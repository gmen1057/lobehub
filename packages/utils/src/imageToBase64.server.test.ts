// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearMediaUrlCacheForTest, resetS3BreakerForTest } from './arckepMediaMirror';
import { clearImageBase64CacheForTest, imageUrlToBase64 } from './imageToBase64';

const mockSsrfSafeFetch = vi.fn();

vi.mock('@lobechat/ssrf-safe-fetch', () => ({
  ssrfSafeFetch: (...args: unknown[]) => mockSsrfSafeFetch(...args),
}));

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03]);
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const S3_XML_503 =
  '<?xml version="1.0" encoding="UTF-8"?><Error><Code>ServiceUnavailable</Code></Error>';

const ENV_KEYS = [
  'ARCKEP_INTERNAL_TOKEN',
  'S3_ENDPOINT',
  'S3_BUCKET',
  'S3_PUBLIC_DOMAIN',
  'S3_LOCAL_MIRROR_DIR',
  'S3_LOCAL_SPOOL_DIR',
  'MEDIA_PUBLIC_BASE',
  'LOBECHAT_BACKEND_INTERNAL_URL',
  'LOBECHAT_BACKEND_KEY',
] as const;

describe('imageUrlToBase64 (server)', () => {
  const savedEnv: Record<string, string | undefined> = {};
  let tempDirs: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const k of ENV_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    process.env.S3_ENDPOINT = 'https://storage.yandexcloud.net';
    process.env.S3_BUCKET = 'imagestudio';
    clearImageBase64CacheForTest();
    clearMediaUrlCacheForTest();
    resetS3BreakerForTest();
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

  it('serves own-bucket extensionless image from local mirror with magic-byte MIME and 0 HTTP calls', async () => {
    const mirrorDir = await mkdtemp(path.join(tmpdir(), 'lc-img-mirror-'));
    tempDirs.push(mirrorDir);
    process.env.S3_LOCAL_MIRROR_DIR = mirrorDir;

    const key = 'files/user_x/UT0gLmAa/image';
    await mkdir(path.join(mirrorDir, 'files/user_x/UT0gLmAa'), { recursive: true });
    await writeFile(path.join(mirrorDir, key), PNG_BYTES);

    const url = `https://storage.yandexcloud.net/imagestudio/${key}?X-Amz-Date=20261125T140000Z&X-Amz-Signature=sig1`;
    const result = await imageUrlToBase64(url);

    expect(result).toEqual({
      base64: PNG_BYTES.toString('base64'),
      mimeType: 'image/png',
    });
    expect(mockSsrfSafeFetch).not.toHaveBeenCalled();
  });

  it('serves mirrored .mp4, .webm, .avif, and .heic files with exact media MIME types (Gemini video_url compatibility)', async () => {
    const mirrorDir = await mkdtemp(path.join(tmpdir(), 'lc-media-mirror-'));
    tempDirs.push(mirrorDir);
    process.env.S3_LOCAL_MIRROR_DIR = mirrorDir;

    const mediaCases: Array<[string, Buffer, string]> = [
      ['files/user_x/video.mp4', Buffer.from('mp4-video-bytes'), 'video/mp4'],
      ['files/user_x/video.webm', Buffer.from('webm-video-bytes'), 'video/webm'],
      ['files/user_x/photo.avif', Buffer.from('avif-image-bytes'), 'image/avif'],
      ['files/user_x/photo.heic', Buffer.from('heic-image-bytes'), 'image/heic'],
    ];

    for (const [key, bytes, expectedMime] of mediaCases) {
      await mkdir(path.join(mirrorDir, 'files/user_x'), { recursive: true });
      await writeFile(path.join(mirrorDir, key), bytes);

      const url = `https://storage.yandexcloud.net/imagestudio/${key}?X-Amz-Date=20261125T140000Z`;
      const result = await imageUrlToBase64(url);

      expect(result).toEqual({
        base64: bytes.toString('base64'),
        mimeType: expectedMime,
      });
    }
    expect(mockSsrfSafeFetch).not.toHaveBeenCalled();
  });

  it('retries HTTP 503/500 XML error responses from S3 and throws instead of returning application/xml', async () => {
    mockSsrfSafeFetch.mockImplementation(
      async () =>
        new Response(S3_XML_503, {
          headers: { 'content-type': 'application/xml' },
          status: 503,
          statusText: 'Service Unavailable',
        }),
    );

    const url = 'https://storage.yandexcloud.net/imagestudio/files/user_x/UT0gLmAa/image';

    await expect(imageUrlToBase64(url, { retryDelaysMs: [0, 0] })).rejects.toThrow(/HTTP 503/);
    expect(mockSsrfSafeFetch).toHaveBeenCalledTimes(3);
    expect(mockSsrfSafeFetch).toHaveBeenCalledWith(url, { timeoutMs: 10_000 });
  });

  it('recovers when a transient HTTP 503 is followed by HTTP 200 PNG', async () => {
    mockSsrfSafeFetch
      .mockResolvedValueOnce(
        new Response(S3_XML_503, {
          headers: { 'content-type': 'application/xml' },
          status: 503,
          statusText: 'Service Unavailable',
        }),
      )
      .mockResolvedValueOnce(
        new Response(PNG_BYTES, {
          headers: { 'content-type': 'application/octet-stream' },
          status: 200,
          statusText: 'OK',
        }),
      );

    const url = 'https://storage.yandexcloud.net/imagestudio/files/user_x/recover/image';
    const result = await imageUrlToBase64(url, { retryDelaysMs: [0, 0] });

    expect(result).toEqual({
      base64: PNG_BYTES.toString('base64'),
      mimeType: 'image/png',
    });
    expect(mockSsrfSafeFetch).toHaveBeenCalledTimes(2);
  });

  it('throws immediately on non-retryable HTTP 404 without retrying', async () => {
    mockSsrfSafeFetch.mockResolvedValue(
      new Response('<Error><Code>NoSuchKey</Code></Error>', {
        headers: { 'content-type': 'application/xml' },
        status: 404,
        statusText: 'Not Found',
      }),
    );

    await expect(
      imageUrlToBase64('https://example.com/missing.png', { retryDelaysMs: [0, 0] }),
    ).rejects.toThrow(/HTTP 404/);
    expect(mockSsrfSafeFetch).toHaveBeenCalledTimes(1);
  });

  it('retries on timeout errors and passes configured timeoutMs to ssrfSafeFetch', async () => {
    const timeoutErr = new Error('Fetch failed: Request timed out after 50ms');
    mockSsrfSafeFetch.mockRejectedValueOnce(timeoutErr).mockResolvedValueOnce(
      new Response(JPEG_BYTES, {
        headers: { 'content-type': 'image/jpeg' },
        status: 200,
      }),
    );

    const result = await imageUrlToBase64('https://example.com/slow.jpg', {
      retryDelaysMs: [0, 0],
      timeoutMs: 50,
    });

    expect(result).toEqual({
      base64: JPEG_BYTES.toString('base64'),
      mimeType: 'image/jpeg',
    });
    expect(mockSsrfSafeFetch).toHaveBeenCalledTimes(2);
    expect(mockSsrfSafeFetch).toHaveBeenCalledWith('https://example.com/slow.jpg', {
      timeoutMs: 50,
    });
  });

  it('falls back to signed media.arckep.ru via Studio when all S3 attempts fail', async () => {
    process.env.LOBECHAT_BACKEND_KEY = 'studio-secret';
    process.env.LOBECHAT_BACKEND_INTERNAL_URL = 'http://127.0.0.1:8202';

    const key = 'files/user_x/UT0gLmAa/image';
    const s3Url = `https://storage.yandexcloud.net/imagestudio/${key}?X-Amz-Date=20261125T140000Z`;
    const exp = Math.floor(Date.now() / 1000) + 7200;
    const signedMediaUrl = `https://media.arckep.ru/m/${key}?exp=${exp}&sig=0123456789abcdef`;

    const studioFetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          mirrored: { [key]: true },
          s3_down: true,
          urls: { [key]: signedMediaUrl },
        }),
        { headers: { 'content-type': 'application/json' }, status: 200 },
      ),
    );

    mockSsrfSafeFetch.mockImplementation(async (url: string) => {
      if (url === signedMediaUrl) {
        return new Response(PNG_BYTES, {
          headers: { 'content-type': 'application/octet-stream' },
          status: 200,
        });
      }
      return new Response(S3_XML_503, {
        headers: { 'content-type': 'application/xml' },
        status: 503,
        statusText: 'Service Unavailable',
      });
    });

    const result = await imageUrlToBase64(s3Url, { retryDelaysMs: [0, 0] });

    expect(result).toEqual({
      base64: PNG_BYTES.toString('base64'),
      mimeType: 'image/png',
    });
    expect(studioFetchSpy).toHaveBeenCalledTimes(1);
    // 3 S3 attempts + 1 media.arckep.ru fallback fetch
    expect(mockSsrfSafeFetch).toHaveBeenCalledTimes(4);
    expect(mockSsrfSafeFetch).toHaveBeenLastCalledWith(signedMediaUrl, { timeoutMs: 10_000 });
  });

  it('deduplicates concurrent loads and caches canonical bucket key across presign query changes', async () => {
    let resolveFetch!: (res: Response) => void;
    mockSsrfSafeFetch.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );

    const key = 'files/user_x/shared/image';
    const urlHour1 = `https://storage.yandexcloud.net/imagestudio/${key}?X-Amz-Date=20261125T140000Z&X-Amz-Signature=aaa`;
    const urlHour2 = `https://storage.yandexcloud.net/imagestudio/${key}?X-Amz-Date=20261125T150000Z&X-Amz-Signature=bbb`;

    // Concurrent calls for the same key with different presign signatures share one in-flight fetch
    const p1 = imageUrlToBase64(urlHour1, { retryDelaysMs: [0, 0] });
    const p2 = imageUrlToBase64(urlHour2, { retryDelaysMs: [0, 0] });

    await new Promise((r) => setTimeout(r, 10));
    expect(mockSsrfSafeFetch).toHaveBeenCalledTimes(1);

    resolveFetch(
      new Response(PNG_BYTES, {
        headers: { 'content-type': 'image/png' },
        status: 200,
      }),
    );

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual({ base64: PNG_BYTES.toString('base64'), mimeType: 'image/png' });
    expect(r2).toEqual(r1);

    // Subsequent call after completion with another presign signature hits LRU cache (0 extra fetches)
    const r3 = await imageUrlToBase64(
      `https://storage.yandexcloud.net/imagestudio/${key}?X-Amz-Date=20261125T160000Z&X-Amz-Signature=ccc`,
    );
    expect(r3).toEqual(r1);
    expect(mockSsrfSafeFetch).toHaveBeenCalledTimes(1);
  });
});
