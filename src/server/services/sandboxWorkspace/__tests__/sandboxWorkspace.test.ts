// @vitest-environment node
import { createHash } from 'node:crypto';

import { SkillsExecutionRuntime } from '@lobechat/builtin-tool-skills/executionRuntime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveSandboxAllowInternet } from '@/server/modules/AgentRuntime/arckepSearch';
import { MCPService } from '@/server/services/mcp';
import { buildCommandProgram, SkillSandbox } from '@/server/services/skillSandbox';
import { ToolExecutionService } from '@/server/services/toolExecution';
import {
  HeadlessSkillRuntimeService,
  isRemotionTarget,
} from '@/server/services/toolExecution/serverRuntimes/skillsHeadless';

import {
  prepareSandboxBridgeSession,
  sanitizeBridgeArgumentsString,
  setSandboxBridgeDepsForTests,
} from '../bridge';
import {
  ARCKEP_SYNC_MARKER,
  type ArckepSandboxSyncReport,
  commitSandboxSync,
  extractAndStripArckepSync,
  type SandboxSyncStorage,
} from '../commitSync';
import {
  buildSandboxManifest,
  MAX_HYDRATE_FILE_BYTES,
  type SandboxS3Presigner,
  sanitizeTopicRelPath,
} from '../manifest';
import {
  applySandboxProjectFileSync,
  type HydratableProjectWorkspaceFile,
  listHydratableProjectFiles,
  setProjectWorkspaceBridgeForTests,
} from '../projectAdapter';

const mocks = vi.hoisted(() => ({
  findPluginById: vi.fn(),
  findTopicById: vi.fn(),
  resolveArckepUserId: vi.fn(),
  uploadBase64: vi.fn(),
}));

vi.mock('@/database/models/plugin', () => ({
  PluginModel: vi.fn(() => ({ findById: mocks.findPluginById })),
}));

vi.mock('@/database/models/topic', () => ({
  TopicModel: vi.fn(() => ({ findById: mocks.findTopicById })),
}));

vi.mock('@/server/services/toolExecution/serverRuntimes/arckepStudio', () => ({
  resolveArckepUserId: mocks.resolveArckepUserId,
}));

vi.mock('@/server/services/file', () => ({
  FileService: class {
    uploadBase64 = mocks.uploadBase64;
  },
}));

const RESULT_MARKER = '\u0001ARCKEP_RESULT\u0001';
const E2B_ID = 'mcp-arckep-e2b-sandbox';
const UUID_V4_RE = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;

interface FakeDbData {
  artifactRows?: any[];
  attachmentRows?: any[];
  insertedFiles: any[];
  sandboxRows?: any[];
  topicRow?: { agentId?: string | null; id: string; metadata?: Record<string, unknown> } | null;
  updatedFiles: Array<{ id?: string; set: Record<string, unknown> }>;
}

/**
 * Lightweight chainable Drizzle mock tailored to manifest.ts & commitSync.ts queries:
 * Query 1 (`.limit(1)`): `topics` ownership + metadata;
 * Query 2 (`.innerJoin(...).innerJoin(...)`): `messages_files`;
 * Query 3 (`from(files)` first): `ownedCodeArtifacts`;
 * Query 4 (`from(files)` second): `arckep-sandbox-file/v1/...`.
 */
const createFakeDb = (initial: Partial<FakeDbData> = {}) => {
  const state: FakeDbData = {
    artifactRows: initial.artifactRows ?? [],
    attachmentRows: initial.attachmentRows ?? [],
    insertedFiles: [],
    sandboxRows: initial.sandboxRows ?? [],
    topicRow:
      initial.topicRow === undefined
        ? { agentId: 'agt_proj_1', id: 'tpc_1', metadata: {} }
        : initial.topicRow,
    updatedFiles: [],
  };

  let fileSelectCall = 0;

  const db = {
    insert: vi.fn(() => ({
      values: vi.fn(async (row: any) => {
        state.insertedFiles.push(row);
        return [row];
      }),
    })),
    select: vi.fn(() => {
      let joinedCount = 0;
      const builder: any = {
        from: vi.fn(() => builder),
        innerJoin: vi.fn(() => {
          joinedCount += 1;
          return builder;
        }),
        limit: vi.fn(async () => (state.topicRow ? [state.topicRow] : [])),
        where: vi.fn(() => {
          const thenable: any = {
            limit: vi.fn(async () => (state.topicRow ? [state.topicRow] : [])),
            // eslint-disable-next-line unicorn/no-thenable
            then: (onFulfilled: any, onRejected: any) => {
              let result: any[];
              if (joinedCount >= 2) {
                result = state.attachmentRows ?? [];
              } else {
                const idx = fileSelectCall % 2;
                fileSelectCall += 1;
                result = idx === 0 ? (state.artifactRows ?? []) : (state.sandboxRows ?? []);
              }
              return Promise.resolve(result).then(onFulfilled, onRejected);
            },
          };
          return thenable;
        }),
      };
      return builder;
    }),
    state,
    update: vi.fn(() => ({
      set: vi.fn((patch: Record<string, unknown>) => ({
        where: vi.fn(async () => {
          state.updatedFiles.push({ set: patch });
        }),
      })),
    })),
  };

  return db;
};

const createFakePresigner = (): SandboxS3Presigner & {
  getCalls: Array<{ expires: number; key: string }>;
  putCalls: Array<{ expires: number; key: string }>;
} => {
  const getCalls: Array<{ expires: number; key: string }> = [];
  const putCalls: Array<{ expires: number; key: string }> = [];
  return {
    getCalls,
    putCalls,
    signGetUrl: async (key, expires) => {
      getCalls.push({ expires, key });
      return `https://storage.yandexcloud.net/imagestudio/${key}?X-Amz-Expires=${expires}&sig=get`;
    },
    signPutUrl: async (key, expires) => {
      putCalls.push({ expires, key });
      return `https://storage.yandexcloud.net/imagestudio/${key}?X-Amz-Expires=${expires}&sig=put`;
    },
  };
};

const createFakeS3Storage = (
  objects: Record<string, Uint8Array | string>,
): SandboxSyncStorage & { deletedKeys: string[]; getByteCalls: string[] } => {
  const deletedKeys: string[] = [];
  const getByteCalls: string[] = [];
  const toBytes = (v: Uint8Array | string) =>
    typeof v === 'string' ? new TextEncoder().encode(v) : v;

  return {
    deletedKeys,
    deleteFile: vi.fn(async (key: string) => {
      deletedKeys.push(key);
    }),
    getByteCalls,
    getFileByteArray: vi.fn(async (key: string) => {
      getByteCalls.push(key);
      const entry = objects[key];
      if (!entry) throw new Error(`NoSuchKey: ${key}`);
      return toBytes(entry);
    }),
    getFileMetadata: vi.fn(async (key: string) => {
      const entry = objects[key];
      if (!entry) throw new Error(`NotFound: ${key}`);
      return { contentLength: toBytes(entry).byteLength };
    }),
  };
};

describe('STRAT-4B Engine Sandbox Bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('APP_URL', 'https://arckep.ru/chat');
    mocks.resolveArckepUserId.mockResolvedValue(42);
    mocks.findPluginById.mockResolvedValue({ settings: {} });
    mocks.findTopicById.mockResolvedValue({ id: 'tpc_1', metadata: {} });
    setProjectWorkspaceBridgeForTests(null);
    setSandboxBridgeDepsForTests(null);
  });

  afterEach(() => {
    setProjectWorkspaceBridgeForTests(null);
    setSandboxBridgeDepsForTests(null);
    vi.unstubAllEnvs();
  });

  describe('manifest.ts — Zone 1 chronological overlay, deletion tombstones, Remotion & Data Guard', () => {
    it('overlays messages_files, ready codeArtifacts/TextFileStore, and sandbox outputs in effective_updated_at ASC order', async () => {
      const hashV1 = '1'.repeat(64);
      const hashV2 = '2'.repeat(64);
      const hashArt = 'a'.repeat(64);

      const db = createFakeDb({
        artifactRows: [
          {
            createdAt: new Date('2026-11-23T10:01:00Z'),
            fileHash: null,
            fileId: 'art_draft',
            fileType: 'text/plain',
            metadata: {
              textFile: { fileName: 'draft_ignore.py', hash: '9'.repeat(64), status: 'draft' },
            },
            name: 'draft_ignore.py',
            size: 120,
            updatedAt: new Date('2026-11-23T10:01:00Z'),
            url: 'files/u1/code-artifacts/tpc_1/art_draft/source.txt',
          },
          {
            createdAt: new Date('2026-11-23T10:01:30Z'),
            fileHash: null,
            fileId: 'art_ready',
            fileType: 'text/plain',
            metadata: {
              textFile: { fileName: 'Module1.bas', hash: hashArt, status: 'ready' },
            },
            name: 'Module1.bas',
            size: 340,
            updatedAt: new Date('2026-11-23T10:01:30Z'),
            url: 'files/u1/code-artifacts/tpc_1/art_ready/source.txt',
          },
        ],
        attachmentRows: [
          {
            fileCreatedAt: new Date('2026-11-23T10:00:00Z'),
            fileHash: hashV1,
            fileId: 'att_old',
            fileType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            fileUpdatedAt: new Date('2026-11-23T10:00:00Z'),
            messageCreatedAt: new Date('2026-11-23T10:00:00Z'),
            messageUpdatedAt: new Date('2026-11-23T10:00:00Z'),
            metadata: {},
            name: '../sales.xlsx',
            size: 1000,
            url: 'files/u1/att_old.xlsx',
          },
          {
            fileCreatedAt: new Date('2026-11-23T10:00:00Z'),
            fileHash: 'f'.repeat(64),
            fileId: 'att_huge',
            fileType: 'application/zip',
            fileUpdatedAt: new Date('2026-11-23T10:00:00Z'),
            messageCreatedAt: new Date('2026-11-23T10:00:00Z'),
            messageUpdatedAt: new Date('2026-11-23T10:00:00Z'),
            metadata: {},
            name: 'too_big.zip',
            size: MAX_HYDRATE_FILE_BYTES + 1,
            url: 'files/u1/too_big.zip',
          },
        ],
        sandboxRows: [
          {
            createdAt: new Date('2026-11-23T10:02:00Z'),
            fileHash: null,
            fileId: 'sbx_v2',
            fileType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            metadata: {
              sandboxFile: {
                deletedInWorkspace: false,
                relPath: 'sales.xlsx',
                sha256: hashV2,
                topicId: 'tpc_1',
                updatedAt: '2026-11-23T10:02:00.000Z',
              },
            },
            name: 'sales.xlsx',
            size: 2048,
            updatedAt: new Date('2026-11-23T10:02:00Z'),
            url: 'files/u1/sandbox-outputs/tpc_1/call_1/0.bin',
          },
        ],
      });

      const presigner = createFakePresigner();
      const built = await buildSandboxManifest({
        callUuid: 'call-uuid-1',
        includeUploadSlots: true,
        presigner,
        serverDB: db as any,
        topicId: 'tpc_1',
        userId: 'u1',
      });

      expect(built.envelope.version).toBe(1);
      expect(built.envelope.uploadSlots).toHaveLength(15);
      expect(presigner.putCalls.every((c) => c.expires === 900)).toBe(true);
      expect(presigner.getCalls.every((c) => c.expires === 900)).toBe(true);

      // Draft artifact and >25 MiB attachment are excluded; sandbox output at 10:02 overrides 10:00 attachment!
      expect(built.envelope.hydrate).toEqual([
        expect.objectContaining({
          readOnly: false,
          relPath: 'Module1.bas',
          sha256: hashArt,
          size: 340,
          zone: 'topic',
        }),
        expect.objectContaining({
          getUrl: expect.stringContaining('files/u1/sandbox-outputs/tpc_1/call_1/0.bin'),
          readOnly: false,
          relPath: 'sales.xlsx',
          sha256: hashV2,
          size: 2048,
          zone: 'topic',
        }),
      ]);
    });

    it('deletedInWorkspace: true hides older candidates, while a newer user attachment with the same name mounts again', async () => {
      const presigner = createFakePresigner();

      // Case A: deleted at 10:05 hides 10:00 attachment and 10:02 sandbox file
      const dbDeleted = createFakeDb({
        attachmentRows: [
          {
            fileCreatedAt: new Date('2026-11-23T10:00:00Z'),
            fileHash: '1'.repeat(64),
            fileId: 'att_1',
            fileType: 'text/csv',
            fileUpdatedAt: new Date('2026-11-23T10:00:00Z'),
            messageCreatedAt: new Date('2026-11-23T10:00:00Z'),
            messageUpdatedAt: new Date('2026-11-23T10:00:00Z'),
            metadata: {},
            name: 'data.csv',
            size: 100,
            url: 'files/u1/att_1.csv',
          },
        ],
        sandboxRows: [
          {
            createdAt: new Date('2026-11-23T10:02:00Z'),
            fileHash: null,
            fileId: 'sbx_del',
            fileType: 'text/csv',
            metadata: {
              sandboxFile: {
                deletedInWorkspace: true,
                relPath: 'data.csv',
                sha256: '2'.repeat(64),
                topicId: 'tpc_1',
                updatedAt: '2026-11-23T10:05:00.000Z',
              },
            },
            name: 'data.csv',
            size: 150,
            updatedAt: new Date('2026-11-23T10:05:00Z'),
            url: 'files/u1/sandbox-outputs/tpc_1/c1/0.bin',
          },
        ],
      });

      const hidden = await buildSandboxManifest({
        presigner,
        serverDB: dbDeleted as any,
        topicId: 'tpc_1',
        userId: 'u1',
      });
      expect(hidden.envelope.hydrate).toEqual([]);

      // Case B: user attaches fresh `data.csv` at 10:10 > 10:05 -> mounts again!
      const dbReattached = createFakeDb({
        attachmentRows: [
          {
            fileCreatedAt: new Date('2026-11-23T10:00:00Z'),
            fileHash: '1'.repeat(64),
            fileId: 'att_1',
            fileType: 'text/csv',
            fileUpdatedAt: new Date('2026-11-23T10:00:00Z'),
            messageCreatedAt: new Date('2026-11-23T10:00:00Z'),
            messageUpdatedAt: new Date('2026-11-23T10:00:00Z'),
            metadata: {},
            name: 'data.csv',
            size: 100,
            url: 'files/u1/att_1.csv',
          },
          {
            fileCreatedAt: new Date('2026-11-23T10:09:55Z'),
            fileHash: '3'.repeat(64),
            fileId: 'att_fresh',
            fileType: 'text/csv',
            fileUpdatedAt: new Date('2026-11-23T10:09:55Z'),
            messageCreatedAt: new Date('2026-11-23T10:10:00Z'),
            messageUpdatedAt: new Date('2026-11-23T10:10:00Z'),
            metadata: {},
            name: 'data.csv',
            size: 250,
            url: 'files/u1/att_fresh.csv',
          },
        ],
        sandboxRows: dbDeleted.state.sandboxRows,
      });

      const remounted = await buildSandboxManifest({
        presigner,
        serverDB: dbReattached as any,
        topicId: 'tpc_1',
        userId: 'u1',
      });
      expect(remounted.envelope.hydrate).toEqual([
        expect.objectContaining({
          getUrl: expect.stringContaining('files/u1/att_fresh.csv'),
          relPath: 'data.csv',
          sha256: '3'.repeat(64),
          size: 250,
          zone: 'topic',
        }),
      ]);
    });

    it('filters unscrubbed files, raster images, and unmasked project files when dataGuardProtected is active; closes sandbox internet', async () => {
      vi.stubEnv('ARCKEP_WORKSPACE_ENABLED', '1');
      const listMock = vi.fn(async (): Promise<HydratableProjectWorkspaceFile[]> => [
        {
          byteSize: 500,
          currentFileId: 'pf_1',
          currentRevision: 2,
          dataGuardStatus: 'unmasked',
          kind: 'text',
          mimeType: 'text/csv',
          path: 'raw_clients.csv',
          readOnly: false,
          s3Key: 'files/u1/ws/raw_clients.csv',
          sha256: '4'.repeat(64),
          workspaceFileId: 'wf_unmasked',
        },
        {
          byteSize: 600,
          currentFileId: 'pf_2',
          currentRevision: 3,
          dataGuardStatus: 'scrubbed',
          kind: 'text',
          mimeType: 'text/x-python',
          path: '/src/calc.py',
          readOnly: true,
          s3Key: 'files/u1/ws/calc.py',
          sha256: '5'.repeat(64),
          workspaceFileId: 'wf_scrubbed',
        },
      ]);
      setProjectWorkspaceBridgeForTests({ listHydratableProjectFiles: listMock });

      const db = createFakeDb({
        artifactRows: [
          {
            createdAt: new Date('2026-11-23T10:01:00Z'),
            fileHash: null,
            fileId: 'art_unscrubbed',
            fileType: 'text/plain',
            metadata: {
              textFile: { fileName: 'secret.txt', hash: '6'.repeat(64), status: 'ready' },
            },
            name: 'secret.txt',
            size: 50,
            updatedAt: new Date('2026-11-23T10:01:00Z'),
            url: 'files/u1/code-artifacts/tpc_1/art_unscrubbed/source.txt',
          },
          {
            createdAt: new Date('2026-11-23T10:01:00Z'),
            fileHash: null,
            fileId: 'art_scrubbed',
            fileType: 'text/plain',
            metadata: {
              dataGuardScrubbed: true,
              textFile: { fileName: 'clean.txt', hash: '7'.repeat(64), status: 'ready' },
            },
            name: 'clean.txt',
            size: 60,
            updatedAt: new Date('2026-11-23T10:01:00Z'),
            url: 'files/u1/code-artifacts/tpc_1/art_scrubbed/source.txt',
          },
        ],
        attachmentRows: [
          {
            fileCreatedAt: new Date('2026-11-23T10:00:00Z'),
            fileHash: '8'.repeat(64),
            fileId: 'att_img',
            fileType: 'image/png',
            fileUpdatedAt: new Date('2026-11-23T10:00:00Z'),
            messageCreatedAt: new Date('2026-11-23T10:00:00Z'),
            messageUpdatedAt: new Date('2026-11-23T10:00:00Z'),
            metadata: { dataGuardScrubbed: true },
            name: 'passport.png',
            size: 1200,
            url: 'files/u1/passport.png',
          },
          {
            fileCreatedAt: new Date('2026-11-23T10:00:00Z'),
            fileHash: '9'.repeat(64),
            fileId: 'att_unscrubbed',
            fileType: 'text/csv',
            fileUpdatedAt: new Date('2026-11-23T10:00:00Z'),
            messageCreatedAt: new Date('2026-11-23T10:00:00Z'),
            messageUpdatedAt: new Date('2026-11-23T10:00:00Z'),
            metadata: {},
            name: 'leads.csv',
            size: 400,
            url: 'files/u1/leads.csv',
          },
          {
            fileCreatedAt: new Date('2026-11-23T10:00:00Z'),
            fileHash: 'a'.repeat(64),
            fileId: 'att_scrubbed',
            fileType: 'text/csv',
            fileUpdatedAt: new Date('2026-11-23T10:00:00Z'),
            messageCreatedAt: new Date('2026-11-23T10:00:00Z'),
            messageUpdatedAt: new Date('2026-11-23T10:00:00Z'),
            metadata: { dataGuardScrubbed: true },
            name: 'masked_leads.csv',
            size: 410,
            url: 'files/u1/masked_leads.csv',
          },
        ],
        sandboxRows: [
          {
            createdAt: new Date('2026-11-23T10:02:00Z'),
            fileHash: null,
            fileId: 'sbx_old_unguarded',
            fileType: 'text/csv',
            metadata: {
              sandboxFile: {
                dataGuard: false,
                deletedInWorkspace: false,
                relPath: 'old_dump.csv',
                sha256: 'b'.repeat(64),
                topicId: 'tpc_1',
                updatedAt: '2026-11-23T10:02:00.000Z',
              },
            },
            name: 'old_dump.csv',
            size: 300,
            updatedAt: new Date('2026-11-23T10:02:00Z'),
            url: 'files/u1/sbx_old.bin',
          },
        ],
        topicRow: { agentId: 'agt_proj_1', id: 'tpc_1', metadata: { dataGuardProtected: true } },
      });

      const built = await buildSandboxManifest({
        presigner: createFakePresigner(),
        serverDB: db as any,
        topicId: 'tpc_1',
        userId: 'u1',
      });

      expect(built.effectiveDataGuard).toBe(true);
      expect(built.envelope.hydrate.map((h) => h.relPath)).toEqual([
        'masked_leads.csv',
        'clean.txt',
        'project/src/calc.py',
      ]);
      expect(built.envelope.hydrate[2]).toMatchObject({
        baseRevision: 3,
        readOnly: true,
        workspaceFileId: 'wf_scrubbed',
        zone: 'project',
      });

      // resolveSandboxAllowInternet immediately returns false when Data Guard is on
      expect(
        await resolveSandboxAllowInternet({
          agentConfig: { chatConfig: { searchMode: 'on' } },
          dataGuardProtected: true,
          model: 'claude-opus-5',
          provider: 'anthropic',
        }),
      ).toBe(false);
      expect(
        await resolveSandboxAllowInternet({
          agentConfig: {
            chatConfig: { deepseekDataGuardProtected: true, searchMode: 'on' },
          },
          model: 'gpt-5.6-luna',
          provider: 'openai',
        }),
      ).toBe(false);
    });

    it('remotion=true isolates Zone 2 completely and maps Zone 1 files into public/media/<basename>', async () => {
      vi.stubEnv('ARCKEP_WORKSPACE_ENABLED', '1');
      const listMock = vi.fn(async () => []);
      setProjectWorkspaceBridgeForTests({ listHydratableProjectFiles: listMock });

      const db = createFakeDb({
        attachmentRows: [
          {
            fileCreatedAt: new Date('2026-11-23T10:00:00Z'),
            fileHash: 'c'.repeat(64),
            fileId: 'att_logo',
            fileType: 'image/png',
            fileUpdatedAt: new Date('2026-11-23T10:00:00Z'),
            messageCreatedAt: new Date('2026-11-23T10:00:00Z'),
            messageUpdatedAt: new Date('2026-11-23T10:00:00Z'),
            metadata: {},
            name: 'logo.png',
            size: 800,
            url: 'files/u1/logo.png',
          },
        ],
      });

      const built = await buildSandboxManifest({
        presigner: createFakePresigner(),
        remotion: true,
        serverDB: db as any,
        topicId: 'tpc_1',
        userId: 'u1',
      });

      expect(listMock).not.toHaveBeenCalled();
      expect(built.envelope.remotion).toBe(true);
      expect(built.envelope.hydrate).toEqual([
        expect.objectContaining({
          readOnly: false,
          relPath: 'public/media/logo.png',
          zone: 'topic',
        }),
      ]);
      expect(sanitizeTopicRelPath('..///.secret..')).toBe('secret');
      expect(sanitizeTopicRelPath('project')).toBe('project_file');
    });
  });

  describe('commitSync.ts & projectAdapter.ts — Zone 1 files, Zone 2 Project Workspace & lossless fallbacks', () => {
    it('extractAndStripArckepSync strips both trailing marker and inline JSON _arckepSync cleanly', () => {
      const report = {
        deletedTopicRelPaths: [],
        hydratedCount: 1,
        resumed: false,
        synced: [],
        version: 1,
        warnings: ['Много мелких файлов'],
      };
      const withMarker = `Hello stdout\n${ARCKEP_SYNC_MARKER}${JSON.stringify(report)}`;
      const res1 = extractAndStripArckepSync(withMarker);
      expect(res1.cleanedText).toBe('Hello stdout');
      expect(res1.syncReport?.warnings).toEqual(['Много мелких файлов']);

      const inlineBase64 = JSON.stringify({
        _arckepSync: report,
        content_base64: 'aGk=',
        filename: 'a.txt',
        success: true,
      });
      const res2 = extractAndStripArckepSync(inlineBase64);
      expect(JSON.parse(res2.cleanedText)).toEqual({
        content_base64: 'aGk=',
        filename: 'a.txt',
        success: true,
      });
      expect(res2.cleanedText).not.toContain('_arckepSync');
      expect(res2.syncReport?.hydratedCount).toBe(1);
    });

    it('commits Zone 1 files (UUID, fileHash: null, /chat/f/<uuid>, 1..N ARCKEP_FILE markers, PNG vision block, soft-deletes deletedTopicRelPaths)', async () => {
      const db = createFakeDb({
        sandboxRows: [
          {
            id: 'old_sbx_file_id',
            metadata: {
              sandboxFile: {
                deletedInWorkspace: false,
                relPath: 'obsolete.csv',
                topicId: 'tpc_1',
              },
            },
          },
        ],
      });
      // Prime select so commitSandboxSync reads sandboxRows
      await db
        .select()
        .from({} as any)
        .where({} as any);

      const s3Key0 = 'files/u1/sandbox-outputs/tpc_1/call_1/0.bin';
      const s3Key1 = 'files/u1/sandbox-outputs/tpc_1/call_1/1.bin';
      const s3 = createFakeS3Storage({
        [s3Key0]: new Uint8Array(48_210),
        [s3Key1]: new Uint8Array(4096),
      });
      const slotKeyMap = new Map<number, string>([
        [0, s3Key0],
        [1, s3Key1],
      ]);

      const syncReport: ArckepSandboxSyncReport = {
        deletedTopicRelPaths: ['obsolete.csv'],
        hydratedCount: 2,
        resumed: true,
        synced: [
          {
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            relPath: 'report_q4.xlsx',
            sha256: '1'.repeat(64),
            size: 999, // spoofed size — commitSync must record actual S3 size (48_210)!
            slotIndex: 0,
            zone: 'topic',
          },
          {
            mimeType: 'image/png',
            relPath: 'charts/margin.png',
            sha256: '2'.repeat(64),
            size: 4096,
            slotIndex: 1,
            zone: 'topic',
          },
        ],
        version: 1,
        warnings: ['Остальные временные кадры оставлены на диске песочницы.'],
      };

      const res = await commitSandboxSync({
        callUuid: 'call_1',
        effectiveAgentId: 'agt_proj_1',
        effectiveDataGuard: false,
        s3,
        serverDB: db as any,
        slotKeyMap,
        syncReport,
        topicId: 'tpc_1',
        userId: 'u1',
      });

      // Soft-marked deletedInWorkspace=true without deleting DB row or S3 object
      expect(db.state.updatedFiles).toHaveLength(1);
      expect((db.state.updatedFiles[0].set.metadata as any).sandboxFile.deletedInWorkspace).toBe(
        true,
      );
      expect(s3.deletedKeys).toEqual([]);

      // Inserted 2 files with UUID id and strictly null fileHash
      expect(db.state.insertedFiles).toHaveLength(2);
      const [xlsxRow, pngRow] = db.state.insertedFiles;
      expect(xlsxRow.id).toMatch(UUID_V4_RE);
      expect(xlsxRow.fileHash).toBeNull();
      expect(xlsxRow.size).toBe(48_210);
      expect(xlsxRow.url).toBe(s3Key0);

      expect(pngRow.id).toMatch(UUID_V4_RE);
      expect(pngRow.fileHash).toBeNull();
      expect(res.mediaBlocks).toEqual([
        {
          data: `https://arckep.ru/chat/f/${pngRow.id}`,
          fileId: pngRow.id,
          mimeType: 'image/png',
          type: 'image',
        },
      ]);

      // Warnings come BEFORE markers, and ARCKEP_FILE markers are single-line JSON at the very end
      const footerLines = res.receiptFooter.split('\n');
      expect(footerLines[0]).toContain('Остальные временные кадры');
      expect(res.receiptFooter).toContain(
        `Сохранено в хранилище чата: [report_q4.xlsx](https://arckep.ru/chat/f/${xlsxRow.id})`,
      );
      expect(footerLines.at(-2)).toBe(
        `ARCKEP_FILE ${JSON.stringify({
          fileId: xlsxRow.id,
          filename: 'report_q4.xlsx',
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          size: 48_210,
        })}`,
      );
      expect(footerLines.at(-1)).toBe(
        `ARCKEP_FILE ${JSON.stringify({
          fileId: pngRow.id,
          filename: 'margin.png',
          mimeType: 'image/png',
          size: 4096,
        })}`,
      );
    });

    it('syncs Zone 2 (project/*) via projectAdapter: emits ARCKEP_WORKSPACE_CHANGE, ARCKEP_WORKSPACE_PROPOSAL, and lossless Zone 1 fallbacks', async () => {
      // 1. Default when ARCKEP_WORKSPACE_ENABLED !== '1'
      vi.stubEnv('ARCKEP_WORKSPACE_ENABLED', '0');
      expect(
        await listHydratableProjectFiles({
          agentId: 'agt_1',
          dataGuardProtected: false,
          serverDB: {} as any,
          userId: 'u1',
        }),
      ).toEqual([]);
      expect(
        await applySandboxProjectFileSync({
          agentId: 'agt_1',
          bytes: new Uint8Array([1]),
          dataGuardProtected: false,
          path: 'src/a.py',
          serverDB: {} as any,
          sha256: '0'.repeat(64),
          topicId: 'tpc_1',
          userId: 'u1',
        }),
      ).toEqual({
        message: 'Рабочее пространство проекта выключено',
        outcome: 'fallback_to_topic',
        reason: 'workspace_disabled',
      });

      // 2. Active workspace sync with all outcomes
      vi.stubEnv('ARCKEP_WORKSPACE_ENABLED', '1');
      const applyMock = vi.fn(async (params: any) => {
        if (params.path === 'src/calc.py') {
          return {
            addedLines: 14,
            agentId: params.agentId,
            outcome: 'updated' as const,
            path: 'src/calc.py',
            prevRevision: 2,
            removedLines: 3,
            revision: 3,
            workspaceFileId: 'wf_calc',
          };
        }
        if (params.path === 'AGENTS.md') {
          return {
            addedLines: 5,
            agentId: params.agentId,
            baseRevision: 1,
            diffPreview: '@@ -1,2 +1,6 @@',
            outcome: 'proposal_created' as const,
            proposalId: 'prop_1',
            proposalType: 'edit' as const,
            reason: 'Обновить правила проекта из песочницы',
            removedLines: 1,
            targetPath: 'AGENTS.md',
            workspaceFileId: 'wf_agents',
          };
        }
        if (params.path === 'src/conflict.py') {
          return {
            message: 'Revision conflict',
            outcome: 'fallback_to_topic' as const,
            reason: 'revision_conflict' as const,
          };
        }
        return {
          message: 'Binary not allowed',
          outcome: 'fallback_to_topic' as const,
          reason: 'binary_or_disallowed_ext' as const,
        };
      });
      setProjectWorkspaceBridgeForTests({ applySandboxProjectFileSync: applyMock });

      const db = createFakeDb();
      const s3Keys = [0, 1, 2, 3, 4].map((i) => `files/u1/sandbox-outputs/tpc_1/call_p/${i}.bin`);
      const s3 = createFakeS3Storage({
        [s3Keys[0]]: 'def add(a, b):\n    return a + b\n',
        [s3Keys[1]]: '# AGENTS\nRule 1\n',
        [s3Keys[2]]: 'print("conflict")\n',
        [s3Keys[3]]: new Uint8Array([137, 80, 78, 71]),
        [s3Keys[4]]: new Uint8Array(2 * 1024 * 1024 + 128), // > 2 MiB!
      });
      const slotKeyMap = new Map(s3Keys.map((k, i) => [i, k]));

      const res = await commitSandboxSync({
        callUuid: 'call_p',
        effectiveAgentId: 'agt_proj_1',
        effectiveDataGuard: false,
        messageId: 'msg_1',
        s3,
        serverDB: db as any,
        slotKeyMap,
        syncReport: {
          deletedTopicRelPaths: [],
          hydratedCount: 0,
          resumed: true,
          synced: [
            {
              baseRevision: 2,
              mimeType: 'text/x-python',
              relPath: 'project/src/calc.py',
              sha256: createHash('sha256')
                .update('def add(a, b):\n    return a + b\n')
                .digest('hex'),
              size: 32,
              slotIndex: 0,
              zone: 'project',
            },
            {
              baseRevision: 1,
              mimeType: 'text/markdown',
              relPath: 'project/AGENTS.md',
              sha256: 'b'.repeat(64),
              size: 16,
              slotIndex: 1,
              zone: 'project',
            },
            {
              baseRevision: 1,
              mimeType: 'text/x-python',
              relPath: 'project/src/conflict.py',
              sha256: 'c'.repeat(64),
              size: 18,
              slotIndex: 2,
              zone: 'project',
            },
            {
              baseRevision: null,
              mimeType: 'image/png',
              relPath: 'project/chart.png',
              sha256: 'd'.repeat(64),
              size: 4,
              slotIndex: 3,
              zone: 'project',
            },
            {
              baseRevision: null,
              mimeType: 'text/csv',
              relPath: 'project/big_dump.csv',
              sha256: 'e'.repeat(64),
              size: 2 * 1024 * 1024 + 128,
              slotIndex: 4,
              zone: 'project',
            },
          ],
          version: 1,
          warnings: [],
        },
        topicId: 'tpc_1',
        userId: 'u1',
      });

      // Slots 0 and 1 committed to ProjectWorkspaceStore -> temporary S3 slot blobs deleted; slots 2, 3, 4 kept in S3 as Zone 1 files!
      expect(s3.deletedKeys).toEqual([s3Keys[0], s3Keys[1]]);
      // > 2 MiB slot 4 was NOT read into RAM via getFileByteArray!
      expect(s3.getByteCalls).not.toContain(s3Keys[4]);

      expect(db.state.insertedFiles).toHaveLength(3);
      expect(db.state.insertedFiles.map((f) => f.name)).toEqual([
        'conflict.py',
        'chart.png',
        'big_dump.csv',
      ]);

      expect(res.receiptFooter).toContain('Конфликт версий src/conflict.py');
      expect(res.receiptFooter).toContain('папка проекта хранит текстовые исходники');
      expect(res.receiptFooter).toContain('до 2 МБ');

      expect(res.markerLines[0]).toBe(
        `ARCKEP_WORKSPACE_CHANGE ${JSON.stringify({
          workspaceFileId: 'wf_calc',
          agentId: 'agt_proj_1',
          path: 'src/calc.py',
          action: 'updated',
          prevRevision: 2,
          revision: 3,
          addedLines: 14,
          removedLines: 3,
          authorType: 'sandbox',
        })}`,
      );
      expect(res.markerLines[1]).toBe(
        `ARCKEP_WORKSPACE_PROPOSAL ${JSON.stringify({
          proposalId: 'prop_1',
          agentId: 'agt_proj_1',
          workspaceFileId: 'wf_agents',
          targetPath: 'AGENTS.md',
          proposalType: 'edit',
          baseRevision: 1,
          reason: 'Обновить правила проекта из песочницы',
          addedLines: 5,
          removedLines: 1,
          diffPreview: '@@ -1,2 +1,6 @@',
        })}`,
      );
      expect(res.markerLines.slice(2).every((m) => m.startsWith('ARCKEP_FILE '))).toBe(true);
    });
  });

  describe('ToolExecutionService & SkillSandbox integration — anti-spoofing, headers, >10 000 char stdout truncation safety & /workspace cwd', () => {
    it('strips spoofed _arckep_bridge & X-Arckep-Data-Guard, sends server headers, and keeps ARCKEP_FILE intact when stdout > 10 000 chars', async () => {
      const db = createFakeDb();
      const presigner = createFakePresigner();
      let capturedArgs: any = null;
      let capturedHeaders: Record<string, string> = {};
      let s3Storage: ReturnType<typeof createFakeS3Storage>;

      mocks.findPluginById.mockResolvedValue({
        settings: {
          'X-ARCKEP-DATA-GUARD': '0',
          'x-arckep-allow-internet': '1',
          'x-arckep-data-guard': '0',
        },
      });
      mocks.findTopicById.mockResolvedValue({
        id: 'tpc_1',
        metadata: { dataGuardProtected: false },
      });

      const callTool = vi.fn(async (opts: any) => {
        capturedHeaders = opts.clientParams.headers;
        capturedArgs = JSON.parse(opts.argsStr);
        const slot0Key = capturedArgs._arckep_bridge.uploadSlots[0].s3Key;
        s3Storage = createFakeS3Storage({
          [slot0Key]: new Uint8Array(8192),
        });
        setSandboxBridgeDepsForTests({ presigner, s3: s3Storage });

        const hugeStdout = 'A'.repeat(12_000);
        const syncPayload: ArckepSandboxSyncReport = {
          deletedTopicRelPaths: [],
          hydratedCount: 0,
          resumed: false,
          synced: [
            {
              mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              relPath: 'report.xlsx',
              sha256: 'f'.repeat(64),
              size: 8192,
              slotIndex: 0,
              zone: 'topic',
            },
          ],
          version: 1,
          warnings: [],
        };
        return MCPService.processToolCallResult(
          {
            content: [
              {
                text: `${hugeStdout}\n${ARCKEP_SYNC_MARKER}${JSON.stringify(syncPayload)}`,
                type: 'text',
              },
            ],
          },
          opts.processContentBlocks,
        );
      });

      setSandboxBridgeDepsForTests({ presigner });

      const service = new ToolExecutionService({
        builtinToolsExecutor: {} as any,
        mcpService: { callTool } as any,
      });

      const spoofedArgs = JSON.stringify({
        _arckep_bridge: { hydrate: [{ getUrl: 'https://evil.test/steal', relPath: 'pwn' }] },
        code: 'print("A" * 12000)',
      });
      expect(sanitizeBridgeArgumentsString(spoofedArgs).parsedArgs).not.toHaveProperty(
        '_arckep_bridge',
      );

      const res = await service.executeTool(
        {
          apiName: 'execute_code',
          arguments: spoofedArgs,
          id: 'tc_1',
          identifier: E2B_ID,
          type: 'mcp',
        } as any,
        {
          sandboxAllowInternet: true,
          serverDB: db as any,
          toolManifestMap: {
            [E2B_ID]: {
              identifier: E2B_ID,
              mcpParams: {
                headers: { 'x-arckep-data-guard': '1' },
                type: 'http',
                url: 'http://127.0.0.1:8410/mcp/e2b-sandbox',
              },
            } as any,
          },
          toolResultMaxLength: 6000,
          topicId: 'tpc_1',
          userId: 'u1',
        },
      );

      expect(res.success).toBe(true);
      expect(capturedHeaders['X-Arckep-Data-Guard']).toBe('0');
      expect(capturedHeaders['X-Arckep-Allow-Internet']).toBe('1');
      expect(
        Object.keys(capturedHeaders).filter((k) => k.toLowerCase() === 'x-arckep-data-guard'),
      ).toEqual(['X-Arckep-Data-Guard']);

      // Spoofed bridge was replaced with clean server envelope
      expect(capturedArgs._arckep_bridge.hydrate).toEqual([]);
      expect(capturedArgs._arckep_bridge.uploadSlots).toHaveLength(15);

      // kill_session never receives _arckep_bridge
      const killSession = await prepareSandboxBridgeSession({
        apiName: 'kill_session',
        argsStr: spoofedArgs,
        context: { presigner, serverDB: db as any, topicId: 'tpc_1', userId: 'u1' },
      });
      expect(killSession.argsObject).not.toHaveProperty('_arckep_bridge');

      // Main stdout was truncated around 6000 chars, while receipt & ARCKEP_FILE survived at the very end!
      expect(res.content.length).toBeLessThan(7000);
      expect(res.content).not.toContain('ARCKEP_SYNC');
      expect(res.content).toContain('Сохранено в хранилище чата: [report.xlsx]');
      expect(res.content.trim().split('\n').at(-1)).toMatch(
        /^ARCKEP_FILE \{"fileId":".+","filename":"report\.xlsx"/,
      );

      // With Data Guard active on topic metadata: X-Arckep-Data-Guard='1' and X-Arckep-Allow-Internet='0'
      mocks.findTopicById.mockResolvedValue({
        id: 'tpc_1',
        metadata: { dataGuardProtected: true },
      });
      await service.executeTool(
        {
          apiName: 'kill_session',
          arguments: '{}',
          id: 'tc_2',
          identifier: E2B_ID,
          type: 'mcp',
        } as any,
        {
          sandboxAllowInternet: true,
          serverDB: db as any,
          toolManifestMap: {
            [E2B_ID]: {
              identifier: E2B_ID,
              mcpParams: { type: 'http', url: 'http://127.0.0.1:8410/mcp/e2b-sandbox' },
            } as any,
          },
          topicId: 'tpc_1',
          userId: 'u1',
        },
      );
      expect(capturedHeaders['X-Arckep-Data-Guard']).toBe('1');
      expect(capturedHeaders['X-Arckep-Allow-Internet']).toBe('0');
    });

    it('SkillSandbox defaults cwd to /workspace, keeps ~/skills/<skill> for relative cwd, does not route /workspace/project to Remotion, and preserves ARCKEP_FILE', async () => {
      const defaultProgram = buildCommandProgram({ command: 'pwd' });
      expect(defaultProgram).toContain('_root = "/workspace"');

      const skillProgram = buildCommandProgram({ command: 'python run.py', cwd: 'skills/demo' });
      expect(skillProgram).toContain('os.path.join(os.path.expanduser("~"), "skills/demo")');

      // Zone 2 project path is NOT mistaken for Remotion video sandbox
      expect(isRemotionTarget('pytest /workspace/project/tests')).toBe(false);
      expect(isRemotionTarget('node /opt/remotion/runtime/preview.mjs')).toBe(true);

      const db = createFakeDb();
      const presigner = createFakePresigner();
      let slot0Key = '';
      let s3Storage: ReturnType<typeof createFakeS3Storage>;
      let capturedSkillHeaders: Record<string, string> = {};

      const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
        capturedSkillHeaders = (init?.headers ?? {}) as Record<string, string>;
        const body = JSON.parse(String(init?.body));
        const bridge = body.params.arguments._arckep_bridge;
        slot0Key = bridge.uploadSlots[0].s3Key;
        s3Storage = createFakeS3Storage({ [slot0Key]: 'col1,col2\n1,2\n' });
        setSandboxBridgeDepsForTests({ presigner, s3: s3Storage });

        const syncPayload: ArckepSandboxSyncReport = {
          deletedTopicRelPaths: [],
          hydratedCount: 0,
          resumed: false,
          synced: [
            {
              mimeType: 'text/csv',
              relPath: 'summary.csv',
              sha256: 'a'.repeat(64),
              size: 14,
              slotIndex: 0,
              zone: 'topic',
            },
          ],
          version: 1,
          warnings: [],
        };
        const cmdJson = JSON.stringify({
          exit: 0,
          stderr: '',
          stdout: 'B'.repeat(11_000),
        });
        const text = `${RESULT_MARKER}${cmdJson}\n${ARCKEP_SYNC_MARKER}${JSON.stringify(syncPayload)}`;
        return new Response(
          JSON.stringify({ id: 1, jsonrpc: '2.0', result: { content: [{ text }] } }),
        );
      });

      // 1) Direct SkillSandbox call with bridgeContext appends receipt to CommandResult.output
      const directSandbox = new SkillSandbox({
        allowInternet: true,
        arckepUserId: '42',
        bridgeContext: {
          dataGuardProtected: true,
          presigner,
          serverDB: db as any,
          topicId: 'tpc_1',
          userId: 'u1',
        },
        fetchImpl: fetchImpl as unknown as typeof fetch,
        gatewayUrl: 'http://gw.test/mcp/e2b-sandbox',
        topicId: 'tpc_1',
      });

      const directRes = await directSandbox.runCommand('python build_summary.py');
      expect(directRes.success).toBe(true);
      expect(capturedSkillHeaders['X-Arckep-Data-Guard']).toBe('1');
      expect(capturedSkillHeaders['X-Arckep-Allow-Internet']).toBe('0');
      expect(directRes.output).toContain('Сохранено в хранилище чата: [summary.csv]');
      expect(directRes.output.trim().split('\n').at(-1)).toMatch(/^ARCKEP_FILE /);

      // 2) Via ToolExecutionService + SkillsExecutionRuntime with >10 000 chars stdout: receipt survives truncation!
      setSandboxBridgeDepsForTests({ presigner });
      const runtimeSandbox = new SkillSandbox({
        allowInternet: false,
        arckepUserId: '42',
        fetchImpl: fetchImpl as unknown as typeof fetch,
        gatewayUrl: 'http://gw.test/mcp/e2b-sandbox',
        topicId: 'tpc_1',
      });
      const headless = new HeadlessSkillRuntimeService({
        base: {
          findAll: async () => ({ data: [], total: 0 }),
          findById: async () => undefined as any,
          findByName: async () => undefined as any,
          readResource: async () => '' as any,
        },
        fileService: { createFileRecord: vi.fn(), uploadBuffer: vi.fn() },
        resourceService: { readResource: vi.fn() },
        sandbox: runtimeSandbox,
        topicId: 'tpc_1',
      });
      const skillsExec = new SkillsExecutionRuntime({ builtinSkills: [], service: headless });

      const toolService = new ToolExecutionService({
        builtinToolsExecutor: {
          execute: async (payload: any) => skillsExec.runCommand(JSON.parse(payload.arguments)),
        } as any,
        mcpService: {} as any,
      });

      const toolRes = await toolService.executeTool(
        {
          apiName: 'runCommand',
          arguments: JSON.stringify({ command: 'python build_summary.py', description: 'build' }),
          id: 'tc_skill_1',
          identifier: 'lobe-skills',
          type: 'builtin',
        } as any,
        {
          serverDB: db as any,
          toolManifestMap: {},
          toolResultMaxLength: 6000,
          topicId: 'tpc_1',
          userId: 'u1',
        },
      );

      expect(toolRes.success).toBe(true);
      expect(toolRes.content.length).toBeLessThan(7000);
      expect(toolRes.content).toContain('Сохранено в хранилище чата: [summary.csv]');
      expect(toolRes.content.trim().split('\n').at(-1)).toMatch(
        /^ARCKEP_FILE \{"fileId":".+","filename":"summary\.csv"/,
      );
    });

    it('regression [DEFECT-1]: isRemotionTarget matches exports/ & public/media/ & .runtime/ in Remotion without hijacking Zone 2 project files', async () => {
      // Remotion targets (even with custom filenames like promo.mp4 / cover.jpg)
      expect(isRemotionTarget('/workspace/project/exports/promo.mp4')).toBe(true);
      expect(isRemotionTarget('exports/promo.mp4')).toBe(true);
      expect(isRemotionTarget('/workspace/project/public/media/logo.png')).toBe(true);
      expect(isRemotionTarget('public/media/voice.mp3')).toBe(true);
      expect(isRemotionTarget('/workspace/project/.runtime/preview.html')).toBe(true);
      expect(isRemotionTarget('.runtime/bundle.js')).toBe(true);

      // Zone 2 Project Workspace paths MUST stay false (standard code sandbox)
      expect(isRemotionTarget('/workspace/project/src/calc.py')).toBe(false);
      expect(isRemotionTarget('/workspace/project/AGENTS.md')).toBe(false);
      expect(isRemotionTarget('pytest /workspace/project/tests')).toBe(false);

      // End-to-end check on fresh HeadlessSkillRuntimeService.exportFile with custom MP4 name
      const readFileMock = vi.fn(async () => ({
        base64: Buffer.from('mp4bytes').toString('base64'),
        filename: 'promo.mp4',
        ok: true as const,
        size: 8,
      }));
      const headless = new HeadlessSkillRuntimeService({
        base: {
          findAll: async () => ({ data: [], total: 0 }),
          findById: async () => undefined as any,
          findByName: async () => undefined as any,
          readResource: async () => '' as any,
        },
        fileService: {
          createFileRecord: vi.fn(async () => ({
            fileId: 'vid-uuid-1',
            url: 'https://arckep.ru/chat/f/vid-uuid-1',
          })),
          uploadBuffer: vi.fn(async () => ({ key: 'k' })),
        },
        resourceService: { readResource: vi.fn() },
        sandbox: { readFile: readFileMock, runCommand: vi.fn() },
        topicId: 'tpc_1',
      });

      await headless.exportFile('/workspace/project/exports/promo.mp4', 'promo.mp4');
      expect(readFileMock).toHaveBeenCalledWith('/workspace/project/exports/promo.mp4', {
        template: 'remotion',
      });
    });

    it('regression [DEFECT-2]: blocks image media blocks in E2B read_file / base64 fallback when Data Guard is active (including via topic.metadata.dataGuardProtected)', async () => {
      const db = createFakeDb({
        topicRow: { agentId: 'agt_proj_1', id: 'tpc_1', metadata: { dataGuardProtected: true } },
      });
      const presigner = createFakePresigner();
      setSandboxBridgeDepsForTests({ presigner });

      mocks.findTopicById.mockResolvedValue({
        id: 'tpc_1',
        metadata: { dataGuardProtected: true },
      });
      mocks.uploadBase64.mockResolvedValue({
        fileId: 'img-uuid-dg',
        key: 'files/u1/mcp/files/scan.png',
        url: 'https://arckep.ru/chat/f/img-uuid-dg',
      });

      const rawBase64Payload = {
        content: [
          {
            text: JSON.stringify({
              content_base64: Buffer.from([137, 80, 78, 71]).toString('base64'),
              filename: 'scan.png',
              success: true,
            }),
            type: 'text',
          },
        ],
      };

      const callTool = vi.fn(async (opts: any) =>
        MCPService.processToolCallResult(rawBase64Payload, opts.processContentBlocks),
      );
      const service = new ToolExecutionService({
        builtinToolsExecutor: {} as any,
        mcpService: { callTool } as any,
      });

      const guardedRes = await service.executeTool(
        {
          apiName: 'read_file',
          arguments: JSON.stringify({ path: '/workspace/scan.png' }),
          id: 'tc_dg_read',
          identifier: E2B_ID,
          type: 'mcp',
        } as any,
        {
          // Context flag omitted intentionally — Data Guard comes from topic.metadata.dataGuardProtected!
          serverDB: db as any,
          toolManifestMap: {
            [E2B_ID]: {
              identifier: E2B_ID,
              mcpParams: { type: 'http', url: 'http://127.0.0.1:8410/mcp/e2b-sandbox' },
            } as any,
          },
          topicId: 'tpc_1',
          userId: 'u1',
        },
      );

      expect(guardedRes.success).toBe(true);
      expect(guardedRes.state?.content).toEqual([
        { text: 'Файл готов: [scan.png](https://arckep.ru/chat/f/img-uuid-dg)', type: 'text' },
      ]);
      expect(guardedRes.content).not.toContain('![](');

      // Control check: when Data Guard is OFF, the exact same call DOES attach the image vision block
      const unguardedDb = createFakeDb({
        topicRow: { agentId: 'agt_proj_1', id: 'tpc_1', metadata: { dataGuardProtected: false } },
      });
      mocks.findTopicById.mockResolvedValue({
        id: 'tpc_1',
        metadata: { dataGuardProtected: false },
      });

      const unguardedRes = await service.executeTool(
        {
          apiName: 'read_file',
          arguments: JSON.stringify({ path: '/workspace/scan.png' }),
          id: 'tc_open_read',
          identifier: E2B_ID,
          type: 'mcp',
        } as any,
        {
          serverDB: unguardedDb as any,
          toolManifestMap: {
            [E2B_ID]: {
              identifier: E2B_ID,
              mcpParams: { type: 'http', url: 'http://127.0.0.1:8410/mcp/e2b-sandbox' },
            } as any,
          },
          topicId: 'tpc_1',
          userId: 'u1',
        },
      );

      expect(unguardedRes.state?.content).toContainEqual({
        data: 'https://arckep.ru/chat/f/img-uuid-dg',
        fileId: 'img-uuid-dg',
        mimeType: 'image/png',
        type: 'image',
      });
    });

    it('regression [DEFECT-4]: buildCommandProgram prepends /workspace/project:/workspace to PYTHONPATH without duplicates', async () => {
      const { spawnSync } = await import('node:child_process');
      const program = buildCommandProgram({
        command: "python3 -c \"import os; print(os.environ.get('PYTHONPATH', ''))\"",
      });
      expect(program).toContain('"/workspace/project", "/workspace"');
      expect(program).toContain('env=_env');

      if (spawnSync('python3', ['--version']).status === 0) {
        const run1 = spawnSync('python3', ['-c', program], {
          encoding: 'utf8',
          env: { ...process.env, PYTHONPATH: '/opt/custom' },
        });
        expect(run1.stdout).toContain('/workspace/project:/workspace:/opt/custom');

        // Does not duplicate when already present
        const run2 = spawnSync('python3', ['-c', program], {
          encoding: 'utf8',
          env: { ...process.env, PYTHONPATH: '/workspace/project:/workspace' },
        });
        expect(run2.stdout).toContain('"stdout": "/workspace/project:/workspace\\n"');
      }
    });

    it('regression [LOW-1]: forwards context.parentMessageId as messageId into applySandboxProjectFileSync when context.messageId is undefined (both MCP and lobe-skills)', async () => {
      vi.stubEnv('ARCKEP_WORKSPACE_ENABLED', '1');
      const receivedMessageIds: Array<string | null | undefined> = [];
      const applyMock = vi.fn(async (params: any) => {
        receivedMessageIds.push(params.messageId);
        return {
          addedLines: 2,
          agentId: params.agentId,
          outcome: 'updated' as const,
          path: params.path,
          prevRevision: 1,
          removedLines: 0,
          revision: 2,
          workspaceFileId: 'wf_low1',
        };
      });
      setProjectWorkspaceBridgeForTests({ applySandboxProjectFileSync: applyMock });

      const db = createFakeDb();
      const presigner = createFakePresigner();
      setSandboxBridgeDepsForTests({ presigner });

      // 1) MCP path (`mcp-arckep-e2b-sandbox` / `execute_code`)
      const callTool = vi.fn(async (opts: any) => {
        const parsedArgs = JSON.parse(opts.argsStr);
        const slot0Key = parsedArgs._arckep_bridge.uploadSlots[0].s3Key;
        const s3 = createFakeS3Storage({ [slot0Key]: 'print("v2")\n' });
        setSandboxBridgeDepsForTests({ presigner, s3 });

        const syncPayload: ArckepSandboxSyncReport = {
          deletedTopicRelPaths: [],
          hydratedCount: 0,
          resumed: true,
          synced: [
            {
              baseRevision: 1,
              mimeType: 'text/x-python',
              relPath: 'project/src/app.py',
              sha256: createHash('sha256').update('print("v2")\n').digest('hex'),
              size: 12,
              slotIndex: 0,
              zone: 'project',
            },
          ],
          version: 1,
          warnings: [],
        };
        return MCPService.processToolCallResult(
          {
            content: [
              {
                text: `done\n${ARCKEP_SYNC_MARKER}${JSON.stringify(syncPayload)}`,
                type: 'text',
              },
            ],
          },
          opts.processContentBlocks,
        );
      });

      // 2) Builtin `lobe-skills` (`runCommand`) path
      const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        const slot0Key = body.params.arguments._arckep_bridge.uploadSlots[0].s3Key;
        const s3 = createFakeS3Storage({ [slot0Key]: 'print("v3")\n' });
        setSandboxBridgeDepsForTests({ presigner, s3 });

        const syncPayload: ArckepSandboxSyncReport = {
          deletedTopicRelPaths: [],
          hydratedCount: 0,
          resumed: true,
          synced: [
            {
              baseRevision: 2,
              mimeType: 'text/x-python',
              relPath: 'project/src/app.py',
              sha256: createHash('sha256').update('print("v3")\n').digest('hex'),
              size: 12,
              slotIndex: 0,
              zone: 'project',
            },
          ],
          version: 1,
          warnings: [],
        };
        const cmdJson = JSON.stringify({ exit: 0, stderr: '', stdout: 'skill done' });
        const text = `${RESULT_MARKER}${cmdJson}\n${ARCKEP_SYNC_MARKER}${JSON.stringify(syncPayload)}`;
        return new Response(
          JSON.stringify({ id: 1, jsonrpc: '2.0', result: { content: [{ text }] } }),
        );
      });

      const runtimeSandbox = new SkillSandbox({
        allowInternet: false,
        arckepUserId: '42',
        fetchImpl: fetchImpl as unknown as typeof fetch,
        gatewayUrl: 'http://gw.test/mcp/e2b-sandbox',
        topicId: 'tpc_1',
      });
      const headless = new HeadlessSkillRuntimeService({
        base: {
          findAll: async () => ({ data: [], total: 0 }),
          findById: async () => undefined as any,
          findByName: async () => undefined as any,
          readResource: async () => '' as any,
        },
        fileService: { createFileRecord: vi.fn(), uploadBuffer: vi.fn() },
        resourceService: { readResource: vi.fn() },
        sandbox: runtimeSandbox,
        topicId: 'tpc_1',
      });
      const skillsExec = new SkillsExecutionRuntime({ builtinSkills: [], service: headless });

      const service = new ToolExecutionService({
        builtinToolsExecutor: {
          execute: async (payload: any) => skillsExec.runCommand(JSON.parse(payload.arguments)),
        } as any,
        mcpService: { callTool } as any,
      });

      const mcpRes = await service.executeTool(
        {
          apiName: 'execute_code',
          arguments: JSON.stringify({
            code: 'open("project/src/app.py","w").write("print(\\"v2\\")\\n")',
          }),
          id: 'tc_low1_mcp',
          identifier: E2B_ID,
          type: 'mcp',
        } as any,
        {
          agentId: 'agt_proj_1',
          messageId: undefined,
          parentMessageId: 'msg_assistant_parent_1',
          serverDB: db as any,
          toolManifestMap: {
            [E2B_ID]: {
              identifier: E2B_ID,
              mcpParams: { type: 'http', url: 'http://127.0.0.1:8410/mcp/e2b-sandbox' },
            } as any,
          },
          topicId: 'tpc_1',
          userId: 'u1',
        },
      );
      expect(mcpRes.success).toBe(true);
      expect(mcpRes.content).toContain('ARCKEP_WORKSPACE_CHANGE ');

      setSandboxBridgeDepsForTests({ presigner });
      const skillRes = await service.executeTool(
        {
          apiName: 'runCommand',
          arguments: JSON.stringify({ command: 'python update.py', description: 'update' }),
          id: 'tc_low1_skill',
          identifier: 'lobe-skills',
          type: 'builtin',
        } as any,
        {
          agentId: 'agt_proj_1',
          messageId: undefined,
          parentMessageId: 'msg_assistant_parent_1',
          serverDB: db as any,
          toolManifestMap: {},
          topicId: 'tpc_1',
          userId: 'u1',
        },
      );
      expect(skillRes.success).toBe(true);
      expect(skillRes.content).toContain('ARCKEP_WORKSPACE_CHANGE ');

      expect(receivedMessageIds).toEqual(['msg_assistant_parent_1', 'msg_assistant_parent_1']);
    });
  });
});
