import type * as ModelBankModule from 'model-bank';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createServerAgentToolsEngine } from '@/server/modules/Mecha';

import { AiAgentService } from '../index';

// arckep (19.10.2026): инструмент arckep-layout (сверка письма с макетом и правки артефакта кусками) включается
// в ход сразу, когда в теме есть PDF (макет) или HTML-артефакт; боты, выключенные человеком и пустые темы его
// не получают. Правило: aiAgent/index.ts + arckepLayout/enable.ts.

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

const LAYOUT = 'arckep-layout';
const artifact =
  '<lobeArtifact identifier="mail" type="text/html" title="Письмо"><p>x</p></lobeArtifact>';

describe('AiAgentService.execAgent — arckep: arckep-layout включается, когда в теме есть PDF или HTML-артефакт', () => {
  let service: AiAgentService;

  const agentConfig = (plugins: string[] = ['lobe-user-memory']) => ({
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
  const appContext = { topicId: 'topic-1' } as any;

  beforeEach(() => {
    vi.clearAllMocks();
    // страницы и вшитые картинки PDF здесь не нужны (их готовит отдельный фон): разбор PDF выключен
    process.env.ARCKEP_PDF_PAGE_IMAGES = '0';
    process.env.ARCKEP_PDF_EMBEDDED_IMAGES = '0';
    delete process.env.ARCKEP_LAYOUT_CHECK;
    mockMessageCreate.mockResolvedValue({ id: 'msg-1' });
    mockParseFile.mockResolvedValue(undefined);
    mockCreateOperation.mockResolvedValue({
      autoStarted: true,
      messageId: 'queue-msg-1',
      operationId: 'op-123',
      success: true,
    });
    mockPluginQuery.mockResolvedValue([]);
    mockMessageQuery.mockResolvedValue([]);
    mockGetAgentConfig.mockResolvedValue(agentConfig());
    service = new AiAgentService({} as any, 'test-user-id');
  });

  afterEach(() => {
    delete process.env.ARCKEP_PDF_PAGE_IMAGES;
    delete process.env.ARCKEP_PDF_EMBEDDED_IMAGES;
    delete process.env.ARCKEP_LAYOUT_CHECK;
  });

  it('пустая тема, обычный вопрос — инструмента нет', async () => {
    await service.execAgent({ agentId: 'agent-1', appContext, prompt: 'Привет' });

    expect(enginePlugins()).not.toContain(LAYOUT);
    expect(generateArgs().toolIds).not.toContain(LAYOUT);
  });

  it('PDF в этом сообщении — инструмент сразу в первом шаге, один раз, не «по требованию»', async () => {
    await service.execAgent({
      agentId: 'agent-1',
      appContext,
      files: [{ fileId: 'file_pdf', mimeType: 'application/pdf', name: 'new.pdf' } as any],
      prompt: 'Сверстай письмо по макету',
    });

    expect(enginePlugins().filter((id) => id === LAYOUT)).toHaveLength(1);
    expect(generateArgs().toolIds).toContain(LAYOUT);
    expect(generateArgs().excludeDefaultToolIds ?? []).not.toContain(LAYOUT);
  });

  it('PDF в прежнем сообщении человека (история темы) — тоже включается', async () => {
    mockMessageQuery.mockResolvedValue([
      {
        fileList: [{ fileType: 'application/pdf', id: 'f1', name: 'new.pdf' }],
        id: 'u1',
        role: 'user',
      },
      { content: 'Готово', id: 'a1', role: 'assistant' },
    ]);
    await service.execAgent({ agentId: 'agent-1', appContext, prompt: 'Поправь кнопку' });

    expect(generateArgs().toolIds).toContain(LAYOUT);
  });

  it('HTML-артефакт в прежнем ответе помощника — включается (editArtifact для правок по просьбе)', async () => {
    mockMessageQuery.mockResolvedValue([
      { content: 'Вот страница', id: 'u1', role: 'user' },
      { content: `Держите: ${artifact}`, id: 'a1', role: 'assistant' },
    ]);
    await service.execAgent({ agentId: 'agent-1', appContext, prompt: 'Сделай кнопку синей' });

    expect(enginePlugins()).toContain(LAYOUT);
    expect(generateArgs().toolIds).toContain(LAYOUT);
  });

  it('только SVG-артефакт или картинка — не включается', async () => {
    mockMessageQuery.mockResolvedValue([
      {
        content: '<lobeArtifact identifier="logo" type="image/svg+xml"><svg/></lobeArtifact>',
        id: 'a1',
        role: 'assistant',
      },
    ]);
    await service.execAgent({
      agentId: 'agent-1',
      appContext,
      files: [
        {
          fileId: 'file_img',
          mimeType: 'image/png',
          name: 'a.png',
          url: 'https://s3/a.png',
        } as any,
      ],
      prompt: 'Нарисуй',
    });

    expect(enginePlugins()).not.toContain(LAYOUT);
  });

  it('человек выключил инструмент на это сообщение (excludePluginIds) — не включается', async () => {
    mockMessageQuery.mockResolvedValue([{ content: artifact, id: 'a1', role: 'assistant' }]);
    await service.execAgent({
      agentId: 'agent-1',
      appContext,
      excludePluginIds: [LAYOUT],
      prompt: 'Поправь',
    });

    expect(enginePlugins()).not.toContain(LAYOUT);
    expect(generateArgs().toolIds).not.toContain(LAYOUT);
  });

  it('у бота инструмента нет', async () => {
    mockMessageQuery.mockResolvedValue([{ content: artifact, id: 'a1', role: 'assistant' }]);
    await service.execAgent({
      agentId: 'agent-1',
      appContext,
      botContext: { botProviderId: 'bot-1', endUserRef: 'tg:1', platform: 'telegram' } as any,
      prompt: 'Поправь',
    });

    expect(enginePlugins()).not.toContain(LAYOUT);
  });

  it('выключатель ARCKEP_LAYOUT_CHECK=0 — инструмента нет даже при PDF', async () => {
    process.env.ARCKEP_LAYOUT_CHECK = '0';
    await service.execAgent({
      agentId: 'agent-1',
      appContext,
      files: [{ fileId: 'file_pdf', mimeType: 'application/pdf', name: 'new.pdf' } as any],
      prompt: 'Сверстай',
    });

    expect(enginePlugins()).not.toContain(LAYOUT);
  });

  it('с выключенными инструментами (disableTools) ничего не добавляется', async () => {
    mockMessageQuery.mockResolvedValue([{ content: artifact, id: 'a1', role: 'assistant' }]);
    await service.execAgent({
      agentId: 'agent-1',
      appContext,
      disableTools: true,
      prompt: 'Поправь',
    });

    expect(vi.mocked(createServerAgentToolsEngine)).not.toHaveBeenCalled();
  });
});
