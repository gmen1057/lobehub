import type {
  Comparison,
  ImageIssue,
  Issue,
  LineIssue,
  Mockup,
  OtherIssue,
  Rect,
  RenderImage,
  RenderResult,
} from './types';

/**
 * arckep (19.10.2026): сверка отрисованного письма с описанием макета — порт `compare.py` пробы 19.10 (проверен на
 * настоящем письме: r1 — 13 сдвигов по x в двух рамках и app-phone, r2 — +27/+28 по высоте ниже одной строки).
 *
 * Что меряется:
 * - строки — по началу текста (бэкенд находит начало строки в письме и отдаёт место первых знаков);
 * - высота — не по медиане, а по самому частому сдвигу (±3 px): «верх строки» в PDF и в браузере отличается на
 *   постоянную величину у одного шрифта, а настоящие сдвиги — это отклонения от неё;
 * - у строк «по центру» левый край не сравнивается (ширина строки в письме другая — край уезжает сам);
 * - размер шрифта: разница от 1 px;
 * - картинки — по адресу вырезки; чужие адреса (человек дал свои) — по месту и размеру; допуск ±6 px;
 * - ширина документа: шире окна — «выходит за ширину».
 * Схожесть по картинке — отдельно (pictures.ts), здесь только числа.
 */

/** Допуск положения и размера, px. */
export const POSITION_TOLERANCE = 6;
/** Окно, в которое попадают «одинаковые» сдвиги по высоте, px. */
const SHIFT_WINDOW = 3;
/** Пределы поиска общего сдвига, px. */
const SHIFT_RANGE = 30;
/** Картинка без своего адреса считается стоящей на месте вырезки, если пересечение не меньше этой доли. */
const MIN_OVERLAP = 0.3;

/** Номер файла чата из адреса (абсолютного или относительного); любой другой адрес — как есть. */
export const addressKey = (src: string | null | undefined): string => {
  const text = (src ?? '').trim();
  const id = /\/chat\/f\/([\w-]+)/.exec(text)?.[1];
  return id ? `chat:${id}` : text;
};

const round = (value: number) => Math.round(value);
const signed = (value: number) => `${value > 0 ? '+' : ''}${round(value)}`;

/**
 * Самый частый сдвиг: находим кандидата в диапазоне ±30 с наибольшим числом сдвигов в окне ±3 px (при равенстве —
 * меньший), а итог — среднее сдвигов этого окна. Так допуск ±6 px вокруг общего сдвига симметричен: начало
 * «полки» кандидатов (как в пробе 19.10) смещало бы допуск в одну сторону.
 */
export const commonShift = (shifts: number[]): number => {
  if (shifts.length === 0) return 0;
  let best = 0;
  let bestCount = -1;
  for (let candidate = -SHIFT_RANGE; candidate <= SHIFT_RANGE; candidate++) {
    const count = shifts.filter((shift) => Math.abs(shift - candidate) <= SHIFT_WINDOW).length;
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  if (bestCount <= 0) return best;
  const cluster = shifts.filter((shift) => Math.abs(shift - best) <= SHIFT_WINDOW);
  return cluster.reduce((sum, shift) => sum + shift, 0) / cluster.length;
};

const area = (rect: Rect) => Math.max(0, rect.w) * Math.max(0, rect.h);

const overlap = (a: Rect, b: Rect) => {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  return inter / (area(a) + area(b) - inter);
};

const rectOf = (image: RenderImage): Rect => ({ h: image.h, w: image.w, x: image.x, y: image.y });

const lineIssues = (mockup: Mockup, render: RenderResult, dy0: number): LineIssue[] => {
  const issues: LineIssue[] = [];
  mockup.lines.forEach((line, index) => {
    const found = render.lines[index];
    const mock = { size: line.size, text: line.text, w: line.w, x: line.x, y: line.y };
    if (!found?.found || found.x == null || found.y == null) {
      issues.push({ index, key: `line:${index}`, kind: 'line', missing: true, mock });
      return;
    }
    const fontSize = found.font_size ?? line.size;
    const dy = found.y - line.y - dy0;
    const dx = found.x - line.x;
    const issue: LineIssue = {
      index,
      key: `line:${index}`,
      kind: 'line',
      mock,
      render: { h: found.h ?? 0, size: fontSize, x: found.x, y: found.y },
    };
    let bad = false;
    if (Math.abs(dy) > POSITION_TOLERANCE) {
      issue.dy = dy;
      bad = true;
    }
    if (Math.abs(dx) > POSITION_TOLERANCE && !line.center) {
      issue.dx = dx;
      bad = true;
    }
    if (Math.abs(fontSize - line.size) >= 1) {
      issue.size = fontSize;
      bad = true;
    }
    if (bad) issues.push(issue);
  });
  return issues;
};

const imageIssues = (mockup: Mockup, render: RenderResult): ImageIssue[] => {
  const issues: ImageIssue[] = [];
  const cropKeys = new Set(mockup.crops.map((crop) => addressKey(crop.url)));
  // чужие адреса (человек дал свои): ищутся по месту; каждая картинка занята один раз
  const free = render.images.filter((image) => !cropKeys.has(addressKey(image.src)));
  const taken = new Set<RenderImage>();

  mockup.crops.forEach((crop, index) => {
    const key = `image:${index}`;
    const own = render.images.filter((image) => addressKey(image.src) === addressKey(crop.url));
    let best: RenderImage | undefined;
    if (own.length > 0) {
      best = own.reduce((a, b) =>
        Math.abs(a.y - crop.y) + Math.abs(a.x - crop.x) <=
        Math.abs(b.y - crop.y) + Math.abs(b.x - crop.x)
          ? a
          : b,
      );
    } else {
      let bestOverlap = MIN_OVERLAP;
      for (const image of free) {
        if (taken.has(image)) continue;
        const value = overlap(rectOf(image), crop);
        if (value >= bestOverlap) {
          best = image;
          bestOverlap = value;
        }
      }
      if (best) taken.add(best);
    }

    const mock: Rect = { h: crop.h, w: crop.w, x: crop.x, y: crop.y };
    if (!best) {
      issues.push({ index, key, kind: 'image', label: crop.label, missing: true, mock });
      return;
    }
    const diff = Math.max(
      Math.abs(best.x - crop.x),
      Math.abs(best.y - crop.y),
      Math.abs(best.w - crop.w),
      Math.abs(best.h - crop.h),
    );
    if (diff > POSITION_TOLERANCE) {
      issues.push({ index, key, kind: 'image', label: crop.label, mock, render: rectOf(best) });
    }
  });
  return issues;
};

const otherIssues = (render: RenderResult): OtherIssue[] => {
  const issues: OtherIssue[] = [];
  if (render.scroll_width > render.width) {
    issues.push({
      key: 'overflow',
      kind: 'overflow',
      text: `письмо выходит за ширину: ${render.scroll_width} px вместо ${render.width} px (горизонтальная прокрутка)`,
    });
  }
  const seen = new Set<string>();
  const add = (src: string, reason: string, y?: number) => {
    const key = `broken:${addressKey(src)}`;
    if (seen.has(key)) return;
    seen.add(key);
    issues.push({
      key,
      kind: 'broken',
      text: `картинка не загрузилась (${reason}): ${src.slice(0, 80)}`,
      y,
    });
  };
  for (const image of render.images) {
    if (!image.loaded) add(image.src ?? '(без адреса)', image.error ?? 'не открылась', image.y);
  }
  for (const failed of render.failed_images) add(failed.url, failed.reason);
  return issues;
};

/** Сравнение отрисованного письма с макетом: список расхождений в порядке «сверху вниз». */
export const compareLayout = (mockup: Mockup, render: RenderResult): Comparison => {
  const found = mockup.lines.flatMap((_, index) => {
    const line = render.lines[index];
    return line?.found && line.y != null ? [line.y - mockup.lines[index].y] : [];
  });
  const dy0 = commonShift(found);
  const issues: Issue[] = [
    ...lineIssues(mockup, render, dy0),
    ...imageIssues(mockup, render),
    ...otherIssues(render),
  ];
  return {
    dy0,
    issues: issues.sort((a, b) => (issueY(a) ?? Infinity) - (issueY(b) ?? Infinity)),
    linesFound: found.length,
    linesTotal: mockup.lines.length,
    overflow: render.scroll_width > render.width,
    renderHeight: render.height,
  };
};

/** Верх места на странице, пт (по макету); у общих проблем может не быть. */
export const issueY = (issue: Issue): number | undefined =>
  issue.kind === 'line' || issue.kind === 'image' ? issue.mock.y : issue.y;

/** Насколько велико расхождение (px): по нему сравнивают версии; пропавшее и «не загрузилось» — очень велико. */
export const issueSeverity = (issue: Issue): number => {
  if (issue.kind === 'line') {
    if (issue.missing) return 1000;
    return Math.max(
      Math.abs(issue.dy ?? 0),
      Math.abs(issue.dx ?? 0),
      issue.size === undefined ? 0 : Math.abs(issue.size - issue.mock.size) * 4,
    );
  }
  if (issue.kind === 'image') {
    if (issue.missing || !issue.render) return 1000;
    return Math.max(
      Math.abs(issue.render.x - issue.mock.x),
      Math.abs(issue.render.y - issue.mock.y),
      Math.abs(issue.render.w - issue.mock.w),
      Math.abs(issue.render.h - issue.mock.h),
    );
  }
  return 1000;
};

const cut = (text: string, limit = 40) => {
  const chars = [...text.replaceAll(/\s+/g, ' ').trim()];
  return chars.length > limit ? `${chars.slice(0, limit).join('')}…` : chars.join('');
};

const rectText = (rect: Rect) =>
  `x${round(rect.x)} y${round(rect.y)} ${round(rect.w)}×${round(rect.h)}`;

/** Расхождение одной строкой для правщика и для ответа модели. */
export const issueText = (issue: Issue): string => {
  if (issue.kind === 'line') {
    const where = `макет y${round(issue.mock.y)} x${round(issue.mock.x)}`;
    if (issue.missing) return `«${cut(issue.mock.text)}» (${where}): строки нет в письме`;
    const bad: string[] = [];
    if (issue.dy !== undefined) bad.push(`по высоте ${signed(issue.dy)}`);
    if (issue.dx !== undefined) bad.push(`по горизонтали ${signed(issue.dx)}`);
    if (issue.size !== undefined) {
      bad.push(`размер ${round(issue.size)} вместо ${issue.mock.size}`);
    }
    return `«${cut(issue.mock.text)}» (${where}): ${bad.join(', ')}`;
  }
  if (issue.kind === 'image') {
    if (!issue.render)
      return `${issue.label}: макет ${rectText(issue.mock)}, в письме её нет на этом месте`;
    return `${issue.label}: макет ${rectText(issue.mock)}, в письме ${rectText(issue.render)}`;
  }
  return issue.text;
};

/** Что стало хуже между двумя замерами. */
export interface Regression {
  /** Расхождения, которые стали заметно больше (ключ → было → стало, px) */
  grown: Array<{ after: number; before: number; key: string }>;
  /** Места, которые были на своих, а теперь с расхождением */
  newKeys: string[];
}

/** Рост расхождения, который ещё не считается ухудшением, px. */
const GROWTH_TOLERANCE = 6;

/**
 * Защита от «исправил названное, сломал соседнее» (проба 19.10: +28 px ниже одной строки): ухудшением считается
 * и новое расхождение там, где было на месте, и рост уже бывшего больше чем на 6 px.
 */
export const regression = (before: Comparison, after: Comparison): Regression => {
  const was = new Map(before.issues.map((issue) => [issue.key, issueSeverity(issue)]));
  const newKeys: string[] = [];
  const grown: Regression['grown'] = [];
  for (const issue of after.issues) {
    const old = was.get(issue.key);
    const now = issueSeverity(issue);
    if (old === undefined) newKeys.push(issue.key);
    else if (now > old + GROWTH_TOLERANCE) grown.push({ after: now, before: old, key: issue.key });
  }
  return { grown, newKeys };
};
