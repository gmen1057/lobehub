import type { LobeChatDatabase } from '@lobechat/database';
import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm';
import { sha256 as computeSha256 } from 'js-sha256';

import { agents, files, projectWorkspaceFiles } from '@/database/schemas';

import { computeWorkspaceDataGuardState } from './dataGuard';
import { normalizeWorkspacePath, WorkspaceError } from './paths';
import type { WorkspaceStorageAdapter } from './store';
import { ProjectWorkspaceStore } from './store';
import {
  isAllowedWorkspaceDocumentPath,
  isAllowedWorkspaceTextPath,
  isWorkspaceEnabled,
  MAX_WORKSPACE_TEXT_BYTES,
  validateWorkspaceTextBuffer,
} from './validator';

export interface HydratableProjectWorkspaceFile {
  byteSize: number;
  currentFileId: string;
  currentRevision: number;
  dataGuardStatus: 'unmasked' | 'scrubbed';
  kind: 'text' | 'document';
  mimeType: string;
  path: string; // relative inside /workspace/project/<path>
  readOnly: boolean; // true when isProtected || kind === 'document'
  s3Key: string; // files.url in LobeChat DB
  sha256: string;
  workspaceFileId: string;
}

export type SandboxProjectSyncResult =
  | {
      addedLines: number;
      agentId: string;
      outcome: 'updated' | 'created';
      path: string;
      prevRevision: number | null;
      removedLines: number;
      revision: number;
      workspaceFileId: string;
    }
  | {
      addedLines: number;
      agentId: string;
      baseRevision: number | null;
      diffPreview: string;
      outcome: 'proposal_created';
      proposalId: string;
      proposalType: 'edit' | 'create_pinned';
      reason: string;
      removedLines: number;
      targetPath: string;
      workspaceFileId: string | null;
    }
  | {
      message: string;
      outcome: 'fallback_to_topic';
      reason:
        | 'workspace_disabled'
        | 'data_guard_blocked'
        | 'binary_or_disallowed_ext'
        | 'too_large'
        | 'revision_conflict'
        | 'protected_readonly_doc'
        | 'quota_exceeded';
    };

export async function listHydratableProjectFiles(params: {
  agentId: string;
  dataGuardProtected: boolean;
  serverDB: LobeChatDatabase;
  userId: string;
}): Promise<HydratableProjectWorkspaceFile[]> {
  if (!isWorkspaceEnabled()) return [];

  const [agent] = await params.serverDB
    .select({ chatConfig: agents.chatConfig, id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, params.agentId), eq(agents.userId, params.userId)))
    .limit(1);

  if (!agent) return [];

  if (params.dataGuardProtected) {
    const dgState = await computeWorkspaceDataGuardState({
      agentChatConfig: (agent.chatConfig as Record<string, unknown> | null | undefined) ?? {},
      agentId: params.agentId,
      db: params.serverDB,
      requestDataGuardProtected: true,
      userId: params.userId,
    });
    if (!dgState.workspaceDataGuardReady) {
      return [];
    }
  }

  const rows = await params.serverDB
    .select({
      byteSize: projectWorkspaceFiles.byteSize,
      contentSha256: projectWorkspaceFiles.contentSha256,
      currentFileId: projectWorkspaceFiles.currentFileId,
      currentRevision: projectWorkspaceFiles.currentRevision,
      dataGuardStatus: projectWorkspaceFiles.dataGuardStatus,
      isProtected: projectWorkspaceFiles.isProtected,
      kind: projectWorkspaceFiles.kind,
      mimeType: projectWorkspaceFiles.mimeType,
      path: projectWorkspaceFiles.path,
      s3Key: files.url,
      workspaceFileId: projectWorkspaceFiles.id,
    })
    .from(projectWorkspaceFiles)
    .innerJoin(files, eq(files.id, projectWorkspaceFiles.currentFileId))
    .where(
      and(
        eq(projectWorkspaceFiles.userId, params.userId),
        eq(projectWorkspaceFiles.agentId, params.agentId),
        isNull(projectWorkspaceFiles.deletedAt),
        ne(projectWorkspaceFiles.loadMode, 'disabled'),
        params.dataGuardProtected
          ? eq(projectWorkspaceFiles.dataGuardStatus, 'scrubbed')
          : undefined,
      ),
    )
    .orderBy(asc(projectWorkspaceFiles.loadPriority), asc(projectWorkspaceFiles.path));

  return rows.map((row) => ({
    byteSize: row.byteSize,
    currentFileId: row.currentFileId,
    currentRevision: row.currentRevision,
    dataGuardStatus: row.dataGuardStatus === 'scrubbed' ? 'scrubbed' : 'unmasked',
    kind: row.kind === 'document' ? 'document' : 'text',
    mimeType: row.mimeType,
    path: row.path,
    readOnly: row.isProtected || row.kind === 'document',
    s3Key: row.s3Key,
    sha256: row.contentSha256,
    workspaceFileId: row.workspaceFileId,
  }));
}

export async function applySandboxProjectFileSync(
  params: {
    agentId: string;
    baseRevision?: number | null;
    bytes: Uint8Array;
    dataGuardProtected: boolean;
    messageId?: string | null;
    path: string; // relative inside /workspace/project/
    serverDB: LobeChatDatabase;
    sha256: string;
    topicId: string;
    userId: string;
    workspaceDataGuardReady?: boolean;
  },
  fileServiceOverride?: WorkspaceStorageAdapter,
): Promise<SandboxProjectSyncResult> {
  if (!isWorkspaceEnabled()) {
    return {
      message: 'Рабочее пространство проекта выключено — файл сохранён в текущей теме.',
      outcome: 'fallback_to_topic',
      reason: 'workspace_disabled',
    };
  }

  let effectiveWorkspaceDataGuardReady = false;
  if (params.dataGuardProtected) {
    const isReady =
      params.workspaceDataGuardReady ??
      (
        await computeWorkspaceDataGuardState({
          agentId: params.agentId,
          db: params.serverDB,
          requestDataGuardProtected: true,
          userId: params.userId,
        })
      ).workspaceDataGuardReady;
    if (!isReady) {
      return {
        message:
          'В защищённом режиме Data Guard изменения из песочницы сохраняются только в текущей теме.',
        outcome: 'fallback_to_topic',
        reason: 'data_guard_blocked',
      };
    }
    effectiveWorkspaceDataGuardReady = true;
  }

  let normalizedPath: string;
  try {
    normalizedPath = normalizeWorkspacePath(params.path);
  } catch (error) {
    return {
      message:
        error instanceof Error
          ? error.message
          : 'Недопустимый путь файла в /workspace/project/ — файл сохранён в теме.',
      outcome: 'fallback_to_topic',
      reason: 'binary_or_disallowed_ext',
    };
  }

  const [existingRow] = await params.serverDB
    .select()
    .from(projectWorkspaceFiles)
    .where(
      and(
        eq(projectWorkspaceFiles.userId, params.userId),
        eq(projectWorkspaceFiles.agentId, params.agentId),
        isNull(projectWorkspaceFiles.deletedAt),
        sql`lower(${projectWorkspaceFiles.path}) = lower(${normalizedPath})`,
      ),
    )
    .limit(1);

  if (
    (existingRow && existingRow.kind === 'document') ||
    isAllowedWorkspaceDocumentPath(normalizedPath)
  ) {
    return {
      message: `Документ «${normalizedPath}» открыт только для чтения — результат сохранён как файл темы.`,
      outcome: 'fallback_to_topic',
      reason: 'protected_readonly_doc',
    };
  }

  if (params.bytes.byteLength > MAX_WORKSPACE_TEXT_BYTES) {
    return {
      message: `Размер файла «${normalizedPath}» превышает лимит 2 МБ для текстовых файлов проекта — сохранён в теме.`,
      outcome: 'fallback_to_topic',
      reason: 'too_large',
    };
  }

  if (!isAllowedWorkspaceTextPath(normalizedPath)) {
    return {
      message: `Расширение файла «${normalizedPath}» не входит в список текстовых файлов проекта — сохранён в теме.`,
      outcome: 'fallback_to_topic',
      reason: 'binary_or_disallowed_ext',
    };
  }

  const actualSha = computeSha256(params.bytes);
  if (params.sha256 && params.sha256.toLowerCase() !== actualSha.toLowerCase()) {
    return {
      message: `Контрольная сумма файла «${normalizedPath}» не совпала — сохранён в теме.`,
      outcome: 'fallback_to_topic',
      reason: 'binary_or_disallowed_ext',
    };
  }

  // No-op optimization if sandbox synced identical bytes at matching revision
  if (
    existingRow &&
    existingRow.contentSha256 === actualSha &&
    (params.baseRevision === undefined ||
      params.baseRevision === null ||
      params.baseRevision === existingRow.currentRevision)
  ) {
    return {
      addedLines: 0,
      agentId: params.agentId,
      outcome: 'updated',
      path: existingRow.path,
      prevRevision: existingRow.currentRevision,
      removedLines: 0,
      revision: existingRow.currentRevision,
      workspaceFileId: existingRow.id,
    };
  }

  try {
    validateWorkspaceTextBuffer(params.bytes, normalizedPath);
  } catch (error) {
    if (error instanceof WorkspaceError && error.code === 'FILE_TOO_LARGE') {
      return {
        message: error.message,
        outcome: 'fallback_to_topic',
        reason: 'too_large',
      };
    }
    return {
      message:
        error instanceof Error
          ? error.message
          : `Файл «${normalizedPath}» содержит бинарные данные — сохранён в теме.`,
      outcome: 'fallback_to_topic',
      reason: 'binary_or_disallowed_ext',
    };
  }

  const store = new ProjectWorkspaceStore(params.serverDB, params.userId, fileServiceOverride);

  try {
    const writeRes = await store.writeAgentTextFile(params.agentId, {
      actor: 'sandbox',
      baseRevision: params.baseRevision,
      changeNote: 'Synced from E2B sandbox (/workspace/project)',
      dataGuardStatus:
        params.dataGuardProtected && effectiveWorkspaceDataGuardReady ? 'scrubbed' : 'unmasked',
      encodedBytesOverride: params.bytes,
      messageId: params.messageId,
      path: normalizedPath,
      reason: 'Изменения из песочницы кода (/workspace/project)',
      topicId: params.topicId,
    });

    if (writeRes.outcome === 'proposal_created') {
      const prop = writeRes.proposal;
      return {
        addedLines: prop.addedLines,
        agentId: params.agentId,
        baseRevision: prop.baseRevision,
        diffPreview: prop.diffPreview ?? '',
        outcome: 'proposal_created',
        proposalId: prop.id,
        proposalType: prop.proposalType === 'create_pinned' ? 'create_pinned' : 'edit',
        reason: prop.reason ?? 'Изменения защищённого файла из песочницы',
        removedLines: prop.removedLines,
        targetPath: prop.targetPath,
        workspaceFileId: prop.workspaceFileId,
      };
    }

    return {
      addedLines: writeRes.addedLines,
      agentId: params.agentId,
      outcome: writeRes.outcome === 'created' ? 'created' : 'updated',
      path: writeRes.file.path,
      prevRevision: writeRes.prevRevision,
      removedLines: writeRes.removedLines,
      revision: writeRes.file.currentRevision,
      workspaceFileId: writeRes.file.id,
    };
  } catch (error) {
    if (error instanceof WorkspaceError) {
      if (error.code === 'REVISION_CONFLICT' || error.code === 'FILE_ALREADY_EXISTS') {
        return {
          message: error.message,
          outcome: 'fallback_to_topic',
          reason: 'revision_conflict',
        };
      }
      if (error.code === 'QUOTA_EXCEEDED' || error.code === 'PINNED_BUDGET_EXCEEDED') {
        return {
          message: error.message,
          outcome: 'fallback_to_topic',
          reason: 'quota_exceeded',
        };
      }
      if (error.code === 'PROTECTED_FILE' || error.code === 'INBOX_INSTRUCTION_FORBIDDEN') {
        return {
          message: error.message,
          outcome: 'fallback_to_topic',
          reason: 'protected_readonly_doc',
        };
      }
      if (error.code === 'FILE_TOO_LARGE') {
        return {
          message: error.message,
          outcome: 'fallback_to_topic',
          reason: 'too_large',
        };
      }
      return {
        message: error.message,
        outcome: 'fallback_to_topic',
        reason: 'binary_or_disallowed_ext',
      };
    }
    throw error;
  }
}

export interface ProjectWorkspaceSandboxBridgeGlobal {
  applySandboxProjectFileSync: typeof applySandboxProjectFileSync;
  listHydratableProjectFiles: typeof listHydratableProjectFiles;
}

export function registerProjectWorkspaceSandboxBridge(): ProjectWorkspaceSandboxBridgeGlobal {
  const bridge: ProjectWorkspaceSandboxBridgeGlobal = {
    applySandboxProjectFileSync,
    listHydratableProjectFiles,
  };
  (globalThis as Record<string, unknown>).__arckepProjectWorkspaceSandboxBridge = bridge;
  return bridge;
}

registerProjectWorkspaceSandboxBridge();
