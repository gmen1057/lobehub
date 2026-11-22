import { createHash } from 'node:crypto';

import type { LobeChatDatabase } from '@lobechat/database';
import {
  type DecodedSourceText,
  decodeSourceText,
  type SourceLineEnding,
  TextEncodingError,
} from '@lobechat/file-loaders';
import { and, desc, eq, exists, or, sql } from 'drizzle-orm';
import { z } from 'zod';

import {
  agentsFiles,
  agentsKnowledgeBases,
  files,
  knowledgeBaseFiles,
  messages,
  messagesFiles,
  topics,
} from '@/database/schemas';
import { FileService } from '@/server/services/file';
import { ownedCodeArtifacts } from '@/server/services/topicContext/codeArtifacts';

import { applyAtomicPatch, MAX_PATCH_EDITS, type PatchEditDiagnostic } from './patch';

const MIME = 'text/plain; charset=utf-8';
export const RECEIPT_PREFIX = 'ARCKEP_TEXT_FILE_V1\n';
export const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_PART_BYTES = 64 * 1024;
const MAX_PARTS = 512;
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const isExactUtf8 = (s: string) => Buffer.from(s).toString('utf8') === s;

const isValidFileName = (s: string) =>
  s !== '.' &&
  s !== '..' &&
  s === s.trim() &&
  Buffer.byteLength(s) <= 255 &&
  isExactUtf8(s) &&
  !/[\\/<>:"|?*\p{Cc}\p{Cf}]/u.test(s);

const fileNameSchema = z.string().min(1).max(255).refine(isValidFileName);

const partSchema = z
  .object({
    documentId: z.string().uuid().optional(),
    fileName: fileNameSchema,
    final: z.boolean(),
    part: z.number().int().min(1).max(MAX_PARTS),
    text: z
      .string()
      .refine((s) => !s.includes('\0') && isExactUtf8(s) && Buffer.byteLength(s) <= MAX_PART_BYTES),
  })
  .strict();

const patchEditSchema = z
  .object({
    endLine: z.number().int().min(1).optional(),
    newText: z.string().refine((s) => !s.includes('\0') && isExactUtf8(s)),
    oldText: z
      .string()
      .min(1)
      .refine((s) => !s.includes('\0') && isExactUtf8(s)),
    replaceAll: z.boolean().optional(),
    startLine: z.number().int().min(1).optional(),
  })
  .strict();

const patchSchema = z
  .object({
    documentId: z.string().uuid().optional(),
    edits: z.array(patchEditSchema).min(1).max(MAX_PATCH_EDITS),
    fileName: fileNameSchema.optional(),
    final: z.boolean().optional(),
    sourceFileId: z.string().min(1).max(200).optional(),
  })
  .strict();

const DISALLOWED_BINARY_MIMES = new Set([
  'application/gzip',
  'application/msword',
  'application/pdf',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/wasm',
  'application/x-7z-compressed',
  'application/x-rar-compressed',
  'application/x-tar',
  'application/x-zip-compressed',
  'application/zip',
]);

const isDisallowedBinaryMime = (fileType: string): boolean => {
  const mime = fileType.split(';')[0].trim().toLowerCase();
  if (!mime) return false;
  if (DISALLOWED_BINARY_MIMES.has(mime)) return true;
  if (mime.startsWith('image/') && mime !== 'image/svg+xml') return true;
  if (mime.startsWith('audio/') || mime.startsWith('video/') || mime.startsWith('font/'))
    return true;
  if (mime.startsWith('application/vnd.openxmlformats')) return true;
  return false;
};

const sanitizeFallbackFileName = (rawName: string): string => {
  const trimmed = rawName.trim().replaceAll(/[\\/<>:"|?*\p{Cc}\p{Cf}]/gu, '_');
  if (!trimmed || trimmed === '.' || trimmed === '..') return 'patched.txt';
  let result = trimmed;
  while (Buffer.byteLength(result, 'utf8') > 255) {
    result = result.slice(0, -1);
  }
  result = result.trim();
  return result && isValidFileName(result) ? result : 'patched.txt';
};

export interface TextFileReceipt {
  documentId: string;
  fileId: string;
  fileName: string;
  part: number;
  status: 'draft' | 'ready';
}

interface Checkpoint extends TextFileReceipt {
  hash: string;
  patchMeta?: {
    appliedEdits: number;
    appliedOccurrences: number;
    lineEnding: SourceLineEnding;
    linesAfter: number;
    linesBefore: number;
    sourceEncoding: string;
  };
  requestMessageId?: string;
  toolCallId?: string;
  topicId: string;
}

export type TextFileErrorCode =
  | 'binary_file'
  | 'invalid_encoding'
  | 'invalid_part'
  | 'invalid_patch'
  | 'not_found'
  | 'part_conflict'
  | 'patch_failed'
  | 'size_limit';

export class TextFileError extends Error {
  public readonly detailsMessage?: string;
  public readonly diagnostics?: PatchEditDiagnostic[];

  constructor(
    public readonly code: TextFileErrorCode,
    message?: string,
    diagnostics?: PatchEditDiagnostic[],
  ) {
    super(message ? `${code}: ${message}` : code);
    this.detailsMessage = message;
    this.diagnostics = diagnostics;
  }
}

export interface ReadableSourceFile {
  decoded: DecodedSourceText;
  fileId: string;
  fileName: string;
  size: number;
  url: string;
}

export interface PatchOptions {
  agentId?: string;
  requestMessageId?: string;
  toolCallId?: string;
}

export interface PatchResult {
  appliedEdits: number;
  appliedOccurrences: number;
  diffSummary: string;
  lineEnding: SourceLineEnding;
  linesAfter: number;
  linesBefore: number;
  receipt: TextFileReceipt;
  replayed?: boolean;
  sourceEncoding: string;
}

function publicReceipt({
  documentId,
  fileId,
  fileName,
  part,
  status,
}: Checkpoint): TextFileReceipt {
  return { documentId, fileId, fileName, part, status };
}

/**
 * Parses the canonical 5-key JSON receipt from line 2 of an `ARCKEP_TEXT_FILE_V1\n` tool output,
 * safely ignoring any LLM-only diff summary lines that may follow after the second newline.
 */
export function parseTextFileReceipt(content: string): TextFileReceipt | null {
  if (typeof content !== 'string' || !content.startsWith(RECEIPT_PREFIX)) return null;
  const body = content.slice(RECEIPT_PREFIX.length);
  const newlineIndex = body.indexOf('\n');
  const jsonLine = newlineIndex >= 0 ? body.slice(0, newlineIndex) : body;
  try {
    const parsed = JSON.parse(jsonLine);
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.documentId === 'string' &&
      typeof parsed.fileId === 'string' &&
      typeof parsed.fileName === 'string' &&
      Number.isSafeInteger(parsed.part) &&
      (parsed.status === 'draft' || parsed.status === 'ready')
    ) {
      return {
        documentId: parsed.documentId,
        fileId: parsed.fileId,
        fileName: parsed.fileName,
        part: parsed.part,
        status: parsed.status,
      };
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Strips any LLM-only diff tail from an `ARCKEP_TEXT_FILE_V1\n` tool output so Postgres messages,
 * SSE `function_call_output`, and REST responses always emit strictly the 2-line 5-key receipt
 * expected by all web and shipped mobile clients.
 */
export function stripTextFileReceiptForClient(content: string): string {
  if (typeof content !== 'string' || !content.startsWith(RECEIPT_PREFIX)) return content;
  const receipt = parseTextFileReceipt(content);
  if (receipt) return RECEIPT_PREFIX + JSON.stringify(receipt);
  const body = content.slice(RECEIPT_PREFIX.length);
  const newlineIndex = body.indexOf('\n');
  return newlineIndex >= 0 ? RECEIPT_PREFIX + body.slice(0, newlineIndex) : content;
}

function scopedId(...parts: Array<string | number>) {
  const hex = digest(JSON.stringify(parts));
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    '5' + hex.slice(13, 16),
    'a' + hex.slice(17, 20),
    hex.slice(20, 32),
  ].join('-');
}

export class TextFileStore {
  constructor(
    private readonly db: LobeChatDatabase,
    private readonly userId: string,
    private readonly topicId: string,
    private readonly storage: Pick<
      FileService,
      'uploadBuffer' | 'deleteFile' | 'getFileByteArray'
    > = new FileService(db, userId),
  ) {}

  async ownsTopic() {
    const [row] = await this.db
      .select({ id: topics.id })
      .from(topics)
      .where(and(eq(topics.id, this.topicId), eq(topics.userId, this.userId)))
      .limit(1);
    return Boolean(row);
  }

  private get scope() {
    return and(
      eq(files.userId, this.userId),
      sql`starts_with(${files.url}, ${'files/' + this.userId + '/code-artifacts/' + this.topicId + '/'})`,
      sql`${files.metadata}->'textFile'->>'topicId' = ${this.topicId}`,
      sql`starts_with(${files.clientId}, 'arckep-text-file/v1/')`,
    );
  }

  private readonly checkpoint = sql<Checkpoint>`${files.metadata}->'textFile'`;
  private readonly docId = sql<string>`${files.metadata}->'textFile'->>'documentId'`;
  private readonly partNumber = sql<number>`(${files.metadata}->'textFile'->>'part')::int`;

  async list(): Promise<TextFileReceipt[]> {
    const rows = await this.db
      .selectDistinctOn([this.docId], { checkpoint: this.checkpoint })
      .from(files)
      .where(this.scope)
      .orderBy(this.docId, desc(this.partNumber));
    return rows.map(({ checkpoint }) => publicReceipt(checkpoint));
  }

  private async latest(documentId: string, part?: number) {
    const [row] = await this.db
      .select({ checkpoint: this.checkpoint, url: files.url })
      .from(files)
      .where(
        and(
          this.scope,
          eq(this.docId, documentId),
          part === undefined ? undefined : eq(this.partNumber, part),
        ),
      )
      .orderBy(desc(this.partNumber))
      .limit(1);
    return row;
  }

  private async findByToolCallId(toolCallId: string) {
    const [row] = await this.db
      .select({ checkpoint: this.checkpoint, url: files.url })
      .from(files)
      .where(and(this.scope, sql`${files.metadata}->'textFile'->>'toolCallId' = ${toolCallId}`))
      .orderBy(desc(this.partNumber))
      .limit(1);
    return row;
  }

  /**
   * Resolves a readable source file strictly scoped to this owner, topic, and (optionally) agent.
   * Checks size <= MAX_SOURCE_BYTES and binary MIME BEFORE fetching bytes from S3.
   */
  async resolveReadableSourceFile(
    sourceFileId: string,
    agentId?: string,
  ): Promise<ReadableSourceFile> {
    if (
      !sourceFileId ||
      !/^[\w-]{1,100}$/.test(this.userId) ||
      !/^[\w-]{1,100}$/.test(this.topicId)
    )
      throw new TextFileError('not_found');
    if (!(await this.ownsTopic())) throw new TextFileError('not_found');

    const membershipPredicates = [
      // 1. Attachment on a message inside this topic
      exists(
        this.db
          .select({ fileId: messagesFiles.fileId })
          .from(messagesFiles)
          .innerJoin(messages, eq(messages.id, messagesFiles.messageId))
          .where(
            and(
              eq(messagesFiles.fileId, files.id),
              eq(messagesFiles.userId, this.userId),
              eq(messages.topicId, this.topicId),
              eq(messages.userId, this.userId),
            ),
          ),
      ),
      // 2. Saved code artifact or text-file snapshot in this topic
      ownedCodeArtifacts(this.db, this.userId, this.topicId, true),
      // 3 & 4. Agent files and knowledge base files enabled for this agent
      ...(agentId
        ? [
            exists(
              this.db
                .select({ fileId: agentsFiles.fileId })
                .from(agentsFiles)
                .where(
                  and(
                    eq(agentsFiles.fileId, files.id),
                    eq(agentsFiles.agentId, agentId),
                    eq(agentsFiles.userId, this.userId),
                    eq(agentsFiles.enabled, true),
                  ),
                ),
            ),
            exists(
              this.db
                .select({ fileId: knowledgeBaseFiles.fileId })
                .from(knowledgeBaseFiles)
                .innerJoin(
                  agentsKnowledgeBases,
                  eq(agentsKnowledgeBases.knowledgeBaseId, knowledgeBaseFiles.knowledgeBaseId),
                )
                .where(
                  and(
                    eq(knowledgeBaseFiles.fileId, files.id),
                    eq(knowledgeBaseFiles.userId, this.userId),
                    eq(agentsKnowledgeBases.agentId, agentId),
                    eq(agentsKnowledgeBases.userId, this.userId),
                    eq(agentsKnowledgeBases.enabled, true),
                  ),
                ),
            ),
          ]
        : []),
    ];

    const [row] = await this.db
      .select({
        fileType: files.fileType,
        id: files.id,
        name: files.name,
        size: files.size,
        url: files.url,
      })
      .from(files)
      .where(
        and(
          eq(files.id, sourceFileId),
          eq(files.userId, this.userId),
          sql`NOT starts_with(${files.url}, 'internal://')`,
          or(...membershipPredicates),
        ),
      )
      .limit(1);

    if (!row) throw new TextFileError('not_found');
    if (row.size > MAX_SOURCE_BYTES) throw new TextFileError('size_limit');
    if (isDisallowedBinaryMime(row.fileType)) {
      throw new TextFileError(
        'binary_file',
        `File "${row.name}" (${row.fileType}) is binary and cannot be patched as text.`,
      );
    }

    const bytes = await this.storage.getFileByteArray(row.url);
    if (!bytes) throw new TextFileError('not_found');
    if (bytes.byteLength > MAX_SOURCE_BYTES) throw new TextFileError('size_limit');

    let decoded: DecodedSourceText;
    try {
      decoded = decodeSourceText(bytes);
    } catch (error) {
      if (error instanceof TextEncodingError) {
        throw new TextFileError(
          error.code === 'binary_content' ? 'binary_file' : 'invalid_encoding',
          error.message,
        );
      }
      throw error;
    }

    return {
      decoded,
      fileId: row.id,
      fileName: row.name,
      size: bytes.byteLength,
      url: row.url,
    };
  }

  async resume(documentId: string) {
    if (!(await this.ownsTopic())) throw new TextFileError('not_found');
    const row = await this.latest(documentId);
    if (!row || row.checkpoint.status !== 'draft') throw new TextFileError('not_found');
    const bytes = await this.storage.getFileByteArray(row.url);
    const [request] = row.checkpoint.requestMessageId
      ? await this.db
          .select({ text: sql<string>`left(${messages.content}, 4096)` })
          .from(messages)
          .where(
            and(
              eq(messages.id, row.checkpoint.requestMessageId),
              eq(messages.role, 'user'),
              eq(messages.topicId, this.topicId),
              eq(messages.userId, this.userId),
            ),
          )
          .limit(1)
      : [];

    // Tail provides the exact continuation boundary even after history compression.
    return {
      ...(request?.text ? { originalRequest: request.text } : {}),
      receipt: publicReceipt(row.checkpoint),
      tail: Buffer.from(bytes).toString('utf8').slice(-4096),
    };
  }

  async write(parent: string, raw: unknown, requestMessageId?: string): Promise<TextFileReceipt> {
    const parsed = partSchema.safeParse(raw);
    if (
      !parsed.success ||
      !parent ||
      !/^[\w-]{1,100}$/.test(this.userId) ||
      !/^[\w-]{1,100}$/.test(this.topicId)
    )
      throw new TextFileError('invalid_part');
    const { documentId: requested, fileName, final, part, text } = parsed.data;
    if ((!requested && part !== 1) || (!final && !text.length))
      throw new TextFileError('invalid_part');
    if (!(await this.ownsTopic())) throw new TextFileError('not_found');
    const documentId =
      requested ?? scopedId('document', this.userId, this.topicId, parent, fileName);
    const hash = digest(text);
    const status = final ? 'ready' : 'draft';
    const replay = (saved: Checkpoint) => {
      if (saved.hash !== hash || saved.status !== status || saved.fileName !== fileName)
        throw new TextFileError('part_conflict');
      return publicReceipt(saved);
    };
    const prior = await this.latest(documentId, part);
    if (prior) return replay(prior.checkpoint);
    if (requested && part === 1) throw new TextFileError('not_found');
    let bytes = Buffer.from(text);
    if (part > 1) {
      const previous = await this.latest(documentId, part - 1);
      if (!previous) throw new TextFileError('not_found');
      if (previous.checkpoint.status !== 'draft' || previous.checkpoint.fileName !== fileName)
        throw new TextFileError('part_conflict');
      requestMessageId = previous.checkpoint.requestMessageId;
      bytes = Buffer.concat([await this.storage.getFileByteArray(previous.url), bytes]);
    }
    if (bytes.length > MAX_SOURCE_BYTES) throw new TextFileError('size_limit');
    // An ambiguous DB response can be retried against exactly the same immutable object.
    const fileId = scopedId('snapshot', this.userId, this.topicId, documentId, part, status, hash);
    // Storage paths never contain the user-controlled display name.
    const key = `files/${this.userId}/code-artifacts/${this.topicId}/${fileId}/source.txt`;
    const { key: url } = await this.storage.uploadBuffer(key, bytes, MIME, true);
    const saved: Checkpoint = {
      requestMessageId,
      documentId,
      fileId,
      fileName,
      hash,
      part,
      status,
      topicId: this.topicId,
    };
    // Only the winning immutable snapshot acquires the unique (owner, clientId) slot.
    // Errors with an ambiguous commit outcome must never remove a potentially committed blob.
    const inserted = await this.db
      .insert(files)
      .values({
        clientId: `arckep-text-file/v1/${this.topicId}/${documentId}/${part}`,
        fileType: MIME,
        id: fileId,
        metadata: { textFile: saved },
        name: fileName,
        size: bytes.length,
        url,
        userId: this.userId,
      })
      .onConflictDoNothing()
      .returning({ id: files.id });
    if (inserted.length) return publicReceipt(saved);
    const winner = await this.latest(documentId, part);
    if (!winner) throw new TextFileError('part_conflict');
    if (winner.checkpoint.fileId === fileId) return replay(winner.checkpoint);
    try {
      await this.storage.deleteFile(url);
    } catch {
      console.warn('[text-file] unused snapshot cleanup failed', { fileId });
    }
    return replay(winner.checkpoint);
  }

  /**
   * Atomically applies search-and-replace edits to either an existing readable source file
   * (`sourceFileId`) or an existing text-file document (`documentId`, whether `draft` or `ready`),
   * saving the patched UTF-8 snapshot with preserved line endings and UTF-8 BOM.
   */
  async patch(parent: string, raw: unknown, options: PatchOptions = {}): Promise<PatchResult> {
    const parsed = patchSchema.safeParse(raw);
    if (
      !parsed.success ||
      !parent ||
      !/^[\w-]{1,100}$/.test(this.userId) ||
      !/^[\w-]{1,100}$/.test(this.topicId)
    ) {
      throw new TextFileError('invalid_patch', 'Invalid patchFile arguments.');
    }

    const {
      documentId: requestedDocumentId,
      edits,
      fileName: requestedFileName,
      final = true,
      sourceFileId,
    } = parsed.data;

    if (Boolean(requestedDocumentId) === Boolean(sourceFileId)) {
      throw new TextFileError(
        'invalid_patch',
        'Provide exactly one of sourceFileId or documentId, never both.',
      );
    }

    if (!(await this.ownsTopic())) throw new TextFileError('not_found');

    const { agentId, toolCallId } = options;
    let requestMessageId = options.requestMessageId;

    const buildReplayResult = (saved: Checkpoint): PatchResult => {
      const meta = saved.patchMeta;
      return {
        appliedEdits: meta?.appliedEdits ?? edits.length,
        appliedOccurrences: meta?.appliedOccurrences ?? edits.length,
        diffSummary: `Patch already applied (idempotent replay for part ${saved.part}).`,
        lineEnding: meta?.lineEnding ?? 'LF',
        linesAfter: meta?.linesAfter ?? 0,
        linesBefore: meta?.linesBefore ?? 0,
        receipt: publicReceipt(saved),
        replayed: true,
        // eslint-disable-next-line unicorn/text-encoding-identifier-case
        sourceEncoding: meta?.sourceEncoding ?? 'utf-8',
      };
    };

    // Fast-path idempotent replay for retries of the exact same toolCallId.
    if (toolCallId) {
      const replayed = await this.findByToolCallId(toolCallId);
      if (
        replayed &&
        (!requestedDocumentId || replayed.checkpoint.documentId === requestedDocumentId)
      ) {
        return buildReplayResult(replayed.checkpoint);
      }
    }

    let documentId: string;
    let part: number;
    let fileName: string;
    let decoded: DecodedSourceText;

    if (requestedDocumentId) {
      const previous = await this.latest(requestedDocumentId);
      if (!previous) throw new TextFileError('not_found');
      if (toolCallId && previous.checkpoint.toolCallId === toolCallId) {
        return buildReplayResult(previous.checkpoint);
      }
      // Allow re-patching over both 'draft' AND 'ready' checkpoints!
      part = previous.checkpoint.part + 1;
      if (part > MAX_PARTS) throw new TextFileError('part_conflict');
      documentId = requestedDocumentId;
      fileName = requestedFileName ?? previous.checkpoint.fileName;
      requestMessageId = previous.checkpoint.requestMessageId ?? requestMessageId;

      const prevBytes = await this.storage.getFileByteArray(previous.url);
      if (!prevBytes) throw new TextFileError('not_found');
      if (prevBytes.byteLength > MAX_SOURCE_BYTES) throw new TextFileError('size_limit');
      try {
        decoded = decodeSourceText(prevBytes);
      } catch (error) {
        if (error instanceof TextEncodingError) {
          throw new TextFileError(
            error.code === 'binary_content' ? 'binary_file' : 'invalid_encoding',
            error.message,
          );
        }
        throw error;
      }
    } else {
      const sourceFile = await this.resolveReadableSourceFile(sourceFileId!, agentId);
      fileName = requestedFileName ?? sanitizeFallbackFileName(sourceFile.fileName);
      part = 1;
      documentId = scopedId(
        'document',
        this.userId,
        this.topicId,
        parent,
        toolCallId ?? sourceFileId!,
        fileName,
      );
      decoded = sourceFile.decoded;

      const prior = await this.latest(documentId, 1);
      if (prior && toolCallId && prior.checkpoint.toolCallId === toolCallId) {
        return buildReplayResult(prior.checkpoint);
      }
    }

    const patched = applyAtomicPatch(decoded.text, edits, {
      fileName,
      maxOutputBytes: MAX_SOURCE_BYTES,
      sourceEncoding: decoded.encoding,
    });

    if (!patched.ok) {
      throw new TextFileError(patched.code, patched.error, patched.diagnostics);
    }

    const bytes = Buffer.from(patched.content, 'utf8');
    if (bytes.length > MAX_SOURCE_BYTES) throw new TextFileError('size_limit');

    const hash = digest(patched.content);
    const status: 'draft' | 'ready' = final ? 'ready' : 'draft';
    const fileId = scopedId('snapshot', this.userId, this.topicId, documentId, part, status, hash);
    const key = `files/${this.userId}/code-artifacts/${this.topicId}/${fileId}/source.txt`;
    const { key: url } = await this.storage.uploadBuffer(key, bytes, MIME, true);

    const saved: Checkpoint = {
      documentId,
      fileId,
      fileName,
      hash,
      part,
      patchMeta: {
        appliedEdits: patched.appliedEdits,
        appliedOccurrences: patched.appliedOccurrences,
        lineEnding: patched.lineEnding,
        linesAfter: patched.linesAfter,
        linesBefore: patched.linesBefore,
        sourceEncoding: decoded.encoding,
      },
      ...(requestMessageId ? { requestMessageId } : {}),
      status,
      ...(toolCallId ? { toolCallId } : {}),
      topicId: this.topicId,
    };

    const inserted = await this.db
      .insert(files)
      .values({
        clientId: `arckep-text-file/v1/${this.topicId}/${documentId}/${part}`,
        fileType: MIME,
        id: fileId,
        metadata: { textFile: saved },
        name: fileName,
        size: bytes.length,
        url,
        userId: this.userId,
      })
      .onConflictDoNothing()
      .returning({ id: files.id });

    if (inserted.length) {
      return {
        appliedEdits: patched.appliedEdits,
        appliedOccurrences: patched.appliedOccurrences,
        diffSummary: patched.diffSummary,
        lineEnding: patched.lineEnding,
        linesAfter: patched.linesAfter,
        linesBefore: patched.linesBefore,
        receipt: publicReceipt(saved),
        sourceEncoding: decoded.encoding,
      };
    }

    const winner = await this.latest(documentId, part);
    if (!winner) throw new TextFileError('part_conflict');

    if (winner.checkpoint.fileId !== fileId) {
      try {
        await this.storage.deleteFile(url);
      } catch {
        console.warn('[text-file] unused patch snapshot cleanup failed', { fileId });
      }
    }

    if (
      (toolCallId && winner.checkpoint.toolCallId === toolCallId) ||
      (winner.checkpoint.hash === hash &&
        winner.checkpoint.status === status &&
        winner.checkpoint.fileName === fileName)
    ) {
      return {
        appliedEdits: patched.appliedEdits,
        appliedOccurrences: patched.appliedOccurrences,
        diffSummary: patched.diffSummary,
        lineEnding: patched.lineEnding,
        linesAfter: patched.linesAfter,
        linesBefore: patched.linesBefore,
        receipt: publicReceipt(winner.checkpoint),
        replayed: true,
        sourceEncoding: decoded.encoding,
      };
    }

    throw new TextFileError('part_conflict');
  }
}
