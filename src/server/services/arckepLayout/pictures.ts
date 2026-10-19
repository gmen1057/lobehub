import sharp from 'sharp';

import { issueY } from './compare';
import type { Issue, Rect } from './types';

/**
 * arckep (19.10.2026): картинки сверки — склейка макета из кусков страницы, похожесть по картинке и картинки
 * «макет | письмо» для правщика.
 *
 * Макет приводится к «1 точка = 1 px» (куски страницы — файлы шириной ≤1536 с диапазоном y в точках), письмо
 * приходит снимком в той же ширине. Похожесть — полосы по 400 пт: доля точек с разницей яркости ≤ 40 (порт
 * `compare.py` пробы 19.10). Правщик получает обзор (макет и письмо рядом во всю длину, уменьшенные) и до трёх
 * крупных пар «макет | письмо» по полосам с расхождениями; расхождения обведены: красная рамка — строка или
 * картинка не на месте, жёлтая — заметная разница по картинке без замеренной причины.
 */

/** Сырая картинка: RGB, 3 байта на точку. */
export interface RawPicture {
  data: Buffer;
  height: number;
  width: number;
}

/** Высота полосы похожести, пт. */
export const BAND_HEIGHT = 400;
/** Разница яркости, до которой точки считаются одинаковыми. */
const BRIGHTNESS_TOLERANCE = 40;
/** Самая большая картинка (точек), которую сравниваем: дальше память не оправдана. */
const MAX_PIXELS = 60_000_000;
/** Полосы с похожестью ниже этой подсвечиваются жёлтым, если у них нет замеренной причины. */
const YELLOW_BELOW = 85;
/** Крупных пар в сообщении правщику. */
export const MAX_STRIPS = 3;
/** Сторона картинки в сообщении, px (дальше провайдеры всё равно сжимают). */
const MAX_SIDE = 1568;
const GAP = 20;

const gray = (data: Buffer, offset: number) =>
  (data[offset] * 299 + data[offset + 1] * 587 + data[offset + 2] * 114 + 500) / 1000;

/** Картинка (PNG/JPEG) → сырые точки RGB; если задана ширина — приведена к ней. */
export const decodePicture = async (input: Buffer, width?: number): Promise<RawPicture> => {
  let pipeline = sharp(input, { failOn: 'none', limitInputPixels: MAX_PIXELS }).flatten({
    background: '#ffffff',
  });
  if (width) pipeline = pipeline.resize({ fit: 'fill', width, withoutEnlargement: false });
  const { data, info } = await pipeline.removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, height: info.height, width: info.width };
};

export interface MockPiece {
  buffer: Buffer;
  /** Верх куска на странице, пт (у нецелой страницы) */
  fromPt?: number;
  /** Высота куска, px */
  height: number;
  /** Номер страницы с 1 */
  page: number;
  /** Ширина куска, px */
  width: number;
}

export interface MockPage {
  /** Высота страницы, пт */
  height: number;
  page: number;
  /** Ширина страницы, пт */
  width: number;
}

/**
 * Куски страниц → одна картинка макета «1 пт = 1 px» шириной окна. Страницы стоят друг под другом, куски
 * одной страницы — по их `fromPt` (перекрытие закрывает следующий кусок). Нет кусков или картинка слишком велика —
 * `undefined`: похожесть тогда не считается.
 */
export const stitchMockup = async (
  pieces: MockPiece[],
  pages: MockPage[],
  viewportWidth: number,
): Promise<RawPicture | undefined> => {
  if (pieces.length === 0 || pages.length === 0) return undefined;
  const canvasWidth = Math.max(viewportWidth, ...pages.map((page) => Math.round(page.width)));
  const totalHeight = pages.reduce((sum, page) => sum + Math.round(page.height), 0);
  if (canvasWidth * totalHeight > MAX_PIXELS || totalHeight < 1) return undefined;

  const offsets = new Map<number, number>();
  let top = 0;
  for (const page of pages) {
    offsets.set(page.page, top);
    top += Math.round(page.height);
  }

  const composites: sharp.OverlayOptions[] = [];
  for (const piece of [...pieces].sort(
    (a, b) => a.page - b.page || (a.fromPt ?? 0) - (b.fromPt ?? 0),
  )) {
    const page = pages.find((item) => item.page === piece.page);
    const offset = offsets.get(piece.page);
    if (!page || offset === undefined || piece.width < 1) continue;
    const scale = piece.width / page.width;
    const input = await sharp(piece.buffer, { failOn: 'none' })
      .flatten({ background: '#ffffff' })
      .resize({
        fit: 'fill',
        height: Math.max(1, Math.round(piece.height / scale)),
        width: Math.max(1, Math.round(page.width)),
      })
      .png()
      .toBuffer();
    composites.push({ input, left: 0, top: offset + Math.round(piece.fromPt ?? 0) });
  }
  if (composites.length === 0) return undefined;

  const full = await sharp({
    create: { background: '#ffffff', channels: 3, height: totalHeight, width: canvasWidth },
  })
    .composite(composites)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  // окно письма уже страницы (колонка 600 при странице 603): обрезаем справа отдельным шагом — extract до
  // composite применился бы к основе, и куски не поместились бы
  const { data, info } =
    canvasWidth === viewportWidth
      ? full
      : await sharp(full.data, {
          raw: { channels: 3, height: totalHeight, width: canvasWidth },
        })
          .extract({ height: totalHeight, left: 0, top: 0, width: viewportWidth })
          .removeAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
  return { data, height: info.height, width: info.width };
};

/** Доля одинаковых точек в строках [from, to) (%, одна десятая). Строки, которых нет с одной стороны, — разные. */
export const regionSimilarity = (
  mock: RawPicture,
  render: RawPicture,
  from: number,
  to: number,
): number => {
  const width = Math.min(mock.width, render.width);
  const rows = Math.max(0, to - from);
  if (rows === 0 || width === 0) return 100;
  const shared = Math.min(mock.height, render.height, to);
  let same = 0;
  for (let y = Math.max(0, from); y < shared; y++) {
    const a = y * mock.width * 3;
    const b = y * render.width * 3;
    for (let x = 0; x < width; x++) {
      const diff = Math.abs(gray(mock.data, a + x * 3) - gray(render.data, b + x * 3));
      if (diff <= BRIGHTNESS_TOLERANCE) same++;
    }
  }
  return Math.round((same / (rows * width)) * 1000) / 10;
};

/** Похожесть по полосам 400 пт и средняя по ним (%, одна десятая). Картинки должны быть одной ширины. */
export const bandSimilarity = (
  mock: RawPicture,
  render: RawPicture,
): { average: number; bands: number[] } => {
  const total = Math.max(mock.height, render.height);
  const bands: number[] = [];
  for (let y = 0; y < total; y += BAND_HEIGHT) {
    bands.push(regionSimilarity(mock, render, y, Math.min(y + BAND_HEIGHT, total)));
  }
  const average =
    bands.length > 0 ? bands.reduce((sum, value) => sum + value, 0) / bands.length : 100;
  return { average: Math.round(average * 10) / 10, bands };
};

// ---- Картинки для правщика ----

export interface Frame {
  /** red — не на месте (замерено), yellow — разница по картинке без замеренной причины */
  color: 'red' | 'yellow';
  rect: Rect;
}

const COLORS = { red: '#e11d1d', yellow: '#f5b800' } as const;

const rectsSvg = (width: number, height: number, frames: Frame[], scale: number) => {
  const items = frames
    .map(({ color, rect }) => {
      const x = Math.round(rect.x * scale);
      const y = Math.round(rect.y * scale);
      const w = Math.max(2, Math.round(rect.w * scale));
      const h = Math.max(2, Math.round(rect.h * scale));
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${COLORS[color]}" stroke-width="2"/>`;
    })
    .join('');
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${items}</svg>`,
  );
};

/** Окно картинки [y0, y1) → sharp. */
const rowsOf = (picture: RawPicture, y0: number, y1: number) => {
  const top = Math.max(0, Math.min(y0, picture.height));
  const bottom = Math.max(top, Math.min(y1, picture.height));
  const rows = bottom - top;
  const data =
    rows > 0
      ? picture.data.subarray(top * picture.width * 3, bottom * picture.width * 3)
      : Buffer.alloc(0);
  return { data, rows };
};

/** Пустое место под картинкой (письмо короче макета и наоборот) закрашивается серым, чтобы разница была видна. */
const FILLER = { b: 150, g: 150, r: 150 };

interface PairOptions {
  frames: { mock: Frame[]; render: Frame[] };
  /** Масштаб итоговой картинки */
  scale: number;
  y0: number;
  y1: number;
}

/** Пара «макет | письмо» по окну [y0, y1) в одну JPEG. */
const pair = async (
  mock: RawPicture,
  render: RawPicture,
  options: PairOptions,
): Promise<Buffer> => {
  const { frames, scale, y0, y1 } = options;
  const rows = Math.max(1, y1 - y0);
  const side = async (picture: RawPicture, sideFrames: Frame[]) => {
    const { data, rows: have } = rowsOf(picture, y0, y1);
    const base = sharp({
      create: { background: FILLER, channels: 3, height: rows, width: picture.width },
    });
    const layers: sharp.OverlayOptions[] = [];
    if (have > 0) {
      layers.push({
        input: await sharp(data, { raw: { channels: 3, height: have, width: picture.width } })
          .png()
          .toBuffer(),
        left: 0,
        top: 0,
      });
    }
    const local = sideFrames
      .map((frame) => ({ ...frame, rect: { ...frame.rect, y: frame.rect.y - y0 } }))
      .filter((frame) => frame.rect.y + frame.rect.h >= 0 && frame.rect.y <= rows);
    if (local.length > 0) {
      layers.push({ input: rectsSvg(picture.width, rows, local, 1), left: 0, top: 0 });
    }
    return base.composite(layers).png().toBuffer();
  };

  const left = await side(mock, frames.mock);
  const right = await side(render, frames.render);
  const width = mock.width;
  const gap = GAP;
  const sheet = await sharp({
    create: { background: '#282828', channels: 3, height: rows, width: width * 2 + gap },
  })
    .composite([
      { input: left, left: 0, top: 0 },
      { input: right, left: width + gap, top: 0 },
    ])
    .png()
    .toBuffer();
  const outWidth = Math.max(1, Math.round((width * 2 + gap) * scale));
  return sharp(sheet)
    .resize({ width: outWidth })
    .jpeg({ chromaSubsampling: '4:4:4', quality: 82 })
    .toBuffer();
};

export interface EditorStrip {
  /** Что обведено */
  caption: string;
  from: number;
  jpeg: Buffer;
  to: number;
}

export interface EditorPictures {
  overview: Buffer;
  strips: EditorStrip[];
}

const issueFrames = (issues: Issue[]) => {
  const mock: Frame[] = [];
  const render: Frame[] = [];
  for (const issue of issues) {
    if (issue.kind === 'line') {
      const h = Math.max(8, issue.mock.size * 1.3);
      mock.push({ color: 'red', rect: { h, w: issue.mock.w, x: issue.mock.x, y: issue.mock.y } });
      if (issue.render) {
        render.push({
          color: 'red',
          rect: { h: issue.render.h || h, w: issue.mock.w, x: issue.render.x, y: issue.render.y },
        });
      }
    } else if (issue.kind === 'image') {
      mock.push({ color: 'red', rect: issue.mock });
      if (issue.render) render.push({ color: 'red', rect: issue.render });
    }
  }
  return { mock, render };
};

/**
 * Картинки для правщика: обзор и до трёх крупных пар. Полосы выбираются по числу замеренных расхождений и по
 * провалу похожести; в выбранных расхождения обведены красным, а куски с заметной разницей без замеренной причины —
 * жёлтым.
 */
export const buildEditorPictures = async (
  mock: RawPicture,
  render: RawPicture,
  issues: Issue[],
  bands: number[],
): Promise<EditorPictures> => {
  const total = Math.max(mock.height, render.height);

  // обзор: оба снимка рядом во всю длину
  const scale = Math.min(1, Math.max(MAX_SIDE / total, 0.15));
  const overview = await pair(mock, render, {
    frames: { mock: [], render: [] },
    scale,
    y0: 0,
    y1: total,
  });

  // какие полосы показать крупно
  const count = Math.ceil(total / BAND_HEIGHT);
  const scored = Array.from({ length: count }, (_, index) => {
    const from = index * BAND_HEIGHT;
    const reds = issues.filter((issue) => {
      const y = issueY(issue);
      return y !== undefined && y >= from && y < from + BAND_HEIGHT && issue.kind !== 'overflow';
    }).length;
    const similarity = bands[index] ?? 100;
    const low = similarity < YELLOW_BELOW;
    return {
      index,
      low,
      reds,
      score: reds > 0 || low ? Math.min(reds, 10) * 2 + (100 - similarity) / 5 : 0,
    };
  })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_STRIPS)
    .sort((a, b) => a.index - b.index);

  const strips: EditorStrip[] = [];
  for (const item of scored) {
    const from = Math.max(0, item.index * BAND_HEIGHT - 40);
    const to = Math.min(total, (item.index + 1) * BAND_HEIGHT + 40);
    const inside = issues.filter((issue) => {
      const y = issueY(issue);
      return y !== undefined && y >= from && y < to;
    });
    const frames = issueFrames(inside);
    // жёлтые: куски по 100 пт с заметной разницей, в которых нет красной рамки
    for (let y = from; y < to; y += 100) {
      const end = Math.min(y + 100, to);
      const red = frames.mock.some(
        (frame) => frame.rect.y < end && frame.rect.y + frame.rect.h > y,
      );
      if (!red && regionSimilarity(mock, render, y, end) < YELLOW_BELOW) {
        const rect = { h: end - y, w: mock.width - 2, x: 1, y };
        frames.mock.push({ color: 'yellow', rect });
        frames.render.push({ color: 'yellow', rect });
      }
    }
    const pairScale = Math.min(1, MAX_SIDE / (mock.width * 2 + GAP));
    const reds = inside.filter((issue) => issue.kind === 'line' || issue.kind === 'image').length;
    strips.push({
      caption: `y ${from}–${to}: ${reds > 0 ? `красным обведено ${reds} расхождений` : 'расхождений в замерах нет'}${frames.mock.some((frame) => frame.color === 'yellow') ? ', жёлтым — заметная разница по картинке без замеренной причины' : ''}`,
      from,
      jpeg: await pair(mock, render, { frames, scale: pairScale, y0: from, y1: to }),
      to,
    });
  }

  return { overview, strips };
};

/** JPEG → адрес `data:` для сообщения модели. */
export const toDataUri = (jpeg: Buffer) => `data:image/jpeg;base64,${jpeg.toString('base64')}`;
