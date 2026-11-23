import type { LobeChatDatabase } from '@lobechat/database';
import { FileSource } from '@lobechat/types';
import { and, desc, eq, gt, inArray, isNotNull, lt, sql } from 'drizzle-orm';

import { FileModel } from '@/database/models/file';
import {
  agentDocuments,
  agents,
  agentsFiles,
  documents,
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

import type {
  WorkspaceBudgetSummary,
  WorkspaceFileDto,
  WorkspaceFileKind,
  WorkspaceLoadMode,
} from './paths';
import { isRootAgentsMd, WorkspaceError } from './paths';
import type { WorkspaceStorageAdapter } from './store';
import { assertNoActivePathPrefixConflict, ProjectWorkspaceStore } from './store';
import { isWorkspaceEnabled } from './validator';

export const WORKSPACE_TRASH_RETENTION_DAYS = 30;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const DEFAULT_GC_BATCH_LIMIT = 500;
const DEFAULT_STAGING_MAX_AGE_HOURS = 24;
const WORKSPACE_STAGING_SOURCE = FileSource.ProjectWorkspaceStaging;

export type WorkspaceQuotaDto = WorkspaceBudgetSummary;

export interface WorkspaceTrashFileDto extends WorkspaceFileDto {
  deletedAt: string;
  deletedBy: string | null;
  expiresAt: string;
}

const safeDeleteS3Batch = async (
  db: LobeChatDatabase,
  userId: string,
  keys: string[],
  fileServiceOverride?: Pick<WorkspaceStorageAdapter, 'deleteFiles'>,
): Promise<number> => {
  const uniqueKeys = [...new Set(keys.filter(Boolean))];
  if (uniqueKeys.length === 0) return 0;
  try {
    const adapter = fileServiceOverride ?? new FileService(db, userId || 'system');
    await adapter.deleteFiles(uniqueKeys);
    return uniqueKeys.length;
  } catch (error) {
    console.warn('[projectWorkspace/trash] Failed to delete S3 objects:', uniqueKeys.length, error);
    return 0;
  }
};

const ensureAgentOwnedRead = async (
  db: LobeChatDatabase,
  userId: string,
  agentId: string,
): Promise<{
  chatConfig: Record<string, unknown> | null;
  id: string;
  slug: string | null;
  title: string | null;
  virtual: boolean | null;
}> => {
  const [agent] = await db
    .select({
      chatConfig: agents.chatConfig,
      id: agents.id,
      slug: agents.slug,
      title: agents.title,
      virtual: agents.virtual,
    })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.userId, userId)))
    .limit(1);

  if (!agent) {
    throw new WorkspaceError('AGENT_NOT_FOUND', 'Agent not found', 404);
  }

  return {
    ...agent,
    chatConfig: (agent.chatConfig as Record<string, unknown> | null | undefined) ?? null,
  };
};

export async function listTrashFiles(
  db: LobeChatDatabase,
  userId: string,
  agentId: string,
  fileServiceOverride?: WorkspaceStorageAdapter,
): Promise<{ files: WorkspaceTrashFileDto[] }> {
  await ensureAgentOwnedRead(db, userId, agentId);

  const cutoffDate = new Date(Date.now() - WORKSPACE_TRASH_RETENTION_DAYS * DAY_MS);
  const rows = await db
    .select()
    .from(projectWorkspaceFiles)
    .where(
      and(
        eq(projectWorkspaceFiles.userId, userId),
        eq(projectWorkspaceFiles.agentId, agentId),
        isNotNull(projectWorkspaceFiles.deletedAt),
        gt(projectWorkspaceFiles.deletedAt, cutoffDate),
      ),
    )
    .orderBy(desc(projectWorkspaceFiles.deletedAt));

  if (rows.length === 0) {
    return { files: [] };
  }

  const store = new ProjectWorkspaceStore(db, userId, fileServiceOverride);
  const baseDtos = await store.toWorkspaceFileDtos(db, rows);

  const filesOut: WorkspaceTrashFileDto[] = rows.map((row, idx) => {
    const deletedAtDate = row.deletedAt!;
    const expiresAtDate = new Date(
      deletedAtDate.getTime() + WORKSPACE_TRASH_RETENTION_DAYS * DAY_MS,
    );
    return {
      ...baseDtos[idx]!,
      deletedAt: deletedAtDate.toISOString(),
      deletedBy: row.deletedBy ?? null,
      expiresAt: expiresAtDate.toISOString(),
    };
  });

  return { files: filesOut };
}

export async function restoreDeletedFile(
  db: LobeChatDatabase,
  userId: string,
  agentId: string,
  workspaceFileId: string,
  fileServiceOverride?: WorkspaceStorageAdapter,
): Promise<{
  budget: WorkspaceBudgetSummary;
  file: WorkspaceFileDto;
  quota: WorkspaceQuotaDto;
}> {
  if (!isWorkspaceEnabled()) {
    throw new WorkspaceError('WORKSPACE_DISABLED', 'Project workspace is currently disabled', 409);
  }

  const store = new ProjectWorkspaceStore(db, userId, fileServiceOverride);
  const s3KeysToPrune: string[] = [];

  const result = await db.transaction(async (tx) => {
    const [agent] = await tx
      .select({
        chatConfig: agents.chatConfig,
        id: agents.id,
        slug: agents.slug,
        title: agents.title,
        virtual: agents.virtual,
      })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.userId, userId)))
      .for('update');

    if (!agent) {
      throw new WorkspaceError('AGENT_NOT_FOUND', 'Agent not found', 404);
    }

    const [row] = await tx
      .select()
      .from(projectWorkspaceFiles)
      .where(
        and(
          eq(projectWorkspaceFiles.id, workspaceFileId),
          eq(projectWorkspaceFiles.agentId, agentId),
          eq(projectWorkspaceFiles.userId, userId),
        ),
      )
      .for('update');

    const cutoffMs = Date.now() - WORKSPACE_TRASH_RETENTION_DAYS * DAY_MS;
    if (!row || row.deletedAt === null || row.deletedAt.getTime() <= cutoffMs) {
      throw new WorkspaceError('FILE_NOT_FOUND', 'Workspace file not found in trash', 404);
    }

    if ((agent.slug === 'inbox' || agent.virtual === true) && isRootAgentsMd(row.path)) {
      throw new WorkspaceError(
        'INBOX_INSTRUCTION_FORBIDDEN',
        'Inbox or virtual system agent cannot store custom AGENTS.md instructions',
        422,
      );
    }

    const isProtectedProject = Boolean(
      (agent.chatConfig as Record<string, unknown> | null | undefined)?.dataGuardProtected,
    );
    if (isProtectedProject && row.dataGuardStatus !== 'scrubbed') {
      throw new WorkspaceError(
        'DATA_GUARD_SCRUB_REQUIRED',
        'Нельзя восстановить незащищённый файл из корзины в защищённом проекте',
        409,
      );
    }

    await assertNoActivePathPrefixConflict(tx, {
      agentId,
      excludeWorkspaceFileId: row.id,
      normalizedPath: row.path,
      userId,
    });

    const tokensMap = await store.resolveEstimatedTokensForRows(tx, [row]);
    const estimatedTokens =
      row.kind === 'text'
        ? row.currentDocumentId
          ? (tokensMap.get(row.currentDocumentId) ?? Math.ceil((row.charCount ?? 0) * 0.45))
          : Math.ceil((row.charCount ?? 0) * 0.45)
        : 0;

    await store.assertQuotasForWriteInTx(tx, {
      addedRevisionBytes: row.byteSize,
      agentId,
      excludeWorkspaceFileId: row.id,
      isCreatingActiveSlot: true,
      newByteSize: row.byteSize,
      newCharCount: row.charCount ?? 0,
      newEstimatedTokens: estimatedTokens,
      newKind: row.kind as WorkspaceFileKind,
      newLoadMode: row.loadMode as WorkspaceLoadMode,
    });

    const nextRev = row.currentRevision + 1;
    const now = new Date();

    const [updated] = await tx
      .update(projectWorkspaceFiles)
      .set({
        currentRevision: nextRev,
        deletedAt: null,
        deletedBy: null,
        updatedAt: now,
        updatedBy: 'user',
      })
      .where(eq(projectWorkspaceFiles.id, row.id))
      .returning();

    await tx.insert(projectFileRevisions).values({
      agentId,
      authorType: 'user',
      byteSize: row.byteSize,
      changeNote: 'Restored from trash',
      charCount: row.charCount,
      contentSha256: row.contentSha256,
      diffStats: null,
      documentId: row.currentDocumentId,
      encoding: row.encoding,
      fileId: row.currentFileId,
      lineCount: row.lineCount,
      lineEnding: row.lineEnding,
      revision: nextRev,
      userId,
      workspaceFileId: row.id,
    });

    if (isRootAgentsMd(row.path)) {
      await tx
        .update(agents)
        .set({ systemRole: null, updatedAt: now })
        .where(and(eq(agents.id, agentId), eq(agents.userId, userId)));
    }

    if (row.ragEnabled) {
      await store.syncRagMembershipInTx(tx, {
        agentId,
        agentTitle: agent.title,
        newFileId: row.currentFileId,
        newRagEnabled: true,
        oldFileId: null,
        oldRagEnabled: false,
      });
    }

    const prunedKeys = await store.pruneRevisionsInTx(tx, row.id);
    s3KeysToPrune.push(...prunedKeys);

    const [dto] = await store.toWorkspaceFileDtos(tx, [updated!]);
    const budget = await store.computeBudgetSummary(tx, agentId);

    return {
      budget,
      file: dto!,
      quota: budget,
    };
  });

  if (s3KeysToPrune.length > 0) {
    await store.deleteS3KeysSafe(s3KeysToPrune);
  }

  return result;
}

const executeLockedTrashPurgeInTx = async (
  tx: Parameters<Parameters<LobeChatDatabase['transaction']>[0]>[0],
  db: LobeChatDatabase,
  lockedRows: Array<{
    agentId: string;
    currentDocumentId: string | null;
    currentFileId: string;
    id: string;
    path: string;
    userId: string;
  }>,
): Promise<{ deletedS3Keys: string[]; purgedCount: number }> => {
  if (lockedRows.length === 0) {
    return { deletedS3Keys: [], purgedCount: 0 };
  }

  const pwfIds = lockedRows.map((r) => r.id);
  const affectedAgentIds = [...new Set(lockedRows.map((r) => r.agentId))];

  // R2-2 invariant: ensure agents.systemRole stays null if AGENTS.md is purged
  const agentsMdAgentIds = [
    ...new Set(lockedRows.filter((r) => isRootAgentsMd(r.path)).map((r) => r.agentId)),
  ];
  if (agentsMdAgentIds.length > 0) {
    await tx
      .update(agents)
      .set({ systemRole: null, updatedAt: new Date() })
      .where(inArray(agents.id, agentsMdAgentIds));
  }

  const [pfrRows, pfpRows, managedKbs] = await Promise.all([
    tx
      .select({
        documentId: projectFileRevisions.documentId,
        fileId: projectFileRevisions.fileId,
      })
      .from(projectFileRevisions)
      .where(inArray(projectFileRevisions.workspaceFileId, pwfIds)),
    tx
      .select({ proposedFileId: projectFileProposals.proposedFileId })
      .from(projectFileProposals)
      .where(inArray(projectFileProposals.workspaceFileId, pwfIds)),
    tx
      .select({ id: knowledgeBases.id })
      .from(knowledgeBases)
      .where(
        and(
          eq(knowledgeBases.type, 'project_workspace'),
          sql`${knowledgeBases.settings}->>'managedByAgentId' IN (${sql.join(
            affectedAgentIds.map((aid) => sql`${aid}`),
            sql`, `,
          )})`,
        ),
      ),
  ]);

  const candidateFileIds = [
    ...new Set(
      [
        ...lockedRows.map((r) => r.currentFileId),
        ...pfrRows.map((r) => r.fileId),
        ...pfpRows.map((r) => r.proposedFileId).filter((v): v is string => Boolean(v)),
      ].filter(Boolean),
    ),
  ];

  const candidateDocIds = [
    ...new Set(
      [...lockedRows.map((r) => r.currentDocumentId), ...pfrRows.map((r) => r.documentId)].filter(
        (v): v is string => Boolean(v),
      ),
    ),
  ];

  // Detach ONLY from managed project_workspace KBs of affected agents
  const managedKbIds = managedKbs.map((k) => k.id);
  if (managedKbIds.length > 0 && candidateFileIds.length > 0) {
    await tx
      .delete(knowledgeBaseFiles)
      .where(
        and(
          inArray(knowledgeBaseFiles.knowledgeBaseId, managedKbIds),
          inArray(knowledgeBaseFiles.fileId, candidateFileIds),
        ),
      );
  }

  // Strict FK deletion order: proposals -> revisions -> project_workspace_files
  await tx
    .delete(projectFileProposals)
    .where(inArray(projectFileProposals.workspaceFileId, pwfIds));
  await tx
    .delete(projectFileRevisions)
    .where(inArray(projectFileRevisions.workspaceFileId, pwfIds));
  await tx.delete(projectWorkspaceFiles).where(inArray(projectWorkspaceFiles.id, pwfIds));

  // Delete unreferenced documents
  if (candidateDocIds.length > 0) {
    const [remPwfDocs, remPfrDocs, remAgentDocs, remTopicDocs] = await Promise.all([
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
        .where(inArray(agentDocuments.documentId, candidateDocIds)),
      tx
        .select({ id: topicDocuments.documentId })
        .from(topicDocuments)
        .where(inArray(topicDocuments.documentId, candidateDocIds)),
    ]);

    const busyDocIds = new Set<string>([
      ...remPwfDocs.map((r) => r.id).filter((v): v is string => Boolean(v)),
      ...remPfrDocs.map((r) => r.id).filter((v): v is string => Boolean(v)),
      ...remAgentDocs.map((r) => r.id),
      ...remTopicDocs.map((r) => r.id),
    ]);

    const deletableDocIds = candidateDocIds.filter((id) => !busyDocIds.has(id));
    if (deletableDocIds.length > 0) {
      await tx.delete(documents).where(inArray(documents.id, deletableDocIds));
    }
  }

  if (candidateFileIds.length === 0) {
    return { deletedS3Keys: [], purgedCount: lockedRows.length };
  }

  // Protect files still referenced by messages_files, external/remaining KBs, agents_files, or remaining workspace rows
  const [msgRefs, kbRefs, afRefs, remPwfRefs, remPfrRefs, remPfpRefs] = await Promise.all([
    tx
      .select({ fileId: messagesFiles.fileId })
      .from(messagesFiles)
      .where(inArray(messagesFiles.fileId, candidateFileIds)),
    tx
      .select({ fileId: knowledgeBaseFiles.fileId })
      .from(knowledgeBaseFiles)
      .where(inArray(knowledgeBaseFiles.fileId, candidateFileIds)),
    tx
      .select({ fileId: agentsFiles.fileId })
      .from(agentsFiles)
      .where(inArray(agentsFiles.fileId, candidateFileIds)),
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
  ]);

  const protectedFileIds = new Set<string>([
    ...msgRefs.map((r) => r.fileId),
    ...kbRefs.map((r) => r.fileId),
    ...afRefs.map((r) => r.fileId),
    ...remPwfRefs.map((r) => r.fileId),
    ...remPfrRefs.map((r) => r.fileId),
    ...remPfpRefs.map((r) => r.fileId).filter((v): v is string => Boolean(v)),
  ]);

  const deletableFileIds = candidateFileIds.filter((id) => !protectedFileIds.has(id));
  if (deletableFileIds.length === 0) {
    return { deletedS3Keys: [], purgedCount: lockedRows.length };
  }

  const fileRows = await tx
    .select({
      fileHash: files.fileHash,
      id: files.id,
      url: files.url,
      userId: files.userId,
    })
    .from(files)
    .where(inArray(files.id, deletableFileIds));

  // Group by owner userId for deleteFileChunks
  const filesByOwner = new Map<string, string[]>();
  for (const fr of fileRows) {
    const list = filesByOwner.get(fr.userId) ?? [];
    list.push(fr.id);
    filesByOwner.set(fr.userId, list);
  }
  for (const [ownerId, ownerFileIds] of filesByOwner) {
    await new FileModel(db, ownerId).deleteFileChunks(tx as any, ownerFileIds);
  }

  await tx.delete(files).where(inArray(files.id, deletableFileIds));

  const hashes = [
    ...new Set(fileRows.map((f) => f.fileHash).filter((v): v is string => Boolean(v))),
  ];
  if (hashes.length > 0) {
    const remHashes = await tx
      .select({ fileHash: files.fileHash })
      .from(files)
      .where(inArray(files.fileHash, hashes));
    const busyHashes = new Set(remHashes.map((r) => r.fileHash));
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

  return { deletedS3Keys, purgedCount: lockedRows.length };
};

export async function purgeTrashFile(
  db: LobeChatDatabase,
  userId: string,
  agentId: string,
  workspaceFileId: string,
  fileServiceOverride?: Pick<WorkspaceStorageAdapter, 'deleteFiles'>,
): Promise<{ purgedCount: number }> {
  if (!isWorkspaceEnabled()) {
    throw new WorkspaceError('WORKSPACE_DISABLED', 'Project workspace is currently disabled', 409);
  }

  const txOutcome = await db.transaction(async (tx) => {
    const [agent] = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.userId, userId)))
      .limit(1);
    if (!agent) {
      throw new WorkspaceError('AGENT_NOT_FOUND', 'Agent not found', 404);
    }

    const lockedRows = await tx
      .select({
        agentId: projectWorkspaceFiles.agentId,
        currentDocumentId: projectWorkspaceFiles.currentDocumentId,
        currentFileId: projectWorkspaceFiles.currentFileId,
        deletedAt: projectWorkspaceFiles.deletedAt,
        id: projectWorkspaceFiles.id,
        path: projectWorkspaceFiles.path,
        userId: projectWorkspaceFiles.userId,
      })
      .from(projectWorkspaceFiles)
      .where(
        and(
          eq(projectWorkspaceFiles.id, workspaceFileId),
          eq(projectWorkspaceFiles.agentId, agentId),
          eq(projectWorkspaceFiles.userId, userId),
        ),
      )
      .for('update');

    const row = lockedRows[0];
    if (!row || row.deletedAt === null) {
      throw new WorkspaceError('FILE_NOT_FOUND', 'Trash file not found', 404);
    }

    return executeLockedTrashPurgeInTx(tx, db, [row]);
  });

  if (txOutcome.deletedS3Keys.length > 0) {
    await safeDeleteS3Batch(db, userId, txOutcome.deletedS3Keys, fileServiceOverride);
  }

  return { purgedCount: txOutcome.purgedCount };
}

export async function emptyAgentTrash(
  db: LobeChatDatabase,
  userId: string,
  agentId: string,
  fileServiceOverride?: Pick<WorkspaceStorageAdapter, 'deleteFiles'>,
): Promise<{ purgedCount: number }> {
  if (!isWorkspaceEnabled()) {
    throw new WorkspaceError('WORKSPACE_DISABLED', 'Project workspace is currently disabled', 409);
  }

  const txOutcome = await db.transaction(async (tx) => {
    const [agent] = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.userId, userId)))
      .limit(1);
    if (!agent) {
      throw new WorkspaceError('AGENT_NOT_FOUND', 'Agent not found', 404);
    }

    const lockedRows = await tx
      .select({
        agentId: projectWorkspaceFiles.agentId,
        currentDocumentId: projectWorkspaceFiles.currentDocumentId,
        currentFileId: projectWorkspaceFiles.currentFileId,
        id: projectWorkspaceFiles.id,
        path: projectWorkspaceFiles.path,
        userId: projectWorkspaceFiles.userId,
      })
      .from(projectWorkspaceFiles)
      .where(
        and(
          eq(projectWorkspaceFiles.agentId, agentId),
          eq(projectWorkspaceFiles.userId, userId),
          isNotNull(projectWorkspaceFiles.deletedAt),
        ),
      )
      .for('update');

    return executeLockedTrashPurgeInTx(tx, db, lockedRows);
  });

  if (txOutcome.deletedS3Keys.length > 0) {
    await safeDeleteS3Batch(db, userId, txOutcome.deletedS3Keys, fileServiceOverride);
  }

  return { purgedCount: txOutcome.purgedCount };
}

export async function purgeExpiredWorkspaceTrash(
  db: LobeChatDatabase,
  options?: {
    limit?: number;
    retentionDays?: number;
    stagingMaxAgeHours?: number;
  },
  fileServiceOverride?: Pick<WorkspaceStorageAdapter, 'deleteFiles'>,
): Promise<{
  deletedS3Objects: number;
  purgedStagingFiles: number;
  purgedTrashFiles: number;
}> {
  const retentionDays = Math.max(0, options?.retentionDays ?? WORKSPACE_TRASH_RETENTION_DAYS);
  const limit = Math.min(5000, Math.max(1, Math.floor(options?.limit ?? DEFAULT_GC_BATCH_LIMIT)));
  const stagingMaxAgeHours = Math.max(
    0,
    options?.stagingMaxAgeHours ?? DEFAULT_STAGING_MAX_AGE_HOURS,
  );

  const trashCutoff = new Date(Date.now() - retentionDays * DAY_MS);
  const stagingCutoff = new Date(Date.now() - stagingMaxAgeHours * HOUR_MS);

  const trashTxOutcome = await db.transaction(async (tx) => {
    const expiredRows = await tx
      .select({
        agentId: projectWorkspaceFiles.agentId,
        currentDocumentId: projectWorkspaceFiles.currentDocumentId,
        currentFileId: projectWorkspaceFiles.currentFileId,
        id: projectWorkspaceFiles.id,
        path: projectWorkspaceFiles.path,
        userId: projectWorkspaceFiles.userId,
      })
      .from(projectWorkspaceFiles)
      .where(
        and(
          isNotNull(projectWorkspaceFiles.deletedAt),
          lt(projectWorkspaceFiles.deletedAt, trashCutoff),
        ),
      )
      .limit(limit)
      .for('update');

    return executeLockedTrashPurgeInTx(tx, db, expiredRows);
  });

  const stagingTxOutcome = await db.transaction(async (tx) => {
    const staleStagingRows = await tx
      .select({
        fileHash: files.fileHash,
        id: files.id,
        url: files.url,
        userId: files.userId,
      })
      .from(files)
      .where(and(eq(files.source, WORKSPACE_STAGING_SOURCE), lt(files.updatedAt, stagingCutoff)))
      .limit(limit)
      .for('update');

    if (staleStagingRows.length === 0) {
      return { deletedS3Keys: [] as string[], purgedStagingCount: 0 };
    }

    const stagingIds = staleStagingRows.map((r) => r.id);
    const [pwfRefs, pfrRefs, pfpRefs, msgRefs, kbRefs, afRefs] = await Promise.all([
      tx
        .select({ fileId: projectWorkspaceFiles.currentFileId })
        .from(projectWorkspaceFiles)
        .where(inArray(projectWorkspaceFiles.currentFileId, stagingIds)),
      tx
        .select({ fileId: projectFileRevisions.fileId })
        .from(projectFileRevisions)
        .where(inArray(projectFileRevisions.fileId, stagingIds)),
      tx
        .select({ fileId: projectFileProposals.proposedFileId })
        .from(projectFileProposals)
        .where(inArray(projectFileProposals.proposedFileId, stagingIds)),
      tx
        .select({ fileId: messagesFiles.fileId })
        .from(messagesFiles)
        .where(inArray(messagesFiles.fileId, stagingIds)),
      tx
        .select({ fileId: knowledgeBaseFiles.fileId })
        .from(knowledgeBaseFiles)
        .where(inArray(knowledgeBaseFiles.fileId, stagingIds)),
      tx
        .select({ fileId: agentsFiles.fileId })
        .from(agentsFiles)
        .where(inArray(agentsFiles.fileId, stagingIds)),
    ]);

    const busyIds = new Set<string>([
      ...pwfRefs.map((r) => r.fileId),
      ...pfrRefs.map((r) => r.fileId),
      ...pfpRefs.map((r) => r.fileId).filter((v): v is string => Boolean(v)),
      ...msgRefs.map((r) => r.fileId),
      ...kbRefs.map((r) => r.fileId),
      ...afRefs.map((r) => r.fileId),
    ]);

    const deletableRows = staleStagingRows.filter((r) => !busyIds.has(r.id));
    if (deletableRows.length === 0) {
      return { deletedS3Keys: [] as string[], purgedStagingCount: 0 };
    }

    const deletableIds = deletableRows.map((r) => r.id);
    const ownersMap = new Map<string, string[]>();
    for (const r of deletableRows) {
      const list = ownersMap.get(r.userId) ?? [];
      list.push(r.id);
      ownersMap.set(r.userId, list);
    }
    for (const [ownerId, ownerFileIds] of ownersMap) {
      await new FileModel(db, ownerId).deleteFileChunks(tx as any, ownerFileIds);
    }

    await tx.delete(files).where(inArray(files.id, deletableIds));

    const hashes = [
      ...new Set(deletableRows.map((r) => r.fileHash).filter((v): v is string => Boolean(v))),
    ];
    if (hashes.length > 0) {
      const remHashes = await tx
        .select({ fileHash: files.fileHash })
        .from(files)
        .where(inArray(files.fileHash, hashes));
      const busyHashes = new Set(remHashes.map((r) => r.fileHash));
      const orphanHashes = hashes.filter((h) => !busyHashes.has(h));
      if (orphanHashes.length > 0) {
        await tx.delete(globalFiles).where(inArray(globalFiles.hashId, orphanHashes));
      }
    }

    const candidateUrls = [...new Set(deletableRows.map((r) => r.url).filter(Boolean))];
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

    return { deletedS3Keys, purgedStagingCount: deletableRows.length };
  });

  const allS3Keys = [
    ...new Set([...trashTxOutcome.deletedS3Keys, ...stagingTxOutcome.deletedS3Keys]),
  ];
  const deletedS3Objects =
    allS3Keys.length > 0
      ? await safeDeleteS3Batch(db, 'system', allS3Keys, fileServiceOverride)
      : 0;

  return {
    deletedS3Objects,
    purgedStagingFiles: stagingTxOutcome.purgedStagingCount,
    purgedTrashFiles: trashTxOutcome.purgedCount,
  };
}
