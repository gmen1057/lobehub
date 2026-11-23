/* eslint-disable unicorn/text-encoding-identifier-case */
import type { LobeChatDatabase, Transaction } from '@lobechat/database';
import { idGenerator } from '@lobechat/database';
import type { SourceLineEnding, SourceTextEncoding } from '@lobechat/file-loaders';
import {
  decodeSourceText,
  detectLineEnding,
  encodeSourceText,
  TextEncodingError,
} from '@lobechat/file-loaders';
import type { FileReadPage } from '@lobechat/prompts';
import {
  FILE_READ_CHARS,
  FILE_READ_DEFAULT_MAX_LINES,
  FILE_READ_MATCH_PREVIEW_CHARS,
  FILE_READ_MAX_LINES,
  FILE_READ_MIN_LINES,
  readFilePage,
} from '@lobechat/prompts';
import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { sha256 } from 'js-sha256';

import { FileModel } from '@/database/models/file';
import type { ProjectFileRevisionItem, ProjectWorkspaceFileItem } from '@/database/schemas';
import {
  agentDocuments,
  agents,
  agentsFiles,
  agentsKnowledgeBases,
  asyncTasks,
  documents,
  fileChunks,
  files,
  globalFiles,
  knowledgeBaseFiles,
  knowledgeBases,
  messagesFiles,
  projectFileProposals,
  projectFileRevisions,
  projectWorkspaceFiles,
  topicDocuments,
} from '@/database/schemas';
import { FileService } from '@/server/services/file';
import type { PatchEdit } from '@/server/services/textFiles/patch';
import { applyAtomicPatch } from '@/server/services/textFiles/patch';

import type {
  WorkspaceBudgetSummary,
  WorkspaceCreatedBy,
  WorkspaceDataGuardStatus,
  WorkspaceFileDto,
  WorkspaceFileKind,
  WorkspaceIndexingStatus,
  WorkspaceLoadMode,
  WorkspaceProposalDto,
  WorkspaceRevisionDto,
  WorkspaceUpdatedBy,
} from './paths';
import {
  escapeXmlAttr,
  isAutoProtectedPath,
  isRootAgentsMd,
  normalizeWorkspacePath,
  resolveEffectiveProtection,
  sanitizeChangeNote,
  sanitizeUserSummary,
  validateWorkspaceLoadMode,
  WorkspaceError,
} from './paths';
import {
  computeUnifiedDiff,
  countTextLines,
  insertWorkspaceProposal,
  listPendingProposalsForAgent,
  lockWorkspaceProposalForUpdate,
  rejectWorkspaceProposal,
  toWorkspaceProposalDto,
} from './proposals';
import {
  estimateWorkspaceTokens,
  extractWorkspaceBasenameAndExt,
  HARD_MAX_PINNED_CHARS,
  HARD_MAX_PINNED_TOKENS,
  isAllowedWorkspaceDocumentPath,
  isAllowedWorkspaceTextPath,
  isWorkspaceEnabled,
  MAX_PROJECT_HISTORY_BYTES,
  MAX_REVISIONS_KEEP,
  MAX_USER_WORKSPACE_BYTES,
  MAX_WORKSPACE_ACTIVE_BYTES,
  MAX_WORKSPACE_ACTIVE_FILES,
  MAX_WORKSPACE_TEXT_BYTES,
  resolveCanonicalDocumentMimeType,
  resolveCanonicalTextMimeType,
  SOFT_WARN_PINNED_TOKENS,
  validateWorkspaceDocumentPathAndSize,
  validateWorkspaceTextBuffer,
} from './validator';

export type {
  WorkspaceBudgetSummary,
  WorkspaceFileDto,
  WorkspaceProposalDto,
  WorkspaceRevisionDto,
} from './paths';

export type WorkspaceStorageAdapter = Pick<
  FileService,
  | 'createPreSignedUrlForPreview'
  | 'deleteFile'
  | 'deleteFiles'
  | 'getFileByteArray'
  | 'uploadBuffer'
>;

export interface WorkspaceSearchMatch {
  line: number;
  path: string;
  preview: string;
  revision: number;
  workspaceFileId: string;
}

export interface WorkspaceSearchResult {
  formatted: string;
  matches: WorkspaceSearchMatch[];
  totalMatchesReturned: number;
  truncated: boolean;
}

export type AgentWriteOutcome =
  | {
      addedLines: number;
      budget: WorkspaceBudgetSummary;
      diffSummary?: string;
      file: WorkspaceFileDto;
      outcome: 'created' | 'restored' | 'updated';
      prevRevision: number | null;
      removedLines: number;
    }
  | {
      diffSummary?: string;
      outcome: 'proposal_created';
      proposal: WorkspaceProposalDto;
    };

export type WorkspaceDeleteOutcome =
  | {
      budget: WorkspaceBudgetSummary;
      deleted: true;
      outcome: 'deleted';
      path: string;
      revision: number;
      workspaceFileId: string;
    }
  | {
      outcome: 'proposal_created';
      proposal: WorkspaceProposalDto;
    };

const MAX_SEARCH_MATCHES = 30;
const MAX_SEARCH_OUTPUT_CHARS = 8000;

const defaultPriorityForPathAndMode = (
  normalizedPath: string,
  loadMode: WorkspaceLoadMode,
): number => {
  if (isRootAgentsMd(normalizedPath)) return 0;
  const lower = normalizedPath.toLowerCase();
  if (
    lower === 'claude.md' ||
    lower.endsWith('/agents.md') ||
    lower.endsWith('/claude.md') ||
    lower.startsWith('rules/') ||
    lower.includes('/rules/')
  ) {
    return 10;
  }
  if (loadMode === 'always') return 50;
  return 100;
};

const isPgUniqueViolation = (err: unknown): boolean => {
  if (!err || typeof err !== 'object') return false;
  const code =
    (err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code;
  return code === '23505';
};

const escapeLikeLiteral = (value: string): string =>
  value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');

const buildSingleLineMatchPreview = (lineText: string, matchIdx: number): string => {
  if (lineText.length <= FILE_READ_MATCH_PREVIEW_CHARS) return lineText;
  let start = Math.max(0, matchIdx - 40);
  const hasPrefix = start > 0;
  const maxInner = FILE_READ_MATCH_PREVIEW_CHARS - (hasPrefix ? 1 : 0);
  let end = Math.min(lineText.length, start + maxInner);
  const hasSuffix = end < lineText.length;
  if (hasSuffix) {
    end = Math.min(lineText.length, start + maxInner - 1);
  } else if (end - start < maxInner) {
    start = Math.max(0, end - maxInner);
  }
  const prefix = start > 0 ? '…' : '';
  const suffix = end < lineText.length ? '…' : '';
  return `${prefix}${lineText.slice(start, Math.max(start, end))}${suffix}`;
};

const extractTaskErrorMessage = (err: unknown): string | null => {
  if (!err) return null;
  if (typeof err === 'string') return err;
  if (typeof err === 'object') {
    const obj = err as Record<string, any>;
    if (typeof obj.body?.detail === 'string') return obj.body.detail;
    if (typeof obj.message === 'string') return obj.message;
    try {
      return JSON.stringify(obj);
    } catch {
      return 'Indexing failed';
    }
  }
  return String(err);
};

const stripLeadingBomChar = (text: string): string =>
  text.startsWith('\uFEFF') ? text.slice(1) : text;

const mapEncodingError = (err: unknown): WorkspaceError => {
  if (err instanceof WorkspaceError) return err;
  if (err instanceof TextEncodingError) {
    if (err.code === 'binary_content') {
      return new WorkspaceError('BINARY_CONTENT', err.message, 415);
    }
    if (err.code === 'UNREPRESENTABLE_CHAR_IN_CP1251') {
      return new WorkspaceError('INVALID_ENCODING', err.message, 422);
    }
    return new WorkspaceError('INVALID_ENCODING', err.message, 415);
  }
  throw err;
};

const toRevisionDto = (row: ProjectFileRevisionItem): WorkspaceRevisionDto => ({
  authorType: row.authorType,
  byteSize: row.byteSize,
  changeNote: row.changeNote ?? null,
  createdAt: row.createdAt.toISOString(),
  diffStats: row.diffStats ?? null,
  id: row.id,
  lineCount: row.lineCount ?? null,
  messageId: row.messageId ?? null,
  revision: row.revision,
  topicId: row.topicId ?? null,
});

interface LockedAgentRow {
  id: string;
  slug: string | null;
  systemRole: string | null;
  title: string | null;
  virtual: boolean | null;
}

export class ProjectWorkspaceStore {
  private readonly db: LobeChatDatabase;
  private readonly userId: string;
  private customFileService?: WorkspaceStorageAdapter;
  private defaultFileService?: FileService;

  constructor(db: LobeChatDatabase, userId: string, fileService?: WorkspaceStorageAdapter) {
    this.db = db;
    this.userId = userId;
    this.customFileService = fileService;
  }

  private get storage(): WorkspaceStorageAdapter {
    if (this.customFileService) return this.customFileService;
    if (!this.defaultFileService) {
      this.defaultFileService = new FileService(this.db, this.userId);
    }
    return this.defaultFileService;
  }

  private async safeDeleteS3Key(key: string | null | undefined): Promise<void> {
    if (!key) return;
    try {
      await this.storage.deleteFile(key);
    } catch (error) {
      console.warn('[ProjectWorkspaceStore] Failed to clean up orphan S3 object:', key, error);
    }
  }

  private async safeDeleteS3Keys(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    try {
      await this.storage.deleteFiles(keys);
    } catch (error) {
      console.warn(
        '[ProjectWorkspaceStore] Failed to batch-delete S3 objects:',
        keys.length,
        error,
      );
    }
  }

  private buildImmutableS3Key(
    agentId: string,
    workspaceFileId: string,
    revision: number,
    contentSha256: string,
  ): string {
    return `files/${this.userId}/project-workspace/${agentId}/${workspaceFileId}/r${revision}-${contentSha256.slice(0, 12)}.bin`;
  }

  private async ensureAgentOwned(
    executor: LobeChatDatabase | Transaction,
    agentId: string,
    forUpdate = false,
  ): Promise<LockedAgentRow> {
    const baseQuery = executor
      .select({
        id: agents.id,
        slug: agents.slug,
        systemRole: agents.systemRole,
        title: agents.title,
        virtual: agents.virtual,
      })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.userId, this.userId)));

    const rows = forUpdate ? await baseQuery.for('update') : await baseQuery;
    const agent = rows[0];
    if (!agent) {
      throw new WorkspaceError('AGENT_NOT_FOUND', 'Agent not found', 404);
    }
    return agent;
  }

  private assertNotInboxInstruction(agent: LockedAgentRow, normalizedPath: string): void {
    if ((agent.slug === 'inbox' || agent.virtual === true) && isRootAgentsMd(normalizedPath)) {
      throw new WorkspaceError(
        'INBOX_INSTRUCTION_FORBIDDEN',
        'Inbox or virtual system agent cannot store custom AGENTS.md instructions',
        422,
      );
    }
  }

  private async lockWorkspaceRowByPath(
    tx: Transaction,
    agentId: string,
    normalizedPath: string,
  ): Promise<ProjectWorkspaceFileItem | undefined> {
    const rows = await tx
      .select()
      .from(projectWorkspaceFiles)
      .where(
        and(
          eq(projectWorkspaceFiles.agentId, agentId),
          eq(projectWorkspaceFiles.userId, this.userId),
          sql`lower(${projectWorkspaceFiles.path}) = lower(${normalizedPath})`,
        ),
      )
      .for('update');
    return rows[0];
  }

  private async lockWorkspaceRowById(
    tx: Transaction,
    agentId: string,
    workspaceFileId: string,
  ): Promise<ProjectWorkspaceFileItem | undefined> {
    const rows = await tx
      .select()
      .from(projectWorkspaceFiles)
      .where(
        and(
          eq(projectWorkspaceFiles.id, workspaceFileId),
          eq(projectWorkspaceFiles.agentId, agentId),
          eq(projectWorkspaceFiles.userId, this.userId),
        ),
      )
      .for('update');
    return rows[0];
  }

  private async resolveEstimatedTokensMap(
    executor: LobeChatDatabase | Transaction,
    rows: ProjectWorkspaceFileItem[],
  ): Promise<Map<string, number>> {
    const docIds = rows
      .filter((r) => r.kind === 'text' && r.currentDocumentId)
      .map((r) => r.currentDocumentId!) as string[];

    const result = new Map<string, number>();
    if (docIds.length === 0) return result;

    const docRows = await executor
      .select({
        content: documents.content,
        id: documents.id,
        metadata: documents.metadata,
      })
      .from(documents)
      .where(inArray(documents.id, docIds));

    for (const doc of docRows) {
      const metaTokens = doc.metadata?.estimatedTokens;
      if (typeof metaTokens === 'number' && Number.isFinite(metaTokens) && metaTokens >= 0) {
        result.set(doc.id, Math.ceil(metaTokens));
      } else {
        result.set(doc.id, estimateWorkspaceTokens(doc.content ?? ''));
      }
    }

    return result;
  }

  private async resolveIndexingStatusMap(
    executor: LobeChatDatabase | Transaction,
    rows: ProjectWorkspaceFileItem[],
  ): Promise<
    Map<string, { indexingError: string | null; indexingStatus: WorkspaceIndexingStatus }>
  > {
    const ragFileIds = rows.filter((r) => r.ragEnabled).map((r) => r.currentFileId);
    const out = new Map<
      string,
      { indexingError: string | null; indexingStatus: WorkspaceIndexingStatus }
    >();
    if (ragFileIds.length === 0) return out;

    const fileRows = await executor
      .select({
        chunkTaskId: files.chunkTaskId,
        embeddingTaskId: files.embeddingTaskId,
        id: files.id,
        size: files.size,
      })
      .from(files)
      .where(inArray(files.id, ragFileIds));

    const taskIds: string[] = [];
    for (const f of fileRows) {
      if (f.chunkTaskId) taskIds.push(f.chunkTaskId);
      if (f.embeddingTaskId) taskIds.push(f.embeddingTaskId);
    }

    const taskMap = new Map<string, { error: unknown; status: string | null }>();
    if (taskIds.length > 0) {
      const tasks = await executor
        .select({ error: asyncTasks.error, id: asyncTasks.id, status: asyncTasks.status })
        .from(asyncTasks)
        .where(inArray(asyncTasks.id, taskIds));
      for (const t of tasks) {
        taskMap.set(t.id, { error: t.error, status: t.status });
      }
    }

    const chunkRows = await executor
      .select({ fileId: fileChunks.fileId })
      .from(fileChunks)
      .where(inArray(fileChunks.fileId, ragFileIds));
    const filesWithChunks = new Set<string>(
      chunkRows.map((c) => c.fileId).filter((id): id is string => Boolean(id)),
    );

    for (const f of fileRows) {
      const chunkTask = f.chunkTaskId ? taskMap.get(f.chunkTaskId) : undefined;
      const embedTask = f.embeddingTaskId ? taskMap.get(f.embeddingTaskId) : undefined;

      if (chunkTask?.status === 'error' || embedTask?.status === 'error') {
        out.set(f.id, {
          indexingError: extractTaskErrorMessage(embedTask?.error ?? chunkTask?.error),
          indexingStatus: 'error',
        });
      } else if (
        chunkTask?.status === 'pending' ||
        chunkTask?.status === 'processing' ||
        embedTask?.status === 'pending' ||
        embedTask?.status === 'processing'
      ) {
        out.set(f.id, { indexingError: null, indexingStatus: 'indexing' });
      } else if (
        filesWithChunks.has(f.id) ||
        embedTask?.status === 'success' ||
        chunkTask?.status === 'success' ||
        f.size === 0
      ) {
        out.set(f.id, { indexingError: null, indexingStatus: 'ready' });
      } else {
        out.set(f.id, { indexingError: null, indexingStatus: 'indexing' });
      }
    }

    return out;
  }

  private async toFileDtos(
    executor: LobeChatDatabase | Transaction,
    rows: ProjectWorkspaceFileItem[],
  ): Promise<WorkspaceFileDto[]> {
    if (rows.length === 0) return [];
    const [tokensMap, indexingMap] = await Promise.all([
      this.resolveEstimatedTokensMap(executor, rows),
      this.resolveIndexingStatusMap(executor, rows),
    ]);

    return rows.map((row) => {
      const estimatedTokens =
        row.kind === 'text'
          ? row.currentDocumentId
            ? (tokensMap.get(row.currentDocumentId) ?? Math.ceil((row.charCount ?? 0) * 0.45))
            : Math.ceil((row.charCount ?? 0) * 0.45)
          : 0;

      const idxState = row.ragEnabled
        ? (indexingMap.get(row.currentFileId) ?? {
            indexingError: null,
            indexingStatus: row.byteSize === 0 ? ('ready' as const) : ('indexing' as const),
          })
        : { indexingError: null, indexingStatus: 'none' as const };

      return {
        agentId: row.agentId,
        byteSize: row.byteSize,
        charCount: row.charCount ?? null,
        createdAt: row.createdAt.toISOString(),
        createdBy: row.createdBy as WorkspaceCreatedBy,
        currentFileId: row.currentFileId,
        currentRevision: row.currentRevision,
        dataGuardStatus: (row.dataGuardStatus === 'scrubbed'
          ? 'scrubbed'
          : 'unmasked') as WorkspaceDataGuardStatus,
        encoding: (row.encoding as WorkspaceFileDto['encoding']) ?? null,
        estimatedTokens,
        id: row.id,
        indexingError: idxState.indexingError,
        indexingStatus: idxState.indexingStatus,
        isProtected: row.isProtected,
        kind: row.kind as WorkspaceFileKind,
        lineCount: row.lineCount ?? null,
        lineEnding: (row.lineEnding as WorkspaceFileDto['lineEnding']) ?? null,
        loadMode: row.loadMode as WorkspaceLoadMode,
        loadPriority: row.loadPriority,
        mimeType: row.mimeType,
        path: row.path,
        ragEnabled: row.ragEnabled,
        updatedAt: row.updatedAt.toISOString(),
        updatedBy: row.updatedBy as WorkspaceUpdatedBy,
        userSummary: row.userSummary ?? null,
      };
    });
  }

  public async computeBudgetSummary(
    executor: LobeChatDatabase | Transaction,
    agentId: string,
  ): Promise<WorkspaceBudgetSummary> {
    const activeRows = await executor
      .select()
      .from(projectWorkspaceFiles)
      .where(
        and(
          eq(projectWorkspaceFiles.userId, this.userId),
          eq(projectWorkspaceFiles.agentId, agentId),
          isNull(projectWorkspaceFiles.deletedAt),
        ),
      );

    const pinnedRows = activeRows.filter((r) => r.loadMode === 'always');
    const tokensMap = await this.resolveEstimatedTokensMap(executor, pinnedRows);

    let activeBytes = 0;
    let pinnedChars = 0;
    let pinnedTokens = 0;

    for (const row of activeRows) {
      activeBytes += row.byteSize;
      if (row.loadMode === 'always') {
        pinnedChars += row.charCount ?? 0;
        const est =
          row.kind === 'text'
            ? row.currentDocumentId
              ? (tokensMap.get(row.currentDocumentId) ?? Math.ceil((row.charCount ?? 0) * 0.45))
              : Math.ceil((row.charCount ?? 0) * 0.45)
            : 0;
        pinnedTokens += est;
      }
    }

    return {
      activeBytes,
      activeFilesCount: activeRows.length,
      hardMaxChars: HARD_MAX_PINNED_CHARS,
      hardMaxTokens: HARD_MAX_PINNED_TOKENS,
      maxActiveBytes: MAX_WORKSPACE_ACTIVE_BYTES,
      maxFilesCount: MAX_WORKSPACE_ACTIVE_FILES,
      pinnedChars,
      pinnedTokens,
      softWarnTokens: SOFT_WARN_PINNED_TOKENS,
    };
  }

  private async assertBudgetAndQuotasForWrite(
    tx: Transaction,
    params: {
      addedRevisionBytes: number;
      agentId: string;
      excludeWorkspaceFileId?: string;
      isCreatingActiveSlot: boolean;
      newByteSize: number;
      newCharCount: number;
      newEstimatedTokens: number;
      newKind: WorkspaceFileKind;
      newLoadMode: WorkspaceLoadMode;
    },
  ): Promise<void> {
    if (params.newKind === 'document' && params.newLoadMode === 'always') {
      throw new WorkspaceError(
        'DOCUMENT_CANNOT_BE_PINNED',
        'Binary documents cannot use always loadMode; use on_demand with RAG',
        422,
      );
    }

    const otherActiveRows = await tx
      .select()
      .from(projectWorkspaceFiles)
      .where(
        and(
          eq(projectWorkspaceFiles.userId, this.userId),
          eq(projectWorkspaceFiles.agentId, params.agentId),
          isNull(projectWorkspaceFiles.deletedAt),
          params.excludeWorkspaceFileId
            ? ne(projectWorkspaceFiles.id, params.excludeWorkspaceFileId)
            : undefined,
        ),
      );

    const nextActiveCount = otherActiveRows.length + 1;
    if (params.isCreatingActiveSlot && nextActiveCount > MAX_WORKSPACE_ACTIVE_FILES) {
      throw new WorkspaceError(
        'QUOTA_EXCEEDED',
        `Project exceeds maximum of ${MAX_WORKSPACE_ACTIVE_FILES} active files`,
        422,
        { activeFilesCount: nextActiveCount, maxFilesCount: MAX_WORKSPACE_ACTIVE_FILES },
      );
    }

    let otherActiveBytes = 0;
    const otherPinnedRows: ProjectWorkspaceFileItem[] = [];
    for (const r of otherActiveRows) {
      otherActiveBytes += r.byteSize;
      if (r.loadMode === 'always') otherPinnedRows.push(r);
    }

    const nextActiveBytes = otherActiveBytes + params.newByteSize;
    if (nextActiveBytes > MAX_WORKSPACE_ACTIVE_BYTES) {
      throw new WorkspaceError(
        'QUOTA_EXCEEDED',
        `Project active files exceed ${MAX_WORKSPACE_ACTIVE_BYTES} bytes quota`,
        413,
        { activeBytes: nextActiveBytes, maxActiveBytes: MAX_WORKSPACE_ACTIVE_BYTES },
      );
    }

    if (params.newLoadMode === 'always') {
      const tokensMap = await this.resolveEstimatedTokensMap(tx, otherPinnedRows);
      let pinnedChars = params.newCharCount;
      let pinnedTokens = params.newEstimatedTokens;

      for (const r of otherPinnedRows) {
        pinnedChars += r.charCount ?? 0;
        pinnedTokens += r.currentDocumentId
          ? (tokensMap.get(r.currentDocumentId) ?? Math.ceil((r.charCount ?? 0) * 0.45))
          : Math.ceil((r.charCount ?? 0) * 0.45);
      }

      if (pinnedChars > HARD_MAX_PINNED_CHARS || pinnedTokens > HARD_MAX_PINNED_TOKENS) {
        throw new WorkspaceError(
          'PINNED_BUDGET_EXCEEDED',
          `Pinned rules budget exceeded (${pinnedChars}/${HARD_MAX_PINNED_CHARS} chars, ${pinnedTokens}/${HARD_MAX_PINNED_TOKENS} tokens)`,
          422,
          {
            hardMaxChars: HARD_MAX_PINNED_CHARS,
            hardMaxTokens: HARD_MAX_PINNED_TOKENS,
            pinnedChars,
            pinnedTokens,
          },
        );
      }
    }

    if (params.addedRevisionBytes > 0) {
      const [projectHistRow] = await tx
        .select({ total: sql<string>`COALESCE(SUM(${projectFileRevisions.byteSize}), 0)` })
        .from(projectFileRevisions)
        .where(
          and(
            eq(projectFileRevisions.userId, this.userId),
            eq(projectFileRevisions.agentId, params.agentId),
          ),
        );

      const nextProjectHistoryBytes =
        Number(projectHistRow?.total ?? 0) + params.addedRevisionBytes;
      if (nextProjectHistoryBytes > MAX_PROJECT_HISTORY_BYTES) {
        throw new WorkspaceError(
          'QUOTA_EXCEEDED',
          `Project revision history exceeds ${MAX_PROJECT_HISTORY_BYTES} bytes quota`,
          413,
          {
            maxProjectHistoryBytes: MAX_PROJECT_HISTORY_BYTES,
            projectHistoryBytes: nextProjectHistoryBytes,
          },
        );
      }

      const [userHistRow] = await tx
        .select({ total: sql<string>`COALESCE(SUM(${projectFileRevisions.byteSize}), 0)` })
        .from(projectFileRevisions)
        .where(eq(projectFileRevisions.userId, this.userId));

      const nextUserHistoryBytes = Number(userHistRow?.total ?? 0) + params.addedRevisionBytes;
      if (nextUserHistoryBytes > MAX_USER_WORKSPACE_BYTES) {
        throw new WorkspaceError(
          'QUOTA_EXCEEDED',
          `User workspace storage exceeds ${MAX_USER_WORKSPACE_BYTES} bytes quota`,
          413,
          {
            maxUserWorkspaceBytes: MAX_USER_WORKSPACE_BYTES,
            userWorkspaceBytes: nextUserHistoryBytes,
          },
        );
      }
    }
  }

  private async findManagedKnowledgeBaseId(
    tx: Transaction,
    agentId: string,
  ): Promise<string | null> {
    const rows = await tx
      .select({ id: knowledgeBases.id })
      .from(knowledgeBases)
      .where(
        and(
          eq(knowledgeBases.userId, this.userId),
          eq(knowledgeBases.type, 'project_workspace'),
          sql`${knowledgeBases.settings}->>'managedByAgentId' = ${agentId}`,
        ),
      )
      .limit(1);
    return rows[0]?.id ?? null;
  }

  private async ensureManagedKnowledgeBaseId(
    tx: Transaction,
    agentId: string,
    agentTitle: string | null,
  ): Promise<string> {
    const existingId = await this.findManagedKnowledgeBaseId(tx, agentId);
    const kbId = existingId ?? idGenerator('knowledgeBases');

    if (!existingId) {
      await tx.insert(knowledgeBases).values({
        id: kbId,
        name: `Файлы проекта «${agentTitle?.trim() || 'Проект'}»`,
        settings: { managedByAgentId: agentId },
        type: 'project_workspace',
        userId: this.userId,
      });
    }

    await tx
      .insert(agentsKnowledgeBases)
      .values({
        agentId,
        enabled: true,
        knowledgeBaseId: kbId,
        userId: this.userId,
      })
      .onConflictDoUpdate({
        set: { enabled: true, updatedAt: new Date() },
        target: [agentsKnowledgeBases.agentId, agentsKnowledgeBases.knowledgeBaseId],
      });

    return kbId;
  }

  private async syncFileRagMembership(
    tx: Transaction,
    params: {
      agentId: string;
      agentTitle: string | null;
      newFileId: string | null;
      newRagEnabled: boolean;
      oldFileId: string | null;
      oldRagEnabled: boolean;
    },
  ): Promise<void> {
    const { agentId, agentTitle, newFileId, newRagEnabled, oldFileId, oldRagEnabled } = params;

    const shouldRemoveOld =
      Boolean(oldFileId) && (oldRagEnabled || !newRagEnabled) && oldFileId !== newFileId;

    const shouldDisableSame = Boolean(oldFileId) && oldRagEnabled && !newRagEnabled;
    const fileToDetach = shouldRemoveOld || shouldDisableSame ? oldFileId : null;

    if (fileToDetach) {
      const managedKbId = await this.findManagedKnowledgeBaseId(tx, agentId);
      if (managedKbId) {
        await tx
          .delete(knowledgeBaseFiles)
          .where(
            and(
              eq(knowledgeBaseFiles.knowledgeBaseId, managedKbId),
              eq(knowledgeBaseFiles.fileId, fileToDetach),
            ),
          );
      }

      const otherKbRefs = await tx
        .select({ kbId: knowledgeBaseFiles.knowledgeBaseId })
        .from(knowledgeBaseFiles)
        .where(eq(knowledgeBaseFiles.fileId, fileToDetach))
        .limit(1);

      if (otherKbRefs.length === 0) {
        await new FileModel(this.db, this.userId).deleteFileChunks(tx as any, [fileToDetach]);
      }
    }

    if (newRagEnabled && newFileId) {
      const managedKbId = await this.ensureManagedKnowledgeBaseId(tx, agentId, agentTitle);
      await tx
        .insert(knowledgeBaseFiles)
        .values({
          fileId: newFileId,
          knowledgeBaseId: managedKbId,
          userId: this.userId,
        })
        .onConflictDoNothing();
    }
  }

  private async pruneOldRevisionsInTx(tx: Transaction, workspaceFileId: string): Promise<string[]> {
    const allRevs = await tx
      .select()
      .from(projectFileRevisions)
      .where(eq(projectFileRevisions.workspaceFileId, workspaceFileId))
      .orderBy(desc(projectFileRevisions.revision));

    if (allRevs.length <= MAX_REVISIONS_KEEP) return [];

    const recentKeepCount = Math.max(1, MAX_REVISIONS_KEEP - 1);
    const keepIds = new Set<string>();
    for (let i = 0; i < allRevs.length; i++) {
      const rev = allRevs[i]!;
      if (i < recentKeepCount || rev.revision === 1) {
        keepIds.add(rev.id);
      }
    }

    const candidates = allRevs.filter((r) => !keepIds.has(r.id));
    if (candidates.length === 0) return [];

    const candidateFileIds = [...new Set(candidates.map((c) => c.fileId))];

    const [pendingProposalRefs, msgRefs] = await Promise.all([
      tx
        .select({ fileId: projectFileProposals.proposedFileId })
        .from(projectFileProposals)
        .where(
          and(
            eq(projectFileProposals.status, 'pending'),
            inArray(projectFileProposals.proposedFileId, candidateFileIds),
          ),
        ),
      tx
        .select({ fileId: messagesFiles.fileId })
        .from(messagesFiles)
        .where(inArray(messagesFiles.fileId, candidateFileIds)),
    ]);

    const protectedFileIds = new Set<string>([
      ...pendingProposalRefs.map((r) => r.fileId).filter((v): v is string => Boolean(v)),
      ...msgRefs.map((r) => r.fileId),
    ]);

    const revsToDelete = candidates.filter((c) => !protectedFileIds.has(c.fileId));
    if (revsToDelete.length === 0) return [];

    await tx.delete(projectFileRevisions).where(
      inArray(
        projectFileRevisions.id,
        revsToDelete.map((r) => r.id),
      ),
    );

    const remainingRevIds = new Set(
      allRevs.filter((r) => !revsToDelete.includes(r)).map((r) => r.id),
    );
    const stillUsedFileIds = new Set<string>();
    const stillUsedDocIds = new Set<string>();
    for (const r of allRevs) {
      if (remainingRevIds.has(r.id)) {
        stillUsedFileIds.add(r.fileId);
        if (r.documentId) stillUsedDocIds.add(r.documentId);
      }
    }

    const docCandidates = [
      ...new Set(
        revsToDelete
          .map((r) => r.documentId)
          .filter(
            (id): id is string =>
              typeof id === 'string' && id.length > 0 && !stillUsedDocIds.has(id),
          ),
      ),
    ];

    if (docCandidates.length > 0) {
      const [pwfDocRefs, agentDocRefs, topicDocRefs] = await Promise.all([
        tx
          .select({ id: projectWorkspaceFiles.currentDocumentId })
          .from(projectWorkspaceFiles)
          .where(inArray(projectWorkspaceFiles.currentDocumentId, docCandidates)),
        tx
          .select({ id: agentDocuments.documentId })
          .from(agentDocuments)
          .where(inArray(agentDocuments.documentId, docCandidates)),
        tx
          .select({ id: topicDocuments.documentId })
          .from(topicDocuments)
          .where(inArray(topicDocuments.documentId, docCandidates)),
      ]);
      const busyDocs = new Set<string>([
        ...pwfDocRefs.map((r) => r.id).filter((v): v is string => Boolean(v)),
        ...agentDocRefs.map((r) => r.id),
        ...topicDocRefs.map((r) => r.id),
      ]);
      const deletableDocs = docCandidates.filter((id) => !busyDocs.has(id));
      if (deletableDocs.length > 0) {
        await tx
          .delete(documents)
          .where(and(inArray(documents.id, deletableDocs), eq(documents.userId, this.userId)));
      }
    }

    const fileCandidates = [
      ...new Set(revsToDelete.map((r) => r.fileId).filter((id) => !stillUsedFileIds.has(id))),
    ];
    if (fileCandidates.length === 0) return [];

    const [pwfRefs, pfrRefs, pfpRefs, kbRefs, afRefs] = await Promise.all([
      tx
        .select({ id: projectWorkspaceFiles.currentFileId })
        .from(projectWorkspaceFiles)
        .where(inArray(projectWorkspaceFiles.currentFileId, fileCandidates)),
      tx
        .select({ id: projectFileRevisions.fileId })
        .from(projectFileRevisions)
        .where(inArray(projectFileRevisions.fileId, fileCandidates)),
      tx
        .select({ id: projectFileProposals.proposedFileId })
        .from(projectFileProposals)
        .where(inArray(projectFileProposals.proposedFileId, fileCandidates)),
      tx
        .select({ id: knowledgeBaseFiles.fileId })
        .from(knowledgeBaseFiles)
        .where(inArray(knowledgeBaseFiles.fileId, fileCandidates)),
      tx
        .select({ id: agentsFiles.fileId })
        .from(agentsFiles)
        .where(inArray(agentsFiles.fileId, fileCandidates)),
    ]);

    const busyFiles = new Set<string>([
      ...pwfRefs.map((r) => r.id),
      ...pfrRefs.map((r) => r.id),
      ...pfpRefs.map((r) => r.id).filter((v): v is string => Boolean(v)),
      ...kbRefs.map((r) => r.id),
      ...afRefs.map((r) => r.id),
    ]);

    const deletableFiles = fileCandidates.filter((id) => !busyFiles.has(id));
    if (deletableFiles.length === 0) return [];

    const fileRows = await tx
      .select({ fileHash: files.fileHash, id: files.id, url: files.url })
      .from(files)
      .where(and(inArray(files.id, deletableFiles), eq(files.userId, this.userId)));

    await new FileModel(this.db, this.userId).deleteFileChunks(tx as any, deletableFiles);
    await tx
      .delete(files)
      .where(and(inArray(files.id, deletableFiles), eq(files.userId, this.userId)));

    const candidateUrls = [...new Set(fileRows.map((f) => f.url).filter(Boolean))];
    if (candidateUrls.length === 0) return [];

    const stillReferencedUrls = await tx
      .select({ url: files.url })
      .from(files)
      .where(inArray(files.url, candidateUrls));
    const usedUrlSet = new Set(stillReferencedUrls.map((r) => r.url));

    return candidateUrls.filter(
      (u) => !usedUrlSet.has(u) && u.startsWith(`files/${this.userId}/project-workspace/`),
    );
  }

  private async readTextContentForWorkspaceRow(
    executor: LobeChatDatabase | Transaction,
    params: { documentId: string | null; fileId: string },
  ): Promise<{ encoding: SourceTextEncoding; lineEnding: SourceLineEnding; text: string }> {
    if (params.documentId) {
      const [doc] = await executor
        .select({ content: documents.content, metadata: documents.metadata })
        .from(documents)
        .where(eq(documents.id, params.documentId))
        .limit(1);

      if (doc && typeof doc.content === 'string') {
        const encoding = (doc.metadata?.encoding as SourceTextEncoding | undefined) ?? 'utf-8';
        const lineEnding =
          (doc.metadata?.lineEnding as SourceLineEnding | undefined) ??
          detectLineEnding(doc.content);
        return { encoding, lineEnding, text: doc.content };
      }
    }

    const [fileRow] = await executor
      .select({ url: files.url })
      .from(files)
      .where(and(eq(files.id, params.fileId), eq(files.userId, this.userId)))
      .limit(1);

    if (!fileRow) {
      throw new WorkspaceError('FILE_NOT_FOUND', 'Underlying workspace file record not found', 404);
    }

    const bytes = await this.storage.getFileByteArray(fileRow.url);
    if (bytes.byteLength === 0) {
      return { encoding: 'utf-8', lineEnding: 'LF', text: '' };
    }
    const decoded = decodeSourceText(bytes);
    return {
      encoding: decoded.encoding,
      lineEnding: decoded.lineEnding,
      text: decoded.text,
    };
  }

  public async getWorkspaceOverview(agentId: string): Promise<{
    budget: WorkspaceBudgetSummary;
    files: WorkspaceFileDto[];
    instructionFile: WorkspaceFileDto | null;
    pendingProposals: WorkspaceProposalDto[];
    workspaceEnabled: boolean;
  }> {
    await this.ensureAgentOwned(this.db, agentId, false);

    const activeRows = await this.db
      .select()
      .from(projectWorkspaceFiles)
      .where(
        and(
          eq(projectWorkspaceFiles.userId, this.userId),
          eq(projectWorkspaceFiles.agentId, agentId),
          isNull(projectWorkspaceFiles.deletedAt),
        ),
      )
      .orderBy(asc(projectWorkspaceFiles.loadPriority), asc(projectWorkspaceFiles.path));

    const [dtos, budget, pendingProposals] = await Promise.all([
      this.toFileDtos(this.db, activeRows),
      this.computeBudgetSummary(this.db, agentId),
      listPendingProposalsForAgent(this.db, this.userId, agentId),
    ]);

    const instructionFile = dtos.find((f) => isRootAgentsMd(f.path)) ?? null;

    return {
      budget,
      files: dtos,
      instructionFile,
      pendingProposals,
      workspaceEnabled: isWorkspaceEnabled(),
    };
  }

  public async getFileDetail(
    agentId: string,
    workspaceFileId: string,
    opts?: { includeContent?: boolean; revision?: number },
  ): Promise<{
    content: string | null;
    downloadUrl: string;
    file: WorkspaceFileDto;
    revision: number;
  }> {
    await this.ensureAgentOwned(this.db, agentId, false);

    const rows = await this.db
      .select()
      .from(projectWorkspaceFiles)
      .where(
        and(
          eq(projectWorkspaceFiles.id, workspaceFileId),
          eq(projectWorkspaceFiles.agentId, agentId),
          eq(projectWorkspaceFiles.userId, this.userId),
          opts?.revision === undefined ? isNull(projectWorkspaceFiles.deletedAt) : undefined,
        ),
      )
      .limit(1);

    const row = rows[0];
    if (!row) {
      throw new WorkspaceError('FILE_NOT_FOUND', 'Workspace file not found', 404);
    }

    let targetFileId = row.currentFileId;
    let targetDocId = row.currentDocumentId;
    let targetRevision = row.currentRevision;

    if (opts?.revision !== undefined) {
      const [revRow] = await this.db
        .select()
        .from(projectFileRevisions)
        .where(
          and(
            eq(projectFileRevisions.workspaceFileId, row.id),
            eq(projectFileRevisions.revision, opts.revision),
          ),
        )
        .limit(1);

      if (!revRow) {
        throw new WorkspaceError(
          'INVALID_REVISION',
          `Revision v${opts.revision} not found for "${row.path}"`,
          404,
        );
      }

      targetFileId = revRow.fileId;
      targetDocId = revRow.documentId;
      targetRevision = revRow.revision;
    }

    const [fileRecord] = await this.db
      .select({ url: files.url })
      .from(files)
      .where(and(eq(files.id, targetFileId), eq(files.userId, this.userId)))
      .limit(1);

    if (!fileRecord) {
      throw new WorkspaceError('FILE_NOT_FOUND', 'Storage file record not found', 404);
    }

    const { basename } = extractWorkspaceBasenameAndExt(row.path);
    const downloadUrl = await this.storage.createPreSignedUrlForPreview(fileRecord.url, undefined, {
      responseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(basename)}`,
    });

    const includeContent = opts?.includeContent !== false && row.kind === 'text';
    let content: string | null = null;
    if (includeContent) {
      const loaded = await this.readTextContentForWorkspaceRow(this.db, {
        documentId: targetDocId ?? null,
        fileId: targetFileId,
      });
      content = loaded.text;
    }

    const [dto] = await this.toFileDtos(this.db, [row]);

    return {
      content,
      downloadUrl,
      file: dto!,
      revision: targetRevision,
    };
  }

  private async executeTextWriteCore(params: {
    actor: 'agent' | 'migration' | 'sandbox' | 'user';
    agentId: string;
    allowLatestRevisionInTx?: boolean;
    baseRevision?: number | null;
    changeNote?: string | null;
    content?: string;
    encodedBytesOverride?: Uint8Array;
    encoding?: SourceTextEncoding;
    isProtected?: boolean;
    lineEnding?: SourceLineEnding;
    loadMode?: WorkspaceLoadMode;
    messageId?: string | null;
    path: string;
    reason?: string | null;
    requireExpectedReadRevision?: number;
    topicId?: string | null;
    userSummary?: string | null;
  }): Promise<{
    addedLines: number;
    budget?: WorkspaceBudgetSummary;
    file?: WorkspaceFileDto;
    outcome: 'created' | 'proposal_created' | 'restored' | 'updated';
    prevRevision: number | null;
    proposal?: WorkspaceProposalDto;
    removedLines: number;
  }> {
    const normalizedPath = normalizeWorkspacePath(params.path);
    const cleanedSummary =
      params.userSummary !== undefined ? sanitizeUserSummary(params.userSummary) : undefined;
    const cleanedChangeNote = sanitizeChangeNote(params.changeNote);

    const [existingHint] = await this.db
      .select()
      .from(projectWorkspaceFiles)
      .where(
        and(
          eq(projectWorkspaceFiles.userId, this.userId),
          eq(projectWorkspaceFiles.agentId, params.agentId),
          sql`lower(${projectWorkspaceFiles.path}) = lower(${normalizedPath})`,
        ),
      )
      .limit(1);

    let oldText = '';
    if (existingHint && existingHint.deletedAt === null && existingHint.kind === 'text') {
      try {
        const prev = await this.readTextContentForWorkspaceRow(this.db, {
          documentId: existingHint.currentDocumentId ?? null,
          fileId: existingHint.currentFileId,
        });
        oldText = prev.text;
      } catch {
        oldText = '';
      }
    }

    let encodedBytes: Uint8Array;
    let finalEncoding: SourceTextEncoding;
    let finalLineEnding: SourceLineEnding;
    let canonicalText: string;

    try {
      if (params.encodedBytesOverride) {
        encodedBytes = params.encodedBytesOverride;
        validateWorkspaceTextBuffer(encodedBytes, normalizedPath);
        if (encodedBytes.byteLength === 0) {
          finalEncoding =
            params.encoding ??
            (existingHint?.encoding as SourceTextEncoding | undefined) ??
            'utf-8';
          finalLineEnding =
            params.lineEnding ?? (existingHint?.lineEnding as SourceLineEnding | undefined) ?? 'LF';
          canonicalText = '';
        } else {
          const decoded = decodeSourceText(encodedBytes);
          finalEncoding = decoded.encoding;
          finalLineEnding = decoded.lineEnding;
          canonicalText = stripLeadingBomChar(decoded.text);
        }
      } else {
        const rawContent = params.content ?? '';
        finalEncoding =
          params.encoding ??
          (existingHint?.deletedAt === null
            ? ((existingHint.encoding as SourceTextEncoding | null) ?? 'utf-8')
            : 'utf-8');
        finalLineEnding =
          params.lineEnding ??
          (existingHint?.deletedAt === null && existingHint.lineEnding
            ? (existingHint.lineEnding as SourceLineEnding)
            : detectLineEnding(rawContent));

        encodedBytes = encodeSourceText(rawContent, finalEncoding, finalLineEnding);
        validateWorkspaceTextBuffer(encodedBytes, normalizedPath);
        const lfText = stripLeadingBomChar(rawContent)
          .replaceAll('\r\n', '\n')
          .replaceAll('\r', '\n');
        canonicalText = finalLineEnding === 'CRLF' ? lfText.replaceAll('\n', '\r\n') : lfText;
      }
    } catch (error) {
      throw mapEncodingError(error);
    }

    const mimeType = resolveCanonicalTextMimeType(normalizedPath);
    const contentSha256 = sha256(encodedBytes);
    const byteSize = encodedBytes.byteLength;
    const charCount = canonicalText.length;
    const lineCount = countTextLines(canonicalText);
    const estimatedTokens = estimateWorkspaceTokens(canonicalText);

    const workspaceFileIdForS3 = existingHint?.id ?? crypto.randomUUID();
    const candidateRev = (existingHint?.currentRevision ?? 0) + 1;
    const s3Key = this.buildImmutableS3Key(
      params.agentId,
      workspaceFileIdForS3,
      candidateRev,
      contentSha256,
    );

    await this.storage.uploadBuffer(s3Key, Buffer.from(encodedBytes), mimeType, true);

    let keepUploadedS3 = false;
    const S3KeysToPrune: string[] = [];

    try {
      const txResult = await this.db.transaction(async (tx) => {
        const agent = await this.ensureAgentOwned(tx, params.agentId, true);
        this.assertNotInboxInstruction(agent, normalizedPath);

        const lockedRow = await this.lockWorkspaceRowByPath(tx, params.agentId, normalizedPath);

        if (lockedRow && lockedRow.deletedAt === null && lockedRow.kind === 'document') {
          throw new WorkspaceError(
            'PROTECTED_FILE',
            `Cannot overwrite binary document "${lockedRow.path}" with text content`,
            403,
          );
        }

        const effectiveLoadMode: WorkspaceLoadMode =
          params.loadMode ??
          (lockedRow && lockedRow.deletedAt === null
            ? (lockedRow.loadMode as WorkspaceLoadMode)
            : isRootAgentsMd(normalizedPath)
              ? 'always'
              : 'on_demand');

        validateWorkspaceLoadMode(normalizedPath, effectiveLoadMode);

        const isTargetProtected =
          (lockedRow !== undefined && lockedRow.deletedAt === null && lockedRow.isProtected) ||
          isAutoProtectedPath(normalizedPath, effectiveLoadMode);

        if (
          params.requireExpectedReadRevision !== undefined &&
          (!lockedRow ||
            lockedRow.deletedAt !== null ||
            lockedRow.currentRevision !== params.requireExpectedReadRevision)
        ) {
          throw new WorkspaceError(
            'REVISION_CONFLICT',
            `Workspace file "${normalizedPath}" changed concurrently`,
            409,
            {
              currentRevision: lockedRow?.currentRevision ?? null,
              updatedAt: lockedRow?.updatedAt ? lockedRow.updatedAt.toISOString() : null,
              updatedBy: lockedRow?.updatedBy ?? null,
            },
          );
        }

        if (params.actor !== 'user' && params.actor !== 'migration' && isTargetProtected) {
          if (
            params.baseRevision !== undefined &&
            params.baseRevision !== null &&
            params.baseRevision > 0 &&
            (!lockedRow ||
              lockedRow.deletedAt !== null ||
              lockedRow.currentRevision !== params.baseRevision)
          ) {
            throw new WorkspaceError(
              'REVISION_CONFLICT',
              `Base revision v${params.baseRevision} is stale for protected file "${normalizedPath}"`,
              409,
              {
                currentRevision: lockedRow?.currentRevision ?? null,
                updatedAt: lockedRow?.updatedAt ? lockedRow.updatedAt.toISOString() : null,
                updatedBy: lockedRow?.updatedBy ?? null,
              },
            );
          }

          const diffBase = lockedRow && lockedRow.deletedAt === null ? oldText : '';
          const diff = computeUnifiedDiff(normalizedPath, diffBase, canonicalText);
          const proposedFileId = idGenerator('files');
          const { basename } = extractWorkspaceBasenameAndExt(normalizedPath);

          await tx.insert(files).values({
            fileHash: null,
            fileType: mimeType,
            id: proposedFileId,
            metadata: {
              charCount,
              contentSha256,
              encoding: finalEncoding,
              estimatedTokens,
              lineCount,
              lineEnding: finalLineEnding,
              workspacePath: normalizedPath,
            },
            name: basename,
            size: byteSize,
            url: s3Key,
            userId: this.userId,
          });

          keepUploadedS3 = true;

          const proposal = await insertWorkspaceProposal(tx, {
            addedLines: diff.addedLines,
            agentId: params.agentId,
            baseRevision:
              lockedRow && lockedRow.deletedAt === null ? lockedRow.currentRevision : null,
            diffPreview: diff.patch,
            messageId: params.messageId,
            proposalType: lockedRow && lockedRow.deletedAt === null ? 'edit' : 'create_pinned',
            proposedFileId,
            reason: params.reason ?? cleanedChangeNote,
            removedLines: diff.removedLines,
            targetPath: lockedRow?.path ?? normalizedPath,
            topicId: params.topicId,
            userId: this.userId,
            workspaceFileId: lockedRow?.id ?? null,
          });

          return {
            addedLines: diff.addedLines,
            outcome: 'proposal_created' as const,
            prevRevision:
              lockedRow && lockedRow.deletedAt === null ? lockedRow.currentRevision : null,
            proposal,
            removedLines: diff.removedLines,
          };
        }

        if (!params.allowLatestRevisionInTx) {
          if (
            params.baseRevision === undefined ||
            params.baseRevision === null ||
            params.baseRevision === 0
          ) {
            if (lockedRow && lockedRow.deletedAt === null) {
              throw new WorkspaceError(
                'FILE_ALREADY_EXISTS',
                `Workspace file "${lockedRow.path}" already exists at revision v${lockedRow.currentRevision}`,
                409,
                {
                  currentRevision: lockedRow.currentRevision,
                  updatedAt: lockedRow.updatedAt.toISOString(),
                  updatedBy: lockedRow.updatedBy,
                },
              );
            }
          } else {
            if (
              !lockedRow ||
              lockedRow.deletedAt !== null ||
              lockedRow.currentRevision !== params.baseRevision
            ) {
              throw new WorkspaceError(
                'REVISION_CONFLICT',
                `Revision conflict on "${normalizedPath}": expected v${params.baseRevision}, actual v${lockedRow?.currentRevision ?? 'none'}`,
                409,
                {
                  currentRevision: lockedRow?.currentRevision ?? null,
                  updatedAt: lockedRow?.updatedAt ? lockedRow.updatedAt.toISOString() : null,
                  updatedBy: lockedRow?.updatedBy ?? null,
                },
              );
            }
          }
        }

        const isResurrecting = Boolean(lockedRow && lockedRow.deletedAt !== null);
        const isCreatingNewRow = !lockedRow;

        await this.assertBudgetAndQuotasForWrite(tx, {
          addedRevisionBytes: byteSize,
          agentId: params.agentId,
          excludeWorkspaceFileId: lockedRow?.id,
          isCreatingActiveSlot: isCreatingNewRow || isResurrecting,
          newByteSize: byteSize,
          newCharCount: charCount,
          newEstimatedTokens: estimatedTokens,
          newKind: 'text',
          newLoadMode: effectiveLoadMode,
        });

        const nextRev = lockedRow ? lockedRow.currentRevision + 1 : 1;
        const prevActiveRev =
          lockedRow && lockedRow.deletedAt === null ? lockedRow.currentRevision : null;
        const diffBase = lockedRow && lockedRow.deletedAt === null ? oldText : '';
        const diff = computeUnifiedDiff(normalizedPath, diffBase, canonicalText);

        const newFileId = idGenerator('files');
        const newDocId = idGenerator('documents', 16);
        const { basename } = extractWorkspaceBasenameAndExt(normalizedPath);

        await tx.insert(files).values({
          fileHash: null,
          fileType: mimeType,
          id: newFileId,
          metadata: {
            charCount,
            contentSha256,
            encoding: finalEncoding,
            estimatedTokens,
            lineCount,
            lineEnding: finalLineEnding,
            workspacePath: normalizedPath,
          },
          name: basename,
          size: byteSize,
          url: s3Key,
          userId: this.userId,
        });

        await tx.insert(documents).values({
          content: canonicalText,
          fileId: newFileId,
          fileType: mimeType,
          filename: normalizedPath,
          id: newDocId,
          metadata: {
            encoding: finalEncoding,
            estimatedTokens,
            lineEnding: finalLineEnding,
            workspacePath: normalizedPath,
          },
          source: s3Key,
          sourceType: 'file',
          title: basename,
          totalCharCount: charCount,
          totalLineCount: lineCount,
          userId: this.userId,
        });

        const effectiveProtected = resolveEffectiveProtection(
          normalizedPath,
          effectiveLoadMode,
          params.isProtected ?? (lockedRow?.deletedAt === null ? lockedRow.isProtected : false),
        );

        const nextSummary =
          cleanedSummary !== undefined
            ? cleanedSummary
            : lockedRow?.deletedAt === null
              ? lockedRow.userSummary
              : null;

        const nextRagEnabled = lockedRow?.deletedAt === null ? lockedRow.ragEnabled : false;
        const nextPriority =
          lockedRow?.deletedAt === null && params.loadMode === undefined
            ? lockedRow.loadPriority
            : defaultPriorityForPathAndMode(normalizedPath, effectiveLoadMode);

        let savedRow: ProjectWorkspaceFileItem;

        if (!lockedRow) {
          const [inserted] = await tx
            .insert(projectWorkspaceFiles)
            .values({
              agentId: params.agentId,
              byteSize,
              charCount,
              contentSha256,
              createdBy: params.actor,
              currentDocumentId: newDocId,
              currentFileId: newFileId,
              currentRevision: 1,
              dataGuardStatus: 'unmasked',
              deletedAt: null,
              deletedBy: null,
              encoding: finalEncoding,
              id: workspaceFileIdForS3,
              isProtected: effectiveProtected,
              kind: 'text',
              lastTopicId: params.topicId ?? null,
              lineCount,
              lineEnding: finalLineEnding,
              loadMode: effectiveLoadMode,
              loadPriority: nextPriority,
              mimeType,
              path: normalizedPath,
              ragEnabled: nextRagEnabled,
              updatedBy: params.actor,
              userId: this.userId,
              userSummary: nextSummary,
            })
            .returning();
          savedRow = inserted!;
        } else {
          const [updated] = await tx
            .update(projectWorkspaceFiles)
            .set({
              byteSize,
              charCount,
              contentSha256,
              currentDocumentId: newDocId,
              currentFileId: newFileId,
              currentRevision: nextRev,
              deletedAt: null,
              deletedBy: null,
              encoding: finalEncoding,
              isProtected: effectiveProtected,
              kind: 'text',
              lastTopicId: params.topicId ?? lockedRow.lastTopicId,
              lineCount,
              lineEnding: finalLineEnding,
              loadMode: effectiveLoadMode,
              loadPriority: nextPriority,
              mimeType,
              path: normalizedPath,
              ragEnabled: nextRagEnabled,
              updatedAt: new Date(),
              updatedBy: params.actor,
              userSummary: nextSummary,
            })
            .where(eq(projectWorkspaceFiles.id, lockedRow.id))
            .returning();
          savedRow = updated!;
        }

        await tx.insert(projectFileRevisions).values({
          agentId: params.agentId,
          authorType: params.actor,
          byteSize,
          changeNote: cleanedChangeNote,
          charCount,
          contentSha256,
          diffStats: { addedLines: diff.addedLines, removedLines: diff.removedLines },
          documentId: newDocId,
          encoding: finalEncoding,
          fileId: newFileId,
          lineCount,
          lineEnding: finalLineEnding,
          messageId: params.messageId ?? null,
          revision: nextRev,
          topicId: params.topicId ?? null,
          userId: this.userId,
          workspaceFileId: savedRow.id,
        });

        if (isRootAgentsMd(normalizedPath)) {
          await tx
            .update(agents)
            .set({ systemRole: null, updatedAt: new Date() })
            .where(and(eq(agents.id, params.agentId), eq(agents.userId, this.userId)));
        }

        await this.syncFileRagMembership(tx, {
          agentId: params.agentId,
          agentTitle: agent.title,
          newFileId,
          newRagEnabled: nextRagEnabled,
          oldFileId: lockedRow?.currentFileId ?? null,
          oldRagEnabled: Boolean(lockedRow?.ragEnabled),
        });

        const prunedKeys = await this.pruneOldRevisionsInTx(tx, savedRow.id);
        S3KeysToPrune.push(...prunedKeys);

        keepUploadedS3 = true;

        const [fileDto] = await this.toFileDtos(tx, [savedRow]);
        const budget = await this.computeBudgetSummary(tx, params.agentId);

        const writeOutcome: 'created' | 'restored' | 'updated' = isCreatingNewRow
          ? 'created'
          : isResurrecting
            ? 'restored'
            : 'updated';

        return {
          addedLines: diff.addedLines,
          budget,
          file: fileDto!,
          outcome: writeOutcome,
          prevRevision: prevActiveRev,
          removedLines: diff.removedLines,
        };
      });

      if (S3KeysToPrune.length > 0) {
        await this.safeDeleteS3Keys(S3KeysToPrune);
      }

      return txResult;
    } catch (error) {
      if (!keepUploadedS3) {
        await this.safeDeleteS3Key(s3Key);
      }

      if (isPgUniqueViolation(error)) {
        const [winner] = await this.db
          .select()
          .from(projectWorkspaceFiles)
          .where(
            and(
              eq(projectWorkspaceFiles.userId, this.userId),
              eq(projectWorkspaceFiles.agentId, params.agentId),
              sql`lower(${projectWorkspaceFiles.path}) = lower(${normalizedPath})`,
            ),
          )
          .limit(1);

        throw new WorkspaceError(
          'FILE_ALREADY_EXISTS',
          `Concurrent creation conflict for "${normalizedPath}"`,
          409,
          {
            currentRevision: winner?.currentRevision ?? null,
            updatedAt: winner?.updatedAt ? winner.updatedAt.toISOString() : null,
            updatedBy: winner?.updatedBy ?? null,
          },
        );
      }

      throw error;
    }
  }

  public async putUserTextFile(
    agentId: string,
    input: {
      baseRevision?: number | null;
      changeNote?: string | null;
      content: string;
      encoding?: SourceTextEncoding;
      isProtected?: boolean;
      lineEnding?: SourceLineEnding;
      loadMode?: WorkspaceLoadMode;
      path: string;
      userSummary?: string | null;
    },
  ): Promise<{
    budget: WorkspaceBudgetSummary;
    deleted: boolean;
    file: WorkspaceFileDto | null;
  }> {
    const normalizedPath = normalizeWorkspacePath(input.path);

    if (isRootAgentsMd(normalizedPath) && input.content.trim() === '') {
      return this.db.transaction(async (tx) => {
        const agent = await this.ensureAgentOwned(tx, agentId, true);
        this.assertNotInboxInstruction(agent, normalizedPath);

        const lockedRow = await this.lockWorkspaceRowByPath(tx, agentId, normalizedPath);

        await tx
          .update(agents)
          .set({ systemRole: null, updatedAt: new Date() })
          .where(and(eq(agents.id, agentId), eq(agents.userId, this.userId)));

        if (lockedRow && lockedRow.deletedAt === null) {
          if (
            input.baseRevision !== undefined &&
            input.baseRevision !== null &&
            input.baseRevision > 0 &&
            lockedRow.currentRevision !== input.baseRevision
          ) {
            throw new WorkspaceError(
              'REVISION_CONFLICT',
              `Revision conflict while clearing AGENTS.md: expected v${input.baseRevision}, actual v${lockedRow.currentRevision}`,
              409,
              {
                currentRevision: lockedRow.currentRevision,
                updatedAt: lockedRow.updatedAt.toISOString(),
                updatedBy: lockedRow.updatedBy,
              },
            );
          }

          await tx
            .update(projectWorkspaceFiles)
            .set({
              deletedAt: new Date(),
              deletedBy: 'user',
              updatedAt: new Date(),
              updatedBy: 'user',
            })
            .where(eq(projectWorkspaceFiles.id, lockedRow.id));

          await this.syncFileRagMembership(tx, {
            agentId,
            agentTitle: agent.title,
            newFileId: null,
            newRagEnabled: false,
            oldFileId: lockedRow.currentFileId,
            oldRagEnabled: lockedRow.ragEnabled,
          });

          const budget = await this.computeBudgetSummary(tx, agentId);
          return { budget, deleted: true, file: null };
        }

        const budget = await this.computeBudgetSummary(tx, agentId);
        return { budget, deleted: false, file: null };
      });
    }

    const res = await this.executeTextWriteCore({
      actor: 'user',
      agentId,
      baseRevision: input.baseRevision,
      changeNote: input.changeNote,
      content: input.content,
      encoding: input.encoding,
      isProtected: isRootAgentsMd(normalizedPath) ? true : input.isProtected,
      lineEnding: input.lineEnding,
      loadMode: input.loadMode ?? (isRootAgentsMd(normalizedPath) ? 'always' : undefined),
      path: normalizedPath,
      userSummary: input.userSummary,
    });

    return {
      budget: res.budget!,
      deleted: false,
      file: res.file!,
    };
  }

  public async syncAgentInstructionFromAgentApi(
    agentId: string,
    systemRole: string | null | undefined,
    _opts?: { isCreate?: boolean },
  ): Promise<{ changed: boolean; file: WorkspaceFileDto | null }> {
    if (systemRole === undefined) {
      return { changed: false, file: null };
    }

    if (systemRole === null || systemRole.trim() === '') {
      return this.db.transaction(async (tx) => {
        const agent = await this.ensureAgentOwned(tx, agentId, true);
        if (agent.slug === 'inbox' || agent.virtual === true) {
          return { changed: false, file: null };
        }

        const lockedRow = await this.lockWorkspaceRowByPath(tx, agentId, 'AGENTS.md');
        await tx
          .update(agents)
          .set({ systemRole: null, updatedAt: new Date() })
          .where(and(eq(agents.id, agentId), eq(agents.userId, this.userId)));

        if (lockedRow && lockedRow.deletedAt === null) {
          await tx
            .update(projectWorkspaceFiles)
            .set({
              deletedAt: new Date(),
              deletedBy: 'user',
              updatedAt: new Date(),
              updatedBy: 'user',
            })
            .where(eq(projectWorkspaceFiles.id, lockedRow.id));

          await this.syncFileRagMembership(tx, {
            agentId,
            agentTitle: agent.title,
            newFileId: null,
            newRagEnabled: false,
            oldFileId: lockedRow.currentFileId,
            oldRagEnabled: lockedRow.ragEnabled,
          });
          return { changed: true, file: null };
        }

        return { changed: false, file: null };
      });
    }

    const res = await this.executeTextWriteCore({
      actor: 'user',
      agentId,
      allowLatestRevisionInTx: true,
      changeNote: 'Synced via agent instruction API',
      content: systemRole,
      isProtected: true,
      path: 'AGENTS.md',
    });

    return { changed: true, file: res.file ?? null };
  }

  public async registerUploadedFile(
    agentId: string,
    input: {
      baseRevision?: number | null;
      enableRag?: boolean;
      fileId: string;
      kind: WorkspaceFileKind;
      loadMode?: WorkspaceLoadMode;
      mimeType: string;
      path: string;
      userSummary?: string | null;
    },
  ): Promise<{
    budget: WorkspaceBudgetSummary;
    deleted: false;
    file: WorkspaceFileDto;
  }> {
    const normalizedPath = normalizeWorkspacePath(input.path);
    const cleanedSummary = sanitizeUserSummary(input.userSummary);

    const fileModel = new FileModel(this.db, this.userId);
    const uploadedFile = await fileModel.findById(input.fileId);
    if (!uploadedFile) {
      throw new WorkspaceError('FILE_NOT_FOUND', 'Uploaded file record not found', 404);
    }

    if (input.kind === 'text') {
      if (uploadedFile.size > MAX_WORKSPACE_TEXT_BYTES) {
        throw new WorkspaceError(
          'FILE_TOO_LARGE',
          `Uploaded text file size (${uploadedFile.size} bytes) exceeds ${MAX_WORKSPACE_TEXT_BYTES} bytes`,
          413,
        );
      }

      const bytes = await this.storage.getFileByteArray(uploadedFile.url);
      validateWorkspaceTextBuffer(bytes, normalizedPath);

      let decoded: { encoding: SourceTextEncoding; lineEnding: SourceLineEnding; text: string };
      try {
        decoded =
          bytes.byteLength === 0
            ? { encoding: 'utf-8', lineEnding: 'LF', text: '' }
            : decodeSourceText(bytes);
      } catch (error) {
        throw mapEncodingError(error);
      }

      const canonicalText = stripLeadingBomChar(decoded.text);
      const byteSize = bytes.byteLength;
      const charCount = canonicalText.length;
      const lineCount = countTextLines(canonicalText);
      const estimatedTokens = estimateWorkspaceTokens(canonicalText);
      const contentSha256 = sha256(bytes);
      const mimeType = resolveCanonicalTextMimeType(normalizedPath);
      const effectiveLoadMode: WorkspaceLoadMode =
        input.loadMode ?? (isRootAgentsMd(normalizedPath) ? 'always' : 'on_demand');
      validateWorkspaceLoadMode(normalizedPath, effectiveLoadMode);

      const s3KeysToPrune: string[] = [];

      const result = await this.db.transaction(async (tx) => {
        const agent = await this.ensureAgentOwned(tx, agentId, true);
        this.assertNotInboxInstruction(agent, normalizedPath);

        const lockedRow = await this.lockWorkspaceRowByPath(tx, agentId, normalizedPath);
        if (
          input.baseRevision === undefined ||
          input.baseRevision === null ||
          input.baseRevision === 0
        ) {
          if (lockedRow && lockedRow.deletedAt === null) {
            throw new WorkspaceError(
              'FILE_ALREADY_EXISTS',
              `Workspace file "${lockedRow.path}" already exists`,
              409,
              {
                currentRevision: lockedRow.currentRevision,
                updatedAt: lockedRow.updatedAt.toISOString(),
                updatedBy: lockedRow.updatedBy,
              },
            );
          }
        } else if (
          !lockedRow ||
          lockedRow.deletedAt !== null ||
          lockedRow.currentRevision !== input.baseRevision
        ) {
          throw new WorkspaceError(
            'REVISION_CONFLICT',
            `Revision conflict on "${normalizedPath}"`,
            409,
            {
              currentRevision: lockedRow?.currentRevision ?? null,
              updatedAt: lockedRow?.updatedAt ? lockedRow.updatedAt.toISOString() : null,
              updatedBy: lockedRow?.updatedBy ?? null,
            },
          );
        }

        const isResurrecting = Boolean(lockedRow && lockedRow.deletedAt !== null);
        await this.assertBudgetAndQuotasForWrite(tx, {
          addedRevisionBytes: byteSize,
          agentId,
          excludeWorkspaceFileId: lockedRow?.id,
          isCreatingActiveSlot: !lockedRow || isResurrecting,
          newByteSize: byteSize,
          newCharCount: charCount,
          newEstimatedTokens: estimatedTokens,
          newKind: 'text',
          newLoadMode: effectiveLoadMode,
        });

        const nextRev = lockedRow ? lockedRow.currentRevision + 1 : 1;
        const newDocId = idGenerator('documents', 16);
        const { basename } = extractWorkspaceBasenameAndExt(normalizedPath);

        await tx.insert(documents).values({
          content: canonicalText,
          fileId: uploadedFile.id,
          fileType: mimeType,
          filename: normalizedPath,
          id: newDocId,
          metadata: {
            encoding: decoded.encoding,
            estimatedTokens,
            lineEnding: decoded.lineEnding,
            workspacePath: normalizedPath,
          },
          source: uploadedFile.url,
          sourceType: 'file',
          title: basename,
          totalCharCount: charCount,
          totalLineCount: lineCount,
          userId: this.userId,
        });

        const ragEnabled =
          input.enableRag ?? (lockedRow?.deletedAt === null ? lockedRow.ragEnabled : false);
        const isProtected = resolveEffectiveProtection(
          normalizedPath,
          effectiveLoadMode,
          lockedRow?.deletedAt === null ? lockedRow.isProtected : false,
        );
        const priority = defaultPriorityForPathAndMode(normalizedPath, effectiveLoadMode);

        let savedRow: ProjectWorkspaceFileItem;
        if (!lockedRow) {
          const [ins] = await tx
            .insert(projectWorkspaceFiles)
            .values({
              agentId,
              byteSize,
              charCount,
              contentSha256,
              createdBy: 'user',
              currentDocumentId: newDocId,
              currentFileId: uploadedFile.id,
              currentRevision: 1,
              dataGuardStatus: 'unmasked',
              encoding: decoded.encoding,
              isProtected,
              kind: 'text',
              lineCount,
              lineEnding: decoded.lineEnding,
              loadMode: effectiveLoadMode,
              loadPriority: priority,
              mimeType,
              path: normalizedPath,
              ragEnabled,
              updatedBy: 'user',
              userId: this.userId,
              userSummary: cleanedSummary,
            })
            .returning();
          savedRow = ins!;
        } else {
          const [upd] = await tx
            .update(projectWorkspaceFiles)
            .set({
              byteSize,
              charCount,
              contentSha256,
              currentDocumentId: newDocId,
              currentFileId: uploadedFile.id,
              currentRevision: nextRev,
              deletedAt: null,
              deletedBy: null,
              encoding: decoded.encoding,
              isProtected,
              kind: 'text',
              lineCount,
              lineEnding: decoded.lineEnding,
              loadMode: effectiveLoadMode,
              loadPriority: priority,
              mimeType,
              path: normalizedPath,
              ragEnabled,
              updatedAt: new Date(),
              updatedBy: 'user',
              userSummary:
                cleanedSummary ?? (lockedRow.deletedAt === null ? lockedRow.userSummary : null),
            })
            .where(eq(projectWorkspaceFiles.id, lockedRow.id))
            .returning();
          savedRow = upd!;
        }

        await tx.insert(projectFileRevisions).values({
          agentId,
          authorType: 'user',
          byteSize,
          changeNote: 'Uploaded file',
          charCount,
          contentSha256,
          diffStats: { addedLines: lineCount, removedLines: 0 },
          documentId: newDocId,
          encoding: decoded.encoding,
          fileId: uploadedFile.id,
          lineCount,
          lineEnding: decoded.lineEnding,
          revision: nextRev,
          userId: this.userId,
          workspaceFileId: savedRow.id,
        });

        if (isRootAgentsMd(normalizedPath)) {
          await tx
            .update(agents)
            .set({ systemRole: null, updatedAt: new Date() })
            .where(and(eq(agents.id, agentId), eq(agents.userId, this.userId)));
        }

        await this.syncFileRagMembership(tx, {
          agentId,
          agentTitle: agent.title,
          newFileId: uploadedFile.id,
          newRagEnabled: ragEnabled,
          oldFileId: lockedRow?.currentFileId ?? null,
          oldRagEnabled: Boolean(lockedRow?.ragEnabled),
        });

        s3KeysToPrune.push(...(await this.pruneOldRevisionsInTx(tx, savedRow.id)));

        const [dto] = await this.toFileDtos(tx, [savedRow]);
        const budget = await this.computeBudgetSummary(tx, agentId);
        return { budget, deleted: false as const, file: dto! };
      });

      if (s3KeysToPrune.length > 0) await this.safeDeleteS3Keys(s3KeysToPrune);
      return result;
    }

    // Binary document upload ('pdf' | 'docx' | 'xlsx' | 'pptx')
    validateWorkspaceDocumentPathAndSize(normalizedPath, uploadedFile.size);
    const effectiveLoadMode: WorkspaceLoadMode = input.loadMode ?? 'on_demand';
    validateWorkspaceLoadMode(normalizedPath, effectiveLoadMode);
    if (effectiveLoadMode === 'always') {
      throw new WorkspaceError(
        'DOCUMENT_CANNOT_BE_PINNED',
        'Binary documents cannot use always loadMode; use on_demand with RAG',
        422,
      );
    }

    let contentSha256 =
      uploadedFile.fileHash && /^[0-9a-f]{64}$/i.test(uploadedFile.fileHash)
        ? uploadedFile.fileHash.toLowerCase()
        : '';
    let verifiedByteSize = uploadedFile.size;

    if (!contentSha256) {
      const bytes = await this.storage.getFileByteArray(uploadedFile.url);
      validateWorkspaceDocumentPathAndSize(normalizedPath, bytes.byteLength);
      verifiedByteSize = bytes.byteLength;
      contentSha256 = sha256(bytes);
    }

    const mimeType = input.mimeType?.trim() || resolveCanonicalDocumentMimeType(normalizedPath);
    const ragEnabled = input.enableRag ?? true;
    const s3KeysToPrune: string[] = [];

    const result = await this.db.transaction(async (tx) => {
      const agent = await this.ensureAgentOwned(tx, agentId, true);
      const lockedRow = await this.lockWorkspaceRowByPath(tx, agentId, normalizedPath);

      if (
        input.baseRevision === undefined ||
        input.baseRevision === null ||
        input.baseRevision === 0
      ) {
        if (lockedRow && lockedRow.deletedAt === null) {
          throw new WorkspaceError(
            'FILE_ALREADY_EXISTS',
            `Workspace file "${lockedRow.path}" already exists`,
            409,
            {
              currentRevision: lockedRow.currentRevision,
              updatedAt: lockedRow.updatedAt.toISOString(),
              updatedBy: lockedRow.updatedBy,
            },
          );
        }
      } else if (
        !lockedRow ||
        lockedRow.deletedAt !== null ||
        lockedRow.currentRevision !== input.baseRevision
      ) {
        throw new WorkspaceError(
          'REVISION_CONFLICT',
          `Revision conflict on "${normalizedPath}"`,
          409,
          {
            currentRevision: lockedRow?.currentRevision ?? null,
            updatedAt: lockedRow?.updatedAt ? lockedRow.updatedAt.toISOString() : null,
            updatedBy: lockedRow?.updatedBy ?? null,
          },
        );
      }

      const isResurrecting = Boolean(lockedRow && lockedRow.deletedAt !== null);
      await this.assertBudgetAndQuotasForWrite(tx, {
        addedRevisionBytes: verifiedByteSize,
        agentId,
        excludeWorkspaceFileId: lockedRow?.id,
        isCreatingActiveSlot: !lockedRow || isResurrecting,
        newByteSize: verifiedByteSize,
        newCharCount: 0,
        newEstimatedTokens: 0,
        newKind: 'document',
        newLoadMode: effectiveLoadMode,
      });

      const nextRev = lockedRow ? lockedRow.currentRevision + 1 : 1;
      const isProtected = resolveEffectiveProtection(
        normalizedPath,
        effectiveLoadMode,
        lockedRow?.deletedAt === null ? lockedRow.isProtected : false,
      );

      let savedRow: ProjectWorkspaceFileItem;
      if (!lockedRow) {
        const [ins] = await tx
          .insert(projectWorkspaceFiles)
          .values({
            agentId,
            byteSize: verifiedByteSize,
            charCount: null,
            contentSha256,
            createdBy: 'user',
            currentDocumentId: null,
            currentFileId: uploadedFile.id,
            currentRevision: 1,
            dataGuardStatus: 'unmasked',
            encoding: null,
            isProtected,
            kind: 'document',
            lineCount: null,
            lineEnding: null,
            loadMode: effectiveLoadMode,
            loadPriority: 100,
            mimeType,
            path: normalizedPath,
            ragEnabled,
            updatedBy: 'user',
            userId: this.userId,
            userSummary: cleanedSummary,
          })
          .returning();
        savedRow = ins!;
      } else {
        const [upd] = await tx
          .update(projectWorkspaceFiles)
          .set({
            byteSize: verifiedByteSize,
            charCount: null,
            contentSha256,
            currentDocumentId: null,
            currentFileId: uploadedFile.id,
            currentRevision: nextRev,
            deletedAt: null,
            deletedBy: null,
            encoding: null,
            isProtected,
            kind: 'document',
            lineCount: null,
            lineEnding: null,
            loadMode: effectiveLoadMode,
            loadPriority: 100,
            mimeType,
            path: normalizedPath,
            ragEnabled,
            updatedAt: new Date(),
            updatedBy: 'user',
            userSummary:
              cleanedSummary ?? (lockedRow.deletedAt === null ? lockedRow.userSummary : null),
          })
          .where(eq(projectWorkspaceFiles.id, lockedRow.id))
          .returning();
        savedRow = upd!;
      }

      await tx.insert(projectFileRevisions).values({
        agentId,
        authorType: 'user',
        byteSize: verifiedByteSize,
        changeNote: 'Uploaded document',
        charCount: null,
        contentSha256,
        diffStats: null,
        documentId: null,
        encoding: null,
        fileId: uploadedFile.id,
        lineCount: null,
        lineEnding: null,
        revision: nextRev,
        userId: this.userId,
        workspaceFileId: savedRow.id,
      });

      await this.syncFileRagMembership(tx, {
        agentId,
        agentTitle: agent.title,
        newFileId: uploadedFile.id,
        newRagEnabled: ragEnabled,
        oldFileId: lockedRow?.currentFileId ?? null,
        oldRagEnabled: Boolean(lockedRow?.ragEnabled),
      });

      s3KeysToPrune.push(...(await this.pruneOldRevisionsInTx(tx, savedRow.id)));

      const [dto] = await this.toFileDtos(tx, [savedRow]);
      const budget = await this.computeBudgetSummary(tx, agentId);
      return { budget, deleted: false as const, file: dto! };
    });

    if (s3KeysToPrune.length > 0) await this.safeDeleteS3Keys(s3KeysToPrune);
    return result;
  }

  public async updateFileMetadata(
    agentId: string,
    workspaceFileId: string,
    input: {
      actor?: 'agent' | 'user';
      baseRevision?: number;
      isProtected?: boolean;
      loadMode?: WorkspaceLoadMode;
      path?: string;
      ragEnabled?: boolean;
      userSummary?: string | null;
    },
  ): Promise<{
    budget: WorkspaceBudgetSummary;
    deleted: false;
    file: WorkspaceFileDto;
  }> {
    return this.db.transaction(async (tx) => {
      const agent = await this.ensureAgentOwned(tx, agentId, true);
      const row = await this.lockWorkspaceRowById(tx, agentId, workspaceFileId);
      if (!row || row.deletedAt !== null) {
        throw new WorkspaceError('FILE_NOT_FOUND', 'Workspace file not found', 404);
      }

      if (input.baseRevision !== undefined && row.currentRevision !== input.baseRevision) {
        throw new WorkspaceError(
          'REVISION_CONFLICT',
          `Revision conflict: expected v${input.baseRevision}, actual v${row.currentRevision}`,
          409,
          {
            currentRevision: row.currentRevision,
            updatedAt: row.updatedAt.toISOString(),
            updatedBy: row.updatedBy,
          },
        );
      }

      if (input.actor && input.actor !== 'user' && row.isProtected) {
        throw new WorkspaceError('PROTECTED_FILE', `File "${row.path}" is protected`, 403);
      }

      const nextPath = input.path !== undefined ? normalizeWorkspacePath(input.path) : row.path;
      this.assertNotInboxInstruction(agent, nextPath);

      const nextLoadMode: WorkspaceLoadMode = input.loadMode ?? (row.loadMode as WorkspaceLoadMode);
      validateWorkspaceLoadMode(nextPath, nextLoadMode);

      if (
        input.actor &&
        input.actor !== 'user' &&
        (isAutoProtectedPath(nextPath, nextLoadMode) || input.isProtected === true)
      ) {
        throw new WorkspaceError(
          'PROTECTED_FILE',
          `Agent actor cannot move or promote file into protected rule path "${nextPath}"`,
          403,
        );
      }

      if (nextPath.toLowerCase() !== row.path.toLowerCase()) {
        if (row.kind === 'text' && !isAllowedWorkspaceTextPath(nextPath)) {
          throw new WorkspaceError(
            'UNSUPPORTED_TEXT_EXTENSION',
            `Unsupported text file extension for "${nextPath}"`,
            415,
          );
        }
        if (row.kind === 'document' && !isAllowedWorkspaceDocumentPath(nextPath)) {
          throw new WorkspaceError(
            'UNSUPPORTED_DOCUMENT_EXTENSION',
            `Unsupported document extension for "${nextPath}"`,
            415,
          );
        }

        const existingAtTarget = await this.lockWorkspaceRowByPath(tx, agentId, nextPath);
        if (existingAtTarget && existingAtTarget.id !== row.id) {
          throw new WorkspaceError(
            'FILE_ALREADY_EXISTS',
            `Another workspace file entry already exists at "${nextPath}"`,
            409,
            {
              currentRevision: existingAtTarget.currentRevision,
              updatedAt: existingAtTarget.updatedAt.toISOString(),
              updatedBy: existingAtTarget.updatedBy,
            },
          );
        }
      }

      const tokensMap = await this.resolveEstimatedTokensMap(tx, [row]);
      const rowTokens =
        row.kind === 'text'
          ? row.currentDocumentId
            ? (tokensMap.get(row.currentDocumentId) ?? Math.ceil((row.charCount ?? 0) * 0.45))
            : Math.ceil((row.charCount ?? 0) * 0.45)
          : 0;

      await this.assertBudgetAndQuotasForWrite(tx, {
        addedRevisionBytes: 0,
        agentId,
        excludeWorkspaceFileId: row.id,
        isCreatingActiveSlot: false,
        newByteSize: row.byteSize,
        newCharCount: row.charCount ?? 0,
        newEstimatedTokens: rowTokens,
        newKind: row.kind as WorkspaceFileKind,
        newLoadMode: nextLoadMode,
      });

      const nextIsProtected = resolveEffectiveProtection(
        nextPath,
        nextLoadMode,
        input.isProtected ?? row.isProtected,
      );

      const nextUserSummary =
        input.userSummary !== undefined ? sanitizeUserSummary(input.userSummary) : row.userSummary;
      const nextRagEnabled = input.ragEnabled ?? row.ragEnabled;
      const nextPriority = defaultPriorityForPathAndMode(nextPath, nextLoadMode);
      const nextMimeType =
        row.kind === 'text' ? resolveCanonicalTextMimeType(nextPath) : row.mimeType;

      const [updated] = await tx
        .update(projectWorkspaceFiles)
        .set({
          isProtected: nextIsProtected,
          loadMode: nextLoadMode,
          loadPriority: nextPriority,
          mimeType: nextMimeType,
          path: nextPath,
          ragEnabled: nextRagEnabled,
          updatedAt: new Date(),
          updatedBy: input.actor ?? 'user',
          userSummary: nextUserSummary,
        })
        .where(eq(projectWorkspaceFiles.id, row.id))
        .returning();

      if (isRootAgentsMd(nextPath) || isRootAgentsMd(row.path)) {
        await tx
          .update(agents)
          .set({ systemRole: null, updatedAt: new Date() })
          .where(and(eq(agents.id, agentId), eq(agents.userId, this.userId)));
      }

      await this.syncFileRagMembership(tx, {
        agentId,
        agentTitle: agent.title,
        newFileId: row.currentFileId,
        newRagEnabled: nextRagEnabled,
        oldFileId: row.currentFileId,
        oldRagEnabled: row.ragEnabled,
      });

      const [dto] = await this.toFileDtos(tx, [updated!]);
      const budget = await this.computeBudgetSummary(tx, agentId);
      return { budget, deleted: false, file: dto! };
    });
  }

  public async deleteWorkspaceFile(
    agentId: string,
    workspaceFileIdOrPath: { path?: string; workspaceFileId?: string },
    opts: {
      actor: 'agent' | 'sandbox' | 'user';
      baseRevision?: number;
      messageId?: string;
      reason?: string;
      topicId?: string;
    },
  ): Promise<WorkspaceDeleteOutcome> {
    return this.db.transaction(async (tx) => {
      const agent = await this.ensureAgentOwned(tx, agentId, true);

      let row: ProjectWorkspaceFileItem | undefined;
      if (workspaceFileIdOrPath.workspaceFileId) {
        row = await this.lockWorkspaceRowById(tx, agentId, workspaceFileIdOrPath.workspaceFileId);
      } else if (workspaceFileIdOrPath.path) {
        const normalizedPath = normalizeWorkspacePath(workspaceFileIdOrPath.path);
        row = await this.lockWorkspaceRowByPath(tx, agentId, normalizedPath);
      } else {
        throw new WorkspaceError(
          'INVALID_PATH',
          'Either workspaceFileId or path must be provided for deletion',
          400,
        );
      }

      if (!row || row.deletedAt !== null) {
        throw new WorkspaceError('FILE_NOT_FOUND', 'Workspace file not found', 404);
      }

      const isProtected = row.isProtected || isAutoProtectedPath(row.path, row.loadMode);

      if (opts.actor !== 'user' && isProtected) {
        if (opts.baseRevision !== undefined && row.currentRevision !== opts.baseRevision) {
          throw new WorkspaceError(
            'REVISION_CONFLICT',
            `Base revision v${opts.baseRevision} does not match current v${row.currentRevision}`,
            409,
            {
              currentRevision: row.currentRevision,
              updatedAt: row.updatedAt.toISOString(),
              updatedBy: row.updatedBy,
            },
          );
        }

        let diffPreview: string | null = null;
        let removedLines = row.lineCount ?? 0;
        if (row.kind === 'text') {
          try {
            const cur = await this.readTextContentForWorkspaceRow(tx, {
              documentId: row.currentDocumentId ?? null,
              fileId: row.currentFileId,
            });
            const diff = computeUnifiedDiff(row.path, cur.text, '');
            diffPreview = diff.patch;
            removedLines = diff.removedLines;
          } catch {
            diffPreview = null;
          }
        }

        const proposal = await insertWorkspaceProposal(tx, {
          addedLines: 0,
          agentId,
          baseRevision: row.currentRevision,
          diffPreview,
          messageId: opts.messageId,
          proposalType: 'delete',
          proposedFileId: null,
          reason: opts.reason,
          removedLines,
          targetPath: row.path,
          topicId: opts.topicId,
          userId: this.userId,
          workspaceFileId: row.id,
        });

        return { outcome: 'proposal_created', proposal };
      }

      if (opts.baseRevision === undefined || opts.baseRevision === null) {
        throw new WorkspaceError(
          'INVALID_REVISION',
          'baseRevision is required to delete a workspace file',
          400,
        );
      }

      if (row.currentRevision !== opts.baseRevision) {
        throw new WorkspaceError(
          'REVISION_CONFLICT',
          `Revision conflict on delete: expected v${opts.baseRevision}, actual v${row.currentRevision}`,
          409,
          {
            currentRevision: row.currentRevision,
            updatedAt: row.updatedAt.toISOString(),
            updatedBy: row.updatedBy,
          },
        );
      }

      await tx
        .update(projectWorkspaceFiles)
        .set({
          deletedAt: new Date(),
          deletedBy: opts.actor,
          updatedAt: new Date(),
          updatedBy: opts.actor,
        })
        .where(eq(projectWorkspaceFiles.id, row.id));

      if (isRootAgentsMd(row.path)) {
        await tx
          .update(agents)
          .set({ systemRole: null, updatedAt: new Date() })
          .where(and(eq(agents.id, agentId), eq(agents.userId, this.userId)));
      }

      await this.syncFileRagMembership(tx, {
        agentId,
        agentTitle: agent.title,
        newFileId: null,
        newRagEnabled: false,
        oldFileId: row.currentFileId,
        oldRagEnabled: row.ragEnabled,
      });

      const budget = await this.computeBudgetSummary(tx, agentId);
      return {
        budget,
        deleted: true,
        outcome: 'deleted',
        path: row.path,
        revision: row.currentRevision,
        workspaceFileId: row.id,
      };
    });
  }

  public async writeAgentTextFile(
    agentId: string,
    input: {
      actor?: 'agent' | 'sandbox';
      baseRevision?: number | null;
      changeNote?: string | null;
      content?: string;
      encodedBytesOverride?: Uint8Array;
      encoding?: SourceTextEncoding;
      lineEnding?: SourceLineEnding;
      loadMode?: WorkspaceLoadMode;
      messageId?: string | null;
      path: string;
      reason?: string | null;
      topicId?: string | null;
      userSummary?: string | null;
    },
  ): Promise<AgentWriteOutcome> {
    const res = await this.executeTextWriteCore({
      actor: input.actor ?? 'agent',
      agentId,
      baseRevision: input.baseRevision,
      changeNote: input.changeNote,
      content: input.content,
      encodedBytesOverride: input.encodedBytesOverride,
      encoding: input.encoding,
      lineEnding: input.lineEnding,
      loadMode: input.loadMode,
      messageId: input.messageId,
      path: input.path,
      reason: input.reason,
      topicId: input.topicId,
      userSummary: input.userSummary,
    });

    if (res.outcome === 'proposal_created') {
      return {
        outcome: 'proposal_created',
        proposal: res.proposal!,
      };
    }

    return {
      addedLines: res.addedLines,
      budget: res.budget!,
      file: res.file!,
      outcome: res.outcome,
      prevRevision: res.prevRevision,
      removedLines: res.removedLines,
    };
  }

  public async patchAgentTextFile(
    agentId: string,
    input: {
      actor?: 'agent' | 'sandbox';
      baseRevision?: number | null;
      changeNote?: string | null;
      edits: PatchEdit[];
      messageId?: string | null;
      path?: string;
      reason?: string | null;
      topicId?: string | null;
      workspaceFileId?: string;
    },
  ): Promise<AgentWriteOutcome> {
    await this.ensureAgentOwned(this.db, agentId, false);

    let row: ProjectWorkspaceFileItem | undefined;
    if (input.workspaceFileId) {
      const rows = await this.db
        .select()
        .from(projectWorkspaceFiles)
        .where(
          and(
            eq(projectWorkspaceFiles.id, input.workspaceFileId),
            eq(projectWorkspaceFiles.agentId, agentId),
            eq(projectWorkspaceFiles.userId, this.userId),
            isNull(projectWorkspaceFiles.deletedAt),
          ),
        )
        .limit(1);
      row = rows[0];
    } else if (input.path) {
      const normalizedPath = normalizeWorkspacePath(input.path);
      const rows = await this.db
        .select()
        .from(projectWorkspaceFiles)
        .where(
          and(
            eq(projectWorkspaceFiles.agentId, agentId),
            eq(projectWorkspaceFiles.userId, this.userId),
            isNull(projectWorkspaceFiles.deletedAt),
            sql`lower(${projectWorkspaceFiles.path}) = lower(${normalizedPath})`,
          ),
        )
        .limit(1);
      row = rows[0];
    } else {
      throw new WorkspaceError(
        'INVALID_PATH',
        'Either workspaceFileId or path is required to patch a file',
        400,
      );
    }

    if (!row) {
      throw new WorkspaceError('FILE_NOT_FOUND', 'Workspace file not found', 404);
    }

    if (row.kind !== 'text') {
      throw new WorkspaceError(
        'INVALID_OPERATION',
        `Cannot apply text patch to binary document "${row.path}"`,
        422,
      );
    }

    if (
      input.baseRevision !== undefined &&
      input.baseRevision !== null &&
      row.currentRevision !== input.baseRevision
    ) {
      throw new WorkspaceError(
        'REVISION_CONFLICT',
        `Revision conflict on "${row.path}": expected v${input.baseRevision}, actual v${row.currentRevision}`,
        409,
        {
          currentRevision: row.currentRevision,
          updatedAt: row.updatedAt.toISOString(),
          updatedBy: row.updatedBy,
        },
      );
    }

    const loaded = await this.readTextContentForWorkspaceRow(this.db, {
      documentId: row.currentDocumentId ?? null,
      fileId: row.currentFileId,
    });

    const targetEncoding: SourceTextEncoding =
      (row.encoding as SourceTextEncoding | null) ?? loaded.encoding ?? 'utf-8';
    const targetLineEnding: SourceLineEnding =
      (row.lineEnding as SourceLineEnding | null) ?? loaded.lineEnding ?? 'LF';

    const sourceForPatch = targetEncoding === 'utf-8-bom' ? `\uFEFF${loaded.text}` : loaded.text;
    const patchRes = applyAtomicPatch(sourceForPatch, input.edits, {
      fileName: row.path,
      maxOutputBytes: MAX_WORKSPACE_TEXT_BYTES,
      sourceEncoding: targetEncoding,
      targetEncoding,
    });

    if (!patchRes.ok) {
      if (patchRes.code === 'size_limit') {
        throw new WorkspaceError('FILE_TOO_LARGE', patchRes.error, 413, {
          diagnostics: patchRes.diagnostics,
        });
      }
      if (patchRes.code === 'invalid_patch') {
        throw new WorkspaceError('INVALID_PATCH', patchRes.error, 400, {
          diagnostics: patchRes.diagnostics,
        });
      }
      throw new WorkspaceError('PATCH_FAILED', patchRes.error, 422, {
        diagnostics: patchRes.diagnostics,
      });
    }

    const res = await this.executeTextWriteCore({
      actor: input.actor ?? 'agent',
      agentId,
      baseRevision: row.currentRevision,
      changeNote: input.changeNote,
      content: stripLeadingBomChar(patchRes.content),
      encoding: targetEncoding,
      lineEnding: targetLineEnding,
      messageId: input.messageId,
      path: row.path,
      reason: input.reason,
      requireExpectedReadRevision: row.currentRevision,
      topicId: input.topicId,
    });

    if (res.outcome === 'proposal_created') {
      return {
        diffSummary: patchRes.diffSummary,
        outcome: 'proposal_created',
        proposal: res.proposal!,
      };
    }

    return {
      addedLines: res.addedLines,
      budget: res.budget!,
      diffSummary: patchRes.diffSummary,
      file: res.file!,
      outcome: res.outcome,
      prevRevision: res.prevRevision,
      removedLines: res.removedLines,
    };
  }

  public async readProjectFilePage(
    agentId: string,
    params: {
      maxLines?: number;
      offset?: number;
      path?: string;
      query?: string;
      revision?: number;
      startLine?: number;
      workspaceFileId?: string;
    },
  ): Promise<{
    file: WorkspaceFileDto;
    page: FileReadPage;
    revision: number;
    wrappedContent: string;
  }> {
    await this.ensureAgentOwned(this.db, agentId, false);

    let row: ProjectWorkspaceFileItem | undefined;
    if (params.workspaceFileId) {
      const rows = await this.db
        .select()
        .from(projectWorkspaceFiles)
        .where(
          and(
            eq(projectWorkspaceFiles.id, params.workspaceFileId),
            eq(projectWorkspaceFiles.agentId, agentId),
            eq(projectWorkspaceFiles.userId, this.userId),
            params.revision === undefined ? isNull(projectWorkspaceFiles.deletedAt) : undefined,
          ),
        )
        .limit(1);
      row = rows[0];
    } else if (params.path) {
      const normalizedPath = normalizeWorkspacePath(params.path);
      const rows = await this.db
        .select()
        .from(projectWorkspaceFiles)
        .where(
          and(
            eq(projectWorkspaceFiles.agentId, agentId),
            eq(projectWorkspaceFiles.userId, this.userId),
            params.revision === undefined ? isNull(projectWorkspaceFiles.deletedAt) : undefined,
            sql`lower(${projectWorkspaceFiles.path}) = lower(${normalizedPath})`,
          ),
        )
        .limit(1);
      row = rows[0];
    } else {
      throw new WorkspaceError('INVALID_PATH', 'Either path or workspaceFileId is required', 400);
    }

    if (!row) {
      throw new WorkspaceError('FILE_NOT_FOUND', 'Workspace file not found', 404);
    }

    if (row.kind !== 'text') {
      throw new WorkspaceError(
        'INVALID_OPERATION',
        `File "${row.path}" is a binary document; use searchKnowledgeBase or code sandbox to inspect it`,
        422,
      );
    }

    let targetFileId = row.currentFileId;
    let targetDocId = row.currentDocumentId;
    let targetRevision = row.currentRevision;
    let targetEncoding = row.encoding ?? 'utf-8';

    if (params.revision !== undefined) {
      const [revRow] = await this.db
        .select()
        .from(projectFileRevisions)
        .where(
          and(
            eq(projectFileRevisions.workspaceFileId, row.id),
            eq(projectFileRevisions.revision, params.revision),
          ),
        )
        .limit(1);
      if (!revRow) {
        throw new WorkspaceError(
          'INVALID_REVISION',
          `Revision v${params.revision} not found for "${row.path}"`,
          404,
        );
      }
      targetFileId = revRow.fileId;
      targetDocId = revRow.documentId;
      targetRevision = revRow.revision;
      targetEncoding = revRow.encoding ?? targetEncoding;
    }

    const loaded = await this.readTextContentForWorkspaceRow(this.db, {
      documentId: targetDocId ?? null,
      fileId: targetFileId,
    });

    const useOffsetMode =
      params.offset !== undefined &&
      params.startLine === undefined &&
      params.maxLines === undefined;

    const clampedMaxLines =
      params.maxLines !== undefined
        ? Math.min(FILE_READ_MAX_LINES, Math.max(FILE_READ_MIN_LINES, Math.floor(params.maxLines)))
        : FILE_READ_DEFAULT_MAX_LINES;

    const page = readFilePage(
      loaded.text,
      useOffsetMode
        ? { offset: params.offset, query: params.query }
        : {
            maxLines: clampedMaxLines,
            query: params.query,
            startLine: params.startLine ?? 1,
          },
      FILE_READ_CHARS,
    );

    const safeBody = page.content.replaceAll(/<\/\s*project_file\s*>/gi, '&lt;/project_file&gt;');
    const escapedPath = escapeXmlAttr(row.path);
    const escapedEncoding = escapeXmlAttr(targetEncoding);

    const wrappedContent = `<project_file path="${escapedPath}" revision="${targetRevision}" encoding="${escapedEncoding}" trust="untrusted_workspace_data">\n${safeBody}\n</project_file>`;
    const [dto] = await this.toFileDtos(this.db, [row]);

    return {
      file: dto!,
      page,
      revision: targetRevision,
      wrappedContent,
    };
  }

  /**
   * Executes strictly 1 SQL query over `project_workspace_files` + `documents` with 0 S3 GETs (`H-4`).
   */
  public async searchProjectFiles(
    agentId: string,
    params: { limit?: number; pathPrefix?: string; query: string },
  ): Promise<WorkspaceSearchResult> {
    const trimmedQuery = params.query?.trim() ?? '';
    if (!trimmedQuery) {
      throw new WorkspaceError('INVALID_OPERATION', 'Search query must not be empty', 400);
    }

    const maxMatches = Math.min(
      MAX_SEARCH_MATCHES,
      Math.max(1, Math.floor(params.limit ?? MAX_SEARCH_MATCHES)),
    );

    const escapedQuery = escapeLikeLiteral(trimmedQuery);
    const cleanedPrefix = params.pathPrefix?.trim()
      ? normalizeWorkspacePath(params.pathPrefix.trim().replace(/\/+$/, ''))
      : null;
    const escapedPrefix = cleanedPrefix ? escapeLikeLiteral(cleanedPrefix) : null;

    const rows = await this.db
      .select({
        content: documents.content,
        id: projectWorkspaceFiles.id,
        path: projectWorkspaceFiles.path,
        revision: projectWorkspaceFiles.currentRevision,
      })
      .from(projectWorkspaceFiles)
      .innerJoin(documents, eq(documents.id, projectWorkspaceFiles.currentDocumentId))
      .where(
        and(
          eq(projectWorkspaceFiles.userId, this.userId),
          eq(projectWorkspaceFiles.agentId, agentId),
          isNull(projectWorkspaceFiles.deletedAt),
          ne(projectWorkspaceFiles.loadMode, 'disabled'),
          eq(projectWorkspaceFiles.kind, 'text'),
          escapedPrefix
            ? sql`lower(${projectWorkspaceFiles.path}) LIKE lower(${`${escapedPrefix}%`}) ESCAPE '\\'`
            : undefined,
          sql`${documents.content} ILIKE ${`%${escapedQuery}%`} ESCAPE '\\'`,
        ),
      )
      .orderBy(asc(projectWorkspaceFiles.loadPriority), desc(projectWorkspaceFiles.updatedAt))
      .limit(MAX_SEARCH_MATCHES);

    const needleLower = trimmedQuery.toLowerCase();
    const matches: WorkspaceSearchMatch[] = [];
    const formattedLines: string[] = [];
    let currentChars = 0;
    let truncated = false;

    for (const row of rows) {
      if (matches.length >= maxMatches) {
        truncated = true;
        break;
      }

      const content = row.content ?? '';
      if (!content) continue;

      const lines = content.replaceAll('\r\n', '\n').split('\n');
      for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const lineText = lines[lineIdx]!;
        const foundAt = lineText.toLowerCase().indexOf(needleLower);
        if (foundAt === -1) continue;

        if (matches.length >= maxMatches) {
          truncated = true;
          break;
        }

        const preview = buildSingleLineMatchPreview(lineText, foundAt);
        const formattedLine = `${row.path} (v${row.revision}) L${lineIdx + 1}: ${preview}`;
        const sep = formattedLines.length > 0 ? 1 : 0;

        if (currentChars + sep + formattedLine.length > MAX_SEARCH_OUTPUT_CHARS) {
          truncated = true;
          break;
        }

        matches.push({
          line: lineIdx + 1,
          path: row.path,
          preview,
          revision: row.revision,
          workspaceFileId: row.id,
        });
        formattedLines.push(formattedLine);
        currentChars += sep + formattedLine.length;
      }

      if (truncated) break;
    }

    return {
      formatted: formattedLines.join('\n'),
      matches,
      totalMatchesReturned: matches.length,
      truncated,
    };
  }

  public async listRevisions(
    agentId: string,
    workspaceFileId: string,
  ): Promise<{ revisions: WorkspaceRevisionDto[] }> {
    await this.ensureAgentOwned(this.db, agentId, false);

    const [row] = await this.db
      .select({ id: projectWorkspaceFiles.id })
      .from(projectWorkspaceFiles)
      .where(
        and(
          eq(projectWorkspaceFiles.id, workspaceFileId),
          eq(projectWorkspaceFiles.agentId, agentId),
          eq(projectWorkspaceFiles.userId, this.userId),
        ),
      )
      .limit(1);

    if (!row) {
      throw new WorkspaceError('FILE_NOT_FOUND', 'Workspace file not found', 404);
    }

    const revRows = await this.db
      .select()
      .from(projectFileRevisions)
      .where(eq(projectFileRevisions.workspaceFileId, workspaceFileId))
      .orderBy(desc(projectFileRevisions.revision));

    return { revisions: revRows.map(toRevisionDto) };
  }

  public async diffRevisions(
    agentId: string,
    workspaceFileId: string,
    fromRevision: number,
    toRevision: number,
  ): Promise<{
    addedLines: number;
    fromRevision: number;
    patch: string;
    path: string;
    removedLines: number;
    toRevision: number;
  }> {
    await this.ensureAgentOwned(this.db, agentId, false);

    const [row] = await this.db
      .select()
      .from(projectWorkspaceFiles)
      .where(
        and(
          eq(projectWorkspaceFiles.id, workspaceFileId),
          eq(projectWorkspaceFiles.agentId, agentId),
          eq(projectWorkspaceFiles.userId, this.userId),
        ),
      )
      .limit(1);

    if (!row) {
      throw new WorkspaceError('FILE_NOT_FOUND', 'Workspace file not found', 404);
    }

    if (row.kind !== 'text') {
      throw new WorkspaceError(
        'INVALID_OPERATION',
        'Line diff is only supported for text workspace files',
        422,
      );
    }

    const revRows = await this.db
      .select()
      .from(projectFileRevisions)
      .where(
        and(
          eq(projectFileRevisions.workspaceFileId, workspaceFileId),
          inArray(projectFileRevisions.revision, [fromRevision, toRevision]),
        ),
      );

    const fromRev = revRows.find((r) => r.revision === fromRevision);
    const toRev = revRows.find((r) => r.revision === toRevision);

    if (!fromRev || !toRev) {
      throw new WorkspaceError(
        'INVALID_REVISION',
        `Requested revisions v${fromRevision}..v${toRevision} not found`,
        404,
      );
    }

    const [fromLoaded, toLoaded] = await Promise.all([
      this.readTextContentForWorkspaceRow(this.db, {
        documentId: fromRev.documentId ?? null,
        fileId: fromRev.fileId,
      }),
      this.readTextContentForWorkspaceRow(this.db, {
        documentId: toRev.documentId ?? null,
        fileId: toRev.fileId,
      }),
    ]);

    const diff = computeUnifiedDiff(
      row.path,
      fromLoaded.text,
      toLoaded.text,
      `v${fromRevision}`,
      `v${toRevision}`,
    );

    return {
      addedLines: diff.addedLines,
      fromRevision,
      patch: diff.patch,
      path: row.path,
      removedLines: diff.removedLines,
      toRevision,
    };
  }

  public async rollbackFileRevision(
    agentId: string,
    workspaceFileId: string,
    input: { baseRevision?: number; targetRevision: number },
  ): Promise<{ budget: WorkspaceBudgetSummary; file: WorkspaceFileDto }> {
    const s3KeysToPrune: string[] = [];

    const result = await this.db.transaction(async (tx) => {
      const agent = await this.ensureAgentOwned(tx, agentId, true);
      const row = await this.lockWorkspaceRowById(tx, agentId, workspaceFileId);
      if (!row) {
        throw new WorkspaceError('FILE_NOT_FOUND', 'Workspace file not found', 404);
      }

      if (input.baseRevision !== undefined && row.currentRevision !== input.baseRevision) {
        throw new WorkspaceError(
          'REVISION_CONFLICT',
          `Revision conflict on rollback: expected v${input.baseRevision}, actual v${row.currentRevision}`,
          409,
          {
            currentRevision: row.currentRevision,
            updatedAt: row.updatedAt.toISOString(),
            updatedBy: row.updatedBy,
          },
        );
      }

      const [targetRevRow] = await tx
        .select()
        .from(projectFileRevisions)
        .where(
          and(
            eq(projectFileRevisions.workspaceFileId, row.id),
            eq(projectFileRevisions.revision, input.targetRevision),
          ),
        )
        .limit(1);

      if (!targetRevRow) {
        throw new WorkspaceError(
          'INVALID_REVISION',
          `Target revision v${input.targetRevision} not found`,
          404,
        );
      }

      let targetEstimatedTokens = 0;
      let diffStats: { addedLines: number; removedLines: number } | null = null;

      if (row.kind === 'text') {
        const targetText = await this.readTextContentForWorkspaceRow(tx, {
          documentId: targetRevRow.documentId ?? null,
          fileId: targetRevRow.fileId,
        });
        targetEstimatedTokens = estimateWorkspaceTokens(targetText.text);

        let curText = '';
        if (row.deletedAt === null) {
          try {
            const curLoaded = await this.readTextContentForWorkspaceRow(tx, {
              documentId: row.currentDocumentId ?? null,
              fileId: row.currentFileId,
            });
            curText = curLoaded.text;
          } catch {
            curText = '';
          }
        }
        const diff = computeUnifiedDiff(row.path, curText, targetText.text);
        diffStats = { addedLines: diff.addedLines, removedLines: diff.removedLines };
      }

      const isResurrecting = row.deletedAt !== null;
      await this.assertBudgetAndQuotasForWrite(tx, {
        addedRevisionBytes: targetRevRow.byteSize,
        agentId,
        excludeWorkspaceFileId: row.id,
        isCreatingActiveSlot: isResurrecting,
        newByteSize: targetRevRow.byteSize,
        newCharCount: targetRevRow.charCount ?? 0,
        newEstimatedTokens: targetEstimatedTokens,
        newKind: row.kind as WorkspaceFileKind,
        newLoadMode: row.loadMode as WorkspaceLoadMode,
      });

      const nextRev = row.currentRevision + 1;

      const [updated] = await tx
        .update(projectWorkspaceFiles)
        .set({
          byteSize: targetRevRow.byteSize,
          charCount: targetRevRow.charCount,
          contentSha256: targetRevRow.contentSha256,
          currentDocumentId: targetRevRow.documentId,
          currentFileId: targetRevRow.fileId,
          currentRevision: nextRev,
          deletedAt: null,
          deletedBy: null,
          encoding: targetRevRow.encoding,
          lineCount: targetRevRow.lineCount,
          lineEnding: targetRevRow.lineEnding,
          updatedAt: new Date(),
          updatedBy: 'rollback',
        })
        .where(eq(projectWorkspaceFiles.id, row.id))
        .returning();

      await tx.insert(projectFileRevisions).values({
        agentId,
        authorType: 'rollback',
        byteSize: targetRevRow.byteSize,
        changeNote: `Rollback to v${input.targetRevision}`,
        charCount: targetRevRow.charCount,
        contentSha256: targetRevRow.contentSha256,
        diffStats,
        documentId: targetRevRow.documentId,
        encoding: targetRevRow.encoding,
        fileId: targetRevRow.fileId,
        lineCount: targetRevRow.lineCount,
        lineEnding: targetRevRow.lineEnding,
        revision: nextRev,
        userId: this.userId,
        workspaceFileId: row.id,
      });

      if (isRootAgentsMd(row.path)) {
        await tx
          .update(agents)
          .set({ systemRole: null, updatedAt: new Date() })
          .where(and(eq(agents.id, agentId), eq(agents.userId, this.userId)));
      }

      await this.syncFileRagMembership(tx, {
        agentId,
        agentTitle: agent.title,
        newFileId: targetRevRow.fileId,
        newRagEnabled: row.ragEnabled,
        oldFileId: row.currentFileId,
        oldRagEnabled: row.ragEnabled,
      });

      s3KeysToPrune.push(...(await this.pruneOldRevisionsInTx(tx, row.id)));

      const [dto] = await this.toFileDtos(tx, [updated!]);
      const budget = await this.computeBudgetSummary(tx, agentId);
      return { budget, file: dto! };
    });

    if (s3KeysToPrune.length > 0) await this.safeDeleteS3Keys(s3KeysToPrune);
    return result;
  }

  public async applyProposal(
    agentId: string,
    proposalId: string,
  ): Promise<{
    alreadyApplied: boolean;
    budget: WorkspaceBudgetSummary;
    file: WorkspaceFileDto | null;
    proposal: WorkspaceProposalDto;
  }> {
    const [preProposal] = await this.db
      .select()
      .from(projectFileProposals)
      .where(
        and(
          eq(projectFileProposals.id, proposalId),
          eq(projectFileProposals.userId, this.userId),
          eq(projectFileProposals.agentId, agentId),
        ),
      )
      .limit(1);

    if (!preProposal) {
      throw new WorkspaceError('PROPOSAL_NOT_FOUND', 'Workspace proposal not found', 404);
    }

    let decodedProposal:
      | {
          byteSize: number;
          charCount: number;
          contentSha256: string;
          encoding: SourceTextEncoding;
          estimatedTokens: number;
          fileType: string;
          lineCount: number;
          lineEnding: SourceLineEnding;
          s3Key: string;
          text: string;
        }
      | undefined;

    if (preProposal.status === 'pending' && preProposal.proposalType !== 'delete') {
      if (!preProposal.proposedFileId) {
        throw new WorkspaceError('INVALID_OPERATION', 'Proposal is missing proposedFileId', 422);
      }

      const [propFile] = await this.db
        .select()
        .from(files)
        .where(and(eq(files.id, preProposal.proposedFileId), eq(files.userId, this.userId)))
        .limit(1);

      if (!propFile) {
        throw new WorkspaceError('FILE_NOT_FOUND', 'Proposed file record no longer exists', 404);
      }

      const bytes = await this.storage.getFileByteArray(propFile.url);
      const decoded =
        bytes.byteLength === 0
          ? { encoding: 'utf-8' as const, lineEnding: 'LF' as const, text: '' }
          : decodeSourceText(bytes);
      const canonicalText = stripLeadingBomChar(decoded.text);

      decodedProposal = {
        byteSize: bytes.byteLength,
        charCount: canonicalText.length,
        contentSha256: sha256(bytes),
        encoding: (propFile.metadata as any)?.encoding ?? decoded.encoding,
        estimatedTokens: estimateWorkspaceTokens(canonicalText),
        fileType: propFile.fileType,
        lineCount: countTextLines(canonicalText),
        lineEnding: (propFile.metadata as any)?.lineEnding ?? decoded.lineEnding,
        s3Key: propFile.url,
        text: canonicalText,
      };
    }

    const s3KeysToPrune: string[] = [];

    const result = await this.db.transaction(async (tx) => {
      const agent = await this.ensureAgentOwned(tx, agentId, true);
      const proposal = await lockWorkspaceProposalForUpdate(tx, this.userId, agentId, proposalId);

      if (proposal.status === 'applied') {
        let currentFileDto: WorkspaceFileDto | null = null;
        if (proposal.workspaceFileId) {
          const locked = await this.lockWorkspaceRowById(tx, agentId, proposal.workspaceFileId);
          if (locked && locked.deletedAt === null) {
            const [dto] = await this.toFileDtos(tx, [locked]);
            currentFileDto = dto ?? null;
          }
        }
        const budget = await this.computeBudgetSummary(tx, agentId);
        return {
          alreadyApplied: true,
          budget,
          file: currentFileDto,
          proposal: toWorkspaceProposalDto(proposal),
        };
      }

      if (proposal.status !== 'pending') {
        throw new WorkspaceError(
          'REVISION_CONFLICT',
          `Cannot apply proposal in status "${proposal.status}"`,
          409,
          { proposalId: proposal.id, status: proposal.status },
        );
      }

      if (proposal.proposalType === 'delete') {
        const lockedRow = proposal.workspaceFileId
          ? await this.lockWorkspaceRowById(tx, agentId, proposal.workspaceFileId)
          : await this.lockWorkspaceRowByPath(tx, agentId, proposal.targetPath);

        if (lockedRow && lockedRow.deletedAt === null) {
          if (
            proposal.baseRevision !== null &&
            lockedRow.currentRevision !== proposal.baseRevision
          ) {
            throw new WorkspaceError(
              'REVISION_CONFLICT',
              `Proposal baseRevision v${proposal.baseRevision} conflicts with current v${lockedRow.currentRevision}`,
              409,
              {
                currentRevision: lockedRow.currentRevision,
                updatedAt: lockedRow.updatedAt.toISOString(),
                updatedBy: lockedRow.updatedBy,
              },
            );
          }

          await tx
            .update(projectWorkspaceFiles)
            .set({
              deletedAt: new Date(),
              deletedBy: 'proposal_approved',
              updatedAt: new Date(),
              updatedBy: 'proposal_approved',
            })
            .where(eq(projectWorkspaceFiles.id, lockedRow.id));

          if (isRootAgentsMd(lockedRow.path)) {
            await tx
              .update(agents)
              .set({ systemRole: null, updatedAt: new Date() })
              .where(and(eq(agents.id, agentId), eq(agents.userId, this.userId)));
          }

          await this.syncFileRagMembership(tx, {
            agentId,
            agentTitle: agent.title,
            newFileId: null,
            newRagEnabled: false,
            oldFileId: lockedRow.currentFileId,
            oldRagEnabled: lockedRow.ragEnabled,
          });
        }

        const [updatedProp] = await tx
          .update(projectFileProposals)
          .set({ resolvedAt: new Date(), status: 'applied' })
          .where(eq(projectFileProposals.id, proposal.id))
          .returning();

        const budget = await this.computeBudgetSummary(tx, agentId);
        return {
          alreadyApplied: false,
          budget,
          file: null,
          proposal: toWorkspaceProposalDto(updatedProp!),
        };
      }

      const normalizedPath = normalizeWorkspacePath(proposal.targetPath);
      this.assertNotInboxInstruction(agent, normalizedPath);

      const lockedRow = proposal.workspaceFileId
        ? await this.lockWorkspaceRowById(tx, agentId, proposal.workspaceFileId)
        : await this.lockWorkspaceRowByPath(tx, agentId, normalizedPath);

      if (proposal.proposalType === 'edit') {
        if (
          !lockedRow ||
          lockedRow.deletedAt !== null ||
          (proposal.baseRevision !== null && lockedRow.currentRevision !== proposal.baseRevision)
        ) {
          throw new WorkspaceError(
            'REVISION_CONFLICT',
            `Proposal baseRevision v${proposal.baseRevision} conflicts with current v${lockedRow?.currentRevision ?? 'deleted'}`,
            409,
            {
              currentRevision: lockedRow?.currentRevision ?? null,
              updatedAt: lockedRow?.updatedAt ? lockedRow.updatedAt.toISOString() : null,
              updatedBy: lockedRow?.updatedBy ?? null,
            },
          );
        }
      } else if (lockedRow && lockedRow.deletedAt === null) {
        throw new WorkspaceError(
          'REVISION_CONFLICT',
          `Target file "${normalizedPath}" was created concurrently at v${lockedRow.currentRevision}`,
          409,
          {
            currentRevision: lockedRow.currentRevision,
            updatedAt: lockedRow.updatedAt.toISOString(),
            updatedBy: lockedRow.updatedBy,
          },
        );
      }

      const payload = decodedProposal!;
      const effectiveLoadMode: WorkspaceLoadMode =
        lockedRow && lockedRow.deletedAt === null
          ? (lockedRow.loadMode as WorkspaceLoadMode)
          : isRootAgentsMd(normalizedPath) || proposal.proposalType === 'create_pinned'
            ? isRootAgentsMd(normalizedPath) || isAutoProtectedPath(normalizedPath, 'always')
              ? isRootAgentsMd(normalizedPath)
                ? 'always'
                : 'always'
              : 'on_demand'
            : 'on_demand';

      validateWorkspaceLoadMode(normalizedPath, effectiveLoadMode);

      const isResurrecting = Boolean(lockedRow && lockedRow.deletedAt !== null);
      await this.assertBudgetAndQuotasForWrite(tx, {
        addedRevisionBytes: payload.byteSize,
        agentId,
        excludeWorkspaceFileId: lockedRow?.id,
        isCreatingActiveSlot: !lockedRow || isResurrecting,
        newByteSize: payload.byteSize,
        newCharCount: payload.charCount,
        newEstimatedTokens: payload.estimatedTokens,
        newKind: 'text',
        newLoadMode: effectiveLoadMode,
      });

      const nextRev = lockedRow ? lockedRow.currentRevision + 1 : 1;
      const newDocId = idGenerator('documents', 16);
      const { basename } = extractWorkspaceBasenameAndExt(normalizedPath);

      await tx.insert(documents).values({
        content: payload.text,
        fileId: proposal.proposedFileId!,
        fileType: payload.fileType,
        filename: normalizedPath,
        id: newDocId,
        metadata: {
          encoding: payload.encoding,
          estimatedTokens: payload.estimatedTokens,
          lineEnding: payload.lineEnding,
          workspacePath: normalizedPath,
        },
        source: payload.s3Key,
        sourceType: 'file',
        title: basename,
        totalCharCount: payload.charCount,
        totalLineCount: payload.lineCount,
        userId: this.userId,
      });

      const effectiveProtected = resolveEffectiveProtection(
        normalizedPath,
        effectiveLoadMode,
        lockedRow?.isProtected ?? true,
      );
      const ragEnabled = lockedRow?.deletedAt === null ? lockedRow.ragEnabled : false;
      const priority =
        lockedRow?.deletedAt === null
          ? lockedRow.loadPriority
          : defaultPriorityForPathAndMode(normalizedPath, effectiveLoadMode);

      let savedRow: ProjectWorkspaceFileItem;
      if (!lockedRow) {
        const [ins] = await tx
          .insert(projectWorkspaceFiles)
          .values({
            agentId,
            byteSize: payload.byteSize,
            charCount: payload.charCount,
            contentSha256: payload.contentSha256,
            createdBy: 'agent',
            currentDocumentId: newDocId,
            currentFileId: proposal.proposedFileId!,
            currentRevision: 1,
            dataGuardStatus: 'unmasked',
            encoding: payload.encoding,
            isProtected: effectiveProtected,
            kind: 'text',
            lastTopicId: proposal.topicId,
            lineCount: payload.lineCount,
            lineEnding: payload.lineEnding,
            loadMode: effectiveLoadMode,
            loadPriority: priority,
            mimeType: payload.fileType,
            path: normalizedPath,
            ragEnabled,
            updatedBy: 'proposal_approved',
            userId: this.userId,
          })
          .returning();
        savedRow = ins!;
      } else {
        const [upd] = await tx
          .update(projectWorkspaceFiles)
          .set({
            byteSize: payload.byteSize,
            charCount: payload.charCount,
            contentSha256: payload.contentSha256,
            currentDocumentId: newDocId,
            currentFileId: proposal.proposedFileId!,
            currentRevision: nextRev,
            deletedAt: null,
            deletedBy: null,
            encoding: payload.encoding,
            isProtected: effectiveProtected,
            kind: 'text',
            lastTopicId: proposal.topicId ?? lockedRow.lastTopicId,
            lineCount: payload.lineCount,
            lineEnding: payload.lineEnding,
            loadMode: effectiveLoadMode,
            loadPriority: priority,
            mimeType: payload.fileType,
            path: normalizedPath,
            ragEnabled,
            updatedAt: new Date(),
            updatedBy: 'proposal_approved',
          })
          .where(eq(projectWorkspaceFiles.id, lockedRow.id))
          .returning();
        savedRow = upd!;
      }

      await tx.insert(projectFileRevisions).values({
        agentId,
        authorType: 'proposal_approved',
        byteSize: payload.byteSize,
        changeNote: proposal.reason ?? 'Approved agent proposal',
        charCount: payload.charCount,
        contentSha256: payload.contentSha256,
        diffStats: proposal.diffStats,
        documentId: newDocId,
        encoding: payload.encoding,
        fileId: proposal.proposedFileId!,
        lineCount: payload.lineCount,
        lineEnding: payload.lineEnding,
        messageId: proposal.messageId,
        revision: nextRev,
        topicId: proposal.topicId,
        userId: this.userId,
        workspaceFileId: savedRow.id,
      });

      const [updatedProp] = await tx
        .update(projectFileProposals)
        .set({
          resolvedAt: new Date(),
          status: 'applied',
          workspaceFileId: savedRow.id,
        })
        .where(eq(projectFileProposals.id, proposal.id))
        .returning();

      if (isRootAgentsMd(normalizedPath)) {
        await tx
          .update(agents)
          .set({ systemRole: null, updatedAt: new Date() })
          .where(and(eq(agents.id, agentId), eq(agents.userId, this.userId)));
      }

      await this.syncFileRagMembership(tx, {
        agentId,
        agentTitle: agent.title,
        newFileId: proposal.proposedFileId!,
        newRagEnabled: ragEnabled,
        oldFileId: lockedRow?.currentFileId ?? null,
        oldRagEnabled: Boolean(lockedRow?.ragEnabled),
      });

      s3KeysToPrune.push(...(await this.pruneOldRevisionsInTx(tx, savedRow.id)));

      const [dto] = await this.toFileDtos(tx, [savedRow]);
      const budget = await this.computeBudgetSummary(tx, agentId);

      return {
        alreadyApplied: false,
        budget,
        file: dto!,
        proposal: toWorkspaceProposalDto(updatedProp!),
      };
    });

    if (s3KeysToPrune.length > 0) await this.safeDeleteS3Keys(s3KeysToPrune);
    return result;
  }

  public async rejectProposal(
    agentId: string,
    proposalId: string,
  ): Promise<{ proposal: WorkspaceProposalDto }> {
    await this.ensureAgentOwned(this.db, agentId, false);
    return rejectWorkspaceProposal(this.db, this.userId, agentId, proposalId);
  }
}

/**
 * Checks whether a `files.id` row is referenced by any workspace active file, revision, or proposal (`B-1`).
 */
export async function findWorkspaceFileReferences(
  db: LobeChatDatabase,
  fileId: string,
): Promise<{ referenced: boolean; sources: string[] }> {
  const [pwf, pfr, pfp] = await Promise.all([
    db
      .select({ id: projectWorkspaceFiles.id })
      .from(projectWorkspaceFiles)
      .where(eq(projectWorkspaceFiles.currentFileId, fileId))
      .limit(1),
    db
      .select({ id: projectFileRevisions.id })
      .from(projectFileRevisions)
      .where(eq(projectFileRevisions.fileId, fileId))
      .limit(1),
    db
      .select({ id: projectFileProposals.id })
      .from(projectFileProposals)
      .where(eq(projectFileProposals.proposedFileId, fileId))
      .limit(1),
  ]);

  const sources: string[] = [];
  if (pwf.length > 0) sources.push('project_workspace_files');
  if (pfr.length > 0) sources.push('project_file_revisions');
  if (pfp.length > 0) sources.push('project_file_proposals');

  return { referenced: sources.length > 0, sources };
}

/**
 * Cleans up all workspace rows, managed knowledge bases, unshared `files`/chunks/documents,
 * and S3 objects before deleting an agent (`B-1`).
 */
export async function cleanupAgentWorkspaceBeforeDelete(
  db: LobeChatDatabase,
  userId: string,
  agentId: string,
  fileService?: Pick<FileService, 'deleteFiles'>,
): Promise<{ deletedFileIds: string[]; deletedS3Keys: string[] }> {
  const txOutcome = await db.transaction(async (tx) => {
    const [pwfRows, pfrRows, pfpRows, managedKbs] = await Promise.all([
      tx
        .select({
          currentDocumentId: projectWorkspaceFiles.currentDocumentId,
          currentFileId: projectWorkspaceFiles.currentFileId,
        })
        .from(projectWorkspaceFiles)
        .where(
          and(eq(projectWorkspaceFiles.userId, userId), eq(projectWorkspaceFiles.agentId, agentId)),
        ),
      tx
        .select({
          documentId: projectFileRevisions.documentId,
          fileId: projectFileRevisions.fileId,
        })
        .from(projectFileRevisions)
        .where(
          and(eq(projectFileRevisions.userId, userId), eq(projectFileRevisions.agentId, agentId)),
        ),
      tx
        .select({ proposedFileId: projectFileProposals.proposedFileId })
        .from(projectFileProposals)
        .where(
          and(eq(projectFileProposals.userId, userId), eq(projectFileProposals.agentId, agentId)),
        ),
      tx
        .select({ id: knowledgeBases.id })
        .from(knowledgeBases)
        .where(
          and(
            eq(knowledgeBases.userId, userId),
            eq(knowledgeBases.type, 'project_workspace'),
            sql`${knowledgeBases.settings}->>'managedByAgentId' = ${agentId}`,
          ),
        ),
    ]);

    const managedKbIds = managedKbs.map((k) => k.id);
    const kbFileRows =
      managedKbIds.length > 0
        ? await tx
            .select({ fileId: knowledgeBaseFiles.fileId })
            .from(knowledgeBaseFiles)
            .where(inArray(knowledgeBaseFiles.knowledgeBaseId, managedKbIds))
        : [];

    const candidateFileIds = [
      ...new Set(
        [
          ...pwfRows.map((r) => r.currentFileId),
          ...pfrRows.map((r) => r.fileId),
          ...pfpRows.map((r) => r.proposedFileId).filter((v): v is string => Boolean(v)),
          ...kbFileRows.map((r) => r.fileId),
        ].filter(Boolean),
      ),
    ];

    const candidateDocIds = [
      ...new Set(
        [...pwfRows.map((r) => r.currentDocumentId), ...pfrRows.map((r) => r.documentId)].filter(
          (v): v is string => Boolean(v),
        ),
      ),
    ];

    await tx
      .delete(projectFileProposals)
      .where(
        and(eq(projectFileProposals.userId, userId), eq(projectFileProposals.agentId, agentId)),
      );
    await tx
      .delete(projectFileRevisions)
      .where(
        and(eq(projectFileRevisions.userId, userId), eq(projectFileRevisions.agentId, agentId)),
      );
    await tx
      .delete(projectWorkspaceFiles)
      .where(
        and(eq(projectWorkspaceFiles.userId, userId), eq(projectWorkspaceFiles.agentId, agentId)),
      );

    if (managedKbIds.length > 0) {
      await tx
        .delete(knowledgeBases)
        .where(and(inArray(knowledgeBases.id, managedKbIds), eq(knowledgeBases.userId, userId)));
    }

    if (candidateDocIds.length > 0) {
      const [otherPwfDocs, otherPfrDocs, otherAgentDocs, otherTopicDocs] = await Promise.all([
        tx
          .select({ id: projectWorkspaceFiles.currentDocumentId })
          .from(projectWorkspaceFiles)
          .where(inArray(projectWorkspaceFiles.currentDocumentId, candidateDocIds)),
        tx
          .select({ id: projectFileRevisions.documentId })
          .from(projectFileRevisions)
          .where(inArray(projectFileRevisions.documentId, candidateDocIds)),
        tx
          .select({ id: agentDocuments.documentId })
          .from(agentDocuments)
          .where(
            and(
              inArray(agentDocuments.documentId, candidateDocIds),
              ne(agentDocuments.agentId, agentId),
            ),
          ),
        tx
          .select({ id: topicDocuments.documentId })
          .from(topicDocuments)
          .where(inArray(topicDocuments.documentId, candidateDocIds)),
      ]);

      const busyDocs = new Set<string>([
        ...otherPwfDocs.map((r) => r.id).filter((v): v is string => Boolean(v)),
        ...otherPfrDocs.map((r) => r.id).filter((v): v is string => Boolean(v)),
        ...otherAgentDocs.map((r) => r.id),
        ...otherTopicDocs.map((r) => r.id),
      ]);

      const deletableDocIds = candidateDocIds.filter((id) => !busyDocs.has(id));
      if (deletableDocIds.length > 0) {
        await tx
          .delete(documents)
          .where(and(inArray(documents.id, deletableDocIds), eq(documents.userId, userId)));
      }
    }

    if (candidateFileIds.length === 0) {
      return { deletedFileIds: [] as string[], deletedS3Keys: [] as string[] };
    }

    const [msgRefs, extKbRefs, otherPwfRefs, otherPfrRefs, otherPfpRefs, otherAfRefs] =
      await Promise.all([
        tx
          .select({ fileId: messagesFiles.fileId })
          .from(messagesFiles)
          .where(inArray(messagesFiles.fileId, candidateFileIds)),
        tx
          .select({ fileId: knowledgeBaseFiles.fileId })
          .from(knowledgeBaseFiles)
          .where(inArray(knowledgeBaseFiles.fileId, candidateFileIds)),
        tx
          .select({ fileId: projectWorkspaceFiles.currentFileId })
          .from(projectWorkspaceFiles)
          .where(inArray(projectWorkspaceFiles.currentFileId, candidateFileIds)),
        tx
          .select({ fileId: projectFileRevisions.fileId })
          .from(projectFileRevisions)
          .where(inArray(projectFileRevisions.fileId, candidateFileIds)),
        tx
          .select({ fileId: projectFileProposals.proposedFileId })
          .from(projectFileProposals)
          .where(inArray(projectFileProposals.proposedFileId, candidateFileIds)),
        tx
          .select({ fileId: agentsFiles.fileId })
          .from(agentsFiles)
          .where(
            and(inArray(agentsFiles.fileId, candidateFileIds), ne(agentsFiles.agentId, agentId)),
          ),
      ]);

    const protectedFileIds = new Set<string>([
      ...msgRefs.map((r) => r.fileId),
      ...extKbRefs.map((r) => r.fileId),
      ...otherPwfRefs.map((r) => r.fileId),
      ...otherPfrRefs.map((r) => r.fileId),
      ...otherPfpRefs.map((r) => r.fileId).filter((v): v is string => Boolean(v)),
      ...otherAfRefs.map((r) => r.fileId),
    ]);

    const deletableFileIds = candidateFileIds.filter((id) => !protectedFileIds.has(id));
    if (deletableFileIds.length === 0) {
      return { deletedFileIds: [] as string[], deletedS3Keys: [] as string[] };
    }

    const fileRows = await tx
      .select({ fileHash: files.fileHash, id: files.id, url: files.url })
      .from(files)
      .where(and(inArray(files.id, deletableFileIds), eq(files.userId, userId)));

    await new FileModel(db, userId).deleteFileChunks(tx as any, deletableFileIds);
    await tx
      .delete(files)
      .where(and(inArray(files.id, deletableFileIds), eq(files.userId, userId)));

    const hashes = [
      ...new Set(fileRows.map((f) => f.fileHash).filter((v): v is string => Boolean(v))),
    ];
    if (hashes.length > 0) {
      const remainingHashes = await tx
        .select({ fileHash: files.fileHash })
        .from(files)
        .where(inArray(files.fileHash, hashes));
      const busyHashes = new Set(remainingHashes.map((r) => r.fileHash));
      const orphanHashes = hashes.filter((h) => !busyHashes.has(h));
      if (orphanHashes.length > 0) {
        await tx.delete(globalFiles).where(inArray(globalFiles.hashId, orphanHashes));
      }
    }

    const candidateUrls = [...new Set(fileRows.map((f) => f.url).filter(Boolean))];
    let deletedS3Keys: string[] = [];
    if (candidateUrls.length > 0) {
      const [remFiles, remGlobal] = await Promise.all([
        tx.select({ url: files.url }).from(files).where(inArray(files.url, candidateUrls)),
        tx
          .select({ url: globalFiles.url })
          .from(globalFiles)
          .where(inArray(globalFiles.url, candidateUrls)),
      ]);
      const busyUrls = new Set<string>([
        ...remFiles.map((r) => r.url),
        ...remGlobal.map((r) => r.url),
      ]);
      deletedS3Keys = candidateUrls.filter((u) => !busyUrls.has(u));
    }

    return { deletedFileIds: fileRows.map((f) => f.id), deletedS3Keys };
  });

  if (txOutcome.deletedS3Keys.length > 0) {
    try {
      const svc = fileService ?? new FileService(db, userId);
      await svc.deleteFiles(txOutcome.deletedS3Keys);
    } catch (error) {
      console.warn('[cleanupAgentWorkspaceBeforeDelete] Failed to delete S3 keys:', error);
    }
  }

  return txOutcome;
}
