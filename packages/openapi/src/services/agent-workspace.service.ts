import type { SourceLineEnding } from '@lobechat/file-loaders';

import type { LobeChatDatabase } from '@/database/type';
import {
  isWorkspaceEnabled,
  ProjectWorkspaceStore,
  WorkspaceError,
} from '@/server/services/projectWorkspace';
import { getWorkspaceExportManifest } from '@/server/services/projectWorkspace/exportManifest';
import {
  emptyAgentTrash,
  listTrashFiles,
  purgeTrashFile,
  restoreDeletedFile,
} from '@/server/services/projectWorkspace/trash';

import { BaseService } from '../common/base.service';
import type { ServiceResult } from '../types';
import type {
  PutWorkspaceTextRequest,
  RegisterWorkspaceFileRequest,
  RollbackWorkspaceFileRequest,
  UpdateWorkspaceFileMetadataRequest,
  WorkspaceApplyProposalResponse,
  WorkspaceDeleteResponse,
  WorkspaceDiffResponse,
  WorkspaceExportManifestResponse,
  WorkspaceFileDetailResponse,
  WorkspaceOverviewResponse,
  WorkspacePurgeTrashResponse,
  WorkspaceRejectProposalResponse,
  WorkspaceRestoreTrashResponse,
  WorkspaceRevisionsResponse,
  WorkspaceRollbackResponse,
  WorkspaceTrashResponse,
  WorkspaceWriteResponse,
} from '../types/agent-workspace.type';

export class AgentWorkspaceService extends BaseService {
  private readonly store: ProjectWorkspaceStore;

  constructor(db: LobeChatDatabase, userId: string | null, store?: ProjectWorkspaceStore) {
    super(db, userId);
    this.store = store ?? new ProjectWorkspaceStore(db, this.userId);
  }

  private async assertWorkspacePermission(action: 'AGENT_READ' | 'AGENT_UPDATE'): Promise<void> {
    if (!this.userId) {
      throw this.createAuthError('Authentication required');
    }

    const permissionResult = await this.resolveOperationPermission(action);
    if (!permissionResult.isPermitted) {
      throw this.createAuthorizationError(
        permissionResult.message || `Insufficient permission for ${action}`,
      );
    }
  }

  private assertWorkspaceMutationsEnabled(): void {
    if (!isWorkspaceEnabled()) {
      throw new WorkspaceError(
        'WORKSPACE_DISABLED',
        'Project workspace is currently disabled',
        409,
      );
    }
  }

  async getWorkspaceOverview(agentId: string): ServiceResult<WorkspaceOverviewResponse> {
    await this.assertWorkspacePermission('AGENT_READ');
    return await this.store.getWorkspaceOverview(agentId);
  }

  async getFileDetail(
    agentId: string,
    workspaceFileId: string,
    options?: { includeContent?: boolean; revision?: number },
  ): ServiceResult<WorkspaceFileDetailResponse> {
    await this.assertWorkspacePermission('AGENT_READ');
    return await this.store.getFileDetail(agentId, workspaceFileId, options);
  }

  async putUserTextFile(
    agentId: string,
    body: PutWorkspaceTextRequest,
  ): ServiceResult<WorkspaceWriteResponse> {
    await this.assertWorkspacePermission('AGENT_UPDATE');
    this.assertWorkspaceMutationsEnabled();
    const normalizedLineEnding: SourceLineEnding | undefined = body.lineEnding
      ? (body.lineEnding.toUpperCase() as SourceLineEnding)
      : undefined;
    return await this.store.putUserTextFile(agentId, {
      baseRevision: body.baseRevision,
      changeNote: body.changeNote,
      content: body.content,
      ...(body.dataGuardStatus !== undefined ? { dataGuardStatus: body.dataGuardStatus } : {}),
      encoding: body.encoding ?? undefined,
      isProtected: body.isProtected ?? undefined,
      lineEnding: normalizedLineEnding,
      loadMode: body.loadMode ?? undefined,
      path: body.path,
      userSummary: body.userSummary,
    });
  }

  async registerUploadedFile(
    agentId: string,
    body: RegisterWorkspaceFileRequest,
  ): ServiceResult<WorkspaceWriteResponse> {
    await this.assertWorkspacePermission('AGENT_UPDATE');
    this.assertWorkspaceMutationsEnabled();
    return await this.store.registerUploadedFile(agentId, {
      baseRevision: body.baseRevision,
      ...(body.dataGuardStatus !== undefined ? { dataGuardStatus: body.dataGuardStatus } : {}),
      enableRag: body.enableRag ?? undefined,
      fileId: body.fileId,
      kind: body.kind,
      loadMode: body.loadMode ?? undefined,
      mimeType: body.mimeType,
      path: body.path,
      userSummary: body.userSummary,
    });
  }

  async updateFileMetadata(
    agentId: string,
    workspaceFileId: string,
    body: UpdateWorkspaceFileMetadataRequest,
  ): ServiceResult<WorkspaceWriteResponse> {
    await this.assertWorkspacePermission('AGENT_UPDATE');
    this.assertWorkspaceMutationsEnabled();
    return await this.store.updateFileMetadata(agentId, workspaceFileId, {
      actor: 'user',
      baseRevision: body.baseRevision ?? undefined,
      isProtected: body.isProtected ?? undefined,
      loadMode: body.loadMode ?? undefined,
      path: body.path,
      ragEnabled: body.ragEnabled ?? undefined,
      userSummary: body.userSummary,
    });
  }

  async deleteWorkspaceFile(
    agentId: string,
    workspaceFileId: string,
    baseRevision?: number,
  ): ServiceResult<WorkspaceDeleteResponse> {
    await this.assertWorkspacePermission('AGENT_UPDATE');
    this.assertWorkspaceMutationsEnabled();
    const result = await this.store.deleteWorkspaceFile(
      agentId,
      { workspaceFileId },
      { actor: 'user', baseRevision },
    );

    if (result.outcome !== 'deleted') {
      throw new WorkspaceError(
        'INVALID_OPERATION',
        'Unexpected proposal outcome when deleting file as user',
        422,
      );
    }

    return {
      budget: result.budget,
      deleted: true,
      revision: result.revision,
    };
  }

  async listRevisions(
    agentId: string,
    workspaceFileId: string,
  ): ServiceResult<WorkspaceRevisionsResponse> {
    await this.assertWorkspacePermission('AGENT_READ');
    return await this.store.listRevisions(agentId, workspaceFileId);
  }

  async diffRevisions(
    agentId: string,
    workspaceFileId: string,
    fromRevision: number,
    toRevision: number,
  ): ServiceResult<WorkspaceDiffResponse> {
    await this.assertWorkspacePermission('AGENT_READ');
    return await this.store.diffRevisions(agentId, workspaceFileId, fromRevision, toRevision);
  }

  async rollbackFileRevision(
    agentId: string,
    workspaceFileId: string,
    body: RollbackWorkspaceFileRequest,
  ): ServiceResult<WorkspaceRollbackResponse> {
    await this.assertWorkspacePermission('AGENT_UPDATE');
    this.assertWorkspaceMutationsEnabled();
    return await this.store.rollbackFileRevision(agentId, workspaceFileId, {
      baseRevision: body.baseRevision ?? undefined,
      targetRevision: body.targetRevision,
    });
  }

  async applyProposal(
    agentId: string,
    proposalId: string,
  ): ServiceResult<WorkspaceApplyProposalResponse> {
    await this.assertWorkspacePermission('AGENT_UPDATE');
    this.assertWorkspaceMutationsEnabled();
    return await this.store.applyProposal(agentId, proposalId);
  }

  async rejectProposal(
    agentId: string,
    proposalId: string,
  ): ServiceResult<WorkspaceRejectProposalResponse> {
    await this.assertWorkspacePermission('AGENT_UPDATE');
    this.assertWorkspaceMutationsEnabled();
    return await this.store.rejectProposal(agentId, proposalId);
  }

  async listTrash(agentId: string): ServiceResult<WorkspaceTrashResponse> {
    await this.assertWorkspacePermission('AGENT_READ');
    return await listTrashFiles(this.db, this.userId, agentId);
  }

  async restoreTrashFile(
    agentId: string,
    workspaceFileId: string,
  ): ServiceResult<WorkspaceRestoreTrashResponse> {
    await this.assertWorkspacePermission('AGENT_UPDATE');
    this.assertWorkspaceMutationsEnabled();
    return await restoreDeletedFile(this.db, this.userId, agentId, workspaceFileId);
  }

  async purgeTrashFile(
    agentId: string,
    workspaceFileId: string,
  ): ServiceResult<WorkspacePurgeTrashResponse> {
    await this.assertWorkspacePermission('AGENT_UPDATE');
    this.assertWorkspaceMutationsEnabled();
    return await purgeTrashFile(this.db, this.userId, agentId, workspaceFileId);
  }

  async emptyTrash(agentId: string): ServiceResult<WorkspacePurgeTrashResponse> {
    await this.assertWorkspacePermission('AGENT_UPDATE');
    this.assertWorkspaceMutationsEnabled();
    return await emptyAgentTrash(this.db, this.userId, agentId);
  }

  async getExportManifest(agentId: string): ServiceResult<WorkspaceExportManifestResponse> {
    await this.assertWorkspacePermission('AGENT_READ');
    this.assertWorkspaceMutationsEnabled();
    return await getWorkspaceExportManifest(this.db, this.userId, agentId);
  }
}
