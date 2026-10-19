// @vitest-environment node
import sharp from 'sharp';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ingestAttachment } from '../ingestAttachment';

// arckep (19.10.2026): ingest отдаёт модели все куски длинной картинки по порядку, обычную — одним файлом.

let counter = 0;
const fileService = {
  getFullFileUrl: vi.fn(async (key: string) => `https://s3.test/${key}`),
  uploadFromBuffer: vi.fn(async (_buffer: Buffer, _mime: string, pathname: string) => ({
    fileId: `file_${++counter}`,
    key: pathname,
  })),
};

const ingest = (source: Parameters<typeof ingestAttachment>[0]) =>
  ingestAttachment(source, fileService as any, 'user_1');

const canvas = (width: number, height: number, format: 'jpeg' | 'png' = 'jpeg') => {
  const image = sharp({ create: { background: '#445566', channels: 3, height, width } });
  return format === 'jpeg' ? image.jpeg().toBuffer() : image.png().toBuffer();
};

beforeEach(() => {
  counter = 0;
  vi.clearAllMocks();
});

describe('ingestAttachment — картинки', () => {
  it('длинный макет 2512×23050: 8 файлов «имя.part-NN-of-08.png» по порядку, поля прежнего вида — у первого', async () => {
    const result = await ingest({ buffer: await canvas(2512, 23_050), name: 'letter.jpg' });

    expect(result.isImage).toBe(true);
    expect(result.images).toHaveLength(8);
    expect(result.images.map((image) => image.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(result.images.every((image) => image.total === 8)).toBe(true);
    expect(result.images.map((image) => image.name)).toEqual(
      Array.from({ length: 8 }, (_, i) => `letter.jpg.part-0${i + 1}-of-08.png`),
    );
    // загружены по порядку, ключи под папкой человека
    const uploaded = fileService.uploadFromBuffer.mock.calls.map((call) => call[2]);
    expect(uploaded).toHaveLength(8);
    expect(uploaded.every((path) => path.startsWith('files/user_1/'))).toBe(true);
    expect(uploaded.map((path) => path.split('/').at(-1))).toEqual(
      result.images.map((image) => image.name),
    );
    for (const call of fileService.uploadFromBuffer.mock.calls) {
      expect(call[1]).toBe('image/png');
      const meta = await sharp(call[0]).metadata();
      expect([meta.width, meta.height]).toEqual([1536, 2048]);
    }
    // прежние поля — первый кусок
    expect(result.fileId).toBe(result.images[0].fileId);
    expect(result.key).toBe(result.images[0].key);
    expect(result.resolvedUrl).toBe(result.images[0].resolvedUrl);
    expect(result.resolvedUrl).toMatch(/^https:\/\/s3\.test\/files\/user_1\/.+part-01-of-08\.png$/);
  }, 60_000);

  it('обычное фото в пределах: один файл под своим именем, байты не менялись', async () => {
    const photo = await canvas(1200, 800);
    const result = await ingest({ buffer: photo, mimeType: 'image/jpeg', name: 'photo.jpg' });

    expect(result.images).toHaveLength(1);
    expect(result.images[0]).toMatchObject({ index: 1, name: 'photo.jpg', total: 1 });
    expect(fileService.uploadFromBuffer).toHaveBeenCalledTimes(1);
    const [buffer, mime, pathname] = fileService.uploadFromBuffer.mock.calls[0];
    expect(buffer).toBe(photo);
    expect(mime).toBe('image/jpeg');
    expect(pathname.endsWith('/photo.jpg')).toBe(true);
  });

  it('большое фото 4000×3000: один файл, сжат по ширине до 1536 (PNG)', async () => {
    const result = await ingest({ buffer: await canvas(4000, 3000), name: 'big.jpg' });

    expect(result.images).toHaveLength(1);
    const [buffer, mime] = fileService.uploadFromBuffer.mock.calls[0];
    expect(mime).toBe('image/png');
    const meta = await sharp(buffer).metadata();
    expect([meta.width, meta.height]).toEqual([1536, 1152]);
  });

  it('экран телефона 1170×2532 — один файл, не режется', async () => {
    const result = await ingest({ buffer: await canvas(1170, 2532, 'png'), name: 'screen.png' });
    expect(result.images).toHaveLength(1);
    expect(fileService.uploadFromBuffer).toHaveBeenCalledTimes(1);
  });

  it('картинка по ссылке тоже режется', async () => {
    const tall = await canvas(1600, 9000);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(new Uint8Array(tall), { headers: { 'content-type': 'image/jpeg' } }),
      ),
    );
    try {
      const result = await ingest({ name: 'long.jpg', url: 'https://example.com/long.jpg' });
      expect(result.images.length).toBeGreaterThan(1);
      expect(result.images.every((image) => image.total === result.images.length)).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  }, 60_000);
});

describe('ingestAttachment — не картинки', () => {
  it('PDF и прочее: один файл, images пуст, resolvedUrl пуст — как раньше', async () => {
    const result = await ingest({
      buffer: Buffer.from('%PDF-1.4'),
      mimeType: 'application/pdf',
      name: 'doc.pdf',
    });

    expect(result.isImage).toBe(false);
    expect(result.images).toEqual([]);
    expect(result.resolvedUrl).toBe('');
    expect(result.fileId).toBe('file_1');
    expect(fileService.uploadFromBuffer.mock.calls[0][1]).toBe('application/pdf');
    expect(fileService.getFullFileUrl).not.toHaveBeenCalled();
  });

  it('нет ни буфера, ни ссылки — понятная ошибка', async () => {
    await expect(ingest({ name: 'x' })).rejects.toThrow('buffer or url');
  });
});
