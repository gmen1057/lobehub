import type { PdfPrepPage, PdfPrepRecord } from '../aiAgent/pdfPrepare';
import { type MockPage, type MockPiece, type RawPicture, stitchMockup } from './pictures';
import type { Mockup, MockupBlock, MockupCrop, MockupLine } from './types';

/**
 * arckep (19.10.2026): макет для сверки — из записи подготовки PDF (`files.metadata.pdfPrep`): строки, блоки и
 * вырезки описания (pdfLayout.ts) и куски страниц-картинок (pdfPages.ts).
 *
 * Окно письма — колонка содержимого, а не вся страница: макет 603×5532 с содержимым x0–600 рисуется в окне
 * 600 px, как и в пробе 19.10 (страница на 3 pt шире колонки из-за полей PDF). Если содержимое не прижато к левому
 * краю (колонка по центру), окно — вся страница. Несколько страниц ставятся друг под другом.
 */

export const MIN_WIDTH = 320;
export const MAX_WIDTH = 1600;

type LayoutPageRecord = NonNullable<PdfPrepRecord['layout']>['pages'][number];

/** Ширина окна одной страницы, px. */
const pageViewport = (page: LayoutPageRecord): number => {
  const edges = [...page.blocks.filter((block) => block.kind !== 'line'), ...page.crops];
  let width = page.width;
  if (edges.length > 0) {
    const left = Math.min(...edges.map((item) => item.x));
    const right = Math.max(...edges.map((item) => item.x + item.w));
    if (left <= 2 && right < page.width - 1) width = right;
  }
  return Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width)));
};

/** Описание макета записи → макет для сверки; описания нет — `undefined`. */
export const buildMockup = (
  record: PdfPrepRecord,
  address: (fileId: string) => string,
): Mockup | undefined => {
  const pages = [...(record.layout?.pages ?? [])].sort((a, b) => a.page - b.page);
  if (pages.length === 0) return undefined;

  const lines: MockupLine[] = [];
  const blocks: MockupBlock[] = [];
  const crops: MockupCrop[] = [];
  let offset = 0;
  for (const page of pages) {
    for (const line of page.lines) {
      lines.push({
        bold: line.bold,
        center: line.center,
        size: line.size,
        text: line.text,
        w: line.w,
        x: line.x,
        y: line.y + offset,
      });
    }
    for (const block of page.blocks) {
      blocks.push({
        color: block.color,
        h: block.h,
        kind: block.kind,
        w: block.w,
        x: block.x,
        y: block.y + offset,
      });
    }
    const counters = { icon: 0, photo: 0 };
    for (const crop of page.crops) {
      counters[crop.kind]++;
      const name = `${crop.kind === 'photo' ? 'фото' : 'значок'} ${counters[crop.kind]}`;
      crops.push({
        h: crop.h,
        kind: crop.kind,
        label: pages.length > 1 ? `${name} (стр. ${page.page})` : name,
        url: address(crop.fileId),
        w: crop.w,
        x: crop.x,
        y: crop.y + offset,
      });
    }
    offset += Math.round(page.height);
  }
  if (lines.length === 0 && crops.length === 0) return undefined;

  return {
    blocks,
    crops,
    height: offset,
    lines,
    width: Math.max(...pages.map(pageViewport)),
  };
};

/** Стороннее хранилище: прочитать файл по ключу. */
export type ReadFile = (key: string) => Promise<Uint8Array>;

/** Куски страниц записи → картинка макета «1 пт = 1 px»; кусков нет или чтение не вышло — `undefined`. */
export const loadMockPicture = async (
  record: PdfPrepRecord,
  read: ReadFile,
  viewportWidth: number,
): Promise<RawPicture | undefined> => {
  const layoutPages = [...(record.layout?.pages ?? [])].sort((a, b) => a.page - b.page);
  const parts = (record.pages ?? []) as PdfPrepPage[];
  if (layoutPages.length === 0 || parts.length === 0) return undefined;

  const pieces: MockPiece[] = [];
  for (const part of parts) {
    pieces.push({
      buffer: Buffer.from(await read(part.key)),
      fromPt: part.fromPt,
      height: part.height,
      page: part.page,
      width: part.width,
    });
  }
  const pages: MockPage[] = layoutPages.map((page) => ({
    height: page.height,
    page: page.page,
    width: page.width,
  }));
  return stitchMockup(pieces, pages, viewportWidth);
};
