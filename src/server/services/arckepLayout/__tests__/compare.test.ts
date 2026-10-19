import { describe, expect, it } from 'vitest';

import {
  addressKey,
  commonShift,
  compareLayout,
  issueSeverity,
  issueText,
  issueY,
  regression,
} from '../compare';
import type { ImageIssue, LineIssue, Mockup, RenderResult } from '../types';
import mockupJson from './fixtures/mockup.json';
import r1Json from './fixtures/render-r1.json';
import r2Json from './fixtures/render-r2.json';

// arckep (19.10.2026): проверка порта compare.py на настоящем письме пробы 19.10 (клиника, 111 строк, 20 вырезок):
// r1 — первое письмо модели (13 сдвигов по x в двух рамках и app-phone), r2 — после круга «сверить и поправить»
// (исправило названное, но сломало соседнее: +27/+28 по высоте ниже одной строки).

const mockup: Mockup = {
  blocks: [],
  crops: mockupJson.crops.map(({ name: _name, ...crop }) => crop) as Mockup['crops'],
  height: mockupJson.height,
  lines: mockupJson.lines as Mockup['lines'],
  width: mockupJson.width,
};
const render = (data: unknown): RenderResult => ({
  screenshot_jpeg_base64: '',
  ...(data as Omit<RenderResult, 'screenshot_jpeg_base64'>),
});
const r1 = render(r1Json);
const r2 = render(r2Json);

const lineIssues = (list: ReturnType<typeof compareLayout>['issues']) =>
  list.filter((issue): issue is LineIssue => issue.kind === 'line');
const imageIssues = (list: ReturnType<typeof compareLayout>['issues']) =>
  list.filter((issue): issue is ImageIssue => issue.kind === 'image');

describe('сравнение письма с макетом на данных пробы 19.10', () => {
  it('r1: 13 сдвигов по x (две рамки), все строки найдены, общий сдвиг по высоте около 4,3 px', () => {
    const result = compareLayout(mockup, r1);
    expect(result.dy0).toBeCloseTo(4.3, 0);
    expect(result.linesFound).toBe(111);
    expect(result.linesTotal).toBe(111);

    const lines = lineIssues(result.issues);
    expect(lines).toHaveLength(13);
    // только горизонталь: по высоте и по размеру шрифта всё на месте
    expect(
      lines.every(
        (issue) => issue.dx !== undefined && issue.dy === undefined && issue.size === undefined,
      ),
    ).toBe(true);
    // две рамки: x155 (+22, шесть строк) и x160/x296 (+11/+15, семь строк)
    expect(lines.filter((issue) => Math.round(issue.dx!) === 22)).toHaveLength(6);
    expect(lines.filter((issue) => [11, 15].includes(Math.round(issue.dx!)))).toHaveLength(7);
  });

  it('r1: из картинок не на месте только app-phone (сдвиг на 11 px по x и 9 px по y)', () => {
    const images = imageIssues(compareLayout(mockup, r1).issues);
    expect(images).toHaveLength(1);
    expect(Math.round(images[0].mock.h)).toBe(238);
    expect(Math.round(images[0].mock.w)).toBe(163);
    expect(Math.round(images[0].mock.x)).toBe(368);
    expect(Math.round(images[0].mock.y)).toBe(4818);
    expect(Math.round(images[0].render!.x)).toBe(379);
    expect(Math.round(images[0].render!.y)).toBe(4827);
  });

  it('r2: 55 строк со сдвигом, общий сдвиг около 0,6 px, все сдвиги по высоте начинаются со строки y2669', () => {
    const result = compareLayout(mockup, r2);
    expect(result.dy0).toBeCloseTo(0.6, 0);
    const lines = lineIssues(result.issues);
    expect(lines).toHaveLength(55);

    const shifted = lines.filter((issue) => issue.dy !== undefined);
    expect(shifted.length).toBeGreaterThanOrEqual(45);
    // сдвиги +23…+28 (от общего сдвига письма) начинаются в строке y2669 и идут до конца письма
    expect(Math.min(...shifted.map((issue) => issue.mock.y))).toBe(2669);
    for (const issue of shifted) expect(Math.round(issue.dy!)).toBeGreaterThanOrEqual(23);
    for (const issue of shifted) expect(Math.round(issue.dy!)).toBeLessThanOrEqual(28);
    // выше строки y2669 (соседняя строка y2671 — другой столбец) высота не сдвинута нигде
    expect(shifted.filter((issue) => issue.mock.y < 2669)).toHaveLength(0);
  });

  it('r2: 11 картинок не на месте — все ниже, на ту же величину по y', () => {
    const images = imageIssues(compareLayout(mockup, r2).issues);
    expect(images).toHaveLength(11);
    for (const issue of images) {
      expect(issue.render).toBeDefined();
      const dy = issue.render!.y - issue.mock.y;
      expect(dy).toBeGreaterThanOrEqual(24);
      expect(dy).toBeLessThanOrEqual(26);
    }
  });

  it('расхождения идут сверху вниз и читаются одной строкой', () => {
    const issues = compareLayout(mockup, r1).issues;
    const ys = issues.map((issue) => issueY(issue) ?? Infinity);
    expect(ys).toEqual([...ys].sort((a, b) => a - b));
    expect(issueText(issues[0])).toMatch(/^«.+» \(макет y\d+ x\d+\): по горизонтали \+\d+$/);
    const phone = issues.find((issue) => issue.kind === 'image')!;
    expect(issueText(phone)).toMatch(
      /^(?:фото|значок) \d+: макет x368 y4818 163×238, в письме x379 y4827 163×238$/,
    );
  });
});

describe('правила сравнения', () => {
  const base: Mockup = {
    blocks: [],
    crops: [],
    height: 1000,
    lines: [
      { size: 20, text: 'Первая', w: 100, x: 20, y: 40 },
      { center: true, size: 20, text: 'По центру', w: 120, x: 240, y: 100 },
      { size: 16, text: 'Третья', w: 80, x: 20, y: 160 },
    ],
    width: 600,
  };
  const make = (lines: RenderResult['lines'], extra: Partial<RenderResult> = {}): RenderResult => ({
    failed_images: [],
    height: 1000,
    images: [],
    lines,
    scroll_width: 600,
    screenshot_jpeg_base64: '',
    width: 600,
    ...extra,
  });
  const at = (text: string, x: number, y: number, size = 20) => ({
    found: true,
    font_size: size,
    font_weight: '400',
    h: 24,
    text,
    x,
    y,
  });

  it('всё на месте при постоянном сдвиге «верх строки» — расхождений нет', () => {
    const result = compareLayout(
      base,
      make([at('Первая', 20, 43), at('По центру', 240, 103), at('Третья', 20, 163, 16)]),
    );
    expect(result.issues).toEqual([]);
    expect(result.dy0).toBeCloseTo(3, 5);
  });

  it('у строки «по центру» левый край не сравнивается, у остальных — сравнивается', () => {
    const result = compareLayout(
      base,
      make([at('Первая', 40, 43), at('По центру', 300, 103), at('Третья', 20, 163, 16)]),
    );
    const lines = lineIssues(result.issues);
    expect(lines.map((issue) => issue.mock.text)).toEqual(['Первая']);
    expect(lines[0].dx).toBe(20);
  });

  it('размер шрифта: разница от 1 px — расхождение', () => {
    const result = compareLayout(
      base,
      make([at('Первая', 20, 43, 19), at('По центру', 240, 103, 20.4), at('Третья', 20, 163, 16)]),
    );
    const lines = lineIssues(result.issues);
    expect(lines).toHaveLength(1);
    expect(lines[0].size).toBe(19);
    expect(issueText(lines[0])).toContain('размер 19 вместо 20');
  });

  it('строки нет в письме — расхождение «строки нет»', () => {
    const result = compareLayout(
      base,
      make([at('Первая', 20, 43), { found: false, text: 'По центру' }, at('Третья', 20, 163, 16)]),
    );
    const lines = lineIssues(result.issues);
    expect(lines).toHaveLength(1);
    expect(lines[0].missing).toBe(true);
    expect(issueText(lines[0])).toContain('строки нет в письме');
    expect(result.linesFound).toBe(2);
  });

  it('ширина документа больше окна — «выходит за ширину»', () => {
    const result = compareLayout(
      base,
      make([at('Первая', 20, 43), at('По центру', 240, 103), at('Третья', 20, 163, 16)], {
        scroll_width: 640,
      }),
    );
    expect(result.overflow).toBe(true);
    expect(result.issues.map((issue) => issue.kind)).toEqual(['overflow']);
    expect(issueText(result.issues[0])).toContain('выходит за ширину: 640 px вместо 600 px');
  });

  it('самый частый сдвиг, а не медиана: меньшинство сдвинутых строк остаётся расхождением', () => {
    // 5 строк на +3 и 4 строки на +30: общий сдвиг — большая группа, а не середина между ними
    expect(commonShift([3, 3, 3, 3, 3, 30, 30, 30, 30])).toBeCloseTo(3, 5);
    // итог — среднее сдвигов в окне ±3 вокруг самого частого
    expect(commonShift([2, 3, 4, 3, 2, 30, 30])).toBeCloseTo(2.8, 5);
    expect(commonShift([])).toBe(0);
    // при равенстве групп — та, где кандидат меньше
    expect(commonShift([-20, -20, 10, 10])).toBeCloseTo(-20, 5);
  });
});

describe('картинки', () => {
  const crop = (x: number, y: number, w: number, h: number, id = 'file_AAA') => ({
    h,
    kind: 'photo' as const,
    label: 'фото 1',
    url: `https://arckep.ru/chat/f/${id}/`,
    w,
    x,
    y,
  });
  const mockup: Mockup = {
    blocks: [],
    crops: [crop(0, 100, 600, 300)],
    height: 800,
    lines: [],
    width: 600,
  };
  const page = (
    images: RenderResult['images'],
    extra: Partial<RenderResult> = {},
  ): RenderResult => ({
    failed_images: [],
    height: 800,
    images,
    lines: [],
    scroll_width: 600,
    screenshot_jpeg_base64: '',
    width: 600,
    ...extra,
  });
  const image = (src: string, x: number, y: number, w: number, h: number, loaded = true) => ({
    h,
    loaded,
    origin: 'ours' as const,
    src,
    w,
    x,
    y,
  });

  it('адрес с хостом и без хоста — одна и та же картинка', () => {
    expect(addressKey('https://arckep.ru/chat/f/file_AAA/')).toBe('chat:file_AAA');
    expect(addressKey('/chat/f/file_AAA')).toBe('chat:file_AAA');
    expect(addressKey('https://example.com/a.png')).toBe('https://example.com/a.png');
    const result = compareLayout(mockup, page([image('/chat/f/file_AAA/', 3, 104, 600, 300)]));
    expect(result.issues).toEqual([]);
  });

  it('допуск ±6 px: 6 — на месте, 7 — расхождение; высота и ширина тоже', () => {
    expect(
      compareLayout(mockup, page([image('/chat/f/file_AAA/', 0, 106, 600, 300)])).issues,
    ).toEqual([]);
    expect(
      compareLayout(mockup, page([image('/chat/f/file_AAA/', 0, 107, 600, 300)])).issues,
    ).toHaveLength(1);
    expect(
      compareLayout(mockup, page([image('/chat/f/file_AAA/', 0, 100, 600, 307)])).issues,
    ).toHaveLength(1);
  });

  it('вырезки нет в письме, чужих картинок на её месте тоже — расхождение «её нет на этом месте»', () => {
    const result = compareLayout(mockup, page([]));
    const [issue] = imageIssues(result.issues);
    expect(issue.missing).toBe(true);
    expect(issueText(issue)).toContain('в письме её нет на этом месте');
  });

  it('человек дал свои адреса: картинка с чужим адресом на месте вырезки сверяется по месту и размеру', () => {
    const own = page([image('https://shop.example/hero.jpg', 0, 100, 600, 300)]);
    expect(compareLayout(mockup, own).issues).toEqual([]);

    const shifted = page([image('https://shop.example/hero.jpg', 0, 130, 600, 300)]);
    const [issue] = imageIssues(compareLayout(mockup, shifted).issues);
    expect(issue.render).toMatchObject({ x: 0, y: 130 });
  });

  it('одна чужая картинка закрывает только одну вырезку', () => {
    const two: Mockup = {
      ...mockup,
      crops: [crop(0, 100, 300, 300, 'file_A'), crop(0, 100, 300, 300, 'file_B')],
    };
    const result = compareLayout(
      two,
      page([image('https://shop.example/a.jpg', 0, 100, 300, 300)]),
    );
    expect(imageIssues(result.issues)).toHaveLength(1);
  });

  it('картинка не загрузилась и адреса, которые не удалось подставить, — расхождения', () => {
    const result = compareLayout(
      mockup,
      page([image('/chat/f/file_AAA/', 0, 100, 600, 300, false)], {
        failed_images: [
          { origin: 'external', reason: 'not_https', url: 'http://shop.example/a.png' },
        ],
      }),
    );
    const broken = result.issues.filter((issue) => issue.kind === 'broken');
    expect(broken).toHaveLength(2);
    expect(broken[0].kind === 'broken' && broken[0].text).toContain('картинка не загрузилась');
    expect(
      broken.some((issue) => issue.kind === 'broken' && issue.text.includes('not_https')),
    ).toBe(true);
  });
});

describe('ухудшение между версиями', () => {
  const lineIssue = (index: number, dy: number): LineIssue => ({
    dy,
    index,
    key: `line:${index}`,
    kind: 'line',
    mock: { size: 20, text: `строка ${index}`, w: 100, x: 20, y: index * 30 },
  });
  const comparison = (issues: LineIssue[]) => ({
    dy0: 0,
    issues,
    linesFound: 10,
    linesTotal: 10,
    overflow: false,
    renderHeight: 1000,
  });

  it('новое расхождение там, где было на месте, — ухудшение', () => {
    const result = regression(
      comparison([lineIssue(1, 10)]),
      comparison([lineIssue(1, 10), lineIssue(2, 28)]),
    );
    expect(result.newKeys).toEqual(['line:2']);
    expect(result.grown).toEqual([]);
  });

  it('прежнее расхождение выросло больше чем на 6 px — ухудшение, на 6 — нет', () => {
    expect(
      regression(comparison([lineIssue(1, 10)]), comparison([lineIssue(1, 17)])).grown,
    ).toHaveLength(1);
    expect(
      regression(comparison([lineIssue(1, 10)]), comparison([lineIssue(1, 16)])).grown,
    ).toEqual([]);
  });

  it('исправленные и неизменные расхождения не мешают', () => {
    const result = regression(
      comparison([lineIssue(1, 10), lineIssue(2, 12)]),
      comparison([lineIssue(2, 12)]),
    );
    expect(result).toEqual({ grown: [], newKeys: [] });
  });

  it('тяжесть: пропавшее — очень велика, остальное — наибольшее смещение', () => {
    expect(issueSeverity({ ...lineIssue(1, 10), missing: true })).toBe(1000);
    expect(issueSeverity({ ...lineIssue(1, -12), dx: 5 })).toBe(12);
  });
});
