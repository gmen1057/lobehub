/* eslint-disable unicorn/text-encoding-identifier-case */
import type { LobeChatDatabase } from '@lobechat/database';
import { and, eq, isNull, sql } from 'drizzle-orm';

import { agents, files, projectWorkspaceFiles } from '@/database/schemas';
import { FileService } from '@/server/services/file';

import { WorkspaceError } from './paths';
import type { WorkspaceStorageAdapter } from './store';
import { extractWorkspaceBasenameAndExt, isWorkspaceEnabled } from './validator';

export interface WorkspaceExportManifestItem {
  byteSize: number;
  contentSha256: string;
  currentFileId: string;
  dataGuardStatus: 'unmasked' | 'scrubbed';
  downloadUrl: string;
  encoding: 'utf-8' | 'utf-8-bom' | 'windows-1251';
  id: string;
  kind: 'text' | 'document';
  lineEnding: 'lf' | 'crlf';
  mimeType: string;
  path: string;
  s3Key: string;
  updatedAt: string;
}

export interface WorkspaceExportManifestResponse {
  agentId: string;
  agentTitle: string | null;
  dataGuardProtected: boolean;
  files: WorkspaceExportManifestItem[];
  totalBytes: number;
}

export async function getWorkspaceExportManifest(
  db: LobeChatDatabase,
  userId: string,
  agentId: string,
  fileServiceOverride?: Pick<WorkspaceStorageAdapter, 'createPreSignedUrlForPreview'>,
): Promise<WorkspaceExportManifestResponse> {
  if (!isWorkspaceEnabled()) {
    throw new WorkspaceError('WORKSPACE_DISABLED', 'Project workspace is currently disabled', 409);
  }

  const [agent] = await db
    .select({
      chatConfig: agents.chatConfig,
      id: agents.id,
      title: agents.title,
    })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.userId, userId)))
    .limit(1);

  if (!agent) {
    throw new WorkspaceError('AGENT_NOT_FOUND', 'Agent not found', 404);
  }

  const dataGuardProtected = Boolean(
    (agent.chatConfig as Record<string, unknown> | null | undefined)?.dataGuardProtected,
  );

  const rows = await db
    .select({
      byteSize: projectWorkspaceFiles.byteSize,
      contentSha256: projectWorkspaceFiles.contentSha256,
      currentFileId: projectWorkspaceFiles.currentFileId,
      dataGuardStatus: projectWorkspaceFiles.dataGuardStatus,
      encoding: projectWorkspaceFiles.encoding,
      id: projectWorkspaceFiles.id,
      kind: projectWorkspaceFiles.kind,
      lineEnding: projectWorkspaceFiles.lineEnding,
      mimeType: projectWorkspaceFiles.mimeType,
      path: projectWorkspaceFiles.path,
      s3Key: files.url,
      updatedAt: projectWorkspaceFiles.updatedAt,
    })
    .from(projectWorkspaceFiles)
    .innerJoin(files, eq(files.id, projectWorkspaceFiles.currentFileId))
    .where(
      and(
        eq(projectWorkspaceFiles.userId, userId),
        eq(projectWorkspaceFiles.agentId, agentId),
        isNull(projectWorkspaceFiles.deletedAt),
      ),
    )
    .orderBy(sql`lower(${projectWorkspaceFiles.path}) ASC`);

  let lazyStorage: Pick<WorkspaceStorageAdapter, 'createPreSignedUrlForPreview'> | undefined =
    fileServiceOverride;
  const getStorage = (): Pick<WorkspaceStorageAdapter, 'createPreSignedUrlForPreview'> => {
    if (!lazyStorage) {
      lazyStorage = new FileService(db, userId);
    }
    return lazyStorage;
  };

  let totalBytes = 0;
  const manifestFiles: WorkspaceExportManifestItem[] = await Promise.all(
    rows.map(async (row) => {
      totalBytes += row.byteSize;
      const { basename } = extractWorkspaceBasenameAndExt(row.path);
      let downloadUrl: string;
      try {
        downloadUrl = await getStorage().createPreSignedUrlForPreview(row.s3Key, undefined, {
          responseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(basename)}`,
        });
      } catch {
        downloadUrl = `/f/${row.currentFileId}`;
      }

      const encoding: 'utf-8' | 'utf-8-bom' | 'windows-1251' =
        row.encoding === 'utf-8-bom' || row.encoding === 'windows-1251' ? row.encoding : 'utf-8';
      const lineEnding: 'lf' | 'crlf' = row.lineEnding?.toLowerCase() === 'crlf' ? 'crlf' : 'lf';

      return {
        byteSize: row.byteSize,
        contentSha256: row.contentSha256,
        currentFileId: row.currentFileId,
        dataGuardStatus: row.dataGuardStatus === 'scrubbed' ? 'scrubbed' : 'unmasked',
        downloadUrl,
        encoding,
        id: row.id,
        kind: row.kind === 'document' ? 'document' : 'text',
        lineEnding,
        mimeType: row.mimeType,
        path: row.path,
        s3Key: row.s3Key,
        updatedAt: row.updatedAt.toISOString(),
      };
    }),
  );

  return {
    agentId,
    agentTitle: agent.title ?? null,
    dataGuardProtected,
    files: manifestFiles,
    totalBytes,
  };
}
