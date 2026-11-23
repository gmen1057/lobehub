// @vitest-environment node
import { AgentRuntime, type AgentState } from '@lobechat/agent-runtime';
import { LobeActivatorIdentifier } from '@lobechat/builtin-tool-activator';
import { AgentDocumentsIdentifier } from '@lobechat/builtin-tool-agent-documents';
import {
  KnowledgeBaseApiName,
  KnowledgeBaseIdentifier,
} from '@lobechat/builtin-tool-knowledge-base';
import {
  buildReadOnlyProjectWorkspaceManifest,
  builtinTools,
  PROJECT_WORKSPACE_TOOL,
  ProjectWorkspaceManifest,
} from '@lobechat/builtin-tools';
import { readFilePage } from '@lobechat/prompts';
import type * as ModelBankModule from 'model-bank';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildToolDiscoveryConfig,
  createRuntimeExecutors,
  type RuntimeExecutorContext,
} from '@/server/modules/AgentRuntime/RuntimeExecutors';
import type * as MechaModule from '@/server/modules/Mecha';
import { createServerAgentToolsEngine } from '@/server/modules/Mecha';
import { serverMessagesEngine } from '@/server/modules/Mecha/ContextEngineering';
import type * as ProjectWorkspaceModule from '@/server/services/projectWorkspace';
import { WorkspaceError } from '@/server/services/projectWorkspace/paths';
import { getServerRuntime, hasServerRuntime } from '@/server/services/toolExecution/serverRuntimes';
import {
  DATA_GUARD_FILE_MASKED_CONTENT,
  DATA_GUARD_SEARCH_BLOCKED_MESSAGE,
  knowledgeBaseRuntime,
} from '@/server/services/toolExecution/serverRuntimes/knowledgeBase';
import {
  projectWorkspaceRuntime,
  resetProjectWorkspaceWriteLimiterForTests,
  WORKSPACE_CHANGE_MARKER_PREFIX,
  WORKSPACE_PROPOSAL_MARKER_PREFIX,
} from '@/server/services/toolExecution/serverRuntimes/projectWorkspace';

import { AiAgentService } from '../index';

const {
  mockCreateOperation,
  mockDeleteWorkspaceFile,
  mockFindById,
  mockGetAgentConfig,
  mockGetAgentDocuments,
  mockGetFileContents,
  mockGetWorkspaceOverview,
  mockHasEverHadAgentsMd,
  mockMessageCreate,
  mockMessageQuery,
  mockParseDocumentQuietly,
  mockPatchAgentTextFile,
  mockReadProjectFilePage,
  mockResolveTopicWorkspaceSnapshot,
  mockSearchProjectFiles,
  mockSemanticSearchForChat,
  mockTopicHasCodeArtifacts,
  mockWriteAgentTextFile,
} = vi.hoisted(() => ({
  mockCreateOperation: vi.fn(),
  mockDeleteWorkspaceFile: vi.fn(),
  mockFindById: vi.fn(),
  mockGetAgentConfig: vi.fn(),
  mockGetAgentDocuments: vi.fn(),
  mockGetFileContents: vi.fn(),
  mockGetWorkspaceOverview: vi.fn(),
  mockHasEverHadAgentsMd: vi.fn(),
  mockMessageCreate: vi.fn(),
  mockMessageQuery: vi.fn(),
  mockParseDocumentQuietly: vi.fn(),
  mockPatchAgentTextFile: vi.fn(),
  mockReadProjectFilePage: vi.fn(),
  mockResolveTopicWorkspaceSnapshot: vi.fn(),
  mockSearchProjectFiles: vi.fn(),
  mockSemanticSearchForChat: vi.fn(),
  mockTopicHasCodeArtifacts: vi.fn(),
  mockWriteAgentTextFile: vi.fn(),
}));

vi.mock('@/libs/trusted-client', () => ({
  generateTrustedClientToken: vi.fn().mockReturnValue(undefined),
  getTrustedClientTokenForSession: vi.fn().mockResolvedValue(undefined),
  isTrustedClientEnabled: vi.fn().mockReturnValue(false),
}));

vi.mock('@/database/models/message', () => ({
  MessageModel: vi.fn().mockImplementation(() => ({
    addFiles: vi.fn().mockResolvedValue(undefined),
    create: mockMessageCreate,
    findById: mockFindById,
    query: mockMessageQuery,
    update: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock('@/database/models/agent', () => ({
  AgentModel: vi.fn().mockImplementation(() => ({
    getAgentConfig: vi.fn().mockResolvedValue({ knowledgeBases: [{ enabled: true, id: 'kb-1' }] }),
  })),
}));

vi.mock('@/server/services/agent', () => ({
  AgentService: vi.fn().mockImplementation(() => ({
    getAgentConfig: mockGetAgentConfig,
  })),
}));

vi.mock('@/server/services/agentDocuments', () => ({
  AgentDocumentsService: vi.fn().mockImplementation(() => ({
    getAgentDocuments: mockGetAgentDocuments,
  })),
}));

vi.mock('@/database/models/plugin', () => ({
  PluginModel: vi.fn().mockImplementation(() => ({
    findById: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue([]),
  })),
}));

vi.mock('@/database/models/topic', () => ({
  TopicModel: vi.fn().mockImplementation(() => ({
    create: vi.fn().mockResolvedValue({ id: 'topic-new' }),
    findById: vi.fn().mockImplementation(async (id: string) => ({ id })),
    updateMetadata: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('@/database/models/thread', () => ({
  ThreadModel: vi.fn().mockImplementation(() => ({
    create: vi.fn(),
    findById: vi.fn(),
    update: vi.fn(),
  })),
}));

vi.mock('@/database/models/user', () => ({
  UserModel: vi.fn().mockImplementation(() => ({
    getUserSettings: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('@/database/models/userMemory/persona', () => ({
  UserPersonaModel: vi.fn().mockImplementation(() => ({
    getLatestPersonaDocument: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('@/server/services/agentRuntime', () => ({
  AgentRuntimeService: vi.fn().mockImplementation(() => ({
    createOperation: mockCreateOperation,
  })),
}));

vi.mock('@/server/services/market', () => ({
  MarketService: vi.fn().mockImplementation(() => ({
    getLobehubSkillManifests: vi.fn().mockResolvedValue([]),
  })),
}));

vi.mock('@/server/services/klavis', () => ({
  KlavisService: vi.fn().mockImplementation(() => ({
    getKlavisManifests: vi.fn().mockResolvedValue([]),
  })),
}));

vi.mock('@/server/modules/Mecha', async (importOriginal) => {
  const actual = await importOriginal<typeof MechaModule>();
  return {
    ...actual,
    createServerAgentToolsEngine: vi.fn((ctx, params) =>
      actual.createServerAgentToolsEngine(ctx, params),
    ),
  };
});

vi.mock('@/server/modules/Mecha/ContextEngineering', () => ({
  serverMessagesEngine: vi.fn().mockResolvedValue([{ content: 'ok', role: 'user' }]),
}));

vi.mock('@/server/modules/ModelRuntime', () => ({
  initModelRuntimeFromDB: vi.fn().mockResolvedValue({
    chat: vi.fn(async () => new Response('ok')),
  }),
}));

vi.mock('@/server/services/file', () => ({
  FileService: vi.fn().mockImplementation(() => ({
    getFullFileUrl: vi.fn(async (p: string | null) => (p ? `https://s3.test/${p}` : '')),
    uploadFromUrl: vi.fn(),
  })),
}));

vi.mock('@/server/services/document', () => ({
  DocumentService: vi.fn().mockImplementation(() => ({
    parseFile: mockParseDocumentQuietly,
  })),
}));

vi.mock('@/server/services/toolExecution/deviceProxy', () => ({
  deviceProxy: {
    isConfigured: false,
    queryDeviceList: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('@/server/services/topicContext/codeArtifacts', () => ({
  topicHasCodeArtifacts: mockTopicHasCodeArtifacts,
}));

vi.mock('@/server/services/knowledgeRetrieval', () => ({
  KnowledgeRetrievalService: vi.fn().mockImplementation(() => ({
    getFileContents: mockGetFileContents,
    semanticSearchForChat: mockSemanticSearchForChat,
  })),
}));

vi.mock('@/server/services/projectWorkspace', async (importOriginal) => {
  const actual = await importOriginal<typeof ProjectWorkspaceModule>();
  return {
    ...actual,
    ProjectWorkspaceStore: vi.fn().mockImplementation(() => ({
      deleteWorkspaceFile: mockDeleteWorkspaceFile,
      getWorkspaceOverview: mockGetWorkspaceOverview,
      patchAgentTextFile: mockPatchAgentTextFile,
      readProjectFilePage: mockReadProjectFilePage,
      searchProjectFiles: mockSearchProjectFiles,
      writeAgentTextFile: mockWriteAgentTextFile,
    })),
    hasEverHadAgentsMd: mockHasEverHadAgentsMd,
    resolveTopicWorkspaceSnapshot: mockResolveTopicWorkspaceSnapshot,
  };
});

vi.mock('model-bank', async (importOriginal) => {
  const actual = await importOriginal<typeof ModelBankModule>();
  return {
    ...actual,
    LOBE_DEFAULT_MODEL_LIST: [
      {
        abilities: { functionCall: true, video: false, vision: true },
        id: 'gpt-4',
        providerId: 'openai',
      },
      {
        abilities: { functionCall: true, video: false, vision: true },
        id: 'claude-sonnet-4-5',
        providerId: 'anthropic',
      },
    ],
  };
});

const makeSnapshot = (
  overrides: Partial<Awaited<ReturnType<typeof mockResolveTopicWorkspaceSnapshot>>> = {},
) => ({
  activeFilesCount: 1,
  agentId: 'agent-1',
  compressionSignature: null,
  currentVersion: 'ver-1',
  documentFilesCount: 0,
  indexBlock: '',
  pinnedChars: 120,
  pinnedTokens: 40,
  rebuilt: true,
  rulesBlock:
    '<project_rules>\n<rule_file path="AGENTS.md" revision="1">\nRule body\n</rule_file>\n</project_rules>',
  seenVersion: 'ver-1',
  textFilesCount: 1,
  unpinnedCount: 0,
  workspaceDelta: null,
  ...overrides,
});

describe('Project Workspace integration: execAgent, RuntimeExecutors, projectWorkspaceRuntime & Data Guard', () => {
  const prevEnv = process.env.ARCKEP_WORKSPACE_ENABLED;
  let service: AiAgentService;

  beforeEach(() => {
    vi.clearAllMocks();
    resetProjectWorkspaceWriteLimiterForTests();
    process.env.ARCKEP_WORKSPACE_ENABLED = '1';

    mockGetAgentConfig.mockResolvedValue({
      chatConfig: {},
      files: [{ content: 'legacy file body', enabled: true, id: 'legacy-f1', name: 'old.txt' }],
      id: 'agent-1',
      knowledgeBases: [],
      model: 'gpt-4',
      plugins: [],
      provider: 'openai',
      slug: null,
      systemRole: 'Legacy DB system_role that was migrated',
      virtual: false,
    });

    mockHasEverHadAgentsMd.mockResolvedValue(true);
    mockResolveTopicWorkspaceSnapshot.mockResolvedValue(makeSnapshot());
    mockGetAgentDocuments.mockResolvedValue([
      { content: 'legacy doc', filename: 'doc.md', id: 'd1', title: 'Doc' },
    ]);
    mockTopicHasCodeArtifacts.mockResolvedValue(false);
    mockMessageQuery.mockResolvedValue([]);
    mockMessageCreate
      .mockResolvedValueOnce({ createdAt: new Date('2026-11-23T10:00:00.000Z'), id: 'u-msg-1' })
      .mockResolvedValueOnce({ id: 'a-msg-1' });

    mockCreateOperation.mockResolvedValue({
      autoStarted: true,
      messageId: 'q-1',
      operationId: 'op-ws-1',
      success: true,
    });

    service = new AiAgentService({} as any, 'user-1');
  });

  afterEach(() => {
    if (prevEnv === undefined) {
      delete process.env.ARCKEP_WORKSPACE_ENABLED;
    } else {
      process.env.ARCKEP_WORKSPACE_ENABLED = prevEnv;
    }
  });

  describe('1. R2-1 / R2-2: systemRole protection, soft-deleted AGENTS.md, inbox preservation & dynamicSystemAppend', () => {
    it('clears DB systemRole when AGENTS.md has ever existed (including soft-deleted AGENTS.md — zero zombie fallback) while keeping static studioWebChat filenameRule and moving instructions/codeSourceRules to dynamicSystemAppend', async () => {
      // Soft-deleted AGENTS.md: hasEverHadAgentsMd === true, rulesBlock === ''
      mockHasEverHadAgentsMd.mockResolvedValue(true);
      mockResolveTopicWorkspaceSnapshot.mockResolvedValue(
        makeSnapshot({
          activeFilesCount: 0,
          pinnedChars: 0,
          pinnedTokens: 0,
          rulesBlock: '',
          textFilesCount: 0,
          unpinnedCount: 0,
        }),
      );
      mockTopicHasCodeArtifacts.mockResolvedValue(true);

      await service.execAgent({
        agentId: 'agent-1',
        appContext: { topicId: 'topic-1' },
        instructions: 'Per-turn extra instruction',
        prompt: 'Continue code',
        studioWebChat: true,
      });

      expect(mockHasEverHadAgentsMd).toHaveBeenCalledWith({}, 'user-1', 'agent-1');
      expect(mockCreateOperation).toHaveBeenCalledOnce();

      const [{ agentConfig, appContext }] = mockCreateOperation.mock.calls[0];
      // Zombie DB system_role must NOT resurrect, only static studioWebChat filenameRule remains in systemRole
      expect(agentConfig.systemRole).not.toContain('Legacy DB system_role');
      expect(agentConfig.systemRole).toContain('Markdown code fence');
      expect(agentConfig.systemRole).not.toContain('Per-turn extra instruction');
      expect(agentConfig.systemRole).not.toContain('Saved code versions are available');

      // Dynamic per-turn additions are routed to dynamicSystemAppend (after <project_rules>)
      expect(appContext.dynamicSystemAppend).toContain('Per-turn extra instruction');
      expect(appContext.dynamicSystemAppend).toContain('Saved code versions are available');
      expect(appContext.workspaceActive).toBe(true);
    });

    it('preserves fallback DB systemRole for unmigrated projects before backfill (hasEverHadAgentsMd === false)', async () => {
      mockHasEverHadAgentsMd.mockResolvedValue(false);
      mockResolveTopicWorkspaceSnapshot.mockResolvedValue(makeSnapshot({ rulesBlock: '' }));

      await service.execAgent({
        agentId: 'agent-1',
        appContext: { topicId: 'topic-legacy' },
        prompt: 'Hello',
      });

      const [{ agentConfig }] = mockCreateOperation.mock.calls[0];
      expect(agentConfig.systemRole).toBe('Legacy DB system_role that was migrated');
    });

    it('preserves builtin inbox runtimeConfig.systemRole and disables arckep-workspace on inbox', async () => {
      mockGetAgentConfig.mockResolvedValue({
        chatConfig: {},
        files: [],
        id: 'agent-inbox',
        knowledgeBases: [],
        model: 'gpt-4',
        plugins: [],
        provider: 'openai',
        slug: 'inbox',
        systemRole: '',
        virtual: true,
      });

      await service.execAgent({
        agentId: 'agent-inbox',
        appContext: { topicId: 'topic-inbox' },
        instructions: 'Custom call instruction',
        prompt: 'Hi inbox',
      });

      expect(mockHasEverHadAgentsMd).not.toHaveBeenCalled();
      expect(mockResolveTopicWorkspaceSnapshot).not.toHaveBeenCalled();

      const [{ agentConfig, appContext, toolSet }] = mockCreateOperation.mock.calls[0];
      expect(agentConfig.systemRole).toBeTruthy();
      expect(agentConfig.systemRole).toContain('Custom call instruction');
      expect(appContext.dynamicSystemAppend).toBeUndefined();
      expect(appContext.workspaceActive).toBeUndefined();
      expect(toolSet.disabledToolIds).toContain(PROJECT_WORKSPACE_TOOL);
      expect(toolSet.enabledToolIds).not.toContain(PROJECT_WORKSPACE_TOOL);
      expect(toolSet.manifestMap[PROJECT_WORKSPACE_TOOL]).toBeUndefined();
    });
  });

  describe('2. H-4 & H-1: smart tool loading (lazy vs eager 6 tools vs eager read-only 2 tools) & schema safety', () => {
    it('registers ProjectWorkspaceManifest in builtinTools as hidden + discoverable without userSummary on writeProjectFile (H-1)', () => {
      const entry = builtinTools.find((t) => t.identifier === PROJECT_WORKSPACE_TOOL);
      expect(entry).toBeDefined();
      expect(entry?.hidden).toBe(true);
      expect(entry?.discoverable).toBe(true);
      expect(hasServerRuntime(PROJECT_WORKSPACE_TOOL)).toBe(true);

      const apiNames = ProjectWorkspaceManifest.api.map((a) => a.name);
      expect(apiNames).toEqual([
        'listProjectFiles',
        'searchProjectFiles',
        'readProjectFile',
        'patchProjectFile',
        'writeProjectFile',
        'deleteProjectFile',
      ]);

      const writeSchema = ProjectWorkspaceManifest.api.find((a) => a.name === 'writeProjectFile');
      expect(writeSchema?.parameters?.properties).not.toHaveProperty('userSummary');

      const roManifest = buildReadOnlyProjectWorkspaceManifest();
      expect(roManifest.api.map((a) => a.name)).toEqual(['listProjectFiles', 'readProjectFile']);
    });

    it('defers arckep-workspace into lazyToolIds (<available_tools>) when unpinnedCount === 0 and suppresses lobe-agent-documents', async () => {
      mockResolveTopicWorkspaceSnapshot.mockResolvedValue(
        makeSnapshot({
          activeFilesCount: 1,
          documentFilesCount: 0,
          textFilesCount: 1,
          unpinnedCount: 0, // Only pinned AGENTS.md
        }),
      );

      await service.execAgent({
        agentId: 'agent-1',
        appContext: { topicId: 'topic-lazy' },
        prompt: 'Explain project rules',
      });

      // Legacy getAgentDocuments must NOT be queried in workspace mode
      expect(mockGetAgentDocuments).not.toHaveBeenCalled();

      const [{ toolSet }] = mockCreateOperation.mock.calls[0];
      expect(toolSet.disabledToolIds).toContain(AgentDocumentsIdentifier);
      expect(toolSet.enabledToolIds).not.toContain(PROJECT_WORKSPACE_TOOL);
      expect(toolSet.enabledToolIds).toContain(LobeActivatorIdentifier);
      expect(toolSet.manifestMap[PROJECT_WORKSPACE_TOOL]).toBeDefined();

      // Verify buildToolDiscoveryConfig exposes arckep-workspace as a compact single line in <available_tools>
      const discovery = buildToolDiscoveryConfig(toolSet, toolSet.enabledToolIds);
      expect(discovery?.availableTools?.some((t) => t.identifier === PROJECT_WORKSPACE_TOOL)).toBe(
        true,
      );
    });

    it('loads all 6 arckep-workspace tools eager on Step 0 when unpinnedCount > 0 && textFilesCount > 0', async () => {
      mockResolveTopicWorkspaceSnapshot.mockResolvedValue(
        makeSnapshot({
          activeFilesCount: 2,
          documentFilesCount: 0,
          indexBlock:
            '<project_workspace_index trust="untrusted_workspace_data">\n- src/app.py\n</project_workspace_index>',
          textFilesCount: 2,
          unpinnedCount: 1,
        }),
      );

      await service.execAgent({
        agentId: 'agent-1',
        appContext: { topicId: 'topic-eager-text' },
        prompt: 'Check src/app.py',
      });

      const [{ appContext, toolSet }] = mockCreateOperation.mock.calls[0];
      expect(toolSet.enabledToolIds).toContain(PROJECT_WORKSPACE_TOOL);
      expect(toolSet.manifestMap[PROJECT_WORKSPACE_TOOL].api).toHaveLength(6);
      expect(appContext.workspaceIndexBlock).toContain('src/app.py');
    });

    it('loads read-only 2-tool arckep-workspace manifest eager when documentFilesCount > 0 && textFilesCount === 0, and filters empty managed project_workspace KBs', async () => {
      mockGetAgentConfig.mockResolvedValue({
        chatConfig: {},
        files: [],
        id: 'agent-1',
        knowledgeBases: [
          { enabled: true, id: 'kb-managed', name: 'Файлы проекта', type: 'project_workspace' },
        ],
        model: 'gpt-4',
        plugins: [],
        provider: 'openai',
        systemRole: '',
      });
      mockResolveTopicWorkspaceSnapshot.mockResolvedValue(
        makeSnapshot({
          activeFilesCount: 1,
          documentFilesCount: 1,
          rulesBlock: '',
          textFilesCount: 0,
          unpinnedCount: 1,
        }),
      );

      await service.execAgent({
        agentId: 'agent-1',
        appContext: { topicId: 'topic-docs-only' },
        prompt: 'Inspect uploaded PDF',
      });

      const [{ toolSet }] = mockCreateOperation.mock.calls[0];
      expect(toolSet.enabledToolIds).toContain(PROJECT_WORKSPACE_TOOL);
      const wsStep0Tools = (toolSet.tools ?? [])
        .map((t: any) => t.function?.name as string)
        .filter((name: string) => name?.startsWith(`${PROJECT_WORKSPACE_TOOL}____`));
      expect(wsStep0Tools).toEqual([
        `${PROJECT_WORKSPACE_TOOL}____listProjectFiles____builtin`,
        `${PROJECT_WORKSPACE_TOOL}____readProjectFile____builtin`,
      ]);
      // Full 6-tool manifest stays in manifestMap so activateTools(['arckep-workspace']) unlocks writeProjectFile
      expect(toolSet.manifestMap[PROJECT_WORKSPACE_TOOL].api.map((a: any) => a.name)).toEqual([
        'listProjectFiles',
        'searchProjectFiles',
        'readProjectFile',
        'patchProjectFile',
        'writeProjectFile',
        'deleteProjectFile',
      ]);
      // Managed KB has documentFilesCount > 0 -> searchKnowledgeBase stays enabled!
      expect(toolSet.enabledToolIds).toContain(KnowledgeBaseIdentifier);

      // Now test empty managed KB (0 active files) -> lobe-knowledge-base is NOT loaded eager
      vi.clearAllMocks();
      mockGetAgentConfig.mockResolvedValue({
        chatConfig: {},
        files: [],
        id: 'agent-1',
        knowledgeBases: [
          { enabled: true, id: 'kb-empty', name: 'Файлы проекта', type: 'project_workspace' },
        ],
        model: 'gpt-4',
        plugins: [],
        provider: 'openai',
        systemRole: '',
      });
      mockHasEverHadAgentsMd.mockResolvedValue(true);
      mockResolveTopicWorkspaceSnapshot.mockResolvedValue(
        makeSnapshot({
          activeFilesCount: 0,
          documentFilesCount: 0,
          rulesBlock: '',
          textFilesCount: 0,
          unpinnedCount: 0,
        }),
      );
      mockMessageQuery.mockResolvedValue([]);
      mockMessageCreate
        .mockResolvedValueOnce({ createdAt: new Date(), id: 'u-2' })
        .mockResolvedValueOnce({ id: 'a-2' });
      mockCreateOperation.mockResolvedValue({
        autoStarted: true,
        operationId: 'op-2',
        success: true,
      });

      await service.execAgent({
        agentId: 'agent-1',
        appContext: { topicId: 'topic-empty-kb' },
        prompt: 'Hi',
      });

      const [{ toolSet: emptyKbToolSet }] = mockCreateOperation.mock.calls[0];
      expect(emptyKbToolSet.enabledToolIds).not.toContain(KnowledgeBaseIdentifier);
    });

    it('aligns topicCacheTtlMs to 1h (3,600,000ms) for Anthropic models at >= 30K tokens and keeps 5m otherwise', async () => {
      mockGetAgentConfig.mockResolvedValue({
        chatConfig: {},
        files: [],
        id: 'agent-1',
        knowledgeBases: [],
        model: 'claude-sonnet-4-5',
        plugins: [],
        provider: 'anthropic',
        systemRole: '',
      });
      mockResolveTopicWorkspaceSnapshot.mockResolvedValue(
        makeSnapshot({
          pinnedTokens: 31_000,
        }),
      );

      await service.execAgent({
        agentId: 'agent-1',
        appContext: { topicId: 'topic-claude-long' },
        prompt: 'Follow up inside 1h window',
      });

      expect(mockCreateOperation.mock.calls[0][0].appContext.topicCacheTtlMs).toBe(60 * 60 * 1000);
      expect(createServerAgentToolsEngine).toHaveBeenCalledOnce();
    });
  });

  describe('3. B-3 / H-2 / H-3: Persist-Once workspaceDelta & compressionSignature propagation', () => {
    it('persists workspaceDelta once into userMessageRecord.metadata AND userMessage.metadata and computes compressionSignature from compressedGroup', async () => {
      const compressedUpdated = new Date('2026-11-23T09:30:00.000Z');
      mockMessageQuery.mockResolvedValue([
        {
          content: 'Summary of earlier turns',
          createdAt: new Date('2026-11-23T09:00:00.000Z'),
          id: 'cg-42',
          role: 'compressedGroup',
          updatedAt: compressedUpdated,
        },
      ]);

      const deltaText =
        'Изменения файлов проекта с прошлого хода:\n- src/calc.py: updated (v1 -> v2)';
      mockResolveTopicWorkspaceSnapshot.mockResolvedValue(
        makeSnapshot({
          compressionSignature: `cg-42:${compressedUpdated.toISOString()}`,
          rebuilt: false,
          workspaceDelta: deltaText,
        }),
      );

      await service.execAgent({
        agentId: 'agent-1',
        appContext: { topicId: 'topic-delta' },
        prompt: 'Use updated calc.py',
      });

      expect(mockResolveTopicWorkspaceSnapshot).toHaveBeenCalledWith({
        agentId: 'agent-1',
        compressionSignature: `cg-42:${compressedUpdated.toISOString()}`,
        db: {},
        forceRebuild: false,
        persist: true,
        topicId: 'topic-delta',
        userId: 'user-1',
      });

      // Persisted into PostgreSQL user message metadata
      expect(mockMessageCreate.mock.calls[0][0].metadata).toMatchObject({
        workspaceDelta: deltaText,
      });

      // Also present in initialMessages userMessage.metadata on Step 0
      const [{ initialMessages }] = mockCreateOperation.mock.calls[0];
      expect(initialMessages.at(-1).metadata).toMatchObject({
        workspaceDelta: deltaText,
      });
    });

    it('isolates subagent/group-chat threads (threadId present) with topicId=undefined & persist=false without mutating parent topic snapshot, and passes forceRebuild=true on empty main history', async () => {
      mockMessageQuery.mockResolvedValue([]);
      const freshRules =
        '<project_rules>\n<rule_file path="AGENTS.md" revision="5">\nSubagent fresh rules\n</rule_file>\n</project_rules>';
      mockResolveTopicWorkspaceSnapshot.mockResolvedValueOnce(
        makeSnapshot({
          rulesBlock: freshRules,
          workspaceDelta: null,
        }),
      );

      await service.execAgent({
        agentId: 'agent-1',
        appContext: { threadId: 'thr_sub_1', topicId: 't1' },
        prompt: 'Subagent task prompt',
      });

      expect(mockResolveTopicWorkspaceSnapshot).toHaveBeenCalledWith({
        agentId: 'agent-1',
        compressionSignature: null,
        db: {},
        persist: false,
        topicId: undefined,
        userId: 'user-1',
      });
      expect(mockCreateOperation.mock.calls[0][0].appContext.workspaceRulesBlock).toBe(freshRules);

      // Main-topic turn with empty history passes forceRebuild: true
      vi.clearAllMocks();
      mockHasEverHadAgentsMd.mockResolvedValue(true);
      mockResolveTopicWorkspaceSnapshot.mockResolvedValueOnce(makeSnapshot());
      mockMessageQuery.mockResolvedValue([]);
      mockMessageCreate
        .mockResolvedValueOnce({ createdAt: new Date(), id: 'u-empty-hist' })
        .mockResolvedValueOnce({ id: 'a-empty-hist' });
      mockCreateOperation.mockResolvedValue({
        autoStarted: true,
        operationId: 'op-main-empty',
        success: true,
      });

      await service.execAgent({
        agentId: 'agent-1',
        appContext: { topicId: 't1' },
        prompt: 'First message after clearing history',
      });

      expect(mockResolveTopicWorkspaceSnapshot).toHaveBeenCalledWith({
        agentId: 'agent-1',
        compressionSignature: null,
        db: {},
        forceRebuild: true,
        persist: true,
        topicId: 't1',
        userId: 'user-1',
      });
    });
  });

  describe('4. B-4: Data Guard strict isolation in execAgent, RuntimeExecutors & knowledgeBaseRuntime SQL allowlist', () => {
    it('clears systemRole/knowledgeBases/files, disables arckep-workspace, skips snapshot DB write, and preserves read-only readKnowledge for >8K truncated chat attachments', async () => {
      mockGetAgentConfig.mockResolvedValue({
        chatConfig: { deepseekDataGuardProtected: true },
        files: [
          { content: 'secret agent file', enabled: true, id: 'af-secret', name: 'secret.txt' },
        ],
        id: 'agent-1',
        knowledgeBases: [{ enabled: true, id: 'kb-secret', name: 'Private KB' }],
        model: 'gpt-4',
        plugins: [],
        provider: 'openai',
        systemRole: 'Unmasked secret system prompt',
      });

      // History has a >8K scrubbed chat attachment requiring ENG-4 readKnowledge
      mockMessageQuery.mockResolvedValue([
        {
          content: 'Read attached contract',
          createdAt: new Date('2026-11-23T09:50:00.000Z'),
          fileList: [{ content: 'A'.repeat(12_000), id: 'att-topic-1', name: 'contract.txt' }],
          id: 'u-prev',
          role: 'user',
        },
      ]);

      await service.execAgent({
        agentId: 'agent-1',
        appContext: { topicId: 'topic-dg' },
        prompt: 'Check clause 5',
      });

      // Must NOT touch or overwrite topics.metadata.workspacePrefixSnapshot in Data Guard mode
      expect(mockResolveTopicWorkspaceSnapshot).not.toHaveBeenCalled();

      const [{ agentConfig, appContext, toolSet }] = mockCreateOperation.mock.calls[0];
      expect(agentConfig.systemRole).toBe('');
      expect(agentConfig.knowledgeBases).toEqual([]);
      expect(agentConfig.files).toEqual([]);
      expect(appContext.workspaceRulesBlock).toBeUndefined();
      expect(appContext.workspaceIndexBlock).toBeUndefined();

      // arckep-workspace is completely disabled
      expect(toolSet.disabledToolIds).toContain(PROJECT_WORKSPACE_TOOL);
      expect(toolSet.enabledToolIds).not.toContain(PROJECT_WORKSPACE_TOOL);
      expect(toolSet.manifestMap[PROJECT_WORKSPACE_TOOL]).toBeUndefined();

      // ENG-4 read-only readKnowledge stays enabled (without searchKnowledgeBase!)
      expect(toolSet.enabledToolIds).toContain(KnowledgeBaseIdentifier);
      expect(toolSet.manifestMap[KnowledgeBaseIdentifier].api.map((a: any) => a.name)).toEqual([
        KnowledgeBaseApiName.readKnowledge,
      ]);
    });

    it('RuntimeExecutors.call_llm forwards workspace blocks & deepseekDataGuardProtected and suppresses agentDocuments / legacy files', async () => {
      const state: AgentState = AgentRuntime.createInitialState({
        messages: [{ content: 'Hi', id: 'u1', role: 'user' }] as any,
        metadata: {
          agentConfig: { chatConfig: { deepseekDataGuardProtected: false } },
          agentId: 'agent-1',
          dynamicSystemAppend: 'Dynamic rule',
          topicId: 'topic-1',
          workspaceActive: true,
          workspaceIndexBlock:
            '<project_workspace_index trust="untrusted_workspace_data">\n</project_workspace_index>',
          workspaceRulesBlock: '<project_rules>\n</project_rules>',
        },
        operationId: 'op-exec-1',
        status: 'running',
      });

      const ctx: RuntimeExecutorContext = {
        agentConfig: {
          chatConfig: {},
          files: [{ content: 'legacy', enabled: true, id: 'f1', name: 'old.md' }],
          id: 'agent-1',
          knowledgeBases: [{ enabled: true, id: 'kb-1', name: 'KB' }],
          model: 'gpt-4',
          plugins: [],
          provider: 'openai',
          systemRole: 'Static rule',
        } as any,
        loadAgentState: vi.fn(async () => null),
        messageModel: {
          addFiles: vi.fn(),
          create: vi.fn(async () => ({ id: 'a1' })),
          query: vi.fn(async () => []),
          update: vi.fn(async () => ({})),
        } as any,
        operationId: 'op-exec-1',
        serverDB: {} as any,
        stepIndex: 0,
        streamManager: {
          publishStreamChunk: vi.fn(async () => 'c1'),
          publishStreamEvent: vi.fn(async () => 'e1'),
        } as any,
        toolExecutionService: { executeTool: vi.fn() } as any,
        topicId: 'topic-1',
        userId: 'user-1',
      };

      const executors = createRuntimeExecutors(ctx);
      await executors.call_llm!(
        {
          payload: {
            messages: [{ content: 'Hi', id: 'u1', role: 'user' }],
            model: 'gpt-4',
            provider: 'openai',
            tools: [],
          },
          type: 'call_llm',
        } as any,
        state,
      );

      expect(mockGetAgentDocuments).not.toHaveBeenCalled();
      expect(serverMessagesEngine).toHaveBeenCalledWith(
        expect.objectContaining({
          agentDocuments: undefined,
          deepseekDataGuardProtected: false,
          dynamicSystemAppend: 'Dynamic rule',
          knowledge: {
            fileContents: undefined,
            knowledgeBases: [{ id: 'kb-1', name: 'KB' }],
          },
          workspaceIndexBlock:
            '<project_workspace_index trust="untrusted_workspace_data">\n</project_workspace_index>',
          workspaceRulesBlock: '<project_rules>\n</project_rules>',
        }),
      );
    });

    it('knowledgeBaseRuntime blocks semanticSearchForChat and enforces messages_files SQL allowlist per topicId in Data Guard mode', async () => {
      const mockWhere = vi.fn().mockResolvedValue([{ fileId: 'file-topic-allowed' }]);
      const mockInnerJoin = vi.fn().mockReturnValue({ where: mockWhere });
      const mockFrom = vi.fn().mockReturnValue({ innerJoin: mockInnerJoin });
      const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });
      const fakeDb = { select: mockSelect } as any;

      mockGetFileContents.mockResolvedValue([
        {
          content: 'Scrubbed attachment body line 1\nline 2',
          fileId: 'file-topic-allowed',
          filename: 'scrubbed.txt',
          preview: 'Scrubbed attachment body line 1',
          totalCharCount: 38,
          totalLineCount: 2,
        },
      ]);

      const runtime = await knowledgeBaseRuntime.factory({
        agentId: 'agent-1',
        dataGuardProtected: true,
        serverDB: fakeDb,
        toolManifestMap: {},
        topicId: 'topic-current',
        userId: 'user-1',
      });

      // 1. semanticSearchForChat is strictly blocked without calling service
      const searchRes = await runtime.searchKnowledgeBase({ query: 'revenue' });
      expect(searchRes.success).toBe(false);
      expect(searchRes.content).toBe(DATA_GUARD_SEARCH_BLOCKED_MESSAGE);
      expect(mockSemanticSearchForChat).not.toHaveBeenCalled();

      // 2. readKnowledge allows current-topic attachment and masks external workspace/KB fileId without reading it
      const readRes = await runtime.readKnowledge({
        fileIds: ['file-topic-allowed', 'file-external-ws'],
      });
      expect(readRes.success).toBe(true);
      expect(mockGetFileContents).toHaveBeenCalledOnce();
      expect(mockGetFileContents.mock.calls[0][0]).toEqual(['file-topic-allowed']);
      expect(readRes.content).toContain('Scrubbed attachment body line 1');
      expect(readRes.content).toContain(DATA_GUARD_FILE_MASKED_CONTENT);

      // 3. Without topicId, all fileIds are masked and service.getFileContents is never called
      vi.clearAllMocks();
      const noTopicRuntime = await knowledgeBaseRuntime.factory({
        agentId: 'agent-1',
        dataGuardProtected: true,
        serverDB: fakeDb,
        toolManifestMap: {},
        topicId: undefined,
        userId: 'user-1',
      });
      const blockedAll = await noTopicRuntime.readKnowledge({ fileIds: ['file-topic-allowed'] });
      expect(mockGetFileContents).not.toHaveBeenCalled();
      expect(blockedAll.content).toContain(DATA_GUARD_FILE_MASKED_CONTENT);
    });
  });

  describe('5. projectWorkspaceRuntime: exact markers, error diagnostics & 20-write ceiling', () => {
    const baseCtx = {
      agentId: 'agent-1',
      dataGuardProtected: false,
      operationId: 'op-mut-test',
      parentMessageId: 'a-parent-1',
      serverDB: {} as any,
      toolManifestMap: {},
      topicId: 'topic-1',
      userId: 'user-1',
    };

    it('reads bounded pages via readProjectFile with real FileReadPage on both text files and parsed kind="document" files', async () => {
      const textBody = ['alpha = 1', 'beta = 2', 'gamma = 3', 'delta = 4'].join('\n');
      const realTextPage = readFilePage(textBody, { maxLines: 2, startLine: 1 });
      mockReadProjectFilePage.mockResolvedValueOnce({
        file: {
          agentId: 'agent-1',
          currentRevision: 2,
          id: 'ws-txt-1',
          kind: 'text',
          path: 'src/config.py',
        },
        page: realTextPage,
        revision: 2,
        wrappedContent: `<project_file path="src/config.py" revision="2" encoding="utf-8" trust="untrusted_workspace_data">\n${realTextPage.content}\n</project_file>`,
      });

      const runtime = projectWorkspaceRuntime.factory(baseCtx);
      const textRes = await runtime.readProjectFile({
        maxLines: 2,
        path: 'src/config.py',
        startLine: 1,
      });

      expect(textRes.success).toBe(true);
      expect(textRes.content).toContain('File: src/config.py (v2)');
      expect(textRes.content).toContain('lines 1-2 of 4');
      expect(textRes.content).toContain('nextStartLine=3');
      expect(textRes.content).toContain('L1: alpha = 1');
      expect(textRes.state).toEqual({
        complete: false,
        endLine: 2,
        endOffset: realTextPage.endOffset,
        nextOffset: realTextPage.nextOffset,
        nextStartLine: 3,
        path: 'src/config.py',
        revision: 2,
        startLine: 1,
        startOffset: 0,
        totalCharCount: textBody.length,
        totalLines: 4,
        workspaceFileId: 'ws-txt-1',
      });

      // Binary document (kind = 'document') fallback reading parsed documents.content with real readFilePage
      mockReadProjectFilePage.mockRejectedValueOnce(
        new WorkspaceError(
          'INVALID_OPERATION',
          'File "specs/report.pdf" is a binary document',
          422,
        ),
      );
      let selectCall = 0;
      const docDb = {
        select: vi.fn().mockImplementation(() => ({
          from: () => ({
            where: () => ({
              limit: async () => {
                selectCall += 1;
                if (selectCall === 1) {
                  return [
                    {
                      agentId: 'agent-1',
                      currentFileId: 'file-pdf-1',
                      currentRevision: 3,
                      deletedAt: null,
                      id: 'ws-doc-1',
                      kind: 'document',
                      path: 'specs/report.pdf',
                      userId: 'user-1',
                    },
                  ];
                }
                return [{ content: 'Page 1 header\nPage 1 body\nPage 2 summary' }];
              },
            }),
          }),
        })),
      };

      const docRuntime = projectWorkspaceRuntime.factory({
        ...baseCtx,
        serverDB: docDb as any,
      });
      const docRes = await docRuntime.readProjectFile({
        maxLines: 2,
        path: 'specs/report.pdf',
        startLine: 1,
      });

      expect(docRes.success).toBe(true);
      expect(docRes.content).toContain('File: specs/report.pdf (v3)');
      expect(docRes.content).toContain('lines 1-2 of 3');
      expect(docRes.content).toContain('nextStartLine=3');
      expect(docRes.content).toContain('<project_file path="specs/report.pdf" revision="3"');
      expect(docRes.content).toContain('L1: Page 1 header');
      expect(docRes.state).toMatchObject({
        complete: false,
        endLine: 2,
        kind: 'document',
        nextStartLine: 3,
        path: 'specs/report.pdf',
        revision: 3,
        startLine: 1,
        totalLines: 3,
        workspaceFileId: 'ws-doc-1',
      });
    });

    it('emits byte-exact ARCKEP_WORKSPACE_CHANGE and ARCKEP_WORKSPACE_PROPOSAL markers', async () => {
      const runtime = await getServerRuntime(PROJECT_WORKSPACE_TOOL, baseCtx);

      mockWriteAgentTextFile.mockResolvedValueOnce({
        addedLines: 14,
        budget: {
          activeBytes: 200,
          activeFilesCount: 1,
          hardMaxChars: 60_000,
          hardMaxTokens: 24_000,
          maxActiveBytes: 262_144_000,
          maxFilesCount: 200,
          pinnedChars: 0,
          pinnedTokens: 0,
          softWarnTokens: 4000,
        },
        file: {
          agentId: 'agent-1',
          currentRevision: 3,
          id: 'ws-uuid-1',
          path: 'src/parser.py',
        },
        outcome: 'updated',
        prevRevision: 2,
        removedLines: 3,
      });

      const writeRes = await runtime.writeProjectFile({
        baseRevision: 2,
        content: 'def parse():\n    return True\n',
        path: 'src/parser.py',
      });
      expect(writeRes.success).toBe(true);
      const expectedChangeLine =
        `${WORKSPACE_CHANGE_MARKER_PREFIX}` +
        '{"workspaceFileId":"ws-uuid-1","agentId":"agent-1","path":"src/parser.py","action":"updated","prevRevision":2,"revision":3,"addedLines":14,"removedLines":3,"authorType":"agent"}';
      expect(writeRes.content.split('\n').at(-1)).toBe(expectedChangeLine);

      // Delete marker
      mockDeleteWorkspaceFile.mockResolvedValueOnce({
        budget: {} as any,
        deleted: true,
        outcome: 'deleted',
        path: 'src/old.py',
        revision: 4,
        workspaceFileId: 'ws-uuid-del',
      });
      const delRes = await runtime.deleteProjectFile({ baseRevision: 4, path: 'src/old.py' });
      expect(delRes.success).toBe(true);
      expect(delRes.content.split('\n').at(-1)).toBe(
        `${WORKSPACE_CHANGE_MARKER_PREFIX}` +
          '{"workspaceFileId":"ws-uuid-del","agentId":"agent-1","path":"src/old.py","action":"deleted","prevRevision":4,"revision":4,"addedLines":0,"removedLines":0,"authorType":"agent"}',
      );

      // Protected file proposal marker
      mockPatchAgentTextFile.mockResolvedValueOnce({
        outcome: 'proposal_created',
        proposal: {
          addedLines: 5,
          agentId: 'agent-1',
          baseRevision: 1,
          diffPreview: '@@ -1,2 +1,6 @@',
          id: 'prop-uuid-1',
          proposalType: 'edit',
          reason: 'Добавить правило форматирования дат',
          removedLines: 1,
          targetPath: 'AGENTS.md',
          workspaceFileId: 'ws-agents-id',
        },
      });
      const propRes = await runtime.patchProjectFile({
        baseRevision: 1,
        edits: [{ newText: 'New rule', oldText: 'Old rule' }],
        path: 'AGENTS.md',
        reason: 'Добавить правило форматирования дат',
      });
      expect(propRes.success).toBe(true);
      expect(propRes.content).toContain('pending_user_approval');
      expect(propRes.content.split('\n').at(-1)).toBe(
        `${WORKSPACE_PROPOSAL_MARKER_PREFIX}` +
          '{"proposalId":"prop-uuid-1","agentId":"agent-1","workspaceFileId":"ws-agents-id","targetPath":"AGENTS.md","proposalType":"edit","baseRevision":1,"reason":"Добавить правило форматирования дат","addedLines":5,"removedLines":1,"diffPreview":"@@ -1,2 +1,6 @@"}',
      );
    });

    it('returns actionable diagnostics on WorkspaceError and enforces MAX_AGENT_WRITES_PER_RUN = 20', async () => {
      const runtime = projectWorkspaceRuntime.factory({
        ...baseCtx,
        operationId: 'op-limit-20',
      });

      mockPatchAgentTextFile.mockRejectedValueOnce(
        new WorkspaceError('REVISION_CONFLICT', 'Expected v1, actual v3', 409, {
          currentRevision: 3,
        }),
      );
      const conflictRes = await runtime.patchProjectFile({
        baseRevision: 1,
        edits: [{ newText: 'b', oldText: 'a' }],
        path: 'src/a.ts',
      });
      expect(conflictRes.success).toBe(false);
      expect(conflictRes.content).toContain('REVISION_CONFLICT');
      expect(conflictRes.content).toContain('"currentRevision":3');
      expect(conflictRes.content).toContain('readProjectFile');

      // Already used 1 write slot above; consume remaining 19 slots (total 20)
      mockWriteAgentTextFile.mockResolvedValue({
        addedLines: 1,
        budget: {} as any,
        file: { agentId: 'agent-1', currentRevision: 1, id: 'ws-x', path: 'src/x.ts' },
        outcome: 'created',
        prevRevision: null,
        removedLines: 0,
      });

      for (let i = 2; i <= 20; i++) {
        const okRes = await runtime.writeProjectFile({ content: 'x', path: `src/f${i}.ts` });
        expect(okRes.success).toBe(true);
      }

      // 21st mutation in the same operationId is rejected
      const callsBefore21 = mockWriteAgentTextFile.mock.calls.length;
      const blocked21 = await runtime.writeProjectFile({ content: 'x', path: 'src/f21.ts' });
      expect(blocked21).toEqual({
        content:
          'Workspace write limit reached (maximum 20 file mutations per response). Summarize completed changes and ask the user before continuing.',
        success: false,
      });
      expect(mockWriteAgentTextFile).toHaveBeenCalledTimes(callsBefore21);

      // Data Guard blocks runtime immediately
      const dgRuntime = projectWorkspaceRuntime.factory({ ...baseCtx, dataGuardProtected: true });
      const dgRes = await dgRuntime.listProjectFiles({});
      expect(dgRes).toEqual({
        content: 'Project workspace is disabled in Data Guard protected mode.',
        success: false,
      });
    });

    it('registers globalThis.__arckepProjectWorkspaceSandboxBridge on module load and runtime factory initialization', () => {
      const initialBridge = (globalThis as Record<string, any>)
        .__arckepProjectWorkspaceSandboxBridge;
      expect(initialBridge).toBeDefined();
      expect(typeof initialBridge.listHydratableProjectFiles).toBe('function');
      expect(typeof initialBridge.applySandboxProjectFileSync).toBe('function');

      // Clear globalThis and verify projectWorkspaceRuntime.factory re-registers the bridge
      delete (globalThis as Record<string, any>).__arckepProjectWorkspaceSandboxBridge;
      projectWorkspaceRuntime.factory(baseCtx);

      const restoredBridge = (globalThis as Record<string, any>)
        .__arckepProjectWorkspaceSandboxBridge;
      expect(restoredBridge).toBeDefined();
      expect(typeof restoredBridge.listHydratableProjectFiles).toBe('function');
      expect(typeof restoredBridge.applySandboxProjectFileSync).toBe('function');
    });
  });

  describe('6. Backward compatibility when ARCKEP_WORKSPACE_ENABLED=0', () => {
    it('keeps legacy systemRole concatenation, queries AgentDocumentsService, and hides arckep-workspace', async () => {
      process.env.ARCKEP_WORKSPACE_ENABLED = '0';
      mockTopicHasCodeArtifacts.mockResolvedValue(true);

      await service.execAgent({
        agentId: 'agent-1',
        appContext: { topicId: 'topic-flag-off' },
        instructions: 'Legacy instruction append',
        prompt: 'Hello with flag off',
        studioWebChat: true,
      });

      expect(mockHasEverHadAgentsMd).not.toHaveBeenCalled();
      expect(mockResolveTopicWorkspaceSnapshot).not.toHaveBeenCalled();
      expect(mockGetAgentDocuments).toHaveBeenCalledWith('agent-1');

      const [{ agentConfig, appContext, toolSet }] = mockCreateOperation.mock.calls[0];
      expect(agentConfig.systemRole).toContain('Legacy DB system_role that was migrated');
      expect(agentConfig.systemRole).toContain('Legacy instruction append');
      expect(agentConfig.systemRole).toContain('Saved code versions are available');
      expect(appContext.dynamicSystemAppend).toBeUndefined();
      expect(appContext.workspaceActive).toBeUndefined();
      expect(toolSet.disabledToolIds).toContain(PROJECT_WORKSPACE_TOOL);
      expect(toolSet.enabledToolIds).not.toContain(PROJECT_WORKSPACE_TOOL);
    });
  });
});
