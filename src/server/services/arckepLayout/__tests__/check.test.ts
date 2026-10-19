import { readFileSync } from 'node:fs';
import path from 'node:path';

import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  checkBudgetMs,
  type CheckDeps,
  type CheckInput,
  checkRounds,
  judge,
  runLayoutCheck,
  techniqueIssues,
} from '../check';
import { compareLayout, issueText } from '../compare';
import type { EditorPart } from '../editor';
import type { RawPicture } from '../pictures';
import { LayoutRenderError } from '../render';
import { TECHNIQUE_LABELS, type TechniqueFinding } from '../techniques';
import type { Measure, Mockup, RenderResult } from '../types';
import mockupJson from './fixtures/mockup.json';
import r1Json from './fixtures/render-r1.json';
import r2Json from './fixtures/render-r2.json';

// arckep (19.10.2026): цикл сверки на подменённых отрисовке и правщике — круги, приём версии, откат, пределы.

const mockup: Mockup = {
  blocks: [],
  crops: [],
  height: 400,
  lines: [
    { size: 20, text: 'Заголовок', w: 100, x: 20, y: 20 },
    { size: 16, text: 'Абзац', w: 100, x: 20, y: 80 },
    { size: 16, text: 'Кнопка', w: 100, x: 20, y: 140 },
  ],
  width: 300,
};

/** Отрисовка: x и y трёх строк (верх строки на 3 px ниже макета — общий сдвиг, не расхождение). */
const page = (
  positions: Array<{ x: number; y: number }>,
  screenshot = '',
  extra: Partial<RenderResult> = {},
): RenderResult => ({
  failed_images: [],
  height: 400,
  images: [],
  lines: mockup.lines.map((line, index) => ({
    found: true,
    font_size: line.size,
    h: 24,
    text: line.text,
    x: positions[index].x,
    y: positions[index].y,
  })),
  scroll_width: 300,
  screenshot_jpeg_base64: screenshot,
  width: 300,
  ...extra,
});

const good = [
  { x: 20, y: 23 },
  { x: 20, y: 83 },
  { x: 20, y: 143 },
];
/** «Абзац» уехал по x — одно расхождение */
const v0 = page([good[0], { x: 60, y: 83 }, good[2]]);
/** всё на месте */
const v1 = page(good);
/** «Абзац» починен, но «Кнопка» уехала вниз — новое расхождение там, где было на месте */
const v2 = page([good[0], good[1], { x: 20, y: 183 }]);

const HTML = { v0: '<p>v0</p>', v1: '<p>v1</p>', v2: '<p>v2</p>' };
const renders: Record<string, RenderResult> = {
  [HTML.v0]: v0,
  [HTML.v1]: v1,
  [HTML.v2]: v2,
};

const input = (extra: Partial<CheckInput> = {}): CheckInput => ({
  file: 'new.pdf',
  html: HTML.v0,
  mockup,
  vision: false,
  ...extra,
});

const edit = (from: keyof typeof HTML, to: keyof typeof HTML) =>
  `Вижу сдвиг.\n\`\`\`json\n[{"find": "${from}", "replace": "${to}"}]\n\`\`\``;

const deps = (answers: Array<string | Error>, overrides: Partial<CheckDeps> = {}) => {
  const asked: Array<{ parts: EditorPart[]; system: string }> = [];
  const rendered: string[] = [];
  const value: CheckDeps = {
    askEditor: vi.fn(async (system, parts) => {
      asked.push({ parts, system });
      const answer = answers[asked.length - 1] ?? '[]';
      if (answer instanceof Error) throw answer;
      return answer;
    }),
    render: vi.fn(async (html) => {
      rendered.push(html);
      const result = renders[html];
      if (!result) throw new Error(`нет заготовки для ${html}`);
      return result;
    }),
    ...overrides,
  };
  return { asked, deps: value, rendered };
};

const text = (parts: EditorPart[]) => (parts[0] as { text: string }).text;

describe('цикл сверки', () => {
  it('круг принят: письмо стало лучше, расхождений нет — цикл останавливается («чисто»), второго вызова нет', async () => {
    const { asked, deps: d, rendered } = deps([edit('v0', 'v1')]);
    const outcome = await runLayoutCheck(input(), d);

    expect(outcome.initial.comparison.issues).toHaveLength(1);
    expect(outcome.best.html).toBe(HTML.v1);
    expect(outcome.best.comparison.issues).toEqual([]);
    expect(outcome.stopped).toBe('clean');
    expect(outcome.rounds).toHaveLength(1);
    expect(outcome.rounds[0]).toMatchObject({
      applied: 1,
      rejected: 0,
      round: 1,
      status: 'accepted',
    });
    expect(outcome.rounds[0].observations).toBe('Вижу сдвиг.');
    // отрисовок две (исходное письмо и после правок), вызов правщика один
    expect(rendered).toEqual([HTML.v0, HTML.v1]);
    expect(asked).toHaveLength(1);
    // правщик получает только текущий HTML и список расхождений — без переписки
    expect(text(asked[0].parts)).toContain('<p>v0</p>');
    expect(text(asked[0].parts)).toContain('«Абзац»');
    expect(asked[0].system).toMatch(/Тебя вызывает программа сверки/);
  });

  it('исправило названное, но сломало соседнее — не принимается, откат, второй круг получает пометку что и почему', async () => {
    const { asked, deps: d } = deps([edit('v0', 'v2'), edit('v0', 'v1')]);
    const outcome = await runLayoutCheck(input(), d);

    expect(outcome.rounds.map((round) => round.status)).toEqual(['rolled_back', 'accepted']);
    expect(outcome.rounds[0].note).toMatch(/появились новые расхождения там, где было на месте/);
    expect(outcome.rounds[0].note).toContain('«Кнопка»');
    // откатились к лучшей версии, правщик второго круга исходил из неё (v0), а не из v2
    expect(text(asked[1].parts)).toContain('<p>v0</p>');
    expect(text(asked[1].parts)).toContain('ВАЖНО: прошлые правки сделали хуже и откачены');
    expect(outcome.best.html).toBe(HTML.v1);
    expect(outcome.stopped).toBe('clean');
  });

  it('битый JSON — круг пропускается, версия не меняется; кругов не больше трёх', async () => {
    const { asked, deps: d, rendered } = deps(['ерунда без массива', '[{"find": }]', 'опять']);
    const outcome = await runLayoutCheck(input(), d);

    expect(outcome.rounds.map((round) => round.status)).toEqual([
      'no_edits',
      'no_edits',
      'no_edits',
    ]);
    expect(outcome.rounds[0].note).toMatch(/нет разбираемого массива правок/);
    expect(asked).toHaveLength(3);
    expect(rendered).toEqual([HTML.v0]);
    expect(outcome.best.html).toBe(HTML.v0);
    expect(outcome.stopped).toBe('rounds');
  });

  it('правки не применились (find не найден) — пометка в следующем круге, отрисовки нет', async () => {
    const {
      asked,
      deps: d,
      rendered,
    } = deps(['[{"find": "нет такого", "replace": "x"}]', edit('v0', 'v1')]);
    const outcome = await runLayoutCheck(input(), d);

    expect(outcome.rounds[0]).toMatchObject({ applied: 0, rejected: 1, status: 'nothing_applied' });
    expect(text(asked[1].parts)).toContain('прошлые правки не применились');
    expect(text(asked[1].parts)).toContain('не найдено в тексте');
    expect(rendered).toEqual([HTML.v0, HTML.v1]);
    expect(outcome.best.html).toBe(HTML.v1);
  });

  it('пределы: ARCKEP_LAYOUT_CHECK_ROUNDS и параметр rounds', async () => {
    const { asked, deps: d } = deps(['[]', '[]', '[]', '[]']);
    const outcome = await runLayoutCheck(input(), d, { rounds: 2 });
    expect(asked).toHaveLength(2);
    expect(outcome.rounds).toHaveLength(2);
    expect(outcome.rounds[0].status).toBe('nothing_applied');
  });

  it('ошибка первой отрисовки — исключение (вызывающий скажет «сверка недоступна»)', async () => {
    const { deps: d } = deps([], {
      render: vi.fn(async () => {
        throw new LayoutRenderError('rate_limit', 'лимит отрисовок исчерпан (60 в час)', 429);
      }),
    });
    await expect(runLayoutCheck(input(), d)).rejects.toMatchObject({ kind: 'rate_limit' });
  });

  it('ошибка отрисовки после правок — цикл останавливается, лучшая версия остаётся', async () => {
    let calls = 0;
    const { deps: d } = deps([edit('v0', 'v1')], {
      render: vi.fn(async (html) => {
        if (++calls > 1)
          throw new LayoutRenderError('unavailable', 'отрисовка сейчас недоступна', 502);
        return renders[html];
      }),
    });
    const outcome = await runLayoutCheck(input(), d);
    expect(outcome.stopped).toBe('render_failed');
    expect(outcome.problem).toMatch(/отрисовка не удалась: отрисовка сейчас недоступна/);
    expect(outcome.rounds[0].status).toBe('render_failed');
    expect(outcome.best.html).toBe(HTML.v0);
  });

  it('правщик не ответил (например, не хватило денег) — цикл останавливается с причиной', async () => {
    const { deps: d } = deps([new Error('Недостаточно средств')]);
    const outcome = await runLayoutCheck(input(), d);
    expect(outcome.stopped).toBe('editor_failed');
    expect(outcome.problem).toBe('правщик не ответил: Недостаточно средств');
    expect(outcome.rounds[0]).toMatchObject({
      note: 'Недостаточно средств',
      status: 'editor_failed',
    });
    expect(outcome.best.html).toBe(HTML.v0);
  });

  it('бюджет времени: на втором круге не хватает времени — стоп «время»', async () => {
    let clock = 0;
    const { asked, deps: d } = deps([], {
      askEditor: vi.fn(async () => {
        clock += 100_000;
        return '[{"find": "v0", "replace": "v2"}]';
      }),
      now: () => clock,
      render: vi.fn(async (html) => {
        clock += 20_000;
        return renders[html];
      }),
    });
    const outcome = await runLayoutCheck(input(), d, { budgetMs: 240_000, rounds: 3 });
    // круг 1: 120 с (правщик + отрисовка); к круг 2 осталось 100 с < 120 с → стоп
    expect(outcome.rounds).toHaveLength(1);
    expect(outcome.stopped).toBe('time');
    expect(asked).toHaveLength(0);
  });

  it('чисто с самого начала — правщик не вызывается', async () => {
    const { asked, deps: d } = deps([]);
    const outcome = await runLayoutCheck(input({ html: HTML.v1 }), d);
    expect(asked).toHaveLength(0);
    expect(outcome.stopped).toBe('clean');
    expect(outcome.rounds).toEqual([]);
  });
});

describe('приём версии: похожесть по картинке', () => {
  const solid = (width: number, height: number, value: number): RawPicture => ({
    data: Buffer.alloc(width * height * 3, value),
    height,
    width,
  });
  /** JPEG: белый лист с чёрной полосой сверху нужной высоты */
  const shot = async (blackRows: number) => {
    const data = Buffer.alloc(300 * 400 * 3, 255);
    data.fill(0, 0, 300 * blackRows * 3);
    return (
      await sharp(data, { raw: { channels: 3, height: 400, width: 300 } })
        .jpeg({ quality: 95 })
        .toBuffer()
    ).toString('base64');
  };

  it('похожесть считается по снимку и макету; выросла и нет новых расхождений — версия принята', async () => {
    const withShots: Record<string, RenderResult> = {
      [HTML.v0]: { ...v0, screenshot_jpeg_base64: await shot(200) },
      [HTML.v1]: { ...v1, screenshot_jpeg_base64: await shot(40) },
    };
    const { deps: d } = deps([edit('v0', 'v1')], {
      render: vi.fn(async (html) => withShots[html]),
    });
    const outcome = await runLayoutCheck(input({ mockPicture: solid(300, 400, 255) }), d);

    expect(outcome.initial.similarity).toBeGreaterThan(49);
    expect(outcome.initial.similarity).toBeLessThan(52);
    expect(outcome.best.similarity).toBeGreaterThan(85);
    expect(outcome.rounds[0]).toMatchObject({ status: 'accepted' });
    expect(outcome.rounds[0].similarityBefore).toBe(outcome.initial.similarity);
    expect(outcome.rounds[0].similarityAfter).toBe(outcome.best.similarity);
  });

  it('похожесть выросла, но «Кнопка» уехала на +28 — не принимается (защита от сломанного соседнего)', async () => {
    const withShots: Record<string, RenderResult> = {
      [HTML.v0]: { ...v0, screenshot_jpeg_base64: await shot(200) },
      [HTML.v2]: { ...v2, screenshot_jpeg_base64: await shot(40) },
    };
    const { deps: d } = deps([edit('v0', 'v2'), '[]', '[]'], {
      render: vi.fn(async (html) => withShots[html]),
    });
    const outcome = await runLayoutCheck(input({ mockPicture: solid(300, 400, 255) }), d);
    expect(outcome.rounds[0].status).toBe('rolled_back');
    expect(outcome.rounds[0].similarityAfter!).toBeGreaterThan(outcome.rounds[0].similarityBefore!);
    expect(outcome.best.html).toBe(HTML.v0);
  });

  it('модель со зрением: правщик получает обзор и пары «макет | письмо»', async () => {
    const withShots: Record<string, RenderResult> = {
      [HTML.v0]: { ...v0, screenshot_jpeg_base64: await shot(200) },
      [HTML.v1]: { ...v1, screenshot_jpeg_base64: await shot(0) },
    };
    const { asked, deps: d } = deps([edit('v0', 'v1')], {
      render: vi.fn(async (html) => withShots[html]),
    });
    await runLayoutCheck(input({ mockPicture: solid(300, 400, 255), vision: true }), d);
    const types = asked[0].parts.map((part) => part.type);
    expect(types[0]).toBe('text');
    expect(types.filter((type) => type === 'image_url').length).toBeGreaterThanOrEqual(2);

    // без зрения — только текст
    const text = deps([edit('v0', 'v1')], { render: vi.fn(async (html) => withShots[html]) });
    await runLayoutCheck(input({ mockPicture: solid(300, 400, 255), vision: false }), text.deps);
    expect(text.asked[0].parts.map((part) => part.type)).toEqual(['text']);
  });
});

describe('judge: приём версии', () => {
  const measure = (render: RenderResult, similarity?: number): Measure => ({
    comparison: compareLayout(mockup, render),
    render,
    similarity,
  });

  it('похожесть не выросла — не принимается, даже если расхождений стало меньше', () => {
    const verdict = judge(measure(v0, 80), measure(v1, 80));
    expect(verdict.accept).toBe(false);
    expect(verdict.reason).toMatch(/похожесть по картинке не выросла \(80,0 % → 80,0 %\)/);
  });

  it('выросла, но появилось новое расхождение — не принимается', () => {
    const verdict = judge(measure(v0, 80), measure(v2, 90));
    expect(verdict.accept).toBe(false);
    expect(verdict.reason).toMatch(/новые расхождения/);
    expect(verdict.reason).not.toMatch(/похожесть по картинке не выросла/);
  });

  it('выросла и ничего нового — принимается', () => {
    expect(judge(measure(v0, 80), measure(v1, 90))).toEqual({ accept: true, reason: '' });
  });

  it('без картинки: принимается, только если расхождений меньше и нет новых', () => {
    expect(judge(measure(v0), measure(v1)).accept).toBe(true);
    expect(judge(measure(v0), measure(v2)).accept).toBe(false);
    expect(judge(measure(v1), measure(v1)).accept).toBe(false);
  });

  it('прежнее расхождение стало заметно больше — не принимается', () => {
    const far = page([good[0], { x: 120, y: 83 }, good[2]]);
    const verdict = judge(measure(v0, 80), measure(far, 90));
    expect(verdict.accept).toBe(false);
    expect(verdict.reason).toMatch(/стали заметно больше прежние расхождения/);
  });
});

describe('настройки из окружения', () => {
  afterEach(() => {
    delete process.env.ARCKEP_LAYOUT_CHECK_ROUNDS;
    delete process.env.ARCKEP_LAYOUT_CHECK_BUDGET_MS;
  });

  it('кругов по умолчанию 3, бюджет 240 с; переменные меняют, мусор и нули игнорируются', () => {
    expect(checkRounds()).toBe(3);
    expect(checkBudgetMs()).toBe(240_000);
    process.env.ARCKEP_LAYOUT_CHECK_ROUNDS = '2';
    process.env.ARCKEP_LAYOUT_CHECK_BUDGET_MS = '120000';
    expect(checkRounds()).toBe(2);
    expect(checkBudgetMs()).toBe(120_000);
    process.env.ARCKEP_LAYOUT_CHECK_ROUNDS = '0';
    process.env.ARCKEP_LAYOUT_CHECK_BUDGET_MS = 'много';
    expect(checkRounds()).toBe(3);
    expect(checkBudgetMs()).toBe(240_000);
    process.env.ARCKEP_LAYOUT_CHECK_ROUNDS = '99';
    expect(checkRounds()).toBe(5);
  });
});

// настоящее письмо пробы 19.10 (111 строк, 20 вырезок): r1 — первое письмо модели, r2 — после круга «сверить и
// поправить в переписке» (исправило сдвиги по x, но сдвинуло всё ниже на +27/+28 по высоте)
describe('сломанное соседнее на данных пробы 19.10', () => {
  const real: Mockup = {
    blocks: [],
    crops: mockupJson.crops.map(({ name: _name, ...crop }) => crop) as Mockup['crops'],
    height: mockupJson.height,
    lines: mockupJson.lines as Mockup['lines'],
    width: mockupJson.width,
  };
  const fixture = (data: unknown): RenderResult => ({
    screenshot_jpeg_base64: '',
    ...(data as Omit<RenderResult, 'screenshot_jpeg_base64'>),
  });
  const R1 = fixture(r1Json);
  const R2 = fixture(r2Json);

  it('r2 хуже r1 по строкам — не принимается, причина названа, лучшая версия остаётся r1', async () => {
    const asked: EditorPart[][] = [];
    const outcome = await runLayoutCheck(
      { file: 'new.pdf', html: '<main>R1</main>', mockup: real, vision: false },
      {
        askEditor: vi.fn(async (_system, parts) => {
          asked.push(parts);
          return asked.length === 1
            ? 'Вижу сдвиг по x.\n```json\n[{"find": "R1", "replace": "R2"}]\n```'
            : '[]';
        }),
        render: vi.fn(async (html) => (html.includes('R2') ? R2 : R1)),
      },
      { rounds: 2 },
    );

    expect(outcome.initial.comparison.issues).toHaveLength(14);
    expect(outcome.rounds[0].status).toBe('rolled_back');
    expect(outcome.rounds[0].note).toMatch(
      /появились новые расхождения там, где было на месте \(\d+\)/,
    );
    expect(outcome.rounds[0].note).toMatch(/по высоте \+2[3-8]/);
    expect(outcome.best.html).toBe('<main>R1</main>');
    // правщик второго круга получил пометку, что прошлые правки сделали хуже
    expect(text(asked[1])).toContain('прошлые правки сделали хуже и откачены');
    // и список расхождений первой версии: каскад +28 в нём не фигурирует, 13 сдвигов по x — да
    expect(text(asked[1])).toContain('по горизонтали +22');
  });

  it('r1 после r2 тоже не принимается: сдвиги по x вернулись бы (новые расхождения там, где r2 было на месте)', () => {
    const measure = (render: RenderResult): Measure => ({
      comparison: compareLayout(real, render),
      render,
    });
    const verdict = judge(measure(R2), measure(R1));
    expect(verdict.accept).toBe(false);
    expect(verdict.reason).toMatch(/новые расхождения/);
  });
});

// приёмы вёрстки, которые выбросит почта (techniques.ts): важнее похожести
describe('приёмы, которые выбросит почта: приём версии', () => {
  const withTechniques = (
    render: RenderResult,
    techniques: TechniqueFinding[],
    similarity?: number,
  ): Measure => ({
    comparison: (() => {
      const comparison = compareLayout(mockup, render);
      comparison.issues = [...techniqueIssues(techniques), ...comparison.issues];
      return comparison;
    })(),
    render,
    similarity,
    techniques,
  });
  const found = (kind: TechniqueFinding['kind'], count: number): TechniqueFinding => ({
    count,
    examples: [`${kind}-пример`],
    kind,
    label: TECHNIQUE_LABELS[kind],
  });

  it('в лучшей версии приёмов нет, в новой появились — не принимается, даже если похожесть выше', () => {
    const verdict = judge(
      withTechniques(v0, [], 80),
      withTechniques(v1, [found('position', 3)], 99),
    );
    expect(verdict.accept).toBe(false);
    expect(verdict.reason).toMatch(
      /правки вернули приёмы, которые выбросит почта \(position:absolute\/fixed ×3\)/,
    );
    expect(verdict.reason).toMatch(/важнее похожести/);
  });

  it('приёмы остались или их стало не меньше — не принимается, даже если похожесть выше', () => {
    const before = withTechniques(v0, [found('position', 77)], 80);
    expect(judge(before, withTechniques(v1, [found('position', 77)], 99))).toMatchObject({
      accept: false,
      reason: 'приёмы, которые выбросит почта, не убрались (было 77, стало 77)',
    });
    expect(judge(before, withTechniques(v1, [found('position', 78)], 99)).accept).toBe(false);
  });

  it('приёмов стало строго меньше — принимается шагом уборки, хоть похожесть и упала', () => {
    const before = withTechniques(v0, [found('position', 77)], 90);
    expect(judge(before, withTechniques(v1, [found('position', 40)], 70))).toEqual({
      accept: true,
      reason: '',
    });
  });

  it('приёмов стало меньше, но появился новый вид (flex) — не принимается', () => {
    const verdict = judge(
      withTechniques(v0, [found('position', 77)], 90),
      withTechniques(v1, [found('position', 10), found('flex', 2)], 95),
    );
    expect(verdict.accept).toBe(false);
    expect(verdict.reason).toMatch(
      /появились новые приёмы, которые выбросит почта \(display:flex ×2\)/,
    );
  });

  it('приёмы убраны совсем — принимается, даже если новые сдвиги ещё остались (их доведут следующие круги)', () => {
    const verdict = judge(
      withTechniques(v0, [found('position', 5)], 90),
      withTechniques(v2, [], 80),
    );
    expect(verdict).toEqual({ accept: true, reason: '' });
  });

  it('уборка не должна выбросить письмо: строк макета осталось меньше 80 % — не принимается', () => {
    const emptied: RenderResult = {
      ...v1,
      lines: v1.lines.map((line, index) =>
        index === 0 ? line : { found: false, text: line.text },
      ),
    };
    const verdict = judge(
      withTechniques(v0, [found('position', 5)], 90),
      withTechniques(emptied, [], 95),
    );
    expect(verdict.accept).toBe(false);
    expect(verdict.reason).toMatch(/осталось слишком мало строк макета \(1 из 3\)/);
  });

  it('техника вперёд положения: расхождения-приёмы идут первыми, у каждого вида свой ключ', () => {
    const issues = techniqueIssues([found('position', 2), found('script', 1)]);
    expect(issues.map((issue) => [issue.key, issue.kind, issue.y])).toEqual([
      ['technique:position', 'technique', -1],
      ['technique:script', 'technique', -1],
    ]);
    expect(issueText(issues[0])).toBe(
      'почта выбросит position:absolute/fixed ×2 (пример: position-пример)',
    );
  });
});

describe('приёмы в цикле сверки', () => {
  afterEach(() => {
    delete process.env.ARCKEP_LAYOUT_TECHNIQUES;
  });

  const ABS = '<p style="position:absolute;left:20px">v0</p>';
  const TABLE = '<table><tr><td>v1</td></tr></table>';
  const loopRenders: Record<string, RenderResult> = {
    [ABS]: v0,
    [TABLE]: v1,
    '<p style="position:absolute;left:20px">v1</p>': v1,
    '<p style="display:flex">v0</p>': v1,
  };
  const loopDeps = (answers: string[]) => {
    const asked: Array<{ parts: EditorPart[] }> = [];
    const deps: CheckDeps = {
      askEditor: vi.fn(async (_system, parts) => {
        asked.push({ parts });
        return answers[asked.length - 1] ?? '[]';
      }),
      render: vi.fn(async (html) => loopRenders[html]),
    };
    return { asked, deps };
  };

  it('приёмы входят в замер: они первые в списке расхождений и в outcome', async () => {
    const { deps: d } = loopDeps(['[]']);
    const outcome = await runLayoutCheck(input({ html: ABS }), d, { rounds: 1 });
    expect(outcome.initial.techniques).toEqual([
      expect.objectContaining({ count: 1, kind: 'position' }),
    ]);
    expect(outcome.initial.comparison.issues[0]).toMatchObject({
      key: 'technique:position',
      kind: 'technique',
    });
    expect(outcome.initial.comparison.issues).toHaveLength(2);
  });

  it('правщик получает отдельный раздел «Приёмы, которые выбросит почта»; уборка принимается без роста похожести', async () => {
    const { asked, deps: d } = loopDeps([
      `Вижу absolute.\n\`\`\`json\n${JSON.stringify([{ find: ABS, replace: TABLE }])}\n\`\`\``,
    ]);
    const outcome = await runLayoutCheck(input({ html: ABS }), d);

    const message = text(asked[0].parts);
    expect(message).toContain('Приёмы, которые выбросит почта (1;');
    expect(message).toContain('- position:absolute/fixed ×1');
    expect(message).toContain('пример: position:absolute;left:20px');
    // в списке измеренных расхождений приёма нет, а «Абзац» есть
    expect(message).toContain('Расхождения, которые измерила программа (1):');
    expect(outcome.rounds[0].status).toBe('accepted');
    expect(outcome.best.html).toBe(TABLE);
    expect(outcome.best.techniques).toEqual([]);
    expect(outcome.stopped).toBe('clean');
  });

  it('правка, которая улучшила картинку, но оставила position:absolute, откатывается', async () => {
    const { asked, deps: d } = loopDeps([
      '[{"find": "v0", "replace": "v1"}]',
      '[{"find": "v0", "replace": "v1"}]',
    ]);
    const outcome = await runLayoutCheck(input({ html: ABS }), d, { rounds: 2 });
    expect(outcome.rounds.map((round) => round.status)).toEqual(['rolled_back', 'rolled_back']);
    expect(outcome.rounds[0].note).toBe(
      'приёмы, которые выбросит почта, не убрались (было 1, стало 1)',
    );
    expect(text(asked[1].parts)).toContain(
      'ВАЖНО: прошлые правки сделали хуже и откачены (приёмы, которые выбросит почта',
    );
    expect(outcome.best.html).toBe(ABS);
    expect(outcome.best.techniques).toHaveLength(1);
    expect(outcome.stopped).toBe('rounds');
  });

  it('приёмы остаются «не чисто»: цикл не останавливается досрочно, даже если расхождений положения нет', async () => {
    loopRenders['<p style="position:absolute">v1</p>'] = v1;
    const { asked, deps: d } = loopDeps(['[]', '[]']);
    const outcome = await runLayoutCheck(
      input({ html: '<p style="position:absolute">v1</p>' }),
      d,
      { rounds: 2 },
    );
    expect(outcome.stopped).not.toBe('clean');
    expect(asked).toHaveLength(2);
    expect(outcome.best.comparison.issues.map((issue) => issue.kind)).toEqual(['technique']);
  });

  it('живое письмо с 77 position:absolute: приёмы названы в сообщении правщику, версия без уборки не принимается', async () => {
    const live = readFileSync(path.join(__dirname, 'fixtures/live-absolute.html'), 'utf8');
    const real: Mockup = {
      blocks: [],
      crops: mockupJson.crops.map(({ name: _name, ...crop }) => crop) as Mockup['crops'],
      height: mockupJson.height,
      lines: mockupJson.lines as Mockup['lines'],
      width: mockupJson.width,
    };
    const R1 = { ...(r1Json as unknown as RenderResult), screenshot_jpeg_base64: '' };
    const asked: EditorPart[][] = [];
    const outcome = await runLayoutCheck(
      { file: 'new.pdf', html: live, mockup: real, vision: false },
      {
        askEditor: vi.fn(async (_system, parts) => {
          asked.push(parts);
          // правщик «исправил» сдвиг по x, но абсолютные блоки остались
          return '[{"find": "<title>", "replace": "<title> "}]';
        }),
        render: vi.fn(async () => R1),
      },
      { rounds: 2 },
    );

    expect(outcome.initial.techniques).toEqual([
      expect.objectContaining({ count: 77, kind: 'position' }),
    ]);
    expect(text(asked[0])).toContain('Приёмы, которые выбросит почта (77;');
    expect(text(asked[0])).toContain('- position:absolute/fixed ×77');
    expect(outcome.rounds.map((round) => round.status)).toEqual(['rolled_back', 'rolled_back']);
    expect(outcome.rounds[0].note).toMatch(/не убрались \(было 77, стало 77\)/);
    expect(outcome.best.html).toBe(live);
    expect(outcome.stopped).toBe('rounds');
  });

  it('ARCKEP_LAYOUT_TECHNIQUES=0 — приёмы не проверяются, версия принимается по похожести', async () => {
    process.env.ARCKEP_LAYOUT_TECHNIQUES = '0';
    const { deps: d } = loopDeps(['[{"find": "v0", "replace": "v1"}]']);
    const outcome = await runLayoutCheck(input({ html: ABS }), d);
    expect(outcome.initial.techniques).toEqual([]);
    expect(outcome.rounds[0].status).toBe('accepted');
    expect(outcome.best.html).toBe('<p style="position:absolute;left:20px">v1</p>');
  });
});
