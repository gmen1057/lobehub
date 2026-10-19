import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ToolExecutionService } from '../index';

/**
 * arckep (19.10.2026): подключение песочницы E2B получает от сервера заголовок X-Arckep-Topic — номер темы.
 * Так execute_code из MCP и команды навыков (skillSandbox) одной темы попадают в одну песочницу; X-Arckep-User
 * остаётся номером человека в студии (по нему шлюз и бэкенд считают деньги).
 */

const mockFindById = vi.hoisted(() => vi.fn());
const mockResolveArckepUserId = vi.hoisted(() => vi.fn());

vi.mock('@/database/models/plugin', () => ({
  PluginModel: vi.fn(() => ({ findById: mockFindById })),
}));

vi.mock('../serverRuntimes/arckepStudio', () => ({
  resolveArckepUserId: mockResolveArckepUserId,
}));

const E2B = 'mcp-arckep-e2b-sandbox';
const context = (extra: Record<string, unknown> = {}) =>
  ({
    serverDB: {} as any,
    toolManifestMap: {},
    topicId: 'tpc_1',
    userId: 'user-1',
    ...extra,
  }) as any;
const http = {
  headers: { 'X-Static': '1' },
  type: 'http',
  url: 'http://127.0.0.1:8410/mcp/e2b-sandbox',
};

describe('withUserConnectionParams — песочница E2B и номер темы', () => {
  let service: ToolExecutionService;
  const env = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveArckepUserId.mockResolvedValue(15);
    mockFindById.mockResolvedValue({ settings: {} });
    service = new ToolExecutionService({ builtinToolsExecutor: {} as any, mcpService: {} as any });
  });

  afterEach(() => {
    process.env = { ...env };
  });

  const params = (identifier: string, ctx = context(), mcp: any = http) =>
    (service as any).withUserConnectionParams(identifier, mcp, ctx) as Promise<any>;

  it('E2B: X-Arckep-Topic = номер темы, X-Arckep-User = номер человека в студии', async () => {
    const result = await params(E2B);
    expect(result.headers).toEqual({
      'X-Arckep-Topic': 'tpc_1',
      'X-Arckep-User': '15',
      'X-Static': '1',
    });
    expect(result.url).toBe(http.url);
  });

  it('нет номера темы — заголовка нет', async () => {
    const result = await params(E2B, context({ topicId: undefined }));
    expect(result.headers).not.toHaveProperty('X-Arckep-Topic');
    expect(result.headers['X-Arckep-User']).toBe('15');
  });

  it('другие подключения номер темы не получают', async () => {
    for (const id of ['mcp-arckep-wordstat', 'mcp-arckep-postgres', 'mcp-custom-thing']) {
      const result = await params(id);
      expect(result.headers, id).not.toHaveProperty('X-Arckep-Topic');
    }
  });

  it('заголовки темы из настроек человека и манифеста отбрасываются; у E2B остаётся серверный', async () => {
    mockFindById.mockResolvedValue({
      settings: {
        'X-Arckep-Topic': 'tpc_victim',
        'x-mcp-topic-id': 'tpc_victim',
        'X-MCP-Host': 'db.local',
      },
    });
    const evilManifest = { ...http, headers: { 'X-Static': '1', 'x-arckep-topic': 'tpc_victim2' } };

    const e2b = await params(E2B, context(), evilManifest);
    expect(e2b.headers).toEqual({
      'X-Arckep-Topic': 'tpc_1',
      'X-Arckep-User': '15',
      'X-MCP-Host': 'db.local',
      'X-Static': '1',
    });

    const other = await params('mcp-arckep-postgres', context(), evilManifest);
    expect(JSON.stringify(other.headers).toLowerCase()).not.toContain('topic');
    expect(other.headers['X-MCP-Host']).toBe('db.local');
  });

  it('аккаунт не из студии: номера человека нет, тема всё равно передаётся (шлюз без человека не считает деньги)', async () => {
    mockResolveArckepUserId.mockRejectedValue(new Error('not studio'));
    const result = await params(E2B);
    expect(result.headers['X-Arckep-Topic']).toBe('tpc_1');
    expect(result.headers).not.toHaveProperty('X-Arckep-User');
  });

  it('stdio-подключение не меняется', async () => {
    const stdio = { command: 'x', type: 'stdio' };
    expect(await params(E2B, context(), stdio)).toBe(stdio);
  });
});
