import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import debug from 'debug';

import {
  IMAGE_MAX_TOTAL_HEIGHT,
  IMAGE_MAX_WIDTH,
  IMAGE_MIN_WIDTH,
  planImageSlices,
  prepareImageForModel,
} from './imageSlicing';
import { popplerBin as bin, runPoppler as run } from './popplerRunner';

const log = debug('lobe-server:pdf-pages');

/**
 * arckep (19.10.2026): страницы PDF → картинки для моделей со зрением.
 *
 * Модель получала из PDF только текстовый слой (documents) — вёрстка, картинки и таблицы пропадали, а у
 * макетов, где текст нарисован, не оставалось ничего. Теперь до PDF_MAX_PAGES страниц рисуются в картинки
 * (ширина ≤ 1536; высокие страницы режутся на куски так же, как картинки — imageSlicing.ts), всего не больше
 * PDF_MAX_IMAGES картинок на файл.
 *
 * Чем рисуем: poppler (pdftoppm/pdfinfo) отдельным процессом. Движок работает на хосте под systemd, poppler
 * там стоит. Отдельный процесс изолирует разбор чужих PDF от движка (зависание и падение не трогают
 * сервис, есть тайм-аут и низкий приоритет); pdfjs-dist в процессе движка требовал бы холст (@napi-rs/canvas)
 * в том же процессе, с памятью высоких страниц и без этой изоляции. Нет poppler — картинок нет, остаётся
 * текстовый слой (как раньше).
 */

export const PDF_MAX_PAGES = 10;
export const PDF_MAX_IMAGES = 16;
/** Самый большой PDF, который рисуем (байт): больше — только текст. */
export const PDF_MAX_BYTES = 40 * 1024 * 1024;

/** Вес одной картинки страницы: до 16 штук на файл, весь запрос к Gemini (inline) — до 20 МБ с base64. */
const PDF_IMAGE_TARGET_BYTES = 640 * 1024;

// Рисование идёт в фоне при загрузке файла (pdfPrepare.ts) под низким приоритетом: на занятом хосте poppler
// получает малую долю процессора, и прежние 60 с на страницу превращались в «ничего не нарисовано». Модель
// результат не ждёт (execAgent — не дольше 5 с), поэтому пределы щедрые; от зависания защищает prlimit --cpu.
const PAGE_TIMEOUT_MS = 180_000;
const TOTAL_BUDGET_MS = 420_000;
const PARALLEL_PAGES = 2;
/** Сколько байт PNG целых страниц держим в памяти для описания макета; сверх — у страницы описания не будет. */
const RASTER_KEEP_BYTES = 160 * 1024 * 1024;

export interface PdfPageImage {
  buffer: Buffer;
  /** Где кусок лежит на странице: от и до по вертикали, пункты страницы (у куска нарезанной страницы) */
  fromPt?: number;
  height: number;
  /** Номер куска страницы с 1; у страницы целиком — 1 */
  index: number;
  mimeType: string;
  /** Номер страницы с 1 */
  page: number;
  toPt?: number;
  /** Сколько кусков у этой страницы */
  total: number;
  width: number;
}

/**
 * Страница целиком одной PNG-картинкой — так, как её нарисовал pdftoppm, до нарезки на куски. Нужна описанию
 * макета (pdfLayout.ts), чтобы не рисовать страницу второй раз.
 */
export interface PdfPageRaster {
  png: Buffer;
  /** Размер страницы в пунктах (из pdfinfo) */
  ptHeight: number;
  ptWidth: number;
  /** Размер картинки в точках экрана */
  pxHeight: number;
  pxWidth: number;
}

export interface PdfRenderResult {
  images: PdfPageImage[];
  /** Сколько страниц в файле */
  pageCount: number;
  /** Целые страницы (только при keepRasters), по номеру страницы с 1; только нарисованные */
  rasters?: Map<number, PdfPageRaster>;
  /** Сколько страниц нарисовано (по порядку с первой) */
  renderedPages: number;
}

export interface PdfRenderOptions {
  /** Оставить целые страницы в результате (для описания макета); сверх RASTER_KEEP_BYTES не копим */
  keepRasters?: boolean;
  maxImages?: number;
  maxPages?: number;
  /** Тайм-аут одной страницы, мс */
  pageTimeoutMs?: number;
}

interface PageSize {
  height: number;
  width: number;
}

/** Число страниц и размеры первых `limit` страниц (пункты) из вывода `pdfinfo -f 1 -l N`. */
export const parsePdfInfo = (
  output: string,
): { pageCount: number; sizes: Map<number, PageSize> } => {
  const pageCount = Number(output.match(/^Pages:\s+(\d+)/m)?.[1] ?? 0);
  const sizes = new Map<number, PageSize>();
  for (const match of output.matchAll(/^Page\s+(\d+)\s+size:\s+([\d.]+)\s+x\s+([\d.]+)\s+pts/gm)) {
    const width = Number(match[2]);
    const height = Number(match[3]);
    if (width > 0 && height > 0) sizes.set(Number(match[1]), { height, width });
  }
  return { pageCount, sizes };
};

/**
 * Страницы PDF → картинки. Любая неудача (нет poppler, повреждённый или запароленный файл, тайм-аут) —
 * пустой результат: вызывающий остаётся с текстовым слоем.
 */
export const renderPdfPages = async (
  pdf: Buffer,
  options: PdfRenderOptions = {},
): Promise<PdfRenderResult> => {
  const maxPages = options.maxPages ?? PDF_MAX_PAGES;
  const maxImages = options.maxImages ?? PDF_MAX_IMAGES;
  const pageTimeout = options.pageTimeoutMs ?? PAGE_TIMEOUT_MS;
  const empty: PdfRenderResult = { images: [], pageCount: 0, renderedPages: 0 };

  if (pdf.length === 0 || pdf.length > PDF_MAX_BYTES) return empty;

  const dir = await mkdtemp(path.join(os.tmpdir(), 'pdf-pages-'));
  try {
    const input = path.join(dir, 'in.pdf');
    await writeFile(input, pdf);

    let info: ReturnType<typeof parsePdfInfo>;
    try {
      info = parsePdfInfo(
        await run(bin('pdfinfo'), ['-f', '1', '-l', String(maxPages), input], 60_000),
      );
    } catch (error) {
      log('pdfinfo failed, no page images: %s', (error as Error).message);
      return empty;
    }
    if (info.pageCount === 0) return empty;

    // План по всем страницам заранее: каждой странице — не меньше одной картинки, остальное делится по порядку
    const pagesToRender = Math.min(info.pageCount, maxPages, maxImages);
    const plans: Array<{ page: number; slices: number; width: number }> = [];
    let budget = maxImages;
    for (let page = 1; page <= pagesToRender; page++) {
      const size = info.sizes.get(page);
      if (!size) break;
      // Страница крайней пропорции (полоса, выше 30000 px даже при ширине 768): рисовать нельзя — картинка в памяти
      // была бы огромной
      if ((size.height / size.width) * IMAGE_MIN_WIDTH > IMAGE_MAX_TOTAL_HEIGHT) break;
      const reserved = pagesToRender - page; // по картинке на каждую следующую страницу
      const maxForPage = Math.min(budget - reserved, 12);
      if (maxForPage < 1) break;
      // Векторная страница рисуется сразу нужной ширины (≤1536), не растягивая малое
      const plan = planImageSlices(
        IMAGE_MAX_WIDTH,
        Math.round((size.height / size.width) * IMAGE_MAX_WIDTH),
        maxForPage,
      );
      plans.push({ page, slices: maxForPage, width: plan.width });
      budget -= plan.slices.length;
    }

    const deadline = Date.now() + TOTAL_BUDGET_MS;
    const perPage = new Map<number, PdfPageImage[]>();
    const rasters = new Map<number, PdfPageRaster>();
    let rasterBytes = 0;

    const renderPage = async ({ page, slices, width }: (typeof plans)[number]) => {
      if (Date.now() > deadline) return;
      const prefix = path.join(dir, `p${page}`);
      try {
        await run(
          bin('pdftoppm'),
          [
            '-f',
            String(page),
            '-l',
            String(page),
            '-scale-to-x',
            String(width),
            '-scale-to-y',
            '-1',
            '-png',
            '-singlefile',
            input,
            prefix,
          ],
          pageTimeout,
        );
        const png = await readFile(`${prefix}.png`);
        const size = info.sizes.get(page);
        if (options.keepRasters && size && rasterBytes + png.length <= RASTER_KEEP_BYTES) {
          // размер картинки — из заголовка PNG (IHDR: ширина и высота по 4 байта с 16-го)
          rasters.set(page, {
            png,
            ptHeight: size.height,
            ptWidth: size.width,
            pxHeight: png.readUInt32BE(20),
            pxWidth: png.readUInt32BE(16),
          });
          rasterBytes += png.length;
        }
        const prepared = await prepareImageForModel(png, 'image/png', {
          maxBytes: PDF_IMAGE_TARGET_BYTES,
          maxSlices: slices,
        });
        // масштаб (px на пт) — по ширине куска: подпись «часть 2 из 8 (y 740–1544)» в точках страницы
        const scale = size && prepared.parts[0]?.width ? prepared.parts[0].width / size.width : 0;
        perPage.set(
          page,
          prepared.parts.map(({ top, ...part }, position) => ({
            ...part,
            ...(prepared.parts.length > 1 && scale > 0 && top !== undefined
              ? {
                  fromPt: Math.round(top / scale),
                  toPt: Math.min(Math.round(size!.height), Math.round((top + part.height) / scale)),
                }
              : {}),
            index: position + 1,
            page,
            total: prepared.parts.length,
          })),
        );
      } catch (error) {
        log('page %d was not rendered: %s', page, (error as Error).message);
      }
    };

    // Небольшой пул: страницы независимы, но хост общий
    const queue = [...plans];
    await Promise.all(
      Array.from({ length: Math.min(PARALLEL_PAGES, queue.length) }, async () => {
        for (let next = queue.shift(); next; next = queue.shift()) await renderPage(next);
      }),
    );

    // Только подряд идущие нарисованные страницы с первой: дыра в середине сбила бы нумерацию для модели
    const images: PdfPageImage[] = [];
    let renderedPages = 0;
    for (const { page } of plans) {
      const pageImages = perPage.get(page);
      if (!pageImages || images.length + pageImages.length > maxImages) break;
      images.push(...pageImages);
      renderedPages = page;
    }

    log('pdf: %d page(s), rendered %d → %d image(s)', info.pageCount, renderedPages, images.length);
    for (const page of rasters.keys()) if (page > renderedPages) rasters.delete(page);
    return {
      images,
      pageCount: info.pageCount,
      ...(options.keepRasters ? { rasters } : {}),
      renderedPages,
    };
  } finally {
    await rm(dir, { force: true, recursive: true }).catch(() => {});
  }
};
