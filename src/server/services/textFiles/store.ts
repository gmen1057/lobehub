import { createHash } from 'node:crypto';

import type { LobeChatDatabase } from '@lobechat/database';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { files, messages, topics } from '@/database/schemas';
import { FileService } from '@/server/services/file';

const MIME = 'text/plain; charset=utf-8';
export const RECEIPT_PREFIX = 'ARCKEP_TEXT_FILE_V1\n';
export const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_PART_BYTES = 64 * 1024;
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const isExactUtf8 = (s: string) => Buffer.from(s).toString('utf8') === s;
const partSchema = z
  .object({
    documentId: z.string().uuid().optional(),
    fileName: z
      .string()
      .min(1)
      .max(255)
      .refine(
        (s) =>
          s !== '.' &&
          s !== '..' &&
          s === s.trim() &&
          Buffer.byteLength(s) <= 255 &&
          isExactUtf8(s) &&
          !/[\\/<>:"|?*\p{Cc}\p{Cf}]/u.test(s),
      ),
    final: z.boolean(),
    part: z.number().int().min(1).max(512),
    text: z
      .string()
      .refine((s) => !s.includes('\0') && isExactUtf8(s) && Buffer.byteLength(s) <= MAX_PART_BYTES),
  })
  .strict();

export interface TextFileReceipt {
  documentId: string;
  fileId: string;
  fileName: string;
  part: number;
  status: 'draft' | 'ready';
}

interface Checkpoint extends TextFileReceipt {
  hash: string;
  requestMessageId?: string;
  topicId: string;
}

export class TextFileError extends Error {
  constructor(public readonly code: 'invalid_part' | 'not_found' | 'part_conflict' | 'size_limit') {
    super(code);
  }
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
}
