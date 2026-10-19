import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import debug from 'debug';
import { sha256 } from 'js-sha256';
import sharp from 'sharp';

import { popplerBin, runPoppler } from './popplerRunner';

const log = debug('lobe-server:pdf-images');

/**
 * arckep (19.10.2026): картинки, вшитые в PDF (фото героя, врачей, услуг в макете письма), — файлами человека.
 * Модель получает их адреса в списке вложений и вставляет фото прямо в HTML; сами картинки в запрос не идут,
 * поэтому текста модели прибавляется мало.
 *
 * Как достаём: `pdfimages` (poppler, отдельным процессом под пределами — popplerRunner.ts), как и страницы в
 * pdfPages.ts. В PDF фото часто лежит с мягкой маской (SMask: скругления, прозрачность) отдельной серой
 * картинкой с тем же номером объекта — маска применяется, получается PNG с альфой. Нет маски — исходный JPEG
 * без перекодирования. Мелочь (сторона меньше 48 точек: линии, градиентные полосы), дубли (тот же объект
 * на нескольких страницах, тот же хеш) и картинки сверх 30 на файл отбрасываются.
 *
 * Пределы против «бомб» (PDF приходит от кого угодно, а разбор теперь может стартовать при загрузке файла):
 * - распаковываем только страницы, где есть нужные картинки, по одной (`-f N -l N`), а не весь диапазон сразу;
 * - по списку `pdfimages -list` оцениваем сырой размер всех картинок страницы (ширина × высота × каналы × бит):
 *   страница тяжелее PAGE_RAW_CAP пропускается, всего — не больше TOTAL_RAW_CAP;
 * - каждый записываемый файл ≤ OUTPUT_FILE_MAX_BYTES (prlimit --fsize), реальный размер папки после каждой
 *   страницы ≤ DIR_BYTES_CAP, весь разбор ≤ TOTAL_BUDGET_MS.
 */

export const PDF_IMAGE_MIN_SIDE = 48;
export const PDF_IMAGES_MAX = 30;
/** Сколько первых страниц просматриваем. */
export const PDF_IMAGES_MAX_PAGES = 40;
/** Картинка больше этого (точек) не обрабатывается: при разборе она заняла бы слишком много памяти. */
const MAX_PIXELS = 36_000_000;
/** Один файл, который может записать pdfimages (сырой RGB 36 Мпикс ≈ 108 МБ). */
const OUTPUT_FILE_MAX_BYTES = 128 * 1024 * 1024;
/** Оценка сырого размера всех картинок одной страницы; тяжелее — страница не распаковывается. */
const PAGE_RAW_CAP = 512 * 1024 * 1024;
/** То же на весь файл. */
const TOTAL_RAW_CAP = 1024 * 1024 * 1024;
/** Реальный размер временной папки; больше — следующие страницы не распаковываются. */
const DIR_BYTES_CAP = 512 * 1024 * 1024;
const TOTAL_BUDGET_MS = 300_000;
/** Самый большой PDF, из которого достаём картинки (байт). */
const MAX_PDF_BYTES = 40 * 1024 * 1024;
// Пределы щедрые по той же причине, что в pdfPages.ts: разбор идёт в фоне под низким приоритетом.
const LIST_TIMEOUT_MS = 60_000;
const EXTRACT_TIMEOUT_MS = 180_000;

export interface PdfEmbeddedImage {
  buffer: Buffer;
  /** Есть прозрачность (применена маска) */
  hasAlpha: boolean;
  height: number;
  /** Номер среди оставшихся картинок файла, с 1 (по порядку страниц) */
  index: number;
  mimeType: 'image/jpeg' | 'image/png';
  /** Страница, с 1 */
  page: number;
  width: number;
}

interface ListedImage {
  /** Бит на канал; 0 — неизвестно */
  bpc: number;
  /** Каналов; 0 — неизвестно */
  comp: number;
  height: number;
  num: number;
  objectId: string;
  page: number;
  type: string;
  width: number;
}

/** Строки вывода `pdfimages -list`: page num type width height color comp bpc enc interp object ID … */
export const parsePdfImagesList = (output: string): ListedImage[] => {
  const rows: ListedImage[] = [];
  for (const line of output.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 12 || !/^\d+$/.test(cols[0]) || !/^\d+$/.test(cols[1])) continue;
    const [page, num, type, width, height] = cols;
    rows.push({
      bpc: Number(cols[7]) || 0,
      comp: Number(cols[6]) || 0,
      height: Number(height),
      num: Number(num),
      // номер объекта и поколение: у картинки и её маски номер объекта общий
      objectId: `${cols[10]}:${cols[11]}`,
      page: Number(page),
      type,
      width: Number(width),
    });
  }
  return rows;
};

/** Оценка сырого размера картинки в памяти (байт); неизвестные каналы и глубина — по верхней границе. */
const rawBytes = (row: ListedImage) =>
  (row.width * row.height * (row.comp || 4) * (row.bpc || 8)) / 8;

const dirBytes = async (dir: string) => {
  let total = 0;
  for (const name of await readdir(dir)) total += (await stat(path.join(dir, name))).size;
  return total;
};

/** Картинка (и, если есть, её маска) → один файл: PNG с альфой при маске, иначе исходный JPEG/PNG. */
const compose = async (
  imageFile: Buffer,
  maskFile: Buffer | undefined,
): Promise<{
  buffer: Buffer;
  hasAlpha: boolean;
  height: number;
  mimeType: 'image/jpeg' | 'image/png';
  width: number;
} | null> => {
  const meta = await sharp(imageFile, { failOn: 'none' }).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height || width * height > MAX_PIXELS) return null;

  if (maskFile) {
    const rgb = await sharp(imageFile, { failOn: 'none' })
      .toColourspace('srgb')
      .removeAlpha()
      .raw()
      .toBuffer();
    const alpha = await sharp(maskFile, { failOn: 'none' })
      .greyscale()
      .resize(width, height, { fit: 'fill' })
      .raw()
      .toBuffer();
    const png = await sharp(rgb, { raw: { channels: 3, height, width } })
      .joinChannel(alpha, { raw: { channels: 1, height, width } })
      .png()
      .toBuffer();
    return { buffer: png, hasAlpha: true, height, mimeType: 'image/png', width };
  }

  // Без маски: исходный JPEG/PNG как есть; CMYK и прочее — через sRGB PNG
  const original = meta.format === 'jpeg' || meta.format === 'png';
  const cmyk = meta.space === 'cmyk';
  if (original && !cmyk) {
    return {
      buffer: imageFile,
      hasAlpha: meta.hasAlpha ?? false,
      height,
      mimeType: meta.format === 'jpeg' ? 'image/jpeg' : 'image/png',
      width,
    };
  }
  const png = await sharp(imageFile, { failOn: 'none' }).toColourspace('srgb').png().toBuffer();
  return { buffer: png, hasAlpha: meta.hasAlpha ?? false, height, mimeType: 'image/png', width };
};

/**
 * Вшитые картинки PDF. Любая неудача (нет poppler, повреждённый файл, тайм-аут) — пустой список:
 * вызывающий остаётся без них.
 */
export const extractPdfImages = async (
  pdf: Buffer,
  options: { maxImages?: number } = {},
): Promise<PdfEmbeddedImage[]> => {
  const maxImages = options.maxImages ?? PDF_IMAGES_MAX;
  if (pdf.length === 0 || pdf.length > MAX_PDF_BYTES) return [];

  const dir = await mkdtemp(path.join(os.tmpdir(), 'pdf-images-'));
  try {
    const input = path.join(dir, 'in.pdf');
    await writeFile(input, pdf);
    const range = ['-f', '1', '-l', String(PDF_IMAGES_MAX_PAGES)];

    let listed: ListedImage[];
    try {
      listed = parsePdfImagesList(
        await runPoppler(popplerBin('pdfimages'), ['-list', ...range, input], LIST_TIMEOUT_MS),
      );
    } catch (error) {
      log('pdfimages -list failed: %s', (error as Error).message);
      return [];
    }

    // Маска (smask) — отдельная строка с тем же номером объекта, что у картинки, на той же странице
    const masks = new Map<string, ListedImage>();
    const rowsByPage = new Map<number, ListedImage[]>();
    for (const row of listed) {
      rowsByPage.set(row.page, [...(rowsByPage.get(row.page) ?? []), row]);
      if (row.type === 'smask') masks.set(`${row.page}:${row.objectId}`, row);
    }

    // Кандидаты: настоящие картинки не мельче 48 точек, один объект — один раз (на многих страницах он повторяется)
    const seenObjects = new Set<string>();
    const candidates: ListedImage[] = [];
    for (const row of listed) {
      if (row.type !== 'image') continue;
      if (Math.min(row.width, row.height) < PDF_IMAGE_MIN_SIDE) continue;
      if (row.width * row.height > MAX_PIXELS) continue;
      if (seenObjects.has(row.objectId)) continue;
      seenObjects.add(row.objectId);
      candidates.push(row);
      // запас на дубли по хешу, которые отсеются позже
      if (candidates.length >= maxImages * 2) break;
    }
    if (candidates.length === 0) return [];

    // Распаковываем по странице: только те, где есть кандидаты, и только пока укладываемся в пределы
    const deadline = Date.now() + TOTAL_BUDGET_MS;
    let totalRaw = 0;
    for (const page of [...new Set(candidates.map((row) => row.page))].sort((a, b) => a - b)) {
      if (Date.now() > deadline) break;
      const raw = (rowsByPage.get(page) ?? []).reduce((sum, row) => sum + rawBytes(row), 0);
      if (raw > PAGE_RAW_CAP) {
        log('page %d skipped: images are about %d MB raw', page, Math.round(raw / 1024 / 1024));
        continue;
      }
      if (totalRaw + raw > TOTAL_RAW_CAP) break;
      totalRaw += raw;
      try {
        await runPoppler(
          popplerBin('pdfimages'),
          ['-all', '-f', String(page), '-l', String(page), input, path.join(dir, `p${page}`)],
          EXTRACT_TIMEOUT_MS,
          { maxFileBytes: OUTPUT_FILE_MAX_BYTES },
        );
      } catch (error) {
        // одна «тяжёлая» страница не отменяет остальные
        log('pdfimages -all failed on page %d: %s', page, (error as Error).message);
        continue;
      }
      if ((await dirBytes(dir)) > DIR_BYTES_CAP) {
        log('extracted images exceed %d MB, stopping', DIR_BYTES_CAP / 1024 / 1024);
        break;
      }
    }

    // страница + номер картинки на странице → файл p<стр>-NNN.ext (в каждом запуске номера идут с нуля)
    const files = new Map<string, string>();
    for (const name of await readdir(dir)) {
      const match = name.match(/^p(\d+)-(\d+)\.(\w+)$/);
      if (match) files.set(`${Number(match[1])}:${Number(match[2])}`, name);
    }
    const fileOf = (row: ListedImage) => {
      const first = Math.min(...(rowsByPage.get(row.page) ?? [row]).map((item) => item.num));
      return files.get(`${row.page}:${row.num - first}`);
    };

    const out: PdfEmbeddedImage[] = [];
    const hashes = new Set<string>();
    for (const row of candidates) {
      if (out.length >= maxImages) break;
      const imageName = fileOf(row);
      if (!imageName) continue;
      try {
        const maskRow = masks.get(`${row.page}:${row.objectId}`);
        const maskName = maskRow ? fileOf(maskRow) : undefined;
        const composed = await compose(
          await readFile(path.join(dir, imageName)),
          maskName ? await readFile(path.join(dir, maskName)) : undefined,
        );
        if (!composed) continue;
        if (Math.min(composed.width, composed.height) < PDF_IMAGE_MIN_SIDE) continue;

        const hash = sha256(composed.buffer);
        if (hashes.has(hash)) continue;
        hashes.add(hash);

        out.push({ ...composed, index: out.length + 1, page: row.page });
      } catch (error) {
        log('image %d of the pdf was skipped: %s', row.num, (error as Error).message);
      }
    }

    log('pdf: %d listed row(s) → %d image(s)', listed.length, out.length);
    return out;
  } finally {
    await rm(dir, { force: true, recursive: true }).catch(() => {});
  }
};
