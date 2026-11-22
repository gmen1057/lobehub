import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ToolExecutionService } from '../index';

/**
 * arckep (19.10.2026): подключение песочницы E2B получает от сервера заголовок X-Arckep-Topic — номер темы.
 * Так execute_code из MCP и команды навыков (skillSandbox) одной темы попадают в одну песочницу; X-Arckep-User
 * остаётся номером человека в студии (по нему шлюз и бэкенд считают деньги).
 */

const mockFindById = vi.hoisted(() => vi.fn());
const mockResolveArckepUserId = vi.hoisted(() => vi.fn());
const mockFindTopic = vi.hoisted(() => vi.fn());

vi.mock('@/database/models/topic', () => ({
  TopicModel: vi.fn(() => ({ findById: mockFindTopic })),
}));

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
    mockFindTopic.mockResolvedValue({ id: 'tpc_1' });
    service = new ToolExecutionService({ builtinToolsExecutor: {} as any, mcpService: {} as any });
  });

  afterEach(() => {
    process.env = { ...env };
  });

  const params = (identifier: string, ctx = context(), mcp: any = http) =>
    (service as any).withUserConnectionParams(identifier, mcp, ctx) as Promise<any>;

  it('E2B: X-Arckep-Topic = номер темы, X-Arckep-User = номер человека в студии, X-Arckep-Allow-Internet = 0 по умолчанию', async () => {
    const result = await params(E2B);
    expect(result.headers).toEqual({
      'X-Arckep-Allow-Internet': '0',
      'X-Arckep-Topic': 'tpc_1',
      'X-Arckep-User': '15',
      'X-Static': '1',
    });
    expect(result.url).toBe(http.url);
  });

  it('E2B: sandboxAllowInternet=true выставляет X-Arckep-Allow-Internet: 1', async () => {
    const result = await params(E2B, context({ sandboxAllowInternet: true }));
    expect(result.headers).toEqual({
      'X-Arckep-Allow-Internet': '1',
      'X-Arckep-Topic': 'tpc_1',
      'X-Arckep-User': '15',
      'X-Static': '1',
    });
  });

  it('нет номера темы — вызов отклоняется, а не уходит на session_id модели', async () => {
    await expect(params(E2B, context({ topicId: undefined }))).rejects.toThrow('в своём чате');
  });

  it('другие подключения номер темы и X-Arckep-Allow-Internet не получают', async () => {
    for (const id of ['mcp-arckep-wordstat', 'mcp-arckep-postgres', 'mcp-custom-thing']) {
      const result = await params(id, context({ sandboxAllowInternet: true }));
      expect(result.headers, id).not.toHaveProperty('X-Arckep-Topic');
      expect(result.headers, id).not.toHaveProperty('X-Arckep-Allow-Internet');
    }
  });

  it('заголовки темы и интернета из настроек человека и манифеста отбрасываются в любом регистре; у E2B остаётся серверный', async () => {
    mockFindById.mockResolvedValue({
      settings: {
        'X-ARCKEP-ALLOW-INTERNET': '1',
        'X-Arckep-Topic': 'tpc_victim',
        'x-arckep-allow-internet': '1',
        'x-mcp-topic-id': 'tpc_victim',
        'X-MCP-Host': 'db.local',
      },
    });
    const evilManifest = {
      ...http,
      headers: {
        'X-Arckep-Allow-Internet': '1',
        'X-Static': '1',
        'x-arckep-allow-internet': '1',
        'x-arckep-topic': 'tpc_victim2',
      },
    };

    const e2b = await params(E2B, context(), evilManifest);
    expect(e2b.headers).toEqual({
      'X-Arckep-Allow-Internet': '0',
      'X-Arckep-Topic': 'tpc_1',
      'X-Arckep-User': '15',
      'X-MCP-Host': 'db.local',
      'X-Static': '1',
    });

    const e2bAllowed = await params(E2B, context({ sandboxAllowInternet: true }), {
      ...http,
      headers: { 'X-Static': '1', 'x-arckep-allow-internet': '0' },
    });
    expect(e2bAllowed.headers['X-Arckep-Allow-Internet']).toBe('1');
    expect(
      Object.keys(e2bAllowed.headers).filter((k) => k.toLowerCase() === 'x-arckep-allow-internet'),
    ).toEqual(['X-Arckep-Allow-Internet']);

    const other = await params(
      'mcp-arckep-postgres',
      context({ sandboxAllowInternet: true }),
      evilManifest,
    );
    expect(JSON.stringify(other.headers).toLowerCase()).not.toContain('topic');
    expect(JSON.stringify(other.headers).toLowerCase()).not.toContain('allow-internet');
    expect(other.headers['X-MCP-Host']).toBe('db.local');
  });

  it('аккаунт не из студии: номера человека нет — вызов отклоняется', async () => {
    mockResolveArckepUserId.mockRejectedValue(new Error('not studio'));
    await expect(params(E2B)).rejects.toThrow('аккаунта студии Arckep');
  });

  it('чужая тема (номер пришёл от клиента) — вызов отклоняется, проверка по базе в рамках человека', async () => {
    mockFindTopic.mockResolvedValue(undefined);
    await expect(params(E2B, context({ topicId: 'tpc_victim' }))).rejects.toThrow('в своём чате');
    expect(mockFindTopic).toHaveBeenCalledWith('tpc_victim');
  });

  it('сбой базы при проверке темы = тема не его, вызов отклоняется', async () => {
    mockFindTopic.mockRejectedValue(new Error('db down'));
    await expect(params(E2B)).rejects.toThrow('в своём чате');
  });

  it('отказ касается только песочницы: другие подключения работают без темы и для не-студийных аккаунтов', async () => {
    mockResolveArckepUserId.mockRejectedValue(new Error('not studio'));
    const result = await params('mcp-arckep-wordstat', context({ topicId: undefined }));
    expect(result.headers).not.toHaveProperty('X-Arckep-Topic');
    expect(result.url).toBe(http.url);
  });

  it('stdio-подключение не меняется', async () => {
    const stdio = { command: 'x', type: 'stdio' };
    expect(await params(E2B, context(), stdio)).toBe(stdio);
  });
});
