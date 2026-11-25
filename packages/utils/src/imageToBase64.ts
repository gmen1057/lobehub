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

export const SERVER_IMAGE_CACHE_MAX_ENTRIES = 128;
export const SERVER_IMAGE_CACHE_MAX_BYTES = 64 * 1024 * 1024;
export const SERVER_IMAGE_CACHE_MAX_ENTRY_BYTES = 12 * 1024 * 1024;
export const SERVER_IMAGE_CACHE_TTL_MS = 30 * 60 * 1000;
const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
const BREAKER_OPEN_PROBE_TIMEOUT_MS = 5_000;
const DEFAULT_RETRY_DELAYS_MS = [300, 700, 1600];
const DEFAULT_RETRY_JITTER_RATIO = 0.3;
const MAX_RETRY_AFTER_MS = 3_000;
const RETRYABLE_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

const NON_RETRYABLE_ERROR_CODES = new Set([
  'ABORT_ERR',
  'AccessDenied',
  'BadRequest',
  'ERR_INVALID_PROTOCOL',
  'ERR_INVALID_URL',
  'Forbidden',
  'InvalidAccessKeyId',
  'InvalidArgument',
  'NoSuchBucket',
  'NoSuchKey',
  'NotFound',
  'SignatureDoesNotMatch',
]);

const RETRYABLE_ERROR_CODES = new Set([
  'EAI_AGAIN',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ETIMEDOUT',
  'InternalError',
  'NetworkingError',
  'RequestTimeout',
  'ServiceUnavailable',
  'SlowDown',
  'TimeoutError',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

const RETRYABLE_ERROR_NAMES = new Set([
  'AbortError',
  'FetchError',
  'InternalError',
  'NetworkingError',
  'RequestTimeout',
  'ServiceUnavailable',
  'SlowDown',
  'TimeoutError',
]);

const NON_RETRYABLE_MESSAGE_PATTERN =
  /ssrf blocked|is not allowed|invalid url|invalid image url|err_invalid_url|only http\(s\) protocols|only absolute urls|unsupported protocol/i;

const RETRYABLE_MESSAGE_PATTERN =
  /econnreset|etimedout|eai_again|econnrefused|epipe|enetunreach|ehostunreach|enotfound|und_err_(?:socket|connect_timeout|headers_timeout|body_timeout)|timeouterror|fetcherror|fetch failed|request timed out|timed out|socket hang up|network error|empty image body received|service unavailable|slowdown|connection reset/i;

export interface ImageBase64Result {
  base64: string;
  mimeType: string;
}

interface CachedImageEntry extends ImageBase64Result {
  expiresAt: number;
  size: number;
}

export interface ImageUrlToBase64Options {
  /** Jitter ratio (0..1) or boolean toggle applied to positive retry delays (defaults to 0.3). */
  jitter?: boolean | number;
  /** Override maximum single cache entry base64 length (defaults to 12 MiB). */
  maxCacheEntryBytes?: number;
  /** Override backoff delays between retries (mainly for unit tests). */
  retryDelaysMs?: number[];
  /** Optional caller AbortSignal; cancels waiting without tearing down other concurrent callers. */
  signal?: AbortSignal;
  /** Per-attempt HTTP timeout in milliseconds (defaults to 10_000ms on server). */
  timeoutMs?: number;
}

interface HttpStatusError extends Error {
  retryable: boolean;
  retryAfterMs?: number;
  status: number;
}

interface InFlightImageLoad {
  activeWaiters: number;
  promise: Promise<ImageBase64Result>;
  sharedController?: AbortController;
}

const serverImageCache = new Map<string, CachedImageEntry>();
let serverImageCacheBytes = 0;
const inFlightImageLoads = new Map<string, InFlightImageLoad>();

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

const setCachedImage = (
  key: string,
  value: ImageBase64Result,
  maxEntryBytes = SERVER_IMAGE_CACHE_MAX_ENTRY_BYTES,
  now = Date.now(),
): void => {
  const size = value.base64.length;
  const effectiveMaxEntry = Math.min(SERVER_IMAGE_CACHE_MAX_BYTES, maxEntryBytes);
  if (size === 0 || size > effectiveMaxEntry) return;

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

const createCallerAbortError = (reason: unknown): Error => {
  if (reason instanceof Error) {
    const err = new Error(reason.message || 'The operation was aborted', { cause: reason });
    err.name = 'AbortError';
    (err as Error & { isCallerAbort?: boolean }).isCallerAbort = true;
    return err;
  }
  const err = new Error(
    typeof reason === 'string' && reason ? reason : 'The operation was aborted',
  );
  err.name = 'AbortError';
  (err as Error & { isCallerAbort?: boolean }).isCallerAbort = true;
  return err;
};

const parseRetryAfterMs = (
  retryAfterHeader: string | null | undefined,
  now = Date.now(),
): number | undefined => {
  if (!retryAfterHeader) return undefined;
  const trimmed = retryAfterHeader.trim();
  if (!trimmed) return undefined;

  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(MAX_RETRY_AFTER_MS, Math.ceil(seconds * 1000));
    }
    return undefined;
  }

  const parsedDate = Date.parse(trimmed);
  if (Number.isFinite(parsedDate)) {
    return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, parsedDate - now));
  }

  return undefined;
};

const createHttpStatusError = (
  status: number,
  statusText: string,
  url: string,
  retryAfterMs?: number,
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
  if (retryAfterMs !== undefined) {
    err.retryAfterMs = retryAfterMs;
  }
  return err;
};

const assertResponseOk = (res: Response, url: string): void => {
  const status = typeof res.status === 'number' ? res.status : undefined;
  const isError = res.ok === false || (status !== undefined && (status < 200 || status >= 300));
  if (isError) {
    const effectiveStatus = status ?? 500;
    const retryAfterMs =
      effectiveStatus === 429 || effectiveStatus === 503
        ? parseRetryAfterMs(res.headers?.get?.('retry-after'))
        : undefined;
    throw createHttpStatusError(effectiveStatus, res.statusText || '', url, retryAfterMs);
  }
};

const isCallerAbortChain = (error: unknown): boolean => {
  let current: unknown = error;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 6 && current != null && !seen.has(current); depth++) {
    seen.add(current);
    if (typeof current !== 'object') break;
    const record = current as Record<string, unknown>;
    if (record.isTimeout === true || record.name === 'TimeoutError') return false;
    if (record.isCallerAbort === true || record.name === 'APIUserAbortError') return true;
    if (record.code === 'ABORT_ERR') return true;
    if (
      typeof DOMException !== 'undefined' &&
      current instanceof DOMException &&
      current.name === 'AbortError'
    ) {
      return true;
    }
    current = record.cause;
  }
  return false;
};

export const isRetryableImageFetchError = (error: unknown): boolean => {
  if (isCallerAbortChain(error)) return false;

  // Pass 1: reject any permanent error anywhere in the error/cause chain
  let cursor: unknown = error;
  const visitedPermanent = new Set<unknown>();
  for (let depth = 0; depth < 6 && cursor != null && !visitedPermanent.has(cursor); depth++) {
    visitedPermanent.add(cursor);

    if (typeof cursor === 'string') {
      if (NON_RETRYABLE_MESSAGE_PATTERN.test(cursor)) return false;
      break;
    }
    if (typeof cursor !== 'object') break;

    const record = cursor as Record<string, unknown>;
    if (typeof record.retryable === 'boolean' && !record.retryable) {
      return false;
    }

    const status =
      typeof record.status === 'number'
        ? record.status
        : typeof record.statusCode === 'number'
          ? record.statusCode
          : undefined;
    if (status !== undefined && !RETRYABLE_HTTP_STATUSES.has(status)) {
      return false;
    }

    const code = typeof record.code === 'string' ? record.code : '';
    const name = typeof record.name === 'string' ? record.name : '';
    if (NON_RETRYABLE_ERROR_CODES.has(code) || NON_RETRYABLE_ERROR_CODES.has(name)) {
      return false;
    }

    const message = typeof record.message === 'string' ? record.message : '';
    if (message && NON_RETRYABLE_MESSAGE_PATTERN.test(message)) {
      return false;
    }

    cursor = record.cause;
  }

  // Pass 2: accept known transient HTTP, socket, DNS, or timeout failures
  let current: unknown = error;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 6 && current != null && !seen.has(current); depth++) {
    seen.add(current);

    if (typeof current === 'string') {
      if (RETRYABLE_MESSAGE_PATTERN.test(current)) return true;
      break;
    }
    if (typeof current !== 'object') break;

    const record = current as Record<string, unknown>;
    if (record.retryable === true || record.isTimeout === true) return true;

    const status =
      typeof record.status === 'number'
        ? record.status
        : typeof record.statusCode === 'number'
          ? record.statusCode
          : undefined;
    if (status !== undefined && RETRYABLE_HTTP_STATUSES.has(status)) {
      return true;
    }

    const code = typeof record.code === 'string' ? record.code : '';
    const name = typeof record.name === 'string' ? record.name : '';
    if (RETRYABLE_ERROR_CODES.has(code) || RETRYABLE_ERROR_NAMES.has(name)) {
      return true;
    }

    const message = typeof record.message === 'string' ? record.message : '';
    if (message && RETRYABLE_MESSAGE_PATTERN.test(message)) {
      return true;
    }

    current = record.cause;
  }

  return false;
};

const computeRetryDelayMs = (
  baseDelayMs: number,
  jitterOption: boolean | number | undefined,
  error: unknown,
): number => {
  let delay = Math.max(0, baseDelayMs);
  if (delay > 0) {
    const ratio =
      jitterOption === false
        ? 0
        : typeof jitterOption === 'number' && Number.isFinite(jitterOption)
          ? Math.min(1, Math.max(0, jitterOption))
          : DEFAULT_RETRY_JITTER_RATIO;
    if (ratio > 0) {
      const factor = 1 - ratio + Math.random() * (2 * ratio);
      delay = Math.round(delay * factor);
    }
  }

  const retryAfterMs =
    error && typeof error === 'object'
      ? (error as Partial<HttpStatusError>).retryAfterMs
      : undefined;
  if (typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
    return Math.min(MAX_RETRY_AFTER_MS, Math.max(delay, retryAfterMs));
  }

  return delay;
};

const sleepMs = (ms: number, signal?: AbortSignal): Promise<void> => {
  if (signal?.aborted) {
    return Promise.reject(createCallerAbortError(signal.reason));
  }
  if (ms <= 0) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(createCallerAbortError(signal?.reason));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
};

const awaitInFlightWithCallerSignal = <T>(
  entry: InFlightImageLoad,
  callerSignal?: AbortSignal,
  onAllWaitersAborted?: () => void,
): Promise<T> => {
  if (!callerSignal) {
    return entry.promise as Promise<T>;
  }
  if (callerSignal.aborted) {
    entry.activeWaiters = Math.max(0, entry.activeWaiters - 1);
    if (entry.activeWaiters === 0) {
      onAllWaitersAborted?.();
      if (entry.sharedController && !entry.sharedController.signal.aborted) {
        entry.sharedController.abort(callerSignal.reason);
      }
    }
    return Promise.reject(createCallerAbortError(callerSignal.reason));
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      entry.activeWaiters = Math.max(0, entry.activeWaiters - 1);
      if (entry.activeWaiters === 0) {
        onAllWaitersAborted?.();
        if (entry.sharedController && !entry.sharedController.signal.aborted) {
          entry.sharedController.abort(callerSignal.reason);
        }
      }
      reject(createCallerAbortError(callerSignal.reason));
    };

    callerSignal.addEventListener('abort', onAbort, { once: true });

    (entry.promise as Promise<T>).then(
      (val) => {
        if (settled) return;
        settled = true;
        callerSignal.removeEventListener('abort', onAbort);
        resolve(val);
      },
      (err) => {
        if (settled) return;
        settled = true;
        callerSignal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
};

const fetchServerImageOnce = async (
  targetUrl: string,
  timeoutMs: number,
  keyForMime: string,
  detectImageMimeType: (
    buf: Buffer | Uint8Array,
    headerMime?: string | null,
    keyOrUrl?: string,
  ) => string,
  signal?: AbortSignal,
): Promise<ImageBase64Result> => {
  if (signal?.aborted) {
    throw createCallerAbortError(signal.reason);
  }
  const { ssrfSafeFetch } = await import('@lobechat/ssrf-safe-fetch');
  const res = await ssrfSafeFetch(targetUrl, signal ? { signal, timeoutMs } : { timeoutMs });
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
  if (options?.signal?.aborted) {
    throw createCallerAbortError(options.signal.reason);
  }

  const mirror = await import('./arckepMediaMirror');
  const rawOwnKey = mirror.extractOwnBucketKey(imageUrl);
  const isAuthorizedOwnKey = rawOwnKey ? await mirror.isAuthorizedOwnBucketUrl(imageUrl) : false;
  if (options?.signal?.aborted) {
    throw createCallerAbortError(options.signal.reason);
  }
  const trustedOwnKey = isAuthorizedOwnKey ? rawOwnKey : null;
  const cacheKey = mirror.buildServerImageCacheKey(imageUrl, trustedOwnKey);

  const cached = getCachedImage(cacheKey);
  if (cached) return cached;

  const existingInFlight = inFlightImageLoads.get(cacheKey);
  if (existingInFlight && !existingInFlight.sharedController?.signal.aborted) {
    existingInFlight.activeWaiters += 1;
    return awaitInFlightWithCallerSignal<ImageBase64Result>(
      existingInFlight,
      options?.signal,
      () => {
        if (inFlightImageLoads.get(cacheKey) === existingInFlight) {
          inFlightImageLoads.delete(cacheKey);
        }
      },
    );
  }

  const sharedController = options?.signal ? new AbortController() : undefined;
  const sharedSignal = sharedController?.signal;
  const maxEntryBytes = options?.maxCacheEntryBytes ?? SERVER_IMAGE_CACHE_MAX_ENTRY_BYTES;

  const loadPromise = (async (): Promise<ImageBase64Result> => {
    const isAlreadyMediaUrl = mirror.isMediaPublicUrl(imageUrl);
    const isOwnS3Host = Boolean(rawOwnKey) && !isAlreadyMediaUrl;
    const timeoutMs = options?.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    const retryDelays = options?.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    const maxAttempts = retryDelays.length + 1;
    const mimeHint = rawOwnKey || imageUrl;

    // 1. Mirror-first ONLY for authorized own-bucket URLs (0 network calls, ~0.2ms)
    if (trustedOwnKey) {
      const mirrored = await mirror.readLocalMirrorFile(trustedOwnKey);
      if (mirrored && mirrored.buffer.length > 0) {
        const result: ImageBase64Result = {
          base64: mirrored.buffer.toString('base64'),
          mimeType: mirrored.mimeType,
        };
        setCachedImage(cacheKey, result, maxEntryBytes);
        return result;
      }
    }

    // 2. If our S3 outage breaker is already open, try signed media.arckep.ru first
    let triedMediaFallback = false;
    const s3BreakerInitiallyOpen = isOwnS3Host && mirror.isS3BreakerOpen();
    if (s3BreakerInitiallyOpen && trustedOwnKey) {
      triedMediaFallback = true;
      const mediaUrl = await mirror.signMediaUrlViaStudio(trustedOwnKey);
      if (mediaUrl) {
        try {
          const result = await fetchServerImageOnce(
            mediaUrl,
            timeoutMs,
            mimeHint,
            mirror.detectImageMimeType,
            sharedSignal,
          );
          setCachedImage(cacheKey, result, maxEntryBytes);
          return result;
        } catch (mediaErr) {
          if (isCallerAbortChain(mediaErr) || sharedSignal?.aborted) {
            throw mediaErr;
          }
          console.warn(
            `[imageUrlToBase64] media fallback failed while S3 breaker open for ${trustedOwnKey}:`,
            mediaErr,
          );
        }
      }
    }

    // 3. Hardened HTTP fetch with timeout, res.ok check, bounded jittered retries, and Retry-After.
    // When S3 breaker was already open and Step 2 could not serve from mirror/media, cap to 1 fast probe.
    const effectiveMaxAttempts = s3BreakerInitiallyOpen ? 1 : maxAttempts;
    const effectiveTimeoutMs = s3BreakerInitiallyOpen
      ? Math.min(timeoutMs, BREAKER_OPEN_PROBE_TIMEOUT_MS)
      : timeoutMs;

    let lastError: unknown;
    for (let attempt = 0; attempt < effectiveMaxAttempts; attempt++) {
      if (sharedSignal?.aborted) {
        throw createCallerAbortError(sharedSignal.reason);
      }
      try {
        const result = await fetchServerImageOnce(
          imageUrl,
          effectiveTimeoutMs,
          mimeHint,
          mirror.detectImageMimeType,
          sharedSignal,
        );
        if (isOwnS3Host) {
          mirror.recordS3Success();
        }
        setCachedImage(cacheKey, result, maxEntryBytes);
        return result;
      } catch (error) {
        lastError = error;
        if (isCallerAbortChain(error) || sharedSignal?.aborted) {
          throw error;
        }
        if (isOwnS3Host) {
          mirror.recordS3Failure(error);
        }
        if (!isRetryableImageFetchError(error) || attempt >= effectiveMaxAttempts - 1) {
          break;
        }
        const delayMs = computeRetryDelayMs(retryDelays[attempt] ?? 0, options?.jitter, error);
        await sleepMs(delayMs, sharedSignal);
      }
    }

    // 4. Fallback for authorized own S3 keys: re-check mirror, then signed media.arckep.ru
    if (isOwnS3Host && trustedOwnKey && !sharedSignal?.aborted) {
      const mirroredAfterFailure = await mirror.readLocalMirrorFile(trustedOwnKey);
      if (mirroredAfterFailure && mirroredAfterFailure.buffer.length > 0) {
        const result: ImageBase64Result = {
          base64: mirroredAfterFailure.buffer.toString('base64'),
          mimeType: mirroredAfterFailure.mimeType,
        };
        setCachedImage(cacheKey, result, maxEntryBytes);
        return result;
      }

      if (!triedMediaFallback) {
        const mediaUrl = await mirror.signMediaUrlViaStudio(trustedOwnKey);
        if (mediaUrl) {
          try {
            const result = await fetchServerImageOnce(
              mediaUrl,
              timeoutMs,
              mimeHint,
              mirror.detectImageMimeType,
              sharedSignal,
            );
            setCachedImage(cacheKey, result, maxEntryBytes);
            return result;
          } catch (fallbackError) {
            if (isCallerAbortChain(fallbackError) || sharedSignal?.aborted) {
              throw fallbackError;
            }
            console.warn(
              `[imageUrlToBase64] media.arckep.ru fallback failed for ${trustedOwnKey}:`,
              fallbackError,
            );
          }
        }
      }
    }

    throw lastError;
  })();

  const entry: InFlightImageLoad = {
    activeWaiters: 1,
    promise: loadPromise,
    sharedController,
  };
  inFlightImageLoads.set(cacheKey, entry);

  // Clean up map entry once the underlying load settles, regardless of individual caller aborts
  loadPromise.then(
    () => {
      if (inFlightImageLoads.get(cacheKey) === entry) {
        inFlightImageLoads.delete(cacheKey);
      }
    },
    () => {
      if (inFlightImageLoads.get(cacheKey) === entry) {
        inFlightImageLoads.delete(cacheKey);
      }
    },
  );

  return awaitInFlightWithCallerSignal<ImageBase64Result>(entry, options?.signal, () => {
    if (inFlightImageLoads.get(cacheKey) === entry) {
      inFlightImageLoads.delete(cacheKey);
    }
  });
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

    const res = options?.signal
      ? await fetch(imageUrl, { signal: options.signal })
      : await fetch(imageUrl);
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
