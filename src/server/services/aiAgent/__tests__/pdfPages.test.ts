// @vitest-environment node
import { execFileSync } from 'node:child_process';

import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';

import { parsePdfInfo, PDF_MAX_IMAGES, PDF_MAX_PAGES, renderPdfPages } from '../pdfPages';

// arckep (19.10.2026): страницы PDF → картинки для моделей со зрением (poppler на хосте).

const hasPoppler = (() => {
  try {
    execFileSync('pdftoppm', ['-v'], { stdio: 'ignore' });
    execFileSync('pdfinfo', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

interface TestPage {
  /** Высота в пунктах */
  h: number;
  /** Ширина в пунктах */
  w: number;
}

/**
 * Минимальный PDF: у каждой страницы чёрная плашка сверху, синяя снизу и строка текста; xref посчитан честно.
 * Размер страницы задаётся MediaBox, как у реальных макетов (603×5532 пт у письма владельца).
 */
const makePdf = (pages: TestPage[]): Buffer => {
  const objects: string[] = [];
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ');
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  pages.forEach(({ w, h }, i) => {
    const pageObj = 4 + i * 2;
    const content =
      `0 0 0 rg 0 ${h - 120} ${w} 120 re f ` + // чёрная плашка сверху
      `0 0.3 1 rg 0 0 ${w} 120 re f ` + // синяя снизу
      `BT /F1 36 Tf 40 ${h / 2} Td (Page ${i + 1}) Tj ET`;
    objects[pageObj] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Contents ${pageObj + 1} 0 R ` +
      '/Resources << /Font << /F1 3 0 R >> >> >>';
    objects[pageObj + 1] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  });

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = Buffer.byteLength(out);
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) {
    out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out);
};

const A4: TestPage = { h: 842, w: 595 };
const OWNER_PAGE: TestPage = { h: 5532, w: 603 };

describe('parsePdfInfo', () => {
  it('число страниц и размеры из вывода pdfinfo', () => {
    const info = parsePdfInfo(
      [
        'Title:  x',
        'Pages:           3',
        'Page    1 size: 603 x 5532 pts',
        'Page    2 size: 595.276 x 841.89 pts (A4)',
      ].join('\n'),
    );
    expect(info.pageCount).toBe(3);
    expect(info.sizes.get(1)).toEqual({ height: 5532, width: 603 });
    expect(info.sizes.get(2)).toEqual({ height: 841.89, width: 595.276 });
    expect(info.sizes.has(3)).toBe(false);
  });

  it('пустой вывод — ноль страниц', () => {
    expect(parsePdfInfo('')).toEqual({ pageCount: 0, sizes: new Map() });
  });
});

describe.runIf(hasPoppler)('renderPdfPages (poppler)', () => {
  const saved = { info: process.env.PDFINFO_BIN, ppm: process.env.PDFTOPPM_BIN };
  afterEach(() => {
    process.env.PDFINFO_BIN = saved.info;
    process.env.PDFTOPPM_BIN = saved.ppm;
    if (saved.info === undefined) delete process.env.PDFINFO_BIN;
    if (saved.ppm === undefined) delete process.env.PDFTOPPM_BIN;
  });

  const pixel = async (buffer: Buffer, x: number, y: number) => {
    const { data, info } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
    const at = (y * info.width + x) * info.channels;
    return [data[at], data[at + 1], data[at + 2]];
  };

  it('высокая страница как у письма владельца (603×5532 пт): 8 кусков 1536×2048, сверху чёрное, снизу синее', async () => {
    const result = await renderPdfPages(makePdf([OWNER_PAGE]));

    expect(result.pageCount).toBe(1);
    expect(result.renderedPages).toBe(1);
    expect(result.images).toHaveLength(8);
    expect(result.images.map((image) => [image.page, image.index, image.total])).toEqual(
      Array.from({ length: 8 }, (_, i) => [1, i + 1, 8]),
    );
    for (const image of result.images) {
      expect([image.width, image.height]).toEqual([1536, 2048]);
      const meta = await sharp(image.buffer).metadata();
      expect([meta.width, meta.height]).toEqual([1536, 2048]);
    }

    // порядок: чёрная плашка — в верхней части первого куска, синяя — в нижней части последнего
    const [r, g, b] = await pixel(result.images[0].buffer, 700, 20);
    expect(r + g + b).toBeLessThan(40);
    const [, , blue] = await pixel(result.images[7].buffer, 700, 2048 - 20);
    expect(blue).toBeGreaterThan(200);
    // середина первого куска — белый фон (плашки там нет)
    expect(await pixel(result.images[0].buffer, 5, 1000)).toEqual([255, 255, 255]);
  }, 60_000);

  it('три страницы A4: по одной картинке, ширина 1536', async () => {
    const result = await renderPdfPages(makePdf([A4, A4, A4]));

    expect(result.pageCount).toBe(3);
    expect(result.renderedPages).toBe(3);
    expect(result.images.map((image) => [image.page, image.index, image.total])).toEqual([
      [1, 1, 1],
      [2, 1, 1],
      [3, 1, 1],
    ]);
    for (const image of result.images) {
      expect(image.width).toBe(1536);
      expect(image.height).toBe(Math.round((842 / 595) * 1536));
      expect(image.mimeType).toBe('image/png');
    }
  }, 60_000);

  it('больше 10 страниц: рисуются первые 10, остальные только в тексте', async () => {
    const result = await renderPdfPages(makePdf(Array.from({ length: 12 }, () => A4)));
    expect(result.pageCount).toBe(12);
    expect(result.renderedPages).toBe(PDF_MAX_PAGES);
    expect(result.images).toHaveLength(PDF_MAX_PAGES);
    expect(result.images.map((image) => image.page)).toEqual(
      Array.from({ length: PDF_MAX_PAGES }, (_, i) => i + 1),
    );
  }, 90_000);

  it('четыре высокие страницы: всего не больше 16 картинок, у каждой страницы — хотя бы одна, по порядку', async () => {
    const result = await renderPdfPages(makePdf(Array.from({ length: 4 }, () => OWNER_PAGE)));

    expect(result.renderedPages).toBe(4);
    expect(result.images.length).toBeLessThanOrEqual(PDF_MAX_IMAGES);
    const pages = [...new Set(result.images.map((image) => image.page))];
    expect(pages).toEqual([1, 2, 3, 4]);
    // порядок: страницы по возрастанию, куски внутри страницы по возрастанию
    const keys = result.images.map((image) => image.page * 100 + image.index);
    expect(keys).toEqual([...keys].sort((a, b) => a - b));
  }, 120_000);

  it('PDF без страниц, повреждённый и пустой — пусто, без исключения', async () => {
    for (const junk of [
      Buffer.from('это не PDF'),
      Buffer.alloc(0),
      Buffer.from('%PDF-1.4\n%%EOF'),
    ]) {
      const result = await renderPdfPages(junk);
      expect(result.images).toEqual([]);
    }
  });

  it('нет poppler (неверный путь к программе) — пусто, остаётся текстовый слой', async () => {
    process.env.PDFINFO_BIN = '/nonexistent/pdfinfo';
    expect((await renderPdfPages(makePdf([A4]))).images).toEqual([]);

    delete process.env.PDFINFO_BIN;
    process.env.PDFTOPPM_BIN = '/nonexistent/pdftoppm';
    const result = await renderPdfPages(makePdf([A4]));
    expect(result.images).toEqual([]);
    expect(result.pageCount).toBe(1);
  });

  it('maxImages и maxPages ограничивают результат', async () => {
    const result = await renderPdfPages(makePdf([A4, A4, A4, A4]), { maxImages: 2, maxPages: 3 });
    expect(result.images.length).toBeLessThanOrEqual(2);
    expect(result.renderedPages).toBeLessThanOrEqual(2);
  }, 60_000);
});
