import type * as ModelBankModule from 'model-bank';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AiAgentService } from '../index';
import { TopicNotFoundError } from '../topicAccess';

// arckep (19.10.2026): тема от клиента (appContext.topicId ← previous_response_id) должна быть этого человека.
// Своя — работаем; чужая и несуществующая — «Тема не найдена», сообщения не пишутся; бот с несуществующей темой
// идёт как раньше (его обработчик лечит удалённую тему по внешнему ключу), с чужой — нет.

const {
  mockCreateOperation,
  mockGetAgentConfig,
  mockMessageCreate,
  mockIngestAttachment,
  mockParseFile,
  mockTopicCreate,
  mockTopicFindById,
  mockTopicFindOwnerId,
} = vi.hoisted(() => ({
  mockCreateOperation: vi.fn(),
  mockGetAgentConfig: vi.fn(),
  mockIngestAttachment: vi.fn(),
  mockMessageCreate: vi.fn(),
  mockParseFile: vi.fn(),
  mockTopicCreate: vi.fn(),
  mockTopicFindById: vi.fn(),
  mockTopicFindOwnerId: vi.fn(),
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

vi.mock('@/server/services/agent', () => ({
  AgentService: vi.fn().mockImplementation(() => ({
    getAgentConfig: mockGetAgentConfig,
  })),
}));

vi.mock('@/database/models/plugin', () => ({
  PluginModel: vi.fn().mockImplementation(() => ({
    query: vi.fn().mockResolvedValue([]),
  })),
}));

vi.mock('@/database/models/topic', () => ({
  TopicModel: vi.fn().mockImplementation(() => ({
    create: mockTopicCreate,
    findById: mockTopicFindById,
    findOwnerId: mockTopicFindOwnerId,
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

describe('AiAgentService.execAgent — arckep: тема от клиента принадлежит человеку', () => {
  const userId = 'user-1';
  let service: AiAgentService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockTopicFindOwnerId.mockResolvedValue(undefined);
    mockTopicCreate.mockResolvedValue({ id: 'topic-new' });
    mockMessageCreate.mockResolvedValue({ id: 'msg-1' });
    mockCreateOperation.mockResolvedValue({
      autoStarted: true,
      messageId: 'queue-msg-1',
      operationId: 'op-123',
      success: true,
    });
    mockGetAgentConfig.mockResolvedValue({
      chatConfig: { historyCount: 8, searchMode: 'auto' },
      id: 'agent-1',
      model: 'gpt-4',
      params: { temperature: 1, top_p: 1 },
      plugins: [],
      provider: 'openai',
      slug: 'my-agent',
      systemRole: 'You are a helpful assistant.',
    });
    service = new AiAgentService({} as any, userId);
  });

  it('своя тема: ответ строится, сообщения пишутся, новая тема не создаётся', async () => {
    mockTopicFindById.mockResolvedValue({ id: 'topic-own' });

    const result = await service.execAgent({
      agentId: 'agent-1',
      appContext: { topicId: 'topic-own' },
      prompt: 'Hello',
    });

    expect(mockTopicFindById).toHaveBeenCalledWith('topic-own');
    expect(result.topicId).toBe('topic-own');
    expect(mockMessageCreate).toHaveBeenCalled();
    expect(mockTopicCreate).not.toHaveBeenCalled();
  });

  it('чужая тема: «Тема не найдена», сообщения не пишутся, операция не создаётся', async () => {
    mockTopicFindById.mockResolvedValue(undefined); // среди тем человека её нет
    mockTopicFindOwnerId.mockResolvedValue('someone-else');

    const error = await service
      .execAgent({ agentId: 'agent-1', appContext: { topicId: 'topic-victim' }, prompt: 'Hello' })
      .catch((e) => e);

    expect(error).toBeInstanceOf(TopicNotFoundError);
    expect(error.message).toBe('Тема не найдена');
    expect(error.name).toBe('NotFoundError');
    expect(error.status).toBe(404);
    expect(mockMessageCreate).not.toHaveBeenCalled();
    expect(mockCreateOperation).not.toHaveBeenCalled();
  });

  it('несуществующая тема: то же «Тема не найдена», сообщения не пишутся', async () => {
    mockTopicFindById.mockResolvedValue(undefined);
    mockTopicFindOwnerId.mockResolvedValue(undefined);

    const error = await service
      .execAgent({ agentId: 'agent-1', appContext: { topicId: 'topic-gone' }, prompt: 'Hello' })
      .catch((e) => e);

    expect(error).toBeInstanceOf(TopicNotFoundError);
    expect(mockMessageCreate).not.toHaveBeenCalled();
  });

  it('без номера темы создаётся новая, проверка владельца не нужна', async () => {
    const result = await service.execAgent({ agentId: 'agent-1', prompt: 'Hello' });
    expect(result.topicId).toBe('topic-new');
    expect(mockTopicFindById).not.toHaveBeenCalled();
  });

  describe('путь бота (Telegram и др.): тема создана под владельцем бота', () => {
    const botContext = { platform: 'telegram' } as any;

    it('своя тема бота работает как раньше', async () => {
      mockTopicFindById.mockResolvedValue({ id: 'topic-bot' });
      const result = await service.execAgent({
        agentId: 'agent-1',
        appContext: { topicId: 'topic-bot' },
        botContext,
        prompt: 'Привет',
        trigger: 'bot',
      });
      expect(result.topicId).toBe('topic-bot');
      expect(mockMessageCreate).toHaveBeenCalled();
    });

    it('удалённая тема бота проходит дальше как раньше: обработчик бота лечит её по внешнему ключу', async () => {
      mockTopicFindById.mockResolvedValue(undefined);
      mockTopicFindOwnerId.mockResolvedValue(undefined);

      const result = await service.execAgent({
        agentId: 'agent-1',
        appContext: { topicId: 'topic-deleted' },
        botContext,
        prompt: 'Привет',
        trigger: 'bot',
      });

      expect(result.topicId).toBe('topic-deleted');
      // дальше база сама отвечает нарушением внешнего ключа — это и ловит AgentBridgeService
      expect(mockMessageCreate).toHaveBeenCalled();
    });

    it('чужая тема у бота отклоняется так же, как у клиента', async () => {
      mockTopicFindById.mockResolvedValue(undefined);
      mockTopicFindOwnerId.mockResolvedValue('someone-else');

      await expect(
        service.execAgent({
          agentId: 'agent-1',
          appContext: { topicId: 'topic-victim' },
          botContext,
          prompt: 'Привет',
          trigger: 'bot',
        }),
      ).rejects.toBeInstanceOf(TopicNotFoundError);
      expect(mockMessageCreate).not.toHaveBeenCalled();
    });

    it('Discord и платформенный контекст бота — тоже путь бота', async () => {
      mockTopicFindById.mockResolvedValue(undefined);
      for (const extra of [
        { discordContext: { channel: { id: 'c' }, guild: { id: 'g' } } },
        { botPlatformContext: { platformName: 'telegram', supportsMarkdown: true } },
      ] as any[]) {
        const result = await service.execAgent({
          agentId: 'agent-1',
          appContext: { topicId: 'topic-deleted' },
          prompt: 'Привет',
          ...extra,
        });
        expect(result.topicId).toBe('topic-deleted');
      }
    });
  });
});
