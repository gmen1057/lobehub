/* eslint-disable unicorn/text-encoding-identifier-case */
import type { LobeChatDatabase } from '@lobechat/database';
import { idGenerator } from '@lobechat/database';
import type { SourceLineEnding, SourceTextEncoding } from '@lobechat/file-loaders';
import { FileSource } from '@lobechat/types';
import { and, eq } from 'drizzle-orm';
import { sha256 } from 'js-sha256';

import { agents, files } from '@/database/schemas';
import { FileService } from '@/server/services/file';

import type { WorkspaceDataGuardStatus } from './paths';
import { isRootAgentsMd, normalizeWorkspacePath, WorkspaceError } from './paths';
import type { AgentWriteOutcome, WorkspaceStorageAdapter } from './store';
import { ProjectWorkspaceStore } from './store';
import {
  extractWorkspaceBasenameAndExt,
  isAllowedWorkspaceTextPath,
  isWorkspaceEnabled,
  MAX_WORKSPACE_TEXT_BYTES,
  validateWorkspaceTextBuffer,
} from './validator';

export const MAX_MULTIPART_UPLOAD_PARTS = 64;
export const MAX_MULTIPART_CHUNK_BYTES = 64 * 1024; // 65_536
export const MAX_MULTIPART_CALLS_PER_RUN = 120;
export const WORKSPACE_STAGING_SOURCE = FileSource.ProjectWorkspaceStaging;
export const WORKSPACE_STAGING_CLIENT_ID_PREFIX = 'arckep-ws-part/v1/';

const RUN_COUNTER_TTL_MS = 30 * 60 * 1000;
const SAFE_UPLOAD_ID_REGEX = /^[\w-]{1,120}$/;

const multipartRunCounters = new Map<string, { count: number; expiresAt: number }>();

export function resetMultipartRunCountersForTests(): void {
  multipartRunCounters.clear();
}

const consumeMultipartRunCall = (runKey: string): void => {
  const now = Date.now();
  if (multipartRunCounters.size > 1000) {
    for (const [k, v] of multipartRunCounters) {
      if (v.expiresAt <= now) multipartRunCounters.delete(k);
    }
  }

  const cur = multipartRunCounters.get(runKey);
  const nextCount = cur && cur.expiresAt > now ? cur.count + 1 : 1;
  if (nextCount > MAX_MULTIPART_CALLS_PER_RUN) {
    throw new WorkspaceError(
      'QUOTA_EXCEEDED',
      `Multipart write calls exceeded maximum of ${MAX_MULTIPART_CALLS_PER_RUN} per run`,
      422,
      { callsCount: nextCount, maxCallsPerRun: MAX_MULTIPART_CALLS_PER_RUN },
    );
  }
  multipartRunCounters.set(runKey, { count: nextCount, expiresAt: now + RUN_COUNTER_TTL_MS });
};

interface WorkspaceMultipartUploadMeta {
  agentId: string;
  baseRevision?: number | null;
  byteSize: number;
  changeNote?: string;
  createdAt: string;
  dataGuardStatus?: WorkspaceDataGuardStatus;
  encoding?: SourceTextEncoding;
  lastPart: number;
  lastToolCallId?: string;
  lineEnding?: SourceLineEnding;
  operationId?: string;
  path: string;
  sha256: string;
  topicId?: string | null;
  uploadId: string;
}

export interface WriteProjectFilePartParams {
  agentId: string;
  baseRevision?: number | null;
  changeNote?: string;
  dataGuardStatus?: 'unmasked' | 'scrubbed';
  db: LobeChatDatabase;
  encoding?: 'utf-8' | 'utf-8-bom' | 'windows-1251';
  fileServiceOverride?: WorkspaceStorageAdapter;
  final: boolean;
  lineEnding?: 'lf' | 'crlf' | 'LF' | 'CRLF';
  messageId?: string | null;
  operationId?: string;
  part: number;
  path: string;
  text: string;
  toolCallId?: string;
  topicId?: string | null;
  uploadId?: string;
  userId: string;
}

export type WriteProjectFilePartResult =
  | {
      accumulatedBytes: number;
      idempotentReplay?: boolean;
      kind: 'staged';
      part: number;
      path: string;
      uploadId: string;
    }
  | {
      accumulatedBytes: number;
      kind: 'committed';
      part: number;
      path: string;
      uploadId: string;
      writeOutcome: AgentWriteOutcome;
    };

const normalizeMultipartLineEnding = (
  raw?: 'lf' | 'crlf' | 'LF' | 'CRLF',
): SourceLineEnding | undefined => {
  if (raw === undefined) return undefined;
  const lower = String(raw).toLowerCase();
  if (lower === 'lf') return 'LF';
  if (lower === 'crlf') return 'CRLF';
  throw new WorkspaceError(
    'INVALID_OPERATION',
    `Invalid lineEnding "${raw}"; expected lf or crlf`,
    400,
  );
};

const normalizeMultipartEncoding = (
  raw?: 'utf-8' | 'utf-8-bom' | 'windows-1251',
): SourceTextEncoding | undefined => {
  if (raw === undefined) return undefined;
  if (raw === 'utf-8' || raw === 'utf-8-bom' || raw === 'windows-1251') return raw;
  throw new WorkspaceError(
    'INVALID_ENCODING',
    `Invalid encoding "${raw}"; expected utf-8, utf-8-bom, or windows-1251`,
    400,
  );
};

const validateUploadId = (rawUploadId: string | undefined, requireExplicit: boolean): string => {
  const trimmed = rawUploadId?.trim();
  if (!trimmed) {
    if (requireExplicit) {
      throw new WorkspaceError(
        'INVALID_OPERATION',
        'uploadId is required for multipart chunks with part > 1',
        400,
      );
    }
    return crypto.randomUUID();
  }
  if (!SAFE_UPLOAD_ID_REGEX.test(trimmed)) {
    throw new WorkspaceError(
      'INVALID_OPERATION',
      'Invalid uploadId format; only alphanumeric, underscore, and hyphen characters are allowed',
      400,
    );
  }
  return trimmed;
};

const buildStagingClientId = (agentId: string, uploadId: string): string =>
  `${WORKSPACE_STAGING_CLIENT_ID_PREFIX}${agentId}/${uploadId}`;

const buildStagingS3Key = (
  userId: string,
  agentId: string,
  uploadId: string,
  part: number,
): string => `files/${userId}/project-workspace-staging/${agentId}/${uploadId}/p${part}.bin`;

const safeDeleteS3Key = async (storage: WorkspaceStorageAdapter, key: string): Promise<void> => {
  if (!key) return;
  try {
    await storage.deleteFile(key);
  } catch (error) {
    console.warn(
      '[projectWorkspace/multipartWrite] Failed to delete staging S3 object:',
      key,
      error,
    );
  }
};

export async function writeProjectFilePart(
  params: WriteProjectFilePartParams,
): Promise<WriteProjectFilePartResult> {
  if (!isWorkspaceEnabled()) {
    throw new WorkspaceError('WORKSPACE_DISABLED', 'Project workspace is currently disabled', 409);
  }

  if (
    typeof params.part !== 'number' ||
    !Number.isInteger(params.part) ||
    params.part < 1 ||
    params.part > MAX_MULTIPART_UPLOAD_PARTS
  ) {
    throw new WorkspaceError(
      'INVALID_OPERATION',
      `Multipart part number must be an integer between 1 and ${MAX_MULTIPART_UPLOAD_PARTS}`,
      400,
      { maxParts: MAX_MULTIPART_UPLOAD_PARTS, part: params.part },
    );
  }

  if (typeof params.text !== 'string') {
    throw new WorkspaceError('INVALID_OPERATION', 'Multipart text must be a string', 400);
  }

  const normalizedPath = normalizeWorkspacePath(params.path);
  if (!isAllowedWorkspaceTextPath(normalizedPath)) {
    throw new WorkspaceError(
      'UNSUPPORTED_TEXT_EXTENSION',
      `Unsupported text file extension for "${normalizedPath}"`,
      415,
    );
  }

  const normalizedLineEnding = normalizeMultipartLineEnding(params.lineEnding);
  const normalizedEncoding = normalizeMultipartEncoding(params.encoding);

  const chunkBuf = Buffer.from(params.text, 'utf8');
  if (chunkBuf.byteLength > MAX_MULTIPART_CHUNK_BYTES) {
    throw new WorkspaceError(
      'FILE_TOO_LARGE',
      `Multipart chunk size (${chunkBuf.byteLength} bytes) exceeds ${MAX_MULTIPART_CHUNK_BYTES} bytes per-part limit`,
      413,
      { byteLength: chunkBuf.byteLength, maxChunkBytes: MAX_MULTIPART_CHUNK_BYTES },
    );
  }

  if (!params.final && chunkBuf.byteLength === 0) {
    throw new WorkspaceError(
      'INVALID_OPERATION',
      'Non-final multipart chunk must not be empty',
      400,
    );
  }

  const runKey = params.operationId || `${params.userId}:${params.topicId ?? 'default'}`;
  consumeMultipartRunCall(runKey);

  const storage: WorkspaceStorageAdapter =
    params.fileServiceOverride ?? new FileService(params.db, params.userId);
  const store = new ProjectWorkspaceStore(params.db, params.userId, storage);

  // Short-circuit single-part final write without creating any staging row
  if (params.part === 1 && params.final) {
    const uploadId = validateUploadId(params.uploadId, false);
    const writeOutcome = await store.writeAgentTextFile(params.agentId, {
      actor: 'agent',
      baseRevision: params.baseRevision,
      changeNote: params.changeNote,
      content: params.text,
      dataGuardStatus: params.dataGuardStatus,
      encoding: normalizedEncoding,
      lineEnding: normalizedLineEnding,
      messageId: params.messageId,
      path: normalizedPath,
      toolCallId: params.toolCallId ?? null,
      topicId: params.topicId,
    });

    return {
      accumulatedBytes: chunkBuf.byteLength,
      kind: 'committed',
      part: 1,
      path: normalizedPath,
      uploadId,
      writeOutcome,
    };
  }

  if (params.part === 1) {
    const uploadId = validateUploadId(params.uploadId, false);
    const clientId = buildStagingClientId(params.agentId, uploadId);

    // Check agent ownership & Data Guard invariant early before staging S3 objects
    const [agent] = await params.db
      .select({
        chatConfig: agents.chatConfig,
        id: agents.id,
        slug: agents.slug,
        virtual: agents.virtual,
      })
      .from(agents)
      .where(and(eq(agents.id, params.agentId), eq(agents.userId, params.userId)))
      .limit(1);

    if (!agent) {
      throw new WorkspaceError('AGENT_NOT_FOUND', 'Agent not found', 404);
    }

    if ((agent.slug === 'inbox' || agent.virtual === true) && isRootAgentsMd(normalizedPath)) {
      throw new WorkspaceError(
        'INBOX_INSTRUCTION_FORBIDDEN',
        'Inbox or virtual system agent cannot store custom AGENTS.md instructions',
        422,
      );
    }

    const isProtectedProject = Boolean(
      (agent.chatConfig as Record<string, unknown> | null | undefined)?.dataGuardProtected,
    );
    if (isProtectedProject && params.dataGuardStatus !== 'scrubbed') {
      throw new WorkspaceError(
        'DATA_GUARD_SCRUB_REQUIRED',
        'Protected project requires scrubbed content (dataGuardStatus="scrubbed")',
        409,
      );
    }

    const [existingStaging] = await params.db
      .select()
      .from(files)
      .where(
        and(
          eq(files.userId, params.userId),
          eq(files.clientId, clientId),
          eq(files.source, WORKSPACE_STAGING_SOURCE),
        ),
      )
      .limit(1);

    if (existingStaging) {
      const existingMeta = (
        existingStaging.metadata as { wsUpload?: WorkspaceMultipartUploadMeta } | null
      )?.wsUpload;
      if (
        existingMeta &&
        params.toolCallId &&
        existingMeta.lastToolCallId === params.toolCallId &&
        existingMeta.lastPart === 1
      ) {
        return {
          accumulatedBytes: existingMeta.byteSize,
          idempotentReplay: true,
          kind: 'staged',
          part: 1,
          path: existingMeta.path,
          uploadId,
        };
      }
      throw new WorkspaceError(
        'INVALID_OPERATION',
        `Multipart uploadId "${uploadId}" is already active at part ${existingMeta?.lastPart ?? 1}`,
        409,
      );
    }

    validateWorkspaceTextBuffer(chunkBuf, normalizedPath);

    const s3Key = buildStagingS3Key(params.userId, params.agentId, uploadId, 1);
    await storage.uploadBuffer(s3Key, chunkBuf, 'application/octet-stream', true);

    const wsUploadMeta: WorkspaceMultipartUploadMeta = {
      agentId: params.agentId,
      baseRevision: params.baseRevision,
      byteSize: chunkBuf.byteLength,
      changeNote: params.changeNote,
      createdAt: new Date().toISOString(),
      dataGuardStatus: params.dataGuardStatus,
      encoding: normalizedEncoding,
      lastPart: 1,
      lastToolCallId: params.toolCallId,
      lineEnding: normalizedLineEnding,
      operationId: params.operationId,
      path: normalizedPath,
      sha256: sha256(chunkBuf),
      topicId: params.topicId ?? null,
      uploadId,
    };

    try {
      const { basename } = extractWorkspaceBasenameAndExt(normalizedPath);
      await params.db.insert(files).values({
        clientId,
        fileHash: null,
        fileType: 'application/octet-stream',
        id: idGenerator('files'),
        metadata: { wsUpload: wsUploadMeta },
        name: basename,
        size: chunkBuf.byteLength,
        source: WORKSPACE_STAGING_SOURCE,
        url: s3Key,
        userId: params.userId,
      });
    } catch (error) {
      await safeDeleteS3Key(storage, s3Key);
      throw error;
    }

    return {
      accumulatedBytes: chunkBuf.byteLength,
      kind: 'staged',
      part: 1,
      path: normalizedPath,
      uploadId,
    };
  }

  // part > 1
  const uploadId = validateUploadId(params.uploadId, true);
  const clientId = buildStagingClientId(params.agentId, uploadId);

  const [stagingRow] = await params.db
    .select()
    .from(files)
    .where(
      and(
        eq(files.userId, params.userId),
        eq(files.clientId, clientId),
        eq(files.source, WORKSPACE_STAGING_SOURCE),
      ),
    )
    .limit(1);

  if (!stagingRow) {
    throw new WorkspaceError(
      'FILE_NOT_FOUND',
      `Multipart upload session "${uploadId}" not found or already finalized`,
      404,
    );
  }

  const meta = (stagingRow.metadata as { wsUpload?: WorkspaceMultipartUploadMeta } | null)
    ?.wsUpload;
  if (!meta) {
    throw new WorkspaceError(
      'INVALID_OPERATION',
      `Corrupted multipart upload metadata for "${uploadId}"`,
      422,
    );
  }

  // Idempotent retry on non-final part
  if (
    params.toolCallId &&
    meta.lastToolCallId === params.toolCallId &&
    params.part === meta.lastPart &&
    !params.final
  ) {
    return {
      accumulatedBytes: meta.byteSize,
      idempotentReplay: true,
      kind: 'staged',
      part: params.part,
      path: meta.path,
      uploadId,
    };
  }

  if (normalizedPath.toLowerCase() !== meta.path.toLowerCase()) {
    throw new WorkspaceError(
      'INVALID_OPERATION',
      `Multipart path "${normalizedPath}" does not match staged session path "${meta.path}"`,
      400,
    );
  }

  if (params.part !== meta.lastPart + 1) {
    throw new WorkspaceError(
      'INVALID_OPERATION',
      `Out-of-order multipart chunk for "${meta.path}": expected part ${meta.lastPart + 1}, received part ${params.part}`,
      409,
      { expectedPart: meta.lastPart + 1, receivedPart: params.part },
    );
  }

  const projectedBytes = meta.byteSize + chunkBuf.byteLength;
  if (projectedBytes > MAX_WORKSPACE_TEXT_BYTES) {
    throw new WorkspaceError(
      'FILE_TOO_LARGE',
      `Accumulated multipart file size (${projectedBytes} bytes) exceeds ${MAX_WORKSPACE_TEXT_BYTES} bytes limit`,
      413,
      { byteLength: projectedBytes, maxBytes: MAX_WORKSPACE_TEXT_BYTES },
    );
  }

  const prevBytes = await storage.getFileByteArray(stagingRow.url);
  const combinedBuf = Buffer.concat([Buffer.from(prevBytes), chunkBuf]);
  if (combinedBuf.byteLength > MAX_WORKSPACE_TEXT_BYTES) {
    throw new WorkspaceError(
      'FILE_TOO_LARGE',
      `Accumulated multipart file size (${combinedBuf.byteLength} bytes) exceeds ${MAX_WORKSPACE_TEXT_BYTES} bytes limit`,
      413,
      { byteLength: combinedBuf.byteLength, maxBytes: MAX_WORKSPACE_TEXT_BYTES },
    );
  }

  if (!params.final) {
    validateWorkspaceTextBuffer(combinedBuf, meta.path);

    const nextS3Key = buildStagingS3Key(params.userId, params.agentId, uploadId, params.part);
    await storage.uploadBuffer(nextS3Key, combinedBuf, 'application/octet-stream', true);

    const nextMeta: WorkspaceMultipartUploadMeta = {
      ...meta,
      baseRevision: params.baseRevision ?? meta.baseRevision,
      byteSize: combinedBuf.byteLength,
      changeNote: params.changeNote ?? meta.changeNote,
      dataGuardStatus: params.dataGuardStatus ?? meta.dataGuardStatus,
      encoding: normalizedEncoding ?? meta.encoding,
      lastPart: params.part,
      lastToolCallId: params.toolCallId ?? meta.lastToolCallId,
      lineEnding: normalizedLineEnding ?? meta.lineEnding,
      sha256: sha256(combinedBuf),
      topicId: params.topicId ?? meta.topicId,
    };

    try {
      await params.db
        .update(files)
        .set({
          metadata: { wsUpload: nextMeta },
          size: combinedBuf.byteLength,
          updatedAt: new Date(),
          url: nextS3Key,
        })
        .where(and(eq(files.id, stagingRow.id), eq(files.userId, params.userId)));
    } catch (error) {
      await safeDeleteS3Key(storage, nextS3Key);
      throw error;
    }

    if (stagingRow.url !== nextS3Key) {
      await safeDeleteS3Key(storage, stagingRow.url);
    }

    return {
      accumulatedBytes: combinedBuf.byteLength,
      kind: 'staged',
      part: params.part,
      path: meta.path,
      uploadId,
    };
  }

  // final === true: commit assembled text atomically via ProjectWorkspaceStore and clean up staging
  const fullText = combinedBuf.toString('utf8');
  const writeOutcome = await store.writeAgentTextFile(params.agentId, {
    actor: 'agent',
    baseRevision: params.baseRevision ?? meta.baseRevision,
    changeNote: params.changeNote ?? meta.changeNote,
    content: fullText,
    dataGuardStatus: params.dataGuardStatus ?? meta.dataGuardStatus,
    encoding: normalizedEncoding ?? meta.encoding,
    lineEnding: normalizedLineEnding ?? meta.lineEnding,
    messageId: params.messageId,
    path: meta.path,
    toolCallId: params.toolCallId ?? meta.lastToolCallId ?? null,
    topicId: params.topicId ?? meta.topicId,
  });

  await params.db
    .delete(files)
    .where(and(eq(files.id, stagingRow.id), eq(files.userId, params.userId)));
  await safeDeleteS3Key(storage, stagingRow.url);

  return {
    accumulatedBytes: combinedBuf.byteLength,
    kind: 'committed',
    part: params.part,
    path: meta.path,
    uploadId,
    writeOutcome,
  };
}
