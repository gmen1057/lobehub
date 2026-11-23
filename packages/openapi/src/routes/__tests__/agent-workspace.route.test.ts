// @vitest-environment node
/* eslint-disable unicorn/text-encoding-identifier-case */
import { PgDialect } from 'drizzle-orm/pg-core';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WorkspaceError } from '@/server/services/projectWorkspace/paths';

import { ArckepController } from '../../controllers/arckep.controller';
import { AgentService } from '../../services/agent.service';
import { FileUploadService } from '../../services/file.service';
import { KnowledgeBaseService } from '../../services/knowledge-base.service';
import { TopicService } from '../../services/topic.service';
import { CreateAgentRequestSchema, UpdateAgentRequestSchema } from '../../types/agent.type';
import routes from '../index';

const mocks = vi.hoisted(() => ({
  agentAssignedKnowledge: vi.fn(),
  agentConfigById: vi.fn(),
  agentDelete: vi.fn(),
  cleanupAgentWorkspaceBeforeDelete: vi.fn(),
  coreDeleteFile: vi.fn(),
  createAgentKnowledgeBase: vi.fn(),
  deleteAgentKnowledgeBase: vi.fn(),
  fileModelDelete: vi.fn(),
  findWorkspaceFileReferences: vi.fn(),
  hasAnyPermission: vi.fn(async () => true),
  kbModelDelete: vi.fn(),
  kbModelUpdate: vi.fn(),
  resolveAgentSystemRoleFromWorkspace: vi.fn(),
  store: {
    applyProposal: vi.fn(),
    deleteWorkspaceFile: vi.fn(),
    diffRevisions: vi.fn(),
    getFileDetail: vi.fn(),
    getWorkspaceOverview: vi.fn(),
    listRevisions: vi.fn(),
    putUserTextFile: vi.fn(),
    registerUploadedFile: vi.fn(),
    rejectProposal: vi.fn(),
    rollbackFileRevision: vi.fn(),
    syncAgentInstructionFromAgentApi: vi.fn(),
    updateFileMetadata: vi.fn(),
  },
}));

vi.mock('@/const/rbac', () => ({ ALL_SCOPE: 'all', RBAC_PERMISSIONS: {} }));
vi.mock('@/utils/rbac', () => ({
  getAllScopePermissions: (action: string) => [`${action.toLowerCase()}:all`],
  getScopePermissions: (action: string) => [`${action.toLowerCase()}:owner`],
}));
vi.mock('@/database/models/rbac', () => ({
  RbacModel: class {
    hasAllPermissions = mocks.hasAnyPermission;
    hasAnyPermission = mocks.hasAnyPermission;
    hasPermission = mocks.hasAnyPermission;
  },
}));
vi.mock('@/server/services/file', () => ({
  FileService: class {
    deleteFile = mocks.coreDeleteFile;
    getFullFileUrl = async (url: string) => `https://s3.example.test/${url}`;
  },
}));
vi.mock('@/database/models/file', () => ({
  FileModel: class {
    checkHash = vi.fn(async () => ({ isExist: false }));
    create = vi.fn(async (rec: any) => ({ id: 'file_created', ...rec }));
    delete = mocks.fileModelDelete;
  },
}));
vi.mock('@/database/models/document', () => ({
  DocumentModel: class {},
}));
vi.mock('@/database/models/chunk', () => ({
  ChunkModel: class {
    countByFileId = vi.fn(async () => 0);
    countByFileIds = vi.fn(async () => []);
  },
}));
vi.mock('@/database/models/asyncTask', () => ({
  AsyncTaskModel: class {
    findById = vi.fn(async () => null);
    findByIds = vi.fn(async () => []);
  },
}));
vi.mock('@/database/models/knowledgeBase', () => ({
  KnowledgeBaseModel: class {
    delete = mocks.kbModelDelete;
    findById = vi.fn(async (id: string) => ({ id, name: 'KB', type: null, userId: 'user_1' }));
    update = mocks.kbModelUpdate;
  },
}));
vi.mock('@/server/modules/S3', () => ({
  FileS3: class {
    createPreSignedUrlForPreview = vi.fn(async () => 'https://s3.example.test/signed');
    uploadBuffer = vi.fn(async () => undefined);
  },
}));
vi.mock('@/server/services/document', () => ({
  DocumentService: class {},
}));
vi.mock('@/database/models/agent', () => ({
  AgentModel: class {
    createAgentKnowledgeBase = mocks.createAgentKnowledgeBase;
    delete = mocks.agentDelete;
    deleteAgentKnowledgeBase = mocks.deleteAgentKnowledgeBase;
    getAgentAssignedKnowledge = mocks.agentAssignedKnowledge;
    getAgentConfigById = mocks.agentConfigById;
  },
}));
vi.mock('@/server/services/projectWorkspace', async () => {
  const pathsMod = await import('@/server/services/projectWorkspace/paths');
  const validatorMod = await import('@/server/services/projectWorkspace/validator');
  return {
    ...pathsMod,
    ProjectWorkspaceStore: class {
      applyProposal = mocks.store.applyProposal;
      deleteWorkspaceFile = mocks.store.deleteWorkspaceFile;
      diffRevisions = mocks.store.diffRevisions;
      getFileDetail = mocks.store.getFileDetail;
      getWorkspaceOverview = mocks.store.getWorkspaceOverview;
      listRevisions = mocks.store.listRevisions;
      putUserTextFile = mocks.store.putUserTextFile;
      registerUploadedFile = mocks.store.registerUploadedFile;
      rejectProposal = mocks.store.rejectProposal;
      rollbackFileRevision = mocks.store.rollbackFileRevision;
      syncAgentInstructionFromAgentApi = mocks.store.syncAgentInstructionFromAgentApi;
      updateFileMetadata = mocks.store.updateFileMetadata;
    },
    cleanupAgentWorkspaceBeforeDelete: mocks.cleanupAgentWorkspaceBeforeDelete,
    findWorkspaceFileReferences: mocks.findWorkspaceFileReferences,
    isWorkspaceEnabled: validatorMod.isWorkspaceEnabled,
    resolveAgentSystemRoleFromWorkspace: mocks.resolveAgentSystemRoleFromWorkspace,
  };
});

const dbHolder = vi.hoisted(() => ({
  currentDb: {} as any,
}));

vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: async () => dbHolder.currentDb,
}));

const sampleBudget = {
  activeBytes: 128,
  activeFilesCount: 1,
  hardMaxChars: 60_000,
  hardMaxTokens: 24_000,
  maxActiveBytes: 262_144_000,
  maxFilesCount: 200,
  pinnedChars: 42,
  pinnedTokens: 16,
  softWarnTokens: 4000,
};

const sampleFile = {
  agentId: 'agt_1',
  byteSize: 42,
  charCount: 42,
  createdAt: '2026-11-23T10:00:00.000Z',
  createdBy: 'user' as const,
  currentFileId: 'file_1',
  currentRevision: 1,
  dataGuardStatus: 'unmasked' as const,
  encoding: 'utf-8' as const,
  estimatedTokens: 16,
  id: 'wsf_1',
  indexingError: null,
  indexingStatus: 'none' as const,
  isProtected: true,
  kind: 'text' as const,
  lineCount: 2,
  lineEnding: 'LF' as const,
  loadMode: 'always' as const,
  loadPriority: 0,
  mimeType: 'text/markdown',
  path: 'AGENTS.md',
  ragEnabled: false,
  updatedAt: '2026-11-23T10:00:00.000Z',
  updatedBy: 'user' as const,
  userSummary: null,
};

const buildOpenApiApp = (authenticatedUserId: string | null = 'user_1') => {
  const app = new Hono().basePath('/api/v1');
  app.use('*', async (c: any, next) => {
    c.set('userId', authenticatedUserId);
    c.set('authType', authenticatedUserId ? 'arckep-service' : null);
    await next();
  });
  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: err.message }, err.status);
    }
    return c.json({ error: err.message }, 500);
  });
  Object.entries(routes).forEach(([key, value]) => app.route(`/${key}`, value));
  return app;
};

describe('OpenAPI Agent Workspace Routes & Protective Invariants (1A-3)', () => {
  const prevWorkspaceEnv = process.env.ARCKEP_WORKSPACE_ENABLED;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ARCKEP_WORKSPACE_ENABLED = '1';
    mocks.hasAnyPermission.mockResolvedValue(true);
    dbHolder.currentDb = {};
  });

  afterEach(() => {
    if (prevWorkspaceEnv === undefined) {
      delete process.env.ARCKEP_WORKSPACE_ENABLED;
    } else {
      process.env.ARCKEP_WORKSPACE_ENABLED = prevWorkspaceEnv;
    }
    vi.restoreAllMocks();
  });

  describe('1. Route mounting & trailing slash support (/api/v1/agents/:agentId/workspace/...)', () => {
    it('serves GET /:agentId/workspace both without and with trailing slash without colliding with /:id', async () => {
      const overviewPayload = {
        budget: sampleBudget,
        files: [sampleFile],
        instructionFile: sampleFile,
        pendingProposals: [],
        workspaceEnabled: true,
      };
      mocks.store.getWorkspaceOverview.mockResolvedValue(overviewPayload);

      const app = buildOpenApiApp();

      for (const url of ['/api/v1/agents/agt_1/workspace', '/api/v1/agents/agt_1/workspace/']) {
        const res = await app.request(url);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toMatchObject({
          data: overviewPayload,
          success: true,
        });
      }

      expect(mocks.store.getWorkspaceOverview).toHaveBeenCalledTimes(2);
      expect(mocks.store.getWorkspaceOverview).toHaveBeenCalledWith('agt_1');
      expect(mocks.agentConfigById).not.toHaveBeenCalled();
    });

    it('enforces auth (401) and RBAC permissions (403)', async () => {
      const unauthApp = buildOpenApiApp(null);
      const unauthRes = await unauthApp.request('/api/v1/agents/agt_1/workspace');
      expect(unauthRes.status).toBe(401);

      mocks.hasAnyPermission.mockResolvedValue(false);
      const forbiddenApp = buildOpenApiApp('user_1');
      const forbiddenRes = await forbiddenApp.request('/api/v1/agents/agt_1/workspace');
      expect(forbiddenRes.status).toBe(403);
    });

    it('handles GET /:agentId/workspace/files/:workspaceFileId with revision and includeContent flags', async () => {
      mocks.store.getFileDetail.mockResolvedValue({
        content: null,
        downloadUrl: 'https://s3.example.test/att',
        file: sampleFile,
        revision: 2,
      });

      const app = buildOpenApiApp();
      const res = await app.request(
        '/api/v1/agents/agt_1/workspace/files/wsf_1/?revision=2&includeContent=0',
      );

      expect(res.status).toBe(200);
      expect(mocks.store.getFileDetail).toHaveBeenCalledWith('agt_1', 'wsf_1', {
        includeContent: false,
        revision: 2,
      });
      const json = await res.json();
      expect(json.data).toEqual({
        content: null,
        downloadUrl: 'https://s3.example.test/att',
        file: sampleFile,
        revision: 2,
      });
    });

    it('handles PUT /:agentId/workspace/text and POST /:agentId/workspace/files and PATCH /:agentId/workspace/files/:workspaceFileId', async () => {
      const app = buildOpenApiApp();

      mocks.store.putUserTextFile.mockResolvedValue({
        budget: sampleBudget,
        deleted: false,
        file: sampleFile,
      });

      const putRes = await app.request('/api/v1/agents/agt_1/workspace/text/', {
        body: JSON.stringify({
          baseRevision: 1,
          changeNote: 'Update rules',
          content: '# Rules',
          encoding: 'utf-8',
          isProtected: true,
          lineEnding: 'LF',
          loadMode: 'always',
          path: 'AGENTS.md',
          userSummary: 'Main instructions',
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'PUT',
      });
      expect(putRes.status).toBe(200);
      expect((await putRes.json()).data).toEqual({
        budget: sampleBudget,
        deleted: false,
        file: sampleFile,
      });

      mocks.store.registerUploadedFile.mockResolvedValue({
        budget: sampleBudget,
        deleted: false,
        file: { ...sampleFile, kind: 'document', path: 'docs/spec.pdf', ragEnabled: true },
      });

      const postRes = await app.request('/api/v1/agents/agt_1/workspace/files', {
        body: JSON.stringify({
          enableRag: true,
          fileId: 'file_pdf_1',
          kind: 'document',
          mimeType: 'application/pdf',
          path: 'docs/spec.pdf',
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      });
      expect(postRes.status).toBe(200);
      expect(mocks.store.registerUploadedFile).toHaveBeenCalledWith(
        'agt_1',
        expect.objectContaining({
          enableRag: true,
          fileId: 'file_pdf_1',
          kind: 'document',
          mimeType: 'application/pdf',
          path: 'docs/spec.pdf',
        }),
      );

      mocks.store.updateFileMetadata.mockResolvedValue({
        budget: sampleBudget,
        deleted: false,
        file: { ...sampleFile, userSummary: null },
      });

      const patchRes = await app.request('/api/v1/agents/agt_1/workspace/files/wsf_1', {
        body: JSON.stringify({
          baseRevision: 1,
          loadMode: 'always',
          userSummary: null,
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'PATCH',
      });
      expect(patchRes.status).toBe(200);
      expect(mocks.store.updateFileMetadata).toHaveBeenCalledWith('agt_1', 'wsf_1', {
        actor: 'user',
        baseRevision: 1,
        isProtected: undefined,
        loadMode: 'always',
        path: undefined,
        ragEnabled: undefined,
        userSummary: null,
      });
    });

    it('handles DELETE /:agentId/workspace/files/:workspaceFileId via query ?baseRevision and via JSON body fallback', async () => {
      const app = buildOpenApiApp();
      mocks.store.deleteWorkspaceFile.mockResolvedValue({
        budget: sampleBudget,
        deleted: true,
        outcome: 'deleted',
        path: 'src/calc.py',
        revision: 3,
        workspaceFileId: 'wsf_1',
      });

      const delQueryRes = await app.request(
        '/api/v1/agents/agt_1/workspace/files/wsf_1?baseRevision=3',
        { method: 'DELETE' },
      );
      expect(delQueryRes.status).toBe(200);
      expect((await delQueryRes.json()).data).toEqual({
        budget: sampleBudget,
        deleted: true,
        revision: 3,
      });

      const delBodyRes = await app.request('/api/v1/agents/agt_1/workspace/files/wsf_1/', {
        body: JSON.stringify({ baseRevision: 4 }),
        headers: { 'Content-Type': 'application/json' },
        method: 'DELETE',
      });
      expect(delBodyRes.status).toBe(200);
      expect(mocks.store.deleteWorkspaceFile).toHaveBeenLastCalledWith(
        'agt_1',
        { workspaceFileId: 'wsf_1' },
        { actor: 'user', baseRevision: 4 },
      );
    });

    it('handles revisions, diff, rollback, and idempotent proposal apply/reject (with or without empty body)', async () => {
      const app = buildOpenApiApp();

      const revItem = {
        authorType: 'user',
        byteSize: 42,
        changeNote: 'Init',
        createdAt: '2026-11-23T10:00:00.000Z',
        diffStats: { addedLines: 2, removedLines: 0 },
        id: 'rev_1',
        lineCount: 2,
        messageId: null,
        revision: 1,
        topicId: null,
      };
      mocks.store.listRevisions.mockResolvedValue({ revisions: [revItem] });

      const revRes = await app.request('/api/v1/agents/agt_1/workspace/files/wsf_1/revisions');
      expect(revRes.status).toBe(200);
      expect((await revRes.json()).data).toEqual({ revisions: [revItem] });

      mocks.store.diffRevisions.mockResolvedValue({
        addedLines: 3,
        fromRevision: 1,
        patch: '@@ -1 +1,3 @@',
        path: 'AGENTS.md',
        removedLines: 1,
        toRevision: 2,
      });

      const diffRes = await app.request(
        '/api/v1/agents/agt_1/workspace/files/wsf_1/diff?fromRevision=1&toRevision=2',
      );
      expect(diffRes.status).toBe(200);
      expect((await diffRes.json()).data).toEqual({
        addedLines: 3,
        fromRevision: 1,
        patch: '@@ -1 +1,3 @@',
        path: 'AGENTS.md',
        removedLines: 1,
        toRevision: 2,
      });

      mocks.store.rollbackFileRevision.mockResolvedValue({
        budget: sampleBudget,
        file: { ...sampleFile, currentRevision: 3, updatedBy: 'rollback' },
      });

      const rbRes = await app.request('/api/v1/agents/agt_1/workspace/files/wsf_1/rollback', {
        body: JSON.stringify({ baseRevision: 2, targetRevision: 1 }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      });
      expect(rbRes.status).toBe(200);
      expect(mocks.store.rollbackFileRevision).toHaveBeenCalledWith('agt_1', 'wsf_1', {
        baseRevision: 2,
        targetRevision: 1,
      });

      const sampleProposal = {
        addedLines: 4,
        agentId: 'agt_1',
        baseRevision: 1,
        createdAt: '2026-11-23T10:00:00.000Z',
        diffPreview: '@@ -1 +1,4 @@',
        diffStats: { addedLines: 4, removedLines: 0 },
        id: 'prop_1',
        messageId: null,
        proposalType: 'edit' as const,
        proposedFileId: 'file_prop_1',
        reason: 'Add date format rule',
        removedLines: 0,
        resolvedAt: '2026-11-23T10:01:00.000Z',
        status: 'applied' as const,
        targetPath: 'AGENTS.md',
        topicId: null,
        workspaceFileId: 'wsf_1',
      };

      mocks.store.applyProposal.mockResolvedValue({
        alreadyApplied: true,
        budget: sampleBudget,
        file: sampleFile,
        proposal: sampleProposal,
      });

      // Apply with NO body at all
      const applyRes = await app.request('/api/v1/agents/agt_1/workspace/proposals/prop_1/apply/', {
        method: 'POST',
      });
      expect(applyRes.status).toBe(200);
      expect((await applyRes.json()).data).toEqual({
        alreadyApplied: true,
        budget: sampleBudget,
        file: sampleFile,
        proposal: sampleProposal,
      });

      mocks.store.rejectProposal.mockResolvedValue({
        proposal: { ...sampleProposal, status: 'rejected' },
      });

      // Reject with {} JSON body
      const rejectRes = await app.request(
        '/api/v1/agents/agt_1/workspace/proposals/prop_1/reject',
        {
          body: JSON.stringify({}),
          headers: { 'Content-Type': 'application/json' },
          method: 'POST',
        },
      );
      expect(rejectRes.status).toBe(200);
      expect((await rejectRes.json()).data).toEqual({
        proposal: { ...sampleProposal, status: 'rejected' },
      });
    });

    it('maps WorkspaceError to exact HTTP status, code, details, and top-level conflict/budget fields', async () => {
      const app = buildOpenApiApp();

      mocks.store.putUserTextFile.mockRejectedValueOnce(
        new WorkspaceError('PINNED_BUDGET_EXCEEDED', 'Pinned budget exceeded', 422, {
          hardMaxChars: 60_000,
          hardMaxTokens: 24_000,
          pinnedChars: 61_000,
          pinnedTokens: 25_000,
        }),
      );

      const budgetRes = await app.request('/api/v1/agents/agt_1/workspace/text', {
        body: JSON.stringify({ content: 'too big', path: 'AGENTS.md' }),
        headers: { 'Content-Type': 'application/json' },
        method: 'PUT',
      });
      expect(budgetRes.status).toBe(422);
      const budgetJson = await budgetRes.json();
      expect(budgetJson).toMatchObject({
        code: 'PINNED_BUDGET_EXCEEDED',
        details: {
          hardMaxChars: 60_000,
          hardMaxTokens: 24_000,
          pinnedChars: 61_000,
          pinnedTokens: 25_000,
        },
        error: 'Pinned budget exceeded',
        hardMaxChars: 60_000,
        pinnedChars: 61_000,
        success: false,
      });

      mocks.store.putUserTextFile.mockRejectedValueOnce(
        new WorkspaceError('REVISION_CONFLICT', 'Expected v1, actual v3', 409, {
          currentRevision: 3,
          updatedAt: '2026-11-23T10:05:00.000Z',
          updatedBy: 'agent',
        }),
      );

      const conflictRes = await app.request('/api/v1/agents/agt_1/workspace/text', {
        body: JSON.stringify({ baseRevision: 1, content: 'edit', path: 'src/a.py' }),
        headers: { 'Content-Type': 'application/json' },
        method: 'PUT',
      });
      expect(conflictRes.status).toBe(409);
      const conflictJson = await conflictRes.json();
      expect(conflictJson).toMatchObject({
        code: 'REVISION_CONFLICT',
        currentRevision: 3,
        error: 'Expected v1, actual v3',
        success: false,
        updatedAt: '2026-11-23T10:05:00.000Z',
        updatedBy: 'agent',
      });
    });
  });

  describe('2. Agent Schema & AgentService invariants (R2-2, R2-4, B-1)', () => {
    it('enforces .max(60_000) on systemRole in CreateAgentRequestSchema and UpdateAgentRequestSchema (R2-4)', () => {
      expect(
        CreateAgentRequestSchema.safeParse({
          systemRole: 'a'.repeat(60_000),
          title: 'Valid',
        }).success,
      ).toBe(true);

      expect(
        CreateAgentRequestSchema.safeParse({
          systemRole: 'a'.repeat(60_001),
          title: 'Too long',
        }).success,
      ).toBe(false);

      expect(
        UpdateAgentRequestSchema.safeParse({
          systemRole: 'a'.repeat(60_001),
        }).success,
      ).toBe(false);
    });

    it('createAgent stores systemRole: null in DB and syncs AGENTS.md when workspace is enabled, and preserves legacy DB write when disabled', async () => {
      const insertedValues: any[] = [];
      const mockDb: any = {
        delete: () => ({ where: async () => undefined }),
        transaction: async (cb: any) =>
          cb({
            insert: () => ({
              values: (val: any) => {
                insertedValues.push(val);
                return {
                  returning: async () => [{ ...val, id: 'agt_new', slug: 'slug1' }],
                };
              },
            }),
          }),
      };

      process.env.ARCKEP_WORKSPACE_ENABLED = '1';
      mocks.store.syncAgentInstructionFromAgentApi.mockResolvedValue({
        changed: true,
        file: sampleFile,
      });

      const svc = new AgentService(mockDb, 'user_1');
      const created = await svc.createAgent({
        systemRole: 'Ты главный бухгалтер',
        title: 'Бухгалтерия',
      });

      expect(insertedValues[0].systemRole).toBeNull();
      expect(mocks.store.syncAgentInstructionFromAgentApi).toHaveBeenCalledWith(
        'agt_new',
        'Ты главный бухгалтер',
        { isCreate: true },
      );
      expect(created.systemRole).toBe('Ты главный бухгалтер');

      // Flag disabled fallback
      process.env.ARCKEP_WORKSPACE_ENABLED = '0';
      mocks.store.syncAgentInstructionFromAgentApi.mockClear();
      const createdLegacy = await svc.createAgent({
        systemRole: 'Legacy role',
        title: 'Legacy',
      });
      expect(insertedValues[1].systemRole).toBe('Legacy role');
      expect(mocks.store.syncAgentInstructionFromAgentApi).not.toHaveBeenCalled();
      expect(createdLegacy.systemRole).toBe('Legacy role');
    });

    it('updateAgent unconditionally rejects systemRole mutations on inbox/virtual agents (R2-4) and syncs AGENTS.md for normal agents', async () => {
      let existingAgentRow: any = {
        id: 'agt_inbox',
        slug: 'inbox',
        systemRole: null,
        title: 'Inbox',
        userId: 'user_1',
        virtual: true,
      };
      const setPayloads: any[] = [];

      const mockDb: any = {
        query: {
          agents: {
            findFirst: async () => existingAgentRow,
          },
        },
        transaction: async (cb: any) =>
          cb({
            query: {
              agents: {
                findFirst: async () => existingAgentRow,
              },
            },
            update: () => ({
              set: (data: any) => {
                setPayloads.push(data);
                return {
                  where: () => ({
                    returning: async () => [{ ...existingAgentRow, ...data }],
                  }),
                };
              },
            }),
          }),
      };

      const svc = new AgentService(mockDb, 'user_1');
      await expect(
        svc.updateAgent({ id: 'agt_inbox', systemRole: 'Hack inbox', title: 'Inbox' }),
      ).rejects.toThrow(/inbox or virtual/i);
      expect(setPayloads).toHaveLength(0);

      // Normal project agent with workspace enabled
      existingAgentRow = {
        id: 'agt_proj',
        slug: 'proj',
        systemRole: 'old_db_role',
        title: 'Project',
        userId: 'user_1',
        virtual: false,
      };
      process.env.ARCKEP_WORKSPACE_ENABLED = '1';
      mocks.store.syncAgentInstructionFromAgentApi.mockResolvedValue({
        changed: true,
        file: null,
      });

      const cleared = await svc.updateAgent({ id: 'agt_proj', systemRole: '', title: 'Project' });
      expect(setPayloads[0].systemRole).toBeNull();
      expect(mocks.store.syncAgentInstructionFromAgentApi).toHaveBeenCalledWith('agt_proj', '');
      expect(cleared.systemRole).toBeNull();
    });

    it('getAgentById resolves systemRole via resolveAgentSystemRoleFromWorkspace so deleted AGENTS.md never resurrects DB system_role (R2-2)', async () => {
      const mockDb: any = {
        query: {
          agents: {
            findFirst: async () => ({ id: 'agt_1', userId: 'user_1' }),
          },
        },
      };

      mocks.agentConfigById.mockResolvedValue({
        id: 'agt_1',
        knowledgeBases: [
          { id: 'kb_ws', name: 'Managed', type: 'project_workspace' },
          { id: 'kb_ext', name: 'External', type: null },
        ],
        slug: 'proj-1',
        systemRole: 'ZOMBIE_LEGACY_SYSTEM_ROLE',
        title: 'Project 1',
        virtual: false,
      });
      mocks.resolveAgentSystemRoleFromWorkspace.mockResolvedValue({
        hasEverHadAgentsMd: true,
        instructionFile: null,
        systemRole: null,
      });

      const svc = new AgentService(mockDb, 'user_1');
      const detail = await svc.getAgentById('agt_1');

      expect(mocks.resolveAgentSystemRoleFromWorkspace).toHaveBeenCalledWith(
        mockDb,
        'user_1',
        'agt_1',
        'ZOMBIE_LEGACY_SYSTEM_ROLE',
      );
      expect(detail?.systemRole).toBeNull();
      expect((detail as any)?.knowledgeBases).toEqual([
        { id: 'kb_ext', name: 'External', type: null },
      ]);
    });

    it('deleteAgent calls cleanupAgentWorkspaceBeforeDelete strictly BEFORE agentModel.delete even when flag is 0 (B-1)', async () => {
      process.env.ARCKEP_WORKSPACE_ENABLED = '0';
      const callOrder: string[] = [];
      mocks.cleanupAgentWorkspaceBeforeDelete.mockImplementation(async () => {
        callOrder.push('cleanupWorkspace');
        return { deletedFileIds: ['file_1'], deletedS3Keys: ['s3_1'] };
      });
      mocks.agentDelete.mockImplementation(async () => {
        callOrder.push('deleteAgentRow');
      });

      const mockDb: any = {
        query: {
          agents: {
            findFirst: async () => ({ id: 'agt_del', userId: 'user_1' }),
          },
        },
      };

      const svc = new AgentService(mockDb, 'user_1');
      await svc.deleteAgent({ agentId: 'agt_del' });

      expect(callOrder).toEqual(['cleanupWorkspace', 'deleteAgentRow']);
      expect(mocks.cleanupAgentWorkspaceBeforeDelete).toHaveBeenCalledWith(
        mockDb,
        'user_1',
        'agt_del',
      );
    });
  });

  describe('3. FileUploadService, KnowledgeBaseService & ArckepController guards (B-1)', () => {
    it('FileUploadService.deleteFile returns ConflictError (409) BEFORE touching S3 when referenced in workspace tables', async () => {
      const mockDb: any = {
        query: {
          files: {
            findFirst: async () => ({
              fileType: 'text/markdown',
              id: 'file_ws',
              name: 'AGENTS.md',
              size: 10,
              url: 'files/user_1/project-workspace/agt_1/wsf_1/r1.bin',
              userId: 'user_1',
            }),
          },
        },
        select: () => ({
          from: () => ({
            where: () => ({}),
          }),
        }),
      };

      mocks.findWorkspaceFileReferences.mockResolvedValue({
        referenced: true,
        sources: ['project_file_revisions'],
      });

      const fileSvc = new FileUploadService(mockDb, 'user_1');
      await expect(fileSvc.deleteFile('file_ws')).rejects.toMatchObject({
        name: 'ConflictError',
      });
      expect(mocks.coreDeleteFile).not.toHaveBeenCalled();
      expect(mocks.fileModelDelete).not.toHaveBeenCalled();
    });

    it('FileUploadService blocks direct upload, add, remove, move, and updateFile against project_workspace knowledge bases', async () => {
      const mockDb: any = {
        query: {
          files: {
            findFirst: async () => ({
              fileType: 'application/pdf',
              id: 'file_1',
              name: 'doc.pdf',
              size: 100,
              url: 'uploads/doc.pdf',
              userId: 'user_1',
            }),
          },
          knowledgeBases: {
            findFirst: async ({ where }: any) => ({
              id: 'kb_managed',
              name: 'Managed KB',
              type: 'project_workspace',
              userId: 'user_1',
              where,
            }),
          },
        },
        select: () => ({
          from: () => ({
            where: () => ({}),
          }),
        }),
      };

      mocks.findWorkspaceFileReferences.mockResolvedValue({ referenced: false, sources: [] });

      const fileSvc = new FileUploadService(mockDb, 'user_1');
      const dummyFile = new File(['hello'], 'test.txt', { type: 'text/plain' });

      await expect(
        fileSvc.uploadFile(dummyFile, { knowledgeBaseId: 'kb_managed' }),
      ).rejects.toMatchObject({ name: 'ConflictError' });

      await expect(
        fileSvc.addFilesToKnowledgeBase('kb_managed', { fileIds: ['file_1'] }),
      ).rejects.toMatchObject({ name: 'ConflictError' });

      await expect(
        fileSvc.removeFilesFromKnowledgeBase('kb_managed', { fileIds: ['file_1'] }),
      ).rejects.toMatchObject({ name: 'ConflictError' });

      await expect(
        fileSvc.moveFilesBetweenKnowledgeBases('kb_managed', {
          fileIds: ['file_1'],
          targetKnowledgeBaseId: 'kb_other',
        }),
      ).rejects.toMatchObject({ name: 'ConflictError' });

      await expect(
        fileSvc.updateFile('file_1', { knowledgeBaseId: 'kb_managed' }),
      ).rejects.toMatchObject({ name: 'ConflictError' });
    });

    it('KnowledgeBaseService hides project_workspace from getKnowledgeBaseList and rejects update/delete with 409 ConflictError', async () => {
      let capturedWhere: any;
      const mockDb: any = {
        query: {
          knowledgeBases: {
            findFirst: async () => ({
              id: 'kb_managed',
              name: 'Managed',
              type: 'project_workspace',
              userId: 'user_1',
            }),
            findMany: async (opts: any) => {
              capturedWhere = opts.where;
              return [];
            },
          },
        },
        select: () => ({
          from: () => ({
            where: async () => [{ count: 0 }],
          }),
        }),
      };

      const kbSvc = new KnowledgeBaseService(mockDb, 'user_1');
      await kbSvc.getKnowledgeBaseList({});

      const dialect = new PgDialect();
      const rendered = dialect.sqlToQuery(capturedWhere);
      expect(rendered.sql).toContain('is null');
      expect(rendered.sql).toContain('<>');
      expect(rendered.params).toContain('project_workspace');

      await expect(kbSvc.updateKnowledgeBase('kb_managed', { name: 'New' })).rejects.toMatchObject({
        name: 'ConflictError',
      });
      await expect(kbSvc.deleteKnowledgeBase('kb_managed')).rejects.toMatchObject({
        name: 'ConflictError',
      });
      expect(mocks.kbModelUpdate).not.toHaveBeenCalled();
      expect(mocks.kbModelDelete).not.toHaveBeenCalled();
    });

    it('ArckepController filters managed KB in getAgentKnowledgeBases when enabled and rejects manual link/unlink with 409', async () => {
      let kbRow: any = { id: 'kb_managed', type: 'project_workspace' };
      dbHolder.currentDb = {
        select: () => ({
          from: (table: any) => ({
            where: () => ({
              limit: async () => {
                // First select in linkAgentKnowledgeBase is agents, second is knowledgeBases;
                // in unlinkAgentKnowledgeBase the only select is knowledgeBases.
                if (table && 'avatar' in table && 'slug' in table) {
                  return [{ id: 'agt_1' }];
                }
                return kbRow ? [kbRow] : [];
              },
            }),
          }),
        }),
      };

      mocks.agentAssignedKnowledge.mockResolvedValue({
        files: [],
        knowledgeBases: [
          { enabled: true, id: 'kb_managed', name: 'Managed', type: 'project_workspace' },
          { enabled: true, id: 'kb_ext', name: 'External', type: null },
        ],
      });

      const app = new Hono();
      app.use('*', async (c: any, next) => {
        c.set('userId', 'user_1');
        await next();
      });
      app.get('/agents/:id/knowledge-bases', (c) =>
        new ArckepController().getAgentKnowledgeBases(c),
      );
      app.post('/agents/:id/knowledge-bases', (c) =>
        new ArckepController().linkAgentKnowledgeBase(c),
      );
      app.delete('/agents/:id/knowledge-bases/:kbId', (c) =>
        new ArckepController().unlinkAgentKnowledgeBase(c),
      );

      // Flag ON -> hides project_workspace KB and blocks manual link/unlink with 409
      process.env.ARCKEP_WORKSPACE_ENABLED = '1';
      const getOnRes = await app.request('/agents/agt_1/knowledge-bases');
      expect(getOnRes.status).toBe(200);
      expect((await getOnRes.json()).data.knowledgeBases).toEqual([
        { enabled: true, id: 'kb_ext', name: 'External', type: null },
      ]);

      // Manual link (Flag ON) -> 409
      const linkRes = await app.request('/agents/agt_1/knowledge-bases', {
        body: JSON.stringify({ knowledgeBaseId: 'kb_managed' }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      });
      expect(linkRes.status).toBe(409);
      expect(mocks.createAgentKnowledgeBase).not.toHaveBeenCalled();

      // Manual unlink (Flag ON) -> 409
      const unlinkRes = await app.request('/agents/agt_1/knowledge-bases/kb_managed', {
        method: 'DELETE',
      });
      expect(unlinkRes.status).toBe(409);
      expect(mocks.deleteAgentKnowledgeBase).not.toHaveBeenCalled();

      // Flag OFF -> preserves legacy list
      process.env.ARCKEP_WORKSPACE_ENABLED = '0';
      const getOffRes = await app.request('/agents/agt_1/knowledge-bases');
      expect((await getOffRes.json()).data.knowledgeBases).toHaveLength(2);

      // External KB unlink -> 200
      process.env.ARCKEP_WORKSPACE_ENABLED = '1';
      kbRow = { id: 'kb_ext', type: null };
      const unlinkExtRes = await app.request('/agents/agt_1/knowledge-bases/kb_ext', {
        method: 'DELETE',
      });
      expect(unlinkExtRes.status).toBe(200);
      expect(mocks.deleteAgentKnowledgeBase).toHaveBeenCalledWith('agt_1', 'kb_ext');
    });

    it('Emergency rollback mode (ARCKEP_WORKSPACE_ENABLED=0, M-6): GET /workspace returns workspaceEnabled:false, all mutating Workspace routes return 409 WORKSPACE_DISABLED, deleteFile stays 409 before S3, and legacy KB operations succeed without 409', async () => {
      process.env.ARCKEP_WORKSPACE_ENABLED = '0';

      mocks.store.getWorkspaceOverview.mockResolvedValue({
        budget: sampleBudget,
        files: [],
        instructionFile: null,
        pendingProposals: [],
        workspaceEnabled: false,
      });

      const app = buildOpenApiApp();

      // 1. GET /workspace continues returning 200 with workspaceEnabled: false
      const getRes = await app.request('/api/v1/agents/agt_1/workspace');
      expect(getRes.status).toBe(200);
      expect((await getRes.json()).data.workspaceEnabled).toBe(false);

      // 2. All mutating workspace routes reject with 409 WORKSPACE_DISABLED and do not touch store/DB
      const mutatingCalls: Array<[string, string, unknown?]> = [
        ['PUT', '/api/v1/agents/agt_1/workspace/text', { content: 'x', path: 'AGENTS.md' }],
        [
          'POST',
          '/api/v1/agents/agt_1/workspace/files',
          { fileId: 'f1', kind: 'text', mimeType: 'text/plain', path: 'a.txt' },
        ],
        ['PATCH', '/api/v1/agents/agt_1/workspace/files/wsf_1', { loadMode: 'always' }],
        ['DELETE', '/api/v1/agents/agt_1/workspace/files/wsf_1?baseRevision=1'],
        ['POST', '/api/v1/agents/agt_1/workspace/files/wsf_1/rollback', { targetRevision: 1 }],
        ['POST', '/api/v1/agents/agt_1/workspace/proposals/prop_1/apply'],
        ['POST', '/api/v1/agents/agt_1/workspace/proposals/prop_1/reject'],
      ];

      for (const [method, url, payload] of mutatingCalls) {
        const res = await app.request(url, {
          body: payload === undefined ? undefined : JSON.stringify(payload),
          headers: payload === undefined ? undefined : { 'Content-Type': 'application/json' },
          method,
        });
        expect(res.status).toBe(409);
        const json = await res.json();
        expect(json).toMatchObject({
          code: 'WORKSPACE_DISABLED',
          error: 'Project workspace is currently disabled',
          success: false,
        });
      }

      expect(mocks.store.putUserTextFile).not.toHaveBeenCalled();
      expect(mocks.store.registerUploadedFile).not.toHaveBeenCalled();
      expect(mocks.store.updateFileMetadata).not.toHaveBeenCalled();
      expect(mocks.store.deleteWorkspaceFile).not.toHaveBeenCalled();
      expect(mocks.store.rollbackFileRevision).not.toHaveBeenCalled();
      expect(mocks.store.applyProposal).not.toHaveBeenCalled();
      expect(mocks.store.rejectProposal).not.toHaveBeenCalled();

      // 3. deleteFile on a referenced workspace file STILL unconditionally returns 409 Conflict before S3!
      const fileRefDb: any = {
        insert: () => ({
          values: () => ({
            onConflictDoNothing: async () => undefined,
          }),
        }),
        query: {
          files: {
            findFirst: async () => ({
              fileType: 'text/markdown',
              id: 'file_ws',
              name: 'AGENTS.md',
              size: 10,
              url: 'files/user_1/project-workspace/agt_1/wsf_1/r1.bin',
              userId: 'user_1',
            }),
            findMany: async () => [{ id: 'file_1' }],
          },
          knowledgeBases: {
            findFirst: async () => ({
              id: 'kb_managed',
              name: 'Managed',
              type: 'project_workspace',
              userId: 'user_1',
            }),
            findMany: async () => [
              { id: 'kb_managed', name: 'Managed', type: 'project_workspace', userId: 'user_1' },
            ],
          },
        },
        select: () => ({
          from: () => ({
            where: async () => [{ count: 1 }],
          }),
        }),
      };

      mocks.findWorkspaceFileReferences.mockResolvedValue({
        referenced: true,
        sources: ['project_workspace_files'],
      });
      const fileSvc = new FileUploadService(fileRefDb, 'user_1');
      await expect(fileSvc.deleteFile('file_ws')).rejects.toMatchObject({
        name: 'ConflictError',
      });
      expect(mocks.coreDeleteFile).not.toHaveBeenCalled();

      // 4. Legacy KB operations do NOT fail with 409 when ARCKEP_WORKSPACE_ENABLED=0
      const addRes = await fileSvc.addFilesToKnowledgeBase('kb_managed', { fileIds: ['file_1'] });
      expect(addRes.successed).toEqual(['file_1']);

      const kbSvc = new KnowledgeBaseService(fileRefDb, 'user_1');
      const kbList = await kbSvc.getKnowledgeBaseList({});
      expect(kbList.knowledgeBases).toHaveLength(1);
      await expect(
        kbSvc.updateKnowledgeBase('kb_managed', { name: 'Renamed' }),
      ).resolves.toBeDefined();

      dbHolder.currentDb = {
        select: () => ({
          from: (table: any) => ({
            where: () => ({
              limit: async () => {
                if (table && 'avatar' in table && 'slug' in table) {
                  return [{ id: 'agt_1' }];
                }
                return [{ id: 'kb_managed', type: 'project_workspace' }];
              },
            }),
          }),
        }),
      };

      const kbApp = new Hono();
      kbApp.use('*', async (c: any, next) => {
        c.set('userId', 'user_1');
        await next();
      });
      kbApp.post('/agents/:id/knowledge-bases', (c) =>
        new ArckepController().linkAgentKnowledgeBase(c),
      );
      kbApp.delete('/agents/:id/knowledge-bases/:kbId', (c) =>
        new ArckepController().unlinkAgentKnowledgeBase(c),
      );

      expect(
        (
          await kbApp.request('/agents/agt_1/knowledge-bases', {
            body: JSON.stringify({ knowledgeBaseId: 'kb_managed' }),
            headers: { 'Content-Type': 'application/json' },
            method: 'POST',
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await kbApp.request('/agents/agt_1/knowledge-bases/kb_managed', {
            method: 'DELETE',
          })
        ).status,
      ).toBe(200);
    });
  });

  describe('4. TopicService.updateTopic workspacePrefixSnapshot atomic clear (H-2)', () => {
    it('atomically removes workspacePrefixSnapshot from topics.metadata when agentId is in payload, and leaves metadata untouched otherwise', async () => {
      const capturedSets: Record<string, unknown>[] = [];
      const mockDb: any = {
        query: {
          topics: {
            findFirst: async () => ({ id: 'tpc_1', userId: 'user_1' }),
          },
        },
        select: () => ({
          from: () => ({
            where: () => ({
              limit: async () => [{ id: 'agt_2', sessionId: 'ssn_2' }],
            }),
          }),
        }),
        update: () => ({
          set: (changes: Record<string, unknown>) => {
            capturedSets.push(changes);
            return {
              where: () => ({
                returning: async () => [{ id: 'tpc_1' }],
              }),
            };
          },
        }),
      };

      const svc = new TopicService(mockDb, 'user_1');
      vi.spyOn(svc, 'getTopicById').mockResolvedValue({ id: 'tpc_1' } as any);

      // Moving topic to another agent
      await svc.updateTopic('tpc_1', { agentId: 'agt_2' });
      expect(capturedSets).toHaveLength(1);
      expect(capturedSets[0].metadata).toBeDefined();

      const dialect = new PgDialect();
      const sqlMove = dialect.sqlToQuery(capturedSets[0].metadata as any);
      expect(sqlMove.sql).toContain('COALESCE');
      expect(sqlMove.sql).toContain("- 'workspacePrefixSnapshot'");

      // Moving topic to null ("без проекта")
      await svc.updateTopic('tpc_1', { agentId: null });
      expect(capturedSets).toHaveLength(2);
      const sqlDetach = dialect.sqlToQuery(capturedSets[1].metadata as any);
      expect(sqlDetach.sql).toContain("- 'workspacePrefixSnapshot'");

      // Renaming title only -> metadata is not modified
      await svc.updateTopic('tpc_1', { title: 'Renamed' });
      expect(capturedSets).toHaveLength(3);
      expect(capturedSets[2].metadata).toBeUndefined();
    });
  });
});
