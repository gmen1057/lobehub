import { describe, expect, it } from 'vitest';

import {
  buildEditorMessage,
  EDITOR_SYSTEM,
  MAX_LISTED_ISSUES,
  parseEditorReply,
  summarizeIssues,
} from '../editor';
import type { Issue, LineIssue, MockupBlock } from '../types';

const line = (index: number, y: number, extra: Partial<LineIssue> = {}): LineIssue => ({
  index,
  key: `line:${index}`,
  kind: 'line',
  mock: { size: 20, text: `строка ${index}`, w: 200, x: 40, y },
  ...extra,
});

describe('ответ правщика: «что вижу» и правки', () => {
  it('сначала наблюдения, потом JSON в блоке ```json', () => {
    const reply = [
      'Вижу: у кнопки другой цвет (#FF7A00 вместо #FFBB73), пропала линия под шапкой.',
      '',
      '```json',
      '[{"find": "<a class=\\"btn\\">", "replace": "<a class=\\"btn2\\">"}, {"find": "x", "replace": ""}]',
      '```',
    ].join('\n');
    const parsed = parseEditorReply(reply);
    expect(parsed.observations).toBe(
      'Вижу: у кнопки другой цвет (#FF7A00 вместо #FFBB73), пропала линия под шапкой.',
    );
    expect(parsed.edits).toEqual([
      { find: '<a class="btn">', replace: '<a class="btn2">' },
      { find: 'x', replace: '' },
    ]);
    expect(parsed.error).toBeUndefined();
  });

  it('массив без ограды кода и квадратные скобки в самом HTML внутри строк', () => {
    const reply =
      'Вижу: сдвиг. Правлю:\n[{"find": "<p data-x=\\"[1,2]\\">", "replace": "<p data-x=\\"[3]\\">"}]';
    const parsed = parseEditorReply(reply);
    expect(parsed.edits).toEqual([{ find: '<p data-x="[1,2]">', replace: '<p data-x="[3]">' }]);
    expect(parsed.observations).toBe('Вижу: сдвиг. Правлю:');
  });

  it('несколько блоков: берётся последний подходящий; пустой массив — «править нечего»', () => {
    const reply = '```json\n[{"find":"a","replace":"b"}]\n```\nНет, передумал:\n```json\n[]\n```';
    expect(parseEditorReply(reply).edits).toEqual([]);
  });

  it('битый JSON — правок нет, причина названа (круг пропускается)', () => {
    const parsed = parseEditorReply('Вижу сдвиг.\n```json\n[{"find": "a", "replace": }]\n```');
    expect(parsed.edits).toBeUndefined();
    expect(parsed.error).toMatch(/нет разбираемого массива правок/);
    expect(parsed.observations).toContain('Вижу сдвиг');
  });

  it('пустой ответ и ответ без массива', () => {
    expect(parseEditorReply('')).toMatchObject({ error: 'правщик ответил пустым текстом' });
    expect(parseEditorReply('Всё хорошо, править нечего.').edits).toBeUndefined();
    // массив чисел — не правки
    expect(parseEditorReply('Размеры [1, 2, 3]').edits).toBeUndefined();
  });

  it('«что вижу» обрезается по длине', () => {
    const parsed = parseEditorReply(`${'длинно '.repeat(500)}\n[]`);
    expect(parsed.edits).toEqual([]);
    expect(parsed.observations.length).toBeLessThanOrEqual(1500);
  });
});

describe('расхождения для правщика', () => {
  const blocks: MockupBlock[] = [
    { color: '#F6F7FA', h: 495, kind: 'fill', w: 600, x: 0, y: 2901 },
    { color: '#DDEEF8', h: 190, kind: 'fill', w: 560, x: 20, y: 3101 },
  ];

  it('одинаковые сдвиги по высоте у многих строк сворачиваются в один пункт-«каскад»', () => {
    const issues: Issue[] = [
      line(1, 100, { dx: 12 }),
      ...Array.from({ length: 8 }, (_, i) => line(10 + i, 3000 + i * 30, { dy: 27 + (i % 2) })),
    ];
    const text = summarizeIssues(issues, blocks).join('\n');
    expect(text).toContain('строки с y3000 до y3210 (8 шт.) смещены по высоте на +28');
    expect(text).toContain('причина выше y3000');
    // одиночное расхождение остаётся отдельным пунктом
    expect(text).toContain('строка 1');
    expect(text).not.toContain('строка 12');
  });

  it('три одинаковых сдвига — ещё не каскад', () => {
    const issues: Issue[] = [
      line(1, 3000, { dy: 20 }),
      line(2, 3030, { dy: 20 }),
      line(3, 3060, { dy: 20 }),
    ];
    const text = summarizeIssues(issues, blocks).join('\n');
    expect(text).not.toContain('одинаково');
    expect(text).toContain('строка 1');
  });

  it('группировка по блокам макета: самый внутренний блок над строкой и «вне блоков»', () => {
    const issues: Issue[] = [
      line(1, 50, { dx: 9 }),
      line(2, 3150, { dx: 9 }),
      line(3, 2950, { dx: 8 }),
    ];
    const lines = summarizeIssues(issues, blocks);
    expect(lines).toContain('вне блоков / общее:');
    expect(lines.some((item) => item.startsWith('блок x20 y3101 560×190 (#DDEEF8):'))).toBe(true);
    expect(lines.some((item) => item.startsWith('блок x0 y2901 600×495 (#F6F7FA):'))).toBe(true);
    // порядок групп — сверху вниз
    expect(lines.indexOf('вне блоков / общее:')).toBeLessThan(
      lines.findIndex((item) => item.startsWith('блок x0 y2901')),
    );
  });

  it(`пунктов не больше ${MAX_LISTED_ISSUES}; остальное — одна строка «и ещё N»`, () => {
    const issues: Issue[] = Array.from({ length: 45 }, (_, i) =>
      line(i, 100 + i * 25, { dx: 10 + i }),
    );
    const lines = summarizeIssues(issues, []);
    expect(lines.filter((item) => item.startsWith('  - '))).toHaveLength(MAX_LISTED_ISSUES);
    expect(lines.at(-1)).toBe('… и ещё 15 расхождений ниже');
  });
});

describe('сообщение правщику', () => {
  const input = {
    blocks: [] as MockupBlock[],
    file: 'new.pdf',
    html: '<p>Привет</p>',
    issues: [line(1, 100, { dx: 12 })] as Issue[],
    similarity: 89.3,
    width: 600,
  };

  it('текст: макет, окно, похожесть, список расхождений и текущий HTML', () => {
    const parts = buildEditorMessage(input);
    expect(parts).toHaveLength(1);
    const text = (parts[0] as { text: string }).text;
    expect(text).toContain('Макет: new.pdf, окно письма 600 px.');
    expect(text).toContain('Похожесть письма на макет по картинке: 89.3 %.');
    expect(text).toContain('Расхождения, которые измерила программа (1):');
    expect(text).toContain('```html\n<p>Привет</p>\n```');
    // переписки нет: это единственное сообщение
    expect(text).not.toContain('Ранее');
  });

  it('картинки: обзор и пары идут как data:-адреса после текста, у каждой подпись', () => {
    const jpeg = Buffer.from([0xFF, 0xD8, 0xFF, 0xD9]);
    const parts = buildEditorMessage({
      ...input,
      pictures: {
        overview: jpeg,
        strips: [{ caption: 'y 0–480: красным обведено 1 расхождений', from: 0, jpeg, to: 480 }],
      },
    });
    expect(parts.map((part) => part.type)).toEqual([
      'text',
      'text',
      'image_url',
      'text',
      'image_url',
    ]);
    expect((parts[2] as { image_url: { url: string } }).image_url.url).toMatch(
      /^data:image\/jpeg;base64,/,
    );
    expect((parts[3] as { text: string }).text).toContain('y 0–480');
  });

  it('пометка об откате прошлых правок попадает в сообщение; без расхождений — смотри картинки', () => {
    const text = (
      buildEditorMessage({
        ...input,
        failedAttempt: 'прошлые правки сделали хуже и откачены (появились новые расхождения)',
        issues: [],
      })[0] as { text: string }
    ).text;
    expect(text).toContain('ВАЖНО: прошлые правки сделали хуже и откачены');
    expect(text).toContain('Программа расхождений положения не нашла: смотри только картинки.');
  });

  it('системный текст требует: что вижу (в т. ч. то, чего линейка не меряет) → JSON-массив; не письмо целиком', () => {
    expect(EDITOR_SYSTEM).toMatch(/цвет, жирность/);
    expect(EDITOR_SYSTEM).toMatch(/JSON-массив правок/);
    expect(EDITOR_SYSTEM).toMatch(/Письмо целиком не переписывай/);
    expect(EDITOR_SYSTEM).toMatch(/ровно один раз/);
  });
});

describe('приёмы, которые выбросит почта, в сообщении правщику', () => {
  const technique = {
    count: 77,
    examples: ['position: absolute; left: 20px; top: 35px', 'position:absolute;left:11px'],
    kind: 'position' as const,
    label: 'position:absolute/fixed',
  };
  const input = {
    blocks: [] as MockupBlock[],
    file: 'new.pdf',
    html: '<p style="position:absolute">Привет</p>',
    issues: [
      {
        key: 'technique:position',
        kind: 'technique' as const,
        text: 'почта выбросит position:absolute/fixed ×77',
        y: -1,
      },
      line(1, 100, { dx: 12 }),
    ] as Issue[],
    techniques: [technique],
    width: 600,
  };

  it('отдельный раздел перед списком расхождений положения: число, виды, примеры, «важнее похожести»', () => {
    const text = (buildEditorMessage(input)[0] as { text: string }).text;
    const section = text.indexOf('Приёмы, которые выбросит почта (77;');
    expect(section).toBeGreaterThan(0);
    expect(text).toContain('важнее похожести, правка без их уборки будет отклонена');
    expect(text).toContain(
      '- position:absolute/fixed ×77\n  пример: position: absolute; left: 20px; top: 35px',
    );
    expect(text).toContain('пример: position:absolute;left:11px');
    expect(section).toBeLessThan(text.indexOf('Расхождения, которые измерила программа'));
  });

  it('расхождения положения считаются без приёмов и в списке их нет', () => {
    const text = (buildEditorMessage(input)[0] as { text: string }).text;
    expect(text).toContain('Расхождения, которые измерила программа (1):');
    expect(text).not.toContain('почта выбросит');
    expect(summarizeIssues(input.issues, [])).toEqual([
      'вне блоков / общее:',
      expect.stringContaining('строка 1'),
    ]);
  });

  it('нет приёмов — раздела нет', () => {
    const text = (
      buildEditorMessage({ ...input, issues: [line(1, 100, { dx: 12 })], techniques: [] })[0] as {
        text: string;
      }
    ).text;
    expect(text).not.toContain('Приёмы, которые выбросит почта');
  });

  it('только приёмы, положение в порядке — так и сказано, смотри картинки', () => {
    const text = (
      buildEditorMessage({ ...input, issues: input.issues.slice(0, 1) })[0] as { text: string }
    ).text;
    expect(text).toContain('Программа расхождений положения не нашла: смотри только картинки.');
    expect(text).toContain('Приёмы, которые выбросит почта (77;');
  });

  it('системный текст: почта выбрасывает position/flex/grid/float/стили/script — заменять таблицей, расчёт по макету', () => {
    expect(EDITOR_SYSTEM).toMatch(/Gmail, Outlook/);
    expect(EDITOR_SYSTEM).toMatch(/position:absolute\/fixed, display:flex\/grid, float/);
    expect(EDITOR_SYSTEM).toMatch(/<script>/);
    expect(EDITOR_SYSTEM).toMatch(/важнее похожести/);
    expect(EDITOR_SYSTEM).toMatch(/таблицей/);
  });
});
