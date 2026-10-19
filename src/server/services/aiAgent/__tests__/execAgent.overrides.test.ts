import { systemPromptHeadless } from '@lobechat/builtin-tool-activator';
import type * as ModelBankModule from 'model-bank';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createServerAgentToolsEngine } from '@/server/modules/Mecha';

import { AiAgentService } from '../index';

// arckep (chat-next-redesign, E1): настройки одного вызова поверх помощника — chatConfig, params,
// выключенные инструменты, вложение по fileId без повторной загрузки, разбор документов.

const {
  mockCreateOperation,
  mockGetAgentConfig,
  mockMessageCreate,
  mockIngestAttachment,
  mockParseFile,
} = vi.hoisted(() => ({
  mockCreateOperation: vi.fn(),
  mockGetAgentConfig: vi.fn(),
  mockIngestAttachment: vi.fn(),
  mockMessageCreate: vi.fn(),
  mockParseFile: vi.fn(),
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

describe('AiAgentService.execAgent — arckep: настройки одного вызова', () => {
  let service: AiAgentService;
  const userId = 'test-user-id';

  const agentConfig = () => ({
    chatConfig: { historyCount: 8, searchMode: 'auto' },
    id: 'agent-1',
    model: 'gpt-4',
    params: { temperature: 1, top_p: 1 },
    plugins: ['arckep-studio', 'arckep-sites', 'lobe-user-memory'],
    provider: 'openai',
    slug: 'my-agent',
    systemRole: 'You are a helpful assistant.',
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockMessageCreate.mockResolvedValue({ id: 'msg-1' });
    mockCreateOperation.mockResolvedValue({
      autoStarted: true,
      messageId: 'queue-msg-1',
      operationId: 'op-123',
      success: true,
    });
    mockParseFile.mockResolvedValue({ content: 'Kod proverki: ARCKEP-7731', id: 'doc-1' });
    mockGetAgentConfig.mockResolvedValue(agentConfig());
    service = new AiAgentService({} as any, userId);
  });

  it('chatConfigOverride и paramsOverride сливаются с настройками помощника', async () => {
    await service.execAgent({
      agentId: 'agent-1',
      chatConfigOverride: { reasoningEffort: 'high', searchMode: 'off' },
      paramsOverride: { temperature: 0.2 },
      prompt: 'Hello',
    });

    const { agentConfig: passed } = mockCreateOperation.mock.calls[0][0];
    expect(passed.chatConfig).toEqual({
      historyCount: 8,
      reasoningEffort: 'high',
      searchMode: 'off',
    });
    expect(passed.params).toEqual({ temperature: 0.2, top_p: 1 });
  });

  it('пустые оверрайды ничего не меняют', async () => {
    await service.execAgent({
      agentId: 'agent-1',
      chatConfigOverride: {},
      paramsOverride: {},
      prompt: 'Hello',
    });

    const { agentConfig: passed } = mockCreateOperation.mock.calls[0][0];
    expect(passed.chatConfig).toEqual({ historyCount: 8, searchMode: 'auto' });
    expect(passed.params).toEqual({ temperature: 1, top_p: 1 });
  });

  it('excludePluginIds убирает инструмент помощника из набора для движка инструментов', async () => {
    await service.execAgent({
      agentId: 'agent-1',
      additionalPluginIds: ['lobe-artifacts'],
      excludePluginIds: ['arckep-sites', 'lobe-artifacts'],
      prompt: 'Hello',
    });

    const engineCall = vi.mocked(createServerAgentToolsEngine).mock.calls[0];
    expect(engineCall[1].agentConfig.plugins).toEqual(['arckep-studio', 'lobe-user-memory']);
    const toolsEngine = vi.mocked(createServerAgentToolsEngine).mock.results[0].value;
    const generateArgs = toolsEngine.generateToolsDetailed.mock.calls[0][0];
    expect(generateArgs.toolIds).not.toContain('arckep-sites');
    expect(generateArgs.toolIds).not.toContain('lobe-artifacts');
    // «Студия» — тяжёлый инструмент (arckepLazyToolIds): в первый шаг не грузится, а перечисляется для
    // подключения по требованию; её не выкинули, а отложили.
    expect(generateArgs.toolIds).not.toContain('arckep-studio');
    expect(generateArgs.excludeDefaultToolIds).toContain('arckep-studio');
  });

  it('подключения студии mcp-arckep-studio-* (F6) тоже откладываются до activateTools', async () => {
    mockGetAgentConfig.mockResolvedValue({
      ...agentConfig(),
      plugins: ['mcp-arckep-studio-images', 'mcp-arckep-e2b-sandbox', 'lobe-artifacts'],
    });
    await service.execAgent({ agentId: 'agent-1', prompt: 'Нарисуй кота' });

    const toolsEngine = vi.mocked(createServerAgentToolsEngine).mock.results[0].value;
    const generateArgs = toolsEngine.generateToolsDetailed.mock.calls[0][0];
    expect(generateArgs.toolIds).not.toContain('mcp-arckep-studio-images');
    expect(generateArgs.excludeDefaultToolIds).toContain('mcp-arckep-studio-images');
    // песочница E2B (исключение из ленивых подключений MCP, 19.10) и артефакты — сразу, как и раньше
    expect(generateArgs.toolIds).toContain('mcp-arckep-e2b-sandbox');
    expect(generateArgs.toolIds).toContain('lobe-artifacts');
    expect(generateArgs.excludeDefaultToolIds).not.toContain('mcp-arckep-e2b-sandbox');
  });

  it('у бота подключения студии тоже по требованию, а свои инструменты — сразу (F7)', async () => {
    mockGetAgentConfig.mockResolvedValue({
      ...agentConfig(),
      plugins: ['mcp-arckep-studio-images', 'mcp-arckep-wordstat', 'arckep-studio'],
    });
    await service.execAgent({
      agentId: 'agent-1',
      botContext: { botProviderId: 'bot-1', endUserRef: 'tg:1', platform: 'telegram' } as any,
      prompt: 'Нарисуй кота',
    });

    const toolsEngine = vi.mocked(createServerAgentToolsEngine).mock.results[0].value;
    const generateArgs = toolsEngine.generateToolsDetailed.mock.calls[0][0];
    expect(generateArgs.toolIds).not.toContain('mcp-arckep-studio-images');
    expect(generateArgs.excludeDefaultToolIds).toContain('mcp-arckep-studio-images');
    // набор бота не трогаем: старая «Студия» и Wordstat грузятся с первого шага, как раньше
    expect(generateArgs.toolIds).toContain('arckep-studio');
    expect(generateArgs.toolIds).toContain('mcp-arckep-wordstat');
    expect(generateArgs.excludeDefaultToolIds ?? []).not.toContain('arckep-studio');
  });

  it('вложение по fileId: без повторной загрузки, документ разбирается, картинка идёт в imageList', async () => {
    await service.execAgent({
      agentId: 'agent-1',
      files: [
        {
          fileId: 'file-pdf',
          mimeType: 'application/pdf',
          name: 'договор.pdf',
          url: 'https://s3/doc.pdf',
        },
        {
          fileId: 'file-png',
          mimeType: 'image/png',
          name: 'фото.png',
          url: 'https://s3/photo.png',
        },
      ],
      prompt: 'Что в документе?',
    });

    expect(mockIngestAttachment).not.toHaveBeenCalled();
    expect(mockParseFile).toHaveBeenCalledTimes(1);
    expect(mockParseFile).toHaveBeenCalledWith('file-pdf');

    // текст документа попадает в fileList текущего сообщения (история берёт его из базы)
    const { initialMessages } = mockCreateOperation.mock.calls[0][0];
    const current = initialMessages.at(-1);
    expect(current.fileList).toEqual([
      {
        content: 'Kod proverki: ARCKEP-7731',
        fileType: 'application/pdf',
        id: 'file-pdf',
        name: 'договор.pdf',
        size: 0,
        url: 'https://s3/doc.pdf',
      },
    ]);

    const userMessage = mockMessageCreate.mock.calls.find((call) => call[0].role === 'user')![0];
    expect(userMessage.files).toEqual(['file-pdf', 'file-png']);
    const withImages = (initialMessages ?? []).find((m: any) => m.imageList?.length);
    expect(withImages?.imageList).toEqual([
      { alt: 'фото.png', id: 'file-png', url: 'https://s3/photo.png' },
    ]);
  });

  it('загруженный заново документ тоже разбирается; ошибка разбора не ломает отправку', async () => {
    mockIngestAttachment.mockResolvedValue({
      fileId: 'file-new',
      isImage: false,
      key: 'k',
      resolvedUrl: '',
    });
    mockParseFile.mockRejectedValueOnce(new Error('парсер упал'));

    await service.execAgent({
      agentId: 'agent-1',
      files: [{ name: 'заметки.docx', url: 'https://cdn.example/notes.docx' }],
      prompt: 'Кратко',
    });

    expect(mockParseFile).toHaveBeenCalledWith('file-new');
    const userMessage = mockMessageCreate.mock.calls.find((call) => call[0].role === 'user')![0];
    expect(userMessage.files).toEqual(['file-new']);
    expect(mockCreateOperation).toHaveBeenCalledTimes(1);
  });

  it('картинки и видео на разбор не отправляются', async () => {
    mockIngestAttachment.mockResolvedValue({
      fileId: 'file-jpg',
      isImage: true,
      key: 'k',
      resolvedUrl: 'https://s3/k',
    });

    await service.execAgent({
      agentId: 'agent-1',
      files: [
        { mimeType: 'image/jpeg', name: 'a.jpg', url: 'https://cdn.example/a.jpg' },
        { fileId: 'file-mp4', mimeType: 'video/mp4', name: 'b.mp4', url: 'https://s3/b.mp4' },
      ],
      prompt: 'Смотри',
    });

    expect(mockParseFile).not.toHaveBeenCalled();
  });
});

// arckep (19.10.2026): меньше постоянной нагрузки в первом шаге серверного пути — подключения MCP
// (кроме E2B), база знаний и ссылки на темы по требованию, прежняя «Студия» скрыта при подключениях,
// промпт активатора без магазина навыков в режиме без интерфейса.
describe('AiAgentService.execAgent — arckep: облегчённая загрузка инструментов', () => {
  let service: AiAgentService;

  const FULL_ACTIVATOR_ROLE = 'FULL ACTIVATOR PROMPT: activate lobe-skill-store first';

  const manifest = (identifier: string, extra: Record<string, unknown> = {}) => ({
    api: [],
    identifier,
    meta: { title: identifier },
    type: 'builtin',
    ...extra,
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
  ): Promise<{ generateArgs: any; manifestIds: string[]; toolSet: any }> => {
    const engine = {
      generateToolsDetailed: vi.fn().mockReturnValue({
        enabledManifests: [manifest('lobe-activator', { systemRole: FULL_ACTIVATOR_ROLE })],
        enabledToolIds: ['lobe-activator'],
        tools: [],
      }),
      getEnabledPluginManifests: vi.fn().mockReturnValue(new Map()),
      getPluginManifest: vi.fn((id: string) => manifest(id)),
    };
    vi.mocked(createServerAgentToolsEngine).mockReturnValueOnce(engine as any);
    mockGetAgentConfig.mockResolvedValue(baseConfig(config));

    await service.execAgent({ agentId: 'agent-1', prompt: 'Hello', ...params });

    const { toolSet } = mockCreateOperation.mock.calls[0][0];
    return {
      generateArgs: engine.generateToolsDetailed.mock.calls[0][0],
      manifestIds: Object.keys(toolSet.manifestMap),
      toolSet,
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
    service = new AiAgentService({} as any, 'test-user-id');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('подключения MCP — по требованию, кроме E2B: он остаётся сразу', async () => {
    const { generateArgs, manifestIds } = await run({
      plugins: [
        'mcp-arckep-wordstat',
        'mcp-arckep-e2b-sandbox',
        'mcp-arckep-studio-images',
        'lobe-artifacts',
      ],
    });

    expect(generateArgs.toolIds).toContain('mcp-arckep-e2b-sandbox');
    expect(generateArgs.toolIds).toContain('lobe-artifacts');
    expect(generateArgs.toolIds).not.toContain('mcp-arckep-wordstat');
    expect(generateArgs.toolIds).not.toContain('mcp-arckep-studio-images');
    expect(generateArgs.excludeDefaultToolIds).toEqual(
      expect.arrayContaining(['mcp-arckep-wordstat', 'mcp-arckep-studio-images']),
    );
    expect(generateArgs.excludeDefaultToolIds).not.toContain('mcp-arckep-e2b-sandbox');
    // ленивые перечисляются в <available_tools>: их манифесты лежат в карте операции
    expect(manifestIds).toEqual(
      expect.arrayContaining(['mcp-arckep-wordstat', 'mcp-arckep-studio-images']),
    );
  });

  it('инструмент, выбранный на сообщение, подключается сразу даже если он MCP', async () => {
    const { generateArgs, manifestIds } = await run(
      { plugins: ['mcp-arckep-wordstat'] },
      { additionalPluginIds: ['mcp-arckep-wordstat'] },
    );

    expect(generateArgs.toolIds).toContain('mcp-arckep-wordstat');
    expect(generateArgs.excludeDefaultToolIds).not.toContain('mcp-arckep-wordstat');
    expect(manifestIds).not.toContain('mcp-arckep-wordstat');
  });

  it('набор бота не облегчается: MCP, база знаний и ссылки на темы — как раньше', async () => {
    const { generateArgs } = await run(
      { plugins: ['mcp-arckep-wordstat', 'mcp-arckep-studio-images'] },
      { botContext: { botProviderId: 'bot-1', endUserRef: 'tg:1', platform: 'telegram' } as any },
    );

    expect(generateArgs.toolIds).toContain('mcp-arckep-wordstat');
    expect(generateArgs.toolIds).not.toContain('mcp-arckep-studio-images'); // F7: подключения студии — по требованию
    expect(generateArgs.excludeDefaultToolIds ?? []).not.toContain('lobe-knowledge-base');
    expect(generateArgs.excludeDefaultToolIds ?? []).not.toContain('lobe-topic-reference');
  });

  it('в ручном режиме навыков (активатор выключен) MCP, база знаний и ссылки на темы остаются сразу', async () => {
    const { generateArgs } = await run({
      chatConfig: { skillActivateMode: 'manual' },
      plugins: ['mcp-arckep-wordstat'],
    });

    expect(generateArgs.toolIds).toContain('mcp-arckep-wordstat');
    expect(generateArgs.excludeDefaultToolIds).not.toContain('mcp-arckep-wordstat');
    expect(generateArgs.excludeDefaultToolIds).not.toContain('lobe-knowledge-base');
    expect(generateArgs.excludeDefaultToolIds).not.toContain('lobe-topic-reference');
  });

  it('база знаний: без включённых баз — по требованию, с включённой — сразу', async () => {
    const without = await run({ knowledgeBases: [{ enabled: false, id: 'kb-off' }] });
    expect(without.generateArgs.excludeDefaultToolIds).toContain('lobe-knowledge-base');
    expect(without.manifestIds).toContain('lobe-knowledge-base');

    vi.clearAllMocks();
    mockCreateOperation.mockResolvedValue({
      autoStarted: true,
      operationId: 'op-2',
      success: true,
    });
    mockMessageCreate.mockResolvedValue({ id: 'msg-2' });

    const withKb = await run({ knowledgeBases: [{ enabled: true, id: 'kb-1' }] });
    expect(withKb.generateArgs.excludeDefaultToolIds).not.toContain('lobe-knowledge-base');
    expect(withKb.manifestIds).not.toContain('lobe-knowledge-base');
  });

  it('ссылки на темы: по требованию, а с <refer_topic> в сообщении — сразу', async () => {
    const plain = await run({});
    expect(plain.generateArgs.excludeDefaultToolIds).toContain('lobe-topic-reference');
    expect(plain.manifestIds).toContain('lobe-topic-reference');

    vi.clearAllMocks();
    mockCreateOperation.mockResolvedValue({
      autoStarted: true,
      operationId: 'op-2',
      success: true,
    });
    mockMessageCreate.mockResolvedValue({ id: 'msg-2' });

    const referring = await run(
      {},
      { prompt: 'Что в <refer_topic name="План" id="topic-9"></refer_topic>?' },
    );
    expect(referring.generateArgs.excludeDefaultToolIds).not.toContain('lobe-topic-reference');
    expect(referring.manifestIds).not.toContain('lobe-topic-reference');
  });

  it('прежняя «Студия» скрыта вовсе, если у помощника есть подключение студии', async () => {
    const { generateArgs, manifestIds } = await run({
      plugins: ['arckep-studio', 'mcp-arckep-studio-images'],
    });

    expect(generateArgs.toolIds).not.toContain('arckep-studio');
    expect(generateArgs.excludeDefaultToolIds).toContain('arckep-studio');
    expect(manifestIds).not.toContain('arckep-studio'); // и в списке <available_tools> её нет
    expect(manifestIds).toContain('mcp-arckep-studio-images');
  });

  it('без подключений студии прежняя «Студия» остаётся запасным путём (в списке по требованию)', async () => {
    const { generateArgs, manifestIds } = await run({ plugins: ['arckep-studio'] });

    expect(generateArgs.toolIds).not.toContain('arckep-studio');
    expect(manifestIds).toContain('arckep-studio');
  });

  it('прежняя «Студия», выбранная на сообщение, не прячется', async () => {
    const { generateArgs } = await run(
      { plugins: ['mcp-arckep-studio-images'] },
      { additionalPluginIds: ['arckep-studio'] },
    );

    expect(generateArgs.toolIds).toContain('arckep-studio');
  });

  it('выключенное человеком на это сообщение не предлагается в списке', async () => {
    const { manifestIds } = await run(
      { plugins: ['mcp-arckep-studio-images', 'arckep-sites'] },
      { excludePluginIds: ['arckep-sites', 'mcp-arckep-studio-images'] },
    );

    expect(manifestIds).not.toContain('arckep-sites');
    expect(manifestIds).not.toContain('mcp-arckep-studio-images');
    // остальные ленивые инструменты на месте
    expect(manifestIds).toContain('lobe-notebook');
  });

  it('в режиме без интерфейса активатор получает промпт без магазина навыков', async () => {
    vi.stubEnv('ARCKEP_HEADLESS_TOOLS', '1');

    const { toolSet } = await run({});
    const role = toolSet.manifestMap['lobe-activator'].systemRole as string;

    expect(role).toBe(systemPromptHeadless);
    expect(role).not.toContain('lobe-skill-store');
    expect(role).not.toContain('SKILL-FIRST');
    expect(role).not.toContain('Skill Marketplace');
    // остальное в манифесте активатора не тронуто
    expect(toolSet.manifestMap['lobe-activator'].identifier).toBe('lobe-activator');
  });

  it('вне режима без интерфейса промпт активатора остаётся как собрал движок инструментов', async () => {
    const { toolSet } = await run({});

    expect(toolSet.manifestMap['lobe-activator'].systemRole).toBe(FULL_ACTIVATOR_ROLE);
  });
});
