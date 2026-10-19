import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import debug from 'debug';

import { IMAGE_MAX_WIDTH, planImageSlices, prepareImageForModel } from './imageSlicing';

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

const PAGE_TIMEOUT_MS = 60_000;
const TOTAL_BUDGET_MS = 120_000;
const PARALLEL_PAGES = 2;

export interface PdfPageImage {
  buffer: Buffer;
  height: number;
  /** Номер куска страницы с 1; у страницы целиком — 1 */
  index: number;
  mimeType: string;
  /** Номер страницы с 1 */
  page: number;
  /** Сколько кусков у этой страницы */
  total: number;
  width: number;
}

export interface PdfRenderResult {
  images: PdfPageImage[];
  /** Сколько страниц в файле */
  pageCount: number;
  /** Сколько страниц нарисовано (по порядку с первой) */
  renderedPages: number;
}

export interface PdfRenderOptions {
  maxImages?: number;
  maxPages?: number;
  /** Тайм-аут одной страницы, мс */
  pageTimeoutMs?: number;
}

interface PageSize {
  height: number;
  width: number;
}

const bin = (name: 'pdfinfo' | 'pdftoppm') =>
  (name === 'pdfinfo' ? process.env.PDFINFO_BIN : process.env.PDFTOPPM_BIN) || name;

const run = (file: string, args: string[], timeout: number): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = execFile(file, args, { maxBuffer: 4 * 1024 * 1024, timeout }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    );
    // Не мешаем остальным службам на хосте: низкий приоритет
    try {
      if (child.pid) os.setPriority(child.pid, 10);
    } catch {
      // приоритет не обязателен
    }
  });

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
        await run(bin('pdfinfo'), ['-f', '1', '-l', String(maxPages), input], 15_000),
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
        const prepared = await prepareImageForModel(png, 'image/png', {
          maxBytes: PDF_IMAGE_TARGET_BYTES,
          maxSlices: slices,
        });
        perPage.set(
          page,
          prepared.parts.map((part, position) => ({
            ...part,
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
    return { images, pageCount: info.pageCount, renderedPages };
  } finally {
    await rm(dir, { force: true, recursive: true }).catch(() => {});
  }
};
