import type * as ModelBankModule from 'model-bank';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createServerAgentToolsEngine } from '@/server/modules/Mecha';

import { AiAgentService, DEFAULT_CHAT_MAX_STEPS } from '../index';

const {
  mockCreateOperation,
  mockFindCronJob,
  mockFindPlugin,
  mockGetAgentConfig,
  mockMessageCreate,
} = vi.hoisted(() => ({
  mockCreateOperation: vi.fn(),
  mockFindCronJob: vi.fn(),
  mockFindPlugin: vi.fn(),
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

vi.mock('@/database/models/agentCronJob', () => ({
  AgentCronJobModel: vi.fn().mockImplementation(() => ({
    findById: mockFindCronJob,
  })),
}));

vi.mock('@/server/services/agent', () => ({
  AgentService: vi.fn().mockImplementation(() => ({
    getAgentConfig: mockGetAgentConfig,
  })),
}));

vi.mock('@/database/models/plugin', () => ({
  PluginModel: vi.fn().mockImplementation(() => ({
    findById: mockFindPlugin,
    query: vi.fn().mockResolvedValue([]),
  })),
}));

vi.mock('@/database/models/topic', () => ({
  TopicModel: vi.fn().mockImplementation(() => ({
    create: vi.fn().mockResolvedValue({ id: 'topic-1' }),
  })),
}));

vi.mock('@/database/models/thread', () => ({
  ThreadModel: vi.fn().mockImplementation(() => ({
    create: vi.fn(),
    findById: vi.fn(),
    update: vi.fn(),
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

describe('AiAgentService.execAgent — default maxSteps', () => {
  let service: AiAgentService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockMessageCreate.mockResolvedValue({ id: 'msg-1' });
    mockCreateOperation.mockResolvedValue({
      autoStarted: true,
      messageId: 'queue-msg-1',
      operationId: 'op-123',
      success: true,
    });
    mockFindCronJob.mockResolvedValue({ cronPattern: '0 9 * * *', id: 'cron_1', name: 'Cron' });
    mockFindPlugin.mockResolvedValue(undefined);
    mockGetAgentConfig.mockResolvedValue({
      chatConfig: { historyCount: 8 },
      id: 'agent-1',
      knowledgeBases: [],
      model: 'gpt-4',
      params: {},
      plugins: [],
      provider: 'openai',
      slug: 'my-agent',
      systemRole: 'You are a helpful assistant.',
    });
    vi.mocked(createServerAgentToolsEngine).mockImplementation(
      () =>
        ({
          generateToolsDetailed: vi.fn().mockReturnValue({
            enabledManifests: [],
            enabledToolIds: [],
            tools: [],
          }),
          getEnabledPluginManifests: vi.fn().mockReturnValue(new Map()),
          getPluginManifest: vi.fn(),
        }) as any,
    );
    service = new AiAgentService({} as any, 'test-user-id');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('exports DEFAULT_CHAT_MAX_STEPS = 60 and applies it when maxSteps is omitted', async () => {
    expect(DEFAULT_CHAT_MAX_STEPS).toBe(60);

    await service.execAgent({ agentId: 'agent-1', prompt: 'Run multi-step task' });

    expect(mockCreateOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        maxSteps: 60,
      }),
    );
  });

  it('preserves an explicitly provided maxSteps value', async () => {
    await service.execAgent({ agentId: 'agent-1', maxSteps: 15, prompt: 'Run short task' });

    expect(mockCreateOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        maxSteps: 15,
      }),
    );
  });

  it('applies DEFAULT_CHAT_MAX_STEPS for cron and bot invocations when maxSteps is not passed', async () => {
    await service.execAgent({
      agentId: 'agent-1',
      cronJobId: 'cron_1',
      prompt: 'Scheduled task',
      trigger: 'cron',
    });
    expect(mockCreateOperation).toHaveBeenLastCalledWith(
      expect.objectContaining({
        maxSteps: DEFAULT_CHAT_MAX_STEPS,
      }),
    );

    await service.execAgent({
      agentId: 'agent-1',
      botContext: { botProviderId: 'bot-1', endUserRef: 'tg:1', platform: 'telegram' } as any,
      prompt: 'Bot message',
    });
    expect(mockCreateOperation).toHaveBeenLastCalledWith(
      expect.objectContaining({
        maxSteps: DEFAULT_CHAT_MAX_STEPS,
      }),
    );
  });
});
