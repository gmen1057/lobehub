// @vitest-environment node
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearMediaUrlCacheForTest,
  detectImageMimeType,
  extractOwnBucketKey,
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
  'ARCKEP_INTERNAL_TOKEN',
  'S3_ENDPOINT',
  'S3_BUCKET',
  'S3_PUBLIC_DOMAIN',
  'NEXT_PUBLIC_S3_DOMAIN',
  'S3_ENABLE_PATH_STYLE',
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
  });
});
