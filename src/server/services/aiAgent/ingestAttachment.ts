import mime from 'mime';

import type { FileService } from '@/server/services/file';

import { prepareImageForModel } from './imageSlicing';

// --------------- Constants ---------------

const COMPRESSIBLE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

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
): Promise<IngestResult> {
  let buffer: Buffer;
  let mimeType = source.mimeType || 'application/octet-stream';

  // 1. Resolve buffer
  if (source.buffer) {
    buffer = source.buffer;
  } else if (source.url) {
    const response = await fetch(source.url);
    if (!response.ok) {
      throw new Error(`Failed to fetch attachment: ${response.status} ${response.statusText}`);
    }
    buffer = Buffer.from(await response.arrayBuffer());

    // Use response header if more specific than what we have
    const headerType = response.headers.get('content-type');
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
