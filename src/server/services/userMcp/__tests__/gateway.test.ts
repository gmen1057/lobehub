import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildUserMcpHeaders,
  buildUserMcpManifest,
  getUserMcpGatewayUrl,
  listUserMcpTools,
  sanitizeUserMcpTools,
  UserMcpGatewayError,
} from '../gateway';

/**
 * arckep (19.10.2026, этап 3, п. 3.В): клиент шлюза для создания своего подключения —
 * initialize → notifications/initialized → tools/list, ошибки шлюза дословно и со статусом.
 */

const SEALED = 'enc:v1:AAAA_bbbb-CCCC';
const headers = buildUserMcpHeaders({
  arckepUserId: 15,
  identifier: 'umcp-abcdefghijkl',
  sealed: SEALED,
});

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    status: 200,
    ...init,
  });

const rpc = (id: number, result: unknown) => ({ id, jsonrpc: '2.0', result });

/** Шлюз-заглушка: отвечает по методам запроса, запоминает вызовы. */
const gatewayFetch = (handlers: Record<string, (body: any) => Response | Promise<Response>>) => {
  const calls: Array<{ body: any; headers: Record<string, string>; url: string }> = [];
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ body, headers: init.headers as Record<string, string>, url });
    const handler = handlers[body.method];
    if (!handler) throw new Error(`unexpected method ${body.method}`);
    return handler(body);
  });
  return { calls, fn: fn as unknown as typeof fetch };
};

describe('buildUserMcpHeaders', () => {
  it('заголовки п. 3.Б: номер человека, идентификатор, шифротекст; тема — только если дана', () => {
    expect(headers).toEqual({
      'X-Arckep-User': '15',
      'X-Arckep-User-Mcp-Config': SEALED,
      'X-Arckep-User-Mcp-Id': 'umcp-abcdefghijkl',
    });
    expect(
      buildUserMcpHeaders({
        arckepUserId: 15,
        identifier: 'umcp-abcdefghijkl',
        sealed: SEALED,
        topicId: 'tpc_1',
      })['X-Arckep-Topic'],
    ).toBe('tpc_1');
  });

  it('переводы строк в значениях вырезаются (внедрение заголовков)', () => {
    const evil = buildUserMcpHeaders({
      arckepUserId: 1,
      identifier: 'umcp-abcdefghijkl',
      sealed: `enc:v1:AA\r\nX-Evil: 1`,
    });
    expect(evil['X-Arckep-User-Mcp-Config']).toBe('enc:v1:AAX-Evil: 1');
    expect(evil['X-Arckep-User-Mcp-Config']).not.toMatch(/[\r\n]/);
  });
});

describe('getUserMcpGatewayUrl', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it('по умолчанию внутренний путь шлюза, иначе USER_MCP_GATEWAY_URL', () => {
    delete process.env.USER_MCP_GATEWAY_URL;
    expect(getUserMcpGatewayUrl()).toBe('http://127.0.0.1:8410/mcp/user-mcp');
    process.env.USER_MCP_GATEWAY_URL = 'http://127.0.0.1:9999/mcp/user-mcp';
    expect(getUserMcpGatewayUrl()).toBe('http://127.0.0.1:9999/mcp/user-mcp');
  });
});

describe('listUserMcpTools', () => {
  const tool = (name: string, extra: Record<string, unknown> = {}) => ({
    description: `${name} desc`,
    inputSchema: { properties: { q: { type: 'string' } }, type: 'object' },
    name,
    ...extra,
  });

  it('initialize → notifications/initialized → tools/list, заголовки на каждом запросе', async () => {
    const { calls, fn } = gatewayFetch({
      'initialize': (body) => json(rpc(body.id, { protocolVersion: '2024-11-05' })),
      'notifications/initialized': () => new Response(null, { status: 202 }),
      'tools/list': (body) => json(rpc(body.id, { tools: [tool('search'), tool('read_page')] })),
    });

    const tools = await listUserMcpTools({ fetchImpl: fn, headers });

    expect(calls.map((call) => call.body.method)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/list',
    ]);
    expect(tools.map((item) => item.name)).toEqual(['search', 'read_page']);
    expect(tools[0]).toEqual({
      description: 'search desc',
      name: 'search',
      parameters: { properties: { q: { type: 'string' } }, type: 'object' },
    });
    for (const call of calls) {
      expect(call.url).toBe('http://127.0.0.1:8410/mcp/user-mcp');
      expect(call.headers['X-Arckep-User']).toBe('15');
      expect(call.headers['X-Arckep-User-Mcp-Id']).toBe('umcp-abcdefghijkl');
      expect(call.headers['X-Arckep-User-Mcp-Config']).toBe(SEALED);
    }
    // уведомление — без номера запроса
    expect(calls[1].body.id).toBeUndefined();
  });

  it('постраничный tools/list собирается целиком', async () => {
    let page = 0;
    const { fn } = gatewayFetch({
      'initialize': (body) => json(rpc(body.id, {})),
      'notifications/initialized': () => new Response(null, { status: 202 }),
      'tools/list': (body) =>
        json(
          rpc(
            body.id,
            page++ === 0
              ? { nextCursor: 'c2', tools: [tool('a')] }
              : { tools: [tool('b')] },
          ),
        ),
    });
    const tools = await listUserMcpTools({ fetchImpl: fn, headers });
    expect(tools.map((item) => item.name)).toEqual(['a', 'b']);
  });

  it('ответ потоком событий (data: …) тоже читается', async () => {
    const sse = (id: number, result: unknown) =>
      new Response(`event: message\ndata: ${JSON.stringify(rpc(id, result))}\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
        status: 200,
      });
    const { fn } = gatewayFetch({
      'initialize': (body) => sse(body.id, {}),
      'notifications/initialized': () => new Response(null, { status: 202 }),
      'tools/list': (body) => sse(body.id, { tools: [tool('x')] }),
    });
    expect((await listUserMcpTools({ fetchImpl: fn, headers })).map((item) => item.name)).toEqual(['x']);
  });

  it('ошибка шлюза в теле JSON-RPC — его русский текст, строка не создаётся', async () => {
    const { fn } = gatewayFetch({
      initialize: (body) =>
        json({ error: { code: -32_602, message: 'Недостаточно средств на балансе' }, id: body.id, jsonrpc: '2.0' }),
    });
    const error = await listUserMcpTools({ fetchImpl: fn, headers }).catch((e) => e);
    expect(error).toBeInstanceOf(UserMcpGatewayError);
    expect(error.message).toBe('Недостаточно средств на балансе');
    expect(error.status).toBe(400);
  });

  it('шлюз подсказывает статус в error.data.status (402 — деньги), прочие коды — 502', async () => {
    const make = (error: Record<string, unknown>) =>
      gatewayFetch({
        initialize: (body) => json({ error, id: body.id, jsonrpc: '2.0' }),
      }).fn;

    const money = await listUserMcpTools({
      fetchImpl: make({ code: -32_000, data: { status: 402 }, message: 'Недостаточно средств' }),
      headers,
    }).catch((e) => e);
    expect(money.status).toBe(402);

    const other = await listUserMcpTools({
      fetchImpl: make({ code: -32_603, message: 'Адрес внутренней сети запрещён' }),
      headers,
    }).catch((e) => e);
    expect(other.message).toBe('Адрес внутренней сети запрещён');
    expect(other.status).toBe(502);
  });

  it('HTTP-ошибка шлюза: 4xx из списка проходит, 401/403/5xx — 502; текст берётся из тела', async () => {
    const reply = (status: number, message: string) =>
      gatewayFetch({
        initialize: (body) => json({ error: { code: -32_001, message }, id: body.id }, { status }),
      }).fn;

    const tooMany = await listUserMcpTools({ fetchImpl: reply(429, 'Слишком много запросов'), headers }).catch((e) => e);
    expect([tooMany.message, tooMany.status]).toEqual(['Слишком много запросов', 429]);

    const forbidden = await listUserMcpTools({ fetchImpl: reply(403, 'Только внутренний путь'), headers }).catch((e) => e);
    expect([forbidden.message, forbidden.status]).toEqual(['Только внутренний путь', 502]);

    const plain = gatewayFetch({
      initialize: () => new Response('Bad Gateway', { headers: { 'content-type': 'text/plain' }, status: 502 }),
    }).fn;
    const bad = await listUserMcpTools({ fetchImpl: plain, headers }).catch((e) => e);
    expect([bad.message, bad.status]).toEqual(['Bad Gateway', 502]);
  });

  it('сеть недоступна — 502 по-русски; нет ответа за срок — 504 «не ответил за 2 минуты»', async () => {
    const down = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const unreachable = await listUserMcpTools({ fetchImpl: down, headers }).catch((e) => e);
    expect(unreachable.status).toBe(502);
    expect(unreachable.message).toContain('недоступен');

    const slow = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    ) as unknown as typeof fetch;
    const timeout = await listUserMcpTools({ fetchImpl: slow, headers, timeoutMs: 20 }).catch((e) => e);
    expect(timeout).toBeInstanceOf(UserMcpGatewayError);
    expect(timeout.message).toBe('Сервер не ответил за 2 минуты');
    expect(timeout.status).toBe(504);
  });

  it('непонятный ответ (не JSON) — 502, без утечки тела', async () => {
    const { fn } = gatewayFetch({
      initialize: () => new Response('<html>oops</html>', { headers: { 'content-type': 'text/html' } }),
    });
    const error = await listUserMcpTools({ fetchImpl: fn, headers }).catch((e) => e);
    expect(error.status).toBe(502);
    expect(error.message).not.toContain('html');
  });

  it('огромный ответ: заявленный Content-Length отклоняется сразу, поток обрывается на пределе', async () => {
    const declared = vi.fn(async () =>
      json({ result: {} }, { headers: { 'content-length': String(50 * 1024 * 1024), 'content-type': 'application/json' } }),
    ) as unknown as typeof fetch;
    const big = await listUserMcpTools({ fetchImpl: declared, headers }).catch((e) => e);
    expect([big.message, big.status]).toEqual(['Ответ сервера слишком большой', 502]);

    // без Content-Length (chunked): читаем потоком и бросаем, как только набралось больше 4 МБ
    let produced = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
      pull(controller) {
        produced += 1024 * 1024;
        controller.enqueue(new Uint8Array(1024 * 1024).fill(32));
      },
    });
    const chunked = vi.fn(
      async () => new Response(stream, { headers: { 'content-type': 'application/json' }, status: 200 }),
    ) as unknown as typeof fetch;
    const error = await listUserMcpTools({ fetchImpl: chunked, headers }).catch((e) => e);
    expect([error.message, error.status]).toEqual(['Ответ сервера слишком большой', 502]);
    expect(cancelled).toBe(true);
    // не больше предела и пары кусков сверху, а не «до конца потока»
    expect(produced).toBeLessThanOrEqual(8 * 1024 * 1024);
  });

  it('переадресации шлюза не выполняются (заголовки с номером человека дальше не уходят)', async () => {
    const seen: Array<RequestInit['redirect']> = [];
    const fn = vi.fn(async (_url: string, init: RequestInit) => {
      seen.push(init.redirect);
      return json(rpc(1, {}));
    }) as unknown as typeof fetch;
    await listUserMcpTools({ fetchImpl: fn, headers }).catch(() => undefined);
    expect(seen[0]).toBe('error');
  });
});

describe('sanitizeUserMcpTools и manifest', () => {
  it('чужой список сжимается: плохие имена, повторы, огромные описания и схемы, предел числа', () => {
    const tools = sanitizeUserMcpTools([
      { description: 'ok', inputSchema: { type: 'object' }, name: 'good_tool' },
      { description: 'ok', name: 'good_tool' },
      { name: 'bad name' },
      { name: 'with____sep' },
      { name: 'x'.repeat(65) },
      { name: '' },
      null,
      { description: 'd'.repeat(5000), inputSchema: { blob: 'z'.repeat(20_000) }, name: 'huge' },
      { description: 12, name: 'no_desc' },
    ]);
    expect(tools.map((item) => item.name)).toEqual(['good_tool', 'huge', 'no_desc']);
    expect(tools[1].description).toHaveLength(1000);
    // схема больше 16 КБ заменена пустой: она шла бы в каждый запрос модели
    expect(tools[1].parameters).toEqual({ properties: {}, type: 'object' });
    expect(tools[2].description).toBe('');

    const many = sanitizeUserMcpTools(Array.from({ length: 200 }, (_, i) => ({ name: `t${i}` })));
    expect(many).toHaveLength(60);
    expect(sanitizeUserMcpTools('nope')).toEqual([]);
  });

  it('manifest той же формы, что у MCP движка: type mcp, mcpParams на шлюз, подсказка про недоверие', () => {
    const manifest = buildUserMcpManifest({
      description: '',
      identifier: 'umcp-abcdefghijkl',
      title: 'Мой Notion',
      tools: [{ description: 'd', name: 'search', parameters: { type: 'object' } }],
      url: 'http://127.0.0.1:8410/mcp/user-mcp',
    });
    expect(manifest).toMatchObject({
      api: [{ name: 'search' }],
      identifier: 'umcp-abcdefghijkl',
      mcpParams: { name: 'umcp-abcdefghijkl', type: 'http', url: 'http://127.0.0.1:8410/mcp/user-mcp' },
      meta: { title: 'Мой Notion' },
      type: 'mcp',
    });
    expect(manifest.meta.description).toContain('Мой Notion');
    expect(manifest.systemRole).toContain('untrusted');
    expect(JSON.stringify(manifest)).not.toContain('enc:v1');
  });
});
