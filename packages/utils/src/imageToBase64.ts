export const imageToBase64 = ({
  size,
  img,
  type = 'image/webp',
}: {
  img: HTMLImageElement;
  size: number;
  type?: string;
}) => {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  let startX = 0;
  let startY = 0;

  if (img.width > img.height) {
    startX = (img.width - img.height) / 2;
  } else {
    startY = (img.height - img.width) / 2;
  }

  canvas.width = size;
  canvas.height = size;

  ctx.drawImage(
    img,
    startX,
    startY,
    Math.min(img.width, img.height),
    Math.min(img.width, img.height),
    0,
    0,
    size,
    size,
  );

  return canvas.toDataURL(type);
};

const SERVER_IMAGE_CACHE_MAX_ENTRIES = 128;
const SERVER_IMAGE_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const SERVER_IMAGE_CACHE_TTL_MS = 30 * 60 * 1000;
const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_DELAYS_MS = [250, 1000];
const RETRYABLE_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

interface ImageBase64Result {
  base64: string;
  mimeType: string;
}

interface CachedImageEntry extends ImageBase64Result {
  expiresAt: number;
  size: number;
}

export interface ImageUrlToBase64Options {
  /** Override backoff delays between retries (mainly for unit tests). */
  retryDelaysMs?: number[];
  /** Per-attempt HTTP timeout in milliseconds (defaults to 10_000ms on server). */
  timeoutMs?: number;
}

interface HttpStatusError extends Error {
  retryable: boolean;
  status: number;
}

const serverImageCache = new Map<string, CachedImageEntry>();
let serverImageCacheBytes = 0;
const inFlightImageLoads = new Map<string, Promise<ImageBase64Result>>();

const deleteCachedImage = (key: string): void => {
  const existing = serverImageCache.get(key);
  if (!existing) return;
  serverImageCache.delete(key);
  serverImageCacheBytes = Math.max(0, serverImageCacheBytes - existing.size);
};

const getCachedImage = (key: string, now = Date.now()): ImageBase64Result | null => {
  const entry = serverImageCache.get(key);
  if (!entry) return null;

  if (entry.expiresAt <= now) {
    deleteCachedImage(key);
    return null;
  }

  // Refresh LRU recency
  serverImageCache.delete(key);
  serverImageCache.set(key, entry);
  return { base64: entry.base64, mimeType: entry.mimeType };
};

const setCachedImage = (key: string, value: ImageBase64Result, now = Date.now()): void => {
  const size = value.base64.length;
  if (size === 0 || size > SERVER_IMAGE_CACHE_MAX_BYTES) return;

  deleteCachedImage(key);

  // Evict expired entries first
  for (const [k, entry] of serverImageCache) {
    if (entry.expiresAt <= now) {
      deleteCachedImage(k);
    }
  }

  // Evict oldest LRU entries until within entry count and byte caps
  while (
    serverImageCache.size >= SERVER_IMAGE_CACHE_MAX_ENTRIES ||
    serverImageCacheBytes + size > SERVER_IMAGE_CACHE_MAX_BYTES
  ) {
    const oldestKey = serverImageCache.keys().next().value;
    if (oldestKey === undefined) break;
    deleteCachedImage(oldestKey);
  }

  serverImageCache.set(key, {
    base64: value.base64,
    expiresAt: now + SERVER_IMAGE_CACHE_TTL_MS,
    mimeType: value.mimeType,
    size,
  });
  serverImageCacheBytes += size;
};

export const clearImageBase64CacheForTest = (): void => {
  serverImageCache.clear();
  serverImageCacheBytes = 0;
  inFlightImageLoads.clear();
};

const createHttpStatusError = (
  status: number,
  statusText: string,
  url: string,
): HttpStatusError => {
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    // keep raw url fallback
  }
  const err = new Error(
    `HTTP ${status}${statusText ? ` ${statusText}` : ''} fetching image from ${host}`,
  ) as HttpStatusError;
  err.status = status;
  err.retryable = RETRYABLE_HTTP_STATUSES.has(status);
  return err;
};

const assertResponseOk = (res: Response, url: string): void => {
  const status = typeof res.status === 'number' ? res.status : undefined;
  const isError = res.ok === false || (status !== undefined && (status < 200 || status >= 300));
  if (isError) {
    throw createHttpStatusError(status ?? 500, res.statusText || '', url);
  }
};

const isRetryableError = (error: unknown): boolean => {
  if (error && typeof error === 'object') {
    const maybeHttp = error as Partial<HttpStatusError>;
    if (typeof maybeHttp.status === 'number') {
      return Boolean(maybeHttp.retryable);
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('SSRF blocked')) return false;
  return true;
};

const sleepMs = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

const fetchServerImageOnce = async (
  targetUrl: string,
  timeoutMs: number,
  keyForMime: string,
  detectImageMimeType: (
    buf: Buffer | Uint8Array,
    headerMime?: string | null,
    keyOrUrl?: string,
  ) => string,
): Promise<ImageBase64Result> => {
  const { ssrfSafeFetch } = await import('@lobechat/ssrf-safe-fetch');
  const res = await ssrfSafeFetch(targetUrl, { timeoutMs });
  assertResponseOk(res, targetUrl);

  let headerContentType: string | null = res.headers?.get?.('content-type') ?? null;
  let arrayBuffer: ArrayBuffer;

  if (typeof res.arrayBuffer === 'function') {
    arrayBuffer = await res.arrayBuffer();
  } else {
    const blob = await res.blob();
    if (!headerContentType && blob.type) {
      headerContentType = blob.type;
    }
    arrayBuffer = await blob.arrayBuffer();
  }

  const buffer = Buffer.from(arrayBuffer);
  if (buffer.length === 0) {
    throw new Error(`Empty image body received from ${targetUrl}`);
  }

  return {
    base64: buffer.toString('base64'),
    mimeType: detectImageMimeType(buffer, headerContentType, keyForMime),
  };
};

const loadImageOnServer = async (
  imageUrl: string,
  options?: ImageUrlToBase64Options,
): Promise<ImageBase64Result> => {
  const mirror = await import('./arckepMediaMirror');
  const ownKey = mirror.extractOwnBucketKey(imageUrl);
  const cacheKey = ownKey ? `bucket:${ownKey}` : imageUrl;

  const cached = getCachedImage(cacheKey);
  if (cached) return cached;

  const existingInFlight = inFlightImageLoads.get(cacheKey);
  if (existingInFlight) return existingInFlight;

  const loadPromise = (async (): Promise<ImageBase64Result> => {
    const isAlreadyMediaUrl = mirror.isMediaPublicUrl(imageUrl);
    const isOwnS3Url = Boolean(ownKey) && !isAlreadyMediaUrl;
    const timeoutMs = options?.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    const retryDelays = options?.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    const maxAttempts = retryDelays.length + 1;
    const mimeHint = ownKey || imageUrl;

    // 1. Mirror-first for our own bucket keys (0 network calls, ~0.2ms)
    if (ownKey) {
      const mirrored = await mirror.readLocalMirrorFile(ownKey);
      if (mirrored && mirrored.buffer.length > 0) {
        const result: ImageBase64Result = {
          base64: mirrored.buffer.toString('base64'),
          mimeType: mirrored.mimeType,
        };
        setCachedImage(cacheKey, result);
        return result;
      }
    }

    // 2. If our S3 outage breaker is already open, try signed media.arckep.ru first
    let triedMediaFallback = false;
    if (isOwnS3Url && ownKey && mirror.isS3BreakerOpen()) {
      triedMediaFallback = true;
      const mediaUrl = await mirror.signMediaUrlViaStudio(ownKey);
      if (mediaUrl) {
        try {
          const result = await fetchServerImageOnce(
            mediaUrl,
            timeoutMs,
            mimeHint,
            mirror.detectImageMimeType,
          );
          setCachedImage(cacheKey, result);
          return result;
        } catch (mediaErr) {
          console.warn(
            `[imageUrlToBase64] media fallback failed while S3 breaker open for ${ownKey}:`,
            mediaErr,
          );
        }
      }
    }

    // 3. Hardened HTTP fetch with timeout, res.ok check, and retries
    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const result = await fetchServerImageOnce(
          imageUrl,
          timeoutMs,
          mimeHint,
          mirror.detectImageMimeType,
        );
        if (isOwnS3Url) {
          mirror.recordS3Success();
        }
        setCachedImage(cacheKey, result);
        return result;
      } catch (error) {
        lastError = error;
        if (isOwnS3Url) {
          mirror.recordS3Failure(error);
        }
        if (!isRetryableError(error) || attempt >= maxAttempts - 1) {
          break;
        }
        await sleepMs(retryDelays[attempt] ?? 0);
      }
    }

    // 4. Fallback for our own S3 keys: re-check mirror, then signed media.arckep.ru
    if (isOwnS3Url && ownKey) {
      const mirroredAfterFailure = await mirror.readLocalMirrorFile(ownKey);
      if (mirroredAfterFailure && mirroredAfterFailure.buffer.length > 0) {
        const result: ImageBase64Result = {
          base64: mirroredAfterFailure.buffer.toString('base64'),
          mimeType: mirroredAfterFailure.mimeType,
        };
        setCachedImage(cacheKey, result);
        return result;
      }

      if (!triedMediaFallback) {
        const mediaUrl = await mirror.signMediaUrlViaStudio(ownKey);
        if (mediaUrl) {
          try {
            const result = await fetchServerImageOnce(
              mediaUrl,
              timeoutMs,
              mimeHint,
              mirror.detectImageMimeType,
            );
            setCachedImage(cacheKey, result);
            return result;
          } catch (fallbackError) {
            console.warn(
              `[imageUrlToBase64] media.arckep.ru fallback failed for ${ownKey}:`,
              fallbackError,
            );
          }
        }
      }
    }

    throw lastError;
  })();

  inFlightImageLoads.set(cacheKey, loadPromise);
  try {
    return await loadPromise;
  } finally {
    if (inFlightImageLoads.get(cacheKey) === loadPromise) {
      inFlightImageLoads.delete(cacheKey);
    }
  }
};

/**
 * Convert image URL to base64
 * Uses local S3 mirror, bounded LRU cache, retries, media.arckep.ru fallback,
 * and SSRF-safe fetch on server-side.
 */
export const imageUrlToBase64 = async (
  imageUrl: string,
  options?: ImageUrlToBase64Options,
): Promise<ImageBase64Result> => {
  try {
    const isServer = typeof window === 'undefined';

    if (isServer) {
      return await loadImageOnServer(imageUrl, options);
    }

    const res = await fetch(imageUrl);
    assertResponseOk(res, imageUrl);

    const blob = await res.blob();
    const arrayBuffer = await blob.arrayBuffer();

    const base64 = btoa(
      new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), ''),
    );

    return { base64, mimeType: blob.type };
  } catch (error) {
    console.error('Error converting image to base64:', error);
    throw error;
  }
};
