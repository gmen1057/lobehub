import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  arckepConnectorsRuntime,
  fetchCatalogSuggestions,
  matchInstalledConnections,
} from '../arckepConnectors';

/**
 * arckep (19.10.2026, этап 3, п. 3.Г): серверный поиск подключений для модели — каталог бэкенда студии
 * (`GET /api/internal/chat-mcp-catalog`, служебный ключ) плюс установленные подключения человека.
 */

const mockQuery = vi.hoisted(() => vi.fn());
vi.mock('@/database/models/plugin', () => ({
  PluginModel: vi.fn(() => ({ query: mockQuery })),
}));

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' }, status });

const backendItem = (patch: Record<string, unknown> = {}) => ({
  description: 'Страницы и базы Notion',
  id: 'notion',
  needsSetup: true,
  paid: false,
  source: 'catalog',
  title: 'Notion',
  ...patch,
});

const installedRow = (identifier: string, title: string, description = '', tools: string[] = []) => ({
  identifier,
  manifest: { api: tools.map((name) => ({ name })), meta: { description, title } },
  type: 'customPlugin',
});

describe('fetchCatalogSuggestions', () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env = { ...env };
    delete process.env.IMAGE_STUDIO_API_URL;
    process.env.ARCKEP_INTERNAL_TOKEN = 'internal-secret';
  });

  it('GET /api/internal/chat-mcp-catalog?q=&limit=5 с x-arckep-token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ items: [backendItem()] }));
    const items = await fetchCatalogSuggestions('ноушн & co', fetchImpl as any);

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(
      'http://127.0.0.1:8202/api/internal/chat-mcp-catalog?limit=5&q=%D0%BD%D0%BE%D1%83%D1%88%D0%BD+%26+co',
    );
    expect(init.headers['x-arckep-token']).toBe('internal-secret');
    expect(items).toEqual([backendItem()]);
  });

  it('IMAGE_STUDIO_API_URL из окружения; без служебного токена заголовка нет', async () => {
    process.env.IMAGE_STUDIO_API_URL = 'http://127.0.0.1:9000/';
    delete process.env.ARCKEP_INTERNAL_TOKEN;
    delete process.env.LOBECHAT_BACKEND_KEY;
    const fetchImpl = vi.fn().mockResolvedValue(json({ items: [] }));
    await fetchCatalogSuggestions('x', fetchImpl as any);
    expect(fetchImpl.mock.calls[0][0]).toMatch(/^http:\/\/127\.0\.0\.1:9000\/api\/internal\//);
    expect(fetchImpl.mock.calls[0][1].headers).toEqual({});
  });

  it('ответ чужого формата чистится: плохие строки отбрасываются, текст — в одну строку', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      json({
        items: [
          backendItem({ description: 'a\n\nb ' + 'x'.repeat(1000), title: 'T\nU' }),
          backendItem({ id: '' }),
          backendItem({ source: 'other' }),
          backendItem({ title: 5 }),
          null,
          'str',
        ],
      }),
    );
    const items = await fetchCatalogSuggestions('x', fetchImpl as any);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('T U');
    expect(items[0].description.length).toBeLessThanOrEqual(300);
    expect(items[0].description).not.toContain('\n');
    expect(await fetchCatalogSuggestions('x', vi.fn().mockResolvedValue(json({ items: 'nope' })) as any)).toEqual([]);
  });

  it('HTTP-ошибка бэкенда — исключение', async () => {
    await expect(
      fetchCatalogSuggestions('x', vi.fn().mockResolvedValue(json({}, 503)) as any),
    ).rejects.toThrow('HTTP 503');
  });
});

describe('matchInstalledConnections', () => {
  it('находит установленные подключения по названию, описанию, ключу и именам инструментов; чужие записи не трогает', async () => {
    mockQuery.mockResolvedValue([
      installedRow('umcp-abcdefghijkl', 'Мой Notion', 'страницы заметок', ['search_pages']),
      installedRow('mcp-arckep-figma', 'Figma', 'макеты'),
      installedRow('mcp-arckep-postgres', 'PostgreSQL', 'базы данных', ['query']),
      installedRow('lobe-user-memory', 'Память'),
    ]);

    const byTitle = await matchInstalledConnections({} as any, 'u1', 'notion');
    expect(byTitle.map((i) => i.id)).toEqual(['umcp-abcdefghijkl']);
    expect(byTitle[0]).toMatchObject({ installed: true, needsSetup: false, paid: false, source: 'connection' });

    expect((await matchInstalledConnections({} as any, 'u1', 'макеты фигма')).map((i) => i.id)).toEqual([
      'mcp-arckep-figma',
    ]);
    expect((await matchInstalledConnections({} as any, 'u1', 'query')).map((i) => i.id)).toEqual([
      'mcp-arckep-postgres',
    ]);
    // записи без префикса подключений не предлагаются, пустой запрос ничего не находит
    expect(await matchInstalledConnections({} as any, 'u1', 'память')).toEqual([]);
    expect(await matchInstalledConnections({} as any, 'u1', ' ! ')).toEqual([]);
  });
});

describe('рантайм arckep-connectors', () => {
  const env = { ...process.env };
  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...env };
    process.env.ARCKEP_INTERNAL_TOKEN = 'internal-secret';
  });

  const run = async (query: string, fetchResult: () => Promise<Response>) => {
    vi.stubGlobal('fetch', vi.fn(fetchResult));
    const runtime = arckepConnectorsRuntime.factory({ serverDB: {} as any, toolManifestMap: {}, userId: 'u1' } as any) as any;
    return runtime.searchConnectors({ query });
  };

  it('каталог + установленное: один id из двух источников сливается, всего не больше 5', async () => {
    mockQuery.mockResolvedValue([installedRow('mcp-arckep-figma', 'Figma', 'макеты')]);
    const result = await run('figma', async () =>
      json({
        items: [
          backendItem({ id: 'mcp-arckep-figma', source: 'connection', title: 'Figma' }),
          ...Array.from({ length: 6 }, (_, i) => backendItem({ id: `s${i}`, title: `S${i}` })),
        ],
      }),
    );
    expect(result.success).toBe(true);
    const lines = result.content.split('\n').filter((l: string) => l.startsWith('ARCKEP_CONNECT '));
    expect(lines).toHaveLength(5);
    expect(lines.filter((l: string) => l.includes('mcp-arckep-figma'))).toHaveLength(1);
    expect(result.content).toContain('already installed');
  });

  it('каталог недоступен, но своё подключение подошло — отвечаем им', async () => {
    mockQuery.mockResolvedValue([installedRow('umcp-abcdefghijkl', 'Мой Notion')]);
    const result = await run('notion', async () => json({}, 502));
    expect(result.success).toBe(true);
    expect(result.content).toContain('umcp-abcdefghijkl');
  });

  it('каталог недоступен и своего нет — ошибка, а не «такого подключения не бывает»', async () => {
    mockQuery.mockResolvedValue([]);
    const result = await run('notion', async () => json({}, 502));
    expect(result.success).toBe(false);
    expect(result.content).toContain('HTTP 502');
  });

  it('без базы или человека в контексте рантайм не создаётся', () => {
    expect(() => arckepConnectorsRuntime.factory({ toolManifestMap: {}, userId: 'u1' } as any)).toThrow('serverDB');
    expect(() => arckepConnectorsRuntime.factory({ serverDB: {}, toolManifestMap: {} } as any)).toThrow('userId');
  });
});
