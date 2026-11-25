// @vitest-environment node
import { createHash, createHmac } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildServerImageCacheKey,
  clearMediaUrlCacheForTest,
  detectImageMimeType,
  extractOwnBucketKey,
  isAuthorizedOwnBucketUrl,
  isMediaPublicUrl,
  isS3BreakerOpen,
  isS3OutageError,
  normalizeSafeStorageKey,
  readLocalMirrorFile,
  recordS3Failure,
  recordS3Success,
  resetS3BreakerForTest,
  signMediaUrlViaStudio,
} from './arckepMediaMirror';

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const WEBP_BYTES = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50,
]);
const GIF_BYTES = Buffer.from('GIF89a\x01\x00\x01\x00', 'binary');

const ENV_KEYS = [
  'APP_URL',
  'ARCKEP_INTERNAL_TOKEN',
  'INTERNAL_APP_URL',
  'MEDIA_URL_SECRET',
  'NEXT_PUBLIC_APP_URL',
  'S3_ACCESS_KEY_ID',
  'S3_ENDPOINT',
  'S3_BUCKET',
  'S3_PUBLIC_DOMAIN',
  'NEXT_PUBLIC_S3_DOMAIN',
  'S3_ENABLE_PATH_STYLE',
  'S3_REGION',
  'S3_SECRET_ACCESS_KEY',
  'S3_SET_ACL',
  'MEDIA_PUBLIC_BASE',
  'S3_LOCAL_MIRROR_DIR',
  'S3_LOCAL_SPOOL_DIR',
  'LOBECHAT_BACKEND_INTERNAL_URL',
  'LOBECHAT_BACKEND_KEY',
] as const;

describe('arckepMediaMirror', () => {
  const savedEnv: Record<string, string | undefined> = {};
  let tempDirs: string[] = [];

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    resetS3BreakerForTest();
    clearMediaUrlCacheForTest();
    tempDirs = [];
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = savedEnv[k];
      }
    }
    for (const dir of tempDirs) {
      await rm(dir, { force: true, recursive: true });
    }
  });

  describe('normalizeSafeStorageKey', () => {
    it('accepts valid relative storage keys including unicode', () => {
      expect(normalizeSafeStorageKey('files/user_1/UT0gLmAa/image')).toBe(
        'files/user_1/UT0gLmAa/image',
      );
      expect(normalizeSafeStorageKey('files/user_1/снимок экрана.png')).toBe(
        'files/user_1/снимок экрана.png',
      );
    });

    it('rejects unsafe keys (empty, absolute, traversal, empty segment, backslash, control chars, >1024B)', () => {
      expect(normalizeSafeStorageKey('')).toBeNull();
      expect(normalizeSafeStorageKey('/files/a.png')).toBeNull();
      expect(normalizeSafeStorageKey('files/../secret')).toBeNull();
      expect(normalizeSafeStorageKey('files/./a.png')).toBeNull();
      expect(normalizeSafeStorageKey('files//a.png')).toBeNull();
      expect(normalizeSafeStorageKey('files/a/')).toBeNull();
      expect(normalizeSafeStorageKey('files\\a.png')).toBeNull();
      expect(normalizeSafeStorageKey('files/a\u0000b.png')).toBeNull();
      expect(normalizeSafeStorageKey('files/a\nb.png')).toBeNull();
      expect(normalizeSafeStorageKey('files/a\u007Fb.png')).toBeNull();
      expect(normalizeSafeStorageKey('a'.repeat(1025))).toBeNull();
      expect(normalizeSafeStorageKey('я'.repeat(513))).toBeNull(); // 1026 UTF-8 bytes
      expect(normalizeSafeStorageKey('a'.repeat(1024))).toBe('a'.repeat(1024));
    });
  });

  describe('extractOwnBucketKey', () => {
    it('extracts key from path-style and virtual-hosted S3_ENDPOINT + S3_BUCKET URLs', () => {
      process.env.S3_ENDPOINT = 'https://storage.yandexcloud.net';
      process.env.S3_BUCKET = 'imagestudio';

      expect(
        extractOwnBucketKey(
          'https://storage.yandexcloud.net/imagestudio/files/user_1/UT0gLmAa/image?X-Amz-Date=20261125T140000Z&X-Amz-Signature=abc',
        ),
      ).toBe('files/user_1/UT0gLmAa/image');

      expect(
        extractOwnBucketKey(
          'https://imagestudio.storage.yandexcloud.net/files/user_1/photo%201.png?X-Amz-Expires=7200',
        ),
      ).toBe('files/user_1/photo 1.png');

      // Different bucket on the same endpoint must NOT match
      expect(
        extractOwnBucketKey('https://storage.yandexcloud.net/other-bucket/files/user_1/image'),
      ).toBeNull();
    });

    it('extracts key from S3_PUBLIC_DOMAIN / NEXT_PUBLIC_S3_DOMAIN (with or without scheme)', () => {
      process.env.S3_PUBLIC_DOMAIN = 'storage.yandexcloud.net/imagestudio';
      expect(
        extractOwnBucketKey('https://storage.yandexcloud.net/imagestudio/files/user_2/img.webp'),
      ).toBe('files/user_2/img.webp');

      delete process.env.S3_PUBLIC_DOMAIN;
      process.env.NEXT_PUBLIC_S3_DOMAIN = 'https://cdn.arckep.ru';
      expect(extractOwnBucketKey('https://cdn.arckep.ru/files/user_2/img.png')).toBe(
        'files/user_2/img.png',
      );
    });

    it('extracts key from media.arckep.ru /m/<key> and rejects external hosts or traversal', () => {
      expect(
        extractOwnBucketKey(
          'https://media.arckep.ru/m/files/user_1/UT0gLmAa/image?exp=1800000000&sig=deadbeef',
        ),
      ).toBe('files/user_1/UT0gLmAa/image');
      expect(isMediaPublicUrl('https://media.arckep.ru/m/files/user_1/image?exp=1&sig=2')).toBe(
        true,
      );
      expect(isMediaPublicUrl('https://storage.yandexcloud.net/imagestudio/files/a')).toBe(false);

      // Non-/m/ path on media host must not match
      expect(extractOwnBucketKey('https://media.arckep.ru/other/files/a.png')).toBeNull();

      // Arbitrary external URLs must never match
      expect(extractOwnBucketKey('https://example.com/imagestudio/files/a.png')).toBeNull();
      expect(extractOwnBucketKey('https://evil.com/m/files/a.png')).toBeNull();

      // Encoded traversal must be rejected before WHATWG URL dot-segment normalization
      expect(
        extractOwnBucketKey('https://media.arckep.ru/m/files/user_1/%2e%2e/%2e%2e/etc/passwd'),
      ).toBeNull();
      expect(
        extractOwnBucketKey('https://media.arckep.ru/m/files/user_1/..%2f..%2fetc/passwd'),
      ).toBeNull();
    });

    it('rejects URLs with userinfo credentials and wrong buckets under path-style S3_PUBLIC_DOMAIN', () => {
      process.env.S3_ENDPOINT = 'https://storage.yandexcloud.net';
      process.env.S3_BUCKET = 'imagestudio';

      expect(
        extractOwnBucketKey(
          'https://user:pass@storage.yandexcloud.net/imagestudio/files/user_1/img.png',
        ),
      ).toBeNull();
      expect(
        extractOwnBucketKey('https://user@media.arckep.ru/m/files/user_1/img.png?exp=1&sig=2'),
      ).toBeNull();
      expect(isMediaPublicUrl('https://user:pass@media.arckep.ru/m/files/user_1/img.png')).toBe(
        false,
      );

      // Path-style S3_PUBLIC_DOMAIN without bucket path must NOT match another bucket
      delete process.env.S3_ENDPOINT;
      process.env.S3_PUBLIC_DOMAIN = 'https://s3-public.example.com';
      process.env.S3_ENABLE_PATH_STYLE = '1';
      process.env.S3_BUCKET = 'imagestudio';

      expect(
        extractOwnBucketKey('https://s3-public.example.com/imagestudio/files/user_1/img.png'),
      ).toBe('files/user_1/img.png');
      expect(
        extractOwnBucketKey('https://s3-public.example.com/other-bucket/files/user_1/img.png'),
      ).toBeNull();
    });
  });

  describe('detectImageMimeType', () => {
    it('detects PNG, JPEG, WebP, GIF magic bytes when header is missing or generic', () => {
      expect(detectImageMimeType(PNG_BYTES, undefined, 'files/user_x/UT0gLmAa/image')).toBe(
        'image/png',
      );
      expect(
        detectImageMimeType(JPEG_BYTES, 'application/octet-stream', 'files/user_x/UT0gLmAa/image'),
      ).toBe('image/jpeg');
      expect(
        detectImageMimeType(WEBP_BYTES, 'binary/octet-stream; charset=binary', 'files/noext'),
      ).toBe('image/webp');
      expect(detectImageMimeType(GIF_BYTES, null, 'files/noext')).toBe('image/gif');
    });

    it('preserves concrete non-generic headers and never disguises XML/HTML as an image', () => {
      expect(detectImageMimeType(PNG_BYTES, 'application/xml; charset=utf-8', 'a.png')).toBe(
        'application/xml',
      );
      expect(detectImageMimeType(Buffer.from('<html>503</html>'), 'text/html', 'a.png')).toBe(
        'text/html',
      );
      expect(detectImageMimeType(Buffer.from('data'), 'IMAGE/PNG; charset=utf-8')).toBe(
        'image/png',
      );
    });

    it('falls back to safe media extensions (image/video/audio) and ISO BMFF ftyp magic bytes, never HTML/XML/JS', () => {
      expect(detectImageMimeType(Buffer.from('<svg/>'), undefined, 'files/icon.svg?v=1')).toBe(
        'image/svg+xml',
      );
      expect(detectImageMimeType(Buffer.from('mp4data'), undefined, 'files/clip.mp4')).toBe(
        'video/mp4',
      );
      expect(detectImageMimeType(Buffer.from('webmdata'), undefined, 'files/clip.webm')).toBe(
        'video/webm',
      );
      expect(detectImageMimeType(Buffer.from('movdata'), undefined, 'files/clip.mov')).toBe(
        'video/quicktime',
      );
      expect(detectImageMimeType(Buffer.from('avifdata'), undefined, 'files/shot.avif')).toBe(
        'image/avif',
      );
      expect(detectImageMimeType(Buffer.from('heicdata'), undefined, 'files/shot.heic')).toBe(
        'image/heic',
      );
      expect(detectImageMimeType(Buffer.from('audiodata'), undefined, 'files/voice.mp3')).toBe(
        'audio/mpeg',
      );

      // Extensionless ISO BMFF ftyp detection
      const mp4Ftyp = Buffer.from([
        0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
      ]);
      expect(detectImageMimeType(mp4Ftyp, undefined, 'files/user_x/noext')).toBe('video/mp4');

      // Active/document extensions must never map to media types
      expect(detectImageMimeType(Buffer.from('<html/>'), undefined, 'files/page.html')).toBe(
        'application/octet-stream',
      );
      expect(detectImageMimeType(Buffer.from('<xml/>'), undefined, 'files/err.xml')).toBe(
        'application/octet-stream',
      );
      expect(detectImageMimeType(Buffer.from('alert(1)'), undefined, 'files/x.js')).toBe(
        'application/octet-stream',
      );
      expect(detectImageMimeType(Buffer.from('unknown'), undefined, 'files/noext')).toBe(
        'application/octet-stream',
      );
    });
  });

  describe('readLocalMirrorFile', () => {
    it('reads extensionless raster files from mirror and detects MIME from magic bytes', async () => {
      const mirrorRoot = await mkdtemp(path.join(tmpdir(), 'arckep-mirror-'));
      tempDirs.push(mirrorRoot);
      process.env.S3_LOCAL_MIRROR_DIR = mirrorRoot;

      const cases: Array<[string, Buffer, string]> = [
        ['files/user_x/UT0gLmAa/image', PNG_BYTES, 'image/png'],
        ['files/user_x/photo', JPEG_BYTES, 'image/jpeg'],
        ['files/user_x/anim_webp', WEBP_BYTES, 'image/webp'],
        ['files/user_x/anim_gif', GIF_BYTES, 'image/gif'],
      ];

      for (const [key, bytes, expectedMime] of cases) {
        const fullPath = path.join(mirrorRoot, key);
        await mkdir(path.join(fullPath, '..'), { recursive: true });
        await writeFile(fullPath, bytes);

        const result = await readLocalMirrorFile(key);
        expect(result).not.toBeNull();
        expect(result?.buffer.equals(bytes)).toBe(true);
        expect(result?.mimeType).toBe(expectedMime);
      }
    });

    it('reads mirrored video and modern image formats (.mp4, .webm, .avif, .heic) with proper MIME', async () => {
      const mirrorRoot = await mkdtemp(path.join(tmpdir(), 'arckep-mirror-media-'));
      tempDirs.push(mirrorRoot);
      process.env.S3_LOCAL_MIRROR_DIR = mirrorRoot;

      const cases: Array<[string, Buffer, string]> = [
        ['files/user_x/clip.mp4', Buffer.from('mp4-payload'), 'video/mp4'],
        ['files/user_x/clip.webm', Buffer.from('webm-payload'), 'video/webm'],
        ['files/user_x/photo.avif', Buffer.from('avif-payload'), 'image/avif'],
        ['files/user_x/photo.heic', Buffer.from('heic-payload'), 'image/heic'],
      ];

      for (const [key, bytes, expectedMime] of cases) {
        const fullPath = path.join(mirrorRoot, key);
        await mkdir(path.join(fullPath, '..'), { recursive: true });
        await writeFile(fullPath, bytes);

        const result = await readLocalMirrorFile(key);
        expect(result).not.toBeNull();
        expect(result?.buffer.equals(bytes)).toBe(true);
        expect(result?.mimeType).toBe(expectedMime);
      }
    });

    it('falls back to S3_LOCAL_SPOOL_DIR when absent from primary mirror', async () => {
      const mirrorRoot = await mkdtemp(path.join(tmpdir(), 'arckep-mirror-'));
      const spoolRoot = await mkdtemp(path.join(tmpdir(), 'arckep-spool-'));
      tempDirs.push(mirrorRoot, spoolRoot);
      process.env.S3_LOCAL_MIRROR_DIR = mirrorRoot;
      process.env.S3_LOCAL_SPOOL_DIR = spoolRoot;

      await mkdir(path.join(spoolRoot, 'files/user_s'), { recursive: true });
      await writeFile(path.join(spoolRoot, 'files/user_s/img'), PNG_BYTES);

      const result = await readLocalMirrorFile('files/user_s/img');
      expect(result?.mimeType).toBe('image/png');
      expect(result?.buffer.equals(PNG_BYTES)).toBe(true);
    });

    it('blocks path traversal and symlink escapes outside mirror root', async () => {
      const mirrorRoot = await mkdtemp(path.join(tmpdir(), 'arckep-mirror-'));
      const outsideDir = await mkdtemp(path.join(tmpdir(), 'arckep-outside-'));
      tempDirs.push(mirrorRoot, outsideDir);
      process.env.S3_LOCAL_MIRROR_DIR = mirrorRoot;

      const secretFile = path.join(outsideDir, 'secret.png');
      await writeFile(secretFile, PNG_BYTES);
      await mkdir(path.join(mirrorRoot, 'files/user_x'), { recursive: true });
      await symlink(secretFile, path.join(mirrorRoot, 'files/user_x/escape-link'));

      expect(await readLocalMirrorFile('../outside/secret.png')).toBeNull();
      expect(await readLocalMirrorFile('files/user_x/../../secret.png')).toBeNull();
      expect(await readLocalMirrorFile('files/user_x/escape-link')).toBeNull();
    });

    it('is disabled by default in test env when S3_LOCAL_MIRROR_DIR is unset', async () => {
      process.env.S3_BUCKET = 'imagestudio';
      expect(await readLocalMirrorFile('files/user_x/UT0gLmAa/image')).toBeNull();
    });
  });

  describe('S3 outage circuit breaker', () => {
    it('classifies outage vs non-outage errors accurately', () => {
      expect(isS3OutageError(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))).toBe(true);
      expect(isS3OutageError(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toBe(
        true,
      );
      expect(
        isS3OutageError(
          new Error('Fetch failed: Request timed out after 10000ms', {
            cause: Object.assign(new Error('timeout'), { name: 'AbortError' }),
          }),
        ),
      ).toBe(true);
      expect(
        isS3OutageError(
          Object.assign(new Error('unavailable'), { $metadata: { httpStatusCode: 503 } }),
        ),
      ).toBe(true);
      expect(isS3OutageError(Object.assign(new Error('slowdown'), { name: 'SlowDown' }))).toBe(
        true,
      );

      // Non-outage errors
      expect(
        isS3OutageError(
          Object.assign(new Error('missing'), { $metadata: { httpStatusCode: 404 } }),
        ),
      ).toBe(false);
      expect(isS3OutageError(Object.assign(new Error('missing'), { name: 'NoSuchKey' }))).toBe(
        false,
      );
      expect(isS3OutageError(Object.assign(new Error('denied'), { status: 403 }))).toBe(false);
      expect(isS3OutageError(new Error('SSRF blocked: private IP'))).toBe(false);
    });

    it('opens after 3 consecutive outage failures for 60s, allows half-open probe, and closes on success', () => {
      const t0 = 1_700_000_000_000;
      const outageErr = Object.assign(new Error('503'), { status: 503 });
      const notFoundErr = Object.assign(new Error('404'), { status: 404 });

      expect(isS3BreakerOpen(t0)).toBe(false);
      expect(recordS3Failure(notFoundErr, t0)).toBe(false);

      expect(recordS3Failure(outageErr, t0)).toBe(true);
      expect(isS3BreakerOpen(t0)).toBe(false);
      expect(recordS3Failure(outageErr, t0 + 100)).toBe(true);
      expect(isS3BreakerOpen(t0 + 100)).toBe(false);
      expect(recordS3Failure(outageErr, t0 + 200)).toBe(true);
      expect(isS3BreakerOpen(t0 + 200)).toBe(true);
      expect(isS3BreakerOpen(t0 + 59_999)).toBe(true);

      // Half-open after 60s window
      expect(isS3BreakerOpen(t0 + 60_200)).toBe(false);

      // Failing the half-open probe immediately re-opens for another 60s
      expect(recordS3Failure(outageErr, t0 + 60_200)).toBe(true);
      expect(isS3BreakerOpen(t0 + 60_201)).toBe(true);

      // Success closes the breaker
      recordS3Success();
      expect(isS3BreakerOpen(t0 + 60_202)).toBe(false);
    });
  });

  describe('signMediaUrlViaStudio', () => {
    it('returns null without network call when LOBECHAT_BACKEND_KEY is missing', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      expect(await signMediaUrlViaStudio('files/user_1/img.png')).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('signs via Studio loopback endpoint and caches returned URL', async () => {
      process.env.LOBECHAT_BACKEND_INTERNAL_URL = 'http://127.0.0.1:8202';
      process.env.LOBECHAT_BACKEND_KEY = 'secret-internal-token';

      const futureExp = Math.floor(Date.now() / 1000) + 7200;
      const signed = `https://media.arckep.ru/m/files/user_1/img.png?exp=${futureExp}&sig=abcdef`;

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({
            mirrored: { 'files/user_1/img.png': true },
            s3_down: true,
            urls: { 'files/user_1/img.png': signed },
          }),
          { headers: { 'content-type': 'application/json' }, status: 200 },
        ),
      );

      const first = await signMediaUrlViaStudio('files/user_1/img.png', 7200);
      const second = await signMediaUrlViaStudio('files/user_1/img.png', 7200);

      expect(first).toBe(signed);
      expect(second).toBe(signed);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy).toHaveBeenCalledWith(
        'http://127.0.0.1:8202/api/chat-engine/internal/media-urls',
        expect.objectContaining({
          body: JSON.stringify({
            expires_in: 7200,
            keys: ['files/user_1/img.png'],
            only_if_mirrored: false,
          }),
          headers: {
            'Content-Type': 'application/json',
            'X-Arckep-Token': 'secret-internal-token',
          },
          method: 'POST',
        }),
      );
    });

    it('returns null safely on non-200 or network error without throwing', async () => {
      process.env.LOBECHAT_BACKEND_KEY = 'secret-internal-token';

      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('Service Unavailable', { status: 503 }),
      );
      expect(await signMediaUrlViaStudio('files/user_1/fail503.png')).toBeNull();

      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
      expect(await signMediaUrlViaStudio('files/user_1/failnet.png')).toBeNull();
    });

    it('prefers ARCKEP_INTERNAL_TOKEN over LOBECHAT_BACKEND_KEY for parity with other routes', async () => {
      process.env.ARCKEP_INTERNAL_TOKEN = 'arckep-primary-token';
      process.env.LOBECHAT_BACKEND_KEY = 'fallback-backend-key';

      const exp = Math.floor(Date.now() / 1000) + 7200;
      const signed = `https://media.arckep.ru/m/files/user_1/parity.png?exp=${exp}&sig=1234`;
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ urls: { 'files/user_1/parity.png': signed } }), {
          headers: { 'content-type': 'application/json' },
          status: 200,
        }),
      );

      expect(await signMediaUrlViaStudio('files/user_1/parity.png')).toBe(signed);
      expect(fetchSpy).toHaveBeenCalledWith(
        'http://127.0.0.1:8202/api/chat-engine/internal/media-urls',
        expect.objectContaining({
          headers: expect.objectContaining({ 'X-Arckep-Token': 'arckep-primary-token' }),
        }),
      );
    });

    it('returns null when S3 breaker is open (or s3_down=true) and Studio reports mirrored[key] === false', async () => {
      process.env.LOBECHAT_BACKEND_KEY = 'secret-internal-token';
      const exp = Math.floor(Date.now() / 1000) + 7200;
      const key = 'files/user_1/unmirrored.png';
      const signed = `https://media.arckep.ru/m/${key}?exp=${exp}&sig=abcd1234`;

      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            mirrored: { [key]: false },
            s3_down: true,
            urls: { [key]: signed },
          }),
          { headers: { 'content-type': 'application/json' }, status: 200 },
        ),
      );

      expect(await signMediaUrlViaStudio(key)).toBeNull();
    });
  });

  describe('s3-proxy, URL authorization, MIME overrides, and cacheKey normalization', () => {
    const signSigV4Url = ({
      accessKeyId,
      secretAccessKey,
      host,
      pathname,
      amzDate,
      expiresSec,
      region = 'ru-central1',
    }: {
      accessKeyId: string;
      amzDate: string;
      expiresSec: number;
      host: string;
      pathname: string;
      region?: string;
      secretAccessKey: string;
    }): string => {
      const datestamp = amzDate.slice(0, 8);
      const scope = `${datestamp}/${region}/s3/aws4_request`;
      const queryPairs: Array<[string, string]> = [
        ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
        ['X-Amz-Content-Sha256', 'UNSIGNED-PAYLOAD'],
        ['X-Amz-Credential', `${accessKeyId}/${scope}`],
        ['X-Amz-Date', amzDate],
        ['X-Amz-Expires', String(expiresSec)],
        ['X-Amz-SignedHeaders', 'host'],
      ];
      const enc = (s: string) =>
        encodeURIComponent(s).replaceAll(
          /[!'()*]/g,
          (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
        );
      const canonicalQuery = queryPairs
        .map(([k, v]) => [enc(k), enc(v)] as const)
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([k, v]) => `${k}=${v}`)
        .join('&');
      const canonicalUri = pathname
        .split('/')
        .map((seg) => enc(decodeURIComponent(seg)))
        .join('/');
      const canonicalRequest = [
        'GET',
        canonicalUri,
        canonicalQuery,
        `host:${host.toLowerCase()}\n`,
        'host',
        'UNSIGNED-PAYLOAD',
      ].join('\n');
      const stringToSign = [
        'AWS4-HMAC-SHA256',
        amzDate,
        scope,
        createHash('sha256').update(canonicalRequest).digest('hex'),
      ].join('\n');
      const hmac = (k: Buffer | string, d: string) => createHmac('sha256', k).update(d).digest();
      const signingKey = hmac(
        hmac(hmac(hmac(`AWS4${secretAccessKey}`, datestamp), region), 's3'),
        'aws4_request',
      );
      const sig = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
      return `https://${host}${pathname}?${canonicalQuery}&X-Amz-Signature=${sig}`;
    };

    it('extracts key from Studio /chat/s3-proxy/<bucket>/<key> on APP_URL and rejects wrong bucket', () => {
      process.env.APP_URL = 'https://arckep.ru/chat';
      process.env.S3_BUCKET = 'imagestudio';

      expect(
        extractOwnBucketKey(
          'https://arckep.ru/chat/s3-proxy/imagestudio/files/user_1/UT0gLmAa/image?X-Amz-Signature=abc',
        ),
      ).toBe('files/user_1/UT0gLmAa/image');

      expect(
        extractOwnBucketKey('https://arckep.ru/chat/s3-proxy/other-bucket/files/user_1/image'),
      ).toBeNull();
      expect(
        extractOwnBucketKey(
          'https://evil.example.com/chat/s3-proxy/imagestudio/files/user_1/image',
        ),
      ).toBeNull();
    });

    it('verifies SigV4 & media.arckep.ru signatures and blocks unsigned/forged/expired private URLs', async () => {
      process.env.APP_URL = 'https://arckep.ru/chat';
      process.env.S3_ENDPOINT = 'https://storage.yandexcloud.net';
      process.env.S3_BUCKET = 'imagestudio';
      process.env.S3_ACCESS_KEY_ID = 'YCAJE_TEST_KEY';
      process.env.S3_SECRET_ACCESS_KEY = 'super-secret-s3-key';

      const nowMs = Date.UTC(2026, 10, 25, 15, 0, 0); // 20261125T150000Z
      const amzDate = '20261125T143000Z';
      const validS3Url = signSigV4Url({
        accessKeyId: 'YCAJE_TEST_KEY',
        amzDate,
        expiresSec: 3600,
        host: 'storage.yandexcloud.net',
        pathname: '/imagestudio/files/user_1/photo%201.png',
        secretAccessKey: 'super-secret-s3-key',
      });

      expect(await isAuthorizedOwnBucketUrl(validS3Url, nowMs)).toBe(true);

      // Rewritten /chat/s3-proxy/ URL carrying the upstream S3 signature is also verified
      const proxyRewritten = validS3Url.replace(
        'https://storage.yandexcloud.net/imagestudio/',
        'https://arckep.ru/chat/s3-proxy/imagestudio/',
      );
      expect(await isAuthorizedOwnBucketUrl(proxyRewritten, nowMs)).toBe(true);

      // Tampered key with victim's path fails HMAC check
      const tamperedVictimUrl = validS3Url.replace('user_1', 'user_victim');
      expect(await isAuthorizedOwnBucketUrl(tamperedVictimUrl, nowMs)).toBe(false);

      // Expired presigned URL fails expiry check
      expect(await isAuthorizedOwnBucketUrl(validS3Url, nowMs + 7200 * 1000)).toBe(false);

      // Bare URL without signature fails
      expect(
        await isAuthorizedOwnBucketUrl(
          'https://storage.yandexcloud.net/imagestudio/files/user_victim/x/image',
          nowMs,
        ),
      ).toBe(false);

      // Wrong access key fails
      const wrongKeyUrl = signSigV4Url({
        accessKeyId: 'ATTACKER_KEY',
        amzDate,
        expiresSec: 3600,
        host: 'storage.yandexcloud.net',
        pathname: '/imagestudio/files/user_victim/photo%201.png',
        secretAccessKey: 'super-secret-s3-key',
      });
      expect(await isAuthorizedOwnBucketUrl(wrongKeyUrl, nowMs)).toBe(false);

      // media.arckep.ru without sig/exp or expired exp fails
      expect(
        await isAuthorizedOwnBucketUrl('https://media.arckep.ru/m/files/user_victim/img', nowMs),
      ).toBe(false);
      expect(
        await isAuthorizedOwnBucketUrl(
          `https://media.arckep.ru/m/files/user_1/img?exp=${Math.floor(nowMs / 1000) - 10}&sig=deadbeef`,
          nowMs,
        ),
      ).toBe(false);
      expect(
        await isAuthorizedOwnBucketUrl(
          `https://media.arckep.ru/m/files/user_1/img?exp=${Math.floor(nowMs / 1000) + 600}&sig=deadbeef`,
          nowMs,
        ),
      ).toBe(true);
    });

    it('normalizes internal /chat/f/<id>/ cache keys and preserves external query strings', () => {
      process.env.APP_URL = 'https://arckep.ru/chat';

      expect(buildServerImageCacheKey('https://arckep.ru/chat/f/file_abc123/#preview', null)).toBe(
        'https://arckep.ru/chat/f/file_abc123',
      );
      expect(buildServerImageCacheKey('https://arckep.ru/chat/f/file_abc123', null)).toBe(
        'https://arckep.ru/chat/f/file_abc123',
      );
      expect(buildServerImageCacheKey('/chat/f/file_abc123/', null)).toBe('/chat/f/file_abc123');
      expect(buildServerImageCacheKey('/f/file_abc123/', null)).toBe('/f/file_abc123');

      // External third-party URLs preserve query strings and strip #hash only
      expect(buildServerImageCacheKey('https://cdn.other.io/p.png?sig=111#frag', null)).not.toBe(
        buildServerImageCacheKey('https://cdn.other.io/p.png?sig=222', null),
      );
    });

    it('lets raster magic bytes win over legacy/wrong image/* headers without masking XML/HTML', () => {
      expect(detectImageMimeType(JPEG_BYTES, 'image/png', 'wrong.png')).toBe('image/jpeg');
      expect(detectImageMimeType(PNG_BYTES, 'image/jpg', 'files/noext')).toBe('image/png');
      expect(detectImageMimeType(Buffer.from('no-magic'), 'image/jpg')).toBe('image/jpeg');
      expect(detectImageMimeType(Buffer.from('no-magic'), 'image/pjpeg')).toBe('image/jpeg');
      expect(detectImageMimeType(Buffer.from('no-magic'), 'image/x-png')).toBe('image/png');
      expect(detectImageMimeType(PNG_BYTES, 'application/xml', 'err.xml')).toBe('application/xml');
    });

    it('does not treat external caller AbortSignal as S3 outage', () => {
      const domAbort = new DOMException('This operation was aborted', 'AbortError');
      expect(isS3OutageError(domAbort)).toBe(false);

      const wrappedCallerAbort = Object.assign(new Error('Fetch failed: Caller cancelled'), {
        cause: Object.assign(new Error('Caller cancelled'), {
          isCallerAbort: true,
          name: 'AbortError',
        }),
        isCallerAbort: true,
        name: 'AbortError',
      });
      expect(isS3OutageError(wrappedCallerAbort)).toBe(false);

      // TimeoutError still counts as S3 outage
      const wrappedTimeout = new Error('Fetch failed: Request timed out after 8000ms', {
        cause: Object.assign(new Error('Request timed out after 8000ms'), {
          name: 'TimeoutError',
        }),
      });
      expect(isS3OutageError(wrappedTimeout)).toBe(true);
    });

    it('verifies real @aws-sdk/s3-request-presigner URLs under exact prod env (with NEXT_PUBLIC_S3_DOMAIN and hour-floored signingDate) and blocks unsigned private prefixes', async () => {
      process.env.APP_URL = 'https://arckep.ru/chat';
      process.env.INTERNAL_APP_URL = 'http://127.0.0.1:3403/chat';
      process.env.NEXT_PUBLIC_S3_DOMAIN = 'storage.yandexcloud.net/imagestudio';
      process.env.S3_ACCESS_KEY_ID = 'YCAJE_REAL_SDK_TEST_KEY_ID';
      process.env.S3_SECRET_ACCESS_KEY = 'YCAJE_REAL_SDK_TEST_SECRET_KEY_0123456789';
      process.env.S3_ENDPOINT = 'https://storage.yandexcloud.net';
      process.env.S3_BUCKET = 'imagestudio';
      process.env.S3_ENABLE_PATH_STYLE = '1';
      process.env.S3_REGION = 'ru-central1';

      const client = new S3Client({
        credentials: {
          accessKeyId: process.env.S3_ACCESS_KEY_ID,
          secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
        },
        endpoint: process.env.S3_ENDPOINT,
        forcePathStyle: true,
        region: process.env.S3_REGION,
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
      });

      // Simulate FileS3.createPreSignedUrlForPreview: signingDate rounded down to start of hour,
      // evaluated 59m30s into that hour.
      const presignWindowMs = 60 * 60 * 1000;
      const nowMs = Date.UTC(2026, 10, 25, 14, 59, 30);
      const signingDate = new Date(Math.floor(nowMs / presignWindowMs) * presignWindowMs);
      const expiresIn = 7200 + presignWindowMs / 1000;

      const keys = [
        'files/user_1/UT0gLmAa/image',
        'files/user_1/project.js (builder_proj).md',
        'files/user_1/Сборщик 1.png',
        "generated/42/result !'()*+&,;=~ 1.png",
      ];

      for (const key of keys) {
        const signedUrl = await getSignedUrl(
          client,
          new GetObjectCommand({ Bucket: 'imagestudio', Key: key }),
          { expiresIn, signingDate },
        );

        expect(signedUrl).toContain('x-id=GetObject');
        expect(extractOwnBucketKey(signedUrl)).toBe(key);
        expect(await isAuthorizedOwnBucketUrl(signedUrl, nowMs)).toBe(true);

        const proxyRewritten = signedUrl.replace(
          'https://storage.yandexcloud.net/imagestudio/',
          'https://arckep.ru/chat/s3-proxy/imagestudio/',
        );
        expect(extractOwnBucketKey(proxyRewritten)).toBe(key);
        expect(await isAuthorizedOwnBucketUrl(proxyRewritten, nowMs)).toBe(true);
      }

      // Real presigned URL with ResponseContentDisposition (including Cyrillic & parentheses)
      const dispositionSigned = await getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket: 'imagestudio',
          Key: 'files/user_1/Сборщик 1.png',
          ResponseContentDisposition: 'attachment; filename="preset (1).png"',
        }),
        { expiresIn, signingDate },
      );
      expect(await isAuthorizedOwnBucketUrl(dispositionSigned, nowMs)).toBe(true);

      // Expired real SDK presigned URL must be rejected even when NEXT_PUBLIC_S3_DOMAIN is set
      expect(
        await isAuthorizedOwnBucketUrl(dispositionSigned, signingDate.getTime() + expiresIn * 1000),
      ).toBe(false);

      // Tampered victim key on real SDK presigned URL must be rejected
      const tamperedSdkUrl = dispositionSigned.replace('user_1', 'user_victim');
      expect(await isAuthorizedOwnBucketUrl(tamperedSdkUrl, nowMs)).toBe(false);

      // Bare unsigned URLs across ALL user-owned prefixes (files/, generated/, documents/, videos/)
      // must be rejected when S3_SET_ACL !== '1', even when NEXT_PUBLIC_S3_DOMAIN matches S3_ENDPOINT
      for (const bareUrl of [
        'https://storage.yandexcloud.net/imagestudio/files/victim/x/image',
        'https://storage.yandexcloud.net/imagestudio/generated/42/secret.png',
        'https://storage.yandexcloud.net/imagestudio/documents/42/passport.png',
        'https://storage.yandexcloud.net/imagestudio/videos/42/clip.mp4',
        'https://media.arckep.ru/m/generated/42/secret.png',
      ]) {
        expect(await isAuthorizedOwnBucketUrl(bareUrl, nowMs)).toBe(false);
      }

      // Explicit public-read ACL bucket mode (S3_SET_ACL=1) allows unsigned S3 URLs while media.arckep.ru still requires sig+exp
      process.env.S3_SET_ACL = '1';
      expect(
        await isAuthorizedOwnBucketUrl(
          'https://storage.yandexcloud.net/imagestudio/files/public/img.png',
          nowMs,
        ),
      ).toBe(true);
      expect(
        await isAuthorizedOwnBucketUrl('https://media.arckep.ru/m/files/public/img.png', nowMs),
      ).toBe(false);
    });
  });
});
