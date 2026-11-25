// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearMediaUrlCacheForTest, resetS3BreakerForTest } from './arckepMediaMirror';
import {
  clearImageBase64CacheForTest,
  imageUrlToBase64,
  SERVER_IMAGE_CACHE_MAX_BYTES,
  SERVER_IMAGE_CACHE_MAX_ENTRY_BYTES,
  SERVER_IMAGE_CACHE_TTL_MS,
} from './imageToBase64';

const mockSsrfSafeFetch = vi.fn();

vi.mock('@lobechat/ssrf-safe-fetch', () => ({
  ssrfSafeFetch: (...args: unknown[]) => mockSsrfSafeFetch(...args),
}));

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03]);
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const S3_XML_503 =
  '<?xml version="1.0" encoding="UTF-8"?><Error><Code>ServiceUnavailable</Code></Error>';

const ENV_KEYS = [
  'APP_URL',
  'ARCKEP_INTERNAL_TOKEN',
  'INTERNAL_APP_URL',
  'MEDIA_URL_SECRET',
  'S3_ACCESS_KEY_ID',
  'S3_ENDPOINT',
  'S3_BUCKET',
  'S3_PUBLIC_DOMAIN',
  'S3_SECRET_ACCESS_KEY',
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

  it('retries transient socket/DNS/HTTP errors with bounded jitter and Retry-After', async () => {
    const transientErrors: unknown[] = [
      Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
      Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }),
      Object.assign(new Error('getaddrinfo EAI_AGAIN'), { code: 'EAI_AGAIN' }),
      new Error('Fetch failed: other side closed', {
        cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
      }),
      new TypeError('fetch failed'),
      Object.assign(new Error('Request timed out'), { name: 'TimeoutError' }),
    ];

    for (let i = 0; i < transientErrors.length; i++) {
      mockSsrfSafeFetch
        .mockRejectedValueOnce(transientErrors[i])
        .mockResolvedValueOnce(
          new Response(PNG_BYTES, { headers: { 'content-type': 'image/png' }, status: 200 }),
        );

      const res = await imageUrlToBase64(`https://cdn.example.com/transient-${i}.png`, {
        jitter: 0.3,
        retryDelaysMs: [10],
      });
      expect(res.mimeType).toBe('image/png');
    }
    expect(mockSsrfSafeFetch).toHaveBeenCalledTimes(transientErrors.length * 2);

    // Retryable HTTP statuses: 408, 429 (with Retry-After), 500, 502, 503, 504
    for (const status of [408, 429, 500, 502, 503, 504]) {
      mockSsrfSafeFetch
        .mockResolvedValueOnce(
          new Response('transient error', {
            headers: status === 429 ? { 'Retry-After': '0.02' } : {},
            status,
          }),
        )
        .mockResolvedValueOnce(
          new Response(JPEG_BYTES, { headers: { 'content-type': 'image/jpeg' }, status: 200 }),
        );

      const res = await imageUrlToBase64(`https://cdn.example.com/status-${status}.jpg`, {
        jitter: false,
        retryDelaysMs: [0],
      });
      expect(res.mimeType).toBe('image/jpeg');
    }
  });

  it('does NOT retry on HTTP 400/401/403/404, SSRF blocked, invalid URL/protocol, or caller AbortSignal', async () => {
    for (const status of [400, 401, 403, 404]) {
      mockSsrfSafeFetch.mockClear();
      mockSsrfSafeFetch.mockResolvedValueOnce(new Response('denied', { status }));
      await expect(
        imageUrlToBase64(`https://cdn.example.com/err-${status}.png`, { retryDelaysMs: [0, 0] }),
      ).rejects.toThrow(new RegExp(`HTTP ${status}`));
      expect(mockSsrfSafeFetch).toHaveBeenCalledTimes(1);
    }

    const nonRetryableErrors = [
      new Error('SSRF blocked: DNS lookup 10.0.0.1 is not allowed'),
      new Error('Fetch failed: Only HTTP(S) protocols are supported', {
        cause: new TypeError('Only HTTP(S) protocols are supported'),
      }),
      new Error('Fetch failed: Invalid URL', {
        cause: Object.assign(new TypeError('Invalid URL'), { code: 'ERR_INVALID_URL' }),
      }),
    ];

    for (let i = 0; i < nonRetryableErrors.length; i++) {
      mockSsrfSafeFetch.mockClear();
      mockSsrfSafeFetch.mockRejectedValueOnce(nonRetryableErrors[i]);
      await expect(
        imageUrlToBase64(`https://cdn.example.com/nonretry-${i}.png`, { retryDelaysMs: [0, 0] }),
      ).rejects.toThrow();
      expect(mockSsrfSafeFetch).toHaveBeenCalledTimes(1);
    }

    // Pre-aborted caller signal fails before touching ssrfSafeFetch
    mockSsrfSafeFetch.mockClear();
    const preAborted = new AbortController();
    preAborted.abort(new Error('User cancelled stream'));
    await expect(
      imageUrlToBase64('https://cdn.example.com/cancelled.png', { signal: preAborted.signal }),
    ).rejects.toThrow(/User cancelled stream/);
    expect(mockSsrfSafeFetch).not.toHaveBeenCalled();
  });

  it('cancelling one caller signal does not abort shared in-flight download for another concurrent caller', async () => {
    let resolveFetch!: (res: Response) => void;
    let passedSignal: AbortSignal | undefined;
    mockSsrfSafeFetch.mockImplementation(
      (_url: string, opts?: { signal?: AbortSignal }) =>
        new Promise<Response>((resolve) => {
          passedSignal = opts?.signal;
          resolveFetch = resolve;
        }),
    );

    const controllerA = new AbortController();
    const controllerB = new AbortController();
    const sharedUrl = 'https://cdn.example.com/shared-inflight.png';

    const pA = imageUrlToBase64(sharedUrl, { signal: controllerA.signal });
    const pB = imageUrlToBase64(sharedUrl, { signal: controllerB.signal });

    await new Promise((r) => setTimeout(r, 10));
    expect(mockSsrfSafeFetch).toHaveBeenCalledTimes(1);

    // Abort caller A while caller B is still waiting
    controllerA.abort(new Error('Caller A disconnected'));
    await expect(pA).rejects.toThrow(/Caller A disconnected/);
    expect(passedSignal?.aborted).toBe(false);

    // Resolve underlying fetch -> caller B receives the image cleanly
    resolveFetch(
      new Response(PNG_BYTES, { headers: { 'content-type': 'image/png' }, status: 200 }),
    );
    await expect(pB).resolves.toEqual({
      base64: PNG_BYTES.toString('base64'),
      mimeType: 'image/png',
    });
  });

  it('keeps in-flight download alive for unsignaled caller B when signaled caller A aborts, and never poisons subsequent callers after sole waiter aborts', async () => {
    // Part 1: Caller A WITH signalA + Caller B WITHOUT signal
    let resolveFirstFetch!: (res: Response) => void;
    let firstPassedSignal: AbortSignal | undefined;
    mockSsrfSafeFetch.mockImplementationOnce(
      (_url: string, opts?: { signal?: AbortSignal }) =>
        new Promise<Response>((resolve) => {
          firstPassedSignal = opts?.signal;
          resolveFirstFetch = resolve;
        }),
    );

    const controllerA = new AbortController();
    const mixedUrl = 'https://cdn.example.com/mixed-waiters.png';

    const pSignaled = imageUrlToBase64(mixedUrl, { signal: controllerA.signal });
    const pUnsignaled = imageUrlToBase64(mixedUrl);

    await new Promise((r) => setTimeout(r, 10));
    expect(mockSsrfSafeFetch).toHaveBeenCalledTimes(1);

    controllerA.abort(new Error('Signaled caller left'));
    await expect(pSignaled).rejects.toThrow(/Signaled caller left/);
    // Underlying sharedController must NOT abort because unsignaled caller B is still waiting!
    expect(firstPassedSignal?.aborted).toBe(false);

    resolveFirstFetch(
      new Response(PNG_BYTES, { headers: { 'content-type': 'image/png' }, status: 200 }),
    );
    await expect(pUnsignaled).resolves.toEqual({
      base64: PNG_BYTES.toString('base64'),
      mimeType: 'image/png',
    });

    // Part 2: Sole signaled caller aborts -> sharedController aborts, and a new caller arriving
    // BEFORE the aborted fetch settles must NOT attach to the aborted entry!
    let rejectAbortedFetch!: (err: Error) => void;
    const raceUrl = 'https://cdn.example.com/sole-abort-race.png';
    mockSsrfSafeFetch
      .mockImplementationOnce(
        () =>
          new Promise<Response>((_resolve, reject) => {
            rejectAbortedFetch = reject;
          }),
      )
      .mockResolvedValueOnce(
        new Response(JPEG_BYTES, { headers: { 'content-type': 'image/jpeg' }, status: 200 }),
      );

    const soleController = new AbortController();
    const pSole = imageUrlToBase64(raceUrl, { signal: soleController.signal });
    await new Promise((r) => setTimeout(r, 10));

    soleController.abort(new Error('Sole waiter cancelled'));
    // Immediately invoke a fresh caller BEFORE rejectAbortedFetch unwinds
    const pFresh = imageUrlToBase64(raceUrl);

    await expect(pSole).rejects.toThrow(/Sole waiter cancelled/);
    rejectAbortedFetch(
      Object.assign(new Error('aborted'), { isCallerAbort: true, name: 'AbortError' }),
    );

    await expect(pFresh).resolves.toEqual({
      base64: JPEG_BYTES.toString('base64'),
      mimeType: 'image/jpeg',
    });
    expect(mockSsrfSafeFetch).toHaveBeenCalledTimes(3);
  });

  it('blocks unsigned bare private URLs from reading local mirror or warm bucket:<key> cache', async () => {
    const mirrorDir = await mkdtemp(path.join(tmpdir(), 'lc-sec-mirror-'));
    tempDirs.push(mirrorDir);
    process.env.S3_LOCAL_MIRROR_DIR = mirrorDir;
    process.env.LOBECHAT_BACKEND_KEY = 'studio-secret';

    const victimKey = 'files/user_victim/secret/image';
    await mkdir(path.join(mirrorDir, 'files/user_victim/secret'), { recursive: true });
    await writeFile(path.join(mirrorDir, victimKey), PNG_BYTES);

    // 1. Legitimate signed access populates bucket:<victimKey> cache from mirror
    const signedUrl = `https://storage.yandexcloud.net/imagestudio/${victimKey}?X-Amz-Date=20261125T140000Z&X-Amz-Signature=validsig`;
    const legit = await imageUrlToBase64(signedUrl);
    expect(legit.mimeType).toBe('image/png');
    expect(mockSsrfSafeFetch).not.toHaveBeenCalled();

    // 2. Attacker sends bare S3 URL and bare media.arckep.ru URL without signature -> must NOT hit mirror or cache!
    const studioSpy = vi.spyOn(globalThis, 'fetch');
    mockSsrfSafeFetch.mockResolvedValue(new Response('AccessDenied', { status: 403 }));

    await expect(
      imageUrlToBase64(`https://storage.yandexcloud.net/imagestudio/${victimKey}`),
    ).rejects.toThrow(/HTTP 403/);
    await expect(imageUrlToBase64(`https://media.arckep.ru/m/${victimKey}`)).rejects.toThrow(
      /HTTP 403/,
    );

    expect(mockSsrfSafeFetch).toHaveBeenCalledTimes(2);
    expect(studioSpy).not.toHaveBeenCalled();
  });

  it('normalizes /chat/f/<id>/ cache keys, respects TTL, evicts LRU, and skips entries > MAX_ENTRY_BYTES', async () => {
    process.env.APP_URL = 'https://arckep.ru/chat';

    mockSsrfSafeFetch.mockImplementation(
      async () =>
        new Response(PNG_BYTES, { headers: { 'content-type': 'image/png' }, status: 200 }),
    );

    // /chat/f/file_123/ and /chat/f/file_123#top share one cache entry
    await imageUrlToBase64('https://arckep.ru/chat/f/file_123/');
    await imageUrlToBase64('https://arckep.ru/chat/f/file_123#top');
    expect(mockSsrfSafeFetch).toHaveBeenCalledTimes(1);

    // /chat/s3-proxy/imagestudio/<key>?X-Amz-Signature=... shares canonical bucket:<key> cache
    await imageUrlToBase64(
      'https://arckep.ru/chat/s3-proxy/imagestudio/files/user_x/p1/image?X-Amz-Date=20261125T140000Z&X-Amz-Signature=s1',
    );
    await imageUrlToBase64(
      'https://storage.yandexcloud.net/imagestudio/files/user_x/p1/image?X-Amz-Date=20261125T150000Z&X-Amz-Signature=s2',
    );
    expect(mockSsrfSafeFetch).toHaveBeenCalledTimes(2);

    // Oversized payload (> SERVER_IMAGE_CACHE_MAX_ENTRY_BYTES, e.g. >9 MiB raw -> >12 MiB base64) is NOT cached
    // and does NOT evict existing warm chat images!
    const hugeBinary = Buffer.alloc(Math.ceil((SERVER_IMAGE_CACHE_MAX_ENTRY_BYTES + 16) * 0.75), 1);
    mockSsrfSafeFetch.mockResolvedValueOnce(
      new Response(hugeBinary, { headers: { 'content-type': 'video/mp4' }, status: 200 }),
    );
    const hugeRes = await imageUrlToBase64('https://cdn.example.com/huge-video.mp4');
    expect(hugeRes.base64.length).toBeGreaterThan(SERVER_IMAGE_CACHE_MAX_ENTRY_BYTES);

    // Warm chat image is still in cache (0 extra fetch calls)
    await imageUrlToBase64('https://arckep.ru/chat/f/file_123');
    expect(mockSsrfSafeFetch).toHaveBeenCalledTimes(3);

    // TTL expiration evicts stale entry
    const baseNow = Date.now();
    const nowSpy = vi
      .spyOn(Date, 'now')
      .mockReturnValue(baseNow + SERVER_IMAGE_CACHE_TTL_MS + 1000);
    mockSsrfSafeFetch.mockResolvedValueOnce(
      new Response(PNG_BYTES, { headers: { 'content-type': 'image/png' }, status: 200 }),
    );
    await imageUrlToBase64('https://arckep.ru/chat/f/file_123');
    expect(mockSsrfSafeFetch).toHaveBeenCalledTimes(4);
    nowSpy.mockRestore();
  });

  it('evicts oldest LRU entries when total cached base64 exceeds SERVER_IMAGE_CACHE_MAX_BYTES (64 MiB)', async () => {
    // 7 entries * ~10 MiB base64 each (> 64 MiB total, each <= 12 MiB MAX_ENTRY_BYTES)
    const perEntryRawBytes = 7_600_000; // ~10.13 MiB base64
    expect(Math.ceil((perEntryRawBytes * 4) / 3)).toBeLessThanOrEqual(
      SERVER_IMAGE_CACHE_MAX_ENTRY_BYTES,
    );
    expect(Math.ceil((perEntryRawBytes * 4) / 3) * 7).toBeGreaterThan(SERVER_IMAGE_CACHE_MAX_BYTES);

    mockSsrfSafeFetch.mockImplementation(async (url: string) => {
      const buf = Buffer.alloc(perEntryRawBytes, url.charCodeAt(url.length - 5));
      PNG_BYTES.copy(buf, 0);
      return new Response(buf, { headers: { 'content-type': 'image/png' }, status: 200 });
    });

    for (let i = 0; i < 7; i++) {
      await imageUrlToBase64(`https://cdn.example.com/lru-${i}.png`);
    }
    expect(mockSsrfSafeFetch).toHaveBeenCalledTimes(7);

    // Most recent entry (lru-6) is still cached (0 new fetches)
    await imageUrlToBase64('https://cdn.example.com/lru-6.png');
    expect(mockSsrfSafeFetch).toHaveBeenCalledTimes(7);

    // Oldest entry (lru-0) was evicted by byte cap -> triggers re-fetch
    await imageUrlToBase64('https://cdn.example.com/lru-0.png');
    expect(mockSsrfSafeFetch).toHaveBeenCalledTimes(8);
  });

  it('caps Step 3 to 1 fast probe (<=5000ms) and skips unmirrored 302 redirect when S3 breaker is already open', async () => {
    process.env.LOBECHAT_BACKEND_KEY = 'studio-secret';
    const outageErr = new Response(S3_XML_503, { status: 503 });
    mockSsrfSafeFetch.mockResolvedValue(outageErr);

    // Trip the S3 circuit breaker (3 failures)
    await expect(
      imageUrlToBase64(
        'https://storage.yandexcloud.net/imagestudio/files/user_x/trip/image?X-Amz-Date=20261125T140000Z&X-Amz-Signature=s0',
        { retryDelaysMs: [0, 0] },
      ),
    ).rejects.toThrow(/HTTP 503/);

    mockSsrfSafeFetch.mockClear();
    const unmirroredKey = 'files/user_x/not_mirrored/image';
    const exp = Math.floor(Date.now() / 1000) + 7200;
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          mirrored: { [unmirroredKey]: false },
          s3_down: true,
          urls: {
            [unmirroredKey]: `https://media.arckep.ru/m/${unmirroredKey}?exp=${exp}&sig=abcd`,
          },
        }),
        { headers: { 'content-type': 'application/json' }, status: 200 },
      ),
    );

    const s3Url = `https://storage.yandexcloud.net/imagestudio/${unmirroredKey}?X-Amz-Date=20261125T140000Z&X-Amz-Signature=s1`;
    await expect(imageUrlToBase64(s3Url)).rejects.toThrow(/HTTP 503/);

    // Only 1 fast probe against S3 (timeoutMs capped to 5000ms), 0 calls to media.arckep.ru
    expect(mockSsrfSafeFetch).toHaveBeenCalledTimes(1);
    expect(mockSsrfSafeFetch).toHaveBeenCalledWith(s3Url, { timeoutMs: 5_000 });
  });
});
