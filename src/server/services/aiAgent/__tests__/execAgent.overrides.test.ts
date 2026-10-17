import type * as ModelBankModule from 'model-bank';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
    mockParseFile.mockResolvedValue({ id: 'doc-1' });
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
    expect(generateArgs.toolIds).toContain('arckep-studio');
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

    const userMessage = mockMessageCreate.mock.calls.find((call) => call[0].role === 'user')![0];
    expect(userMessage.files).toEqual(['file-pdf', 'file-png']);
    const { initialMessages } = mockCreateOperation.mock.calls[0][0];
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
