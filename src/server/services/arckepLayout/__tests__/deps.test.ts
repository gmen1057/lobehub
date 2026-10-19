// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as PdfPrepareModule from '../../aiAgent/pdfPrepare';
import { createLayoutDeps } from '../deps';
import { MAX_FILE_BYTES } from '../service';

// arckep (19.10.2026): рабочие зависимости сверки с макетом — вызов модели хода, чтение базы и файлов. Внешнее
// (база, хранилище, модель) подменено.

const mocks = vi.hoisted(() => ({
  chat: vi.fn(),
  fileModel: { findById: vi.fn() },
  fileService: { getFileByteArray: vi.fn(), uploadFromBuffer: vi.fn() },
  findModelExtendParams: vi.fn(),
  initModelRuntimeFromDB: vi.fn(),
  prep: { peek: vi.fn(), waitFor: vi.fn() },
}));

vi.mock('@/server/modules/ModelRuntime', () => ({
  initModelRuntimeFromDB: mocks.initModelRuntimeFromDB,
}));
vi.mock('@/server/modules/AgentRuntime/serverModelParams', () => ({
  findModelExtendParams: mocks.findModelExtendParams,
}));
vi.mock('@/server/services/file', () => ({
  FileService: vi.fn(() => mocks.fileService),
}));
vi.mock('@/database/models/file', () => ({
  FileModel: vi.fn(() => mocks.fileModel),
}));
vi.mock('../../aiAgent/pdfPrepare', async (importOriginal) => ({
  ...(await importOriginal<typeof PdfPrepareModule>()),
  PdfPrepareService: { forUser: vi.fn(() => mocks.prep) },
}));

/** База-подделка: цепочка select().from()….where()… возвращает строки при await. */
const dbWith = (rows: unknown[]) => {
  const chain: any = new Proxy(
    {},
    { get: (_, key) => (key === 'then' ? (resolve: any) => resolve(rows) : () => chain) },
  );
  return { select: vi.fn(() => chain) } as any;
};

const make = (rows: unknown[] = []) =>
  createLayoutDeps(dbWith(rows), 'lobe-user-1', async () => 15);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findModelExtendParams.mockResolvedValue(undefined);
  mocks.initModelRuntimeFromDB.mockResolvedValue({ chat: mocks.chat });
  mocks.chat.mockImplementation(async (_payload: any, options: any) => {
    await options.callback.onText('Вижу сдвиг. ');
    await options.callback.onText('[]');
    await options.callback.onCompletion({ usage: { totalTokens: 10 } });
    return new Response('');
  });
});

describe('askEditor: вызов модели хода', () => {
  const call = {
    model: 'gpt-5.5',
    parentMessageId: 'msg_A',
    parts: [{ text: 'текущий HTML…', type: 'text' as const }],
    provider: 'openai',
    system: 'Ты правишь HTML',
    topicId: 'tpc_1',
  };

  it('тот же поставщик, трата ляжет в эту тему и сообщение хода; текст ответа собирается из потока', async () => {
    const text = await make().askEditor(call);

    expect(mocks.initModelRuntimeFromDB).toHaveBeenCalledWith(
      expect.anything(),
      'lobe-user-1',
      'openai',
      {
        assistantMessageId: 'msg_A',
        topicId: 'tpc_1',
      },
    );
    expect(text).toBe('Вижу сдвиг. []');
    const [payload, options] = mocks.chat.mock.calls[0];
    // одно сообщение пользователя и системный текст — без переписки
    expect(payload.messages).toEqual([
      { content: 'Ты правишь HTML', role: 'system' },
      { content: call.parts, role: 'user' },
    ]);
    expect(payload).toMatchObject({ model: 'gpt-5.5', stream: true });
    expect(options.user).toBe('lobe-user-1');
  });

  it('ступень рассуждений низкая, если модель её знает (по списку параметров карточки)', async () => {
    mocks.findModelExtendParams.mockResolvedValue(['gpt5ReasoningEffort']);
    await make().askEditor(call);
    expect(mocks.chat.mock.calls[0][0].reasoning_effort).toBe('low');
  });

  it('модель без ступеней — параметры рассуждений не передаются', async () => {
    await make().askEditor({ ...call, model: 'some-unknown-model', provider: 'unknown-provider' });
    const payload = mocks.chat.mock.calls[0][0];
    for (const field of [
      'reasoning_effort',
      'thinking',
      'effort',
      'thinkingLevel',
      'thinkingBudget',
    ]) {
      expect(payload).not.toHaveProperty(field);
    }
  });

  it('текст частями содержимого (Gemini 3) собирается так же, как обычный', async () => {
    mocks.chat.mockImplementationOnce(async (_payload: any, options: any) => {
      await options.callback.onContentPart({
        content: 'Вижу. ',
        mimeType: undefined,
        partType: 'text',
      });
      await options.callback.onContentPart({
        content: 'iVBOR',
        mimeType: 'image/png',
        partType: 'image',
      });
      await options.callback.onContentPart({ content: '[]', partType: 'text' });
      return new Response('');
    });
    expect(await make().askEditor(call)).toBe('Вижу. []');
  });

  it('ошибка потока не глотается: исключение с текстом ошибки (например, нет денег)', async () => {
    mocks.chat.mockImplementationOnce(async (_payload: any, options: any) => {
      await options.callback.onError({ message: 'Недостаточно средств' });
      return new Response('');
    });
    await expect(make().askEditor(call)).rejects.toThrow('Недостаточно средств');
  });

  it('ошибка запуска модели уходит вызывающему', async () => {
    mocks.initModelRuntimeFromDB.mockRejectedValueOnce(new Error('нет ключа провайдера'));
    await expect(make().askEditor(call)).rejects.toThrow('нет ключа провайдера');
  });
});

describe('чтение базы', () => {
  it('сообщения с тегами: ответы ассистента и результаты инструмента сверки — вместе, от старых к новым', async () => {
    const at = (minute: number) => new Date(Date.UTC(2026, 9, 19, 12, minute));
    const answers = [
      { at: at(1), content: '<lobeArtifact …1', id: 'a1' },
      { at: at(5), content: '<lobeArtifact …3', id: 'a3' },
    ];
    const toolResults = [{ at: at(3), content: '<lobeArtifact …2', id: 't2' }];
    // первый select — ответы ассистента, второй — результаты инструмента
    let call = 0;
    const chain = (rows: unknown[]): any =>
      new Proxy(
        {},
        { get: (_, key) => (key === 'then' ? (resolve: any) => resolve(rows) : () => chain(rows)) },
      );
    const db = { select: vi.fn(() => chain(++call === 1 ? answers : toolResults)) } as any;
    const deps = createLayoutDeps(db, 'lobe-user-1', async () => 15);

    expect(await deps.artifactMessages('tpc_1')).toEqual([
      { content: '<lobeArtifact …1', id: 'a1' },
      { content: '<lobeArtifact …2', id: 't2' },
      { content: '<lobeArtifact …3', id: 'a3' },
    ]);
  });

  it('PDF темы: только PDF (по mime или имени), без повторов, от новых к старым', async () => {
    const deps = make([
      { fileType: 'application/pdf', id: 'f2', name: 'новый.pdf' },
      { fileType: 'image/png', id: 'f3', name: 'страница.png' },
      { fileType: 'application/pdf', id: 'f2', name: 'новый.pdf' },
      { fileType: '', id: 'f1', name: 'Старый.PDF' },
    ]);
    expect(await deps.topicPdfs('tpc_1')).toEqual([
      { id: 'f2', name: 'новый.pdf' },
      { id: 'f1', name: 'Старый.PDF' },
    ]);
  });

  it('модель и поставщик хода из записи сообщения ассистента; нет сообщения или нет модели — undefined', async () => {
    expect(await make([{ model: 'm', provider: 'p' }]).turnModel('msg_A')).toEqual({
      model: 'm',
      provider: 'p',
    });
    expect(await make([]).turnModel('msg_A')).toBeUndefined();
    expect(await make([{ model: null, provider: 'p' }]).turnModel('msg_A')).toBeUndefined();
    expect(await make([{ model: 'm', provider: 'p' }]).turnModel(undefined)).toBeUndefined();
  });

  it('номер человека в студии берётся у переданной функции', async () => {
    expect(await make().studioUserId()).toBe(15);
  });
});

describe('файлы', () => {
  it('читается только файл этого человека, не больше 2 МБ; не найден — undefined', async () => {
    mocks.fileModel.findById.mockResolvedValueOnce(undefined);
    expect(await make().readChatFileText('file_X')).toBeUndefined();
    expect(mocks.fileService.getFileByteArray).not.toHaveBeenCalled();

    mocks.fileModel.findById.mockResolvedValueOnce({ size: MAX_FILE_BYTES + 1, url: 'k' });
    expect(await make().readChatFileText('file_X')).toBeUndefined();
    expect(mocks.fileService.getFileByteArray).not.toHaveBeenCalled();

    mocks.fileModel.findById.mockResolvedValueOnce({ size: 10, url: 'files/u/a.html' });
    mocks.fileService.getFileByteArray.mockResolvedValueOnce(
      new TextEncoder().encode('<p>Привет</p>'),
    );
    expect(await make().readChatFileText('file_X')).toBe('<p>Привет</p>');
    expect(mocks.fileService.getFileByteArray).toHaveBeenCalledWith('files/u/a.html');
  });

  it('файл на деле больше, чем в записи — не берётся', async () => {
    mocks.fileModel.findById.mockResolvedValueOnce({ size: 10, url: 'k' });
    mocks.fileService.getFileByteArray.mockResolvedValueOnce(new Uint8Array(MAX_FILE_BYTES + 5));
    expect(await make().readChatFileText('file_X')).toBeUndefined();
  });

  it('сохранение HTML: файл чата человека, text/plain; charset=utf-8, адрес /chat/f/<id>/', async () => {
    mocks.fileService.uploadFromBuffer.mockResolvedValueOnce({
      fileId: 'file_NEW',
      key: 'k',
      url: 'u',
    });
    const saved = await make().saveHtml('<p>Привет</p>', 'mail-check-2.html');

    const [buffer, mime, pathname] = mocks.fileService.uploadFromBuffer.mock.calls[0];
    expect(buffer.toString('utf8')).toBe('<p>Привет</p>');
    expect(mime).toBe('text/plain; charset=utf-8');
    expect(pathname).toMatch(/^files\/lobe-user-1\/[\w-]+\/mail-check-2\.html$/);
    expect(saved.fileId).toBe('file_NEW');
    expect(saved.address).toMatch(/\/f\/file_NEW\/$/);
  });

  it('запись подготовки PDF: готовая с описанием — сразу; ещё готовится — ждём', async () => {
    const ready = { layout: { pages: [{}] }, status: 'done' };
    mocks.prep.peek.mockResolvedValueOnce(new Map([['pdf1', ready]]));
    expect(await make().prepRecord('pdf1')).toBe(ready);
    expect(mocks.prep.waitFor).not.toHaveBeenCalled();

    const later = { layout: { pages: [{}] }, status: 'done' };
    mocks.prep.peek.mockResolvedValueOnce(new Map([['pdf2', { status: 'processing' }]]));
    mocks.prep.waitFor.mockResolvedValueOnce({ pending: false, record: later });
    expect(await make().prepRecord('pdf2')).toBe(later);
    expect(mocks.prep.waitFor).toHaveBeenCalledWith('pdf2', expect.any(Number));

    // запись «готово» без описания — это обычный текстовый PDF: ждать нечего
    const plain = { status: 'done' };
    mocks.prep.peek.mockResolvedValueOnce(new Map([['pdf3', plain]]));
    mocks.prep.waitFor.mockClear();
    expect(await make().prepRecord('pdf3')).toBe(plain);
    expect(mocks.prep.waitFor).not.toHaveBeenCalled();
  });
});
