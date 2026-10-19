import debug from 'debug';
import sharp from 'sharp';

const log = debug('lobe-server:image-slicing');

/**
 * arckep (19.10.2026): подготовка картинок для модели со зрением.
 *
 * Раньше любая картинка сжималась до 1920 px по длинной стороне. Длинный макет письма 2512×23050 превращался
 * в 209×1920 — текст не читался. Теперь:
 * - ширина ≤ 1536 px без увеличения;
 * - если высота после этого не больше SINGLE_MAX_HEIGHT — одна картинка (фото, скриншоты, экраны телефонов);
 * - иначе картинка режется на вертикальные куски до SLICE_HEIGHT с небольшим перекрытием, сверху вниз,
 *   не больше MAX_SLICES кусков; не хватило — ширина уменьшается, но не ниже MIN_WIDTH; и тогда не хватило —
 *   куски становятся выше SLICE_HEIGHT (содержимое не теряется).
 */

export const IMAGE_MAX_WIDTH = 1536;
export const IMAGE_MIN_WIDTH = 768;
export const IMAGE_SLICE_HEIGHT = 2048;
export const IMAGE_SLICE_OVERLAP = 64;
/** Выше этого (после сжатия по ширине) картинка режется на куски; обычные экраны телефонов (до ~2:1) — нет. */
export const IMAGE_SINGLE_MAX_HEIGHT = 3072;
export const IMAGE_MAX_SLICES = 12;
/**
 * Потолок высоты картинки после сжатия по ширине. Резка держит в памяти всю сжатую картинку (сырые пиксели,
 * ширина × высота × 3 байта), поэтому её размер ограничен: ≤ ширина 1536 × 30000 × 3 ≈ 138 МБ. Выше (пропорция
 * около 40:1 и круче — не макеты, а полосы) картинка не режется, а сжимается целиком, как раньше (≤1920).
 */
export const IMAGE_MAX_TOTAL_HEIGHT = 30_000;
/** Прежний предел для картинок, которые не режутся. */
const LEGACY_MAX_SIZE = 1920;
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
/**
 * Целевой вес одного куска длинной картинки. Gemini принимает картинки в запросе целиком (inline, до 20 МБ на весь
 * запрос вместе с base64): 8–12 кусков по 5 МБ его бы не уместили. Куски текста в PNG и так лёгкие,
 * фото-куски идут в JPEG.
 */
export const IMAGE_PART_TARGET_BYTES = 1024 * 1024;

/** Ширины, которые пробуем по порядку, пока куски не уложатся в предел. */
const WIDTH_STEPS = [1536, 1280, 1024, 896, 768];

export interface ImageSlice {
  height: number;
  top: number;
}

export interface ImageSlicePlan {
  /** Высота всей картинки после сжатия по ширине */
  height: number;
  slices: ImageSlice[];
  /** Ширина после сжатия */
  width: number;
}

const sliceCount = (height: number) =>
  height <= IMAGE_SINGLE_MAX_HEIGHT
    ? 1
    : Math.ceil((height - IMAGE_SLICE_OVERLAP) / (IMAGE_SLICE_HEIGHT - IMAGE_SLICE_OVERLAP));

/** Куски одинаковой высоты `sliceHeight`, равномерно по всей высоте (перекрытие не меньше OVERLAP). */
const evenSlices = (height: number, count: number, sliceHeight: number): ImageSlice[] => {
  if (count === 1) return [{ height, top: 0 }];
  return Array.from({ length: count }, (_, index) => ({
    height: sliceHeight,
    top: Math.round((index * (height - sliceHeight)) / (count - 1)),
  }));
};

/**
 * План нарезки по размерам исходной картинки. Чистая функция: не трогает пиксели.
 * @param maxSlices сколько кусков можно (по умолчанию IMAGE_MAX_SLICES; PDF делит предел между страницами)
 */
export const planImageSlices = (
  sourceWidth: number,
  sourceHeight: number,
  maxSlices: number = IMAGE_MAX_SLICES,
): ImageSlicePlan => {
  const scaled = (width: number) => Math.max(1, Math.round((sourceHeight * width) / sourceWidth));

  // Ширина: не больше 1536, без увеличения; нижний предел 768 (или сама ширина, если она меньше)
  const widest = Math.min(sourceWidth, IMAGE_MAX_WIDTH);
  const narrowest = Math.min(sourceWidth, IMAGE_MIN_WIDTH);
  const widths = [
    ...new Set([
      widest,
      ...WIDTH_STEPS.filter((step) => step < widest && step >= narrowest),
      narrowest,
    ]),
  ].sort((a, b) => b - a);

  for (const width of widths) {
    const height = scaled(width);
    const count = sliceCount(height);
    if (count <= maxSlices) {
      return { height, slices: evenSlices(height, count, IMAGE_SLICE_HEIGHT), width };
    }
  }

  // Даже на самой узкой ширине не уложились: делим на maxSlices кусков, каждый выше SLICE_HEIGHT.
  const width = widths.at(-1)!;
  const height = scaled(width);
  const count = Math.max(1, maxSlices);
  const sliceHeight = Math.ceil((height + (count - 1) * IMAGE_SLICE_OVERLAP) / count);
  return { height, slices: evenSlices(height, count, Math.min(sliceHeight, height)), width };
};

export interface PreparedImage {
  buffer: Buffer;
  height: number;
  mimeType: string;
  width: number;
}

export interface PreparedImages {
  /** Куски сверху вниз; одна картинка — один элемент */
  parts: PreparedImage[];
  /** Картинка резалась на куски (parts.length > 1) */
  sliced: boolean;
  /** Исходная картинка не менялась */
  unchanged: boolean;
}

/** Размеры с учётом поворота по EXIF (ориентации 5–8 меняют ширину и высоту местами). */
const orientedSize = (meta: sharp.Metadata) => {
  const swap = (meta.orientation ?? 1) >= 5;
  const width = (swap ? meta.height : meta.width) ?? 0;
  const height = (swap ? meta.width : meta.height) ?? 0;
  return { height, width };
};

/**
 * PNG; тяжелее `targetBytes` — JPEG (4:4:4, чтобы текст не расплывался; прозрачность заливается белым) по лестнице
 * качества, пока не влезет, и берётся то, что меньше. Текст и плоская графика в PNG лёгкие, фото-куски — тяжёлые.
 */
const encode = async (
  pipeline: sharp.Sharp,
  targetBytes: number,
): Promise<{ buffer: Buffer; mimeType: string }> => {
  const png = await pipeline.clone().png().toBuffer();
  if (png.length <= targetBytes) return { buffer: png, mimeType: 'image/png' };

  let best = { buffer: png, mimeType: 'image/png' };
  for (const quality of [90, 82, 74, 66, 55]) {
    const jpeg = await pipeline
      .clone()
      .flatten({ background: '#ffffff' })
      .jpeg({ chromaSubsampling: '4:4:4', quality })
      .toBuffer();
    if (jpeg.length < best.buffer.length) best = { buffer: jpeg, mimeType: 'image/jpeg' };
    if (jpeg.length <= targetBytes) break;
  }
  return best;
};

/**
 * Картинка → один или несколько кусков для модели. Не удалось прочитать — исходный файл как есть
 * (как и раньше: сжатие не должно ронять отправку).
 */
export const prepareImageForModel = async (
  buffer: Buffer,
  mimeType: string,
  options: {
    /** Предел веса одного файла: у цельной картинки по умолчанию IMAGE_MAX_BYTES, у кусков — IMAGE_PART_TARGET_BYTES */
    maxBytes?: number;
    maxSlices?: number;
  } = {},
): Promise<PreparedImages> => {
  try {
    const meta = await sharp(buffer, { failOn: 'none' }).metadata();
    const { width, height } = orientedSize(meta);
    if (!width || !height) throw new Error('image size is unknown');

    let plan = planImageSlices(width, height, options.maxSlices);
    // Слишком вытянутая картинка: не режем (иначе сжатая копия в памяти огромна), а сжимаем целиком, как раньше
    const legacy = plan.height > IMAGE_MAX_TOTAL_HEIGHT;
    if (legacy) {
      const factor = Math.min(1, LEGACY_MAX_SIZE / Math.max(width, height));
      plan = {
        height: Math.max(1, Math.round(height * factor)),
        slices: [{ height: Math.max(1, Math.round(height * factor)), top: 0 }],
        width: Math.max(1, Math.round(width * factor)),
      };
    }
    const single = plan.slices.length === 1;
    const singleBytes = options.maxBytes ?? IMAGE_MAX_BYTES;
    const partBytes = options.maxBytes ?? IMAGE_PART_TARGET_BYTES;

    // Обычная картинка в пределах: исходный файл не трогаем
    if (
      single &&
      width <= IMAGE_MAX_WIDTH &&
      height <= IMAGE_SINGLE_MAX_HEIGHT &&
      buffer.length <= singleBytes
    ) {
      return { parts: [{ buffer, height, mimeType, width }], sliced: false, unchanged: true };
    }

    const base = () =>
      sharp(buffer, { failOn: 'none' })
        .rotate()
        .resize({
          kernel: 'lanczos3',
          width: plan.width,
          // сжатие целиком (вытянутая картинка): строго в рамку, как раньше
          ...(legacy ? { fit: 'inside' as const, height: plan.height } : {}),
          withoutEnlargement: true,
        });

    if (single) {
      // Один кусок, но надо сжать: по ширине, затем (если тяжелее 5 МБ) сильнее, как раньше
      let pipeline = base();
      let result = await encode(pipeline, singleBytes);
      let scale = 1;
      while (result.buffer.length > singleBytes && scale > 0.25) {
        scale *= 0.8;
        pipeline = sharp(buffer, { failOn: 'none' })
          .rotate()
          .resize({
            width: Math.max(64, Math.round(plan.width * scale)),
            withoutEnlargement: true,
          });
        result = await encode(pipeline, singleBytes);
      }
      const out = await sharp(result.buffer).metadata();
      log(
        'single image %dx%d (%d bytes) → %dx%d (%d bytes)',
        width,
        height,
        buffer.length,
        out.width,
        out.height,
        result.buffer.length,
      );
      return {
        parts: [{ ...result, height: out.height ?? plan.height, width: out.width ?? plan.width }],
        sliced: false,
        unchanged: false,
      };
    }

    // Нарезка: один раз сжимаем по ширине в сырые пиксели, дальше вырезаем куски без повторного разбора
    const { data, info } = await base()
      .flatten({ background: '#ffffff' })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const parts: PreparedImage[] = [];
    for (const slice of plan.slices) {
      const height = Math.min(slice.height, info.height - slice.top);
      const encoded = await encode(
        sharp(data, {
          raw: { channels: info.channels, height: info.height, width: info.width },
        }).extract({ height, left: 0, top: slice.top, width: info.width }),
        partBytes,
      );
      parts.push({ ...encoded, height, width: info.width });
    }

    log(
      'sliced image %dx%d (%d bytes) → %d parts %dx%d',
      width,
      height,
      buffer.length,
      parts.length,
      info.width,
      info.height,
    );
    return { parts, sliced: true, unchanged: false };
  } catch (error) {
    log('image preparation failed, using the original: %s', error);
    return {
      parts: [{ buffer, height: 0, mimeType, width: 0 }],
      sliced: false,
      unchanged: true,
    };
  }
};
