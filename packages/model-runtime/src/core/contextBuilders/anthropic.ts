import type * as CryptoModule from 'node:crypto';

import type Anthropic from '@anthropic-ai/sdk';
import { imageUrlToBase64 } from '@lobechat/utils';
import type OpenAI from 'openai';

import type { OpenAIChatMessage, UserMessageContentPart } from '../../types';
import { parseDataUri } from '../../utils/uriParser';

type AnthropicMediaType = Anthropic.Base64ImageSource['media_type'];

export const ANTHROPIC_MAX_IMAGE_BASE64_CHARS = 5 * 1024 * 1024;
export const ANTHROPIC_MAX_IMAGE_DIMENSION = 8000;
export const ANTHROPIC_MANY_IMAGES_THRESHOLD = 20;
export const ANTHROPIC_MANY_IMAGES_MAX_DIMENSION = 2000;
export const MAX_CONCURRENT_IMAGE_LOADS = 6;

const NORMALIZED_IMAGE_CACHE_MAX_ENTRIES = 32;
const NORMALIZED_IMAGE_CACHE_MAX_BYTES = 32 * 1024 * 1024;

const ANTHROPIC_NATIVE_IMAGE_TYPES = new Set<AnthropicMediaType>([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

const SERVER_CONVERTIBLE_IMAGE_TYPES = new Set([
  'image/avif',
  'image/bmp',
  'image/heic',
  'image/heif',
  'image/tiff',
]);

const GENERIC_BINARY_MIMES = new Set(['application/octet-stream', 'binary/octet-stream']);

const IMAGE_MIME_ALIASES: Record<string, string> = {
  'image/jfif': 'image/jpeg',
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'image/tif': 'image/tiff',
  'image/x-bmp': 'image/bmp',
  'image/x-ms-bmp': 'image/bmp',
  'image/x-png': 'image/png',
  'image/x-tiff': 'image/tiff',
  'image/x-webp': 'image/webp',
};

const VALID_BMP_DIB_HEADER_SIZES = new Set([12, 40, 52, 56, 108, 124]);

interface NormalizedImageEntry {
  data: string;
  mediaType: AnthropicMediaType;
  size: number;
}

type SharpPipeline = {
  jpeg: (opts?: { mozjpeg?: boolean; quality?: number }) => SharpPipeline;
  metadata: () => Promise<{ hasAlpha?: boolean; height?: number; width?: number }>;
  png: (opts?: { compressionLevel?: number }) => SharpPipeline;
  resize: (opts?: {
    fit?: 'inside';
    height?: number;
    width?: number;
    withoutEnlargement?: boolean;
  }) => SharpPipeline;
  rotate: () => SharpPipeline;
  toBuffer: () => Promise<Buffer>;
  webp: (opts?: { quality?: number }) => SharpPipeline;
};

type SharpInputOptions = {
  failOn?: 'none';
  limitInputPixels?: boolean | number;
  raw?: { channels: 3 | 4; height: number; width: number };
};

type SharpFactory = (input: Buffer, options?: SharpInputOptions) => SharpPipeline;

const decodeUncompressedBmpToRaw = (
  buf: Buffer,
): { channels: 3 | 4; data: Buffer; height: number; width: number } | null => {
  if (buf.length < 54 || buf[0] !== 0x42 || buf[1] !== 0x4d) return null;
  const pixelOffset = buf.readUInt32LE(10);
  const dibSize = buf.readUInt32LE(14);
  if (dibSize < 40) return null;

  const width = buf.readInt32LE(18);
  const rawHeight = buf.readInt32LE(22);
  const topDown = rawHeight < 0;
  const height = Math.abs(rawHeight);
  const bpp = buf.readUInt16LE(28);
  const compression = buf.readUInt32LE(30);

  if (width <= 0 || height <= 0 || width * height > 64_000_000) return null;
  if ((bpp !== 24 && bpp !== 32) || (compression !== 0 && !(bpp === 32 && compression === 3))) {
    return null;
  }

  const rowStride = Math.floor((bpp * width + 31) / 32) * 4;
  if (pixelOffset + rowStride * height > buf.length) return null;

  const channels: 3 | 4 = bpp === 32 ? 4 : 3;
  const bytesPerPixel = bpp / 8;
  const out = Buffer.allocUnsafe(width * height * channels);

  for (let y = 0; y < height; y++) {
    const srcRow = topDown ? y : height - 1 - y;
    const srcRowStart = pixelOffset + srcRow * rowStride;
    const dstRowStart = y * width * channels;
    for (let x = 0; x < width; x++) {
      const s = srcRowStart + x * bytesPerPixel;
      const d = dstRowStart + x * channels;
      out[d] = buf[s + 2]; // R
      out[d + 1] = buf[s + 1]; // G
      out[d + 2] = buf[s]; // B
      if (channels === 4) {
        out[d + 3] = buf[s + 3]; // A
      }
    }
  }

  return { channels, data: out, height, width };
};

const normalizedImageCache = new Map<string, NormalizedImageEntry>();
let normalizedImageCacheBytes = 0;

let cachedSharpPromise: Promise<SharpFactory | null> | null = null;
let cachedCryptoPromise: Promise<typeof CryptoModule | null> | null = null;

export const clearAnthropicImageCacheForTest = (): void => {
  normalizedImageCache.clear();
  normalizedImageCacheBytes = 0;
};

const loadNodeCrypto = async (): Promise<typeof CryptoModule | null> => {
  if (typeof window !== 'undefined' || typeof process === 'undefined') return null;
  if (!cachedCryptoPromise) {
    cachedCryptoPromise = (async () => {
      const getBuiltinModule = (
        process as unknown as { getBuiltinModule?: (id: string) => unknown }
      ).getBuiltinModule;
      if (typeof getBuiltinModule === 'function') {
        const mod = getBuiltinModule('node:crypto') as typeof CryptoModule | undefined;
        if (mod) return mod;
      }
      try {
        const spec = ['node', 'crypto'].join(':');
        const mod = (await import(/* webpackIgnore: true */ spec)) as typeof CryptoModule & {
          default?: typeof CryptoModule;
        };
        return mod.default ?? mod;
      } catch {
        return null;
      }
    })();
  }
  return cachedCryptoPromise;
};

const loadSharp = async (): Promise<SharpFactory | null> => {
  if (typeof window !== 'undefined' || typeof process === 'undefined') return null;

  if (!cachedSharpPromise) {
    cachedSharpPromise = (async () => {
      const sharpName = ['sh', 'arp'].join('');
      const getBuiltinModule = (
        process as unknown as { getBuiltinModule?: (id: string) => unknown }
      ).getBuiltinModule;

      if (typeof getBuiltinModule === 'function') {
        const nodeModule = getBuiltinModule('node:module') as
          { createRequire?: (filename: string) => NodeRequire } | undefined;
        if (typeof nodeModule?.createRequire === 'function') {
          try {
            const req = nodeModule.createRequire(`${process.cwd()}/package.json`);
            const loaded = req(sharpName);
            return (loaded?.default ?? loaded) as SharpFactory;
          } catch {
            // Fall through to dynamic import fallback
          }
        }
      }

      try {
        const modSpec = ['node', 'module'].join(':');
        const nodeModule = (await import(/* webpackIgnore: true */ modSpec)) as {
          createRequire?: (filename: string) => NodeRequire;
          default?: { createRequire?: (filename: string) => NodeRequire };
        };
        const createReq = nodeModule.createRequire ?? nodeModule.default?.createRequire;
        if (typeof createReq === 'function') {
          const req = createReq(`${process.cwd()}/package.json`);
          const loaded = req(sharpName);
          return (loaded?.default ?? loaded) as SharpFactory;
        }
      } catch {
        // Fall through
      }

      try {
        const imported = await import(/* webpackIgnore: true */ sharpName);
        return (imported?.default ?? imported) as SharpFactory;
      } catch {
        return null;
      }
    })();
  }

  return cachedSharpPromise;
};

const normalizeMimeType = (mimeType: string | null | undefined): string | null => {
  if (!mimeType) return null;
  const cleaned = mimeType.split(';', 1)[0].trim().toLowerCase();
  if (!cleaned || GENERIC_BINARY_MIMES.has(cleaned)) return null;
  return IMAGE_MIME_ALIASES[cleaned] ?? cleaned;
};

const decodeBase64Bytes = (b64: string): Uint8Array => {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(b64, 'base64');
  }
  try {
    const normalized = b64.replaceAll(/\s+/g, '').replaceAll('-', '+').replaceAll('_', '/');
    const usableLen = normalized.length - (normalized.length % 4 === 1 ? 1 : 0);
    if (usableLen <= 0) return new Uint8Array(0);
    const padded =
      usableLen % 4 === 0
        ? normalized.slice(0, usableLen)
        : normalized.slice(0, usableLen) + '='.repeat(4 - (usableLen % 4));
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return new Uint8Array(0);
  }
};

const readU16BE = (buf: Uint8Array, offset: number): number =>
  ((buf[offset] << 8) | buf[offset + 1]) >>> 0;

const readU16LE = (buf: Uint8Array, offset: number): number =>
  (buf[offset] | (buf[offset + 1] << 8)) >>> 0;

const readU32BE = (buf: Uint8Array, offset: number): number =>
  (buf[offset] * 0x1_00_00_00 +
    ((buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3])) >>>
  0;

const readU32LE = (buf: Uint8Array, offset: number): number =>
  (buf[offset] |
    (buf[offset + 1] << 8) |
    (buf[offset + 2] << 16) |
    (buf[offset + 3] * 0x1_00_00_00)) >>>
  0;

const detectMagicMimeFromSample = (buf: Uint8Array): string | null => {
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return 'image/png';
  }

  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }

  if (
    buf.length >= 12 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return 'image/webp';
  }

  if (
    buf.length >= 6 &&
    buf[0] === 0x47 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x38 &&
    (buf[4] === 0x37 || buf[4] === 0x39) &&
    buf[5] === 0x61
  ) {
    return 'image/gif';
  }

  // TIFF (little-endian II*\0 or big-endian MM\0*)
  if (
    buf.length >= 4 &&
    ((buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a && buf[3] === 0x00) ||
      (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00 && buf[3] === 0x2a))
  ) {
    return 'image/tiff';
  }

  // BMP ('BM' + valid DIB header size at offset 14)
  if (buf.length >= 26 && buf[0] === 0x42 && buf[1] === 0x4d) {
    const dibSize = readU32LE(buf, 14);
    if (VALID_BMP_DIB_HEADER_SIZES.has(dibSize)) {
      return 'image/bmp';
    }
  }

  // ISO BMFF ('ftyp' at offset 4)
  if (
    buf.length >= 12 &&
    buf[4] === 0x66 &&
    buf[5] === 0x74 &&
    buf[6] === 0x79 &&
    buf[7] === 0x70
  ) {
    const brand = String.fromCharCode(buf[8], buf[9], buf[10], buf[11]);
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
    if (brand === 'heic' || brand === 'heix' || brand === 'hevc' || brand === 'hevx') {
      return 'image/heic';
    }
    if (brand === 'mif1' || brand === 'msf1' || brand === 'heif') return 'image/heif';
  }

  return null;
};

const parseJpegDimensions = (buf: Uint8Array): { height: number; width: number } | null => {
  let offset = 2;
  while (offset + 4 <= buf.length) {
    if (buf[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (offset < buf.length && buf[offset] === 0xff) {
      offset += 1;
    }
    if (offset >= buf.length) break;
    const marker = buf[offset];
    offset += 1;

    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) {
      break;
    }
    if (offset + 2 > buf.length) break;
    const segLen = readU16BE(buf, offset);
    if (segLen < 2) break;

    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (offset + 7 <= buf.length) {
        const height = readU16BE(buf, offset + 3);
        const width = readU16BE(buf, offset + 5);
        if (width > 0 && height > 0) return { height, width };
      }
      return null;
    }

    offset += segLen;
  }
  return null;
};

const readRasterDimensions = (
  base64: string,
  sample: Uint8Array,
  mimeType: AnthropicMediaType,
): { height: number; width: number } | null => {
  if (mimeType === 'image/png') {
    if (
      sample.length >= 24 &&
      sample[12] === 0x49 &&
      sample[13] === 0x48 &&
      sample[14] === 0x44 &&
      sample[15] === 0x52
    ) {
      const width = readU32BE(sample, 16);
      const height = readU32BE(sample, 20);
      return width > 0 && height > 0 ? { height, width } : null;
    }
    return null;
  }

  if (mimeType === 'image/gif') {
    if (sample.length >= 10) {
      const width = readU16LE(sample, 6);
      const height = readU16LE(sample, 8);
      return width > 0 && height > 0 ? { height, width } : null;
    }
    return null;
  }

  if (mimeType === 'image/webp') {
    if (sample.length >= 30 && sample[12] === 0x56 && sample[13] === 0x50 && sample[14] === 0x38) {
      const chunkByte3 = sample[15];
      // 'VP8 '
      if (
        chunkByte3 === 0x20 &&
        sample[23] === 0x9d &&
        sample[24] === 0x01 &&
        sample[25] === 0x2a
      ) {
        return {
          height: readU16LE(sample, 28) & 0x3fff,
          width: readU16LE(sample, 26) & 0x3fff,
        };
      }
      // 'VP8L'
      if (chunkByte3 === 0x4c && sample[20] === 0x2f) {
        const bits = readU32LE(sample, 21);
        return {
          height: ((bits >>> 14) & 0x3fff) + 1,
          width: (bits & 0x3fff) + 1,
        };
      }
      // 'VP8X'
      if (chunkByte3 === 0x58) {
        const width = 1 + (sample[24] | (sample[25] << 8) | (sample[26] << 16));
        const height = 1 + (sample[27] | (sample[28] << 8) | (sample[29] << 16));
        return { height, width };
      }
    }
    return null;
  }

  if (mimeType === 'image/jpeg') {
    // Check small prefix first (handles JPEGs without huge EXIF), then 96 KB slice, then full buffer
    const fromSample = parseJpegDimensions(sample);
    if (fromSample) return fromSample;
    const mediumSlice = decodeBase64Bytes(base64.slice(0, 131_072));
    const fromMedium = parseJpegDimensions(mediumSlice);
    if (fromMedium || base64.length <= 131_072) return fromMedium;
    return parseJpegDimensions(decodeBase64Bytes(base64));
  }

  return null;
};

const getNormalizedCachedImage = (key: string): NormalizedImageEntry | null => {
  const entry = normalizedImageCache.get(key);
  if (!entry) return null;
  normalizedImageCache.delete(key);
  normalizedImageCache.set(key, entry);
  return entry;
};

const setNormalizedCachedImage = (
  key: string,
  data: string,
  mediaType: AnthropicMediaType,
): void => {
  const size = data.length;
  if (size === 0 || size > NORMALIZED_IMAGE_CACHE_MAX_BYTES) return;

  const existing = normalizedImageCache.get(key);
  if (existing) {
    normalizedImageCache.delete(key);
    normalizedImageCacheBytes = Math.max(0, normalizedImageCacheBytes - existing.size);
  }

  while (
    normalizedImageCache.size >= NORMALIZED_IMAGE_CACHE_MAX_ENTRIES ||
    normalizedImageCacheBytes + size > NORMALIZED_IMAGE_CACHE_MAX_BYTES
  ) {
    const oldestKey = normalizedImageCache.keys().next().value;
    if (oldestKey === undefined) break;
    const oldest = normalizedImageCache.get(oldestKey);
    normalizedImageCache.delete(oldestKey);
    if (oldest) {
      normalizedImageCacheBytes = Math.max(0, normalizedImageCacheBytes - oldest.size);
    }
  }

  normalizedImageCache.set(key, { data, mediaType, size });
  normalizedImageCacheBytes += size;
};

const transformImageOnServer = async (
  base64: string,
  detectedMime: string,
  maxDimension: number,
): Promise<{ data: string; mediaType: AnthropicMediaType } | undefined> => {
  const [sharp, crypto] = await Promise.all([loadSharp(), loadNodeCrypto()]);
  if (!sharp) return undefined;

  let cacheKey: string | null = null;
  if (crypto) {
    const digest = crypto.createHash('sha256').update(base64).digest('hex');
    cacheKey = `${maxDimension}:${detectedMime}:${digest}`;
    const cached = getNormalizedCachedImage(cacheKey);
    if (cached) {
      return { data: cached.data, mediaType: cached.mediaType };
    }
  }

  try {
    const inputBuffer = Buffer.from(base64, 'base64');
    let sharpInput: Buffer = inputBuffer;
    let sharpOptions: SharpInputOptions = { failOn: 'none', limitInputPixels: false };
    let metadata: { hasAlpha?: boolean; height?: number; width?: number };

    try {
      metadata = await sharp(sharpInput, sharpOptions).metadata();
    } catch (metaErr) {
      if (detectedMime === 'image/bmp') {
        const decodedBmp = decodeUncompressedBmpToRaw(inputBuffer);
        if (!decodedBmp) throw metaErr;
        sharpInput = decodedBmp.data;
        sharpOptions = {
          limitInputPixels: false,
          raw: {
            channels: decodedBmp.channels,
            height: decodedBmp.height,
            width: decodedBmp.width,
          },
        };
        metadata = {
          hasAlpha: decodedBmp.channels === 4,
          height: decodedBmp.height,
          width: decodedBmp.width,
        };
      } else {
        throw metaErr;
      }
    }

    const hasAlpha = Boolean(metadata.hasAlpha);
    const fitsDim =
      (!metadata.width || metadata.width <= maxDimension) &&
      (!metadata.height || metadata.height <= maxDimension);

    // Pure format conversion (e.g. AVIF / BMP / TIFF / HEIC) when dimensions fit: try lossless PNG first
    if (SERVER_CONVERTIBLE_IMAGE_TYPES.has(detectedMime) && fitsDim) {
      const pngBuffer = await sharp(sharpInput, sharpOptions)
        .rotate()
        .png({ compressionLevel: 8 })
        .toBuffer();
      const pngBase64 = pngBuffer.toString('base64');
      if (pngBase64.length <= ANTHROPIC_MAX_IMAGE_BASE64_CHARS) {
        if (cacheKey) setNormalizedCachedImage(cacheKey, pngBase64, 'image/png');
        return { data: pngBase64, mediaType: 'image/png' };
      }
    }

    const rawSteps: Array<[number, number]> = [
      [maxDimension, 86],
      [Math.min(maxDimension, 4096), 82],
      [Math.min(maxDimension, 3072), 78],
      [Math.min(maxDimension, 2048), 74],
      [Math.min(maxDimension, 1568), 68],
      [Math.min(maxDimension, 1024), 58],
      [Math.min(maxDimension, 768), 48],
    ];

    const seenSteps = new Set<string>();
    for (const [dim, quality] of rawSteps) {
      const stepKey = `${dim}:${quality}`;
      if (seenSteps.has(stepKey)) continue;
      seenSteps.add(stepKey);

      let pipeline = sharp(sharpInput, sharpOptions).rotate().resize({
        fit: 'inside',
        height: dim,
        width: dim,
        withoutEnlargement: true,
      });

      const targetMime: AnthropicMediaType = hasAlpha ? 'image/webp' : 'image/jpeg';
      pipeline = hasAlpha ? pipeline.webp({ quality }) : pipeline.jpeg({ mozjpeg: true, quality });

      const outBuffer = await pipeline.toBuffer();
      const outBase64 = outBuffer.toString('base64');
      if (outBase64.length <= ANTHROPIC_MAX_IMAGE_BASE64_CHARS) {
        if (cacheKey) setNormalizedCachedImage(cacheKey, outBase64, targetMime);
        return { data: outBase64, mediaType: targetMime };
      }
    }

    return undefined;
  } catch {
    return undefined;
  }
};

const normalizeAnthropicImageBlock = async (
  rawBase64: string | null,
  rawMimeType: string | null,
  maxDimension = ANTHROPIC_MAX_IMAGE_DIMENSION,
): Promise<Anthropic.ImageBlockParam | undefined> => {
  if (!rawBase64) return undefined;
  const cleanBase64 = rawBase64.trim();
  if (!cleanBase64) return undefined;

  const headerSample = decodeBase64Bytes(cleanBase64.slice(0, 128));
  const magicMime = detectMagicMimeFromSample(headerSample);
  const normalizedHeaderMime = normalizeMimeType(rawMimeType);
  const effectiveMime = magicMime ?? normalizedHeaderMime;

  if (!effectiveMime) return undefined;
  if (effectiveMime === 'image/svg+xml') return undefined;

  const isNative = ANTHROPIC_NATIVE_IMAGE_TYPES.has(effectiveMime as AnthropicMediaType);
  const isConvertible = SERVER_CONVERTIBLE_IMAGE_TYPES.has(effectiveMime);
  if (!isNative && !isConvertible) {
    return undefined;
  }

  if (isNative && cleanBase64.length <= ANTHROPIC_MAX_IMAGE_BASE64_CHARS) {
    const nativeMime = effectiveMime as AnthropicMediaType;
    const dims = readRasterDimensions(cleanBase64, headerSample, nativeMime);
    const exceedsDimensions =
      dims !== null && (dims.width > maxDimension || dims.height > maxDimension);

    if (!exceedsDimensions) {
      return {
        source: {
          data: cleanBase64,
          media_type: nativeMime,
          type: 'base64',
        },
        type: 'image',
      };
    }
  }

  if (typeof window === 'undefined') {
    const transformed = await transformImageOnServer(cleanBase64, effectiveMime, maxDimension);
    if (!transformed) return undefined;
    return {
      source: {
        data: transformed.data,
        media_type: transformed.mediaType,
        type: 'base64',
      },
      type: 'image',
    };
  }

  if (isNative && cleanBase64.length <= ANTHROPIC_MAX_IMAGE_BASE64_CHARS) {
    return {
      source: {
        data: cleanBase64,
        media_type: effectiveMime as AnthropicMediaType,
        type: 'base64',
      },
      type: 'image',
    };
  }

  return undefined;
};

interface AnthropicBuildContext {
  loadImage: (url: string) => Promise<{ base64: string; mimeType: string }>;
  maxImageDimension: number;
  parsedUris: Map<UserMessageContentPart, ReturnType<typeof parseDataUri>>;
  signal?: AbortSignal;
}

/**
 * Check if a text value contains visible (non-whitespace) characters.
 * Used to filter out empty/whitespace-only messages that would cause Anthropic API errors.
 */
const hasVisibleText = (text: string | null | undefined): text is string => !!text?.trim();

export const buildAnthropicBlock = async (
  content: UserMessageContentPart,
  context?: AnthropicBuildContext,
): Promise<Anthropic.ContentBlock | Anthropic.ImageBlockParam | undefined> => {
  switch (content.type) {
    case 'thinking': {
      // Clone so downstream cache_control mutations never mutate caller's oaiMessages
      return { ...content } as any;
    }

    case 'text': {
      if (!!content.text) return { ...content } as any;

      return undefined;
    }

    case 'image_url': {
      const { mimeType, base64, type } =
        context?.parsedUris.get(content) ?? parseDataUri(content.image_url.url);
      const maxDim = context?.maxImageDimension ?? ANTHROPIC_MAX_IMAGE_DIMENSION;
      const incomingCacheControl = (
        content as { cache_control?: Anthropic.Messages.CacheControlEphemeral }
      ).cache_control;

      let imageBlock: Anthropic.ImageBlockParam | undefined;
      if (type === 'base64') {
        imageBlock = await normalizeAnthropicImageBlock(base64, mimeType, maxDim);
      } else if (type === 'url') {
        const { base64: urlBase64, mimeType: urlMimeType } = context
          ? await context.loadImage(content.image_url.url)
          : await imageUrlToBase64(content.image_url.url);

        imageBlock = await normalizeAnthropicImageBlock(urlBase64, urlMimeType || mimeType, maxDim);
      } else {
        throw new Error(`Invalid image URL: ${content.image_url.url}`);
      }

      if (imageBlock && incomingCacheControl) {
        return { ...imageBlock, cache_control: { ...incomingCacheControl } };
      }
      return imageBlock;
    }
  }
};

const buildArrayContent = async (
  content: UserMessageContentPart[],
  context?: AnthropicBuildContext,
) => {
  let messageContent = (await Promise.all(
    (content as UserMessageContentPart[]).map(async (c) => await buildAnthropicBlock(c, context)),
  )) as Anthropic.Messages.ContentBlockParam[];

  messageContent = messageContent.filter(Boolean);

  return messageContent;
};

/**
 * Build a single Anthropic tool_result block from an OpenAI tool message.
 * Returns undefined if tool_call_id is missing. Uses '<empty_content>' placeholder
 * when content is empty, as Anthropic requires non-empty tool_result content.
 */
const buildAnthropicToolResultBlock = async (
  message: Pick<OpenAIChatMessage, 'content' | 'tool_call_id'>,
  context?: AnthropicBuildContext,
): Promise<Anthropic.ToolResultBlockParam | undefined> => {
  if (!message.tool_call_id) return undefined;

  const toolResultContent = Array.isArray(message.content)
    ? await buildArrayContent(message.content, context)
    : hasVisibleText(message.content)
      ? [{ text: message.content, type: 'text' as const }]
      : [];

  return {
    content: (toolResultContent.length > 0
      ? toolResultContent
      : [
          { text: '<empty_content>', type: 'text' as const },
        ]) as Anthropic.ToolResultBlockParam['content'],
    tool_use_id: message.tool_call_id,
    type: 'tool_result',
  };
};

export const buildAnthropicMessage = async (
  message: OpenAIChatMessage,
  context?: AnthropicBuildContext,
): Promise<Anthropic.Messages.MessageParam | undefined> => {
  const content = message.content as string | UserMessageContentPart[];

  switch (message.role) {
    case 'system': {
      return {
        content: Array.isArray(content) ? content.map((c) => ({ ...c })) : (content as string),
        role: 'user',
      } as Anthropic.Messages.MessageParam;
    }

    case 'user': {
      // Filter out empty user messages to prevent Anthropic API validation errors.
      // Empty messages can appear after context truncation or user edits.
      if (Array.isArray(content)) {
        const messageContent = await buildArrayContent(content, context);
        if (messageContent.length === 0) return undefined;

        return {
          content: messageContent,
          role: 'user',
        };
      }

      if (!hasVisibleText(content)) return undefined;

      return {
        content,
        role: 'user',
      };
    }

    case 'tool': {
      // refs: https://docs.anthropic.com/claude/docs/tool-use#tool-use-and-tool-result-content-blocks
      return {
        content: [
          {
            content: message.content,
            tool_use_id: message.tool_call_id,
            type: 'tool_result',
          } as any,
        ],
        role: 'user',
      };
    }

    case 'assistant': {
      // if there is tool_calls , we need to covert the tool_calls to tool_use content block
      // refs: https://docs.anthropic.com/claude/docs/tool-use#tool-use-and-tool-result-content-blocks
      if (message.tool_calls && message.tool_calls.length > 0) {
        // Handle content: string with text, array, null/undefined/empty -> filter out
        const rawContent =
          typeof content === 'string' && content.trim()
            ? ([{ text: content, type: 'text' }] as UserMessageContentPart[])
            : Array.isArray(content)
              ? content
              : []; // null/undefined/empty string -> empty array (will be filtered)

        const messageContent = await buildArrayContent(rawContent, context);

        return {
          content: [
            // avoid empty text content block
            ...messageContent,
            ...(message.tool_calls.map((tool) => {
              let input: Record<string, unknown> = {};
              try {
                input = JSON.parse(tool.function.arguments);
              } catch {
                // Ignore malformed tool JSON arguments
              }
              return {
                id: tool.id,
                input,
                name: tool.function.name,
                type: 'tool_use',
              };
            }) as any),
          ].filter(Boolean),
          role: 'assistant',
        };
      }

      // or it's a plain assistant message
      // Handle array content (e.g., content with thinking blocks)
      if (Array.isArray(content)) {
        const messageContent = await buildArrayContent(content, context);
        if (messageContent.length === 0) return undefined;
        return { content: messageContent, role: 'assistant' };
      }

      // Anthropic API requires non-empty content, filter out empty/whitespace-only content
      const textContent = content?.trim();
      if (!textContent) return undefined;
      return { content: textContent, role: 'assistant' };
    }

    case 'function': {
      return { content: content as string, role: 'assistant' };
    }
  }
};

export const ANTHROPIC_MAX_CACHE_CONTROL_BLOCKS = 4;

export type AnthropicCacheTTL = NonNullable<Anthropic.Messages.CacheControlEphemeral['ttl']>;

export interface AnthropicCacheControlOptions {
  cacheTTL?: AnthropicCacheTTL;
  enabledContextCaching?: boolean;
  maxCacheControlBlocks?: number;
  signal?: AbortSignal;
}

export const buildAnthropicCacheControl = (
  cacheTTL?: AnthropicCacheTTL,
): Anthropic.Messages.CacheControlEphemeral =>
  cacheTTL === '1h' ? { ttl: '1h', type: 'ephemeral' } : { type: 'ephemeral' };

/**
 * Caps `cache_control` breakpoints across `messages` to `maxBlocks` (Anthropic allows at most 4
 * across `system` + `tools` + `messages` combined). Keeps the latest breakpoints when trimming.
 */
export const capAnthropicMessageCacheControlBlocks = (
  messages: Anthropic.Messages.MessageParam[],
  maxBlocks = ANTHROPIC_MAX_CACHE_CONTROL_BLOCKS,
): void => {
  const effectiveMax = Math.max(0, maxBlocks);
  const markedBlocks: Array<{ cache_control?: unknown }> = [];

  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block && typeof block === 'object' && 'cache_control' in block && block.cache_control) {
        markedBlocks.push(block as { cache_control?: unknown });
      }
    }
  }

  const excess = markedBlocks.length - effectiveMax;
  for (let i = 0; i < excess; i++) {
    delete markedBlocks[i].cache_control;
  }
};

const toContentBlockArray = (
  content: Anthropic.Messages.MessageParam['content'],
): Anthropic.Messages.ContentBlockParam[] =>
  typeof content === 'string' ? [{ text: content, type: 'text' }] : [...content];

/**
 * Appends an Anthropic message while merging adjacent same-role messages so roles
 * strictly alternate (`user` <-> `assistant`). When merging two `user` messages,
 * all `tool_result` blocks are placed BEFORE `text`/`image` blocks as required by Anthropic.
 */
const appendMergedAnthropicMessage = (
  messages: Anthropic.Messages.MessageParam[],
  next: Anthropic.Messages.MessageParam,
): void => {
  const prev = messages.at(-1);
  if (!prev || prev.role !== next.role) {
    messages.push(next);
    return;
  }

  const combined = [...toContentBlockArray(prev.content), ...toContentBlockArray(next.content)];
  if (prev.role === 'user') {
    const toolResults = combined.filter((block) => block.type === 'tool_result');
    const otherBlocks = combined.filter((block) => block.type !== 'tool_result');
    prev.content = [...toolResults, ...otherBlocks];
  } else {
    prev.content = combined;
  }
};

const createConcurrencyLimiter = (limit: number) => {
  let active = 0;
  const queue: Array<() => void> = [];

  const next = () => {
    active -= 1;
    const wake = queue.shift();
    if (wake) wake();
  };

  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= limit) {
      await new Promise<void>((resolve) => {
        queue.push(resolve);
      });
    }
    active += 1;
    try {
      return await fn();
    } finally {
      next();
    }
  };
};

export const buildAnthropicMessages = async (
  oaiMessages: OpenAIChatMessage[],
  options: AnthropicCacheControlOptions = {},
): Promise<Anthropic.Messages.MessageParam[]> => {
  const messages: Anthropic.Messages.MessageParam[] = [];

  // Pass 1a: Collect valid tool_call_ids from assistant messages
  const validToolCallIds = new Set<string>();
  for (const message of oaiMessages) {
    if (message.role === 'assistant' && message.tool_calls?.length) {
      message.tool_calls.forEach((call) => {
        if (call.id) {
          validToolCallIds.add(call.id);
        }
      });
    }
  }

  // Collect all content parts in exact visit order so:
  // 1) total image count determines 8000px vs 2000px (>20 images) dimension cap;
  // 2) parseDataUri is called at most ONCE per content part;
  // 3) URL images across the conversation pre-warm concurrently with bounded concurrency (6).
  const orderedParts: UserMessageContentPart[] = [];
  for (const message of oaiMessages) {
    if (
      message.role === 'tool' &&
      message.tool_call_id &&
      validToolCallIds.has(message.tool_call_id) &&
      Array.isArray(message.content)
    ) {
      orderedParts.push(...message.content);
    }
  }
  for (const message of oaiMessages) {
    if (message.role === 'tool') {
      if (message.tool_call_id && validToolCallIds.has(message.tool_call_id)) continue;
      if (Array.isArray(message.content)) orderedParts.push(...message.content);
      continue;
    }
    if (
      (message.role === 'user' || message.role === 'assistant') &&
      Array.isArray(message.content)
    ) {
      orderedParts.push(...message.content);
    }
  }

  const parsedUris = new Map<UserMessageContentPart, ReturnType<typeof parseDataUri>>();
  let totalImages = 0;
  for (const part of orderedParts) {
    if (part?.type === 'image_url') {
      totalImages += 1;
      parsedUris.set(part, parseDataUri(part.image_url.url));
    }
  }

  const maxImageDimension =
    totalImages > ANTHROPIC_MANY_IMAGES_THRESHOLD
      ? ANTHROPIC_MANY_IMAGES_MAX_DIMENSION
      : ANTHROPIC_SINGLE_MAX_DIMENSION_FALLBACK;

  const limitConcurrency = createConcurrencyLimiter(MAX_CONCURRENT_IMAGE_LOADS);
  const urlLoadPromises = new Map<string, Promise<{ base64: string; mimeType: string }>>();

  const loadImage = (url: string) => {
    const existing = urlLoadPromises.get(url);
    if (existing) return existing;

    const promise = limitConcurrency(() =>
      options.signal ? imageUrlToBase64(url, { signal: options.signal }) : imageUrlToBase64(url),
    );
    urlLoadPromises.set(url, promise);
    return promise;
  };

  // Kick off bounded parallel pre-warm across all messages
  for (const [part, parsed] of parsedUris) {
    if (parsed.type === 'url') {
      loadImage(
        (part as Extract<UserMessageContentPart, { type: 'image_url' }>).image_url.url,
      ).catch(() => {});
    }
  }

  const buildContext: AnthropicBuildContext = {
    loadImage,
    maxImageDimension,
    parsedUris,
    signal: options.signal,
  };

  // Pass 1b: Pre-build tool_result blocks indexed by tool_call_id
  const toolResultsByCallId = new Map<string, Anthropic.ToolResultBlockParam>();
  for (const message of oaiMessages) {
    if (
      message.role !== 'tool' ||
      !message.tool_call_id ||
      !validToolCallIds.has(message.tool_call_id)
    )
      continue;

    const toolResultBlock = await buildAnthropicToolResultBlock(message, buildContext);
    if (toolResultBlock) {
      toolResultsByCallId.set(message.tool_call_id, toolResultBlock);
    }
  }

  // Pass 2: Build final message array with guaranteed tool_use/tool_result pairing and alternating roles
  for (const message of oaiMessages) {
    if (message.role === 'assistant') {
      const pairedToolCalls = message.tool_calls?.filter(
        (toolCall) => !!toolCall.id && toolResultsByCallId.has(toolCall.id),
      );

      const anthropicMessage = await buildAnthropicMessage(
        {
          ...message,
          tool_calls: pairedToolCalls?.length ? pairedToolCalls : undefined,
        },
        buildContext,
      );

      if (anthropicMessage) {
        appendMergedAnthropicMessage(messages, anthropicMessage);
      }

      if (pairedToolCalls?.length) {
        appendMergedAnthropicMessage(messages, {
          content: pairedToolCalls.flatMap((toolCall) => {
            const toolResultBlock = toolResultsByCallId.get(toolCall.id);
            return toolResultBlock ? [toolResultBlock] : [];
          }),
          role: 'user',
        });
      }

      continue;
    }

    if (message.role === 'tool') {
      if (message.tool_call_id && validToolCallIds.has(message.tool_call_id)) {
        continue;
      }

      // Orphan tool message: convert array content via buildArrayContent (never leak raw base64 JSON!)
      if (Array.isArray(message.content)) {
        const orphanBlocks = await buildArrayContent(message.content, buildContext);
        appendMergedAnthropicMessage(messages, {
          content: orphanBlocks.length > 0 ? orphanBlocks : '<empty_content>',
          role: 'user',
        });
      } else {
        const fallbackContent = hasVisibleText(message.content)
          ? message.content
          : '<empty_content>';
        appendMergedAnthropicMessage(messages, {
          content: fallbackContent,
          role: 'user',
        });
      }

      continue;
    }

    const anthropicMessage = await buildAnthropicMessage(message, buildContext);
    if (anthropicMessage) {
      appendMergedAnthropicMessage(messages, anthropicMessage);
    }
  }

  const lastMessage = messages.at(-1);
  if (options.enabledContextCaching && !!lastMessage) {
    const cacheControl = buildAnthropicCacheControl(options.cacheTTL);
    if (typeof lastMessage.content === 'string') {
      lastMessage.content = [
        {
          cache_control: cacheControl,
          text: lastMessage.content as string,
          type: 'text',
        },
      ];
    } else {
      const lastContent = lastMessage.content.at(-1);

      if (
        lastContent &&
        lastContent.type !== 'thinking' &&
        lastContent.type !== 'redacted_thinking'
      ) {
        lastContent.cache_control = cacheControl;
      }
    }
  }

  capAnthropicMessageCacheControlBlocks(
    messages,
    options.maxCacheControlBlocks ?? ANTHROPIC_MAX_CACHE_CONTROL_BLOCKS,
  );

  return messages;
};

const ANTHROPIC_SINGLE_MAX_DIMENSION_FALLBACK = ANTHROPIC_MAX_IMAGE_DIMENSION;

export const buildAnthropicTools = (
  tools?: OpenAI.ChatCompletionTool[],
  options: AnthropicCacheControlOptions = {},
) => {
  if (!tools) return;

  const cacheControl = options.enabledContextCaching
    ? buildAnthropicCacheControl(options.cacheTTL)
    : undefined;

  return tools.map((tool, index): Anthropic.Tool => ({
    cache_control: index === tools.length - 1 ? cacheControl : undefined,
    description: tool.function.description,
    input_schema: tool.function.parameters as Anthropic.Tool.InputSchema,
    name: tool.function.name,
  }));
};

export const buildSearchTool = (): Anthropic.WebSearchTool20250305 => {
  const maxUses = process.env.ANTHROPIC_MAX_USES;

  return {
    name: 'web_search',
    type: 'web_search_20250305',
    ...(maxUses &&
      Number.isInteger(Number(maxUses)) &&
      Number(maxUses) > 0 && {
        max_uses: Number(maxUses),
      }),
  };
};
