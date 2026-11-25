import type * as FsPromises from 'node:fs/promises';
import type pathModule from 'node:path';

/**
 * Arckep S3 local mirror, MIME detection, outage circuit breaker, and
 * Studio loopback media.arckep.ru URL signer.
 *
 * Node builtins (`node:fs/promises`, `node:path`) are loaded lazily inside
 * server-only code paths so browser bundlers (Turbopack/Webpack) never pull
 * them into client chunks.
 */

const MAX_KEY_UTF8_BYTES = 1024;
const DEFAULT_MEDIA_PUBLIC_BASE = 'https://media.arckep.ru';
const DEFAULT_BACKEND_INTERNAL_URL = 'http://127.0.0.1:8202';
const STUDIO_SIGN_TIMEOUT_MS = 2000;
const MEDIA_URL_CACHE_MAX_ENTRIES = 2048;
const MEDIA_URL_CACHE_MAX_TTL_MS = 30 * 60 * 1000;
const MEDIA_URL_CACHE_SAFETY_MARGIN_MS = 60 * 1000;
const MIN_MEDIA_EXPIRES_IN = 300;
const MAX_MEDIA_EXPIRES_IN = 86_400;
const DEFAULT_MEDIA_EXPIRES_IN = 7200;

const S3_BREAKER_FAILURE_THRESHOLD = 3;
const S3_BREAKER_OPEN_WINDOW_MS = 60 * 1000;

const DEFAULT_IMAGESTUDIO_MIRROR_ROOTS = ['/srv/s3-mirror/imagestudio', '/srv/s3-mirror/spool'];

const GENERIC_MIME_TYPES = new Set(['', 'application/octet-stream', 'binary/octet-stream']);

const EXTENSION_MIME_MAP: Record<string, string> = {
  '.aac': 'audio/aac',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.flac': 'audio/flac',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.jfif': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.m4a': 'audio/mp4',
  '.m4v': 'video/x-m4v',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
};

const NON_OUTAGE_S3_CODES = new Set([
  'AccessDenied',
  'BadRequest',
  'Forbidden',
  'InvalidAccessKeyId',
  'InvalidArgument',
  'NoSuchBucket',
  'NoSuchKey',
  'NotFound',
  'SignatureDoesNotMatch',
]);

const OUTAGE_ERROR_CODES = new Set([
  'EAI_AGAIN',
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

const OUTAGE_ERROR_NAMES = new Set([
  'AbortError',
  'FetchError',
  'InternalError',
  'NetworkingError',
  'RequestTimeout',
  'ServiceUnavailable',
  'SlowDown',
  'TimeoutError',
]);

const OUTAGE_MESSAGE_PATTERN =
  /econnreset|etimedout|epipe|econnrefused|enotfound|eai_again|socket hang up|timed out|timeout|service unavailable|slowdown|internalerror|networkingerror|requesttimeout|fetcherror|network error|http\s+(?:408|429|5\d{2})\b/i;

const textEncoder = new TextEncoder();

interface NodeBuiltins {
  fs: typeof FsPromises;
  path: typeof pathModule;
}

let cachedNodeBuiltinsPromise: Promise<NodeBuiltins | null> | null = null;

const loadNodeFsAndPath = async (): Promise<NodeBuiltins | null> => {
  if (typeof window !== 'undefined' || typeof process === 'undefined') return null;

  if (!cachedNodeBuiltinsPromise) {
    cachedNodeBuiltinsPromise = (async () => {
      const getBuiltinModule = (
        process as unknown as { getBuiltinModule?: (id: string) => unknown }
      ).getBuiltinModule;

      if (typeof getBuiltinModule === 'function') {
        const fs = getBuiltinModule('node:fs/promises') as typeof FsPromises | undefined;
        const path = getBuiltinModule('node:path') as typeof pathModule | undefined;
        if (fs && path) return { fs, path };
      }

      try {
        const fsSpec = ['node', 'fs/promises'].join(':');
        const pathSpec = ['node', 'path'].join(':');
        const [fs, rawPath] = await Promise.all([
          import(/* webpackIgnore: true */ fsSpec) as Promise<typeof FsPromises>,
          // eslint-disable-next-line unicorn/import-style
          import(/* webpackIgnore: true */ pathSpec) as Promise<
            typeof pathModule & { default?: typeof pathModule }
          >,
        ]);
        const path = rawPath.default ?? rawPath;
        return { fs, path };
      } catch {
        return null;
      }
    })();
  }

  return cachedNodeBuiltinsPromise;
};

const parseUrlLike = (raw: string): URL | null => {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(withScheme);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed;
  } catch {
    return null;
  }
};

/**
 * Validates and normalizes a relative S3 object key.
 * Rejects absolute paths, traversal segments (`.`, `..`), empty segments (`//`, trailing `/`),
 * backslashes, control characters, lone surrogates, and keys exceeding 1024 UTF-8 bytes.
 */
export const normalizeSafeStorageKey = (key: string): string | null => {
  if (typeof key !== 'string' || key.length === 0) return null;
  const wellFormed = (key as { isWellFormed?: () => boolean }).isWellFormed;
  if (typeof wellFormed === 'function' && !wellFormed.call(key)) return null;
  if (textEncoder.encode(key).byteLength > MAX_KEY_UTF8_BYTES) return null;
  if (key.startsWith('/')) return null;

  for (let i = 0; i < key.length; i++) {
    const code = key.charCodeAt(i);
    if (code < 0x20 || code === 0x7f || code === 0x5c) {
      return null;
    }
  }

  const parts = key.split('/');
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..') return null;
  }

  return key;
};

const decodeRestAsSafeKey = (rawRest: string): string | null => {
  if (!rawRest) return null;
  try {
    const decoded = decodeURIComponent(rawRest);
    return normalizeSafeStorageKey(decoded);
  } catch {
    return null;
  }
};

/**
 * Checks raw URL pathname before WHATWG `new URL()` collapses `.` / `..` / `%2e%2e` dot-segments.
 */
const hasRawUnsafePathSegment = (rawUrl: string): boolean => {
  const afterScheme = rawUrl.indexOf('://');
  if (afterScheme < 0) return true;
  const pathStart = rawUrl.indexOf('/', afterScheme + 3);
  if (pathStart < 0) return true;

  const rest = rawUrl.slice(pathStart);
  const endIdx = rest.search(/[?#]/);
  const rawPath = endIdx >= 0 ? rest.slice(0, endIdx) : rest;
  if (rawPath.includes('\\')) return true;

  const segments = rawPath.slice(1).split('/');
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') return true;
    try {
      const decoded = decodeURIComponent(seg);
      if (decoded.includes('\\')) return true;
      for (const part of decoded.split('/')) {
        if (part === '' || part === '.' || part === '..') return true;
      }
    } catch {
      return true;
    }
  }

  return false;
};

const getMediaBaseUrl = (): URL | null =>
  parseUrlLike(process.env.MEDIA_PUBLIC_BASE || DEFAULT_MEDIA_PUBLIC_BASE);

/**
 * Returns true if the URL targets our signed media host (`MEDIA_PUBLIC_BASE` / `media.arckep.ru`)
 * under its `/m/<key>` prefix.
 */
export const isMediaPublicUrl = (url: string): boolean => {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (parsed.username || parsed.password) return false;

  const mediaBase = getMediaBaseUrl();
  if (!mediaBase) return false;
  if (parsed.host.toLowerCase() !== mediaBase.host.toLowerCase()) return false;

  const basePath = mediaBase.pathname.replace(/\/+$/, '');
  return parsed.pathname.startsWith(`${basePath}/m/`);
};

/**
 * Extracts and URL-decodes a safe storage key ONLY when the URL belongs to:
 * 1. Our media host (`MEDIA_PUBLIC_BASE || https://media.arckep.ru`, path `/m/<key>`)
 * 2. Our S3 bucket (`S3_ENDPOINT` + `S3_BUCKET`, path-style or virtual-hosted-style)
 * 3. `S3_PUBLIC_DOMAIN` or `NEXT_PUBLIC_S3_DOMAIN`
 *
 * Never matches arbitrary external URLs.
 */
export const extractOwnBucketKey = (url: string): string | null => {
  if (typeof url !== 'string' || !url) return null;
  if (hasRawUnsafePathSegment(url)) return null;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password) return null;

  const targetHost = parsed.host.toLowerCase();

  // 1. Our media host: <MEDIA_PUBLIC_BASE>/m/<key>
  const mediaBase = getMediaBaseUrl();
  if (mediaBase && targetHost === mediaBase.host.toLowerCase()) {
    const basePath = mediaBase.pathname.replace(/\/+$/, '');
    const prefix = `${basePath}/m/`;
    if (parsed.pathname.startsWith(prefix)) {
      return decodeRestAsSafeKey(parsed.pathname.slice(prefix.length));
    }
    return null;
  }

  const bucket = process.env.S3_BUCKET?.trim() || '';
  const endpointRaw = process.env.S3_ENDPOINT?.trim() || '';
  const endpointUrl = endpointRaw ? parseUrlLike(endpointRaw) : null;

  // 2. S3_ENDPOINT + S3_BUCKET (path-style and virtual-hosted-style)
  if (bucket && endpointUrl) {
    const endpointHost = endpointUrl.host.toLowerCase();
    const endpointPath = endpointUrl.pathname.replace(/\/+$/, '');

    // Path-style: https://storage.yandexcloud.net/<bucket>/<key>
    if (targetHost === endpointHost) {
      const bucketPrefix = `${endpointPath}/${bucket}/`;
      if (parsed.pathname.startsWith(bucketPrefix)) {
        return decodeRestAsSafeKey(parsed.pathname.slice(bucketPrefix.length));
      }
    }

    // Virtual-hosted-style: https://<bucket>.storage.yandexcloud.net/<key>
    const virtualHost = `${bucket.toLowerCase()}.${endpointHost}`;
    if (targetHost === virtualHost && parsed.pathname.startsWith('/')) {
      return decodeRestAsSafeKey(parsed.pathname.slice(1));
    }
  }

  // 3. S3_PUBLIC_DOMAIN / NEXT_PUBLIC_S3_DOMAIN
  const publicDomains = [process.env.S3_PUBLIC_DOMAIN, process.env.NEXT_PUBLIC_S3_DOMAIN].filter(
    (d): d is string => typeof d === 'string' && d.trim().length > 0,
  );

  for (const rawDomain of publicDomains) {
    const domainUrl = parseUrlLike(rawDomain);
    if (!domainUrl) continue;

    const domainHost = domainUrl.host.toLowerCase();
    if (targetHost !== domainHost) continue;

    const domainPath = domainUrl.pathname.replace(/\/+$/, '');
    if (domainPath) {
      const prefix = `${domainPath}/`;
      if (parsed.pathname.startsWith(prefix)) {
        return decodeRestAsSafeKey(parsed.pathname.slice(prefix.length));
      }
      continue;
    }

    // Domain has no path component.
    // If this host is also S3_ENDPOINT and bucket is known, require /<bucket>/<key>
    // so other buckets on the same S3 host are never matched.
    if (bucket && endpointUrl && domainHost === endpointUrl.host.toLowerCase()) {
      const bucketPrefix = `/${bucket}/`;
      if (parsed.pathname.startsWith(bucketPrefix)) {
        return decodeRestAsSafeKey(parsed.pathname.slice(bucketPrefix.length));
      }
      continue;
    }

    if (bucket && process.env.S3_ENABLE_PATH_STYLE === '1') {
      const bucketPrefix = `/${bucket}/`;
      if (parsed.pathname.startsWith(bucketPrefix)) {
        return decodeRestAsSafeKey(parsed.pathname.slice(bucketPrefix.length));
      }
      continue;
    }

    if (parsed.pathname.startsWith('/')) {
      return decodeRestAsSafeKey(parsed.pathname.slice(1));
    }
  }

  return null;
};

const detectRasterMagicMime = (buf: Uint8Array): string | null => {
  // PNG: 89 50 4E 47 0D 0A 1A 0A
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

  // JPEG: FF D8 FF
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }

  // WebP: RIFF....WEBP
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

  // GIF87a / GIF89a
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

  return null;
};

const detectIsoBmffMagicMime = (buf: Uint8Array): string | null => {
  // ISO BMFF box header: <4-byte size> "ftyp" <4-byte major brand>
  if (buf.length < 12 || buf[4] !== 0x66 || buf[5] !== 0x74 || buf[6] !== 0x79 || buf[7] !== 0x70) {
    return null;
  }

  const brand = String.fromCharCode(buf[8], buf[9], buf[10], buf[11]);
  switch (brand) {
    case 'avif':
    case 'avis': {
      return 'image/avif';
    }
    case 'heic':
    case 'heix':
    case 'hevc':
    case 'hevx': {
      return 'image/heic';
    }
    case 'mif1':
    case 'msf1':
    case 'heif': {
      return 'image/heif';
    }
    case 'isom':
    case 'iso2':
    case 'mp41':
    case 'mp42':
    case 'avc1':
    case 'mp71': {
      return 'video/mp4';
    }
    case 'qt  ': {
      return 'video/quicktime';
    }
    default: {
      return null;
    }
  }
};

const detectExtensionMime = (keyOrUrl?: string): string | null => {
  if (!keyOrUrl) return null;
  const withoutQuery = keyOrUrl.split(/[?#]/, 1)[0];
  const lastSlash = withoutQuery.lastIndexOf('/');
  const filename = lastSlash >= 0 ? withoutQuery.slice(lastSlash + 1) : withoutQuery;
  const lastDot = filename.lastIndexOf('.');
  if (lastDot <= 0) return null;
  const ext = filename.slice(lastDot).toLowerCase();
  return EXTENSION_MIME_MAP[ext] ?? null;
};

/**
 * Detects media MIME type safely:
 * - Preserves concrete non-generic HTTP header MIME types (never disguises `application/xml` or `text/html`).
 * - When header MIME is missing or generic (`application/octet-stream` / `binary/octet-stream`),
 *   detects unambiguous raster magic bytes (PNG/JPEG/WebP/GIF), then safe media extensions
 *   (images/video/audio), then ISO BMFF `ftyp` brand magic bytes for extensionless files.
 */
export const detectImageMimeType = (
  buf: Buffer | Uint8Array,
  headerMime?: string | null,
  keyOrUrl?: string,
): string => {
  const normalizedHeader = headerMime ? headerMime.split(';', 1)[0].trim().toLowerCase() : '';
  if (normalizedHeader && !GENERIC_MIME_TYPES.has(normalizedHeader)) {
    return normalizedHeader;
  }

  const magicMime = detectRasterMagicMime(buf);
  if (magicMime) return magicMime;

  const extMime = detectExtensionMime(keyOrUrl);
  if (extMime) return extMime;

  const bmffMime = detectIsoBmffMagicMime(buf);
  if (bmffMime) return bmffMime;

  return 'application/octet-stream';
};

const getMirrorRoots = (): string[] => {
  const explicitMirror = process.env.S3_LOCAL_MIRROR_DIR;
  const explicitSpool = process.env.S3_LOCAL_SPOOL_DIR;

  if (explicitMirror !== undefined || explicitSpool !== undefined) {
    const roots: string[] = [];
    if (explicitMirror?.trim()) roots.push(explicitMirror.trim());
    if (explicitSpool?.trim()) roots.push(explicitSpool.trim());
    return roots;
  }

  if (
    process.env.S3_BUCKET === 'imagestudio' &&
    !process.env.VITEST &&
    process.env.NODE_ENV !== 'test'
  ) {
    return DEFAULT_IMAGESTUDIO_MIRROR_ROOTS;
  }

  return [];
};

/**
 * Reads an immutable object directly from the local netcup S3 mirror/spool if available.
 * Enforces key validation and `realpath` containment to prevent traversal and symlink escapes.
 */
export const readLocalMirrorFile = async (
  key: string,
): Promise<{ buffer: Buffer; mimeType: string } | null> => {
  const safeKey = normalizeSafeStorageKey(key);
  if (!safeKey) return null;

  const roots = getMirrorRoots();
  if (roots.length === 0) return null;

  const nodeBuiltins = await loadNodeFsAndPath();
  if (!nodeBuiltins) return null;

  const { fs, path } = nodeBuiltins;
  const segments = safeKey.split('/');

  for (const root of roots) {
    try {
      const realRoot = await fs.realpath(root);
      const rootPrefix = realRoot.endsWith(path.sep) ? realRoot : `${realRoot}${path.sep}`;
      const candidate = path.resolve(realRoot, ...segments);
      if (!candidate.startsWith(rootPrefix)) continue;

      const realCandidate = await fs.realpath(candidate);
      if (!realCandidate.startsWith(rootPrefix)) continue;

      const fileStat = await fs.stat(realCandidate);
      if (!fileStat.isFile()) continue;

      const buffer = await fs.readFile(realCandidate);
      return {
        buffer,
        mimeType: detectImageMimeType(buffer, undefined, safeKey),
      };
    } catch {
      continue;
    }
  }

  return null;
};

// ---------------------------------------------------------------------------
// Per-process S3 outage circuit breaker
// ---------------------------------------------------------------------------

let consecutiveS3Failures = 0;
let s3BreakerOpenUntil = 0;

const extractHttpStatus = (obj: Record<string, unknown>): number | undefined => {
  const direct = obj.status ?? obj.statusCode;
  if (typeof direct === 'number' && Number.isFinite(direct)) return direct;

  const metadata = obj.$metadata as Record<string, unknown> | undefined;
  if (metadata && typeof metadata.httpStatusCode === 'number') {
    return metadata.httpStatusCode;
  }
  return undefined;
};

/**
 * Identifies transient network/timeout/5xx/408/429/S3 outage errors.
 * Explicitly returns false for client errors (400/401/403/404, `NoSuchKey`, SSRF blocks).
 */
export const isS3OutageError = (error: unknown): boolean => {
  let current: unknown = error;
  const seen = new Set<unknown>();

  for (let depth = 0; depth < 5 && current != null && !seen.has(current); depth++) {
    seen.add(current);

    if (typeof current === 'string') {
      if (current.includes('SSRF blocked')) return false;
      if (OUTAGE_MESSAGE_PATTERN.test(current)) return true;
      break;
    }

    if (typeof current !== 'object') break;

    const record = current as Record<string, unknown>;
    const message = typeof record.message === 'string' ? record.message : '';
    if (message.includes('SSRF blocked')) return false;

    const code =
      typeof record.code === 'string'
        ? record.code
        : typeof record.Code === 'string'
          ? record.Code
          : '';
    const name = typeof record.name === 'string' ? record.name : '';

    if (NON_OUTAGE_S3_CODES.has(code) || NON_OUTAGE_S3_CODES.has(name)) {
      return false;
    }

    const status = extractHttpStatus(record);
    if (status !== undefined) {
      if (status === 408 || status === 429 || (status >= 500 && status <= 599)) {
        return true;
      }
      if (status >= 400 && status < 500) {
        return false;
      }
    }

    if (OUTAGE_ERROR_CODES.has(code) || OUTAGE_ERROR_NAMES.has(name)) {
      return true;
    }

    if (message && OUTAGE_MESSAGE_PATTERN.test(message)) {
      return true;
    }

    current = record.cause;
  }

  return false;
};

export const recordS3Success = (): void => {
  consecutiveS3Failures = 0;
  s3BreakerOpenUntil = 0;
};

export const recordS3Failure = (error: unknown, now = Date.now()): boolean => {
  if (!isS3OutageError(error)) return false;

  consecutiveS3Failures += 1;
  if (consecutiveS3Failures >= S3_BREAKER_FAILURE_THRESHOLD) {
    s3BreakerOpenUntil = now + S3_BREAKER_OPEN_WINDOW_MS;
  }
  return true;
};

export const isS3BreakerOpen = (now = Date.now()): boolean => s3BreakerOpenUntil > now;

export const resetS3BreakerForTest = (): void => {
  consecutiveS3Failures = 0;
  s3BreakerOpenUntil = 0;
};

// ---------------------------------------------------------------------------
// Studio loopback media URL signer (`POST /api/chat-engine/internal/media-urls`)
// ---------------------------------------------------------------------------

interface CachedMediaUrlEntry {
  cacheUntil: number;
  url: string;
}

const mediaUrlCache = new Map<string, CachedMediaUrlEntry>();

const setCachedMediaUrl = (cacheKey: string, entry: CachedMediaUrlEntry): void => {
  if (mediaUrlCache.has(cacheKey)) {
    mediaUrlCache.delete(cacheKey);
  } else if (mediaUrlCache.size >= MEDIA_URL_CACHE_MAX_ENTRIES) {
    const oldestKey = mediaUrlCache.keys().next().value;
    if (oldestKey !== undefined) {
      mediaUrlCache.delete(oldestKey);
    }
  }
  mediaUrlCache.set(cacheKey, entry);
};

export const clearMediaUrlCacheForTest = (): void => {
  mediaUrlCache.clear();
};

/**
 * Requests a signed `media.arckep.ru/m/<key>?exp=&sig=` URL from the local Studio backend.
 * Caches signed URLs in memory until `min(exp - 60s, now + 30m)`. Never throws.
 */
export const signMediaUrlViaStudio = async (
  key: string,
  expiresIn?: number,
): Promise<string | null> => {
  const safeKey = normalizeSafeStorageKey(key);
  if (!safeKey) return null;

  const token = (process.env.ARCKEP_INTERNAL_TOKEN || process.env.LOBECHAT_BACKEND_KEY)?.trim();
  if (!token) return null;

  const requestedExpires =
    typeof expiresIn === 'number' && Number.isFinite(expiresIn)
      ? Math.trunc(expiresIn)
      : DEFAULT_MEDIA_EXPIRES_IN;
  const clampedExpiresIn = Math.min(
    MAX_MEDIA_EXPIRES_IN,
    Math.max(MIN_MEDIA_EXPIRES_IN, requestedExpires),
  );

  const cacheKey = `${safeKey}:${clampedExpiresIn}`;
  const now = Date.now();
  const cached = mediaUrlCache.get(cacheKey);
  if (cached) {
    if (cached.cacheUntil > now) {
      // Refresh LRU position
      mediaUrlCache.delete(cacheKey);
      mediaUrlCache.set(cacheKey, cached);
      return cached.url;
    }
    mediaUrlCache.delete(cacheKey);
  }

  const baseUrl = (
    process.env.LOBECHAT_BACKEND_INTERNAL_URL || DEFAULT_BACKEND_INTERNAL_URL
  ).replace(/\/+$/, '');
  const endpoint = `${baseUrl}/api/chat-engine/internal/media-urls`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), STUDIO_SIGN_TIMEOUT_MS);

  try {
    const response = await fetch(endpoint, {
      body: JSON.stringify({
        expires_in: clampedExpiresIn,
        keys: [safeKey],
        only_if_mirrored: false,
      }),
      headers: {
        'Content-Type': 'application/json',
        'X-Arckep-Token': token,
      },
      method: 'POST',
      signal: controller.signal,
    });

    if (!response.ok) return null;

    const payload = (await response.json()) as { urls?: Record<string, string> } | null;
    const signedUrl = payload?.urls?.[safeKey];
    if (typeof signedUrl !== 'string' || !signedUrl) return null;

    const afterNow = Date.now();
    let cacheUntil =
      afterNow +
      Math.min(
        MEDIA_URL_CACHE_MAX_TTL_MS,
        Math.max(
          MEDIA_URL_CACHE_SAFETY_MARGIN_MS,
          clampedExpiresIn * 1000 - MEDIA_URL_CACHE_SAFETY_MARGIN_MS,
        ),
      );

    try {
      const parsedSigned = new URL(signedUrl);
      const expParam = Number(parsedSigned.searchParams.get('exp'));
      if (Number.isFinite(expParam) && expParam > 0) {
        cacheUntil = Math.min(
          expParam * 1000 - MEDIA_URL_CACHE_SAFETY_MARGIN_MS,
          afterNow + MEDIA_URL_CACHE_MAX_TTL_MS,
        );
      }
    } catch {
      // Keep fallback cacheUntil
    }

    if (cacheUntil > afterNow) {
      setCachedMediaUrl(cacheKey, { cacheUntil, url: signedUrl });
    }

    return signedUrl;
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
};
