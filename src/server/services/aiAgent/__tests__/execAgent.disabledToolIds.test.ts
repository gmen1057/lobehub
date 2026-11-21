// @vitest-environment node
import type * as ModelBankModule from 'model-bank';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InMemoryAgentStateManager } from '@/server/modules/AgentRuntime/InMemoryAgentStateManager';
import { InMemoryStreamEventManager } from '@/server/modules/AgentRuntime/InMemoryStreamEventManager';
import { createServerAgentToolsEngine } from '@/server/modules/Mecha';
import type * as AgentRuntimeModule from '@/server/services/agentRuntime';

import { AiAgentService } from '../index';

const { mockCreateOperation, mockGetAgentConfig, mockMessageCreate } = vi.hoisted(() => ({
  mockCreateOperation: vi.fn(),
  mockGetAgentConfig: vi.fn(),
  mockMessageCreate: vi.fn(),
}));

vi.mock('@/libs/trusted-client', () => ({
  generateTrustedClientToken: vi.fn().mockReturnValue(undefined),
  getTrustedClientTokenForSession: vi.fn().mockResolvedValue(undefined),
  isTrustedClientEnabled: vi.fn().mockReturnValue(false),
}));

vi.mock('@/database/models/message', () => ({
  MessageModel: vi.fn().mockImplementation(() => ({
    create: mockMessageCreate,
    query: vi.fn().mockResolvedValue([]),
    update: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock('@/database/models/agent', () => ({
  AgentModel: vi.fn().mockImplementation(() => ({
    getAgentConfig: vi.fn(),
  })),
}));

vi.mock('@/database/models/agentSkill', () => ({
  AgentSkillModel: vi.fn().mockImplementation(() => ({
    findAll: vi.fn().mockResolvedValue({ data: [] }),
  })),
}));

vi.mock('@/server/services/agent', () => ({
  AgentService: vi.fn().mockImplementation(() => ({
    getAgentConfig: mockGetAgentConfig,
  })),
}));

vi.mock('@/server/services/agentDocuments', () => ({
  AgentDocumentsService: vi.fn().mockImplementation(() => ({
    getAgentDocuments: vi.fn().mockResolvedValue([]),
  })),
}));

vi.mock('@/database/models/plugin', () => ({
  PluginModel: vi.fn().mockImplementation(() => ({
    query: vi.fn().mockResolvedValue([]),
  })),
}));

vi.mock('@/database/models/topic', () => ({
  TopicModel: vi.fn().mockImplementation(() => ({
    create: vi.fn().mockResolvedValue({ id: 'topic-1' }),
    findById: vi.fn().mockResolvedValue({ id: 'topic-1', userId: 'test-user-id' }),
  })),
}));

vi.mock('@/database/models/thread', () => ({
  ThreadModel: vi.fn().mockImplementation(() => ({
    create: vi.fn(),
    findById: vi.fn(),
    update: vi.fn(),
  })),
}));

vi.mock('@/server/services/agentRuntime', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentRuntimeModule>();
  return {
    ...actual,
    AgentRuntimeService: vi.fn().mockImplementation(() => ({
      createOperation: mockCreateOperation,
    })),
    RealAgentRuntimeService: actual.AgentRuntimeService,
  };
});

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

vi.mock('@/server/services/file', () => ({
  FileService: vi.fn().mockImplementation(() => ({
    getFullFileUrl: vi.fn().mockResolvedValue('https://s3/file'),
  })),
}));

vi.mock('@/server/services/document', () => ({
  DocumentService: vi.fn().mockImplementation(() => ({
    parseFile: vi.fn(),
  })),
}));

vi.mock('@/server/modules/Mecha', () => ({
  createServerAgentToolsEngine: vi.fn(),
  serverMessagesEngine: vi.fn().mockResolvedValue([{ content: 'test', role: 'user' }]),
}));

vi.mock('@/server/services/toolExecution/deviceProxy', () => ({
  deviceProxy: {
    isConfigured: false,
    queryDeviceList: vi.fn().mockResolvedValue([]),
  },
}));

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
    ],
  };
});

describe('AiAgentService.execAgent — disabledToolIds invariant & securityBlacklist wiring', () => {
  let service: AiAgentService;

  const manifest = (identifier: string) => ({
    api: [{ description: identifier, name: 'run', parameters: { properties: {}, type: 'object' } }],
    identifier,
    meta: { title: identifier },
    type: 'builtin',
  });

  const baseConfig = (overrides: Record<string, unknown> = {}) => ({
    chatConfig: { historyCount: 8 },
    id: 'agent-1',
    knowledgeBases: [],
    model: 'gpt-4',
    params: {},
    plugins: ['mcp-arckep-studio-image', 'lobe-notebook', 'mcp-arckep-wordstat'],
    provider: 'openai',
    slug: 'my-agent',
    systemRole: 'You are a helpful assistant.',
    ...overrides,
  });

  const runExecAgent = async (
    config: Record<string, unknown> = {},
    params: Record<string, unknown> = {},
  ) => {
    const engine = {
      addPluginManifest: vi.fn(),
      generateToolsDetailed: vi.fn().mockReturnValue({
        enabledManifests: [manifest('lobe-activator')],
        enabledToolIds: ['lobe-activator'],
        tools: [],
      }),
      getEnabledPluginManifests: vi.fn().mockReturnValue(new Map()),
      getPluginManifest: vi.fn((id: string) => manifest(id)),
    };
    vi.mocked(createServerAgentToolsEngine).mockReturnValueOnce(engine as any);
    mockGetAgentConfig.mockResolvedValueOnce(baseConfig(config));

    await service.execAgent({ agentId: 'agent-1', prompt: 'Помоги с задачей', ...params });
    return mockCreateOperation.mock.calls[0][0];
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('ARCKEP_CHAT_CRON', '');
    mockMessageCreate.mockResolvedValue({ id: 'msg-1' });
    mockCreateOperation.mockResolvedValue({
      autoStarted: true,
      messageId: 'queue-msg-1',
      operationId: 'op-123',
      success: true,
    });
    service = new AiAgentService({} as any, 'test-user-id');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('includes excludedPluginIds, hidden legacy arckep-studio and hidden lobe-cron in disabledToolIds, and NEVER includes lazyToolIds', async () => {
    const createArgs = await runExecAgent({}, { excludePluginIds: ['lobe-artifacts'] });
    const disabledToolIds: string[] = createArgs.toolSet.disabledToolIds;
    const manifestIds = Object.keys(createArgs.toolSet.manifestMap);

    // Truly hidden / disabled tools MUST be in disabledToolIds
    expect(disabledToolIds).toContain('lobe-artifacts');
    expect(disabledToolIds).toContain('arckep-studio');
    expect(disabledToolIds).toContain('lobe-cron');
    expect(disabledToolIds).toContain('lobe-page-agent');
    expect(disabledToolIds).toContain('lobe-message');
    expect(disabledToolIds).toContain('arckep-text-file');

    // Lazy / deferred tools MUST be in manifestMap for discovery AND NEVER in disabledToolIds
    for (const lazyId of [
      'lobe-knowledge-base',
      'lobe-topic-reference',
      'mcp-arckep-studio-image',
      'lobe-notebook',
      'mcp-arckep-wordstat',
    ]) {
      expect(manifestIds, `${lazyId} should stay discoverable in manifestMap`).toContain(lazyId);
      expect(disabledToolIds, `${lazyId} must NEVER be in disabledToolIds`).not.toContain(lazyId);
    }
  });

  it('keeps arckep-text-file out of disabledToolIds when deferred as lazy in studioWebChat', async () => {
    const createArgs = await runExecAgent(
      {},
      { studioTextFilesEnabled: true, studioWebChat: true },
    );
    const disabledToolIds: string[] = createArgs.toolSet.disabledToolIds;
    const manifestIds = Object.keys(createArgs.toolSet.manifestMap);

    expect(manifestIds).toContain('arckep-text-file');
    expect(disabledToolIds).not.toContain('arckep-text-file');
  });

  it('forwards securityBlacklist and userInterventionConfig through execAgent into AgentRuntimeService initialState', async () => {
    const createArgs = await runExecAgent(
      {},
      {
        securityBlacklist: [],
        userInterventionConfig: { approvalMode: 'auto-run' },
      },
    );

    expect(createArgs.securityBlacklist).toEqual([]);
    expect(createArgs.userInterventionConfig).toEqual({ approvalMode: 'auto-run' });

    // Also verify real AgentRuntimeService.createOperation persists securityBlacklist onto state
    const runtimeMod = (await import('@/server/services/agentRuntime')) as any;
    const RealAgentRuntimeService = runtimeMod.RealAgentRuntimeService;
    const stateManager = new InMemoryAgentStateManager();
    const streamEventManager = new InMemoryStreamEventManager();
    const realRuntime = new RealAgentRuntimeService({} as any, 'test-user-id', {
      coordinatorOptions: { stateManager, streamEventManager },
      queueService: null,
      streamEventManager,
    });

    await realRuntime.createOperation({
      appContext: { agentId: 'agent-1', topicId: 'topic-1' },
      autoStart: false,
      initialContext: { payload: {}, phase: 'user_input', session: {} as any },
      initialMessages: [],
      operationId: 'op-real-blacklist-check',
      securityBlacklist: [],
      toolSet: createArgs.toolSet,
      userId: 'test-user-id',
      userInterventionConfig: { approvalMode: 'auto-run' },
    });

    const savedState = await stateManager.loadAgentState('op-real-blacklist-check');
    expect(savedState?.securityBlacklist).toEqual([]);
    expect(savedState?.userInterventionConfig).toEqual({ approvalMode: 'auto-run' });
    expect(savedState?.operationToolSet?.disabledToolIds).toEqual(
      createArgs.toolSet.disabledToolIds,
    );
  });
});
