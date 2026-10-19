import type * as ModelBankModule from 'model-bank';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AiAgentService } from '../index';
import { PDF_PAGES_PENDING_NOTE } from '../pdfPrepare';

// arckep (19.10.2026): вложения для модели со зрением. Длинная картинка приходит кусками — все куски сообщению
// по порядку, с подписью; PDF: текстовый слой остаётся, а страницы картинками добавляются, если у модели есть
// зрение; без зрения (и при выключателе или сбое) — только текст, как раньше.
// Список вложений (metadata.attachments): адреса ОРИГИНАЛОВ для модели; вшитые в PDF картинки — файлами человека,
// не сообщению.

const {
  mockCreateOperation,
  mockGetAgentConfig,
  mockMessageCreate,
  mockIngestAttachment,
  mockParseFile,
  mockRenderPdfPages,
  mockExtractPdfImages,
  mockFileFindById,
  mockFileFindByIds,
  mockFileFindByKey,
  mockFileMergeMetadata,
  mockMessageQuery,
  ownedFiles,
  prepStore,
  mockGetFileByteArray,
  mockUploadFromBuffer,
} = vi.hoisted(() => ({
  mockCreateOperation: vi.fn(),
  mockGetAgentConfig: vi.fn(),
  mockExtractPdfImages: vi.fn(),
  mockFileFindById: vi.fn(),
  mockFileFindByIds: vi.fn(),
  mockFileFindByKey: vi.fn(),
  mockFileMergeMetadata: vi.fn(),
  mockMessageQuery: vi.fn(),
  // подготовка PDF, записанная в files.metadata.pdfPrep: id файла → запись
  prepStore: new Map<string, any>(),
  // файлы этого человека (страницы и картинки, созданные подготовкой): id → ключ в хранилище
  ownedFiles: new Map<string, string>(),
  mockGetFileByteArray: vi.fn(),
  mockIngestAttachment: vi.fn(),
  mockMessageCreate: vi.fn(),
  mockParseFile: vi.fn(),
  mockRenderPdfPages: vi.fn(),
  mockUploadFromBuffer: vi.fn(),
}));

// адрес приложения, как на проде: оригиналы вложений получают https://arckep.ru/chat/f/<id>/
vi.mock('@/envs/app', () => ({
  appEnv: { APP_URL: 'https://arckep.ru/chat' },
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
    query: vi.fn().mockResolvedValue([]),
  })),
}));

vi.mock('@/database/models/topic', () => ({
  TopicModel: vi.fn().mockImplementation(() => ({
    create: vi.fn().mockResolvedValue({ id: 'topic-1' }),
    findById: vi.fn().mockResolvedValue(undefined),
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
    // как настоящий: ключ — путь адреса без начального «/» (в адресе имя закодировано)
    getKeyFromFullUrl: vi
      .fn()
      .mockImplementation((url: string) => Promise.resolve(new URL(url).pathname.slice(1))),
    getFullFileUrl: vi
      .fn()
      .mockImplementation((key: string) => Promise.resolve(`https://s3/${key}`)),
    uploadFromBuffer: mockUploadFromBuffer,
  })),
}));

vi.mock('@/database/models/file', () => ({
  FileModel: vi.fn().mockImplementation(() => ({
    findById: mockFileFindById,
    findByIds: mockFileFindByIds,
    findByKey: mockFileFindByKey,
    mergeMetadata: mockFileMergeMetadata,
  })),
}));

vi.mock('../pdfPages', () => ({
  renderPdfPages: mockRenderPdfPages,
}));

vi.mock('../pdfImages', () => ({
  extractPdfImages: mockExtractPdfImages,
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

  /** Записи файлов человека и их files.metadata.pdfPrep (боевой FileModel заменён памятью теста). */
  const installFileMocks = () => {
    const names: Record<string, string> = { pdf_1: 'tmpl.pdf', pdf_2: 'from-url.pdf' };
    const row = (id: string) => ({
      id,
      metadata: prepStore.has(id) ? { pdfPrep: structuredClone(prepStore.get(id)) } : null,
      name: names[id] ?? `${id}.pdf`,
      url: `files/user-1/${names[id] ?? `${id}.pdf`}`,
    });
    mockFileFindById.mockImplementation(async (id: string) => row(id));
    mockFileFindByIds.mockImplementation(async (ids: string[]) =>
      ids
        .filter((id) => prepStore.has(id) || ownedFiles.has(id))
        .map((id) =>
          prepStore.has(id) ? row(id) : { id, metadata: null, name: id, url: ownedFiles.get(id)! },
        ),
    );
    mockFileMergeMetadata.mockImplementation(async (id: string, patch: { pdfPrep: unknown }) => {
      prepStore.set(id, structuredClone(patch.pdfPrep));
    });
  };

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
    return {
      attachments: messageArgs.metadata?.attachments as any[] | undefined,
      fileIds: messageArgs.files as string[],
      initialMessages,
      messageArgs,
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.ARCKEP_PDF_PAGE_IMAGES;
    delete process.env.ARCKEP_PDF_EMBEDDED_IMAGES;
    delete process.env.ARCKEP_PDF_PREPARE_WAIT_MS;
    pageCounter = 0;
    mockMessageCreate.mockResolvedValue({ id: 'msg-1' });
    mockCreateOperation.mockResolvedValue({
      autoStarted: true,
      messageId: 'queue-msg-1',
      operationId: 'op-123',
      success: true,
    });
    mockParseFile.mockResolvedValue({ content: 'Текст шаблона из слоя PDF', id: 'doc-1' });
    prepStore.clear();
    ownedFiles.clear();
    installFileMocks();
    mockMessageQuery.mockResolvedValue([]);
    mockGetFileByteArray.mockResolvedValue(new Uint8Array([37, 80, 68, 70]));
    mockUploadFromBuffer.mockImplementation(async (_b: Buffer, _m: string, pathname: string) => {
      const fileId = `page_file_${++pageCounter}`;
      ownedFiles.set(fileId, pathname);
      return { fileId, key: pathname };
    });
    mockRenderPdfPages.mockResolvedValue({ images: [], pageCount: 0, renderedPages: 0 });
    mockExtractPdfImages.mockResolvedValue([]);
    mockFileFindByKey.mockResolvedValue(undefined);
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

    it('модель без зрения: модели только текст; страницы готовятся в фоне, но ей не отдаются', async () => {
      mockRenderPdfPages.mockResolvedValue({
        images: [pageImage(1)],
        pageCount: 1,
        renderedPages: 1,
      });
      const { fileIds, initialMessages } = await runWith([pdfFile], 'text-only');

      // сообщению — только сам PDF, ни страниц, ни пометки «ещё рисуются»
      expect(fileIds).toEqual(['pdf_1']);
      expect(initialMessages.at(-1).imageList).toBeUndefined();
      expect(initialMessages.at(-1).fileList).toHaveLength(1);
      expect(mockExtractPdfImages).toHaveBeenCalledTimes(1);
    });

    it('выключатель ARCKEP_PDF_PAGE_IMAGES=0: страниц нет, вшитые картинки ищутся', async () => {
      process.env.ARCKEP_PDF_PAGE_IMAGES = '0';
      const { fileIds } = await runWith([pdfFile]);
      expect(fileIds).toEqual(['pdf_1']);
      expect(mockRenderPdfPages).not.toHaveBeenCalled();
      expect(mockExtractPdfImages).toHaveBeenCalledTimes(1);
    });

    it('оба выключателя: PDF из хранилища вообще не читается', async () => {
      process.env.ARCKEP_PDF_PAGE_IMAGES = '0';
      process.env.ARCKEP_PDF_EMBEDDED_IMAGES = '0';
      const { fileIds } = await runWith([pdfFile]);
      expect(fileIds).toEqual(['pdf_1']);
      expect(mockGetFileByteArray).not.toHaveBeenCalled();
      expect(mockRenderPdfPages).not.toHaveBeenCalled();
      expect(mockExtractPdfImages).not.toHaveBeenCalled();
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
      installFileMocks();
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
      // PDF читается по ключу записи файла, которую создал ingest
      expect(mockFileFindById).toHaveBeenCalledWith('pdf_2');
      expect(mockGetFileByteArray).toHaveBeenCalledWith('files/user-1/from-url.pdf');
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

  describe('список вложений для модели (metadata.attachments)', () => {
    const addr = (id: string) => `https://arckep.ru/chat/f/${id}/`;

    const slicedLayout = {
      fileId: 'img_1',
      images: Array.from({ length: 8 }, (_, i) => ({
        fileId: `img_${i + 1}`,
        height: 2048,
        index: i + 1,
        key: `files/u/letter.part-${i + 1}`,
        mimeType: 'image/png',
        name: `image.part-0${i + 1}-of-08.png`,
        resolvedUrl: `https://s3/part-${i + 1}`,
        total: 8,
        width: 1536,
      })),
      isImage: true,
      key: 'files/u/x',
      resolvedUrl: 'https://s3/part-1',
      source: { height: 23_050, width: 2512 },
      unchanged: false,
    };

    it('картинка по адресу файла человека: в списке одна строка — оригинал с размерами исходной, куски идут сообщению', async () => {
      mockIngestAttachment.mockResolvedValue(slicedLayout);
      // в адресе имя закодировано, в базе — как есть
      mockFileFindByKey.mockImplementation(async (key: string) =>
        key === 'files/user-1/макет.jpg'
          ? { fileType: 'image/jpeg', id: 'orig_1', name: 'макет.jpg' }
          : undefined,
      );

      const { attachments, fileIds, initialMessages } = await runWith([
        {
          name: 'image',
          url: 'https://s3/files/user-1/%D0%BC%D0%B0%D0%BA%D0%B5%D1%82.jpg?X-Amz-Signature=abc',
        },
      ]);

      expect(attachments).toEqual([
        {
          height: 23_050,
          mime: 'image/jpeg',
          name: 'макет.jpg',
          url: addr('orig_1'),
          width: 2512,
        },
      ]);
      // оригинал не прикрепляется — модель получает 8 кусков, как и раньше
      expect(fileIds).toHaveLength(8);
      expect(fileIds).not.toContain('orig_1');
      // тот же список — в сообщении, которое видит модель на этом шаге
      expect(initialMessages.at(-1).metadata).toEqual({ attachments });
    });

    it('внешняя картинка без сохранённого оригинала, ужатая: в списке сохранённые куски с пометкой «копия»', async () => {
      mockIngestAttachment.mockResolvedValue(slicedLayout);

      const { attachments } = await runWith([
        { mimeType: 'image/png', name: 'letter.png', url: 'https://x.example/letter.png' },
      ]);

      expect(attachments).toHaveLength(8);
      expect(attachments![0]).toEqual({
        height: 2048,
        mime: 'image/png',
        name: 'image.part-01-of-08.png',
        note: 'копия, оригинал не сохранён',
        url: addr('img_1'),
        width: 1536,
      });
      expect(attachments![7].url).toBe(addr('img_8'));
    });

    it('внешняя картинка без изменений: сохранённая копия — те же байты, она и есть оригинал', async () => {
      mockIngestAttachment.mockResolvedValue({
        fileId: 'img_9',
        images: [
          {
            fileId: 'img_9',
            height: 900,
            index: 1,
            key: 'files/u/photo.jpg',
            mimeType: 'image/jpeg',
            name: 'photo.jpg',
            resolvedUrl: 'https://s3/photo',
            total: 1,
            width: 1200,
          },
        ],
        isImage: true,
        key: 'files/u/photo.jpg',
        resolvedUrl: 'https://s3/photo',
        source: { height: 900, width: 1200 },
        unchanged: true,
      });

      const { attachments } = await runWith([
        { mimeType: 'image/jpeg', name: 'photo.jpg', url: 'https://x.example/photo.jpg' },
      ]);

      expect(attachments).toEqual([
        { height: 900, mime: 'image/jpeg', name: 'photo.jpg', url: addr('img_9'), width: 1200 },
      ]);
    });

    it('файлы из REST (fileId): адрес по id файла — картинка, PDF и docx, в порядке отправки', async () => {
      const { attachments, fileIds } = await runWith([
        { fileId: 'f_img', mimeType: 'image/png', name: 'logo.png', url: 'https://s3/logo.png' },
        {
          fileId: 'f_pdf',
          mimeType: 'application/pdf',
          name: 'tmpl.pdf',
          url: 'https://s3/files/user-1/tmpl.pdf',
        },
        {
          fileId: 'f_doc',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          name: 'a.docx',
          url: 'https://s3/a.docx',
        },
      ]);

      expect(fileIds).toEqual(['f_img', 'f_pdf', 'f_doc']);
      expect(attachments).toEqual([
        { mime: 'image/png', name: 'logo.png', url: addr('f_img') },
        { mime: 'application/pdf', name: 'tmpl.pdf', url: addr('f_pdf') },
        {
          mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          name: 'a.docx',
          url: addr('f_doc'),
        },
      ]);
    });

    it('без вложений metadata не пишется', async () => {
      mockGetAgentConfig.mockResolvedValue(agent());
      await service.execAgent({ agentId: 'agent-1', prompt: 'Привет' });

      const messageArgs = mockMessageCreate.mock.calls.find((call) => call[0].role === 'user')![0];
      expect(messageArgs.metadata).toBeUndefined();
      const { initialMessages } = mockCreateOperation.mock.calls[0][0];
      expect(initialMessages.at(-1).metadata).toBeUndefined();
    });

    it('вложение, которое не удалось принять, в список не попадает', async () => {
      mockIngestAttachment.mockRejectedValue(new Error('fetch failed'));
      const { attachments } = await runWith([
        { mimeType: 'image/png', name: 'a.png', url: 'https://x.example/a.png' },
      ]);
      expect(attachments).toBeUndefined();
    });
  });

  describe('вшитые картинки PDF', () => {
    const addr = (id: string) => `https://arckep.ru/chat/f/${id}/`;
    const pdfFile = {
      fileId: 'pdf_1',
      mimeType: 'application/pdf',
      name: 'tmpl.pdf',
      size: 2_000_000,
      url: 'https://s3/files/user-1/tmpl.pdf',
    };
    const embedded = (index: number, page: number, mimeType = 'image/png') => ({
      buffer: Buffer.from(`img-${index}`),
      hasAlpha: mimeType === 'image/png',
      height: 400 + index,
      index,
      mimeType,
      page,
      width: 800 + index,
    });

    it('сохраняются файлами человека, к сообщению не прикрепляются, идут в список: номер, страница, размер, адрес', async () => {
      mockExtractPdfImages.mockResolvedValue([
        embedded(1, 1),
        embedded(2, 1, 'image/jpeg'),
        embedded(3, 2),
      ]);

      const { attachments, fileIds, initialMessages } = await runWith([pdfFile], 'text-only');

      // сообщению — только сам PDF
      expect(fileIds).toEqual(['pdf_1']);
      expect(initialMessages.at(-1).imageList).toBeUndefined();
      // загружено три файла: PNG с альфой и исходный JPEG
      expect(mockUploadFromBuffer.mock.calls.map((call) => call[1])).toEqual([
        'image/png',
        'image/jpeg',
        'image/png',
      ]);
      expect(mockUploadFromBuffer.mock.calls[0][2]).toMatch(
        /^files\/user-1\/.+\/tmpl\.pdf\.image-01\.p1\.png$/,
      );
      expect(mockUploadFromBuffer.mock.calls[1][2]).toMatch(/\.image-02\.p1\.jpg$/);
      expect(mockUploadFromBuffer.mock.calls[2][2]).toMatch(/\.image-03\.p2\.png$/);

      expect(attachments).toEqual([
        { mime: 'application/pdf', name: 'tmpl.pdf', url: addr('pdf_1') },
        {
          height: 401,
          mime: 'image/png',
          name: 'картинка 1 из tmpl.pdf',
          note: 'стр. 1',
          url: addr('page_file_1'),
          width: 801,
        },
        {
          height: 402,
          mime: 'image/jpeg',
          name: 'картинка 2 из tmpl.pdf',
          note: 'стр. 1',
          url: addr('page_file_2'),
          width: 802,
        },
        {
          height: 403,
          mime: 'image/png',
          name: 'картинка 3 из tmpl.pdf',
          note: 'стр. 2',
          url: addr('page_file_3'),
          width: 803,
        },
      ]);
    });

    it('модель со зрением: страницы идут сообщению, вшитые картинки — только в список', async () => {
      mockRenderPdfPages.mockResolvedValue({
        images: [pageImage(1)],
        pageCount: 1,
        renderedPages: 1,
      });
      mockExtractPdfImages.mockResolvedValue([embedded(1, 1)]);

      const { attachments, fileIds, initialMessages } = await runWith([pdfFile]);

      // вшитые картинки готовятся первыми (page_file_1), страница — следом (page_file_2)
      expect(fileIds).toEqual(['pdf_1', 'page_file_2']);
      expect(initialMessages.at(-1).imageList).toHaveLength(1);
      expect(attachments!.map((item) => item.url)).toEqual([addr('pdf_1'), addr('page_file_1')]);
      // PDF читается из хранилища один раз на обе задачи
      expect(mockGetFileByteArray).toHaveBeenCalledTimes(1);
    });

    it('PDF через ingest (бот, внешняя ссылка): список содержит и сам файл, и его картинки', async () => {
      mockIngestAttachment.mockResolvedValue({
        fileId: 'pdf_2',
        images: [],
        isImage: false,
        key: 'files/user-1/from-url.pdf',
        resolvedUrl: '',
        unchanged: true,
      });
      mockExtractPdfImages.mockResolvedValue([embedded(1, 3)]);

      const { attachments, fileIds } = await runWith([
        { mimeType: 'application/pdf', name: 'from-url.pdf', url: 'https://x/from-url.pdf' },
      ]);

      expect(fileIds).toEqual(['pdf_2']);
      expect(attachments).toEqual([
        { mime: 'application/pdf', name: 'from-url.pdf', url: addr('pdf_2') },
        expect.objectContaining({
          name: 'картинка 1 из from-url.pdf',
          note: 'стр. 3',
          url: addr('page_file_1'),
        }),
      ]);
    });

    it('выключатель ARCKEP_PDF_EMBEDDED_IMAGES=0: картинки не ищутся, страницы рисуются', async () => {
      process.env.ARCKEP_PDF_EMBEDDED_IMAGES = '0';
      mockRenderPdfPages.mockResolvedValue({
        images: [pageImage(1)],
        pageCount: 1,
        renderedPages: 1,
      });

      const { attachments, fileIds } = await runWith([pdfFile]);

      expect(mockExtractPdfImages).not.toHaveBeenCalled();
      expect(fileIds).toEqual(['pdf_1', 'page_file_1']);
      expect(attachments).toEqual([
        { mime: 'application/pdf', name: 'tmpl.pdf', url: addr('pdf_1') },
      ]);
    });

    it('сбой вшитых картинок не отменяет страницы, сбой страниц — вшитые картинки', async () => {
      mockExtractPdfImages.mockRejectedValue(new Error('pdfimages crashed'));
      mockRenderPdfPages.mockResolvedValue({
        images: [pageImage(1)],
        pageCount: 1,
        renderedPages: 1,
      });
      let result = await runWith([pdfFile]);
      expect(result.fileIds).toEqual(['pdf_1', 'page_file_1']);
      expect(result.attachments).toHaveLength(1);

      vi.clearAllMocks();
      pageCounter = 0;
      mockMessageCreate.mockResolvedValue({ id: 'msg-1' });
      mockCreateOperation.mockResolvedValue({ operationId: 'op-1', success: true });
      mockParseFile.mockResolvedValue({ content: 'текст', id: 'doc-1' });
      prepStore.clear();
      installFileMocks();
      mockGetFileByteArray.mockResolvedValue(new Uint8Array([1]));
      mockUploadFromBuffer.mockImplementation(async (_b: Buffer, _m: string, pathname: string) => {
        const fileId = `page_file_${++pageCounter}`;
        ownedFiles.set(fileId, pathname);
        return { fileId, key: pathname };
      });
      mockRenderPdfPages.mockRejectedValue(new Error('pdftoppm crashed'));
      mockExtractPdfImages.mockResolvedValue([embedded(1, 1)]);
      result = await runWith([pdfFile]);
      expect(result.fileIds).toEqual(['pdf_1']);
      expect(result.attachments).toHaveLength(2);
      expect(result.attachments![1].name).toBe('картинка 1 из tmpl.pdf');
    });
  });

  describe('фоновая подготовка PDF (готовится при загрузке файла, execAgent забирает готовое)', () => {
    const addr = (id: string) => `https://arckep.ru/chat/f/${id}/`;
    const pdfFile = {
      fileId: 'pdf_1',
      mimeType: 'application/pdf',
      name: 'tmpl.pdf',
      size: 2_000_000,
      url: 'https://s3/files/user-1/tmpl.pdf',
    };
    const embeddedImage = {
      buffer: Buffer.from('img'),
      hasAlpha: true,
      height: 400,
      index: 1,
      mimeType: 'image/png',
      page: 1,
      width: 800,
    };
    /** Запись, как её оставляет подготовка: вшитая картинка и одна страница. */
    const readyRecord = {
      finishedAt: 2,
      images: [{ fileId: 'img_a', height: 400, index: 1, mime: 'image/png', page: 1, width: 800 }],
      pageCount: 1,
      pages: [
        {
          fileId: 'page_x',
          height: 2048,
          index: 1,
          key: 'files/user-1/tmpl.pdf.page-01.png',
          mime: 'image/png',
          page: 1,
          total: 1,
          width: 1536,
        },
      ],
      renderedPages: 1,
      startedAt: 1,
      status: 'done',
      version: 1,
    };

    beforeEach(() => {
      ownedFiles.set('page_x', 'files/user-1/tmpl.pdf.page-01.png');
      ownedFiles.set('img_a', 'files/user-1/tmpl.pdf.image-01.p1.png');
    });

    it('уже подготовлено при загрузке: ничего не рисуется заново, страницы и картинки берутся из записи файла', async () => {
      prepStore.set('pdf_1', readyRecord);

      const { attachments, fileIds, initialMessages } = await runWith([pdfFile]);

      expect(fileIds).toEqual(['pdf_1', 'page_x']);
      expect(initialMessages.at(-1).imageList).toEqual([
        {
          alt: 'tmpl.pdf — страница 1 из 1',
          id: 'page_x',
          url: 'https://s3/files/user-1/tmpl.pdf.page-01.png',
        },
      ]);
      expect(attachments).toEqual([
        { mime: 'application/pdf', name: 'tmpl.pdf', url: addr('pdf_1') },
        {
          height: 400,
          mime: 'image/png',
          name: 'картинка 1 из tmpl.pdf',
          note: 'стр. 1',
          url: addr('img_a'),
          width: 800,
        },
      ]);
      // PDF не читается, страницы не рисуются, ничего не загружается
      expect(mockGetFileByteArray).not.toHaveBeenCalled();
      expect(mockRenderPdfPages).not.toHaveBeenCalled();
      expect(mockExtractPdfImages).not.toHaveBeenCalled();
      expect(mockUploadFromBuffer).not.toHaveBeenCalled();
    });

    it('страницы ещё рисуются: ждём не дольше ARCKEP_PDF_PREPARE_WAIT_MS, модель получает текст и пометку, без ошибки', async () => {
      process.env.ARCKEP_PDF_PREPARE_WAIT_MS = '30';
      let finish!: (value: unknown) => void;
      mockRenderPdfPages.mockReturnValue(
        new Promise((resolve) => {
          finish = resolve;
        }),
      );
      mockExtractPdfImages.mockResolvedValue([embeddedImage]);

      const started = Date.now();
      const { attachments, fileIds, initialMessages } = await runWith([pdfFile]);

      // не ждали отрисовку (она ещё не закончена), отправка не упала
      expect(Date.now() - started).toBeLessThan(3000);
      expect(fileIds).toEqual(['pdf_1']);
      expect(initialMessages.at(-1).imageList).toBeUndefined();
      expect(initialMessages.at(-1).fileList).toHaveLength(1);
      // на строке PDF — пометка, вшитые картинки (они готовятся первыми) уже в списке
      expect(attachments).toEqual([
        {
          mime: 'application/pdf',
          name: 'tmpl.pdf',
          note: PDF_PAGES_PENDING_NOTE,
          url: addr('pdf_1'),
        },
        expect.objectContaining({ name: 'картинка 1 из tmpl.pdf', url: addr('page_file_1') }),
      ]);

      // дорисовалось в фоне: запись файла готова
      finish({ images: [pageImage(1)], pageCount: 1, renderedPages: 1 });
      await vi.waitFor(() => expect(prepStore.get('pdf_1')?.status).toBe('done'));
      expect(prepStore.get('pdf_1').pages).toHaveLength(1);
    });

    it('следующий ход: страницы, дорисованные позже, берутся из записи в историю; пометка «ещё рисуются» снимается', async () => {
      prepStore.set('pdf_1', readyRecord);
      mockMessageQuery.mockResolvedValue([
        {
          content: 'сделай письмо',
          fileList: [
            {
              fileType: 'application/pdf',
              id: 'pdf_1',
              name: 'tmpl.pdf',
              size: 1,
              url: 'https://s3/tmpl.pdf',
            },
          ],
          id: 'm1',
          imageList: [],
          metadata: {
            attachments: [
              {
                mime: 'application/pdf',
                name: 'tmpl.pdf',
                note: PDF_PAGES_PENDING_NOTE,
                url: addr('pdf_1'),
              },
            ],
          },
          role: 'user',
        },
        { content: 'вот ответ по тексту', id: 'm2', role: 'assistant' },
      ]);
      mockGetAgentConfig.mockResolvedValue(agent());

      await service.execAgent({
        agentId: 'agent-1',
        appContext: { topicId: 'topic-existing' },
        prompt: 'теперь по картинкам',
      });

      const { initialMessages } = mockCreateOperation.mock.calls[0][0];
      const history = initialMessages[0];
      expect(history.imageList).toEqual([
        {
          alt: 'tmpl.pdf — страница 1 из 1',
          id: 'page_x',
          url: 'https://s3/files/user-1/tmpl.pdf.page-01.png',
        },
      ]);
      expect(history.metadata.attachments).toEqual([
        { mime: 'application/pdf', name: 'tmpl.pdf', note: undefined, url: addr('pdf_1') },
        expect.objectContaining({ name: 'картинка 1 из tmpl.pdf', url: addr('img_a') }),
      ]);
    });

    it('история: страницы уже у сообщения — не дублируются; текстовая модель страниц не получает; список без вложений не трогается', async () => {
      prepStore.set('pdf_1', readyRecord);
      const pdfItem = {
        fileType: 'application/pdf',
        id: 'pdf_1',
        name: 'tmpl.pdf',
        size: 1,
        url: 'u',
      };
      mockMessageQuery.mockResolvedValue([
        // страницы были прикреплены при отправке
        {
          content: 'a',
          fileList: [pdfItem],
          id: 'm1',
          imageList: [{ alt: 'tmpl.pdf — страница 1 из 1', id: 'page_x', url: 'https://s3/p' }],
          role: 'user',
        },
        // старое сообщение без списка вложений
        { content: 'b', fileList: [pdfItem], id: 'm2', imageList: [], role: 'user' },
      ]);

      mockGetAgentConfig.mockResolvedValue(agent());
      await service.execAgent({
        agentId: 'agent-1',
        appContext: { topicId: 'topic-existing' },
        prompt: 'ещё',
      });
      let { initialMessages } = mockCreateOperation.mock.calls[0][0];
      expect(initialMessages[0].imageList).toHaveLength(1); // не продублирована
      expect(initialMessages[1].imageList).toHaveLength(1); // добавлена: у старого сообщения страниц нет
      expect(initialMessages[1].metadata).toBeUndefined();

      // модель без зрения: страницы в историю не добавляются
      vi.clearAllMocks();
      mockCreateOperation.mockResolvedValue({ operationId: 'op-1', success: true });
      mockMessageCreate.mockResolvedValue({ id: 'msg-1' });
      mockMessageQuery.mockResolvedValue([
        { content: 'b', fileList: [pdfItem], id: 'm2', imageList: [], role: 'user' },
      ]);
      mockGetAgentConfig.mockResolvedValue(agent('text-only'));
      await service.execAgent({
        agentId: 'agent-1',
        appContext: { topicId: 'topic-existing' },
        prompt: 'ещё',
      });
      ({ initialMessages } = mockCreateOperation.mock.calls[0][0]);
      expect(initialMessages[0].imageList).toEqual([]);
    });

    it('подделанная запись подготовки (страница — чужой файл) не попадает ни в сообщение, ни в историю', async () => {
      const forgedRecord = {
        ...readyRecord,
        images: [{ ...readyRecord.images[0], fileId: 'foreign_img' }],
        pages: [
          { ...readyRecord.pages[0], fileId: 'foreign_page', key: 'files/other-user/secret.png' },
        ],
      };
      prepStore.set('pdf_1', forgedRecord);

      // текущее сообщение: запись отвергнута, PDF готовится заново (подмена пуста), чужое не используется
      const { attachments, fileIds, initialMessages } = await runWith([pdfFile]);
      expect(fileIds).toEqual(['pdf_1']);
      expect(initialMessages.at(-1).imageList).toBeUndefined();
      expect(JSON.stringify(attachments)).not.toContain('foreign');
      expect(mockGetFileByteArray).toHaveBeenCalledTimes(1);

      // история: запись отвергнута и там
      vi.clearAllMocks();
      mockCreateOperation.mockResolvedValue({ operationId: 'op-1', success: true });
      mockMessageCreate.mockResolvedValue({ id: 'msg-1' });
      prepStore.set('pdf_1', forgedRecord);
      mockMessageQuery.mockResolvedValue([
        {
          content: 'a',
          fileList: [
            { fileType: 'application/pdf', id: 'pdf_1', name: 'tmpl.pdf', size: 1, url: 'u' },
          ],
          id: 'm1',
          imageList: [],
          metadata: { attachments: [{ name: 'tmpl.pdf', url: addr('pdf_1') }] },
          role: 'user',
        },
      ]);
      mockGetAgentConfig.mockResolvedValue(agent());
      mockFileFindByIds.mockImplementation(async (ids: string[]) =>
        ids
          .filter((id) => prepStore.has(id))
          .map((id) => ({
            id,
            metadata: { pdfPrep: structuredClone(prepStore.get(id)) },
            name: 'tmpl.pdf',
            url: 'files/user-1/tmpl.pdf',
          })),
      );
      await service.execAgent({
        agentId: 'agent-1',
        appContext: { topicId: 'topic-existing' },
        prompt: 'ещё',
      });
      const history = mockCreateOperation.mock.calls[0][0].initialMessages[0];
      expect(history.imageList).toEqual([]);
      expect(JSON.stringify(history.metadata)).not.toContain('foreign');
    });

    it('сбой чтения записей истории не мешает отправке', async () => {
      mockMessageQuery.mockResolvedValue([
        {
          content: 'a',
          fileList: [
            { fileType: 'application/pdf', id: 'pdf_1', name: 'tmpl.pdf', size: 1, url: 'u' },
          ],
          id: 'm1',
          imageList: [],
          role: 'user',
        },
      ]);
      mockFileFindByIds.mockRejectedValue(new Error('db down'));
      mockGetAgentConfig.mockResolvedValue(agent());

      await service.execAgent({
        agentId: 'agent-1',
        appContext: { topicId: 'topic-existing' },
        prompt: 'ещё',
      });

      expect(mockCreateOperation).toHaveBeenCalledTimes(1);
    });
  });
});
