import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { LayoutBlock, LayoutLine } from '@lobechat/prompts';
import debug from 'debug';
import sharp from 'sharp';

import fontWidths from './layoutFontWidths.json';
import {
  type BlockResult,
  cornerRadii,
  findBlocks,
  findInkRects,
  findRegions,
  intersectArea,
  makeGrid,
  pageBackground,
  type RawBlock,
  type RawImage,
  type Rect,
  textColor,
  toHex,
  visibleRect,
} from './layoutRaster';
import type { PdfPageRaster } from './pdfPages';
import { popplerBin as bin, runPoppler as run } from './popplerRunner';

const log = debug('lobe-server:pdf-layout');

/**
 * arckep (19.10.2026): «описание макета» PDF для модели — этап A.
 *
 * Люди присылают макет письма или страницы в PDF и просят сверстать HTML «точно по макету». Модель получала
 * текстовый слой, страницы картинками и список вшитых картинок и верстала на глаз: не те картинки не на своих
 * местах, значки текстом или эмодзи (векторные значки в PDF не извлекаются), шрифт мельче. Здесь с файла
 * снимается точное описание (его собирает в текст packages/prompts/.../layout.ts):
 * - строки текста (pdftohtml -xml): место, размер шрифта, жирность, ссылка; цвет — с нарисованной страницы;
 * - блоки: заливки, рамки-контуры, линии, скругления (layoutRaster.ts) — по той же нарисованной странице;
 * - вырезки: видимые части вшитых фото (картинка pdftohtml сравнивается с нарисованной страницей: рамка карточки
 *   обрезает фото) и векторные значки/логотипы («чернила» без текста, фото и рамок) — файлами человека, в 2×;
 * - подсказка шрифта: во сколько раз строки шире тех же строк в Arial (Liberation Sans) — таблица ширин
 *   layoutFontWidths.json (scripts/arckep/gen-layout-font-widths.py).
 *
 * Страницу заново не рисуем: берём ту же PNG, что идёт на куски для модели (pdfPages.ts, keepRasters). Работает
 * в фоне при подготовке файла (pdfPrepare.ts), с пределами: ≤10 страниц, ≤800 строк на страницу и ≤2000 всего,
 * ≤40 вырезок на файл, ~120 с на всё. Любая ошибка — описания нет, остальная подготовка работает как раньше.
 */

export const LAYOUT_MAX_PAGES = 10;
export const LAYOUT_MAX_LINES_PER_PAGE = 800;
export const LAYOUT_MAX_LINES = 2000;
export const LAYOUT_MAX_CROPS = 40;
export const LAYOUT_MAX_BLOCKS_PER_PAGE = 300;
/** Описание нужно только макетам: блоков и вырезок на файле меньше этого — это просто текст, описания нет. */
export const LAYOUT_MIN_ELEMENTS = 4;
const TOTAL_BUDGET_MS = 120_000;
const PAGE_TIMEOUT_MS = 60_000;
const MAX_IMAGES_PER_PAGE = 60;
/** Картинка из pdftohtml не больше этого (точек): как в pdfImages.ts. */
const MAX_IMAGE_PIXELS = 36_000_000;
/** Ужатая до места картинка не больше этого (точек): место в PDF может быть сколь угодно большим. */
const MAX_PLACED_PIXELS = 40_000_000;
/** Кандидатов на вырезку на странице: остальное отбрасывается до слияния и нарезки. */
const MAX_CROP_CANDIDATES = 300;
/** Вырезки сохраняем в 2× (но не крупнее, чем нарисована страница) */
const CROP_SCALE = 2;
const PHOTO_QUALITY = 88;
/** Маленькие картинки-значки (в пт): подрезаются до содержимого */
const ICON_MAX_SIDE = 130;
/** Вырезки крупнее этого значками не считаются (иллюстрации, фоны) */
const ICON_MAX_WIDTH_SHARE = 0.7;
const ICON_MAX_HEIGHT = 260;

// ---- Разбор вывода pdftohtml -xml ----

export interface ParsedLine {
  bold: boolean;
  family?: string;
  h: number;
  link?: string;
  size: number;
  text: string;
  w: number;
  x: number;
  y: number;
}

export interface ParsedImage {
  h: number;
  src: string;
  w: number;
  x: number;
  y: number;
}

export interface ParsedPage {
  height: number;
  images: ParsedImage[];
  lines: ParsedLine[];
  width: number;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: '\u00A0',
  quot: '"',
};

export const decodeEntities = (text: string) =>
  text.replaceAll(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, name: string) => {
    if (name[0] === '#') {
      const code =
        name[1].toLowerCase() === 'x' ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isFinite(code) && code > 0 && code <= 1_114_111
        ? String.fromCodePoint(code)
        : match;
    }
    return ENTITIES[name.toLowerCase()] ?? match;
  });

const attributes = (source: string) => {
  const result: Record<string, string> = {};
  for (const match of source.matchAll(/([\w:-]+)="([^"]*)"/g))
    result[match[1]] = decodeEntities(match[2]);
  return result;
};

/** Название шрифта без метки подмножества (ABCDEF+Roboto → Roboto); служебные и пустые — нет. */
export const cleanFontName = (family?: string) => {
  // только буквы, цифры и знаки имён шрифтов: название идёт в запрос модели
  const name = (family ?? '')
    .replace(/^[A-Z]{6}\+/, '')
    .replaceAll(/[^\p{L}\p{N} ._+-]/gu, '')
    .trim();
  if (!name || /^(?:unknown|null|undefined|\d+)$/i.test(name) || /glyphs|type\s*3/i.test(name)) {
    return undefined;
  }
  return name.slice(0, 60);
};

/**
 * Страница из `pdftohtml -xml` (zoom 1: единица — пункт): размер, строки (место, размер шрифта, жирность,
 * ссылка) и места вшитых картинок. Пустой или без страницы вывод — `undefined`.
 */
export const parsePdfHtmlXml = (xml: string): ParsedPage | undefined => {
  const page = /<page ([^>]*)>/.exec(xml);
  if (!page) return undefined;
  const pageAttrs = attributes(page[1]);
  const width = Number(pageAttrs.width);
  const height = Number(pageAttrs.height);
  if (!(width > 0) || !(height > 0)) return undefined;

  const fonts = new Map<string, { family?: string; size: number }>();
  for (const match of xml.matchAll(/<fontspec ([^>]*?)\/?>/g)) {
    const attrs = attributes(match[1]);
    if (attrs.id !== undefined)
      fonts.set(attrs.id, { family: attrs.family, size: Number(attrs.size) });
  }

  const lines: ParsedLine[] = [];
  for (const match of xml.matchAll(/<text ([^>]*)>([\s\S]*?)<\/text>/g)) {
    const attrs = attributes(match[1]);
    const font = fonts.get(attrs.font);
    const inner = match[2];
    const text = decodeEntities(inner.replaceAll(/<[^>]+>/g, '')).replace(/\s+$/, '');
    const x = Number(attrs.left);
    const y = Number(attrs.top);
    const w = Number(attrs.width);
    const h = Number(attrs.height);
    if (!text.trim() || !font || ![x, y, w, h, font.size].every(Number.isFinite) || font.size <= 0)
      continue;
    const boldText = [...inner.matchAll(/<b>([\s\S]*?)<\/b>/g)]
      .map((part) => decodeEntities(part[1].replaceAll(/<[^>]+>/g, '')))
      .join('');
    lines.push({
      bold: boldText.trim().length > 0 && boldText.trim().length >= text.trim().length * 0.6,
      family: cleanFontName(font.family),
      h,
      link: /<a\s[^>]*href="([^"]+)"/.exec(inner)?.[1]
        ? decodeEntities(/<a\s[^>]*href="([^"]+)"/.exec(inner)![1])
        : undefined,
      size: Math.round(font.size),
      text,
      w,
      x,
      y,
    });
  }

  const images: ParsedImage[] = [];
  for (const match of xml.matchAll(/<image ([^>]*?)\/?>/g)) {
    const attrs = attributes(match[1]);
    const rect = [attrs.left, attrs.top, attrs.width, attrs.height].map(Number);
    if (!attrs.src || !rect.every(Number.isFinite) || rect[2] <= 0 || rect[3] <= 0) continue;
    images.push({ h: rect[3], src: attrs.src, w: rect[2], x: rect[0], y: rect[1] });
  }

  return { height, images, lines, width };
};

// ---- Подсказка шрифта ----

type WidthTable = Record<string, number>;
const widths = fontWidths as unknown as { bold: WidthTable; fallback: number; regular: WidthTable };

/** Ширина текста в Arial (Liberation Sans) при размере `size`, пт. */
export const arialWidth = (text: string, size: number, bold = false) => {
  const table = bold ? widths.bold : widths.regular;
  let total = 0;
  for (const char of text) total += table[char] ?? widths.fallback;
  return (total * size) / 1000;
};

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return undefined;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/** Медиана отношения «ширина строки в PDF / ширина тех же знаков в Arial» по строкам от 15 знаков. */
export const fontWidthRatio = (lines: Array<Pick<ParsedLine, 'bold' | 'size' | 'text' | 'w'>>) => {
  const ratios = lines
    .filter((line) => [...line.text.trim()].length >= 15 && line.w > 0)
    .map((line) => line.w / arialWidth(line.text.trim(), line.size, line.bold))
    .filter((ratio) => Number.isFinite(ratio) && ratio > 0);
  const value = median(ratios);
  return value === undefined ? undefined : Math.round(value * 100) / 100;
};

// ---- Результат ----

export interface LayoutCropDraft {
  buffer: Buffer;
  h: number;
  kind: 'icon' | 'photo';
  mime: 'image/jpeg' | 'image/png';
  /** Сколько px у файла */
  pxHeight: number;
  pxWidth: number;
  w: number;
  x: number;
  y: number;
}

export interface LayoutPageDraft {
  background: string;
  blocks: LayoutBlock[];
  crops: LayoutCropDraft[];
  fontNames?: string[];
  fontRatio?: number;
  height: number;
  lines: LayoutLine[];
  omittedLines?: number;
  page: number;
  textColor?: string;
  width: number;
}

export interface LayoutDraft {
  pages: LayoutPageDraft[];
  /** Места вшитых картинок на страницах (по порядку в файле) для списка вложений */
  places: Array<{ h: number; page: number; w: number; x: number; y: number }>;
}

// ---- Пиксели ----

const decodeRaster = async (png: Buffer): Promise<RawImage> => {
  const { data, info } = await sharp(png, { failOn: 'none' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 3) throw new Error(`unexpected channels: ${info.channels}`);
  return { data, height: info.height, width: info.width };
};

const roundPt = (value: number) => Math.round(value * 10) / 10;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Вырезка прямоугольника страницы (пт) → файл: фото — JPEG, остальное — PNG; в 2× (но не крупнее нарисованного). */
const cropImage = async (
  raw: RawImage,
  sx: number,
  sy: number,
  rect: Rect,
  kind: 'icon' | 'photo',
): Promise<Omit<LayoutCropDraft, 'h' | 'w' | 'x' | 'y' | 'kind'>> => {
  const left = clamp(Math.round(rect.x * sx), 0, raw.width - 1);
  const top = clamp(Math.round(rect.y * sy), 0, raw.height - 1);
  const width = clamp(Math.round(rect.w * sx), 1, raw.width - left);
  const height = clamp(Math.round(rect.h * sy), 1, raw.height - top);
  const outWidth = Math.max(1, Math.round(rect.w * Math.min(CROP_SCALE, sx)));
  const outHeight = Math.max(1, Math.round(rect.h * Math.min(CROP_SCALE, sy)));

  let pipeline = sharp(raw.data, {
    raw: { channels: 3, height: raw.height, width: raw.width },
  }).extract({
    height,
    left,
    top,
    width,
  });
  if (outWidth !== width || outHeight !== height) {
    pipeline = pipeline.resize(outWidth, outHeight, { fit: 'fill', kernel: 'lanczos3' });
  }
  const output =
    kind === 'photo'
      ? pipeline.jpeg({ quality: PHOTO_QUALITY })
      : pipeline.png({ compressionLevel: 9 });
  const { data, info } = await output.toBuffer({ resolveWithObject: true });
  return {
    buffer: data,
    mime: kind === 'photo' ? 'image/jpeg' : 'image/png',
    pxHeight: info.height,
    pxWidth: info.width,
  };
};

/** Картинка из pdftohtml, ужатая до места на странице (px), для сравнения с нарисованной страницей. */
const loadPlaced = async (
  file: string,
  width: number,
  height: number,
): Promise<RawImage | undefined> => {
  try {
    const { data, info } = await sharp(file, {
      failOn: 'none',
      // чужой файл: «бомба» из огромной картинки не должна съесть память
      limitInputPixels: MAX_IMAGE_PIXELS,
      sequentialRead: true,
    })
      .resize(Math.max(1, width), Math.max(1, height), { fit: 'fill' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return { data, height: info.height, width: info.width };
  } catch (error) {
    log('image %s was not read: %s', path.basename(file), (error as Error).message);
    return undefined;
  }
};

/** Объединение пересекающихся прямоугольников (телефон в руке = рука + маска + экран → одна вырезка). */
export const mergeOverlapping = (rects: Rect[]): Rect[] => {
  const groups = rects.map((rect) => ({ ...rect }));
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < groups.length && !merged; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        if (intersectArea(groups[i], groups[j]) <= 0) continue;
        const x = Math.min(groups[i].x, groups[j].x);
        const y = Math.min(groups[i].y, groups[j].y);
        const right = Math.max(groups[i].x + groups[i].w, groups[j].x + groups[j].w);
        const bottom = Math.max(groups[i].y + groups[i].h, groups[j].y + groups[j].h);
        groups[i] = { h: bottom - y, w: right - x, x, y };
        groups.splice(j, 1);
        merged = true;
        break;
      }
    }
  }
  return groups;
};

const inside = (rect: Rect, width: number, height: number): Rect => {
  const x = clamp(rect.x, 0, width);
  const y = clamp(rect.y, 0, height);
  return {
    h: clamp(rect.y + rect.h, 0, height) - y,
    w: clamp(rect.x + rect.w, 0, width) - x,
    x,
    y,
  };
};

const grow = (rect: Rect, by: number): Rect => ({
  h: rect.h + by * 2,
  w: rect.w + by * 2,
  x: rect.x - by,
  y: rect.y - by,
});

const snap = (rect: Rect): Rect => {
  const x = Math.round(rect.x);
  const y = Math.round(rect.y);
  return {
    h: Math.max(1, Math.round(rect.y + rect.h) - y),
    w: Math.max(1, Math.round(rect.x + rect.w) - x),
    x,
    y,
  };
};

/**
 * Заливка продолжается под фото, если фото вплотную налезает на неё: карточка «фото справа + цветной фон слева»
 * целиком, а не только видимый кусок фона. Условие: пересечение не меньше 2 пт по обеим осям, и по одной из осей
 * заливка укладывается в фото (карточка и фото одной высоты — фото сбоку; одной ширины — фото сверху).
 */
const extendUnderPhotos = (block: Rect, photos: Rect[]): Rect => {
  let result = block;
  for (const photo of photos) {
    const w = Math.min(result.x + result.w, photo.x + photo.w) - Math.max(result.x, photo.x);
    const h = Math.min(result.y + result.h, photo.y + photo.h) - Math.max(result.y, photo.y);
    if (w < 2 || h < 2) continue;
    const sameHeight = result.y >= photo.y - 3 && result.y + result.h <= photo.y + photo.h + 3;
    const sameWidth = result.x >= photo.x - 3 && result.x + result.w <= photo.x + photo.w + 3;
    if (!sameHeight && !sameWidth) continue;
    const x = Math.min(result.x, photo.x);
    const y = Math.min(result.y, photo.y);
    result = {
      h: Math.max(result.y + result.h, photo.y + photo.h) - y,
      w: Math.max(result.x + result.w, photo.x + photo.w) - x,
      x,
      y,
    };
  }
  return result;
};

// ---- Страница ----

interface PageContext {
  deadline: number;
  dir: string;
  pdfPath: string;
}

const runPdfToHtml = async (context: PageContext, page: number) => {
  const out = path.join(context.dir, `p${page}`);
  await run(
    bin('pdftohtml'),
    ['-xml', '-q', '-zoom', '1', '-f', String(page), '-l', String(page), context.pdfPath, out],
    PAGE_TIMEOUT_MS,
    { maxFileBytes: 128 * 1024 * 1024 },
  );
  return { xml: await readFile(`${out}.xml`, 'utf8') };
};

/** Главный цвет текста — самый частый по числу знаков. */
const dominant = (colors: Array<{ color: string; weight: number }>) => {
  const sums = new Map<string, number>();
  for (const { color, weight } of colors) sums.set(color, (sums.get(color) ?? 0) + weight);
  let best: string | undefined;
  let bestWeight = -1;
  for (const [color, weight] of sums) {
    if (weight > bestWeight) {
      best = color;
      bestWeight = weight;
    }
  }
  return best;
};

/**
 * «По центру»: середина строки у середины страницы (±4 пт) И левый край строки не встречается у других строк (иначе
 * это колонка с левым выравниванием: строка «пятый продолжает испытывать» ложно считалась бы центрированной).
 */
export const centeredFlags = (
  lines: Array<Pick<ParsedLine, 'w' | 'x'>>,
  pageWidth: number,
): boolean[] => {
  const lefts = new Map<number, number>();
  for (const line of lines) lefts.set(line.x, (lefts.get(line.x) ?? 0) + 1);
  return lines.map(
    (line) =>
      Math.abs(line.x + line.w / 2 - pageWidth / 2) <= 4 &&
      line.w < pageWidth * 0.9 &&
      (lefts.get(line.x) ?? 0) < 2,
  );
};

/** Вырезка до слияния: прямоугольник и «фото» ли это (JPEG) или значок (PNG). */
interface CropItem {
  photo: boolean;
  rect: Rect;
}

const analysePage = async (
  context: PageContext,
  page: number,
  raster: PdfPageRaster,
  /** Сколько вырезок ещё можно на файле */
  maxCrops: number,
): Promise<{ draft: LayoutPageDraft; places: LayoutDraft['places'] } | undefined> => {
  const started = Date.now();
  const marks: string[] = [];
  const mark = (name: string) => marks.push(`${name} ${Date.now() - started}`);
  const { xml } = await runPdfToHtml(context, page);
  mark('pdftohtml');
  const parsed = parsePdfHtmlXml(xml);
  if (!parsed) return undefined;

  const raw = await decodeRaster(raster.png);
  mark('decode');
  const grid = makeGrid(raw, raster.ptWidth, raster.ptHeight);
  if (!grid) {
    log('page %d is too large for the layout (%d×%d pt)', page, parsed.width, parsed.height);
    return undefined;
  }
  const { sx, sy } = grid;
  const background = pageBackground(grid);
  const pageArea = parsed.width * parsed.height;

  // 1. Вшитые картинки. Фото без маски — видимую часть находим по совпадению с нарисованной страницей (рамка
  // карточки обрезает фото). Маленькие картинки и картинки с маской прозрачности (рука, рамка телефона,
  // значок) по совпадению не найти: их содержимое ищется как «чернила» вместе с векторными значками.
  const visible: Rect[] = []; // видимые части фото, найденные по совпадению
  const inkPlaces: Rect[] = []; // места картинок, которые разбираются как чернила
  const places: LayoutDraft['places'] = [];
  for (const image of parsed.images.slice(0, MAX_IMAGES_PER_PAGE)) {
    const place: Rect = { h: image.h, w: image.w, x: image.x, y: image.y };
    const onPage = inside(place, parsed.width, parsed.height);
    if (onPage.w < 6 || onPage.h < 6) continue;
    places.push({ h: onPage.h, page, w: onPage.w, x: onPage.x, y: onPage.y });
    // картинка на всю страницу (скан): страница уже есть картинкой, отдельная вырезка не нужна
    if (onPage.w * onPage.h >= pageArea * 0.85) {
      visible.push(onPage);
      continue;
    }
    if (onPage.w <= ICON_MAX_SIDE && onPage.h <= ICON_MAX_SIDE) {
      inkPlaces.push(onPage);
      continue;
    }
    // место в PDF задаёт кто угодно: огромное ужимать не будем (ни память, ни время), разберём как «чернила»
    const placedWidth = Math.round(place.w * sx);
    const placedHeight = Math.round(place.h * sy);
    const placed =
      placedWidth * placedHeight <= Math.min(MAX_PLACED_PIXELS, raw.width * raw.height * 2)
        ? await loadPlaced(
            path.join(context.dir, path.basename(image.src)),
            placedWidth,
            placedHeight,
          )
        : undefined;
    const found = placed ? visibleRect(raw, sx, sy, place, placed) : undefined;
    if (found?.rect && !(found.ratio < 0.9 && found.transparent >= 0.5)) {
      visible.push(snap(inside(found.rect, parsed.width, parsed.height)));
    } else {
      inkPlaces.push(onPage);
    }
  }
  const photoGroups = mergeOverlapping(visible);
  mark('images');

  // 2. Строки: цвет с нарисованной страницы, выравнивание «по центру»
  const lines = parsed.lines.slice(0, LAYOUT_MAX_LINES_PER_PAGE);
  const omittedLines = Math.max(0, parsed.lines.length - lines.length);
  const lineColors = lines.map((line) =>
    textColor(raw, sx, sy, { h: line.h, w: line.w, x: line.x, y: line.y }),
  );
  const mainColor = dominant(
    lines.flatMap((line, index) => {
      const color = lineColors[index];
      return color ? [{ color: toHex(color), weight: line.text.trim().length }] : [];
    }),
  );
  const centered = centeredFlags(lines, parsed.width);
  const draftLines: LayoutLine[] = lines.map((line, index) => {
    const found = lineColors[index];
    const color = found ? toHex(found) : undefined;
    return {
      ...(line.bold ? { bold: true } : {}),
      ...(centered[index] ? { center: true } : {}),
      ...(color && color !== mainColor ? { color } : {}),
      ...(line.link ? { link: line.link.slice(0, 300) } : {}),
      size: line.size,
      text: line.text.slice(0, 300),
      w: line.w,
      x: line.x,
      y: line.y,
    };
  });
  const textRects: Rect[] = lines.map((line) => ({ h: line.h, w: line.w, x: line.x, y: line.y }));

  // 3. Блоки: заливки, рамки, линии (вне фото), скругления
  const regionMap = await findRegions(grid);
  mark('regions');
  const blockResult: BlockResult = findBlocks(grid, regionMap, {
    background,
    photos: [...photoGroups, ...inkPlaces],
    texts: textRects,
  });
  const rawBlocks: RawBlock[] = blockResult.blocks.slice(0, LAYOUT_MAX_BLOCKS_PER_PAGE);

  const blocks: LayoutBlock[] = rawBlocks.map((block) => {
    const rect: Rect = { h: block.h, w: block.w, x: block.x, y: block.y };
    const extended = block.kind === 'fill' ? extendUnderPhotos(rect, photoGroups) : rect;
    const radii = block.kind === 'line' ? undefined : cornerRadii(raw, sx, sy, rect, block.color);
    // углы, которые ушли под фото, неизвестны
    if (radii) {
      if (extended.x < rect.x) radii[0] = radii[3] = -1;
      if (extended.x + extended.w > rect.x + rect.w) radii[1] = radii[2] = -1;
      if (extended.y < rect.y) radii[0] = radii[1] = -1;
      if (extended.y + extended.h > rect.y + rect.h) radii[2] = radii[3] = -1;
    }
    return {
      color: toHex(block.color),
      h: extended.h,
      kind: block.kind,
      ...(radii?.some((value) => value >= 0) ? { radii } : {}),
      ...(block.thickness ? { thickness: block.thickness } : {}),
      w: extended.w,
      x: extended.x,
      y: extended.y,
    };
  });

  mark('blocks');

  // 4. Значки и логотипы: «чернила» без текста, видимых фото и рамок
  const masked: Rect[] = [
    ...textRects.map((rect) => grow(rect, 2)),
    ...photoGroups.map((rect) => grow(rect, 1)),
  ];
  const inkRects = findInkRects(grid, {
    background,
    blocks: blockResult.blocks,
    flat: blockResult.flat,
    labels: regionMap.labels,
    masked,
  }).filter((rect) => rect.w <= parsed.width * ICON_MAX_WIDTH_SHARE && rect.h <= ICON_MAX_HEIGHT);

  mark('ink');

  // 5. Вырезки: видимые фото + чернила (значок — рамка по чернилам + 1 пт на сглаживание); пересекающиеся
  // сливаются в одну (телефон в руке = рука + маска + экран); маленькие картинки подрезаются до содержимого
  const items: CropItem[] = [];
  for (const rect of photoGroups) {
    if (rect.w * rect.h >= pageArea * 0.85 || rect.w < 6 || rect.h < 6) continue;
    items.push({ photo: true, rect });
  }
  for (const rect of inkRects) {
    const touchesPicture = inkPlaces.some((place) => intersectArea(rect, place) > 0);
    items.push({
      photo: touchesPicture && Math.max(rect.w, rect.h) > ICON_MAX_SIDE,
      rect: grow(rect, 1),
    });
  }
  // слишком много кандидатов (шумная иллюстрация): фото и крупные вперёд, остальное — не разбираем
  const byImportance = (a: CropItem, b: CropItem) =>
    Number(b.photo) - Number(a.photo) || b.rect.w * b.rect.h - a.rect.w * a.rect.h;
  if (items.length > MAX_CROP_CANDIDATES) {
    items.sort(byImportance);
    items.length = MAX_CROP_CANDIDATES;
  }
  const merged: CropItem[] = [];
  const queue = items.map((item) => ({ ...item }));
  while (queue.length > 0) {
    let current = queue.shift()!;
    for (let i = 0; i < queue.length; i++) {
      if (intersectArea(current.rect, queue[i].rect) <= 0) continue;
      const other = queue.splice(i, 1)[0];
      const [rect] = mergeOverlapping([current.rect, other.rect]);
      current = { photo: current.photo || other.photo, rect };
      i = -1;
    }
    merged.push(current);
  }

  // вырезок на файл не больше LAYOUT_MAX_CROPS: лишние не режем вовсе
  if (merged.length > maxCrops) {
    merged.sort(byImportance);
    merged.length = Math.max(0, maxCrops);
  }
  const crops: LayoutCropDraft[] = [];
  for (const item of merged) {
    const box = snap(inside(item.rect, parsed.width, parsed.height));
    if (box.w < 6 || box.h < 6) continue;
    const kind = item.photo ? 'photo' : 'icon';
    const file = await cropImage(raw, sx, sy, box, kind);
    crops.push({ ...file, h: box.h, kind, w: box.w, x: box.x, y: box.y });
  }
  crops.sort((a, b) => a.y - b.y || a.x - b.x);

  mark('crops');
  log('page %d layout: %s ms', page, marks.join(', '));

  const fontNames = [
    ...new Set(parsed.lines.map((line) => line.family).filter(Boolean) as string[]),
  ].slice(0, 5);
  return {
    draft: {
      background: toHex(background),
      blocks,
      crops,
      ...(fontNames.length > 0 ? { fontNames } : {}),
      fontRatio: fontWidthRatio(lines),
      height: parsed.height,
      lines: draftLines,
      ...(omittedLines > 0 ? { omittedLines } : {}),
      page,
      ...(mainColor ? { textColor: mainColor } : {}),
      width: parsed.width,
    },
    places,
  };
};

export interface AnalyseOptions {
  /** Сколько мс на всё */
  budgetMs?: number;
  maxPages?: number;
}

/**
 * Описание макета по нарисованным страницам (pdfPages.ts, keepRasters). Нет pdftohtml, нет страниц, не макет
 * (мало блоков и вырезок), ошибка — `undefined`. Одна упавшая страница пропускается, остальные работают.
 */
export const analysePdfLayout = async (
  pdf: Buffer,
  rasters: Map<number, PdfPageRaster>,
  options: AnalyseOptions = {},
): Promise<LayoutDraft | undefined> => {
  if (pdf.length === 0 || rasters.size === 0) return undefined;
  const maxPages = options.maxPages ?? LAYOUT_MAX_PAGES;
  const deadline = Date.now() + (options.budgetMs ?? TOTAL_BUDGET_MS);

  const dir = await mkdtemp(path.join(os.tmpdir(), 'pdf-layout-'));
  try {
    const pdfPath = path.join(dir, 'in.pdf');
    await writeFile(pdfPath, pdf);
    const context: PageContext = { deadline, dir, pdfPath };

    const pages: LayoutPageDraft[] = [];
    const places: LayoutDraft['places'] = [];
    let totalLines = 0;
    let totalCrops = 0;
    for (const page of [...rasters.keys()].sort((a, b) => a - b).slice(0, maxPages)) {
      if (Date.now() > deadline) {
        log('layout budget is over before page %d', page);
        break;
      }
      try {
        const result = await analysePage(
          context,
          page,
          rasters.get(page)!,
          LAYOUT_MAX_CROPS - totalCrops,
        );
        if (!result) continue;
        const { draft } = result;
        // общие пределы на файл
        if (totalLines + draft.lines.length > LAYOUT_MAX_LINES) {
          const room = Math.max(0, LAYOUT_MAX_LINES - totalLines);
          draft.omittedLines = (draft.omittedLines ?? 0) + (draft.lines.length - room);
          draft.lines = draft.lines.slice(0, room);
        }
        if (totalCrops + draft.crops.length > LAYOUT_MAX_CROPS) {
          draft.crops = draft.crops.slice(0, Math.max(0, LAYOUT_MAX_CROPS - totalCrops));
        }
        totalLines += draft.lines.length;
        totalCrops += draft.crops.length;
        pages.push(draft);
        places.push(...result.places);
      } catch (error) {
        log('page %d layout failed: %s', page, (error as Error).message);
      }
      // отдаём процессор остальной работе движка между страницами
      await new Promise((resolve) => setImmediate(resolve));
    }

    const elements = pages.reduce(
      (sum, draft) =>
        sum + draft.blocks.filter((block) => block.kind !== 'line').length + draft.crops.length,
      0,
    );
    const textLines = pages.reduce((sum, draft) => sum + draft.lines.length, 0);
    if (elements < LAYOUT_MIN_ELEMENTS || textLines < 3) {
      log('not a mockup (%d element(s), %d line(s)), no layout', elements, textLines);
      return undefined;
    }
    return { pages, places };
  } catch (error) {
    log('layout failed: %s', (error as Error).message);
    return undefined;
  } finally {
    await rm(dir, { force: true, recursive: true }).catch(() => {});
  }
};

// ---- Места вшитых картинок для списка вложений ----

export interface PlacedImage {
  height: number;
  index: number;
  page: number;
  width: number;
}

/**
 * Место на странице каждой вшитой картинки (pdfImages.ts) по местам из pdftohtml. Порядок картинок на странице у
 * обеих программ один (порядок рисования), но у pdfImages есть пропуски (мелочь, дубли): идём по местам подряд и
 * берём следующую картинку той же страницы с тем же соотношением сторон (±4 %); не нашли — места нет.
 */
export const matchImagePlaces = (
  images: PlacedImage[],
  placements: Array<{ h: number; page: number; w: number; x: number; y: number }>,
  ratioOf: (image: PlacedImage) => number = (image) => image.width / image.height,
): Map<number, { h: number; w: number; x: number; y: number }> => {
  const result = new Map<number, { h: number; w: number; x: number; y: number }>();
  const pages = new Set(images.map((image) => image.page));
  for (const page of pages) {
    const mine = images.filter((image) => image.page === page).sort((a, b) => a.index - b.index);
    let pointer = 0;
    for (const place of placements.filter((item) => item.page === page)) {
      const ratio = place.w / place.h;
      for (let i = pointer; i < mine.length; i++) {
        const candidate = ratioOf(mine[i]);
        if (Math.abs(candidate - ratio) / ratio <= 0.04) {
          result.set(mine[i].index, {
            h: roundPt(place.h),
            w: roundPt(place.w),
            x: roundPt(place.x),
            y: roundPt(place.y),
          });
          pointer = i + 1;
          break;
        }
      }
    }
  }
  return result;
};
