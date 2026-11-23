// @vitest-environment node
/* eslint-disable unicorn/text-encoding-identifier-case */
import { createHash } from 'node:crypto';

import type { LobeChatDatabase } from '@lobechat/database';
import { idGenerator } from '@lobechat/database';
import {
  agents,
  files,
  globalFiles,
  messages,
  messagesFiles,
  projectWorkspaceFiles,
  topics,
  users,
} from '@lobechat/database/schemas';
import { getTestDB } from '@lobechat/database/test-utils';
import { AgentChatConfigSchema } from '@lobechat/types';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { honoApp } from '../../../../../packages/openapi/src/app';
import {
  CreateAgentRequestSchema,
  UpdateAgentRequestSchema,
} from '../../../../../packages/openapi/src/types/agent.type';
import {
  computeWorkspaceDataGuardState,
  DATA_GUARD_MASKED_TOOL_ARGUMENTS,
  DATA_GUARD_MASKED_WORKSPACE_CONTENT,
  emptyAgentTrash,
  getWorkspaceExportManifest,
  listTrashFiles,
  maskUnmaskedWorkspaceHistoryForSummarizer,
  MAX_MULTIPART_CALLS_PER_RUN,
  MAX_MULTIPART_CHUNK_BYTES,
  MAX_WORKSPACE_TEXT_BYTES,
  ProjectWorkspaceStore,
  purgeExpiredWorkspaceTrash,
  purgeTrashFile,
  resetMultipartRunCountersForTests,
  restoreDeletedFile,
  WORKSPACE_STAGING_SOURCE,
  type WorkspaceStorageAdapter,
  writeProjectFilePart,
} from '../index';

const dbHolder = vi.hoisted(() => ({
  currentDb: null as unknown as LobeChatDatabase,
}));

vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: async () => dbHolder.currentDb,
}));

vi.mock('@/utils/server/auth', () => ({
  extractBearerToken: (authHeader?: string | null) => {
    if (!authHeader) return null;
    const trimmed = authHeader.trim();
    if (!trimmed.toLowerCase().startsWith('bearer ')) return null;
    const token = trimmed.slice(7).trim();
    return token.length > 0 ? token : null;
  },
}));

vi.mock('@/database/models/rbac', () => ({
  RbacModel: class {
    hasAllPermissions = vi.fn(async () => true);
    hasAnyPermission = vi.fn(async () => true);
    hasPermission = vi.fn(async () => true);
  },
}));

class InMemoryStorageAdapter implements WorkspaceStorageAdapter {
  public readonly objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  public readonly deleteOrderLog: string[] = [];

  uploadBuffer = vi.fn(
    async (key: string, buffer: Buffer, contentType: string): Promise<{ key: string }> => {
      this.objects.set(key, { bytes: new Uint8Array(buffer), contentType });
      return { key };
    },
  );

  deleteFile = vi.fn(async (key: string) => {
    this.deleteOrderLog.push(`s3:${key}`);
    this.objects.delete(key);
  });

  deleteFiles = vi.fn(async (keys: string[]) => {
    for (const key of keys) {
      this.deleteOrderLog.push(`s3:${key}`);
      this.objects.delete(key);
    }
  });

  getFileByteArray = vi.fn(async (key: string): Promise<Uint8Array> => {
    const found = this.objects.get(key);
    if (!found) {
      const err: any = new Error(`NoSuchKey: ${key}`);
      err.Code = 'NoSuchKey';
      throw err;
    }
    return found.bytes;
  });

  createPreSignedUrlForPreview = vi.fn(
    async (
      key: string,
      _expiresIn?: number,
      options?: { responseContentDisposition?: string },
    ): Promise<string> => {
      const disp = options?.responseContentDisposition
        ? `?disposition=${encodeURIComponent(options.responseContentDisposition)}`
        : '';
      return `https://s3.mock.local/${key}${disp}`;
    },
  );
}

describe('ProjectWorkspace Wave 2 Core (Data Guard 2A + Trash / Multipart / Export / Maintenance 2B)', () => {
  let db: LobeChatDatabase;
  let storage: InMemoryStorageAdapter;
  let userId: string;
  let agentId: string;
  const prevWorkspaceEnv = process.env.ARCKEP_WORKSPACE_ENABLED;
  const prevServiceKey = process.env.ARCKEP_ENGINE_SERVICE_KEY;

  beforeEach(async () => {
    process.env.ARCKEP_WORKSPACE_ENABLED = '1';
    resetMultipartRunCountersForTests();
    db = await getTestDB();
    dbHolder.currentDb = db;
    await db.delete(users);
    storage = new InMemoryStorageAdapter();
    userId = `usr_w2_${Date.now()}`;
    agentId = `agt_w2_${Date.now()}`;

    await db.insert(users).values({ id: userId });
    await db.insert(agents).values({
      chatConfig: {} as any,
      id: agentId,
      slug: 'wave2-project',
      systemRole: null,
      title: 'Юридический отдел',
      userId,
      virtual: false,
    });
  });

  afterEach(() => {
    if (prevWorkspaceEnv === undefined) {
      delete process.env.ARCKEP_WORKSPACE_ENABLED;
    } else {
      process.env.ARCKEP_WORKSPACE_ENABLED = prevWorkspaceEnv;
    }
    if (prevServiceKey === undefined) {
      delete process.env.ARCKEP_ENGINE_SERVICE_KEY;
    } else {
      process.env.ARCKEP_ENGINE_SERVICE_KEY = prevServiceKey;
    }
    vi.restoreAllMocks();
  });

  describe('1. Agent chatConfig & OpenAPI schemas preserve Data Guard Wave 2 fields', () => {
    it('preserves dataGuardProtected, dataGuardCommercial, dataGuardProtectedSince, and deepseekDataGuardProtected', () => {
      const sinceIso = '2026-11-23T12:00:00.000Z';
      const parsedConfig = AgentChatConfigSchema.parse({
        dataGuardCommercial: true,
        dataGuardProtected: true,
        dataGuardProtectedSince: sinceIso,
        deepseekDataGuardProtected: true,
      });

      expect(parsedConfig).toMatchObject({
        dataGuardCommercial: true,
        dataGuardProtected: true,
        dataGuardProtectedSince: sinceIso,
        deepseekDataGuardProtected: true,
      });

      const createParsed = CreateAgentRequestSchema.parse({
        chatConfig: {
          dataGuardCommercial: true,
          dataGuardProtected: true,
          dataGuardProtectedSince: sinceIso,
          deepseekDataGuardProtected: false,
        },
        title: 'Защищённый проект',
      });
      expect(createParsed.chatConfig).toMatchObject({
        dataGuardCommercial: true,
        dataGuardProtected: true,
        dataGuardProtectedSince: sinceIso,
        deepseekDataGuardProtected: false,
      });

      const patchParsed = UpdateAgentRequestSchema.parse({
        chatConfig: {
          dataGuardProtected: true,
          dataGuardProtectedSince: sinceIso,
        },
      });
      expect(patchParsed.chatConfig).toEqual({
        dataGuardProtected: true,
        dataGuardProtectedSince: sinceIso,
      });
    });
  });

  describe('2. dataGuard.ts: computeWorkspaceDataGuardState & maskUnmaskedWorkspaceHistoryForSummarizer', () => {
    it('does not query project_workspace_files when projectDataGuardEnabled is false, and computes workspaceDataGuardReady accurately when enabled', async () => {
      const spyDb = {
        select: vi.fn(() => {
          throw new Error('Should not query DB when projectDataGuardEnabled is false');
        }),
      } as unknown as LobeChatDatabase;

      const disabledState = await computeWorkspaceDataGuardState({
        agentChatConfig: { dataGuardProtected: false, deepseekDataGuardProtected: true },
        agentId,
        db: spyDb,
        requestDataGuardProtected: true,
        userId,
      });
      expect(disabledState).toEqual({
        dataGuardCommercial: false,
        dataGuardProtected: true,
        dataGuardProtectedSince: null,
        projectDataGuardEnabled: false,
        unmaskedActiveCount: 0,
        workspaceDataGuardReady: false,
      });
      expect((spyDb as any).select).not.toHaveBeenCalled();

      // Create an unmasked file first on normal project, then enable protection in DB
      const store = new ProjectWorkspaceStore(db, userId, storage);
      const unmaskedRes = await store.putUserTextFile(agentId, {
        content: 'Сырой договор',
        path: 'contracts/raw.md',
      });
      await store.putUserTextFile(agentId, {
        content: 'Отключённый файл',
        loadMode: 'disabled',
        path: 'contracts/disabled.md',
      });

      const sinceIso = '2026-11-23T15:00:00.000Z';
      await db
        .update(agents)
        .set({
          chatConfig: {
            dataGuardCommercial: true,
            dataGuardProtected: true,
            dataGuardProtectedSince: sinceIso,
          } as any,
        })
        .where(eq(agents.id, agentId));

      // Loads chatConfig from DB when agentChatConfig is omitted; active unmasked file blocks readiness
      const notReadyState = await computeWorkspaceDataGuardState({
        agentId,
        db,
        userId,
      });
      expect(notReadyState).toEqual({
        dataGuardCommercial: true,
        dataGuardProtected: true,
        dataGuardProtectedSince: sinceIso,
        projectDataGuardEnabled: true,
        unmaskedActiveCount: 1,
        workspaceDataGuardReady: false,
      });

      // Scrub the active file -> workspaceDataGuardReady becomes true (disabled unmasked file is ignored)
      await store.putUserTextFile(agentId, {
        baseRevision: unmaskedRes.file!.currentRevision,
        content: 'Договор [КОМПАНИЯ_1]',
        dataGuardStatus: 'scrubbed',
        path: 'contracts/raw.md',
      });

      const readyState = await computeWorkspaceDataGuardState({
        agentId,
        db,
        userId,
      });
      expect(readyState).toEqual({
        dataGuardCommercial: true,
        dataGuardProtected: true,
        dataGuardProtectedSince: sinceIso,
        projectDataGuardEnabled: true,
        unmaskedActiveCount: 0,
        workspaceDataGuardReady: true,
      });
    });

    it('masks all 7 arckep-workspace tools (including MD5HASH_ & writeProjectFilePart) and searchKnowledgeBase, while NEVER masking readKnowledge', () => {
      const wsMd5 = `MD5HASH_${createHash('md5').update('arckep-workspace').digest('hex').slice(0, 12)}`;
      const searchMd5 = `MD5HASH_${createHash('md5').update('searchKnowledgeBase').digest('hex').slice(0, 12)}`;

      const allSevenApis = [
        'listProjectFiles',
        'searchProjectFiles',
        'readProjectFile',
        'patchProjectFile',
        'writeProjectFile',
        'writeProjectFilePart',
        'deleteProjectFile',
      ];

      const inputMessages: any[] = [
        {
          id: 'msg_asst_1',
          role: 'assistant',
          tool_calls: [
            {
              function: {
                arguments: '{"path":"secret.md","text":"Иванов Иван"}',
                name: `${wsMd5}____writeProjectFilePart____builtin`,
              },
              id: 'call_md5_part',
            },
            {
              function: {
                arguments: '{"query":"паспорт"}',
                name: `lobe-knowledge-base____${searchMd5}____builtin`,
              },
              id: 'call_kb_search',
            },
            {
              function: {
                arguments: '{"fileId":"file_scrubbed_chat"}',
                name: 'lobe-knowledge-base____readKnowledge____builtin',
              },
              id: 'call_kb_read',
            },
          ],
          tools: [
            ...allSevenApis.map((apiName, idx) => ({
              apiName,
              arguments: `{"secret":"raw_${apiName}"}`,
              id: `call_ws_${idx}`,
              identifier: 'arckep-workspace',
              result: { content: `RAW_RESULT_${apiName}`, id: `tool_msg_${idx}` },
            })),
            {
              apiName: 'readKnowledge',
              arguments: '{"fileId":"file_scrubbed_chat"}',
              id: 'call_kb_read',
              identifier: 'lobe-knowledge-base',
              result: { content: 'SCRUBBED_ATTACHMENT_[ЛИЦО_1]', id: 'tool_msg_rk' },
            },
          ],
        },
        ...allSevenApis.map((apiName, idx) => ({
          content: `RAW_TOOL_BODY_${apiName}`,
          id: `tool_msg_${idx}`,
          plugin: {
            apiName,
            arguments: `{"secret":"raw_${apiName}"}`,
            identifier: 'arckep-workspace',
          },
          role: 'tool',
          tool_call_id: `call_ws_${idx}`,
        })),
        {
          content: 'RAW_MD5_PART_OUTPUT',
          id: 'tool_msg_md5',
          role: 'tool',
          tool_call_id: 'call_md5_part',
        },
        {
          content: 'RAW_KB_SEARCH_CHUNKS',
          id: 'tool_msg_search',
          plugin: { apiName: 'searchKnowledgeBase', identifier: 'lobe-knowledge-base' },
          role: 'tool',
          tool_call_id: 'call_kb_search',
        },
        {
          content: 'SCRUBBED_ATTACHMENT_[ЛИЦО_1]',
          id: 'tool_msg_rk',
          name: 'lobe-knowledge-base____readKnowledge____builtin',
          plugin: {
            apiName: 'readKnowledge',
            arguments: '{"fileId":"file_scrubbed_chat"}',
            identifier: 'lobe-knowledge-base',
          },
          role: 'tool',
          tool_call_id: 'call_kb_read',
        },
      ];

      const masked = maskUnmaskedWorkspaceHistoryForSummarizer(inputMessages);

      // Assistant tool_calls & tools: workspace + searchKnowledgeBase masked, readKnowledge untouched
      const asst = masked[0]!;
      expect(asst.tool_calls[0].function.arguments).toBe(DATA_GUARD_MASKED_TOOL_ARGUMENTS);
      expect(asst.tool_calls[1].function.arguments).toBe(DATA_GUARD_MASKED_TOOL_ARGUMENTS);
      expect(asst.tool_calls[2].function.arguments).toBe('{"fileId":"file_scrubbed_chat"}');

      for (let i = 0; i < allSevenApis.length; i++) {
        expect(asst.tools[i].arguments).toBe(DATA_GUARD_MASKED_TOOL_ARGUMENTS);
        expect(asst.tools[i].result.content).toBe(DATA_GUARD_MASKED_WORKSPACE_CONTENT);
      }
      const rkTool = asst.tools[allSevenApis.length]!;
      expect(rkTool.arguments).toBe('{"fileId":"file_scrubbed_chat"}');
      expect(rkTool.result.content).toBe('SCRUBBED_ATTACHMENT_[ЛИЦО_1]');

      // Tool messages: all 7 workspace + MD5 + searchKnowledgeBase masked
      for (let i = 1; i <= allSevenApis.length + 2; i++) {
        expect(masked[i]!.content).toBe(DATA_GUARD_MASKED_WORKSPACE_CONTENT);
      }

      // readKnowledge tool message MUST remain completely untouched
      const rkMsg = masked.at(-1)!;
      expect(rkMsg.content).toBe('SCRUBBED_ATTACHMENT_[ЛИЦО_1]');
      expect(rkMsg.plugin.arguments).toBe('{"fileId":"file_scrubbed_chat"}');
    });
  });

  describe('3. store.ts: Data Guard invariants, PATH_PREFIX_CONFLICT, TRASH_PATH_CONFLICT, and overview fields', () => {
    it('persists dataGuardStatus on INSERT/UPDATE, enforces 409 DATA_GUARD_SCRUB_REQUIRED (including rollback before dataGuardProtectedSince), and exposes overview flags', async () => {
      const store = new ProjectWorkspaceStore(db, userId, storage);

      // 1. Pre-protection revision v1 (unmasked)
      const v1 = await store.putUserTextFile(agentId, {
        content: 'ФИО: Петров Пётр',
        path: 'notes/client.md',
      });
      expect(v1.file!.dataGuardStatus).toBe('unmasked');

      // Wait 15ms so protectedSince timestamp is strictly after v1.createdAt
      await new Promise((r) => setTimeout(r, 15));
      const protectedSince = new Date().toISOString();
      await new Promise((r) => setTimeout(r, 15));

      // Enable Protected Project on agent
      await db
        .update(agents)
        .set({
          chatConfig: {
            dataGuardCommercial: true,
            dataGuardProtected: true,
            dataGuardProtectedSince: protectedSince,
          } as any,
        })
        .where(eq(agents.id, agentId));

      // Overview shows workspaceDataGuardReady = false while v1 is still unmasked
      const ovBefore = await store.getWorkspaceOverview(agentId);
      expect(ovBefore.dataGuardProtected).toBe(true);
      expect(ovBefore.dataGuardCommercial).toBe(true);
      expect(ovBefore.workspaceDataGuardReady).toBe(false);

      // Unscrubbed write in protected project -> 409 DATA_GUARD_SCRUB_REQUIRED
      await expect(
        store.putUserTextFile(agentId, {
          content: 'Сырой текст',
          path: 'notes/new.md',
        }),
      ).rejects.toMatchObject({
        code: 'DATA_GUARD_SCRUB_REQUIRED',
        httpStatus: 409,
      });

      await expect(
        store.writeAgentTextFile(agentId, {
          content: 'Сырой агентский текст',
          path: 'notes/agent.md',
        }),
      ).rejects.toMatchObject({
        code: 'DATA_GUARD_SCRUB_REQUIRED',
        httpStatus: 409,
      });

      // Scrubbed UPDATE on v1 -> v2 ('scrubbed') and v3 ('scrubbed')
      const v2 = await store.putUserTextFile(agentId, {
        baseRevision: 1,
        content: 'ФИО: [ЛИЦО_1]',
        dataGuardStatus: 'scrubbed',
        path: 'notes/client.md',
      });
      expect(v2.file!.dataGuardStatus).toBe('scrubbed');
      expect(v2.file!.currentRevision).toBe(2);

      const v3 = await store.putUserTextFile(agentId, {
        baseRevision: 2,
        content: 'ФИО: [ЛИЦО_1], компания: [КОМПАНИЯ_1]',
        dataGuardStatus: 'scrubbed',
        path: 'notes/client.md',
      });
      expect(v3.file!.currentRevision).toBe(3);

      const ovAfter = await store.getWorkspaceOverview(agentId);
      expect(ovAfter.workspaceDataGuardReady).toBe(true);

      // Rollback to pre-protection revision v1 -> 409 DATA_GUARD_SCRUB_REQUIRED
      await expect(
        store.rollbackFileRevision(agentId, v1.file!.id, {
          baseRevision: 3,
          targetRevision: 1,
        }),
      ).rejects.toMatchObject({
        code: 'DATA_GUARD_SCRUB_REQUIRED',
        httpStatus: 409,
      });

      // Rollback to post-protection revision v2 -> allowed, keeps dataGuardStatus = 'scrubbed'
      const rbOk = await store.restoreRevision(agentId, v1.file!.id, {
        baseRevision: 3,
        targetRevision: 2,
      });
      expect(rbOk.file.currentRevision).toBe(4);
      expect(rbOk.file.dataGuardStatus).toBe('scrubbed');

      // Protected file proposal in protected project -> applyProposal preserves 'scrubbed'
      const propOut = await store.writeAgentTextFile(agentId, {
        content: '# Правила [КОМПАНИЯ_1]',
        dataGuardStatus: 'scrubbed',
        path: 'AGENTS.md',
      });
      expect(propOut.outcome).toBe('proposal_created');
      if (propOut.outcome === 'proposal_created') {
        const applied = await store.applyProposal(agentId, propOut.proposal.id);
        expect(applied.file!.dataGuardStatus).toBe('scrubbed');
      }

      // Register uploaded document without scrubbed status -> 409; with scrubbed -> 200
      const docxFileId = idGenerator('files');
      const docxKey = `files/${userId}/uploads/spec.docx`;
      await storage.uploadBuffer(
        docxKey,
        Buffer.from('PK\u0003\u0004mock-docx'),
        'application/octet-stream',
      );
      await db.insert(files).values({
        fileType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        id: docxFileId,
        name: 'spec.docx',
        size: 13,
        url: docxKey,
        userId,
      });

      await expect(
        store.registerUploadedFile(agentId, {
          fileId: docxFileId,
          kind: 'document',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          path: 'docs/spec.docx',
        }),
      ).rejects.toMatchObject({
        code: 'DATA_GUARD_SCRUB_REQUIRED',
        httpStatus: 409,
      });

      const regOk = await store.registerUploadedFile(agentId, {
        dataGuardStatus: 'scrubbed',
        fileId: docxFileId,
        kind: 'document',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        path: 'docs/spec.docx',
      });
      expect(regOk.file.dataGuardStatus).toBe('scrubbed');
    });

    it('enforces 409 PATH_PREFIX_CONFLICT (file vs folder prefix in both directions, with LIKE wildcard escaping) and 409 TRASH_PATH_CONFLICT on rename', async () => {
      const store = new ProjectWorkspaceStore(db, userId, storage);

      // Direction 1: Active file 'Dockerfile' blocks creating 'Dockerfile/stage.md'
      const rootFile = await store.putUserTextFile(agentId, {
        content: 'FROM node:22-alpine\n',
        path: 'Dockerfile',
      });

      await expect(
        store.putUserTextFile(agentId, {
          content: '# Stage notes',
          path: 'Dockerfile/stage.md',
        }),
      ).rejects.toMatchObject({
        code: 'PATH_PREFIX_CONFLICT',
        httpStatus: 409,
      });

      // Direction 2: Active nested file 'services/Makefile/build.md' blocks creating file 'services/Makefile'
      await store.putUserTextFile(agentId, {
        content: '# Build steps',
        path: 'services/Makefile/build.md',
      });

      await expect(
        store.putUserTextFile(agentId, {
          content: 'all:\n\techo ok\n',
          path: 'services/Makefile',
        }),
      ).rejects.toMatchObject({
        code: 'PATH_PREFIX_CONFLICT',
        httpStatus: 409,
      });

      // Rename into conflicting prefix also throws 409 PATH_PREFIX_CONFLICT
      await expect(
        store.updateFileMetadata(agentId, rootFile.file!.id, {
          path: 'services/Makefile',
        }),
      ).rejects.toMatchObject({
        code: 'PATH_PREFIX_CONFLICT',
        httpStatus: 409,
      });

      // Wildcard '_' in path does NOT falsely collide with other single chars
      await store.putUserTextFile(agentId, {
        content: 'ok',
        path: 'dir_1/a.md',
      });
      await expect(
        store.putUserTextFile(agentId, {
          content: 'ok',
          path: 'dirX1/b.md',
        }),
      ).resolves.toBeDefined();

      // TRASH_PATH_CONFLICT: delete 'old.py', then try renaming 'cur.py' -> 'old.py'
      const oldPy = await store.putUserTextFile(agentId, {
        content: 'x = 1\n',
        path: 'src/old.py',
      });
      const curPy = await store.putUserTextFile(agentId, {
        content: 'x = 2\n',
        path: 'src/cur.py',
      });

      await store.deleteWorkspaceFile(
        agentId,
        { workspaceFileId: oldPy.file!.id },
        { actor: 'user', baseRevision: 1 },
      );

      await expect(
        store.updateFileMetadata(agentId, curPy.file!.id, {
          path: 'src/old.py',
        }),
      ).rejects.toMatchObject({
        code: 'TRASH_PATH_CONFLICT',
        httpStatus: 409,
      });
    });
  });

  describe('4. trash.ts: 30-day retention, restoreDeletedFile, FK-safe purge, messages_files protection, and staging GC', () => {
    it('lists 30-day trash with expiresAt, restores with currentRevision + 1, and enforces DataGuard/prefix conflicts on restore', async () => {
      const store = new ProjectWorkspaceStore(db, userId, storage);

      const fRecent = await store.putUserTextFile(agentId, {
        content: 'print("recent")\n',
        path: 'app/recent.py',
      });
      const fExpired = await store.putUserTextFile(agentId, {
        content: 'print("expired")\n',
        path: 'app/expired.py',
      });

      await store.deleteWorkspaceFile(
        agentId,
        { workspaceFileId: fRecent.file!.id },
        { actor: 'user', baseRevision: 1 },
      );
      await store.deleteWorkspaceFile(
        agentId,
        { workspaceFileId: fExpired.file!.id },
        { actor: 'agent', baseRevision: 1 },
      );

      // Backdate fExpired to 31 days ago
      const thirtyOneDaysAgo = new Date(Date.now() - 31 * 86_400_000);
      await db
        .update(projectWorkspaceFiles)
        .set({ deletedAt: thirtyOneDaysAgo })
        .where(eq(projectWorkspaceFiles.id, fExpired.file!.id));

      const trashList = await listTrashFiles(db, userId, agentId, storage);
      expect(trashList.files).toHaveLength(1);
      expect(trashList.files[0]!.id).toBe(fRecent.file!.id);
      expect(trashList.files[0]!.deletedBy).toBe('user');
      const expectedExpires = new Date(trashList.files[0]!.deletedAt).getTime() + 30 * 86_400_000;
      expect(new Date(trashList.files[0]!.expiresAt).getTime()).toBe(expectedExpires);

      // Expired file cannot be restored (404 FILE_NOT_FOUND)
      await expect(
        restoreDeletedFile(db, userId, agentId, fExpired.file!.id, storage),
      ).rejects.toMatchObject({
        code: 'FILE_NOT_FOUND',
        httpStatus: 404,
      });

      // Restore recent file -> currentRevision increments 1 -> 2, new revision row recorded
      const restored = await restoreDeletedFile(db, userId, agentId, fRecent.file!.id, storage);
      expect(restored.file.currentRevision).toBe(2);
      expect(restored.quota.activeFilesCount).toBe(1);

      const revs = await store.listRevisions(agentId, fRecent.file!.id);
      expect(revs.revisions[0]).toMatchObject({
        changeNote: 'Restored from trash',
        revision: 2,
      });
    });

    it('purges trash & expired staging safely: preserves files linked in messages_files, deletes orphaned files/documents/global_files, and deletes S3 after DB commit', async () => {
      const store = new ProjectWorkspaceStore(db, userId, storage);

      // File 1: orphaned workspace file (its S3 & files row MUST be deleted on purge)
      const orphanWs = await store.putUserTextFile(agentId, {
        content: 'orphan workspace data',
        path: 'data/orphan.txt',
      });
      const orphanFileId = orphanWs.file!.currentFileId;
      const [orphanFileRow] = await db.select().from(files).where(eq(files.id, orphanFileId));

      // File 2: shared with messages_files in chat history (its files row & S3 MUST be preserved!)
      const sharedFileId = idGenerator('files');
      const sharedS3Key = `files/${userId}/chat-attachments/shared.txt`;
      const sharedHash = 'a'.repeat(64);
      await storage.uploadBuffer(sharedS3Key, Buffer.from('shared chat text'), 'text/plain');
      await db.insert(globalFiles).values({
        creator: userId,
        fileType: 'text/plain',
        hashId: sharedHash,
        size: 16,
        url: sharedS3Key,
      });
      await db.insert(files).values({
        fileHash: sharedHash,
        fileType: 'text/plain',
        id: sharedFileId,
        name: 'shared.txt',
        size: 16,
        url: sharedS3Key,
        userId,
      });

      const topicId = idGenerator('topics');
      const msgId = idGenerator('messages');
      await db.insert(topics).values({ agentId, id: topicId, title: 'Chat', userId });
      await db.insert(messages).values({
        content: 'See attached',
        id: msgId,
        role: 'user',
        topicId,
        userId,
      });
      await db.insert(messagesFiles).values({ fileId: sharedFileId, messageId: msgId, userId });

      const sharedWs = await store.registerUploadedFile(agentId, {
        fileId: sharedFileId,
        kind: 'text',
        mimeType: 'text/plain',
        path: 'data/shared.txt',
      });

      // Soft-delete both into trash
      await store.deleteWorkspaceFile(
        agentId,
        { workspaceFileId: orphanWs.file!.id },
        { actor: 'user', baseRevision: 1 },
      );
      await store.deleteWorkspaceFile(
        agentId,
        { workspaceFileId: sharedWs.file.id },
        { actor: 'user', baseRevision: 1 },
      );

      storage.deleteOrderLog.length = 0;

      // Purge single orphan file
      const p1 = await purgeTrashFile(db, userId, agentId, orphanWs.file!.id, storage);
      expect(p1.purgedCount).toBe(1);
      expect(await db.select().from(files).where(eq(files.id, orphanFileId))).toHaveLength(0);
      expect(storage.objects.has(orphanFileRow!.url)).toBe(false);
      expect(storage.deleteOrderLog).toContain(`s3:${orphanFileRow!.url}`);

      // Empty remaining trash (sharedWs): workspace row deleted, but files row & S3 preserved for chat message!
      const p2 = await emptyAgentTrash(db, userId, agentId, storage);
      expect(p2.purgedCount).toBe(1);
      expect(await db.select().from(files).where(eq(files.id, sharedFileId))).toHaveLength(1);
      expect(storage.objects.has(sharedS3Key)).toBe(true);

      // Test global GC: expired trash (>30d) + abandoned multipart staging (>24h) vs fresh staging (<24h)
      const expiredWs = await store.putUserTextFile(agentId, {
        content: 'old trash body',
        path: 'gc/expired.md',
      });
      await store.deleteWorkspaceFile(
        agentId,
        { workspaceFileId: expiredWs.file!.id },
        { actor: 'user', baseRevision: 1 },
      );
      await db
        .update(projectWorkspaceFiles)
        .set({ deletedAt: new Date(Date.now() - 35 * 86_400_000) })
        .where(eq(projectWorkspaceFiles.id, expiredWs.file!.id));

      // Create 2 staging chunks via writeProjectFilePart, backdate one > 24h
      const stalePart = await writeProjectFilePart({
        agentId,
        db,
        fileServiceOverride: storage,
        final: false,
        part: 1,
        path: 'gc/stale_part.ts',
        text: 'const stale = 1;\n',
        uploadId: 'upl_stale_1',
        userId,
      });
      expect(stalePart.kind).toBe('staged');

      const freshPart = await writeProjectFilePart({
        agentId,
        db,
        fileServiceOverride: storage,
        final: false,
        part: 1,
        path: 'gc/fresh_part.ts',
        text: 'const fresh = 2;\n',
        uploadId: 'upl_fresh_1',
        userId,
      });
      expect(freshPart.kind).toBe('staged');

      await db
        .update(files)
        .set({ updatedAt: new Date(Date.now() - 26 * 3_600_000) })
        .where(eq(files.clientId, `arckep-ws-part/v1/${agentId}/upl_stale_1`));

      const gcRes = await purgeExpiredWorkspaceTrash(
        db,
        { limit: 100, retentionDays: 30, stagingMaxAgeHours: 24 },
        storage,
      );
      expect(gcRes).toEqual({
        deletedS3Objects: 2,
        purgedStagingFiles: 1,
        purgedTrashFiles: 1,
      });

      // Fresh staging session is still intact
      const remainingStaging = await db
        .select()
        .from(files)
        .where(eq(files.source, WORKSPACE_STAGING_SOURCE));
      expect(remainingStaging).toHaveLength(1);
      expect(remainingStaging[0]!.clientId).toContain('upl_fresh_1');
    });
  });

  describe('5. multipartWrite.ts: multi-chunk assembly, Proposal support, idempotency, and bounds', () => {
    it('assembles parts 1..3 in S3 staging, supports idempotent toolCallId replay, commits clean file & protected Proposal, and cleans up staging', async () => {
      const store = new ProjectWorkspaceStore(db, userId, storage);

      const p1 = await writeProjectFilePart({
        agentId,
        changeNote: 'Large module',
        db,
        fileServiceOverride: storage,
        final: false,
        lineEnding: 'lf',
        part: 1,
        path: 'src/bigModule.ts',
        text: '// Part 1\nexport const a = 1;\n',
        toolCallId: 'tc_p1',
        userId,
      });
      expect(p1.kind).toBe('staged');
      const uploadId = p1.uploadId;

      // Idempotent retry of part 1 with same toolCallId
      const p1Replay = await writeProjectFilePart({
        agentId,
        db,
        fileServiceOverride: storage,
        final: false,
        part: 1,
        path: 'src/bigModule.ts',
        text: '// Part 1\nexport const a = 1;\n',
        toolCallId: 'tc_p1',
        uploadId,
        userId,
      });
      expect(p1Replay).toEqual({
        accumulatedBytes: p1.accumulatedBytes,
        idempotentReplay: true,
        kind: 'staged',
        part: 1,
        path: 'src/bigModule.ts',
        uploadId,
      });

      // Out-of-order part 3 after part 1 -> 409 INVALID_OPERATION
      await expect(
        writeProjectFilePart({
          agentId,
          db,
          fileServiceOverride: storage,
          final: false,
          part: 3,
          path: 'src/bigModule.ts',
          text: '// skipped\n',
          uploadId,
          userId,
        }),
      ).rejects.toMatchObject({
        code: 'INVALID_OPERATION',
        httpStatus: 409,
      });

      // Part 2 + idempotent replay of Part 2
      const p2 = await writeProjectFilePart({
        agentId,
        db,
        fileServiceOverride: storage,
        final: false,
        part: 2,
        path: 'src/bigModule.ts',
        text: '// Part 2\nexport const b = 2;\n',
        toolCallId: 'tc_p2',
        uploadId,
        userId,
      });
      expect(p2.kind).toBe('staged');

      const p2Replay = await writeProjectFilePart({
        agentId,
        db,
        fileServiceOverride: storage,
        final: false,
        part: 2,
        path: 'src/bigModule.ts',
        text: '// Part 2\nexport const b = 2;\n',
        toolCallId: 'tc_p2',
        uploadId,
        userId,
      });
      expect(p2Replay).toMatchObject({ idempotentReplay: true, kind: 'staged', part: 2 });

      // Part 3 (final: true) -> commits file and removes all staging rows & S3 keys
      const p3 = await writeProjectFilePart({
        agentId,
        db,
        fileServiceOverride: storage,
        final: true,
        part: 3,
        path: 'src/bigModule.ts',
        text: '// Part 3\nexport const c = a + b;\n',
        uploadId,
        userId,
      });
      expect(p3.kind).toBe('committed');
      if (p3.kind === 'committed') {
        expect(p3.writeOutcome.outcome).toBe('created');
      }

      const detail = await store.getFileDetail(
        agentId,
        p3.kind === 'committed' && p3.writeOutcome.outcome !== 'proposal_created'
          ? p3.writeOutcome.file.id
          : '',
      );
      expect(detail.content).toBe(
        '// Part 1\nexport const a = 1;\n// Part 2\nexport const b = 2;\n// Part 3\nexport const c = a + b;\n',
      );

      // Verify zero staging rows or staging S3 objects remain
      const stagingRows = await db
        .select()
        .from(files)
        .where(eq(files.source, WORKSPACE_STAGING_SOURCE));
      expect(stagingRows).toHaveLength(0);
      expect(
        [...storage.objects.keys()].filter((k) => k.includes('project-workspace-staging')),
      ).toHaveLength(0);

      // Multipart write to protected file (AGENTS.md) creates a Proposal cleanly
      const prot1 = await writeProjectFilePart({
        agentId,
        db,
        fileServiceOverride: storage,
        final: false,
        part: 1,
        path: 'AGENTS.md',
        text: '# System Rules\n',
        userId,
      });
      const prot2 = await writeProjectFilePart({
        agentId,
        db,
        fileServiceOverride: storage,
        final: true,
        part: 2,
        path: 'AGENTS.md',
        text: 'Always verify facts.\n',
        uploadId: prot1.uploadId,
        userId,
      });
      expect(prot2.kind).toBe('committed');
      if (prot2.kind === 'committed') {
        expect(prot2.writeOutcome.outcome).toBe('proposal_created');
      }
    });

    it('rejects chunks > 64 KiB, accumulated size > 2 MiB, part > 64, and > 120 calls per run', async () => {
      // > 64 KiB single chunk
      await expect(
        writeProjectFilePart({
          agentId,
          db,
          fileServiceOverride: storage,
          final: true,
          part: 1,
          path: 'src/huge_chunk.ts',
          text: 'a'.repeat(MAX_MULTIPART_CHUNK_BYTES + 1),
          userId,
        }),
      ).rejects.toMatchObject({
        code: 'FILE_TOO_LARGE',
        httpStatus: 413,
      });

      // part > 64
      await expect(
        writeProjectFilePart({
          agentId,
          db,
          fileServiceOverride: storage,
          final: true,
          part: 65,
          path: 'src/too_many_parts.ts',
          text: 'x',
          uploadId: 'upl_65',
          userId,
        }),
      ).rejects.toMatchObject({
        code: 'INVALID_OPERATION',
        httpStatus: 400,
      });

      // > 2 MiB accumulated (32 chunks of 64 KiB = 2 MiB, 33rd byte overflows 2 MiB)
      const full64k = 'x'.repeat(MAX_MULTIPART_CHUNK_BYTES);
      let uplId: string | undefined;
      for (let part = 1; part <= 32; part++) {
        const res = await writeProjectFilePart({
          agentId,
          db,
          fileServiceOverride: storage,
          final: false,
          operationId: 'op_2mb_test',
          part,
          path: 'src/over_2mb.ts',
          text: full64k,
          uploadId: uplId,
          userId,
        });
        uplId = res.uploadId;
      }
      expect(32 * MAX_MULTIPART_CHUNK_BYTES).toBe(MAX_WORKSPACE_TEXT_BYTES);

      await expect(
        writeProjectFilePart({
          agentId,
          db,
          fileServiceOverride: storage,
          final: true,
          operationId: 'op_2mb_test',
          part: 33,
          path: 'src/over_2mb.ts',
          text: 'y',
          uploadId: uplId,
          userId,
        }),
      ).rejects.toMatchObject({
        code: 'FILE_TOO_LARGE',
        httpStatus: 413,
      });

      // > 120 calls per run guard
      resetMultipartRunCountersForTests();
      for (let i = 1; i <= MAX_MULTIPART_CALLS_PER_RUN; i++) {
        await writeProjectFilePart({
          agentId,
          db,
          fileServiceOverride: storage,
          final: false,
          operationId: 'op_run_cap',
          part: 1,
          path: `src/f_${i}.ts`,
          text: 'const ok = 1;\n',
          uploadId: `upl_cap_${i}`,
          userId,
        });
      }
      await expect(
        writeProjectFilePart({
          agentId,
          db,
          fileServiceOverride: storage,
          final: false,
          operationId: 'op_run_cap',
          part: 1,
          path: 'src/f_overflow.ts',
          text: 'const no = 0;\n',
          uploadId: 'upl_cap_over',
          userId,
        }),
      ).rejects.toMatchObject({
        code: 'QUOTA_EXCEEDED',
        httpStatus: 422,
      });
    });
  });

  describe('6. exportManifest.ts & OpenAPI HTTP routes (including service-key workspace-maintenance)', () => {
    it('builds sorted WorkspaceExportManifestResponse and serves trash, export-manifest, and service-key purge-expired-trash routes', async () => {
      const store = new ProjectWorkspaceStore(db, userId, storage);

      await store.putUserTextFile(agentId, {
        content: 'line1\r\nline2\r\n',
        lineEnding: 'CRLF',
        path: 'src/zebra.ts',
      });
      const alpha = await store
        .putUserTextFile(agentId, {
          content: '# Readme\n',
          lineEnding: 'LF',
          path: ' Alpha.md',
        })
        .catch(() =>
          store.putUserTextFile(agentId, {
            content: '# Readme\n',
            lineEnding: 'LF',
            path: 'Alpha.md',
          }),
        );

      const manifest = await getWorkspaceExportManifest(db, userId, agentId, storage);
      expect(manifest.agentId).toBe(agentId);
      expect(manifest.agentTitle).toBe('Юридический отдел');
      expect(manifest.dataGuardProtected).toBe(false);
      expect(manifest.files.map((f) => f.path)).toEqual(['Alpha.md', 'src/zebra.ts']);
      expect(manifest.files[0]).toMatchObject({
        encoding: 'utf-8',
        kind: 'text',
        lineEnding: 'lf',
        path: 'Alpha.md',
      });
      expect(manifest.files[1]).toMatchObject({
        encoding: 'utf-8',
        kind: 'text',
        lineEnding: 'crlf',
        path: 'src/zebra.ts',
      });
      expect(manifest.totalBytes).toBe(manifest.files[0]!.byteSize + manifest.files[1]!.byteSize);

      // Test real production honoApp (userAuthMiddleware + openApiRoutes) for service-key auth bypass & validation
      // 1) Short service key (< 32 chars) -> 503
      process.env.ARCKEP_ENGINE_SERVICE_KEY = 'short_key_123';
      const shortKeyRes = await honoApp.request(
        '/api/v1/workspace-maintenance/purge-expired-trash',
        {
          headers: { Authorization: 'Bearer short_key_123' },
          method: 'POST',
        },
      );
      expect(shortKeyRes.status).toBe(503);

      // 2) Valid 36-char key configured: missing Bearer -> 401; wrong Bearer -> 401
      const validKey = 'arckep_service_secret_key_0123456789abcdef';
      process.env.ARCKEP_ENGINE_SERVICE_KEY = validKey;

      const noAuthRes = await honoApp.request('/api/v1/workspace-maintenance/purge-expired-trash', {
        method: 'POST',
      });
      expect(noAuthRes.status).toBe(401);

      const badAuthRes = await honoApp.request(
        '/api/v1/workspace-maintenance/purge-expired-trash',
        {
          headers: { Authorization: 'Bearer wrong_service_secret_key_0123456789abcdef' },
          method: 'POST',
        },
      );
      expect(badAuthRes.status).toBe(401);

      // 3) Valid Bearer WITHOUT X-Arckep-User-Id header -> 200 on both primary route and /agents/... alias!
      const okMaintRes = await honoApp.request(
        '/api/v1/workspace-maintenance/purge-expired-trash',
        {
          body: JSON.stringify({ limit: 50, retentionDays: 30 }),
          headers: {
            'Authorization': `Bearer ${validKey}`,
            'Content-Type': 'application/json',
          },
          method: 'POST',
        },
      );
      expect(okMaintRes.status).toBe(200);
      const maintBody = await okMaintRes.json();
      expect(maintBody).toEqual({
        data: {
          deletedS3Objects: 0,
          purgedStagingFiles: 0,
          purgedTrashFiles: 0,
        },
        deletedS3Objects: 0,
        purgedStagingFiles: 0,
        purgedTrashFiles: 0,
        success: true,
      });

      const okAliasMaintRes = await honoApp.request(
        '/api/v1/agents/workspace-maintenance/purge-expired-trash',
        {
          headers: { Authorization: `Bearer ${validKey}` },
          method: 'POST',
        },
      );
      expect(okAliasMaintRes.status).toBe(200);

      // 4) Verify authenticated workspace trash, export-manifest, register-file & restore/:rev HTTP endpoints
      const prevMockUser = process.env.MOCK_DEV_USER_ID;
      vi.stubEnv('NODE_ENV', 'development');
      process.env.MOCK_DEV_USER_ID = userId;
      const devHeaders = { 'lobe-auth-dev-backend-api': '1' };

      try {
        // Export manifest via HTTP (falls back to /f/:id when FileService S3 isn't mocked on global singleton)
        const expHttpRes = await honoApp.request(
          `/api/v1/agents/${agentId}/workspace/export-manifest`,
          { headers: devHeaders },
        );
        expect(expHttpRes.status).toBe(200);
        const expJson = await expHttpRes.json();
        expect(expJson.data.files).toHaveLength(2);

        // Soft-delete Alpha.md, list trash, restore via HTTP with empty body, delete again, and empty trash via HTTP
        await store.deleteWorkspaceFile(
          agentId,
          { workspaceFileId: alpha.file!.id },
          { actor: 'user', baseRevision: 1 },
        );

        const listTrashHttp = await honoApp.request(`/api/v1/agents/${agentId}/workspace/trash`, {
          headers: devHeaders,
        });
        expect(listTrashHttp.status).toBe(200);
        expect((await listTrashHttp.json()).data.files).toHaveLength(1);

        const restoreHttp = await honoApp.request(
          `/api/v1/agents/${agentId}/workspace/trash/${alpha.file!.id}/restore`,
          { headers: devHeaders, method: 'POST' },
        );
        expect(restoreHttp.status).toBe(200);
        const restoreBody = await restoreHttp.json();
        expect(restoreBody.data.file.currentRevision).toBe(2);
        expect(restoreBody.data.quota.activeFilesCount).toBe(2);

        // Test alias POST /:agentId/workspace/files/:workspaceFileId/restore/:rev
        const restoreRevHttp = await honoApp.request(
          `/api/v1/agents/${agentId}/workspace/files/${alpha.file!.id}/restore/1`,
          { headers: devHeaders, method: 'POST' },
        );
        expect(restoreRevHttp.status).toBe(200);
        expect((await restoreRevHttp.json()).data.file.currentRevision).toBe(3);

        // Delete again and purge via DELETE /:agentId/workspace/trash
        await store.deleteWorkspaceFile(
          agentId,
          { workspaceFileId: alpha.file!.id },
          { actor: 'user', baseRevision: 3 },
        );
        const emptyHttp = await honoApp.request(`/api/v1/agents/${agentId}/workspace/trash`, {
          headers: devHeaders,
          method: 'DELETE',
        });
        expect(emptyHttp.status).toBe(200);
        expect((await emptyHttp.json()).data).toEqual({ purgedCount: 1 });
      } finally {
        vi.unstubAllEnvs();
        process.env.ARCKEP_WORKSPACE_ENABLED = '1';
        if (prevMockUser === undefined) {
          delete process.env.MOCK_DEV_USER_ID;
        } else {
          process.env.MOCK_DEV_USER_ID = prevMockUser;
        }
      }
    });
  });
});
