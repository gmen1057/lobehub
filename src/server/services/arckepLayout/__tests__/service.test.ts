import { afterEach, describe, expect, it, vi } from 'vitest';

import { PDF_PREP_VERSION, type PdfPrepRecord } from '../../aiAgent/pdfPrepare';
import { LayoutRenderError } from '../render';
import {
  ArckepLayoutService,
  type LayoutServiceDeps,
  LayoutToolError,
  MAX_FILE_BYTES,
} from '../service';
import type { RenderResult } from '../types';

// arckep (19.10.2026): инструменты checkLayout и editArtifact на подменённых зависимостях (база, хранилище,
// отрисовка, модель): поиск последней версии артефакта, выбор макета, приём версии и ответ с тегом.

const tag = (identifier: string, body = '', attrs = '') =>
  `<lobeArtifact identifier="${identifier}" type="text/html" title="Письмо ${identifier}"${attrs}>${body}</lobeArtifact>`;

const HTML = { v0: '<p>v0</p>', v1: '<p>v1</p>' };

const mockRecord = (extra: Partial<PdfPrepRecord> = {}): PdfPrepRecord => ({
  layout: {
    pages: [
      {
        background: '#FFFFFF',
        blocks: [],
        crops: [],
        height: 400,
        lines: [
          { size: 20, text: 'Заголовок', w: 100, x: 20, y: 20 },
          { size: 16, text: 'Абзац', w: 100, x: 20, y: 80 },
        ],
        page: 1,
        width: 320,
      },
    ],
  },
  startedAt: 0,
  status: 'done',
  version: PDF_PREP_VERSION,
  ...extra,
});

const page = (shifted: boolean): RenderResult => ({
  failed_images: [],
  height: 400,
  images: [],
  lines: [
    { found: true, font_size: 20, h: 24, text: 'Заголовок', x: 20, y: 23 },
    { found: true, font_size: 16, h: 20, text: 'Абзац', x: shifted ? 80 : 20, y: 83 },
  ],
  scroll_width: 320,
  screenshot_jpeg_base64: '',
  width: 320,
});

const makeDeps = (overrides: Partial<LayoutServiceDeps> = {}) => {
  const saved: Array<{ html: string; name: string }> = [];
  const deps: LayoutServiceDeps = {
    address: (fileId) => `https://arckep.ru/chat/f/${fileId}/`,
    askEditor: vi.fn(async () => '[{"find": "v0", "replace": "v1"}]'),
    artifactMessages: vi.fn(async () => [{ content: tag('mail', HTML.v0), id: 'm1' }]),
    modelHasVision: vi.fn(async () => false),
    prepRecord: vi.fn(async () => mockRecord()),
    readChatFileText: vi.fn(async () => undefined),
    readStorage: vi.fn(async () => new Uint8Array()),
    render: vi.fn(async ({ html }) => page(html === HTML.v0)),
    saveHtml: vi.fn(async (html, name) => {
      saved.push({ html, name });
      return { address: 'https://arckep.ru/chat/f/file_NEW/', fileId: 'file_NEW' };
    }),
    studioUserId: vi.fn(async () => 15),
    topicPdfs: vi.fn(async () => [{ id: 'pdf1', name: 'new.pdf' }]),
    turnModel: vi.fn(async () => ({ model: 'claude-opus-5-5', provider: 'anthropic' })),
    ...overrides,
  };
  return { deps, saved };
};

const service = (deps: LayoutServiceDeps, ctx = {}) =>
  new ArckepLayoutService(
    deps,
    { parentMessageId: 'msg_A', topicId: 'tpc_1', userId: 'u1', ...ctx },
    { budgetMs: 240_000, rounds: 3 },
  );

afterEach(() => vi.restoreAllMocks());

describe('поиск последней версии артефакта', () => {
  it('последняя версия — тело в самом позднем сообщении ассистента', async () => {
    const { deps, saved } = makeDeps({
      artifactMessages: vi.fn(async () => [
        { content: tag('mail', '<p>старое</p>'), id: 'm1' },
        { content: 'без тегов', id: 'm2' },
        { content: `${tag('mail', '<p>среднее</p>')} и ${tag('mail', '<p>новое</p>')}`, id: 'm3' },
      ]),
    });
    await service(deps).editArtifact({
      edits: [{ find: 'новое', replace: 'самое новое' }],
      identifier: 'mail',
    });
    expect(saved[0].html).toBe('<p>самое новое</p>');
  });

  it('версия по ссылке — содержимое из файла чата; следующая версия по ссылке на правку тоже читается', async () => {
    const readChatFileText = vi.fn(async (id: string) =>
      id === 'file_V2' ? '<p>из файла</p>' : undefined,
    );
    const { deps, saved } = makeDeps({
      artifactMessages: vi.fn(async () => [
        { content: tag('mail', '<p>тело</p>'), id: 'm1' },
        { content: tag('mail', '', ' src="https://arckep.ru/chat/f/file_V2/"'), id: 'm2' },
      ]),
      readChatFileText,
    });
    await service(deps).editArtifact({
      edits: [{ find: 'из файла', replace: 'из файла 2' }],
      identifier: 'mail',
    });
    expect(readChatFileText).toHaveBeenCalledWith('file_V2');
    expect(saved[0].html).toBe('<p>из файла 2</p>');
  });

  it('несколько идентификаторов в теме — берётся запрошенный; SVG не считается', async () => {
    const { deps, saved } = makeDeps({
      artifactMessages: vi.fn(async () => [
        {
          content: `${tag('mail-a', '<p>A</p>')} ${tag('mail-b', '<p>B</p>')} <lobeArtifact identifier="logo" type="image/svg+xml"><svg/></lobeArtifact>`,
          id: 'm1',
        },
      ]),
    });
    await service(deps).editArtifact({
      edits: [{ find: 'A', replace: 'AA' }],
      identifier: 'mail-a',
    });
    expect(saved[0].html).toBe('<p>AA</p>');
  });

  it('нет такого артефакта — ошибка со списком имеющихся идентификаторов', async () => {
    const { deps } = makeDeps({
      artifactMessages: vi.fn(async () => [
        { content: `${tag('a', 'x')} ${tag('b', 'y')}`, id: 'm1' },
      ]),
    });
    await expect(
      service(deps).editArtifact({ edits: [{ find: 'x', replace: 'z' }], identifier: 'нет' }),
    ).rejects.toThrow(/в теме нет HTML-артефакта «нет»\. Есть: «a», «b»\./);
  });

  it('файл версии не читается (чужой, больше 2 МБ, удалён) — понятная ошибка', async () => {
    const { deps } = makeDeps({
      artifactMessages: vi.fn(async () => [
        { content: tag('mail', '', ' src="/chat/f/file_GONE/"'), id: 'm1' },
      ]),
    });
    await expect(
      service(deps).editArtifact({ edits: [{ find: 'x', replace: 'z' }], identifier: 'mail' }),
    ).rejects.toThrow(
      /не удалось прочитать файл последней версии «mail» \(\/chat\/f\/file_GONE\/\)/,
    );
  });

  it('без темы инструмент не работает', async () => {
    const { deps } = makeDeps();
    await expect(
      service(deps, { topicId: undefined }).editArtifact({
        edits: [{ find: 'a', replace: 'b' }],
        identifier: 'mail',
      }),
    ).rejects.toThrow(LayoutToolError);
  });
});

describe('editArtifact', () => {
  it('правки применяются, версия сохраняется файлом чата, ответ — короткий тег со src', async () => {
    const { deps, saved } = makeDeps();
    const result = await service(deps).editArtifact({
      edits: [
        { find: 'v0', replace: 'v1' },
        { find: 'нет такого', replace: 'x' },
      ],
      identifier: 'mail',
    });

    expect(saved).toEqual([{ html: '<p>v1</p>', name: 'mail-edit-2.html' }]);
    expect(result.applied).toEqual([{ find: 'v0', index: 1 }]);
    expect(result.rejected).toEqual([
      { find: 'нет такого', index: 2, reason: 'не найдено в тексте' },
    ]);
    expect(result.src).toBe('https://arckep.ru/chat/f/file_NEW/');
    expect(result.tag).toBe(
      '<lobeArtifact identifier="mail" type="text/html" title="Письмо mail" src="https://arckep.ru/chat/f/file_NEW/"></lobeArtifact>',
    );
  });

  it('ни одна правка не применилась — версия не сохраняется, причины названы', async () => {
    const { deps, saved } = makeDeps();
    await expect(
      service(deps).editArtifact({ edits: [{ find: 'нет', replace: 'x' }], identifier: 'mail' }),
    ).rejects.toThrow(/ни одна правка не применилась[\s\S]*не найдено в тексте/);
    expect(saved).toEqual([]);
  });

  it('письмо длиннее предела отрисовки (500 000 знаков) правкам не поддаётся — ни одна правка не применяется', async () => {
    const big = 'я'.repeat(600_000);
    const { deps, saved } = makeDeps({
      artifactMessages: vi.fn(async () => [{ content: tag('mail', `<p>${big}</p>`), id: 'm1' }]),
    });
    await expect(
      service(deps).editArtifact({
        edits: [{ find: '<p>', replace: '<p class="a">' }],
        identifier: 'mail',
      }),
    ).rejects.toThrow(/длиннее 500000 знаков/);
    expect(saved).toEqual([]);
  });
});

describe('checkLayout', () => {
  it('круг принят: письмо стало лучше → файл с лучшей версией, тег, итоги до и после', async () => {
    const { deps, saved } = makeDeps();
    const result = await service(deps).checkLayout({ identifier: 'mail' });

    expect(result.status).toBe('checked');
    expect(result.changed).toBe(true);
    expect(result.before).toMatchObject({ issues: 1, linesFound: 2, linesTotal: 2 });
    expect(result.after).toMatchObject({ issues: 0 });
    expect(result.stopped).toBe('clean');
    expect(result.rounds).toEqual([
      expect.objectContaining({ applied: 1, rejected: 0, round: 1, status: 'accepted' }),
    ]);
    expect(result.remaining).toEqual([]);
    expect(saved).toEqual([{ html: HTML.v1, name: 'mail-check-2.html' }]);
    expect(result.tag).toContain('src="https://arckep.ru/chat/f/file_NEW/"');
    expect(result.file).toBe('new.pdf');
  });

  it('письмо больше 2 МБ по ссылке не показать — отказ до записи файла', async () => {
    const big = 'я'.repeat(MAX_FILE_BYTES / 2 + 10);
    const { deps, saved } = makeDeps({
      artifactMessages: vi.fn(async () => [{ content: tag('mail', `<p>${big}</p>`), id: 'm1' }]),
      render: vi.fn(async () => page(false)),
    });
    await expect(service(deps).checkLayout({ identifier: 'mail' })).rejects.toThrow(/больше 2 МБ/);
    expect(saved).toEqual([]);
  });

  it('отрисовка получает человека студии, ширину окна, начала строк макета, тему и сообщение хода', async () => {
    const { deps } = makeDeps();
    await service(deps).checkLayout({ identifier: 'mail' });
    expect(deps.render).toHaveBeenCalledWith({
      html: HTML.v0,
      lines: ['Заголовок', 'Абзац'],
      messageId: 'msg_A',
      topicId: 'tpc_1',
      userId: 15,
      width: 320,
    });
  });

  it('правщик получает модель и поставщика хода, тему и сообщение — списание ляжет в эту тему', async () => {
    const { deps } = makeDeps();
    await service(deps).checkLayout({ identifier: 'mail' });
    expect(deps.turnModel).toHaveBeenCalledWith('msg_A');
    expect(deps.askEditor).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'claude-opus-5-5',
        parentMessageId: 'msg_A',
        provider: 'anthropic',
        topicId: 'tpc_1',
      }),
    );
  });

  it('макет не сказан — последний PDF темы с описанием; PDF без описания пропускается', async () => {
    const prepRecord = vi.fn(async (id: string) =>
      id === 'newest' ? mockRecord({ layout: undefined }) : mockRecord(),
    );
    const { deps } = makeDeps({
      prepRecord,
      topicPdfs: vi.fn(async () => [
        { id: 'newest', name: 'договор.pdf' },
        { id: 'older', name: 'макет.pdf' },
      ]),
    });
    const result = await service(deps).checkLayout({ identifier: 'mail' });
    expect(result.file).toBe('макет.pdf');
    expect(prepRecord.mock.calls.map((call) => call[0])).toEqual(['newest', 'older']);
  });

  it('макет по имени: точное совпадение, потом вхождение без регистра; нет такого — ошибка со списком', async () => {
    const pdfs = [
      { id: 'a', name: 'Макет-1.pdf' },
      { id: 'b', name: 'Макет-2.pdf' },
    ];
    const { deps } = makeDeps({ topicPdfs: vi.fn(async () => pdfs) });
    expect(
      (await service(deps).checkLayout({ file: 'макет-2.PDF', identifier: 'mail' })).file,
    ).toBe('Макет-2.pdf');
    expect((await service(deps).checkLayout({ file: '1.pdf', identifier: 'mail' })).file).toBe(
      'Макет-1.pdf',
    );
    await expect(
      service(deps).checkLayout({ file: 'другой.pdf', identifier: 'mail' }),
    ).rejects.toThrow(/в теме нет PDF «другой\.pdf»\. Есть: «Макет-1\.pdf», «Макет-2\.pdf»/);
  });

  it('в теме нет PDF или ни у одного нет описания макета — ошибка с объяснением', async () => {
    const none = makeDeps({ topicPdfs: vi.fn(async () => []) });
    await expect(service(none.deps).checkLayout({ identifier: 'mail' })).rejects.toThrow(
      /в теме нет PDF-макета/,
    );

    const plain = makeDeps({ prepRecord: vi.fn(async () => mockRecord({ layout: undefined })) });
    await expect(service(plain.deps).checkLayout({ identifier: 'mail' })).rejects.toThrow(
      /нет описания макета: оно делается для макетов/,
    );
  });

  it('отрисовка недоступна (429/502): «сверка недоступна» без падения хода, файл не сохраняется, лог с темой и человеком', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { deps, saved } = makeDeps({
      render: vi.fn(async () => {
        throw new LayoutRenderError('rate_limit', 'лимит отрисовок исчерпан (60 в час)', 429);
      }),
    });
    const result = await service(deps).checkLayout({ identifier: 'mail' });

    expect(result).toMatchObject({
      changed: false,
      rounds: [],
      status: 'unavailable',
      unavailableReason: 'лимит отрисовок исчерпан (60 в час)',
    });
    expect(saved).toEqual([]);
    expect(deps.askEditor).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/topic=tpc_1 user=u1.*\(rate_limit\).*60 в час/),
    );
  });

  it('другая ошибка отрисовки (не LayoutRenderError) — настоящая ошибка, а не «недоступна»', async () => {
    const { deps } = makeDeps({
      render: vi.fn(async () => {
        throw new TypeError('баг');
      }),
    });
    await expect(service(deps).checkLayout({ identifier: 'mail' })).rejects.toThrow('баг');
  });

  it('модель хода неизвестна — правщика нет, сверка всё равно возвращает замер и файл с исходной версией', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { deps, saved } = makeDeps({ turnModel: vi.fn(async () => undefined) });
    const result = await service(deps).checkLayout({ identifier: 'mail' });
    expect(result.stopped).toBe('editor_failed');
    expect(result.problem).toMatch(/не известны модель и поставщик/);
    expect(result.changed).toBe(false);
    expect(result.remaining).toHaveLength(1);
    expect(saved[0].html).toBe(HTML.v0);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/topic=tpc_1 user=u1.*editor_failed/));
  });

  it('макет картинкой не собрался — сверка идёт без похожести, предупреждение в журнале', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { deps } = makeDeps({
      prepRecord: vi.fn(async () =>
        mockRecord({
          pages: [
            {
              fileId: 'p',
              height: 10,
              index: 1,
              key: 'k',
              mime: 'image/png',
              page: 1,
              total: 1,
              width: 10,
            },
          ],
        }),
      ),
      readStorage: vi.fn(async () => {
        throw new Error('хранилище недоступно');
      }),
    });
    const result = await service(deps).checkLayout({ identifier: 'mail' });
    expect(result.status).toBe('checked');
    expect(result.before?.similarity).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/макет картинкой не собран: хранилище недоступно/),
    );
  });

  it('что осталось — главные расхождения словами; наблюдения правщика — из последнего круга', async () => {
    const { deps } = makeDeps({
      askEditor: vi.fn(
        async () => 'Вижу: у кнопки другой цвет.\n[{"find": "нет", "replace": "x"}]',
      ),
    });
    const result = await service(deps).checkLayout({ identifier: 'mail' });
    expect(result.changed).toBe(false);
    expect(result.remaining[0]).toMatch(/^«Абзац» \(макет y80 x20\): по горизонтали \+60$/);
    expect(result.observations).toBe('Вижу: у кнопки другой цвет.');
    expect(result.rounds).toHaveLength(3);
  });
});

describe('checkLayout: приёмы, которые выбросит почта', () => {
  const ABS = '<p style="position:absolute;left:20px">v0</p>';
  const TABLE = '<table><tr><td>v1</td></tr></table>';
  const absOf = (html: string) => (html === ABS ? page(true) : page(false));

  it('позиционное письмо: приёмы названы до и после; правки их не убрали — «остались»', async () => {
    const { deps } = makeDeps({
      artifactMessages: vi.fn(async () => [{ content: tag('mail', ABS), id: 'm1' }]),
      askEditor: vi.fn(async () => '[{"find": "v0", "replace": "v1"}]'),
      render: vi.fn(async ({ html }) => absOf(html)),
    });
    const result = await service(deps).checkLayout({ identifier: 'mail' });

    expect(result.techniques?.before).toEqual([
      expect.objectContaining({ count: 1, kind: 'position', label: 'position:absolute/fixed' }),
    ]);
    expect(result.techniques?.left).toEqual(result.techniques?.before);
    expect(result.techniques?.before[0].example).toMatch(/^position:absolute;left:20px/);
    expect(result.changed).toBe(false);
    // приёмы не дублируются в списке «осталось»: там только положение
    expect(result.remaining.every((item) => !item.includes('почта выбросит'))).toBe(true);
    expect(result.remaining[0]).toMatch(/^«Абзац»/);
  });

  it('правщик убрал приёмы — before есть, left пусто', async () => {
    const { deps, saved } = makeDeps({
      artifactMessages: vi.fn(async () => [{ content: tag('mail', ABS), id: 'm1' }]),
      askEditor: vi.fn(async () => JSON.stringify([{ find: ABS, replace: TABLE }])),
      render: vi.fn(async ({ html }) => absOf(html)),
    });
    const result = await service(deps).checkLayout({ identifier: 'mail' });
    expect(result.techniques?.before).toHaveLength(1);
    expect(result.techniques?.left).toEqual([]);
    expect(result.changed).toBe(true);
    expect(saved[0].html).toBe(TABLE);
  });

  it('обычное письмо — приёмов нет ни до, ни после', async () => {
    const { deps } = makeDeps();
    const result = await service(deps).checkLayout({ identifier: 'mail' });
    expect(result.techniques).toEqual({ before: [], left: [] });
  });

  it('отрисовка недоступна: приёмы всё равно найдены (проверка по тексту HTML)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { deps } = makeDeps({
      artifactMessages: vi.fn(async () => [{ content: tag('mail', ABS), id: 'm1' }]),
      render: vi.fn(async () => {
        throw new LayoutRenderError('unavailable', 'отрисовка сейчас недоступна', 502);
      }),
    });
    const result = await service(deps).checkLayout({ identifier: 'mail' });
    expect(result.status).toBe('unavailable');
    expect(result.techniques?.left).toEqual([
      expect.objectContaining({ count: 1, kind: 'position' }),
    ]);
  });

  it('ARCKEP_LAYOUT_TECHNIQUES=0 — приёмы не ищутся', async () => {
    process.env.ARCKEP_LAYOUT_TECHNIQUES = '0';
    try {
      const { deps } = makeDeps({
        artifactMessages: vi.fn(async () => [{ content: tag('mail', ABS), id: 'm1' }]),
        render: vi.fn(async ({ html }) => absOf(html)),
      });
      const result = await service(deps).checkLayout({ identifier: 'mail' });
      expect(result.techniques).toEqual({ before: [], left: [] });
    } finally {
      delete process.env.ARCKEP_LAYOUT_TECHNIQUES;
    }
  });
});
