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

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createSkillSafeFetch, MAX_SKILL_REDIRECTS, skillSafeFetch } from './safeFetch';

// arckep (19.10.2026): ссылки на навыки от людей не должны вести во внутренние службы движка.
// Запрещённые адреса отсекаются агентом до соединения, сеть тестам не нужна.

describe('skillSafeFetch', () => {
  it.each([
    ['http://example.com/SKILL.md', /Only https/],
    ['ftp://example.com/x', /Only https/],
    ['file:///etc/passwd', /Only https/],
    ['https://user:pass@example.com/x', /login or password/],
    ['не ссылка', /Invalid URL/],
  ])('%s отклоняется до запроса', async (url, message) => {
    await expect(skillSafeFetch(url)).rejects.toThrow(message);
  });

  it.each([
    'https://127.0.0.1/',
    'https://127.0.0.1:8202/api/internal',
    'https://localhost/',
    'https://[::1]/',
    'https://169.254.169.254/latest/meta-data/',
    'https://10.0.0.5/',
    'https://192.168.1.10/',
    'https://172.16.0.1/',
  ])('внутренний адрес %s заблокирован', async (url) => {
    await expect(skillSafeFetch(url)).rejects.toThrow(/SSRF blocked|is not allowed|Fetch failed/);
  });

  it('переменная SSRF_ALLOW_PRIVATE_IP_ADDRESS=1 здесь не действует', async () => {
    vi.stubEnv('SSRF_ALLOW_PRIVATE_IP_ADDRESS', '1');
    try {
      await expect(skillSafeFetch('https://127.0.0.1/')).rejects.toThrow(
        /SSRF blocked|is not allowed/,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('skillSafeFetch: имя, которое резолвится во внутренний адрес (подмена DNS)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
  });

  /**
   * Агент запросов берёт `lookup` из ESM-пространства имён `node:dns`: подмена свойства у CJS-объекта видна
   * ему только после syncBuiltinESMExports(). Имена из `answers` резолвятся в заданный адрес, остальные — как обычно. */
  const fakeDns = (answers: Record<string, string>) => {
    const real = dns.lookup;
    vi.spyOn(dns, 'lookup').mockImplementation(((hostname: string, options: any, callback: any) => {
      const cb = typeof options === 'function' ? options : callback;
      const address = answers[hostname];
      if (!address) return (real as any)(hostname, options, callback);
      const family = address.includes(':') ? 6 : 4;
      if (typeof options === 'object' && options?.all) cb(null, [{ address, family }]);
      else cb(null, address, family);
    }) as any);
    syncBuiltinESMExports();
  };

  it.each([
    ['loopback', '127.0.0.1'],
    ['метаданные облака', '169.254.169.254'],
    ['частная сеть', '10.1.2.3'],
    ['loopback IPv6', '::1'],
  ])('имя → %s отклоняется на соединении', async (_, address) => {
    fakeDns({ 'looks-public.example.test': address });
    await expect(skillSafeFetch('https://looks-public.example.test/SKILL.md')).rejects.toThrow(
      /SSRF blocked|is not allowed/,
    );
  });
});

// Настоящий локальный HTTPS-сервер: самоподписанный сертификат делает openssl. Локальный адрес 127.0.0.1
// разрешается только в тестовом экземпляре (опция ssrf), остальное внутреннее остаётся закрытым.
const hasOpenssl = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.runIf(hasOpenssl)('skillSafeFetch: переадресации (локальный HTTPS-сервер)', () => {
  let dir: string;
  let server: https.Server;
  let port: number;
  let requests: string[];
  let handlers: Record<string, (res: ServerResponse) => void>;
  let previousTls: string | undefined;

  const safe = (extra: Parameters<typeof createSkillSafeFetch>[0] = {}) =>
    createSkillSafeFetch({ ssrf: { allowIPAddressList: ['127.0.0.1'] }, ...extra });
  const base = () => `https://127.0.0.1:${port}`;
  const redirect = (res: ServerResponse, location: string, status = 302) => {
    res.writeHead(status, { Location: location });
    res.end();
  };

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'safe-fetch-'));
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
    // самоподписанный сертификат принимается только в этом файле
    previousTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

    server = https.createServer(
      {
        cert: readFileSync(path.join(dir, 'cert.pem')),
        key: readFileSync(path.join(dir, 'key.pem')),
      },
      (req, res) => {
        requests.push(req.url ?? '');
        const handler = handlers[req.url ?? ''];
        if (handler) return handler(res);
        res.writeHead(404);
        res.end('no');
      },
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    if (previousTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTls;
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { force: true, recursive: true });
  });

  afterEach(() => {
    requests = [];
    handlers = {};
  });

  // beforeEach для первого теста: afterEach выше сработает только после него
  requests = [];
  handlers = {};

  it('без переадресации: обычный ответ (проверка самой установки теста)', async () => {
    handlers['/skill.md'] = (res) => {
      res.writeHead(200, { 'Content-Type': 'text/markdown' });
      res.end('# skill');
    };
    const response = await safe()(`${base()}/skill.md`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('# skill');
  });

  it('переадресация https → внутренний адрес отклонена (метаданные, частная сеть)', async () => {
    for (const target of [
      'https://169.254.169.254/latest/meta-data/',
      'https://10.0.0.5/admin',
      'https://192.168.1.1/',
    ]) {
      requests = [];
      handlers['/to-internal'] = (res) => redirect(res, target);

      await expect(safe()(`${base()}/to-internal`), target).rejects.toThrow(
        /SSRF blocked|is not allowed/,
      );
      // первый шаг дошёл до сервера (переадресация была), второй — к внутреннему адресу — нет
      expect(requests).toEqual(['/to-internal']);
    }
  });

  it('переадресация на loopback с другим портом тоже отклонена, если он не разрешён', async () => {
    handlers['/to-other-port'] = (res) => redirect(res, 'https://[::1]:9/x');
    await expect(safe()(`${base()}/to-other-port`)).rejects.toThrow(/SSRF blocked|is not allowed/);
  });

  it('переадресация https → http отклонена до соединения', async () => {
    handlers['/downgrade'] = (res) => redirect(res, 'http://example.com/SKILL.md');
    const error = await safe()(`${base()}/downgrade`).catch((e) => e);
    expect(error.message).toContain('Only https links are allowed');
    expect(error.message).toContain('redirect to http://example.com');
    expect(requests).toEqual(['/downgrade']);
  });

  it('переадресация на ссылку с логином отклонена', async () => {
    handlers['/creds'] = (res) => redirect(res, 'https://user:pass@example.com/x');
    await expect(safe()(`${base()}/creds`)).rejects.toThrow('login or password');
  });

  it('относительная переадресация проходит (301, 302, 307, 308 → итоговый ответ)', async () => {
    for (const status of [301, 302, 307, 308]) {
      requests = [];
      handlers['/a'] = (res) => redirect(res, '/b', status);
      handlers['/b'] = (res) => {
        res.writeHead(200);
        res.end(`final ${status}`);
      };
      const response = await safe()(`${base()}/a`);
      expect(await response.text()).toBe(`final ${status}`);
      expect(requests).toEqual(['/a', '/b']);
    }
  });

  it('цепочка переадресаций ограничена', async () => {
    handlers['/loop'] = (res) => redirect(res, '/loop');
    const error = await safe()(`${base()}/loop`).catch((e) => e);
    expect(error.message).toContain('Too many redirects');
    // исходный запрос + MAX_SKILL_REDIRECTS переходов
    expect(requests).toHaveLength(MAX_SKILL_REDIRECTS + 1);

    requests = [];
    await expect(safe({ maxRedirects: 1 })(`${base()}/loop`)).rejects.toThrow('Too many redirects');
    expect(requests).toHaveLength(2);
  });

  it('переадресация без Location и с битым Location — понятная ошибка', async () => {
    handlers['/no-location'] = (res) => {
      res.writeHead(302);
      res.end();
    };
    await expect(safe()(`${base()}/no-location`)).rejects.toThrow('without a location');

    handlers['/bad-location'] = (res) => redirect(res, 'https://[bad');
    await expect(safe()(`${base()}/bad-location`)).rejects.toThrow('Invalid URL in a redirect');
  });

  it('без разрешения тестового адреса даже первый шаг к локальному серверу закрыт', async () => {
    handlers['/skill.md'] = (res) => res.end('x');
    await expect(createSkillSafeFetch()(`${base()}/skill.md`)).rejects.toThrow(
      /SSRF blocked|is not allowed/,
    );
    expect(requests).toEqual([]);
  });
});
