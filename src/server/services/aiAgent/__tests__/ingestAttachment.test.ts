// @vitest-environment node
import { execFileSync } from 'node:child_process';
import dns from 'node:dns';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { type ServerResponse } from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ingestAttachment,
  type IngestAttachmentOptions,
  MAX_UPLOAD_BYTES,
} from '../ingestAttachment';

// arckep (19.10.2026): ingest отдаёт модели все куски длинной картинки по порядку, обычную — одним файлом.

let counter = 0;
const fileService = {
  getFullFileUrl: vi.fn(async (key: string) => `https://s3.test/${key}`),
  uploadFromBuffer: vi.fn(async (_buffer: Buffer, _mime: string, pathname: string) => ({
    fileId: `file_${++counter}`,
    key: pathname,
  })),
};

const ingest = (
  source: Parameters<typeof ingestAttachment>[0],
  options?: IngestAttachmentOptions,
) => ingestAttachment(source, fileService as any, 'user_1', options);

const canvas = (width: number, height: number, format: 'jpeg' | 'png' = 'jpeg') => {
  const image = sharp({ create: { background: '#445566', channels: 3, height, width } });
  return format === 'jpeg' ? image.jpeg().toBuffer() : image.png().toBuffer();
};

beforeEach(() => {
  counter = 0;
  vi.clearAllMocks();
});

describe('ingestAttachment — картинки', () => {
  it('длинный макет 2512×23050: 8 файлов «имя.part-NN-of-08.png» по порядку, поля прежнего вида — у первого', async () => {
    const result = await ingest({ buffer: await canvas(2512, 23_050), name: 'letter.jpg' });

    expect(result.isImage).toBe(true);
    expect(result.images).toHaveLength(8);
    expect(result.images.map((image) => image.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(result.images.every((image) => image.total === 8)).toBe(true);
    expect(result.images.map((image) => image.name)).toEqual(
      Array.from({ length: 8 }, (_, i) => `letter.jpg.part-0${i + 1}-of-08.png`),
    );
    const uploaded = fileService.uploadFromBuffer.mock.calls.map((call) => call[2]);
    expect(uploaded).toHaveLength(8);
    expect(uploaded.every((path) => path.startsWith('files/user_1/'))).toBe(true);
    expect(uploaded.map((path) => path.split('/').at(-1))).toEqual(
      result.images.map((image) => image.name),
    );
    for (const call of fileService.uploadFromBuffer.mock.calls) {
      expect(call[1]).toBe('image/png');
      const meta = await sharp(call[0]).metadata();
      expect([meta.width, meta.height]).toEqual([1536, 2048]);
    }
    expect(result.source).toEqual({ height: 23_050, width: 2512 });
    expect(result.unchanged).toBe(false);
    expect(result.images.every((image) => image.width === 1536 && image.height === 2048)).toBe(
      true,
    );
    expect(result.fileId).toBe(result.images[0].fileId);
    expect(result.key).toBe(result.images[0].key);
    expect(result.resolvedUrl).toBe(result.images[0].resolvedUrl);
    expect(result.resolvedUrl).toMatch(/^https:\/\/s3\.test\/files\/user_1\/.+part-01-of-08\.png$/);
  }, 60_000);

  it('обычное фото в пределах: один файл под своим именем, байты не менялись', async () => {
    const photo = await canvas(1200, 800);
    const result = await ingest({ buffer: photo, mimeType: 'image/jpeg', name: 'photo.jpg' });

    expect(result.images).toHaveLength(1);
    expect(result.images[0]).toMatchObject({
      height: 800,
      index: 1,
      name: 'photo.jpg',
      total: 1,
      width: 1200,
    });
    expect(result.unchanged).toBe(true);
    expect(result.source).toEqual({ height: 800, width: 1200 });
    expect(fileService.uploadFromBuffer).toHaveBeenCalledTimes(1);
    const [buffer, mime, pathname] = fileService.uploadFromBuffer.mock.calls[0];
    expect(buffer).toBe(photo);
    expect(mime).toBe('image/jpeg');
    expect(pathname.endsWith('/photo.jpg')).toBe(true);
  });

  it('большое фото 4000×3000: один файл, сжат по ширине до 1536 (PNG)', async () => {
    const result = await ingest({ buffer: await canvas(4000, 3000), name: 'big.jpg' });

    expect(result.images).toHaveLength(1);
    const [buffer, mime] = fileService.uploadFromBuffer.mock.calls[0];
    expect(mime).toBe('image/png');
    const meta = await sharp(buffer).metadata();
    expect([meta.width, meta.height]).toEqual([1536, 1152]);
    expect(result.unchanged).toBe(false);
    expect(result.source).toEqual({ height: 3000, width: 4000 });
    expect(result.images[0]).toMatchObject({ height: 1152, width: 1536 });
  });

  it('экран телефона 1170×2532 — один файл, не режется', async () => {
    const result = await ingest({ buffer: await canvas(1170, 2532, 'png'), name: 'screen.png' });
    expect(result.images).toHaveLength(1);
    expect(fileService.uploadFromBuffer).toHaveBeenCalledTimes(1);
  });

  it('картинка по ссылке тоже режется', async () => {
    const tall = await canvas(1600, 9000);
    const result = await ingest(
      { name: 'long.jpg', url: 'https://example.com/long.jpg' },
      {
        baseFetch: vi.fn(
          async () =>
            new Response(new Uint8Array(tall), {
              headers: { 'content-type': 'image/jpeg; charset=binary' },
            }),
        ),
      },
    );
    expect(result.images.length).toBeGreaterThan(1);
    expect(result.images.every((image) => image.total === result.images.length)).toBe(true);
  }, 60_000);
});

describe('ingestAttachment — не картинки', () => {
  it('PDF и прочее: один файл, images пуст, resolvedUrl пуст — как раньше', async () => {
    const result = await ingest({
      buffer: Buffer.from('%PDF-1.4'),
      mimeType: 'application/pdf',
      name: 'doc.pdf',
    });

    expect(result.isImage).toBe(false);
    expect(result.images).toEqual([]);
    expect(result.resolvedUrl).toBe('');
    expect(result.unchanged).toBe(true);
    expect(result.source).toBeUndefined();
    expect(result.fileId).toBe('file_1');
    expect(fileService.uploadFromBuffer.mock.calls[0][1]).toBe('application/pdf');
    expect(fileService.getFullFileUrl).not.toHaveBeenCalled();
  });

  it('нет ни буфера, ни ссылки — понятная ошибка', async () => {
    await expect(ingest({ name: 'x' })).rejects.toThrow('buffer or url');
  });
});

describe('ingestAttachment — защита SSRF и лимит размера', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
  });

  it('MAX_UPLOAD_BYTES равен 50 МБ', () => {
    expect(MAX_UPLOAD_BYTES).toBe(50 * 1024 * 1024);
  });

  it.each([
    ['http://127.0.0.1:8202/api/internal', /Only https/],
    ['http://169.254.169.254/latest/meta-data/', /Only https/],
    ['file:///etc/passwd', /Only https/],
    ['https://user:secret@example.com/a.pdf', /credentials/],
  ])('отклоняет небезопасную схему/учётные данные: %s', async (url, pattern) => {
    await expect(ingest({ name: 'a.pdf', url })).rejects.toThrow(pattern);
    expect(fileService.uploadFromBuffer).not.toHaveBeenCalled();
  });

  it.each([
    'https://127.0.0.1/secret.pdf',
    'https://169.254.169.254/latest/meta-data/',
    'https://10.0.0.5/internal.pdf',
    'https://[::1]/secret.pdf',
  ])('блокирует внутренний/метаданные IP даже по https: %s', async (url) => {
    vi.stubEnv('SSRF_ALLOW_PRIVATE_IP_ADDRESS', '1');
    try {
      await expect(ingest({ name: 'a.pdf', url })).rejects.toThrow(
        /SSRF blocked|is not allowed|Fetch failed/,
      );
      expect(fileService.uploadFromBuffer).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('блокирует DNS-резолв публичного домена в 127.0.0.1 и 169.254.169.254', async () => {
    const realLookup = dns.lookup;
    vi.spyOn(dns, 'lookup').mockImplementation(((hostname: string, options: any, callback: any) => {
      const cb = typeof options === 'function' ? options : callback;
      const mapped =
        hostname === 'rebind-local.example.test'
          ? '127.0.0.1'
          : hostname === 'rebind-meta.example.test'
            ? '169.254.169.254'
            : undefined;
      if (!mapped) return (realLookup as any)(hostname, options, callback);
      if (typeof options === 'object' && options?.all) cb(null, [{ address: mapped, family: 4 }]);
      else cb(null, mapped, 4);
    }) as any);
    syncBuiltinESMExports();

    await expect(
      ingest({ name: 'a.pdf', url: 'https://rebind-local.example.test/a.pdf' }),
    ).rejects.toThrow(/SSRF blocked|is not allowed/);
    await expect(
      ingest({ name: 'a.pdf', url: 'https://rebind-meta.example.test/a.pdf' }),
    ).rejects.toThrow(/SSRF blocked|is not allowed/);
  });

  it('блокирует редирект https -> http://127.0.0.1', async () => {
    const baseFetch = vi.fn(
      async () =>
        new Response(null, {
          headers: { location: 'http://127.0.0.1:8202/internal' },
          status: 302,
        }),
    );

    await expect(
      ingest({ name: 'a.pdf', url: 'https://cdn.example.com/start' }, { baseFetch }),
    ).rejects.toThrow(
      /Only https attachment URLs are allowed \(redirect to http:\/\/127\.0\.0\.1:8202\)/,
    );
    expect(baseFetch).toHaveBeenCalledTimes(1);
    expect(fileService.uploadFromBuffer).not.toHaveBeenCalled();
  });

  it('аварийно обрывает потоковое чтение при превышении лимита размера без чтения хвоста потока', async () => {
    let chunksPulled = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
      pull(controller) {
        chunksPulled += 1;
        controller.enqueue(new Uint8Array(600));
      },
    });

    const baseFetch = vi.fn(
      async () =>
        new Response(stream, {
          headers: { 'content-type': 'application/pdf' },
          status: 200,
        }),
    );

    await expect(
      ingest(
        { name: 'huge.pdf', url: 'https://cdn.example.com/huge.pdf' },
        { baseFetch, maxBytes: 1024 },
      ),
    ).rejects.toThrow(/exceeds limit \(1024 bytes\)/);

    expect(chunksPulled).toBeLessThanOrEqual(3);
    expect(cancelled).toBe(true);
    expect(fileService.uploadFromBuffer).not.toHaveBeenCalled();
  });
});

const hasOpenssl = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.runIf(hasOpenssl)(
  'ingestAttachment — реальный локальный HTTPS-сервер (редиректы и размер)',
  () => {
    let dir: string;
    let server: https.Server;
    let port: number;
    let handlers: Record<string, (res: ServerResponse) => void>;
    let previousTls: string | undefined;

    beforeAll(async () => {
      dir = mkdtempSync(path.join(tmpdir(), 'ingest-safe-fetch-'));
      execFileSync(
        'openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-days',
          '1',
          '-keyout',
          path.join(dir, 'key.pem'),
          '-out',
          path.join(dir, 'cert.pem'),
          '-subj',
          '/CN=127.0.0.1',
          '-addext',
          'subjectAltName=IP:127.0.0.1',
        ],
        { stdio: 'ignore' },
      );
      previousTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

      handlers = {};
      server = https.createServer(
        {
          cert: readFileSync(path.join(dir, 'cert.pem')),
          key: readFileSync(path.join(dir, 'key.pem')),
        },
        (req, res) => {
          const handler = handlers[req.url || '/'];
          if (handler) handler(res);
          else {
            res.writeHead(404);
            res.end();
          }
        },
      );
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      port = (server.address() as AddressInfo).port;
    });

    afterAll(async () => {
      if (previousTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTls;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { force: true, recursive: true });
    });

    it('блокирует 302 редирект с https на http://127.0.0.1 и обрывает ответ крупнее maxBytes на лету', async () => {
      handlers['/to-http'] = (res) => {
        res.writeHead(302, { Location: 'http://127.0.0.1:8202/secret' });
        res.end();
      };
      handlers['/too-big'] = (res) => {
        res.writeHead(200, { 'Content-Type': 'application/pdf' });
        res.end(Buffer.alloc(4096, 0x41));
      };

      await expect(
        ingest(
          { name: 'a.pdf', url: `https://127.0.0.1:${port}/to-http` },
          { ssrf: { allowIPAddressList: ['127.0.0.1'] } },
        ),
      ).rejects.toThrow(/Only https attachment URLs are allowed/);

      await expect(
        ingest(
          { name: 'big.pdf', url: `https://127.0.0.1:${port}/too-big` },
          { maxBytes: 1024, ssrf: { allowIPAddressList: ['127.0.0.1'] } },
        ),
      ).rejects.toThrow(/over limit|exceeds limit/);
    });
  },
);
