import type * as ModelBankModule from 'model-bank';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createServerAgentToolsEngine } from '@/server/modules/Mecha';

import { AiAgentService } from '../index';

// arckep (19.10.2026): ссылка на Figma в последнем сообщении человека — подключение mcp-arckep-figma
// включается на этот ход сразу (схемы инструментов без activateTools) или модель получает строку
// «подключите Figma». Правило и таблица ссылок: server/modules/AgentRuntime/arckepLinkConnectors.ts.

const {
  mockCreateOperation,
  mockGetAgentConfig,
  mockMessageCreate,
  mockIngestAttachment,
  mockParseFile,
  mockMessageQuery,
  mockPluginQuery,
} = vi.hoisted(() => ({
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

const FIGMA = 'mcp-arckep-figma';
const figmaLink = 'https://www.figma.com/design/AbC123xyz/Landing?node-id=12-34';
const withToken = { identifier: FIGMA, settings: { 'X-MCP-Password': 'enc:v1:AAAA' } };
const HINT = 'Подключите Figma: Подключения → Figma → вставьте личный токен';

describe('AiAgentService.execAgent — arckep: ссылка на Figma включает подключение', () => {
  let service: AiAgentService;

  const agentConfig = (plugins: string[] = ['mcp-arckep-wordstat', 'lobe-user-memory']) => ({
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
  const enginePlugins = (): string[] =>
    vi.mocked(createServerAgentToolsEngine).mock.calls[0][1].agentConfig?.plugins ?? [];
  const systemRole = () => mockCreateOperation.mock.calls[0][0].agentConfig.systemRole as string;

  beforeEach(() => {
    vi.clearAllMocks();
    mockMessageCreate.mockResolvedValue({ id: 'msg-1' });
    mockCreateOperation.mockResolvedValue({
      autoStarted: true,
      messageId: 'queue-msg-1',
      operationId: 'op-123',
      success: true,
    });
    mockPluginQuery.mockResolvedValue([withToken]);
    mockMessageQuery.mockResolvedValue([]);
    mockGetAgentConfig.mockResolvedValue(agentConfig());
    service = new AiAgentService({} as any, 'test-user-id');
  });

  it('без ссылки подключение, как и раньше, отложено до activateTools и подсказки нет', async () => {
    mockGetAgentConfig.mockResolvedValue(agentConfig([FIGMA, 'lobe-user-memory']));
    await service.execAgent({ agentId: 'agent-1', prompt: 'Привет, расскажи про Figma' });

    expect(generateArgs().toolIds).not.toContain(FIGMA);
    expect(generateArgs().excludeDefaultToolIds).toContain(FIGMA);
    expect(systemRole()).toBe('You are a helpful assistant.');
  });

  it('ссылка + подключение с токеном: сразу в первом шаге, не отложено (подключение уже у помощника)', async () => {
    mockGetAgentConfig.mockResolvedValue(agentConfig([FIGMA, 'lobe-user-memory']));
    await service.execAgent({ agentId: 'agent-1', prompt: `${figmaLink} — посмотри что тут` });

    expect(generateArgs().toolIds).toContain(FIGMA);
    expect(generateArgs().excludeDefaultToolIds ?? []).not.toContain(FIGMA);
    expect(enginePlugins().filter((id: string) => id === FIGMA)).toHaveLength(1);
    expect(systemRole()).toBe('You are a helpful assistant.');
  });

  it('ссылка + подключение с токеном, но у помощника его нет в наборе: всё равно в первом шаге', async () => {
    await service.execAgent({ agentId: 'agent-1', prompt: `${figmaLink} — посмотри что тут` });

    expect(enginePlugins()).toContain(FIGMA);
    expect(generateArgs().toolIds).toContain(FIGMA);
    expect(generateArgs().excludeDefaultToolIds ?? []).not.toContain(FIGMA);
    // остальное не тронуто: чужое MCP-подключение по-прежнему отложено
    expect(generateArgs().excludeDefaultToolIds).toContain('mcp-arckep-wordstat');
  });

  it('ссылка, подключения нет вовсе: инструмент не включается, модель получает строку «подключите Figma»', async () => {
    mockPluginQuery.mockResolvedValue([]);
    await service.execAgent({ agentId: 'agent-1', prompt: `${figmaLink} — посмотри что тут` });

    expect(generateArgs().toolIds).not.toContain(FIGMA);
    expect(enginePlugins()).not.toContain(FIGMA);
    expect(systemRole()).toContain('You are a helpful assistant.');
    expect(systemRole()).toContain(HINT);
  });

  it.each([
    ['settings пусты', { identifier: FIGMA, settings: {} }],
    ['settings нет', { identifier: FIGMA }],
    ['токен — пустая строка', { identifier: FIGMA, settings: { 'X-MCP-Password': '' } }],
  ])('ссылка, подключение стоит, но %s: подсказка вместо включения', async (_name, plugin) => {
    mockPluginQuery.mockResolvedValue([plugin]);
    mockGetAgentConfig.mockResolvedValue(agentConfig([FIGMA]));
    await service.execAgent({ agentId: 'agent-1', prompt: figmaLink });

    // подключение у помощника остаётся отложенным, как и было, — движок само не включает
    expect(generateArgs().toolIds).not.toContain(FIGMA);
    expect(generateArgs().excludeDefaultToolIds).toContain(FIGMA);
    expect(systemRole()).toContain(HINT);
  });

  it('подсказка попадает и в помощника без своей инструкции', async () => {
    mockPluginQuery.mockResolvedValue([]);
    mockGetAgentConfig.mockResolvedValue({ ...agentConfig(), systemRole: undefined });
    await service.execAgent({ agentId: 'agent-1', prompt: figmaLink });

    expect(systemRole()).toContain(HINT);
    expect(systemRole().startsWith('The user')).toBe(true);
  });

  it('disabled_tools с Figma: подключение не включается и не отложено заново — его нет в наборе', async () => {
    mockGetAgentConfig.mockResolvedValue(agentConfig([FIGMA]));
    await service.execAgent({ agentId: 'agent-1', excludePluginIds: [FIGMA], prompt: figmaLink });

    expect(enginePlugins()).not.toContain(FIGMA);
    expect(generateArgs().toolIds).not.toContain(FIGMA);
    expect(systemRole()).toBe('You are a helpful assistant.');
  });

  it('disabled_tools с Figma при ненастроенном подключении: человек выключил — не уговариваем', async () => {
    mockPluginQuery.mockResolvedValue([]);
    await service.execAgent({ agentId: 'agent-1', excludePluginIds: [FIGMA], prompt: figmaLink });

    expect(enginePlugins()).not.toContain(FIGMA);
    expect(systemRole()).toBe('You are a helpful assistant.');
  });

  it('другие ссылки не срабатывают', async () => {
    mockPluginQuery.mockResolvedValue([]);
    await service.execAgent({
      agentId: 'agent-1',
      prompt:
        'https://docs.google.com/document/d/abc/edit и https://www.figma.com/community/file/1/x',
    });

    expect(enginePlugins()).not.toContain(FIGMA);
    expect(systemRole()).toBe('You are a helpful assistant.');
  });

  const botContext = { botProviderId: 'bot-1', endUserRef: 'tg:1', platform: 'telegram' } as any;

  it('у бота правило не работает: ссылку мог прислать посторонний, а токен — владельца', async () => {
    await service.execAgent({ agentId: 'agent-1', botContext, prompt: figmaLink });

    expect(enginePlugins()).not.toContain(FIGMA);
    expect(generateArgs().toolIds).not.toContain(FIGMA);
  });

  it('у бота с ненастроенным подключением подсказки тоже нет', async () => {
    mockPluginQuery.mockResolvedValue([]);
    await service.execAgent({ agentId: 'agent-1', botContext, prompt: figmaLink });

    expect(systemRole()).toBe('You are a helpful assistant.');
  });

  it('с выключенными инструментами (disableTools) подключения не читаются и подсказки нет', async () => {
    await service.execAgent({ agentId: 'agent-1', disableTools: true, prompt: figmaLink });

    expect(mockPluginQuery).not.toHaveBeenCalled();
    expect(systemRole()).toBe('You are a helpful assistant.');
  });

  // следующие ходы темы: «а теперь сверстай» — в сообщении ссылки нет
  describe('следующий ход темы без ссылки', () => {
    const topic = { topicId: 'topic-1' };
    const user = (id: string, content: string) => ({ content, id, role: 'user' });
    const reply = (id: string, tools?: Array<{ identifier: string }>) => ({
      content: 'ответ',
      id,
      role: 'assistant',
      tools,
    });
    const followUp = (extra: Record<string, unknown> = {}) =>
      service.execAgent({
        agentId: 'agent-1',
        appContext: topic,
        prompt: 'а теперь сверстай',
        ...extra,
      });

    it('ссылка Figma в недавнем сообщении человека: подключение снова в первом шаге, даже если его нет у помощника', async () => {
      mockMessageQuery.mockResolvedValue([
        user('m1', `${figmaLink} — посмотри что тут`),
        reply('m2'),
      ]);
      await followUp();

      expect(enginePlugins()).toContain(FIGMA);
      expect(generateArgs().toolIds).toContain(FIGMA);
      expect(generateArgs().excludeDefaultToolIds ?? []).not.toContain(FIGMA);
      expect(systemRole()).toBe('You are a helpful assistant.');
    });

    it('в истории уже были вызовы Figma (ссылка давно ушла из окна): подключение в первом шаге', async () => {
      const filler = Array.from({ length: 12 }, (_, i) => user(`u${i}`, `дальше ${i}`));
      mockMessageQuery.mockResolvedValue([
        user('m0', figmaLink),
        reply('m1', [{ identifier: FIGMA }]),
        ...filler,
      ]);
      await followUp();

      expect(generateArgs().toolIds).toContain(FIGMA);
    });

    it('вызов Figma виден по сообщению инструмента в истории', async () => {
      mockMessageQuery.mockResolvedValue([
        user('m1', 'посмотри макет'),
        { content: '…', id: 't1', plugin: { identifier: FIGMA }, role: 'tool' },
      ]);
      await followUp();

      expect(generateArgs().toolIds).toContain(FIGMA);
    });

    it('история читается один раз — тем же запросом, что собирает сообщения', async () => {
      mockMessageQuery.mockResolvedValue([user('m1', figmaLink)]);
      await followUp();

      expect(mockMessageQuery).toHaveBeenCalledTimes(1);
      const { initialMessages } = mockCreateOperation.mock.calls[0][0];
      expect(initialMessages.map((message: any) => message.id)).toContain('m1');
    });

    it('в истории нет ни ссылки, ни вызовов Figma: подключение, как и раньше, отложено', async () => {
      mockGetAgentConfig.mockResolvedValue(agentConfig([FIGMA, 'lobe-user-memory']));
      mockMessageQuery.mockResolvedValue([user('m1', 'нарисуй кота'), reply('m2')]);
      await followUp();

      expect(generateArgs().toolIds).not.toContain(FIGMA);
      expect(generateArgs().excludeDefaultToolIds).toContain(FIGMA);
    });

    it('disabled_tools с Figma сильнее истории', async () => {
      mockMessageQuery.mockResolvedValue([
        user('m1', figmaLink),
        reply('m2', [{ identifier: FIGMA }]),
      ]);
      await followUp({ excludePluginIds: [FIGMA] });

      expect(enginePlugins()).not.toContain(FIGMA);
      expect(generateArgs().toolIds).not.toContain(FIGMA);
    });

    it.each([
      ['подключения нет', [] as any[]],
      ['токена нет', [{ identifier: FIGMA, settings: {} }]],
    ])('%s: ничего не включаем и не подсказываем на старую ссылку', async (_name, plugins) => {
      mockPluginQuery.mockResolvedValue(plugins);
      mockMessageQuery.mockResolvedValue([user('m1', figmaLink), reply('m2')]);
      await followUp();

      expect(enginePlugins()).not.toContain(FIGMA);
      expect(systemRole()).toBe('You are a helpful assistant.');
    });

    it('у бота история правило не включает', async () => {
      mockMessageQuery.mockResolvedValue([
        user('m1', figmaLink),
        reply('m2', [{ identifier: FIGMA }]),
      ]);
      await followUp({ botContext });

      expect(enginePlugins()).not.toContain(FIGMA);
    });

    it('новая тема: истории нет, запрос сообщений не выполняется, подключение не включается', async () => {
      await service.execAgent({ agentId: 'agent-1', prompt: 'привет' });

      expect(mockMessageQuery).not.toHaveBeenCalled();
      expect(enginePlugins()).not.toContain(FIGMA);
    });

    it('без настроенной Figma запрос сообщений один — для сборки сообщений', async () => {
      mockPluginQuery.mockResolvedValue([]);
      mockMessageQuery.mockResolvedValue([user('m1', 'привет')]);
      await followUp();

      expect(mockMessageQuery).toHaveBeenCalledTimes(1);
    });
  });
});
