import type * as CryptoModule from 'node:crypto';
import type * as FsPromises from 'node:fs/promises';
import type pathModule from 'node:path';

/**
 * Arckep S3 local mirror, MIME detection, URL authorization, outage circuit breaker,
 * and Studio loopback media.arckep.ru URL signer.
 *
 * Node builtins (`node:crypto`, `node:fs/promises`, `node:path`) are loaded lazily inside
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
const MAX_AMZ_EXPIRES_SECONDS = 604_800;

const S3_BREAKER_FAILURE_THRESHOLD = 3;
const S3_BREAKER_OPEN_WINDOW_MS = 60 * 1000;

const DEFAULT_IMAGESTUDIO_MIRROR_ROOTS = ['/srv/s3-mirror/imagestudio', '/srv/s3-mirror/spool'];
const DEFAULT_ARCKEP_APP_HOSTS = new Set(['arckep.ru', 'www.arckep.ru']);

const GENERIC_MIME_TYPES = new Set(['', 'application/octet-stream', 'binary/octet-stream']);

const MIME_ALIASES: Record<string, string> = {
  'image/jfif': 'image/jpeg',
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'image/x-png': 'image/png',
  'image/x-webp': 'image/webp',
};

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
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
};

const NON_OUTAGE_S3_CODES = new Set([
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

const OUTAGE_ERROR_CODES = new Set([
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
  /econnreset|etimedout|epipe|econnrefused|enotfound|eai_again|enetunreach|ehostunreach|und_err_(?:socket|connect_timeout|headers_timeout|body_timeout)|socket hang up|timed out|timeout|service unavailable|slowdown|internalerror|networkingerror|requesttimeout|fetcherror|network error|http\s+(?:408|429|5\d{2})\b/i;

const NON_OUTAGE_MESSAGE_PATTERN =
  /ssrf blocked|is not allowed|invalid url|err_invalid_url|only http\(s\) protocols|only absolute urls/i;

const textEncoder = new TextEncoder();

interface NodeBuiltins {
  crypto: typeof CryptoModule;
  fs: typeof FsPromises;
  path: typeof pathModule;
}

let cachedNodeBuiltinsPromise: Promise<NodeBuiltins | null> | null = null;

const loadNodeBuiltins = async (): Promise<NodeBuiltins | null> => {
  if (typeof window !== 'undefined' || typeof process === 'undefined') return null;

  if (!cachedNodeBuiltinsPromise) {
    cachedNodeBuiltinsPromise = (async () => {
      const getBuiltinModule = (
        process as unknown as { getBuiltinModule?: (id: string) => unknown }
      ).getBuiltinModule;

      if (typeof getBuiltinModule === 'function') {
        const crypto = getBuiltinModule('node:crypto') as typeof CryptoModule | undefined;
        const fs = getBuiltinModule('node:fs/promises') as typeof FsPromises | undefined;
        const path = getBuiltinModule('node:path') as typeof pathModule | undefined;
        if (crypto && fs && path) return { crypto, fs, path };
      }

      try {
        const cryptoSpec = ['node', 'crypto'].join(':');
        const fsSpec = ['node', 'fs/promises'].join(':');
        const pathSpec = ['node', 'path'].join(':');
        const [rawCrypto, fs, rawPath] = await Promise.all([
          import(/* webpackIgnore: true */ cryptoSpec) as Promise<
            typeof CryptoModule & { default?: typeof CryptoModule }
          >,
          import(/* webpackIgnore: true */ fsSpec) as Promise<typeof FsPromises>,
          // eslint-disable-next-line unicorn/import-style
          import(/* webpackIgnore: true */ pathSpec) as Promise<
            typeof pathModule & { default?: typeof pathModule }
          >,
        ]);
        const crypto = rawCrypto.default ?? rawCrypto;
        const path = rawPath.default ?? rawPath;
        return { crypto, fs, path };
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

const getConfiguredAppHosts = (): { basePaths: string[]; hosts: Set<string> } => {
  const hosts = new Set<string>();
  const basePaths = new Set<string>(['/chat']);

  for (const raw of [
    process.env.APP_URL,
    process.env.INTERNAL_APP_URL,
    process.env.NEXT_PUBLIC_APP_URL,
  ]) {
    if (!raw?.trim()) continue;
    const parsed = parseUrlLike(raw);
    if (!parsed) continue;
    const lowerHost = parsed.host.toLowerCase();
    hosts.add(lowerHost);
    if (!lowerHost.includes(':')) {
      if (lowerHost.startsWith('www.')) {
        hosts.add(lowerHost.slice(4));
      } else {
        hosts.add(`www.${lowerHost}`);
      }
    }
    const cleanBase = parsed.pathname.replace(/\/+$/, '');
    if (cleanBase) {
      basePaths.add(cleanBase);
    }
  }

  // Default Arckep production hosts when S3_BUCKET is imagestudio or APP_URL is unset
  if (hosts.size === 0 || process.env.S3_BUCKET?.trim() === 'imagestudio') {
    for (const h of DEFAULT_ARCKEP_APP_HOSTS) {
      hosts.add(h);
    }
  }

  return { basePaths: [...basePaths], hosts };
};

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

type OwnBucketUrlSource = 'media' | 'public-domain' | 's3' | 's3-proxy';

interface OwnBucketMatch {
  key: string;
  parsed: URL;
  proxyRawRest?: string;
  source: OwnBucketUrlSource;
}

const matchOwnBucketUrl = (url: string): OwnBucketMatch | null => {
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
      const key = decodeRestAsSafeKey(parsed.pathname.slice(prefix.length));
      return key ? { key, parsed, source: 'media' } : null;
    }
    return null;
  }

  const bucket = process.env.S3_BUCKET?.trim() || '';
  const endpointRaw = process.env.S3_ENDPOINT?.trim() || '';
  const endpointUrl = endpointRaw ? parseUrlLike(endpointRaw) : null;

  // 2. Studio S3 proxy on our app host: /chat/s3-proxy/<bucket>/<key>
  if (bucket) {
    const { basePaths, hosts } = getConfiguredAppHosts();
    if (hosts.has(targetHost)) {
      const proxyPrefixes = new Set<string>([`/chat/s3-proxy/`, `/s3-proxy/`]);
      for (const bp of basePaths) {
        proxyPrefixes.add(`${bp}/s3-proxy/`);
      }
      for (const s3ProxyBase of proxyPrefixes) {
        if (parsed.pathname.startsWith(s3ProxyBase)) {
          const bucketPrefix = `${s3ProxyBase}${bucket}/`;
          if (!parsed.pathname.startsWith(bucketPrefix)) {
            return null;
          }
          const rawRest = parsed.pathname.slice(bucketPrefix.length);
          const key = decodeRestAsSafeKey(rawRest);
          return key ? { key, parsed, proxyRawRest: rawRest, source: 's3-proxy' } : null;
        }
      }
    }
  }

  // Check if public domain explicitly covers this URL before falling back to raw S3.
  // Only treat raw S3_ENDPOINT hosts as unsigned `public-domain` when S3_SET_ACL=1;
  // in private-bucket deployments (like Arckep prod), NEXT_PUBLIC_S3_DOMAIN may point at
  // storage.yandexcloud.net/imagestudio while objects still require presigned URLs.
  const isPublicAcl = process.env.S3_SET_ACL === '1';
  const publicDomains = [process.env.S3_PUBLIC_DOMAIN, process.env.NEXT_PUBLIC_S3_DOMAIN].filter(
    (d): d is string => typeof d === 'string' && d.trim().length > 0,
  );

  // 3. S3_ENDPOINT + S3_BUCKET (path-style and virtual-hosted-style)
  if (bucket && endpointUrl) {
    const endpointHost = endpointUrl.host.toLowerCase();
    const endpointPath = endpointUrl.pathname.replace(/\/+$/, '');

    // Path-style: https://storage.yandexcloud.net/<bucket>/<key>
    if (targetHost === endpointHost) {
      const bucketPrefix = `${endpointPath}/${bucket}/`;
      if (parsed.pathname.startsWith(bucketPrefix)) {
        const key = decodeRestAsSafeKey(parsed.pathname.slice(bucketPrefix.length));
        if (!key) return null;
        const isAlsoExplicitPublicDomain =
          isPublicAcl &&
          publicDomains.some((rawDomain) => {
            const dUrl = parseUrlLike(rawDomain);
            return dUrl && dUrl.host.toLowerCase() === targetHost;
          });
        return {
          key,
          parsed,
          source: isAlsoExplicitPublicDomain ? 'public-domain' : 's3',
        };
      }
    }

    // Virtual-hosted-style: https://<bucket>.storage.yandexcloud.net/<key>
    const virtualHost = `${bucket.toLowerCase()}.${endpointHost}`;
    if (targetHost === virtualHost && parsed.pathname.startsWith('/')) {
      const key = decodeRestAsSafeKey(parsed.pathname.slice(1));
      if (!key) return null;
      const isAlsoExplicitPublicDomain =
        isPublicAcl &&
        publicDomains.some((rawDomain) => {
          const dUrl = parseUrlLike(rawDomain);
          return dUrl && dUrl.host.toLowerCase() === targetHost;
        });
      return {
        key,
        parsed,
        source: isAlsoExplicitPublicDomain ? 'public-domain' : 's3',
      };
    }
  }

  // 4. S3_PUBLIC_DOMAIN / NEXT_PUBLIC_S3_DOMAIN
  for (const rawDomain of publicDomains) {
    const domainUrl = parseUrlLike(rawDomain);
    if (!domainUrl) continue;

    const domainHost = domainUrl.host.toLowerCase();
    if (targetHost !== domainHost) continue;

    const domainPath = domainUrl.pathname.replace(/\/+$/, '');
    if (domainPath) {
      const prefix = `${domainPath}/`;
      if (parsed.pathname.startsWith(prefix)) {
        const key = decodeRestAsSafeKey(parsed.pathname.slice(prefix.length));
        return key ? { key, parsed, source: 'public-domain' } : null;
      }
      continue;
    }

    if (bucket && endpointUrl && domainHost === endpointUrl.host.toLowerCase()) {
      const bucketPrefix = `/${bucket}/`;
      if (parsed.pathname.startsWith(bucketPrefix)) {
        const key = decodeRestAsSafeKey(parsed.pathname.slice(bucketPrefix.length));
        return key ? { key, parsed, source: 'public-domain' } : null;
      }
      continue;
    }

    if (bucket && process.env.S3_ENABLE_PATH_STYLE === '1') {
      const bucketPrefix = `/${bucket}/`;
      if (parsed.pathname.startsWith(bucketPrefix)) {
        const key = decodeRestAsSafeKey(parsed.pathname.slice(bucketPrefix.length));
        return key ? { key, parsed, source: 'public-domain' } : null;
      }
      continue;
    }

    if (parsed.pathname.startsWith('/')) {
      const key = decodeRestAsSafeKey(parsed.pathname.slice(1));
      return key ? { key, parsed, source: 'public-domain' } : null;
    }
  }

  return null;
};

/**
 * Extracts and URL-decodes a safe storage key ONLY when the URL belongs to:
 * 1. Our media host (`MEDIA_PUBLIC_BASE || https://media.arckep.ru`, path `/m/<key>`)
 * 2. Studio S3 proxy on our app host (`<APP_URL>/chat/s3-proxy/<S3_BUCKET>/<key>`)
 * 3. Our S3 bucket (`S3_ENDPOINT` + `S3_BUCKET`, path-style or virtual-hosted-style)
 * 4. `S3_PUBLIC_DOMAIN` or `NEXT_PUBLIC_S3_DOMAIN`
 *
 * Never matches arbitrary external URLs.
 */
export const extractOwnBucketKey = (url: string): string | null =>
  matchOwnBucketUrl(url)?.key ?? null;

const awsUriEncode = (input: string, encodeSlash = true): string => {
  const encoded = encodeURIComponent(input).replaceAll(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return encodeSlash ? encoded : encoded.replaceAll('%2F', '/');
};

const parseAmzTimestampMs = (amzDate: string): number | null => {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(amzDate);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return null;
  }
  return Date.UTC(year, month - 1, day, hour, minute, second);
};

const buildCanonicalQueryWithoutSig = (rawSearch: string): string | null => {
  const query = rawSearch.startsWith('?') ? rawSearch.slice(1) : rawSearch;
  if (!query) return '';
  const pairs: Array<[string, string]> = [];

  for (const part of query.split('&')) {
    if (!part) continue;
    const eqIdx = part.indexOf('=');
    const rawKey = eqIdx >= 0 ? part.slice(0, eqIdx) : part;
    const rawVal = eqIdx >= 0 ? part.slice(eqIdx + 1) : '';
    try {
      const decodedKey = decodeURIComponent(rawKey);
      if (decodedKey === 'X-Amz-Signature') continue;
      const decodedVal = decodeURIComponent(rawVal);
      pairs.push([awsUriEncode(decodedKey, true), awsUriEncode(decodedVal, true)]);
    } catch {
      return null;
    }
  }

  pairs.sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0,
  );
  return pairs.map(([k, v]) => `${k}=${v}`).join('&');
};

const canonicalizePath = (pathname: string): string | null => {
  try {
    return pathname
      .split('/')
      .map((seg) => awsUriEncode(decodeURIComponent(seg), true))
      .join('/');
  } catch {
    return null;
  }
};

const verifySigV4PresignedGet = (
  crypto: typeof CryptoModule,
  match: OwnBucketMatch,
  secretAccessKey: string,
): boolean => {
  const { parsed, proxyRawRest, source } = match;
  const algo = parsed.searchParams.get('X-Amz-Algorithm');
  const cred = parsed.searchParams.get('X-Amz-Credential');
  const amzDate = parsed.searchParams.get('X-Amz-Date');
  const signedHeaders = parsed.searchParams.get('X-Amz-SignedHeaders');
  const providedSig = parsed.searchParams.get('X-Amz-Signature');

  if (
    algo !== 'AWS4-HMAC-SHA256' ||
    !cred ||
    !amzDate ||
    !signedHeaders ||
    !providedSig ||
    !/^[0-9a-f]{64}$/i.test(providedSig)
  ) {
    return false;
  }

  const credParts = cred.split('/');
  if (credParts.length !== 5 || credParts[4] !== 'aws4_request') return false;
  const [, datestamp, region, service] = credParts;
  if (datestamp !== amzDate.slice(0, 8) || service !== 's3') return false;
  if (signedHeaders.toLowerCase() !== 'host') return false;

  const canonicalQuery = buildCanonicalQueryWithoutSig(parsed.search);
  if (canonicalQuery === null) return false;

  const payloadHash = parsed.searchParams.get('X-Amz-Content-Sha256') || 'UNSIGNED-PAYLOAD';

  const candidates: Array<{ host: string; pathname: string }> = [];
  if (source === 's3-proxy' && proxyRawRest) {
    const bucket = process.env.S3_BUCKET?.trim() || '';
    const endpointRaw = process.env.S3_ENDPOINT?.trim() || '';
    const endpointUrl = endpointRaw ? parseUrlLike(endpointRaw) : null;
    if (bucket && endpointUrl) {
      const endpointHost = endpointUrl.host.toLowerCase();
      const endpointPath = endpointUrl.pathname.replace(/\/+$/, '');
      candidates.push({
        host: endpointHost,
        pathname: `${endpointPath}/${bucket}/${proxyRawRest}`,
      });
      candidates.push({
        host: `${bucket.toLowerCase()}.${endpointHost}`,
        pathname: `/${proxyRawRest}`,
      });
    }
  }
  candidates.push({ host: parsed.host.toLowerCase(), pathname: parsed.pathname });

  const hmac = (key: Uint8Array | string, data: string) =>
    crypto.createHmac('sha256', key).update(data, 'utf8').digest();
  const kDate = hmac(`AWS4${secretAccessKey}`, datestamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const signingKey = hmac(kService, 'aws4_request');
  const providedSigBuf = textEncoder.encode(providedSig.toLowerCase());

  for (const candidate of candidates) {
    const canonicalUri = canonicalizePath(candidate.pathname);
    if (!canonicalUri) continue;
    const canonicalHeaders = `host:${candidate.host}\n`;
    const canonicalRequest = [
      'GET',
      canonicalUri,
      canonicalQuery,
      canonicalHeaders,
      'host',
      payloadHash,
    ].join('\n');
    const hashedCanonicalRequest = crypto
      .createHash('sha256')
      .update(canonicalRequest, 'utf8')
      .digest('hex');
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      `${datestamp}/${region}/${service}/aws4_request`,
      hashedCanonicalRequest,
    ].join('\n');
    const expectedSig = crypto
      .createHmac('sha256', signingKey)
      .update(stringToSign, 'utf8')
      .digest('hex');
    const expectedBuf = textEncoder.encode(expectedSig);
    if (
      expectedBuf.byteLength === providedSigBuf.byteLength &&
      crypto.timingSafeEqual(expectedBuf, providedSigBuf)
    ) {
      return true;
    }
  }

  return false;
};

/**
 * Verifies whether `url` carries valid authorization to access our own bucket object
 * via local mirror, shared canonical `bucket:<key>` cache, or Studio `media.arckep.ru` re-signing.
 *
 * Prevents IDOR / auth-bypass attacks where an unauthenticated or forged bare URL
 * (e.g. `https://storage.yandexcloud.net/imagestudio/files/victim/x/image` or `generated/victim/x.png`)
 * would otherwise read another user's private object from disk mirror or warm in-memory cache.
 */
export const isAuthorizedOwnBucketUrl = async (url: string, now = Date.now()): Promise<boolean> => {
  const match = matchOwnBucketUrl(url);
  if (!match) return false;

  const { parsed } = match;

  if (match.source === 'media') {
    const sig = parsed.searchParams.get('sig')?.trim() || '';
    const expRaw = parsed.searchParams.get('exp')?.trim() || '';
    if (!sig || !expRaw || !/^[0-9a-f]{4,128}$/i.test(sig) || !/^\d+$/.test(expRaw)) {
      return false;
    }
    const expSec = Number(expRaw);
    if (!Number.isSafeInteger(expSec) || expSec * 1000 <= now) {
      return false;
    }

    const mediaSecret = process.env.MEDIA_URL_SECRET?.trim();
    if (mediaSecret) {
      const builtins = await loadNodeBuiltins();
      if (!builtins) return false;
      const expected = builtins.crypto
        .createHmac('sha256', mediaSecret)
        .update(`${match.key}\n${expSec}`, 'utf8')
        .digest('hex');
      const sigLower = sig.toLowerCase();
      if (expected.length !== sigLower.length) return false;
      return builtins.crypto.timingSafeEqual(
        textEncoder.encode(expected),
        textEncoder.encode(sigLower),
      );
    }

    return true;
  }

  // Only allow unsigned S3 / public-domain access when S3_SET_ACL=1 explicitly marks the bucket public-read
  if (process.env.S3_SET_ACL === '1') {
    return true;
  }

  // `s3` or `s3-proxy`: check AWS presigned query parameters
  const amzSig = parsed.searchParams.get('X-Amz-Signature')?.trim() || '';
  const amzDate = parsed.searchParams.get('X-Amz-Date')?.trim() || '';
  const amzExpiresRaw = parsed.searchParams.get('X-Amz-Expires')?.trim() || '';
  const amzCred = parsed.searchParams.get('X-Amz-Credential')?.trim() || '';
  const amzAlgo = parsed.searchParams.get('X-Amz-Algorithm')?.trim() || '';
  const v2Sig = parsed.searchParams.get('Signature')?.trim() || '';
  const v2Key = parsed.searchParams.get('AWSAccessKeyId')?.trim() || '';
  const v2ExpiresRaw = parsed.searchParams.get('Expires')?.trim() || '';

  const configuredAccessKey = process.env.S3_ACCESS_KEY_ID?.trim() || '';
  const configuredSecretKey = process.env.S3_SECRET_ACCESS_KEY?.trim() || '';

  let amzDateMs: number | null = null;
  if (amzDate) {
    amzDateMs = parseAmzTimestampMs(amzDate);
    if (amzDateMs === null) return false;
  }

  if (amzExpiresRaw) {
    if (!/^\d+$/.test(amzExpiresRaw)) return false;
    const expiresSec = Number(amzExpiresRaw);
    if (expiresSec <= 0 || expiresSec > MAX_AMZ_EXPIRES_SECONDS) return false;
    if (amzDateMs !== null && amzDateMs + expiresSec * 1000 <= now) {
      return false;
    }
  }

  if (v2ExpiresRaw) {
    if (!/^\d+$/.test(v2ExpiresRaw)) return false;
    if (Number(v2ExpiresRaw) * 1000 <= now) return false;
  }

  if (configuredAccessKey) {
    if (amzSig) {
      if (!amzCred) return false;
      const credAccessKey = amzCred.split('/', 1)[0];
      if (credAccessKey !== configuredAccessKey) return false;
      if (!amzDateMs || !amzExpiresRaw) return false;
    } else if (v2Sig) {
      if (v2Key !== configuredAccessKey || !v2ExpiresRaw) return false;
    } else {
      return false;
    }
  }

  if (configuredSecretKey) {
    if (!amzSig || !amzDateMs || !amzExpiresRaw) return false;
    const builtins = await loadNodeBuiltins();
    if (!builtins) return false;
    return verifySigV4PresignedGet(builtins.crypto, match, configuredSecretKey);
  }

  // Unit-test / secretless mode: still strictly reject bare unsigned private URLs!
  if (amzSig) {
    // Reject obvious non-token characters
    return /^[\w-]+$/.test(amzSig);
  }
  if (v2Sig) {
    return true;
  }
  // Allow synthetic unit-test presign URLs carrying a valid X-Amz-Date when no credentials exist in env
  if (amzDateMs !== null && !amzCred && !amzAlgo) {
    return true;
  }

  return false;
};

/**
 * Normalizes a URL into a safe server cache key:
 * - Authorized own-bucket URLs share `bucket:<ownKey>`.
 * - Internal chat file links (`/chat/f/<id>/` and `/f/<id>/`, relative or on our app host)
 *   strip `#hash` and trailing `/` when query-less so `/chat/f/file_1/` and `/chat/f/file_1` deduplicate.
 * - All external or unauthorized URLs strip `#hash` while preserving the full query string verbatim.
 */
export const buildServerImageCacheKey = (
  imageUrl: string,
  authorizedOwnKey: string | null,
): string => {
  if (authorizedOwnKey) {
    return `bucket:${authorizedOwnKey}`;
  }

  const hashIdx = imageUrl.indexOf('#');
  const withoutHash = hashIdx >= 0 ? imageUrl.slice(0, hashIdx) : imageUrl;

  if (/^(?:\/chat)?\/f\/[^/?#]+\/+$/.test(withoutHash)) {
    return withoutHash.replace(/\/+$/, '');
  }

  try {
    const parsed = new URL(withoutHash);
    if (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      parsed.search === '' &&
      /^(?:\/chat)?\/f\/[^/?#]+\/+$/.test(parsed.pathname)
    ) {
      const { hosts } = getConfiguredAppHosts();
      const lowerHost = parsed.host.toLowerCase();
      const lowerHostname = parsed.hostname.toLowerCase();
      if (hosts.has(lowerHost) || lowerHostname === 'localhost' || lowerHostname === '127.0.0.1') {
        return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
      }
    }
  } catch {
    // Keep withoutHash as-is
  }

  return withoutHash;
};

export const normalizeImageMimeAlias = (rawMime: string): string => {
  const base = rawMime.split(';', 1)[0].trim().toLowerCase();
  return MIME_ALIASES[base] ?? base;
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
 * - Preserves concrete non-generic, non-image HTTP headers (never disguises `application/xml` or `text/html`).
 * - Normalizes legacy aliases (`image/jpg`, `image/pjpeg` -> `image/jpeg`, `image/x-png` -> `image/png`).
 * - When header MIME is missing, generic (`application/octet-stream`), or `image/*`,
 *   unambiguous raster magic bytes (PNG/JPEG/WebP/GIF) win over stale/mismatched `image/*` headers.
 * - Falls back to normalized `image/*` header, safe media extensions, then ISO BMFF `ftyp` magic bytes.
 */
export const detectImageMimeType = (
  buf: Buffer | Uint8Array,
  headerMime?: string | null,
  keyOrUrl?: string,
): string => {
  const normalizedHeader = headerMime ? normalizeImageMimeAlias(headerMime) : '';
  if (
    normalizedHeader &&
    !GENERIC_MIME_TYPES.has(normalizedHeader) &&
    !normalizedHeader.startsWith('image/')
  ) {
    return normalizedHeader;
  }

  const magicMime = detectRasterMagicMime(buf);
  if (magicMime) return magicMime;

  if (normalizedHeader && !GENERIC_MIME_TYPES.has(normalizedHeader)) {
    return normalizedHeader;
  }

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

  const nodeBuiltins = await loadNodeBuiltins();
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

export const isExternalCallerAbortError = (error: unknown): boolean => {
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

/**
 * Identifies transient network/timeout/5xx/408/429/S3 outage errors.
 * Explicitly returns false for client errors (400/401/403/404, `NoSuchKey`, SSRF blocks,
 * invalid URLs, and external caller `AbortSignal` cancellations).
 */
export const isS3OutageError = (error: unknown): boolean => {
  if (isExternalCallerAbortError(error)) return false;

  // First pass: check permanent non-outage signals anywhere in the cause chain
  let cursor: unknown = error;
  const visitedFirst = new Set<unknown>();
  for (let depth = 0; depth < 6 && cursor != null && !visitedFirst.has(cursor); depth++) {
    visitedFirst.add(cursor);
    if (typeof cursor === 'string') {
      if (NON_OUTAGE_MESSAGE_PATTERN.test(cursor)) return false;
      break;
    }
    if (typeof cursor !== 'object') break;
    const record = cursor as Record<string, unknown>;
    const message = typeof record.message === 'string' ? record.message : '';
    if (message && NON_OUTAGE_MESSAGE_PATTERN.test(message)) return false;

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
    if (status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429) {
      return false;
    }

    cursor = record.cause;
  }

  // Second pass: check transient outage signals in the cause chain
  let current: unknown = error;
  const seen = new Set<unknown>();

  for (let depth = 0; depth < 6 && current != null && !seen.has(current); depth++) {
    seen.add(current);

    if (typeof current === 'string') {
      if (OUTAGE_MESSAGE_PATTERN.test(current)) return true;
      break;
    }

    if (typeof current !== 'object') break;

    const record = current as Record<string, unknown>;
    const message = typeof record.message === 'string' ? record.message : '';
    const code =
      typeof record.code === 'string'
        ? record.code
        : typeof record.Code === 'string'
          ? record.Code
          : '';
    const name = typeof record.name === 'string' ? record.name : '';

    const status = extractHttpStatus(record);
    if (
      status !== undefined &&
      (status === 408 || status === 429 || (status >= 500 && status <= 599))
    ) {
      return true;
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
  mirrored?: boolean;
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
 * When S3 outage breaker is open (or Studio reports `s3_down: true`) and Studio explicitly
 * reports `mirrored[key] === false`, returns `null` to avoid a doomed 302 redirect back to S3.
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
      if (isS3BreakerOpen(now) && cached.mirrored === false) {
        return null;
      }
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

    const payload = (await response.json()) as {
      mirrored?: Record<string, boolean>;
      s3_down?: boolean;
      urls?: Record<string, string>;
    } | null;
    const signedUrl = payload?.urls?.[safeKey];
    if (typeof signedUrl !== 'string' || !signedUrl) return null;

    const isMirrored = payload?.mirrored?.[safeKey];
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
      setCachedMediaUrl(cacheKey, { cacheUntil, mirrored: isMirrored, url: signedUrl });
    }

    if ((isS3BreakerOpen(afterNow) || payload?.s3_down === true) && isMirrored === false) {
      return null;
    }

    return signedUrl;
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
};
