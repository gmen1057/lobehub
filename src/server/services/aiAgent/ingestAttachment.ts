import { type SSRFOptions, ssrfSafeFetch } from '@lobechat/ssrf-safe-fetch';
import mime from 'mime';

import type { FileService } from '@/server/services/file';

import { prepareImageForModel } from './imageSlicing';

// --------------- Constants ---------------

const COMPRESSIBLE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** Maximum allowed attachment download / buffer size (50 MiB). */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/** Maximum number of HTTPS redirects followed when fetching external attachment URLs. */
export const MAX_ATTACHMENT_REDIRECTS = 5;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface IngestAttachmentOptions {
  /** Network fetcher (defaults to ssrfSafeFetch; injectable for tests). */
  baseFetch?: typeof ssrfSafeFetch;
  /** Maximum payload size in bytes (defaults to MAX_UPLOAD_BYTES). */
  maxBytes?: number;
  /** Maximum redirect hops (defaults to MAX_ATTACHMENT_REDIRECTS). */
  maxRedirects?: number;
  /** SSRF overrides (only used in tests with a local HTTPS server). */
  ssrf?: SSRFOptions;
}

const assertAllowedAttachmentUrl = (url: URL, redirected: boolean) => {
  if (url.protocol !== 'https:') {
    throw new Error(
      redirected
        ? `Only https attachment URLs are allowed (redirect to ${url.protocol}//${url.host})`
        : 'Only https attachment URLs are allowed',
    );
  }
  if (url.username || url.password) {
    throw new Error('Attachment URLs with credentials are not allowed');
  }
};

const fetchAttachmentSafely = async (
  rawUrl: string,
  options: IngestAttachmentOptions = {},
): Promise<{ buffer: Buffer; contentType: string | null }> => {
  const baseFetch = options.baseFetch ?? ssrfSafeFetch;
  const maxBytes = options.maxBytes ?? MAX_UPLOAD_BYTES;
  const maxRedirects = options.maxRedirects ?? MAX_ATTACHMENT_REDIRECTS;
  const ssrf: SSRFOptions = {
    allowIPAddressList: options.ssrf?.allowIPAddressList ?? [],
    allowPrivateIPAddress: options.ssrf?.allowPrivateIPAddress ?? false,
  };

  let current: URL;
  try {
    current = new URL(rawUrl);
  } catch {
    throw new Error('Invalid attachment URL');
  }

  let response: Response | undefined;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    assertAllowedAttachmentUrl(current, hop > 0);

    const hopResponse = await baseFetch(
      current.href,
      { redirect: 'manual', size: maxBytes } as RequestInit,
      ssrf,
    );

    if (!REDIRECT_STATUSES.has(hopResponse.status)) {
      response = hopResponse;
      break;
    }

    const location = hopResponse.headers.get('location');
    if (!location) {
      throw new Error(`Redirect (${hopResponse.status}) without a Location header`);
    }
    try {
      current = new URL(location, current);
    } catch {
      throw new Error('Invalid redirect URL while fetching attachment');
    }
  }

  if (!response) {
    throw new Error(`Too many redirects (more than ${maxRedirects})`);
  }

  if (!response.ok) {
    throw new Error(`Failed to fetch attachment: ${response.status} ${response.statusText}`);
  }

  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Attachment size (${declaredLength} bytes) exceeds limit (${maxBytes} bytes)`);
  }

  const reader = response.body?.getReader();
  let buffer: Buffer;
  if (reader) {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`Attachment size exceeds limit (${maxBytes} bytes)`);
      }
      chunks.push(value);
    }
    buffer = Buffer.concat(chunks, total);
  } else {
    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength > maxBytes) {
      throw new Error(
        `Attachment size (${arrayBuffer.byteLength} bytes) exceeds limit (${maxBytes} bytes)`,
      );
    }
    buffer = Buffer.from(arrayBuffer);
  }

  return {
    buffer,
    contentType: response.headers.get('content-type'),
  };
};

// --------------- Types ---------------

/**
 * Unified attachment source — the only input step 12 needs.
 * Adapter/platform layer fills buffer + metadata, external URLs just fill url.
 */
export interface AttachmentSource {
  /** Pre-downloaded buffer (from adapter/platform layer) */
  buffer?: Buffer;
  mimeType?: string;
  name?: string;
  size?: number;
  /** External URL (e.g. Discord CDN) — fetched if no buffer */
  url?: string;
}

/** Один файл-картинка, отданный модели (картинка целиком или один её кусок). */
export interface IngestedImage {
  fileId: string;
  /** Размер этого файла в точках; 0 — неизвестен */
  height: number;
  /** Номер куска с 1; у цельной картинки — 1 */
  index: number;
  key: string;
  mimeType: string;
  name: string;
  resolvedUrl: string;
  /** Сколько кусков всего; у цельной картинки — 1 */
  total: number;
  width: number;
}

export interface IngestResult {
  /** Первый (у цельной картинки — единственный) файл */
  fileId: string;
  /**
   * arckep (19.10.2026): картинки. Длинная картинка режется на куски сверху вниз (imageSlicing.ts) — по файлу
   * на кусок, по порядку. У обычной картинки здесь один элемент, равный fileId/key/resolvedUrl выше.
   */
  images: IngestedImage[];
  isImage: boolean;
  key: string;
  resolvedUrl: string;
  /** Размер исходной картинки в точках (до сжатия и резки); есть у картинок, которые удалось прочитать */
  source?: { height: number; width: number };
  /** Сохранённый файл — исходные байты (картинка не сжималась и не резалась; прочие файлы — всегда) */
  unchanged: boolean;
}

// --------------- Public API ---------------

/**
 * Unified file ingestion: normalize → prepare images (resize / slice) → upload → create record.
 *
 * Accepts both buffer (bot adapter) and URL (external platforms) inputs.
 * Applies the same MIME correction, image compression, and metadata as the UI upload path.
 */
export async function ingestAttachment(
  source: AttachmentSource,
  fileService: FileService,
  userId: string,
  options?: IngestAttachmentOptions,
): Promise<IngestResult> {
  const maxBytes = options?.maxBytes ?? MAX_UPLOAD_BYTES;
  let buffer: Buffer;
  let mimeType = source.mimeType || 'application/octet-stream';

  // 1. Resolve buffer
  if (source.buffer) {
    if (source.buffer.byteLength > maxBytes) {
      throw new Error(
        `Attachment size (${source.buffer.byteLength} bytes) exceeds limit (${maxBytes} bytes)`,
      );
    }
    buffer = source.buffer;
  } else if (source.url) {
    const fetched = await fetchAttachmentSafely(source.url, options);
    buffer = fetched.buffer;

    // Use response header if more specific than what we have
    const headerType = fetched.contentType?.split(';')[0]?.trim().toLowerCase();
    if (headerType && headerType !== 'application/octet-stream') {
      mimeType = headerType;
    }
  } else {
    throw new Error('AttachmentSource must have either buffer or url');
  }

  // 2. MIME correction from filename
  if (mimeType === 'application/octet-stream' && source.name) {
    mimeType = mime.getType(source.name) || mimeType;
  }

  // 3. Images: width ≤ 1536 without upscaling; very tall images are cut into parts (imageSlicing.ts)
  const isImage = COMPRESSIBLE_TYPES.has(mimeType);
  const ext = source.name?.split('.').pop() || 'bin';
  const baseName = source.name || `file.${ext}`;
  const { nanoid } = await import('@lobechat/utils');
  const folder = `files/${userId}/${nanoid()}`;

  if (isImage) {
    const prepared = await prepareImageForModel(buffer, mimeType);
    const total = prepared.parts.length;
    const images: IngestedImage[] = [];

    for (const [position, part] of prepared.parts.entries()) {
      const index = position + 1;
      // Цельная картинка — под своим именем; куски — «имя.part-01-of-08.png» (порядок читается и по имени)
      const partExt = part.mimeType === 'image/jpeg' ? 'jpg' : 'png';
      const name =
        total === 1
          ? baseName
          : `${baseName}.part-${String(index).padStart(2, '0')}-of-${String(total).padStart(2, '0')}.${partExt}`;
      const { fileId, key } = await fileService.uploadFromBuffer(
        part.buffer,
        part.mimeType,
        `${folder}/${name}`,
      );
      images.push({
        fileId,
        height: part.height,
        index,
        key,
        mimeType: part.mimeType,
        name,
        resolvedUrl: await fileService.getFullFileUrl(key),
        total,
        width: part.width,
      });
    }

    const first = images[0];
    return {
      fileId: first.fileId,
      images,
      isImage: true,
      key: first.key,
      resolvedUrl: first.resolvedUrl,
      source: prepared.source,
      unchanged: prepared.unchanged,
    };
  }

  // 4. Other files: upload + create record
  const { fileId, key } = await fileService.uploadFromBuffer(
    buffer,
    mimeType,
    `${folder}/${baseName}`,
  );

  return { fileId, images: [], isImage: false, key, resolvedUrl: '', unchanged: true };
}
