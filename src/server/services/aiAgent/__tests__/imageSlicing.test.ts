// @vitest-environment node
import { randomBytes } from 'node:crypto';

import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import {
  IMAGE_MAX_BYTES,
  IMAGE_MAX_SLICES,
  IMAGE_MAX_WIDTH,
  IMAGE_PART_TARGET_BYTES,
  IMAGE_SINGLE_MAX_HEIGHT,
  IMAGE_SLICE_HEIGHT,
  IMAGE_SLICE_OVERLAP,
  planImageSlices,
  prepareImageForModel,
} from '../imageSlicing';

// arckep (19.10.2026): картинки для модели со зрением — ширина ≤1536, обычные остаются одним изображением,
// длинные (макет письма 2512×23050) режутся на куски сверху вниз с перекрытием.

const OWNER_JPEG = { height: 23_050, width: 2512 };

/** Куски покрывают всю высоту подряд, с перекрытием не меньше OVERLAP, по порядку сверху вниз. */
const expectCovering = (plan: ReturnType<typeof planImageSlices>) => {
  const { slices, height } = plan;
  expect(slices[0].top).toBe(0);
  const last = slices.at(-1)!;
  expect(last.top + last.height).toBe(height);
  for (let i = 1; i < slices.length; i++) {
    const previousEnd = slices[i - 1].top + slices[i - 1].height;
    expect(slices[i].top).toBeGreaterThan(slices[i - 1].top);
    expect(previousEnd - slices[i].top).toBeGreaterThanOrEqual(IMAGE_SLICE_OVERLAP);
  }
};

describe('planImageSlices', () => {
  it('макет письма владельца 2512×23050: ширина 1536, 8 кусков по 2048, перекрытие ≥64', () => {
    const plan = planImageSlices(OWNER_JPEG.width, OWNER_JPEG.height);

    expect(plan.width).toBe(IMAGE_MAX_WIDTH);
    expect(plan.height).toBe(Math.round((OWNER_JPEG.height * 1536) / OWNER_JPEG.width));
    expect(plan.slices).toHaveLength(8);
    expect(plan.slices.every((slice) => slice.height === IMAGE_SLICE_HEIGHT)).toBe(true);
    expectCovering(plan);
  });

  it.each([
    ['фото 4000×3000', 4000, 3000, 1536, 1152],
    ['скриншот 1920×1080', 1920, 1080, 1536, 864],
    ['экран телефона 1170×2532 (без увеличения и без нарезки)', 1170, 2532, 1170, 2532],
    ['длинный экран 1290×2796', 1290, 2796, 1290, 2796],
    ['маленькая 800×600', 800, 600, 800, 600],
    ['страница A4 при ширине 1536 (1536×2172)', 1536, 2172, 1536, 2172],
  ])('%s — одна картинка', (_, width, height, expectedWidth, expectedHeight) => {
    const plan = planImageSlices(width, height);
    expect(plan.slices).toEqual([{ height: expectedHeight, top: 0 }]);
    expect(plan.width).toBe(expectedWidth);
    expect(plan.height).toBe(expectedHeight);
  });

  it('порог нарезки: высота после сжатия по ширине не больше SINGLE_MAX — одна, выше — куски', () => {
    expect(planImageSlices(1536, IMAGE_SINGLE_MAX_HEIGHT).slices).toHaveLength(1);
    const above = planImageSlices(1536, IMAGE_SINGLE_MAX_HEIGHT + 1);
    expect(above.slices).toHaveLength(2);
    expectCovering(above);
  });

  it('куски не больше 12: не хватило — ширина уменьшается, но не ниже 768', () => {
    // 1000×40000: при ширине 1000 было бы 21 кусок
    const plan = planImageSlices(1000, 40_000);
    expect(plan.slices.length).toBeLessThanOrEqual(IMAGE_MAX_SLICES);
    expect(plan.width).toBeLessThan(1000);
    expect(plan.width).toBeGreaterThanOrEqual(768);
    expectCovering(plan);

    // втрое длиннее макета владельца: при 1536 вышло бы 13 кусков, при 1280 — 11
    const longer = planImageSlices(2512, 42_000);
    expect(longer.width).toBe(1280);
    expect(longer.slices).toHaveLength(11);
    expectCovering(longer);
  });

  it('и на ширине 768 не хватило — куски выше 2048, но ровно 12 и без потери содержимого', () => {
    const plan = planImageSlices(768, 60_000);
    expect(plan.width).toBe(768);
    expect(plan.slices).toHaveLength(IMAGE_MAX_SLICES);
    expect(plan.slices[0].height).toBeGreaterThan(IMAGE_SLICE_HEIGHT);
    expectCovering(plan);
  });

  it('узкая картинка не растягивается: ширина меньше 768 остаётся своей', () => {
    const plan = planImageSlices(500, 30_000);
    expect(plan.width).toBe(500);
    expect(plan.slices.length).toBeLessThanOrEqual(IMAGE_MAX_SLICES);
    expectCovering(plan);
  });

  it('maxSlices меньше — режет реже, уменьшая ширину (так делит предел PDF между страницами)', () => {
    const wide = planImageSlices(2512, OWNER_JPEG.height, 12);
    const tight = planImageSlices(2512, OWNER_JPEG.height, 3);
    expect(tight.slices.length).toBeLessThanOrEqual(3);
    expect(tight.width).toBeLessThan(wide.width);
    expectCovering(tight);
    expect(planImageSlices(2512, OWNER_JPEG.height, 1).slices).toHaveLength(1);
  });
});

/** Холст с горизонтальными полосами: полоса k залита цветом (k*10, 200-k*10, 128). */
const bandedJpeg = async (width: number, height: number, bandHeight: number) => {
  const bands = Math.ceil(height / bandHeight);
  const rects = Array.from({ length: bands }, (_, k) => {
    const y = k * bandHeight;
    return `<rect x="0" y="${y}" width="${width}" height="${Math.min(bandHeight, height - y)}" fill="rgb(${k * 10},${200 - k * 10},128)"/>`;
  }).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${rects}</svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 95 }).toBuffer();
};

const rawPixel = async (buffer: Buffer, x: number, y: number) => {
  const { data, info } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
  const offset = (y * info.width + x) * info.channels;
  return [data[offset], data[offset + 1], data[offset + 2]];
};

describe('prepareImageForModel', () => {
  it('макет 2512×23050 (как у владельца): 8 кусков 1536×2048 сверху вниз, содержимое по порядку', async () => {
    const bandHeight = 1000;
    const source = await bandedJpeg(OWNER_JPEG.width, OWNER_JPEG.height, bandHeight);
    const plan = planImageSlices(OWNER_JPEG.width, OWNER_JPEG.height);
    const scale = plan.width / OWNER_JPEG.width;

    const result = await prepareImageForModel(source, 'image/jpeg');

    expect(result.sliced).toBe(true);
    expect(result.unchanged).toBe(false);
    expect(result.parts).toHaveLength(8);
    for (const [index, part] of result.parts.entries()) {
      expect(part.width).toBe(1536);
      expect(part.height).toBe(2048);
      expect(part.mimeType).toBe('image/png');
      expect(part.buffer.length).toBeLessThanOrEqual(IMAGE_MAX_BYTES);
      const meta = await sharp(part.buffer).metadata();
      expect([meta.width, meta.height]).toEqual([1536, 2048]);

      // порядок: середина куска приходится на ту полосу исходника, которая ожидается по плану
      const slice = plan.slices[index];
      const expectedBand = Math.floor((slice.top + slice.height / 2) / scale / bandHeight);
      const [red] = await rawPixel(part.buffer, 20, 1024);
      expect(Math.round(red / 10)).toBe(expectedBand);
    }

    // перекрытие: нижние строки куска i — это верхние строки куска i+1
    for (let i = 0; i < result.parts.length - 1; i++) {
      const overlap = plan.slices[i].top + plan.slices[i].height - plan.slices[i + 1].top;
      expect(overlap).toBeGreaterThanOrEqual(IMAGE_SLICE_OVERLAP);
      const lower = await sharp(result.parts[i].buffer)
        .extract({ height: IMAGE_SLICE_OVERLAP, left: 0, top: 2048 - overlap, width: 1536 })
        .raw()
        .toBuffer();
      const upper = await sharp(result.parts[i + 1].buffer)
        .extract({ height: IMAGE_SLICE_OVERLAP, left: 0, top: 0, width: 1536 })
        .raw()
        .toBuffer();
      expect(lower.equals(upper)).toBe(true);
    }
  }, 60_000);

  it('вес кусков: плоская графика остаётся лёгким PNG, фото-куски идут JPEG не тяжелее ~1 МБ (запрос Gemini ≤20 МБ)', async () => {
    // «фото»: плавный градиент с шумом — PNG такого куска тяжелее целевого веса
    const width = 1600;
    const height = 6500;
    const pixels = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const at = (y * width + x) * 3;
        const noise = Math.floor(Math.random() * 40);
        pixels[at] = ((x / width) * 200 + noise) % 256;
        pixels[at + 1] = ((y / height) * 200 + noise) % 256;
        pixels[at + 2] = (100 + noise) % 256;
      }
    }
    const photo = await sharp(pixels, { raw: { channels: 3, height, width } })
      .png()
      .toBuffer();

    const photoParts = await prepareImageForModel(photo, 'image/png');
    expect(photoParts.parts.length).toBeGreaterThan(1);
    for (const part of photoParts.parts) {
      expect(part.mimeType).toBe('image/jpeg');
      expect(part.buffer.length).toBeLessThanOrEqual(IMAGE_PART_TARGET_BYTES * 1.3);
    }

    // «текст»: плоский фон с несколькими полосами — PNG остаётся лёгким
    const flat = await bandedJpeg(1600, 6500, 500);
    const flatParts = await prepareImageForModel(flat, 'image/jpeg');
    expect(flatParts.parts.length).toBeGreaterThan(1);
    for (const part of flatParts.parts) {
      expect(part.mimeType).toBe('image/png');
      expect(part.buffer.length).toBeLessThanOrEqual(IMAGE_PART_TARGET_BYTES);
    }
  }, 120_000);

  it('обычное фото в пределах — тот же файл без изменений, одна картинка', async () => {
    const photo = await sharp({
      create: { background: '#336699', channels: 3, height: 900, width: 1200 },
    })
      .jpeg()
      .toBuffer();

    const result = await prepareImageForModel(photo, 'image/jpeg');

    expect(result.sliced).toBe(false);
    expect(result.unchanged).toBe(true);
    expect(result.parts).toHaveLength(1);
    expect(result.parts[0].buffer).toBe(photo);
    expect(result.parts[0].mimeType).toBe('image/jpeg');
  });

  it('большое фото 4000×3000 — одна картинка шириной 1536, PNG', async () => {
    const photo = await sharp({
      create: { background: '#aa5522', channels: 3, height: 3000, width: 4000 },
    })
      .jpeg()
      .toBuffer();

    const result = await prepareImageForModel(photo, 'image/jpeg');

    expect(result.sliced).toBe(false);
    expect(result.unchanged).toBe(false);
    expect(result.parts).toHaveLength(1);
    expect([result.parts[0].width, result.parts[0].height]).toEqual([1536, 1152]);
    expect(result.parts[0].mimeType).toBe('image/png');
  });

  it('экран телефона 1170×2532 остаётся одной картинкой без изменения размера', async () => {
    const shot = await sharp({
      create: { background: '#ffffff', channels: 3, height: 2532, width: 1170 },
    })
      .png()
      .toBuffer();
    const result = await prepareImageForModel(shot, 'image/png');
    expect(result.parts).toHaveLength(1);
    expect(result.unchanged).toBe(true);
  });

  it('поворот по EXIF учитывается: 3000×2000 с ориентацией 6 — это 2000×3000, одна картинка 1536×2304', async () => {
    const rotated = await sharp({
      create: { background: '#228855', channels: 3, height: 2000, width: 3000 },
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();

    const result = await prepareImageForModel(rotated, 'image/jpeg');

    expect(result.parts).toHaveLength(1);
    expect([result.parts[0].width, result.parts[0].height]).toEqual([1536, 2304]);
  });

  it('тяжёлый кусок (шум) не превышает 5 МБ: PNG заменяется JPEG', async () => {
    const noise = await sharp(randomBytes(1700 * 1700 * 3), {
      raw: { channels: 3, height: 1700, width: 1700 },
    })
      .png()
      .toBuffer();

    const result = await prepareImageForModel(noise, 'image/png');

    expect(result.parts).toHaveLength(1);
    expect(result.parts[0].buffer.length).toBeLessThanOrEqual(IMAGE_MAX_BYTES);
    expect(result.parts[0].mimeType).toBe('image/jpeg');
  }, 60_000);

  it('нечитаемый файл — исходные байты как есть, без исключения', async () => {
    const junk = Buffer.from('это не картинка');
    const result = await prepareImageForModel(junk, 'image/png');
    expect(result.unchanged).toBe(true);
    expect(result.parts).toHaveLength(1);
    expect(result.parts[0].buffer).toBe(junk);
  });
});
