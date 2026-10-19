import type * as ModelBankModule from 'model-bank';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createServerAgentToolsEngine } from '@/server/modules/Mecha';

import { AiAgentService } from '../index';

// arckep (19.10.2026, выбор поиска): запуск по расписанию у модели с платным встроенным поиском ищет «Поиском
// Arckep» (встроенный выключается), в обычном чате «Поиск Arckep» у такой модели — вторым, по требованию.

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

const WEB = 'mcp-arckep-studio-web';
const CRON = { cronJobId: 'cron_1', trigger: 'cron' };

describe('AiAgentService.execAgent — arckep: какой поиск у модели', () => {
  let service: AiAgentService;

  const manifest = (identifier: string) => ({
    api: [],
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
    plugins: [],
    provider: 'openai',
    slug: 'my-agent',
    systemRole: 'You are a helpful assistant.',
    ...overrides,
  });

  /** Движок с настоящим getPluginManifest: ленивые манифесты попадают в карту операции. */
  const run = async (
    config: Record<string, unknown>,
    params: Record<string, unknown> = {},
  ): Promise<{ chatConfig: any; eager: string[]; lazy: string[] }> => {
    const engine = {
      generateToolsDetailed: vi.fn().mockReturnValue({
        enabledManifests: [],
        enabledToolIds: [],
        tools: [],
      }),
      getEnabledPluginManifests: vi.fn().mockReturnValue(new Map()),
      getPluginManifest: vi.fn((id: string) => manifest(id)),
    };
    vi.mocked(createServerAgentToolsEngine).mockReturnValueOnce(engine as any);
    mockGetAgentConfig.mockResolvedValue(baseConfig(config));

    await service.execAgent({ agentId: 'agent-1', prompt: 'Собери новости', ...params });

    const createArgs = mockCreateOperation.mock.calls[0][0];
    return {
      chatConfig: createArgs.agentConfig.chatConfig,
      eager: engine.generateToolsDetailed.mock.calls[0][0].toolIds,
      lazy: Object.keys(createArgs.toolSet.manifestMap),
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockMessageCreate.mockResolvedValue({ id: 'msg-1' });
    mockCreateOperation.mockResolvedValue({
      autoStarted: true,
      messageId: 'queue-msg-1',
      operationId: 'op-123',
      success: true,
    });
    mockFindCronJob.mockResolvedValue({ cronPattern: '0 9 * * *', id: 'cron_1', name: 'Новости' });
    mockFindPlugin.mockResolvedValue({ identifier: WEB });
    service = new AiAgentService({} as any, 'test-user-id');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('запуск по расписанию', () => {
    it.each([
      ['openai', 'gpt-4'],
      ['anthropic', 'claude-opus-5'],
      ['google', 'gemini-3.7-flash'],
      ['xai', 'grok-4.3'],
    ])('%s: встроенный поиск выключен, «Поиск Arckep» сразу в наборе', async (provider, model) => {
      const { chatConfig, eager, lazy } = await run({ model, provider }, CRON);

      expect(chatConfig.useModelBuiltinSearch).toBe(false);
      expect(chatConfig.historyCount).toBe(8);
      expect(eager).toContain(WEB);
      expect(lazy).not.toContain(WEB);
      expect(mockFindPlugin).toHaveBeenCalledWith(WEB);
    });

    it('подключение у человека удалено — остаётся встроенный поиск', async () => {
      mockFindPlugin.mockResolvedValue(undefined);

      const { chatConfig, eager } = await run({}, CRON);

      expect(chatConfig.useModelBuiltinSearch).toBeUndefined();
      expect(eager).not.toContain(WEB);
    });

    it('база не ответила — запуск идёт со встроенным поиском', async () => {
      mockFindPlugin.mockRejectedValue(new Error('db down'));

      const { chatConfig, eager } = await run({}, CRON);

      expect(chatConfig.useModelBuiltinSearch).toBeUndefined();
      expect(eager).not.toContain(WEB);
    });

    it('поиск выключен — ни встроенного, ни «Поиска Arckep»', async () => {
      const { chatConfig, eager, lazy } = await run({ chatConfig: { searchMode: 'off' } }, CRON);

      expect(chatConfig.useModelBuiltinSearch).toBeUndefined();
      expect(eager).not.toContain(WEB);
      expect(lazy).not.toContain(WEB);
      expect(mockFindPlugin).not.toHaveBeenCalled();
    });

    it('Qwen (встроенный поиск отдельно не оплачивается) и DeepSeek — как раньше', async () => {
      const qwen = await run({ model: 'qwen3.7-flash', provider: 'qwen' }, CRON);
      expect(qwen.chatConfig.useModelBuiltinSearch).toBeUndefined();
      expect(qwen.eager).not.toContain(WEB);

      mockCreateOperation.mockClear();
      const deepseek = await run({ model: 'deepseek-v4-flash', provider: 'deepseek' }, CRON);
      expect(deepseek.chatConfig.useModelBuiltinSearch).toBeUndefined();
      expect(deepseek.eager).toContain(WEB);
      expect(mockFindPlugin).not.toHaveBeenCalled();
    });
  });

  describe('обычный чат', () => {
    it('модель с платным встроенным поиском: встроенный остаётся, «Поиск Arckep» — по требованию', async () => {
      const { chatConfig, eager, lazy } = await run({
        model: 'claude-opus-5',
        provider: 'anthropic',
      });

      expect(chatConfig.useModelBuiltinSearch).toBeUndefined();
      expect(eager).not.toContain(WEB);
      expect(lazy).toContain(WEB);
      expect(mockFindPlugin).not.toHaveBeenCalled();
    });

    it('поиск выключен — «Поиск Arckep» не предлагается', async () => {
      const { eager, lazy } = await run({ chatConfig: { searchMode: 'off' } });

      expect(eager).not.toContain(WEB);
      expect(lazy).not.toContain(WEB);
    });

    it('человек снял встроенный поиск — «Поиск Arckep» сразу, как раньше', async () => {
      const { eager, lazy } = await run({ chatConfig: { useModelBuiltinSearch: false } });

      expect(eager).toContain(WEB);
      expect(lazy).not.toContain(WEB);
    });

    it('Qwen — без второго поиска; DeepSeek — «Поиск Arckep» сразу, как раньше', async () => {
      const qwen = await run({ model: 'qwen3.7-flash', provider: 'qwen' });
      expect(qwen.eager).not.toContain(WEB);
      expect(qwen.lazy).not.toContain(WEB);

      mockCreateOperation.mockClear();
      const deepseek = await run({ model: 'deepseek-v4-flash', provider: 'deepseek' });
      expect(deepseek.eager).toContain(WEB);
      expect(deepseek.lazy).not.toContain(WEB);
    });

    it('ручной режим навыков и бот (свой набор без активатора) — не предлагается', async () => {
      const manual = await run({ chatConfig: { skillActivateMode: 'manual' } });
      expect(manual.lazy).not.toContain(WEB);
      expect(manual.eager).not.toContain(WEB);

      mockCreateOperation.mockClear();
      const bot = await run(
        {},
        { botContext: { botProviderId: 'bot-1', endUserRef: 'tg:1', platform: 'telegram' } as any },
      );
      expect(bot.lazy).not.toContain(WEB);
      expect(bot.eager).not.toContain(WEB);
    });
  });
});
