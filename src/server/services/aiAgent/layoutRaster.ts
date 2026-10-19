/**
 * arckep (19.10.2026): пиксельная часть описания макета PDF (pdfLayout.ts). Только чистые функции над сырыми
 * пикселями (RGB, 3 байта на точку): страница уже нарисована poppler-ом (pdfPages.ts), здесь ищем на ней
 * заливки, рамки, линии, радиусы скруглений, цвет текста, видимую часть вшитых картинок и векторные значки.
 *
 * Единицы: «пт» — точки страницы (как у pdftohtml при zoom 1), «px» — точки нарисованной картинки. Масштаб
 * (sx, sy) = px на пт. Большая часть работы идёт на «сетке 1 пт» (по одной выборке на точку страницы): так порог
 * «площадь ≥ 400 пт²» не зависит от размера картинки, а память — от длины страницы.
 */

export interface RawImage {
  /** RGB, по 3 байта на точку, строка за строкой */
  data: Uint8Array;
  height: number;
  width: number;
}

export interface Rect {
  h: number;
  w: number;
  x: number;
  y: number;
}

export type Rgb = [number, number, number];

/** Сетка 1 пт: одна выборка цвета на точку страницы. */
export interface PtGrid {
  height: number;
  rgb: Uint8Array;
  /** px на пт по горизонтали и вертикали */
  sx: number;
  sy: number;
  width: number;
}

/** Самая большая страница, которую разбираем (точек сетки): дальше память не оправдана. */
export const MAX_GRID_CELLS = 14_000_000;

const hex2 = (value: number) => value.toString(16).padStart(2, '0').toUpperCase();
export const toHex = ([r, g, b]: Rgb) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;
export const fromHex = (value: string): Rgb => [
  Number.parseInt(value.slice(1, 3), 16),
  Number.parseInt(value.slice(3, 5), 16),
  Number.parseInt(value.slice(5, 7), 16),
];
export const colorDistance = (a: ArrayLike<number>, b: ArrayLike<number>) =>
  Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);

const pixelAt = (img: RawImage, x: number, y: number): Rgb => {
  const i = (y * img.width + x) * 3;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
};

/** Цвет точки близок к образцу: каждый канал отличается не больше чем на `tol`. */
const near = (img: RawImage, x: number, y: number, color: Rgb, tol: number) => {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return false;
  const i = (y * img.width + x) * 3;
  return (
    Math.abs(img.data[i] - color[0]) <= tol &&
    Math.abs(img.data[i + 1] - color[1]) <= tol &&
    Math.abs(img.data[i + 2] - color[2]) <= tol
  );
};

// ---- Сетка и фон ----

/** Нарисованную страницу → сетка 1 пт (выборка в центре каждой точки). */
export const makeGrid = (img: RawImage, ptWidth: number, ptHeight: number): PtGrid | undefined => {
  const width = Math.max(1, Math.round(ptWidth));
  const height = Math.max(1, Math.round(ptHeight));
  if (width * height > MAX_GRID_CELLS || img.width < 1 || img.height < 1) return undefined;

  const sx = img.width / ptWidth;
  const sy = img.height / ptHeight;
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    const py = Math.min(img.height - 1, Math.floor((y + 0.5) * sy));
    for (let x = 0; x < width; x++) {
      const px = Math.min(img.width - 1, Math.floor((x + 0.5) * sx));
      const from = (py * img.width + px) * 3;
      const to = (y * width + x) * 3;
      rgb[to] = img.data[from];
      rgb[to + 1] = img.data[from + 1];
      rgb[to + 2] = img.data[from + 2];
    }
  }
  return { height, rgb, sx, sy, width };
};

const key = (r: number, g: number, b: number) => (r << 16) | (g << 8) | b;
const fromKey = (value: number): Rgb => [(value >> 16) & 255, (value >> 8) & 255, value & 255];

/** Фон страницы: самый частый цвет по кромке (2 пт со всех сторон) — поля обычно пустые. */
export const pageBackground = (grid: PtGrid): Rgb => {
  const counts = new Map<number, number>();
  const { rgb, width, height } = grid;
  const band = Math.max(1, Math.min(2, Math.floor(Math.min(width, height) / 2)));
  const add = (x: number, y: number) => {
    const i = (y * width + x) * 3;
    const k = key(rgb[i], rgb[i + 1], rgb[i + 2]);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  };
  for (let y = 0; y < height; y++) {
    const edge = y < band || y >= height - band;
    if (edge) for (let x = 0; x < width; x++) add(x, y);
    else {
      for (let x = 0; x < band; x++) add(x, y);
      for (let x = width - band; x < width; x++) add(x, y);
    }
  }
  let best = 0;
  let bestCount = -1;
  for (const [k, count] of counts) {
    if (count > bestCount) {
      best = k;
      bestCount = count;
    }
  }
  return fromKey(best);
};

// ---- Цвет текста ----

/**
 * Цвет текста строки: внутри рамки строки находим местный фон (самый частый цвет), затем самый частый цвет среди
 * точек, сильнее всего от него отличающихся (светлый текст на тёмном — тоже). Нет заметных отличий — `undefined`.
 */
export const textColor = (img: RawImage, sx: number, sy: number, rect: Rect): Rgb | undefined => {
  const x0 = Math.max(0, Math.floor(rect.x * sx));
  const y0 = Math.max(0, Math.floor(rect.y * sy));
  const x1 = Math.min(img.width, Math.ceil((rect.x + rect.w) * sx));
  const y1 = Math.min(img.height, Math.ceil((rect.y + rect.h) * sy));
  if (x1 <= x0 || y1 <= y0) return undefined;

  const counts = new Map<number, number>();
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * img.width + x) * 3;
      const k = key(img.data[i], img.data[i + 1], img.data[i + 2]);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  let bgKey = 0;
  let bgCount = -1;
  for (const [k, count] of counts) {
    if (count > bgCount) {
      bgKey = k;
      bgCount = count;
    }
  }
  const bg = fromKey(bgKey);
  let maxDistance = 0;
  for (const k of counts.keys()) maxDistance = Math.max(maxDistance, colorDistance(fromKey(k), bg));
  if (maxDistance < 60) return undefined;

  // самые отличающиеся от фона цвета — «сердцевина» букв, без сглаженной каймы
  const strong = new Map<number, number>();
  for (const [k, count] of counts) {
    if (colorDistance(fromKey(k), bg) >= maxDistance * 0.8) strong.set(k, count);
  }
  let best = bgKey;
  let bestCount = -1;
  for (const [k, count] of strong) {
    if (count > bestCount) {
      best = k;
      bestCount = count;
    }
  }
  return fromKey(best);
};

// ---- Области одного цвета ----

export interface Region {
  color: Rgb;
  id: number;
  n: number;
  /** Границы включительно, в точках сетки */
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

const REGION_TOLERANCE = 6;

export interface RegionMap {
  /** 0 — не посещено, -1 — мелкая область, иначе id области (с 1) */
  labels: Int32Array;
  regions: Region[];
}

/**
 * Связные области одного цвета (4 соседа, цвет близок к цвету первой точки области: каждый канал ±6). Областью
 * может начаться только «ровная» точка — равная соседям по обеим осям (или по двум сторонам одной оси: тонкая
 * линия): сглаженная кайма на краю скругления областью не начинается и не сдвигает её цвет. Области мельче
 * `minCells` точек не запоминаются (метка -1): буквы, остатки каймы. Асинхронная: между кусками цикла уступает
 * процессор (страница в миллионы точек считается долю секунды, но движок отвечает людям в том же процессе).
 */
export const findRegions = async (grid: PtGrid, minCells = 24): Promise<RegionMap> => {
  const { rgb, width: W, height: H } = grid;
  const total = W * H;
  const labels = new Int32Array(total);
  const queue = new Int32Array(total);
  const regions: Region[] = [];

  const same = (a: number, b: number) =>
    Math.abs(rgb[a * 3] - rgb[b * 3]) <= 2 &&
    Math.abs(rgb[a * 3 + 1] - rgb[b * 3 + 1]) <= 2 &&
    Math.abs(rgb[a * 3 + 2] - rgb[b * 3 + 2]) <= 2;
  const isFlatSeed = (index: number, x: number, y: number) => {
    const left = x > 0 && same(index, index - 1);
    const right = x < W - 1 && same(index, index + 1);
    const up = y > 0 && same(index, index - W);
    const down = y < H - 1 && same(index, index + W);
    return ((left || right) && (up || down)) || (left && right) || (up && down);
  };

  let lastYield = Date.now();
  for (let start = 0; start < total; start++) {
    // разбор страницы — длинный цикл в процессе движка: отдаём процессор остальным запросам
    if ((start & 0x3_ff_ff) === 0 && Date.now() - lastYield > 40) {
      await new Promise((resolve) => setImmediate(resolve));
      lastYield = Date.now();
    }
    if (labels[start] !== 0) continue;
    const startX = start % W;
    if (!isFlatSeed(start, startX, (start - startX) / W)) continue;
    const r0 = rgb[start * 3];
    const g0 = rgb[start * 3 + 1];
    const b0 = rgb[start * 3 + 2];
    const id = regions.length + 1;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    labels[start] = id;
    let x0 = W;
    let x1 = -1;
    let y0 = H;
    let y1 = -1;

    const visit = (index: number) => {
      if (labels[index] !== 0) return;
      const i = index * 3;
      if (
        Math.abs(rgb[i] - r0) <= REGION_TOLERANCE &&
        Math.abs(rgb[i + 1] - g0) <= REGION_TOLERANCE &&
        Math.abs(rgb[i + 2] - b0) <= REGION_TOLERANCE
      ) {
        labels[index] = id;
        queue[tail++] = index;
      }
    };

    while (head < tail) {
      const index = queue[head++];
      const x = index % W;
      const y = (index - x) / W;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (x > 0) visit(index - 1);
      if (x < W - 1) visit(index + 1);
      if (y > 0) visit(index - W);
      if (y < H - 1) visit(index + W);
    }

    if (tail < minCells) {
      for (let k = 0; k < tail; k++) labels[queue[k]] = -1;
    } else {
      regions.push({ color: [r0, g0, b0], id, n: tail, x0, x1, y0, y1 });
    }
  }
  return { labels, regions };
};

// ---- Блоки: заливки, рамки, линии ----

export interface RawBlock {
  color: Rgb;
  h: number;
  kind: 'fill' | 'frame' | 'line';
  /** Сколько точек сетки заняла область */
  n: number;
  /** Область (или две — у тонкой рамки из верхней и нижней линий), по которой найден блок */
  region: number;
  regions: number[];
  /** Толщина рамки, пт */
  thickness?: number;
  w: number;
  x: number;
  y: number;
}

export interface BlockOptions {
  /** Страница целиком — одна область фона, а не блок */
  background: Rgb;
  /** Прямоугольники видимых фото: области, лежащие внутри них, блоками не считаются */
  photos: Rect[];
  /** Рамки строк текста: тонкая линия у текста — подчёркивание ссылки, а не разделитель */
  texts?: Rect[];
}

const intersectArea = (a: Rect, b: Rect) => {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
};

const containsRect = (outer: Rect, inner: Rect, slack = 1) =>
  inner.x >= outer.x - slack &&
  inner.y >= outer.y - slack &&
  inner.x + inner.w <= outer.x + outer.w + slack &&
  inner.y + inner.h <= outer.y + outer.h + slack;

/**
 * Охват краёв: доля точек средней половины каждой из четырёх сторон рамки области, которые принадлежат этой
 * области. У настоящей рамки-контура (в том числе скруглённой) все четыре стороны почти сплошные.
 */
const edgeCoverage = (labels: Int32Array, W: number, region: Region) => {
  const w = region.x1 - region.x0 + 1;
  const h = region.y1 - region.y0 + 1;
  const share = (points: Array<[number, number]>) =>
    points.filter(([x, y]) => labels[y * W + x] === region.id).length / Math.max(1, points.length);
  const xs: number[] = [];
  for (let x = region.x0 + Math.floor(w / 4); x <= region.x0 + Math.ceil((w * 3) / 4); x++)
    xs.push(x);
  const ys: number[] = [];
  for (let y = region.y0 + Math.floor(h / 4); y <= region.y0 + Math.ceil((h * 3) / 4); y++)
    ys.push(y);
  return Math.min(
    share(xs.map((x) => [x, region.y0])),
    share(xs.map((x) => [x, region.y1])),
    share(ys.map((y) => [region.x0, y])),
    share(ys.map((y) => [region.x1, y])),
  );
};

export interface BlockResult {
  blocks: RawBlock[];
  /** Области, которые считаются «плоскими»: блоки, рамки, линии, внешний фон, внутренность рамок (id → true) */
  flat: Set<number>;
}

const THIN_MAX_HEIGHT = 3;
const THIN_MIN_WIDTH = 24;
const LINE_MIN_WIDTH = 100;

/** Самая частая «плоская» область в ряду точек у области (выше или ниже её на 1 пт), кроме самой области. */
const neighbourRegion = (
  labels: Int32Array,
  flat: Set<number>,
  W: number,
  H: number,
  region: Region,
  dy: number,
) => {
  const y = dy < 0 ? region.y0 + dy : region.y1 + dy;
  if (y < 0 || y >= H) return undefined;
  const counts = new Map<number, number>();
  for (let x = region.x0; x <= region.x1; x += 2) {
    const label = labels[y * W + x];
    if (label > 0 && label !== region.id && flat.has(label))
      counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  let best: number | undefined;
  let bestCount = 0;
  for (const [label, count] of counts) {
    if (count > bestCount) {
      best = label;
      bestCount = count;
    }
  }
  return best;
};

/**
 * Блоки страницы по областям одного цвета.
 * - заливка: площадь ≥ 400 пт², ширина ≥ 30, высота ≥ 20, не внешний фон; мелкие фигуры (< 80×80 и заполнены
 *   меньше чем на 85 % — значки) заливками не считаются;
 * - рамка-контур: тонкая область (занимает < 35 % своего прямоугольника) со сплошными четырьмя сторонами; тонкую
 *   рамку со скруглением (1 пт: кайма углов рвёт контур) собираем из пары одинаковых горизонтальных линий —
 *   сверху и снизу — и проверяем, что между ними слева и справа тот же цвет;
 * - линия: высота ≤ 3 при ширине ≥ 100; не считаются каймой (строка сглаживания между двумя разными плоскими
 *   областями — край заливки не по сетке) и подчёркиванием (линия у строки текста).
 * Фон, совпадающий с фоном страницы и замкнутый внутри заливки (белая кнопка на серой карточке), — тоже заливка;
 * внутри рамки-контура — нет (это просто внутренность рамки), но «плоской» областью он остаётся.
 */
export const findBlocks = (
  grid: PtGrid,
  regionMap: RegionMap,
  options: BlockOptions,
): BlockResult => {
  const { labels, regions } = regionMap;
  const W = grid.width;
  const H = grid.height;
  const flat = new Set<number>();
  const found: RawBlock[] = [];
  const thin: Region[] = [];
  const isBackground = (region: Region) => colorDistance(region.color, options.background) <= 12;
  const block = (
    region: Region,
    kind: RawBlock['kind'],
    extra: Partial<RawBlock> = {},
  ): RawBlock => ({
    color: region.color,
    h: region.y1 - region.y0 + 1,
    kind,
    n: region.n,
    region: region.id,
    regions: [region.id],
    w: region.x1 - region.x0 + 1,
    x: region.x0,
    y: region.y0,
    ...extra,
  });

  // 1. внешний фон страницы — плоский, до остального: от него зависит отсев каймы
  for (const region of regions) {
    const touchesEdge =
      region.x0 === 0 || region.y0 === 0 || region.x1 === W - 1 || region.y1 === H - 1;
    if (isBackground(region) && touchesEdge) flat.add(region.id);
  }

  for (const region of regions) {
    // фон, замкнутый внутри чего-то, разбирается ниже (кнопка на карточке или внутренность рамки)
    if (flat.has(region.id) || isBackground(region)) continue;
    const w = region.x1 - region.x0 + 1;
    const h = region.y1 - region.y0 + 1;
    const rect: Rect = { h, w, x: region.x0, y: region.y0 };
    // внутри видимого фото — это содержимое фото, а не блок
    if (options.photos.some((photo) => intersectArea(rect, photo) >= rect.w * rect.h * 0.5))
      continue;

    const ratio = region.n / (w * h);
    if (h <= THIN_MAX_HEIGHT && w >= THIN_MIN_WIDTH && ratio >= 0.4) {
      thin.push(region);
    } else if (w >= 30 && h >= 20 && ratio < 0.35) {
      if (edgeCoverage(labels, W, region) >= 0.8) {
        flat.add(region.id);
        found.push(
          block(region, 'frame', { thickness: Math.max(1, Math.round(region.n / (2 * (w + h)))) }),
        );
      }
    } else if (region.n >= 400 && w >= 30 && h >= 20) {
      if (w < 80 && h < 80 && ratio < 0.85) continue; // значок, а не заливка
      flat.add(region.id);
      found.push(block(region, 'fill'));
    }
  }

  // 2. тонкие линии: пары → рамки со скруглением; кайма и подчёркивания отсеиваются; остальное — линии
  const used = new Set<number>();
  const sorted = [...thin].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const colorAt = (x: number, y: number): Rgb => {
    const i = (y * W + x) * 3;
    return [grid.rgb[i], grid.rgb[i + 1], grid.rgb[i + 2]];
  };
  for (const top of sorted) {
    if (used.has(top.id)) continue;
    let bottom: Region | undefined;
    for (const other of sorted) {
      if (other === top || used.has(other.id) || other.y0 <= top.y1) continue;
      const gap = other.y0 - top.y1;
      if (gap < 12 || gap > 900) continue;
      if (colorDistance(top.color, other.color) > 20) continue;
      if (Math.abs(top.x0 - other.x0) > 3 || Math.abs(top.x1 - other.x1) > 3) continue;
      if (!bottom || other.y0 < bottom.y0) bottom = other;
    }
    if (!bottom) continue;

    // боковые стороны между линиями: тот же цвет слева и справа, в нескольких рядах
    const span = bottom.y0 - top.y1;
    const edge = (side: 'left' | 'right') => {
      const hits: number[] = [];
      for (const fraction of [0.35, 0.5, 0.65]) {
        const y = Math.round(top.y1 + span * fraction);
        const from = side === 'left' ? top.x0 - 16 : top.x1 + 16;
        const step = side === 'left' ? 1 : -1;
        if (from < 0 || from >= W) continue;
        // стенка рамки не по сетке сглажена: считаем её там, где точка ближе к цвету рамки, чем к фону снаружи
        const outside = colorAt(from, y);
        const contrast = colorDistance(top.color, outside);
        if (contrast < 20) continue;
        for (let k = 0; k <= 20; k++) {
          const x = from + step * k;
          if (x < 0 || x >= W) continue;
          if (colorDistance(colorAt(x, y), top.color) <= contrast * 0.65) {
            hits.push(x);
            break;
          }
        }
      }
      return hits.length >= 2 && Math.max(...hits) - Math.min(...hits) <= 2
        ? Math.round(median3(hits))
        : undefined;
    };
    const left = edge('left');
    const right = edge('right');
    if (left === undefined || right === undefined || right - left < 24) continue;

    used.add(top.id);
    used.add(bottom.id);
    flat.add(top.id);
    flat.add(bottom.id);
    const thickness = Math.max(top.y1 - top.y0 + 1, bottom.y1 - bottom.y0 + 1);
    found.push({
      color: top.color,
      h: bottom.y1 - top.y0 + 1,
      kind: 'frame',
      n: top.n + bottom.n,
      region: top.id,
      regions: [top.id, bottom.id],
      thickness,
      w: right - left + 1,
      x: left,
      y: top.y0,
    });
  }
  // 3. фон страницы внутри рамки — не блок (но «плоский»); внутри заливки — блок (кнопка)
  const rects = found.map((item) => ({ h: item.h, w: item.w, x: item.x, y: item.y }));
  const enclosed = regions.filter(
    (region) =>
      !flat.has(region.id) &&
      isBackground(region) &&
      region.n >= 400 &&
      region.x1 - region.x0 + 1 >= 30 &&
      region.y1 - region.y0 + 1 >= 20 &&
      !options.photos.some(
        (photo) =>
          intersectArea(
            {
              h: region.y1 - region.y0 + 1,
              w: region.x1 - region.x0 + 1,
              x: region.x0,
              y: region.y0,
            },
            photo,
          ) >=
          (region.x1 - region.x0 + 1) * (region.y1 - region.y0 + 1) * 0.5,
      ),
  );
  for (const region of enclosed) {
    const rect: Rect = {
      h: region.y1 - region.y0 + 1,
      w: region.x1 - region.x0 + 1,
      x: region.x0,
      y: region.y0,
    };
    let parent = -1;
    rects.forEach((other, index) => {
      if (!containsRect(other, rect, 2)) return;
      if (parent === -1 || other.w * other.h < rects[parent].w * rects[parent].h) parent = index;
    });
    if (parent === -1) continue; // замкнута чем-то нераспознанным
    flat.add(region.id);
    if (found[parent].kind === 'fill') found.push(block(region, 'fill'));
  }

  // 4. линии — после того, как все плоские области известны (по ним отсеивается кайма)
  for (const region of sorted) {
    if (used.has(region.id) || region.x1 - region.x0 + 1 < LINE_MIN_WIDTH) continue;
    const textRect = (options.texts ?? []).some(
      (text) =>
        intersectArea(
          {
            h: region.y1 - region.y0 + 1,
            w: region.x1 - region.x0 + 1,
            x: region.x0,
            y: region.y0,
          },
          { h: text.h + 2, w: text.w + 2, x: text.x - 1, y: text.y - 1 },
        ) > 0,
    );
    if (textRect) continue;
    const above = neighbourRegion(labels, flat, W, H, region, -1);
    const below = neighbourRegion(labels, flat, W, H, region, 1);
    if (above !== undefined && below !== undefined && above !== below) continue; // кайма края заливки
    flat.add(region.id);
    found.push(block(region, 'line'));
  }

  // цвет блока — самый частый цвет его областей, а не цвет первой точки
  for (const item of found) item.color = regionColor(grid, labels, regions, item);

  found.sort((a, b) => a.y - b.y || a.x - b.x);
  return { blocks: found, flat };
};

/** Самый частый цвет точек областей блока (выборка до ~4000 точек). */
const regionColor = (grid: PtGrid, labels: Int32Array, regions: Region[], block: RawBlock): Rgb => {
  const counts = new Map<number, number>();
  for (const id of block.regions) {
    const region = regions[id - 1];
    if (!region) continue;
    const stride = Math.max(1, Math.round(Math.sqrt(region.n / 4000)));
    for (let y = region.y0; y <= region.y1; y += stride) {
      for (let x = region.x0; x <= region.x1; x += stride) {
        if (labels[y * grid.width + x] !== id) continue;
        const i = (y * grid.width + x) * 3;
        const k = (grid.rgb[i] << 16) | (grid.rgb[i + 1] << 8) | grid.rgb[i + 2];
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
    }
  }
  let best = -1;
  let bestCount = 0;
  for (const [k, count] of counts) {
    if (count > bestCount) {
      best = k;
      bestCount = count;
    }
  }
  return best < 0 ? block.color : [(best >> 16) & 255, (best >> 8) & 255, best & 255];
};

const median3 = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

// ---- Радиусы скруглений ----

export type Radii = [number, number, number, number]; // ↖ ↗ ↘ ↙ в пт; -1 — угол закрыт чем-то другим

/**
 * Радиус по смещению начала заливки во втором ряду точек от края (круг радиуса r в точке на расстоянии 1,5 px от
 * края начинается на o = r − √(3r − 2,25) px от угла). Решение относительно r — в закрытом виде.
 */
export const radiusFromOffset = (offsetPx: number) => {
  if (offsetPx < 0.75) return 0;
  const t = (3 + Math.sqrt(12 * offsetPx)) / 2;
  return (t * t + 2.25) / 3;
};

export const cornerRadii = (
  img: RawImage,
  sx: number,
  sy: number,
  rect: Rect,
  color: Rgb,
): Radii => {
  const X0 = Math.floor(rect.x * sx);
  const Y0 = Math.floor(rect.y * sy);
  const X1 = Math.ceil((rect.x + rect.w) * sx) - 1;
  const Y1 = Math.ceil((rect.y + rect.h) * sy) - 1;
  const xm = (X0 + X1) >> 1;
  const ym = (Y0 + Y1) >> 1;
  const slack = Math.ceil(3 * Math.max(sx, sy));

  // допуск цвета — по контрасту с окружением: белая кнопка на светло-серой карточке (разница 9) иначе слилась бы с ней
  let contrast = 255;
  for (const [px, py] of [
    [xm, Y0 - slack - 1],
    [xm, Y1 + slack + 1],
    [X0 - slack - 1, ym],
    [X1 + slack + 1, ym],
  ]) {
    if (px < 0 || py < 0 || px >= img.width || py >= img.height) continue;
    const around = pixelAt(img, px, py);
    contrast = Math.min(
      contrast,
      Math.max(
        Math.abs(around[0] - color[0]),
        Math.abs(around[1] - color[1]),
        Math.abs(around[2] - color[2]),
      ),
    );
  }
  const tol = Math.max(2, Math.min(10, Math.floor(contrast / 2)));

  // настоящие края по середине сторон (область из сетки точна только до ±0,5 пт)
  const firstDown = (x: number, from: number, to: number) => {
    for (let y = from; y <= to; y++) if (near(img, x, y, color, tol)) return y;
    return undefined;
  };
  const firstUp = (x: number, from: number, to: number) => {
    for (let y = from; y >= to; y--) if (near(img, x, y, color, tol)) return y;
    return undefined;
  };
  const firstRight = (y: number, from: number, to: number) => {
    for (let x = from; x <= to; x++) if (near(img, x, y, color, tol)) return x;
    return undefined;
  };
  const firstLeft = (y: number, from: number, to: number) => {
    for (let x = from; x >= to; x--) if (near(img, x, y, color, tol)) return x;
    return undefined;
  };
  const top = firstDown(xm, Y0 - slack, Y0 + slack);
  const bottom = firstUp(xm, Y1 + slack, Y1 - slack);
  const left = firstRight(ym, X0 - slack, X0 + slack);
  const right = firstLeft(ym, X1 + slack, X1 - slack);

  const reach = Math.round(60 * Math.max(sx, sy));
  const limit = (a: number, b: number) => Math.min(Math.abs(b - a), reach);
  const corner = (
    edgeRow: number | undefined,
    edgeCol: number | undefined,
    rowStep: 1 | -1,
    colStep: 1 | -1,
  ): number => {
    if (edgeRow === undefined || edgeCol === undefined) return -1;
    const row = edgeRow + rowStep; // второй ряд точек от края
    const span = limit(edgeCol, colStep === 1 ? X1 : X0);
    for (let k = 0; k <= span; k++) {
      if (near(img, edgeCol + colStep * k, row, color, tol)) {
        // угол закрыт чем-то другим, если заливка начинается слишком далеко
        return k > span * 0.5 ? -1 : Math.round(radiusFromOffset(k) / Math.max(sx, sy));
      }
    }
    return -1;
  };

  return [
    corner(top, left, 1, 1),
    corner(top, right, 1, -1),
    corner(bottom, right, -1, -1),
    corner(bottom, left, -1, 1),
  ];
};

// ---- Видимая часть вшитой картинки ----

const MATCH_DISTANCE = 54;
const CELL = 3;

export interface VisibleResult {
  /** Доля совпавших точек среди тех, что лежат на странице */
  ratio: number;
  /** Видимая часть, пт; нет, если совпадений слишком мало */
  rect?: Rect;
  /**
   * Доля чёрных точек картинки среди не совпавших. pdftohtml отдаёт картинку без маски прозрачности, прозрачные
   * места в ней чёрные: много чёрного среди несовпавшего — картинка с маской (рука, рамка телефона, значок), и
   * по совпадению её видимую часть не найти.
   */
  transparent: number;
}

/**
 * Видимая часть картинки на странице. pdftohtml даёт место картинки целиком, а на странице её обрезает рамка
 * карточки (маска). Картинку, ужатую до места (`image`, размер = место в px), сравниваем попиксельно с
 * нарисованной страницей: рамка совпавших точек (сплошных кусков, не одиночных совпадений) — видимая часть.
 */
export const visibleRect = (
  page: RawImage,
  sx: number,
  sy: number,
  place: Rect,
  image: RawImage,
): VisibleResult => {
  const ox = Math.round(place.x * sx);
  const oy = Math.round(place.y * sy);
  const x0 = Math.max(0, -ox);
  const y0 = Math.max(0, -oy);
  const x1 = Math.min(image.width, page.width - ox);
  const y1 = Math.min(image.height, page.height - oy);
  if (x1 <= x0 || y1 <= y0) return { ratio: 0, transparent: 0 };

  const matched = new Uint8Array(image.width * image.height);
  let hits = 0;
  let black = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const a = (y * image.width + x) * 3;
      const b = ((y + oy) * page.width + (x + ox)) * 3;
      const d =
        Math.abs(image.data[a] - page.data[b]) +
        Math.abs(image.data[a + 1] - page.data[b + 1]) +
        Math.abs(image.data[a + 2] - page.data[b + 2]);
      if (d <= MATCH_DISTANCE) {
        matched[y * image.width + x] = 1;
        hits++;
      } else if (image.data[a] + image.data[a + 1] + image.data[a + 2] <= 45) {
        black++;
      }
    }
  }
  const total = (x1 - x0) * (y1 - y0);
  const ratio = hits / total;
  const transparent = total > hits ? black / (total - hits) : 0;
  if (ratio < 0.1) return { ratio, transparent };

  // ячейки CELL×CELL, совпавшие на 60 %+, и связные куски из них
  const cw = Math.ceil(image.width / CELL);
  const ch = Math.ceil(image.height / CELL);
  const cell = new Uint8Array(cw * ch);
  for (let cy = 0; cy < ch; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      let count = 0;
      let total = 0;
      for (let y = cy * CELL; y < Math.min(image.height, (cy + 1) * CELL); y++) {
        for (let x = cx * CELL; x < Math.min(image.width, (cx + 1) * CELL); x++) {
          if (x < x0 || x >= x1 || y < y0 || y >= y1) continue;
          total++;
          count += matched[y * image.width + x];
        }
      }
      if (total > 0 && count / total >= 0.6) cell[cy * cw + cx] = 1;
    }
  }

  const seen = new Uint8Array(cw * ch);
  const parts: Array<{ area: number; cx0: number; cx1: number; cy0: number; cy1: number }> = [];
  const stack: number[] = [];
  for (let start = 0; start < cell.length; start++) {
    if (!cell[start] || seen[start]) continue;
    let area = 0;
    let cx0 = cw;
    let cx1 = -1;
    let cy0 = ch;
    let cy1 = -1;
    stack.push(start);
    seen[start] = 1;
    while (stack.length > 0) {
      const index = stack.pop()!;
      const cx = index % cw;
      const cy = (index - cx) / cw;
      area++;
      cx0 = Math.min(cx0, cx);
      cx1 = Math.max(cx1, cx);
      cy0 = Math.min(cy0, cy);
      cy1 = Math.max(cy1, cy);
      for (const next of [
        cx > 0 ? index - 1 : -1,
        cx < cw - 1 ? index + 1 : -1,
        cy > 0 ? index - cw : -1,
        cy < ch - 1 ? index + cw : -1,
      ]) {
        if (next >= 0 && cell[next] && !seen[next]) {
          seen[next] = 1;
          stack.push(next);
        }
      }
    }
    parts.push({ area, cx0, cx1, cy0, cy1 });
  }
  if (parts.length === 0) return { ratio, transparent };

  const biggest = Math.max(...parts.map((part) => part.area));
  const keep = parts.filter((part) => part.area >= biggest * 0.25);
  let left = Math.min(...keep.map((part) => part.cx0)) * CELL;
  let top = Math.min(...keep.map((part) => part.cy0)) * CELL;
  let right = Math.min(image.width, (Math.max(...keep.map((part) => part.cx1)) + 1) * CELL);
  let bottom = Math.min(image.height, (Math.max(...keep.map((part) => part.cy1)) + 1) * CELL);

  // край уточняем до точки: строка/столбец на границе должны совпадать хотя бы наполовину
  const rowShare = (y: number) => {
    let count = 0;
    for (let x = left; x < right; x++) count += matched[y * image.width + x];
    return count / Math.max(1, right - left);
  };
  const colShare = (x: number) => {
    let count = 0;
    for (let y = top; y < bottom; y++) count += matched[y * image.width + x];
    return count / Math.max(1, bottom - top);
  };
  while (top < bottom - 1 && rowShare(top) < 0.5) top++;
  while (bottom > top + 1 && rowShare(bottom - 1) < 0.5) bottom--;
  while (left < right - 1 && colShare(left) < 0.5) left++;
  while (right > left + 1 && colShare(right - 1) < 0.5) right--;

  return {
    ratio,
    rect: {
      h: (bottom - top) / sy,
      w: (right - left) / sx,
      x: (ox + left) / sx,
      y: (oy + top) / sy,
    },
    transparent,
  };
};

// ---- Чернила: векторные значки и логотипы ----

export interface InkOptions {
  background: Rgb;
  blocks: RawBlock[];
  /** Номера «плоских» областей (блоки, рамки, линии, внешний фон) */
  flat: Set<number>;
  labels: Int32Array;
  /** Прямоугольники, где «чернил» нет: рамки строк текста (+2 пт) и видимые фото (+1 пт) */
  masked: Rect[];
}

const INK_DISTANCE = 48;
const GROW = 3;
const MIN_SIDE = 6;

/**
 * Прямоугольники векторных значков и логотипов (пт). «Чернила» — точки, отличающиеся от фона самого внутреннего
 * блока (и от фона страницы), кроме: строк текста, видимых фото, плоских областей (заливки, рамки, линии, фон),
 * сглаженной каймы на границе двух плоских областей (края скруглений). Связные области после расширения на 3 пт
 * (чтобы части значка слиплись) → рамка по самим чернилам, не по расширению: рамка кнопки со значком в вырезку
 * не попадает.
 */
export const findInkRects = (grid: PtGrid, options: InkOptions): Rect[] => {
  const { rgb, width: W, height: H } = grid;
  const { labels, flat, blocks, background } = options;

  // внутренний блок каждой точки: заливки от больших к малым, меньшие перекрывают большие
  const fills = blocks
    .filter((block) => block.kind === 'fill')
    .sort((a, b) => b.w * b.h - a.w * a.h);
  const inner = new Int32Array(W * H).fill(-1);
  fills.forEach((fill, index) => {
    for (let y = fill.y; y < Math.min(H, fill.y + fill.h); y++) {
      for (let x = fill.x; x < Math.min(W, fill.x + fill.w); x++) inner[y * W + x] = index;
    }
  });
  const parent = fills.map((fill, index) => {
    let best = -1;
    fills.forEach((other, otherIndex) => {
      if (otherIndex >= index || !containsRect(other, fill, 1)) return;
      if (best === -1 || other.w * other.h < fills[best].w * fills[best].h) best = otherIndex;
    });
    return best;
  });

  const masked = new Uint8Array(W * H);
  for (const rect of options.masked) {
    const xa = Math.max(0, Math.floor(rect.x));
    const xb = Math.min(W, Math.ceil(rect.x + rect.w));
    const ya = Math.max(0, Math.floor(rect.y));
    const yb = Math.min(H, Math.ceil(rect.y + rect.h));
    for (let y = ya; y < yb; y++) masked.fill(1, y * W + xa, y * W + xb);
  }

  const isFlat = (index: number) => {
    const label = labels[index];
    return label > 0 && flat.has(label);
  };
  // рамки и линии вместе с каймой не должны попасть в чернила: полоса вдоль края рамки (толщина + 2 пт: туда
  // попадают и сглаженные дуги углов) и линия с запасом 1 пт; сами их области плоские
  const nearEdgeOrLine = new Uint8Array(W * H);
  const markBand = (xa: number, xb: number, ya: number, yb: number) => {
    for (let y = Math.max(0, ya); y < Math.min(H, yb); y++) {
      nearEdgeOrLine.fill(1, y * W + Math.max(0, xa), y * W + Math.min(W, xb));
    }
  };
  for (const block of blocks) {
    if (block.kind === 'fill') continue;
    if (block.kind === 'line') {
      markBand(block.x - 1, block.x + block.w + 1, block.y - 1, block.y + block.h + 1);
      continue;
    }
    const band = (block.thickness ?? 1) + 2;
    markBand(block.x - 1, block.x + block.w + 1, block.y - 1, block.y + band); // верх
    markBand(block.x - 1, block.x + block.w + 1, block.y + block.h - band, block.y + block.h + 1); // низ
    markBand(block.x - 1, block.x + band, block.y - 1, block.y + block.h + 1); // лево
    markBand(block.x + block.w - band, block.x + block.w + 1, block.y - 1, block.y + block.h + 1); // право
  }

  const ink = new Uint8Array(W * H);
  const differs = (i: number, color: ArrayLike<number>) =>
    colorDistance([rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]], color) > INK_DISTANCE;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (masked[i] || nearEdgeOrLine[i] || isFlat(i)) continue;
      if (!differs(i, background)) continue;
      let walk = inner[i];
      let onBackground = false;
      while (walk !== -1) {
        if (!differs(i, fills[walk].color)) {
          onBackground = true;
          break;
        }
        walk = parent[walk];
      }
      if (onBackground) continue;

      // кайма между двумя плоскими областями (скругления, края)
      const seen = new Set<number>();
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const j = ny * W + nx;
          if (isFlat(j)) seen.add(labels[j]);
        }
      }
      if (seen.size >= 2) continue;
      ink[i] = 1;
    }
  }

  // расширение на GROW пт: два прохода (по строкам, по столбцам) с накоплением суммы
  const grow = (source: Uint8Array, vertical: boolean) => {
    const out = new Uint8Array(W * H);
    const lines = vertical ? W : H;
    const length = vertical ? H : W;
    for (let line = 0; line < lines; line++) {
      const at = (k: number) => (vertical ? k * W + line : line * W + k);
      let last = -1000;
      for (let k = 0; k < length; k++) {
        if (source[at(k)]) last = k;
        if (k - last <= GROW) out[at(k)] = 1;
      }
      let next = length + 1000;
      for (let k = length - 1; k >= 0; k--) {
        if (source[at(k)]) next = k;
        if (next - k <= GROW) out[at(k)] = 1;
      }
    }
    return out;
  };
  const grown = grow(grow(ink, false), true);

  // связные области расширенных чернил → рамка по исходным чернилам
  const result: Rect[] = [];
  const seenGrown = new Uint8Array(W * H);
  const stack: number[] = [];
  for (let start = 0; start < W * H; start++) {
    if (!grown[start] || seenGrown[start]) continue;
    let x0 = W;
    let x1 = -1;
    let y0 = H;
    let y1 = -1;
    stack.push(start);
    seenGrown[start] = 1;
    while (stack.length > 0) {
      const index = stack.pop()!;
      const x = index % W;
      const y = (index - x) / W;
      if (ink[index]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
      if (x > 0 && grown[index - 1] && !seenGrown[index - 1]) {
        seenGrown[index - 1] = 1;
        stack.push(index - 1);
      }
      if (x < W - 1 && grown[index + 1] && !seenGrown[index + 1]) {
        seenGrown[index + 1] = 1;
        stack.push(index + 1);
      }
      if (y > 0 && grown[index - W] && !seenGrown[index - W]) {
        seenGrown[index - W] = 1;
        stack.push(index - W);
      }
      if (y < H - 1 && grown[index + W] && !seenGrown[index + W]) {
        seenGrown[index + W] = 1;
        stack.push(index + W);
      }
    }
    if (x1 < 0) continue;
    const rect = { h: y1 - y0 + 1, w: x1 - x0 + 1, x: x0, y: y0 };
    if (rect.w < MIN_SIDE || rect.h < MIN_SIDE) continue;
    result.push(rect);
  }
  return result.sort((a, b) => a.y - b.y || a.x - b.x);
};

/** Подрезать прямоугольник маленькой картинки до содержимого: края, совпадающие с местным фоном, отбрасываются. */
export const trimToContent = (
  grid: PtGrid,
  rect: Rect,
  background: Rgb,
  blocks: RawBlock[],
): Rect => {
  const { rgb, width: W, height: H } = grid;
  const fills = blocks
    .filter((block) => block.kind === 'fill')
    .sort((a, b) => a.w * a.h - b.w * b.h);
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(W, Math.ceil(rect.x + rect.w));
  const y1 = Math.min(H, Math.ceil(rect.y + rect.h));
  // фон снаружи — цвет самой маленькой заливки, объемлющей прямоугольник, иначе фон страницы
  const around = fills.find((fill) => containsRect(fill, rect, 0));
  const bg: Rgb = around ? around.color : background;
  let minX = x1;
  let maxX = x0 - 1;
  let minY = y1;
  let maxY = y0 - 1;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * W + x) * 3;
      if (colorDistance([rgb[i], rgb[i + 1], rgb[i + 2]], bg) > 24) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX || maxY < minY) return rect;
  return { h: maxY - minY + 1, w: maxX - minX + 1, x: minX, y: minY };
};

export { containsRect, intersectArea, pixelAt };
