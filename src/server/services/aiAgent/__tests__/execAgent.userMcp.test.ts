import type * as ModelBankModule from 'model-bank';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createServerAgentToolsEngine } from '@/server/modules/Mecha';

import { AiAgentService } from '../index';

// arckep (19.10.2026, этап 3 «свои инструменты»): свои подключения человека `umcp-*` доступны модели так же,
// как установленные подключения шлюза: помощнику включено, грузится по требованию (activateTools), «Подключения»
// (arckep-connectors) — ленивый встроенный инструмент безголового движка; тема помечается, как только чужой
// инструмент включён сразу.

const {
  mockMarkIfUserMcp,
  mockCreateOperation,
  mockGetAgentConfig,
  mockMessageCreate,
  mockIngestAttachment,
  mockParseFile,
  mockMessageQuery,
  mockPluginQuery,
} = vi.hoisted(() => ({
  mockMarkIfUserMcp: vi.fn(),
  mockCreateOperation: vi.fn(),
  mockGetAgentConfig: vi.fn(),
  mockIngestAttachment: vi.fn(),
  mockMessageCreate: vi.fn(),
  mockMessageQuery: vi.fn(),
  mockParseFile: vi.fn(),
  mockPluginQuery: vi.fn(),
}));

vi.mock('@/libs/trusted-client', () => ({
  generateTrustedClientToken: vi.fn().mockReturnValue(undefined),
  getTrustedClientTokenForSession: vi.fn().mockResolvedValue(undefined),
  isTrustedClientEnabled: vi.fn().mockReturnValue(false),
}));

vi.mock('@/database/models/message', () => ({
  MessageModel: vi.fn().mockImplementation(() => ({
    create: mockMessageCreate,
    query: mockMessageQuery,
    update: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock('@/database/models/agent', () => ({
  AgentModel: vi.fn().mockImplementation(() => ({
    getAgentConfig: vi.fn(),
  })),
}));

vi.mock('@/server/services/agent', () => ({
  AgentService: vi.fn().mockImplementation(() => ({
    getAgentConfig: mockGetAgentConfig,
  })),
}));

vi.mock('@/database/models/plugin', () => ({
  PluginModel: vi.fn().mockImplementation(() => ({
    query: mockPluginQuery,
  })),
}));

vi.mock('@/database/models/topic', () => ({
  TopicModel: vi.fn().mockImplementation(() => ({
    create: vi.fn().mockResolvedValue({ id: 'topic-1' }),
    // arckep: тема из appContext должна быть этого человека (assertTopicAccess) — в тестах она есть
    findById: vi.fn().mockImplementation(async (id: string) => ({ id })),
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
    getFullFileUrl: vi
      .fn()
      .mockImplementation((key: string) => Promise.resolve(`https://s3/${key}`)),
  })),
}));

vi.mock('@/server/services/document', () => ({
  DocumentService: vi.fn().mockImplementation(() => ({
    parseFile: mockParseFile,
  })),
}));

vi.mock('../ingestAttachment', () => ({
  ingestAttachment: mockIngestAttachment,
}));

vi.mock('@/server/modules/Mecha', () => ({
  createServerAgentToolsEngine: vi.fn().mockReturnValue({
    generateToolsDetailed: vi.fn().mockReturnValue({ enabledToolIds: [], tools: [] }),
    getEnabledPluginManifests: vi.fn().mockReturnValue(new Map()),
  }),
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

vi.mock('@/server/services/toolExecution/topicTrust', () => ({
  markTopicIfUserMcp: mockMarkIfUserMcp,
}));

const UMCP = 'umcp-abcdefghijkl';

describe('AiAgentService.execAgent — arckep: свои подключения umcp-* и поиск подключений', () => {
  let service: AiAgentService;
  const env = { ...process.env };

  const agentConfig = (plugins: string[]) => ({
    chatConfig: { historyCount: 8, searchMode: 'auto' },
    id: 'agent-1',
    model: 'gpt-4',
    params: { temperature: 1, top_p: 1 },
    plugins,
    provider: 'openai',
    slug: 'my-agent',
    systemRole: 'You are a helpful assistant.',
  });

  const generateArgs = () => {
    const toolsEngine = vi.mocked(createServerAgentToolsEngine).mock.results[0].value;
    return toolsEngine.generateToolsDetailed.mock.calls[0][0];
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ARCKEP_HEADLESS_TOOLS = '1';
    mockMessageCreate.mockResolvedValue({ id: 'msg-1' });
    mockCreateOperation.mockResolvedValue({
      autoStarted: true,
      messageId: 'queue-msg-1',
      operationId: 'op-123',
      success: true,
    });
    mockPluginQuery.mockResolvedValue([]);
    mockMessageQuery.mockResolvedValue([]);
    mockMarkIfUserMcp.mockResolvedValue(undefined);
    mockGetAgentConfig.mockResolvedValue(agentConfig([UMCP, 'lobe-user-memory']));
    service = new AiAgentService({} as any, 'test-user-id');
  });

  afterEach(() => {
    process.env = { ...env };
  });

  it('своё подключение включено у помощника — по требованию: в первом шаге его схем нет', async () => {
    await service.execAgent({ agentId: 'agent-1', prompt: 'Привет' });

    expect(generateArgs().toolIds).not.toContain(UMCP);
    expect(generateArgs().excludeDefaultToolIds).toContain(UMCP);
    expect(mockMarkIfUserMcp).toHaveBeenCalledWith(expect.anything(), 'test-user-id', 'topic-1', []);
  });

  it('выбрано на сообщение — включено сразу, и тема помечается до ответа модели', async () => {
    vi.mocked(createServerAgentToolsEngine).mockReturnValueOnce({
      generateToolsDetailed: vi.fn().mockReturnValue({ enabledToolIds: [UMCP], tools: [] }),
      getEnabledPluginManifests: vi.fn().mockReturnValue(new Map()),
    } as any);
    await service.execAgent({
      agentId: 'agent-1',
      additionalPluginIds: [UMCP],
      prompt: 'Привет',
    });

    expect(generateArgs().toolIds).toContain(UMCP);
    expect(generateArgs().excludeDefaultToolIds ?? []).not.toContain(UMCP);
    expect(mockMarkIfUserMcp).toHaveBeenCalledWith(expect.anything(), 'test-user-id', 'topic-1', [UMCP]);
  });

  it('выключено человеком на сообщение (disabled_tools) — в набор движка не попадает', async () => {
    await service.execAgent({ agentId: 'agent-1', excludePluginIds: [UMCP], prompt: 'Привет' });

    expect(generateArgs().toolIds).not.toContain(UMCP);
    const enginePlugins: string[] =
      vi.mocked(createServerAgentToolsEngine).mock.calls[0][1].agentConfig?.plugins ?? [];
    expect(enginePlugins).not.toContain(UMCP);
  });

  it('«Подключения» (arckep-connectors) — ленивый инструмент безголового движка, у ботов его нет', async () => {
    await service.execAgent({ agentId: 'agent-1', prompt: 'Привет' });
    expect(generateArgs().excludeDefaultToolIds).toContain('arckep-connectors');
    expect(generateArgs().toolIds).not.toContain('arckep-connectors');

    vi.clearAllMocks();
    mockMessageCreate.mockResolvedValue({ id: 'msg-1' });
    mockCreateOperation.mockResolvedValue({ autoStarted: true, messageId: 'q', operationId: 'op', success: true });
    mockGetAgentConfig.mockResolvedValue(agentConfig([UMCP]));
    await service.execAgent({
      agentId: 'agent-1',
      botContext: { botProviderId: 'bot-1', endUserRef: 'tg:1', platform: 'telegram' } as any,
      prompt: 'Привет',
    });
    expect(generateArgs().excludeDefaultToolIds ?? []).not.toContain('arckep-connectors');
  });

  it('вне безголового режима «Подключения» не предлагаются (экрана с карточками нет)', async () => {
    delete process.env.ARCKEP_HEADLESS_TOOLS;
    await service.execAgent({ agentId: 'agent-1', prompt: 'Привет' });
    expect(generateArgs().excludeDefaultToolIds ?? []).not.toContain('arckep-connectors');
  });
});
