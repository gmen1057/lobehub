import { zValidator } from '@hono/zod-validator';
import type { Context } from 'hono';
import { Hono } from 'hono';

import { WorkspaceError } from '@/server/services/projectWorkspace';
import { getAllScopePermissions } from '@/utils/rbac';

import { BaseController } from '../common/base.controller';
import { requireAuth } from '../middleware/auth';
import { requireAnyPermission } from '../middleware/permission-check';
import { AgentWorkspaceService } from '../services/agent-workspace.service';
import type {
  AgentWorkspaceFileParam,
  AgentWorkspaceParam,
  AgentWorkspaceProposalParam,
  DeleteWorkspaceFileQuery,
  GetWorkspaceFileDetailQuery,
  PutWorkspaceTextRequest,
  RegisterWorkspaceFileRequest,
  RollbackWorkspaceFileRequest,
  UpdateWorkspaceFileMetadataRequest,
  WorkspaceDiffQuery,
} from '../types/agent-workspace.type';
import {
  AgentWorkspaceFileParamSchema,
  AgentWorkspaceParamSchema,
  AgentWorkspaceProposalParamSchema,
  DeleteWorkspaceFileBodySchema,
  DeleteWorkspaceFileQuerySchema,
  GetWorkspaceFileDetailQuerySchema,
  PutWorkspaceTextSchema,
  RegisterWorkspaceFileSchema,
  RollbackWorkspaceFileSchema,
  UpdateWorkspaceFileMetadataSchema,
  WorkspaceDiffQuerySchema,
} from '../types/agent-workspace.type';

class AgentWorkspaceController extends BaseController {
  protected override handleError(c: Context, error: unknown): Response {
    if (error instanceof WorkspaceError) {
      return c.json(
        {
          ...error.details,
          code: error.code,
          details: error.details ?? null,
          error: error.message,
          success: false,
          timestamp: new Date().toISOString(),
        },
        error.httpStatus as any,
      );
    }

    return super.handleError(c, error);
  }

  private async createService(c: Context): Promise<AgentWorkspaceService> {
    const db = await this.getDatabase();
    return new AgentWorkspaceService(db, this.getUserId(c));
  }

  private async ensureOptionalObjectBody(c: Context): Promise<Response | null> {
    const rawBody = await c.req.text();
    if (rawBody.trim().length === 0) return null;

    try {
      const parsed = JSON.parse(rawBody);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return this.error(c, 'Request body must be a JSON object', 400);
      }
      return null;
    } catch {
      return this.error(c, 'Invalid JSON body', 400);
    }
  }

  async getOverview(c: Context): Promise<Response> {
    try {
      const { agentId } = this.getParams<AgentWorkspaceParam>(c);
      const service = await this.createService(c);
      const data = await service.getWorkspaceOverview(agentId);
      return this.success(c, data, 'Workspace overview retrieved');
    } catch (error) {
      return this.handleError(c, error);
    }
  }

  async getFileDetail(c: Context): Promise<Response> {
    try {
      const { agentId, workspaceFileId } = this.getParams<AgentWorkspaceFileParam>(c);
      const query = this.getQuery<GetWorkspaceFileDetailQuery>(c);
      const includeContent = query.includeContent !== '0' && query.includeContent !== 'false';
      const service = await this.createService(c);
      const data = await service.getFileDetail(agentId, workspaceFileId, {
        includeContent,
        revision: query.revision,
      });
      return this.success(c, data, 'Workspace file detail retrieved');
    } catch (error) {
      return this.handleError(c, error);
    }
  }

  async putTextFile(c: Context): Promise<Response> {
    try {
      const { agentId } = this.getParams<AgentWorkspaceParam>(c);
      const body = await this.getBody<PutWorkspaceTextRequest>(c);
      const service = await this.createService(c);
      const data = await service.putUserTextFile(agentId, body);
      return this.success(c, data, 'Workspace text file saved');
    } catch (error) {
      return this.handleError(c, error);
    }
  }

  async registerFile(c: Context): Promise<Response> {
    try {
      const { agentId } = this.getParams<AgentWorkspaceParam>(c);
      const body = await this.getBody<RegisterWorkspaceFileRequest>(c);
      const service = await this.createService(c);
      const data = await service.registerUploadedFile(agentId, body);
      return this.success(c, data, 'Workspace file registered');
    } catch (error) {
      return this.handleError(c, error);
    }
  }

  async updateFileMetadata(c: Context): Promise<Response> {
    try {
      const { agentId, workspaceFileId } = this.getParams<AgentWorkspaceFileParam>(c);
      const body = await this.getBody<UpdateWorkspaceFileMetadataRequest>(c);
      const service = await this.createService(c);
      const data = await service.updateFileMetadata(agentId, workspaceFileId, body);
      return this.success(c, data, 'Workspace file metadata updated');
    } catch (error) {
      return this.handleError(c, error);
    }
  }

  async deleteFile(c: Context): Promise<Response> {
    try {
      const { agentId, workspaceFileId } = this.getParams<AgentWorkspaceFileParam>(c);
      const query = this.getQuery<DeleteWorkspaceFileQuery>(c);
      let baseRevision = query.baseRevision;

      if (baseRevision === undefined) {
        const rawBody = await c.req.text();
        if (rawBody.trim().length > 0) {
          let parsedJson: unknown;
          try {
            parsedJson = JSON.parse(rawBody);
          } catch {
            return this.error(c, 'Invalid JSON body', 400);
          }

          const parsedBody = DeleteWorkspaceFileBodySchema.safeParse(parsedJson);
          if (!parsedBody.success) {
            return this.error(
              c,
              parsedBody.error.issues[0]?.message || 'Invalid delete request body',
              400,
            );
          }
          baseRevision = parsedBody.data.baseRevision ?? undefined;
        }
      }

      const service = await this.createService(c);
      const data = await service.deleteWorkspaceFile(agentId, workspaceFileId, baseRevision);
      return this.success(c, data, 'Workspace file deleted');
    } catch (error) {
      return this.handleError(c, error);
    }
  }

  async listRevisions(c: Context): Promise<Response> {
    try {
      const { agentId, workspaceFileId } = this.getParams<AgentWorkspaceFileParam>(c);
      const service = await this.createService(c);
      const data = await service.listRevisions(agentId, workspaceFileId);
      return this.success(c, data, 'Workspace file revisions retrieved');
    } catch (error) {
      return this.handleError(c, error);
    }
  }

  async diffRevisions(c: Context): Promise<Response> {
    try {
      const { agentId, workspaceFileId } = this.getParams<AgentWorkspaceFileParam>(c);
      const { fromRevision, toRevision } = this.getQuery<WorkspaceDiffQuery>(c);
      const service = await this.createService(c);
      const data = await service.diffRevisions(agentId, workspaceFileId, fromRevision, toRevision);
      return this.success(c, data, 'Workspace file diff computed');
    } catch (error) {
      return this.handleError(c, error);
    }
  }

  async rollbackFile(c: Context): Promise<Response> {
    try {
      const { agentId, workspaceFileId } = this.getParams<AgentWorkspaceFileParam>(c);
      const body = await this.getBody<RollbackWorkspaceFileRequest>(c);
      const service = await this.createService(c);
      const data = await service.rollbackFileRevision(agentId, workspaceFileId, body);
      return this.success(c, data, 'Workspace file rolled back');
    } catch (error) {
      return this.handleError(c, error);
    }
  }

  async applyProposal(c: Context): Promise<Response> {
    try {
      const bodyError = await this.ensureOptionalObjectBody(c);
      if (bodyError) return bodyError;

      const { agentId, proposalId } = this.getParams<AgentWorkspaceProposalParam>(c);
      const service = await this.createService(c);
      const data = await service.applyProposal(agentId, proposalId);
      return this.success(c, data, 'Workspace proposal applied');
    } catch (error) {
      return this.handleError(c, error);
    }
  }

  async rejectProposal(c: Context): Promise<Response> {
    try {
      const bodyError = await this.ensureOptionalObjectBody(c);
      if (bodyError) return bodyError;

      const { agentId, proposalId } = this.getParams<AgentWorkspaceProposalParam>(c);
      const service = await this.createService(c);
      const data = await service.rejectProposal(agentId, proposalId);
      return this.success(c, data, 'Workspace proposal rejected');
    } catch (error) {
      return this.handleError(c, error);
    }
  }
}

const AgentWorkspaceRoutes = new Hono();

const requireAgentRead = requireAnyPermission(
  getAllScopePermissions('AGENT_READ'),
  'You do not have permission to view the Agent workspace',
);

const requireAgentUpdate = requireAnyPermission(
  getAllScopePermissions('AGENT_UPDATE'),
  'You do not have permission to update the Agent workspace',
);

const registerWithOptionalTrailingSlash = (
  method: 'delete' | 'get' | 'patch' | 'post' | 'put',
  path: string,
  ...handlers: any[]
) => {
  (AgentWorkspaceRoutes[method] as any)(path, ...handlers);
  if (!path.endsWith('/')) {
    (AgentWorkspaceRoutes[method] as any)(`${path}/`, ...handlers);
  }
};

// 1. GET /api/v1/agents/:agentId/workspace
registerWithOptionalTrailingSlash(
  'get',
  '/:agentId/workspace',
  requireAuth,
  requireAgentRead,
  zValidator('param', AgentWorkspaceParamSchema),
  async (c: Context) => new AgentWorkspaceController().getOverview(c),
);

// 2. GET /api/v1/agents/:agentId/workspace/files/:workspaceFileId
registerWithOptionalTrailingSlash(
  'get',
  '/:agentId/workspace/files/:workspaceFileId',
  requireAuth,
  requireAgentRead,
  zValidator('param', AgentWorkspaceFileParamSchema),
  zValidator('query', GetWorkspaceFileDetailQuerySchema),
  async (c: Context) => new AgentWorkspaceController().getFileDetail(c),
);

// 3. PUT /api/v1/agents/:agentId/workspace/text
registerWithOptionalTrailingSlash(
  'put',
  '/:agentId/workspace/text',
  requireAuth,
  requireAgentUpdate,
  zValidator('param', AgentWorkspaceParamSchema),
  zValidator('json', PutWorkspaceTextSchema),
  async (c: Context) => new AgentWorkspaceController().putTextFile(c),
);

// 4. POST /api/v1/agents/:agentId/workspace/files
registerWithOptionalTrailingSlash(
  'post',
  '/:agentId/workspace/files',
  requireAuth,
  requireAgentUpdate,
  zValidator('param', AgentWorkspaceParamSchema),
  zValidator('json', RegisterWorkspaceFileSchema),
  async (c: Context) => new AgentWorkspaceController().registerFile(c),
);

// 5. PATCH /api/v1/agents/:agentId/workspace/files/:workspaceFileId
registerWithOptionalTrailingSlash(
  'patch',
  '/:agentId/workspace/files/:workspaceFileId',
  requireAuth,
  requireAgentUpdate,
  zValidator('param', AgentWorkspaceFileParamSchema),
  zValidator('json', UpdateWorkspaceFileMetadataSchema),
  async (c: Context) => new AgentWorkspaceController().updateFileMetadata(c),
);

// 6. DELETE /api/v1/agents/:agentId/workspace/files/:workspaceFileId
registerWithOptionalTrailingSlash(
  'delete',
  '/:agentId/workspace/files/:workspaceFileId',
  requireAuth,
  requireAgentUpdate,
  zValidator('param', AgentWorkspaceFileParamSchema),
  zValidator('query', DeleteWorkspaceFileQuerySchema),
  async (c: Context) => new AgentWorkspaceController().deleteFile(c),
);

// 7. GET /api/v1/agents/:agentId/workspace/files/:workspaceFileId/revisions
registerWithOptionalTrailingSlash(
  'get',
  '/:agentId/workspace/files/:workspaceFileId/revisions',
  requireAuth,
  requireAgentRead,
  zValidator('param', AgentWorkspaceFileParamSchema),
  async (c: Context) => new AgentWorkspaceController().listRevisions(c),
);

// 8. GET /api/v1/agents/:agentId/workspace/files/:workspaceFileId/diff
registerWithOptionalTrailingSlash(
  'get',
  '/:agentId/workspace/files/:workspaceFileId/diff',
  requireAuth,
  requireAgentRead,
  zValidator('param', AgentWorkspaceFileParamSchema),
  zValidator('query', WorkspaceDiffQuerySchema),
  async (c: Context) => new AgentWorkspaceController().diffRevisions(c),
);

// 9. POST /api/v1/agents/:agentId/workspace/files/:workspaceFileId/rollback
registerWithOptionalTrailingSlash(
  'post',
  '/:agentId/workspace/files/:workspaceFileId/rollback',
  requireAuth,
  requireAgentUpdate,
  zValidator('param', AgentWorkspaceFileParamSchema),
  zValidator('json', RollbackWorkspaceFileSchema),
  async (c: Context) => new AgentWorkspaceController().rollbackFile(c),
);

// 10. POST /api/v1/agents/:agentId/workspace/proposals/:proposalId/apply
registerWithOptionalTrailingSlash(
  'post',
  '/:agentId/workspace/proposals/:proposalId/apply',
  requireAuth,
  requireAgentUpdate,
  zValidator('param', AgentWorkspaceProposalParamSchema),
  async (c: Context) => new AgentWorkspaceController().applyProposal(c),
);

// 11. POST /api/v1/agents/:agentId/workspace/proposals/:proposalId/reject
registerWithOptionalTrailingSlash(
  'post',
  '/:agentId/workspace/proposals/:proposalId/reject',
  requireAuth,
  requireAgentUpdate,
  zValidator('param', AgentWorkspaceProposalParamSchema),
  async (c: Context) => new AgentWorkspaceController().rejectProposal(c),
);

export default AgentWorkspaceRoutes;
