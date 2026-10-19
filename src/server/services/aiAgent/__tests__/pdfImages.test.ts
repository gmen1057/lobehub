// @vitest-environment node
import { execFileSync } from 'node:child_process';

import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import {
  extractPdfImages,
  parsePdfImagesList,
  PDF_IMAGE_MIN_SIDE,
  PDF_IMAGES_MAX,
} from '../pdfImages';

// arckep (19.10.2026): вшитые в PDF картинки → файлы для HTML (poppler на хосте). Маска даёт альфу, без маски —
// исходный JPEG, мелочь и дубли отбрасываются, на файл не больше 30.

const hasPoppler = (() => {
  try {
    execFileSync('pdfimages', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

interface ImageSpec {
  /** Байты потока */
  data: Buffer;
  /** Словарь картинки без /Length и /SMask */
  dict: string;
  /** Мягкая маска: серая картинка 8 бит */
  smask?: { data: Buffer; height: number; width: number };
}

const rgbDict = (width: number, height: number, filter = '') =>
  `/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8${filter}`;

/** JPEG однотонной картинки: разные цвета — разные байты. */
const jpegImage = async (width: number, height: number, seed: number): Promise<ImageSpec> => ({
  data: await sharp({
    create: {
      background: { b: (seed * 53) % 256, g: 255 - ((seed * 7) % 256), r: (seed * 31) % 256 },
      channels: 3,
      height,
      width,
    },
  })
    .jpeg({ quality: 90 })
    .toBuffer(),
  dict: rgbDict(width, height, ' /Filter /DCTDecode'),
});

/** Красная картинка без сжатия с маской: левая верхняя четверть прозрачна. */
const maskedRed = async (size: number): Promise<ImageSpec> => {
  const data = await sharp({
    create: { background: { b: 0, g: 0, r: 255 }, channels: 3, height: size, width: size },
  })
    .raw()
    .toBuffer();
  const mask = Buffer.alloc(size * size, 255);
  for (let y = 0; y < size / 2; y++) mask.fill(0, y * size, y * size + size / 2);
  return { data, dict: rgbDict(size, size), smask: { data: mask, height: size, width: size } };
};

/**
 * Минимальный PDF: страницы с картинками (pages — номера картинок на каждой странице). Одна картинка на двух
 * страницах — один объект. xref посчитан честно.
 */
const makeImagePdf = (images: ImageSpec[], pages: number[][]): Buffer => {
  const objects = new Map<number, Buffer>();
  const text = (value: string) => Buffer.from(value, 'latin1');

  const firstImage = 3 + pages.length * 2;
  const imageIds: number[] = [];
  let next = firstImage;
  for (const image of images) {
    imageIds.push(next);
    next += image.smask ? 2 : 1;
  }

  objects.set(1, text('<< /Type /Catalog /Pages 2 0 R >>'));
  objects.set(
    2,
    text(
      `<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    ),
  );
  pages.forEach((used, i) => {
    const content = used
      .map((n, k) => `q 100 0 0 100 ${10 + k * 110} 10 cm /Im${n} Do Q`)
      .join(' ');
    objects.set(
      3 + i * 2,
      text(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 700 400] /Contents ${4 + i * 2} 0 R ` +
          `/Resources << /XObject << ${used.map((n) => `/Im${n} ${imageIds[n]} 0 R`).join(' ')} >> >> >>`,
      ),
    );
    objects.set(
      4 + i * 2,
      Buffer.concat([
        text(`<< /Length ${content.length} >>\nstream\n`),
        text(content),
        text('\nendstream'),
      ]),
    );
  });

  const stream = (dict: string, data: Buffer) =>
    Buffer.concat([
      text(`<< ${dict} /Length ${data.length} >>\nstream\n`),
      data,
      text('\nendstream'),
    ]);

  images.forEach((image, i) => {
    const id = imageIds[i];
    if (image.smask) {
      objects.set(id, stream(`${image.dict} /SMask ${id + 1} 0 R`, image.data));
      objects.set(
        id + 1,
        stream(
          `/Type /XObject /Subtype /Image /Width ${image.smask.width} /Height ${image.smask.height} /ColorSpace /DeviceGray /BitsPerComponent 8`,
          image.smask.data,
        ),
      );
    } else {
      objects.set(id, stream(image.dict, image.data));
    }
  });

  const chunks: Buffer[] = [text('%PDF-1.4\n')];
  const offsets = new Map<number, number>();
  let size = chunks[0].length;
  const total = next;
  for (let id = 1; id < total; id++) {
    const body = objects.get(id)!;
    offsets.set(id, size);
    const chunk = Buffer.concat([text(`${id} 0 obj\n`), body, text('\nendobj\n')]);
    chunks.push(chunk);
    size += chunk.length;
  }
  let xref = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let id = 1; id < total; id++) {
    xref += `${String(offsets.get(id)).padStart(10, '0')} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${size}\n%%EOF\n`;
  chunks.push(text(xref));
  return Buffer.concat(chunks);
};

/** RGBA-пиксель (x, y) картинки. */
const pixel = async (buffer: Buffer, x: number, y: number) => {
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const at = (y * info.width + x) * 4;
  return { a: data[at + 3], b: data[at + 2], g: data[at + 1], r: data[at] };
};

describe('parsePdfImagesList', () => {
  it('строки картинок и масок из вывода pdfimages -list, заголовок пропускается', () => {
    const rows = parsePdfImagesList(
      [
        'page   num  type   width height color comp bpc  enc interp  object ID x-ppi y-ppi size ratio',
        '--------------------------------------------------------------------------------------------',
        '   1     0 image     800   600  rgb     3   8  jpeg   no        12  0   150   150  45K  3.1%',
        '   1     1 smask     800   600  gray    1   8  image  no        12  0   150   150 2118B 0.4%',
        '   2     2 image      32    32  rgb     3   8  image  no        19  0    72    72  3076B 100%',
        '',
      ].join('\n'),
    );

    expect(rows).toEqual([
      { height: 600, num: 0, objectId: '12:0', page: 1, type: 'image', width: 800 },
      { height: 600, num: 1, objectId: '12:0', page: 1, type: 'smask', width: 800 },
      { height: 32, num: 2, objectId: '19:0', page: 2, type: 'image', width: 32 },
    ]);
  });

  it('пустой вывод и мусор — пустой список', () => {
    expect(parsePdfImagesList('')).toEqual([]);
    expect(parsePdfImagesList('Syntax Error: bad\nfoo bar')).toEqual([]);
  });
});

describe.skipIf(!hasPoppler)('extractPdfImages', () => {
  it('картинка без маски — исходный JPEG без перекодирования', async () => {
    const photo = await jpegImage(120, 80, 1);
    const [image] = await extractPdfImages(makeImagePdf([photo], [[0]]));

    expect(image).toMatchObject({
      hasAlpha: false,
      height: 80,
      index: 1,
      mimeType: 'image/jpeg',
      page: 1,
      width: 120,
    });
    expect(image.buffer.equals(photo.data)).toBe(true);
  });

  it('маска даёт альфу: PNG, прозрачная четверть прозрачна, остальное непрозрачно и красное', async () => {
    const [image] = await extractPdfImages(makeImagePdf([await maskedRed(64)], [[0]]));

    expect(image).toMatchObject({ hasAlpha: true, height: 64, mimeType: 'image/png', width: 64 });
    expect(await pixel(image.buffer, 2, 2)).toMatchObject({ a: 0 });
    expect(await pixel(image.buffer, 60, 60)).toEqual({ a: 255, b: 0, g: 0, r: 255 });
    expect(await pixel(image.buffer, 60, 2)).toMatchObject({ a: 255 });
  });

  it('маска не создаёт отдельной картинки: картинка с маской — одна', async () => {
    const result = await extractPdfImages(
      makeImagePdf([await maskedRed(64), await jpegImage(100, 100, 2)], [[0, 1]]),
    );
    expect(result.map((image) => image.mimeType)).toEqual(['image/png', 'image/jpeg']);
    expect(result.map((image) => image.index)).toEqual([1, 2]);
  });

  it('мелочь отброшена: сторона меньше 48 точек и полосы; ровно 48 остаётся', async () => {
    const result = await extractPdfImages(
      makeImagePdf(
        [
          await jpegImage(32, 32, 1), // мельче порога
          await jpegImage(300, 4, 2), // горизонтальная полоса градиента
          await jpegImage(2, 300, 3), // вертикальная полоса
          await jpegImage(PDF_IMAGE_MIN_SIDE, PDF_IMAGE_MIN_SIDE, 4), // ровно порог
          await jpegImage(200, 150, 5),
        ],
        [[0, 1, 2, 3, 4]],
      ),
    );

    expect(result.map((image) => [image.width, image.height])).toEqual([
      [PDF_IMAGE_MIN_SIDE, PDF_IMAGE_MIN_SIDE],
      [200, 150],
    ]);
    expect(result.map((image) => image.index)).toEqual([1, 2]);
  });

  it('дубли отброшены: один объект на двух страницах и два объекта с одинаковыми байтами', async () => {
    const same = await jpegImage(90, 90, 7);
    const other = await jpegImage(90, 90, 8);
    // картинка 0 — на обеих страницах; картинки 1 и 2 — разные объекты с теми же байтами; 3 — другая
    const result = await extractPdfImages(
      makeImagePdf([same, { ...same }, { ...same }, other], [[0, 3], [0, 1], [2]]),
    );

    expect(result).toHaveLength(2);
    expect(result[0].buffer.equals(same.data)).toBe(true);
    expect(result[1].buffer.equals(other.data)).toBe(true);
    // номера идут подряд, страница — первая, где картинка встретилась
    expect(result.map((image) => [image.index, image.page])).toEqual([
      [1, 1],
      [2, 1],
    ]);
  });

  it('страница каждой картинки определена верно', async () => {
    const result = await extractPdfImages(
      makeImagePdf(
        [await jpegImage(80, 80, 1), await jpegImage(80, 80, 2), await jpegImage(80, 80, 3)],
        [[0], [], [1, 2]],
      ),
    );
    expect(result.map((image) => image.page)).toEqual([1, 3, 3]);
  });

  it('предел: не больше 30 на файл по умолчанию и не больше maxImages по просьбе', async () => {
    const images = await Promise.all(Array.from({ length: 35 }, (_, i) => jpegImage(64, 64, i)));
    const pdf = makeImagePdf(images, [images.map((_, i) => i)]);

    const all = await extractPdfImages(pdf);
    expect(PDF_IMAGES_MAX).toBe(30);
    expect(all).toHaveLength(30);
    expect(all.map((image) => image.index)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));

    expect(await extractPdfImages(pdf, { maxImages: 2 })).toHaveLength(2);
  });

  it('PDF без картинок, пустой буфер и не-PDF — пустой список, без исключения', async () => {
    expect(await extractPdfImages(makeImagePdf([], [[]]))).toEqual([]);
    expect(await extractPdfImages(Buffer.alloc(0))).toEqual([]);
    expect(await extractPdfImages(Buffer.from('это не PDF'))).toEqual([]);
  });
});
