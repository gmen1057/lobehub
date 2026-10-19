import type * as ModelBankModule from 'model-bank';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AiAgentService } from '../index';

// arckep (19.10.2026): вложения для модели со зрением. Длинная картинка приходит кусками — все куски сообщению
// по порядку, с подписью; PDF: текстовый слой остаётся, а страницы картинками добавляются, если у модели есть
// зрение; без зрения (и при выключателе или сбое) — только текст, как раньше.

const {
  mockCreateOperation,
  mockGetAgentConfig,
  mockMessageCreate,
  mockIngestAttachment,
  mockParseFile,
  mockRenderPdfPages,
  mockFileFindById,
  mockGetFileByteArray,
  mockUploadFromBuffer,
} = vi.hoisted(() => ({
  mockCreateOperation: vi.fn(),
  mockGetAgentConfig: vi.fn(),
  mockFileFindById: vi.fn(),
  mockGetFileByteArray: vi.fn(),
  mockIngestAttachment: vi.fn(),
  mockMessageCreate: vi.fn(),
  mockParseFile: vi.fn(),
  mockRenderPdfPages: vi.fn(),
  mockUploadFromBuffer: vi.fn(),
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
    getFileByteArray: mockGetFileByteArray,
    getFullFileUrl: vi
      .fn()
      .mockImplementation((key: string) => Promise.resolve(`https://s3/${key}`)),
    uploadFromBuffer: mockUploadFromBuffer,
  })),
}));

vi.mock('@/database/models/file', () => ({
  FileModel: vi.fn().mockImplementation(() => ({ findById: mockFileFindById })),
}));

vi.mock('../pdfPages', () => ({
  renderPdfPages: mockRenderPdfPages,
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
      {
        abilities: { functionCall: true, video: false, vision: false },
        id: 'text-only',
        providerId: 'openai',
      },
    ],
  };
});

describe('AiAgentService.execAgent — arckep: вложения для модели со зрением', () => {
  const userId = 'user-1';
  let service: AiAgentService;
  let pageCounter: number;

  const agent = (model = 'gpt-4') => ({
    chatConfig: { historyCount: 8, searchMode: 'auto' },
    id: 'agent-1',
    model,
    params: { temperature: 1, top_p: 1 },
    plugins: [],
    provider: 'openai',
    slug: 'my-agent',
    systemRole: 'You are a helpful assistant.',
  });

  const pageImage = (page: number, index = 1, total = 1) => ({
    buffer: Buffer.from(`png-${page}-${index}`),
    height: 2048,
    index,
    mimeType: 'image/png',
    page,
    total,
    width: 1536,
  });

  /** Что execAgent передал сообщению и модели. */
  const runWith = async (files: any[], model = 'gpt-4') => {
    mockGetAgentConfig.mockResolvedValue(agent(model));
    await service.execAgent({ agentId: 'agent-1', files, prompt: 'Сделай письмо по шаблону' });
    const messageArgs = mockMessageCreate.mock.calls.find((call) => call[0].role === 'user')![0];
    const { initialMessages } = mockCreateOperation.mock.calls[0][0];
    return { fileIds: messageArgs.files as string[], messageArgs, initialMessages };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.ARCKEP_PDF_PAGE_IMAGES;
    pageCounter = 0;
    mockMessageCreate.mockResolvedValue({ id: 'msg-1' });
    mockCreateOperation.mockResolvedValue({
      autoStarted: true,
      messageId: 'queue-msg-1',
      operationId: 'op-123',
      success: true,
    });
    mockParseFile.mockResolvedValue({ content: 'Текст шаблона из слоя PDF', id: 'doc-1' });
    mockFileFindById.mockResolvedValue({ url: 'files/user-1/tmpl.pdf' });
    mockGetFileByteArray.mockResolvedValue(new Uint8Array([37, 80, 68, 70]));
    mockUploadFromBuffer.mockImplementation(async (_b: Buffer, _m: string, pathname: string) => ({
      fileId: `page_file_${++pageCounter}`,
      key: pathname,
    }));
    mockRenderPdfPages.mockResolvedValue({ images: [], pageCount: 0, renderedPages: 0 });
    service = new AiAgentService({} as any, userId);
  });

  describe('картинки', () => {
    const ingested = (total: number, name = 'letter.jpg') => ({
      fileId: 'img_1',
      images: Array.from({ length: total }, (_, i) => ({
        fileId: `img_${i + 1}`,
        index: i + 1,
        key: `files/u/${name}.part-${i + 1}`,
        mimeType: 'image/png',
        name: `${name}.part-${i + 1}`,
        resolvedUrl: `https://s3/part-${i + 1}`,
        total,
      })),
      isImage: true,
      key: 'files/u/x',
      resolvedUrl: 'https://s3/part-1',
    });

    it('длинная картинка: все 8 кусков сообщению по порядку, у каждого подпись «часть i из 8, сверху вниз»', async () => {
      mockIngestAttachment.mockResolvedValue(ingested(8));

      const { fileIds, initialMessages } = await runWith([
        { mimeType: 'image/jpeg', name: 'letter.jpg', url: 'https://x/letter.jpg' },
      ]);

      expect(fileIds).toEqual(Array.from({ length: 8 }, (_, i) => `img_${i + 1}`));
      const user = initialMessages.at(-1);
      expect(user.imageList.map((image: any) => image.id)).toEqual(fileIds);
      expect(user.imageList.map((image: any) => image.url)).toEqual(
        Array.from({ length: 8 }, (_, i) => `https://s3/part-${i + 1}`),
      );
      expect(user.imageList[0].alt).toBe(
        'letter.jpg — часть 1 из 8 (изображение разрезано на 8 частей сверху вниз, читай по порядку)',
      );
      expect(user.imageList[7].alt).toContain('часть 8 из 8');
    });

    it('обычное фото: одна картинка, подпись — просто имя', async () => {
      mockIngestAttachment.mockResolvedValue(ingested(1, 'photo.jpg'));

      const { fileIds, initialMessages } = await runWith([
        { mimeType: 'image/jpeg', name: 'photo.jpg', url: 'https://x/photo.jpg' },
      ]);

      expect(fileIds).toEqual(['img_1']);
      expect(initialMessages.at(-1).imageList).toEqual([
        { alt: 'photo.jpg', id: 'img_1', url: 'https://s3/part-1' },
      ]);
    });

    it('старый ingest без поля images (совместимость): одна картинка, как раньше', async () => {
      mockIngestAttachment.mockResolvedValue({
        fileId: 'img_old',
        isImage: true,
        key: 'k',
        resolvedUrl: 'https://s3/old',
      });
      const { fileIds, initialMessages } = await runWith([
        { mimeType: 'image/png', name: 'a.png', url: 'https://x/a.png' },
      ]);
      expect(fileIds).toEqual(['img_old']);
      expect(initialMessages.at(-1).imageList).toEqual([
        { alt: 'a.png', id: 'img_old', url: 'https://s3/old' },
      ]);
    });
  });

  describe('PDF', () => {
    const pdfFile = {
      fileId: 'pdf_1',
      mimeType: 'application/pdf',
      name: 'tmpl.pdf',
      size: 2_000_000,
      url: 'https://s3/files/user-1/tmpl.pdf',
    };

    it('модель со зрением: текстовый слой остаётся, страницы картинками по порядку, подписи с номером страницы и части', async () => {
      mockRenderPdfPages.mockResolvedValue({
        images: Array.from({ length: 8 }, (_, i) => pageImage(1, i + 1, 8)),
        pageCount: 1,
        renderedPages: 1,
      });

      const { fileIds, initialMessages } = await runWith([pdfFile]);

      // сам PDF + 8 картинок страницы, по порядку
      expect(fileIds).toEqual([
        'pdf_1',
        ...Array.from({ length: 8 }, (_, i) => `page_file_${i + 1}`),
      ]);
      const user = initialMessages.at(-1);
      expect(user.fileList).toEqual([
        expect.objectContaining({
          content: 'Текст шаблона из слоя PDF',
          id: 'pdf_1',
          name: 'tmpl.pdf',
        }),
      ]);
      expect(user.imageList).toHaveLength(8);
      expect(user.imageList[0].alt).toBe(
        'tmpl.pdf — страница 1 из 1, часть 1 из 8 (страница разрезана на 8 частей сверху вниз, читай по порядку)',
      );
      expect(user.imageList[0].url).toMatch(
        /^https:\/\/s3\/files\/user-1\/.+\.page-01\.part-01-of-08\.png$/,
      );
      // PDF читается из хранилища по ключу записи файла
      expect(mockFileFindById).toHaveBeenCalledWith('pdf_1');
      expect(mockGetFileByteArray).toHaveBeenCalledWith('files/user-1/tmpl.pdf');
      expect(mockRenderPdfPages).toHaveBeenCalledTimes(1);
      // страницы сохраняются картинками PNG
      expect(mockUploadFromBuffer.mock.calls[0][1]).toBe('image/png');
    });

    it('несколько страниц: подпись «страница i из N», нарисованы не все — это сказано в подписи последней', async () => {
      mockRenderPdfPages.mockResolvedValue({
        images: [pageImage(1), pageImage(2), pageImage(3)],
        pageCount: 14,
        renderedPages: 3,
      });

      const { initialMessages } = await runWith([pdfFile]);

      const alts = initialMessages.at(-1).imageList.map((image: any) => image.alt);
      expect(alts[0]).toBe('tmpl.pdf — страница 1 из 14');
      expect(alts[1]).toBe('tmpl.pdf — страница 2 из 14');
      expect(alts[2]).toBe(
        'tmpl.pdf — страница 3 из 14; нарисованы только первые 3 стр., остальное — в тексте файла',
      );
    });

    it('модель без зрения: только текст, страницы не рисуются и не загружаются', async () => {
      const { fileIds, initialMessages } = await runWith([pdfFile], 'text-only');

      expect(fileIds).toEqual(['pdf_1']);
      expect(initialMessages.at(-1).imageList).toBeUndefined();
      expect(initialMessages.at(-1).fileList).toHaveLength(1);
      expect(mockRenderPdfPages).not.toHaveBeenCalled();
      expect(mockGetFileByteArray).not.toHaveBeenCalled();
      expect(mockUploadFromBuffer).not.toHaveBeenCalled();
    });

    it('выключатель ARCKEP_PDF_PAGE_IMAGES=0: только текст', async () => {
      process.env.ARCKEP_PDF_PAGE_IMAGES = '0';
      const { fileIds } = await runWith([pdfFile]);
      expect(fileIds).toEqual(['pdf_1']);
      expect(mockRenderPdfPages).not.toHaveBeenCalled();
    });

    it('не нарисовалось (нет poppler, повреждённый файл) или сбой хранилища — только текст, отправка не падает', async () => {
      // пусто
      let { fileIds } = await runWith([pdfFile]);
      expect(fileIds).toEqual(['pdf_1']);

      // исключение при отрисовке
      vi.clearAllMocks();
      mockMessageCreate.mockResolvedValue({ id: 'msg-1' });
      mockCreateOperation.mockResolvedValue({
        autoStarted: true,
        operationId: 'op-1',
        success: true,
      });
      mockParseFile.mockResolvedValue({ content: 'текст', id: 'doc-1' });
      mockFileFindById.mockResolvedValue({ url: 'k' });
      mockGetFileByteArray.mockResolvedValue(new Uint8Array([1]));
      mockRenderPdfPages.mockRejectedValue(new Error('poppler crashed'));
      ({ fileIds } = await runWith([pdfFile]));
      expect(fileIds).toEqual(['pdf_1']);
    });

    it('PDF через ingest (бот, внешняя ссылка): тоже страницами, ключ берётся из ingest', async () => {
      mockIngestAttachment.mockResolvedValue({
        fileId: 'pdf_2',
        images: [],
        isImage: false,
        key: 'files/user-1/from-url.pdf',
        resolvedUrl: '',
      });
      mockRenderPdfPages.mockResolvedValue({
        images: [pageImage(1)],
        pageCount: 1,
        renderedPages: 1,
      });

      const { fileIds } = await runWith([
        { mimeType: 'application/pdf', name: 'from-url.pdf', url: 'https://x/from-url.pdf' },
      ]);

      expect(fileIds).toEqual(['pdf_2', 'page_file_1']);
      expect(mockGetFileByteArray).toHaveBeenCalledWith('files/user-1/from-url.pdf');
      expect(mockFileFindById).not.toHaveBeenCalled();
    });

    it('не PDF (docx, txt) страниц не получает', async () => {
      const { fileIds } = await runWith([
        {
          fileId: 'doc_1',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          name: 'a.docx',
          url: 'https://s3/a.docx',
        },
      ]);
      expect(fileIds).toEqual(['doc_1']);
      expect(mockRenderPdfPages).not.toHaveBeenCalled();
    });
  });
});
