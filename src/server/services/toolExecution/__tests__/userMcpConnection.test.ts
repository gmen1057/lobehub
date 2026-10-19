import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ToolExecutionService } from '../index';

/**
 * arckep (19.10.2026, этап 3, п. 3.Б и 3.Е): вызов своего подключения `umcp-*` — адрес только из окружения,
 * заголовки п. 3.Б, `sealed` из строки этого человека, настройки не читаются, тема помечается до вызова;
 * защита MCP-клиента — stdio выключен, адреса `mcp-arckep-*` из белого списка, прочие сетевые подключения
 * в безголовом режиме отклоняются, `X-Arckep-User` только на шлюз и MCP студии.
 */

const mockFindById = vi.hoisted(() => vi.fn());
const mockResolveArckepUserId = vi.hoisted(() => vi.fn());
const mockFindTopic = vi.hoisted(() => vi.fn());
const mockMark = vi.hoisted(() => vi.fn());

vi.mock('@/database/models/topic', () => ({
  TopicModel: vi.fn(() => ({ findById: mockFindTopic })),
}));
vi.mock('@/database/models/plugin', () => ({
  PluginModel: vi.fn(() => ({ findById: mockFindById })),
}));
vi.mock('../serverRuntimes/arckepStudio', () => ({
  resolveArckepUserId: mockResolveArckepUserId,
}));
vi.mock('../topicTrust', () => ({
  gatePaidToolCall: vi.fn(async () => ({ action: 'proceed' })),
  markTopicUntrusted: mockMark,
}));

const UMCP = 'umcp-abcdefghijkl';
const SEALED = 'enc:v1:AAAA_bbbb-CCCC';
const GATEWAY = 'http://127.0.0.1:8410/mcp/user-mcp';

const context = (extra: Record<string, unknown> = {}) =>
  ({ serverDB: {} as any, toolManifestMap: {}, topicId: 'tpc_1', userId: 'user-1', ...extra }) as any;

describe('вызов своего подключения umcp-*', () => {
  let service: ToolExecutionService;
  const env = { ...process.env };

  const params = (identifier = UMCP, ctx = context(), mcp: any = { type: 'http', url: 'https://evil.example/mcp' }) =>
    (service as any).withUserConnectionParams(identifier, mcp, ctx) as Promise<any>;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.USER_MCP_GATEWAY_URL;
    mockResolveArckepUserId.mockResolvedValue(15);
    mockFindTopic.mockResolvedValue({ id: 'tpc_1' });
    mockMark.mockResolvedValue(true);
    mockFindById.mockResolvedValue({
      customParams: {
        arckepUserMcp: { display: { host: 'notion.example' }, kind: 'remote', sealed: SEALED },
        mcp: { type: 'http', url: 'https://evil.example/from-db' },
      },
      settings: { 'X-MCP-Host': 'db.local', 'X-Arckep-User': '999', 'X-MCP-Password': 'pw' },
    });
    service = new ToolExecutionService({ builtinToolsExecutor: {} as any, mcpService: {} as any });
  });

  afterEach(() => {
    process.env = { ...env };
  });

  it('адрес — USER_MCP_GATEWAY_URL из окружения, а не из манифеста и не из строки базы; заголовки п. 3.Б', async () => {
    const result = await params();
    expect(result).toEqual({
      headers: {
        'X-Arckep-Topic': 'tpc_1',
        'X-Arckep-User': '15',
        'X-Arckep-User-Mcp-Config': SEALED,
        'X-Arckep-User-Mcp-Id': UMCP,
      },
      type: 'http',
      url: GATEWAY,
    });

    process.env.USER_MCP_GATEWAY_URL = 'http://127.0.0.1:9000/mcp/user-mcp';
    expect((await params()).url).toBe('http://127.0.0.1:9000/mcp/user-mcp');
  });

  it('заголовки, авторизация и settings из манифеста и настроек человека не попадают в запрос', async () => {
    const result = await params(UMCP, context(), {
      auth: { token: 'stolen', type: 'bearer' },
      headers: { 'Authorization': 'Bearer x', 'X-Arckep-User': '1', 'X-Arckep-User-Mcp-Config': 'enc:v1:EVIL' },
      type: 'http',
      url: 'https://evil.example/mcp',
    });
    expect(result.auth).toBeUndefined();
    expect(Object.keys(result.headers).sort()).toEqual([
      'X-Arckep-Topic',
      'X-Arckep-User',
      'X-Arckep-User-Mcp-Config',
      'X-Arckep-User-Mcp-Id',
    ]);
    expect(result.headers['X-Arckep-User']).toBe('15');
    expect(result.headers['X-Arckep-User-Mcp-Config']).toBe(SEALED);
    expect(JSON.stringify(result)).not.toContain('db.local');
    expect(JSON.stringify(result)).not.toContain('pw');
  });

  it('sealed берётся из строки этого человека (PluginModel с его userId)', async () => {
    const { PluginModel } = await import('@/database/models/plugin');
    await params();
    expect(PluginModel).toHaveBeenCalledWith(expect.anything(), 'user-1');
    expect(mockFindById).toHaveBeenCalledWith(UMCP);
  });

  it('тема помечается до вызова: метка «чужой инструмент» с номером подключения', async () => {
    await params();
    expect(mockMark).toHaveBeenCalledWith(expect.anything(), 'user-1', 'tpc_1', UMCP);
  });

  it('нет номера человека в студии — ошибка модели текстом, строка базы не читается', async () => {
    mockResolveArckepUserId.mockRejectedValue(new Error('not studio'));
    await expect(params()).rejects.toThrow('аккаунтам студии Arckep');
    expect(mockFindById).not.toHaveBeenCalled();
    expect(mockMark).not.toHaveBeenCalled();
  });

  it('нет своей темы, чужая тема или сбой проверки — вызов отклоняется, метка не ставится', async () => {
    await expect(params(UMCP, context({ topicId: undefined }))).rejects.toThrow('в своём чате');
    mockFindTopic.mockResolvedValue(undefined);
    await expect(params(UMCP, context({ topicId: 'tpc_victim' }))).rejects.toThrow('в своём чате');
    mockFindTopic.mockRejectedValue(new Error('db down'));
    await expect(params()).rejects.toThrow('в своём чате');
    expect(mockMark).not.toHaveBeenCalled();
  });

  it('нет строки, нет sealed или он не enc:v1 — отказ «добавьте заново», на шлюз ничего не уходит', async () => {
    for (const row of [
      undefined,
      { customParams: {} },
      { customParams: { arckepUserMcp: { sealed: 'plain-text-token' } } },
      { customParams: { arckepUserMcp: { sealed: `enc:v1:${'A'.repeat(8000)}` } } },
    ]) {
      mockFindById.mockResolvedValue(row);
      await expect(params()).rejects.toThrow('добавьте его заново');
    }
    mockFindById.mockRejectedValue(new Error('db down'));
    await expect(params()).rejects.toThrow('добавьте его заново');
    expect(mockMark).not.toHaveBeenCalled();
  });

  it('метка не поставилась (сбой или тема не найдена) — вызов отклоняется', async () => {
    mockMark.mockResolvedValue(false);
    await expect(params()).rejects.toThrow('Не удалось отметить чат');
    mockMark.mockRejectedValue(new Error('db down'));
    await expect(params()).rejects.toThrow('Не удалось отметить чат');
  });

  it('нет сервера или человека в контексте — вызов не уходит по манифесту', async () => {
    await expect(params(UMCP, context({ serverDB: undefined }))).rejects.toThrow('аккаунте студии');
    await expect(params(UMCP, context({ userId: undefined }))).rejects.toThrow('аккаунте студии');
  });

  it('sealed и открытые настройки не попадают в сообщения ошибок', async () => {
    mockMark.mockRejectedValue(new Error(`boom ${SEALED}`));
    const error = await params().catch((e) => e);
    expect(error.message).not.toContain(SEALED);
  });
});

describe('executeTool: свои подключения и защита MCP-клиента', () => {
  let service: ToolExecutionService;
  let callTool: ReturnType<typeof vi.fn>;
  const env = { ...process.env };

  const manifest = (identifier: string, mcpParams: any) => ({
    api: [{ description: '', name: 'ping', parameters: { type: 'object' } }],
    identifier,
    mcpParams,
    meta: { title: identifier },
    type: 'mcp',
  });

  const run = (identifier: string, mcpParams: any, ctx = context()) =>
    service.executeTool(
      { apiName: 'ping', arguments: '{}', id: 'call_1', identifier, type: 'mcp' } as any,
      { ...ctx, toolManifestMap: { [identifier]: manifest(identifier, mcpParams) } },
    );

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.ARCKEP_HEADLESS_TOOLS;
    delete process.env.ARCKEP_MCP_GATEWAY_URL_PREFIX;
    delete process.env.ARCKEP_STUDIO_MCP_URL;
    process.env.ARCKEP_INTERNAL_TOKEN = 'internal-secret';
    mockResolveArckepUserId.mockResolvedValue(15);
    mockFindTopic.mockResolvedValue({ id: 'tpc_1' });
    mockMark.mockResolvedValue(true);
    mockFindById.mockResolvedValue({ customParams: { arckepUserMcp: { sealed: SEALED } }, settings: {} });
    callTool = vi.fn().mockResolvedValue({ content: 'pong', state: { content: [] }, success: true });
    service = new ToolExecutionService({
      builtinToolsExecutor: {} as any,
      mcpService: { callTool } as any,
    });
  });

  afterEach(() => {
    process.env = { ...env };
  });

  it('umcp-*: callTool получает адрес шлюза и заголовки п. 3.Б, ответ идёт модели', async () => {
    const result = await run(UMCP, { type: 'http', url: 'https://evil.example/mcp' });
    expect(result.success).toBe(true);
    expect(result.content).toBe('pong');
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(callTool.mock.calls[0][0].clientParams).toMatchObject({
      headers: { 'X-Arckep-User': '15', 'X-Arckep-User-Mcp-Id': UMCP },
      type: 'http',
      url: GATEWAY,
    });
    expect(callTool.mock.calls[0][0].toolName).toBe('ping');
  });

  it('umcp-* с манифестом stdio или cloud отклоняется до любого запуска', async () => {
    for (const mcpParams of [
      { args: [], command: 'rm', type: 'stdio' },
      { type: 'cloud' },
      undefined,
    ]) {
      const result = await run(UMCP, mcpParams);
      expect(result.success, JSON.stringify(mcpParams)).toBe(false);
    }
    expect(callTool).not.toHaveBeenCalled();
    expect(mockMark).not.toHaveBeenCalled();
  });

  it('stdio на сервере выключен для любых подключений, включая mcp-arckep-*', async () => {
    for (const id of ['mcp-arckep-wordstat', 'mcp-custom-thing', 'mcp-arckep-studio-images']) {
      const result = await run(id, { args: [], command: 'node', type: 'stdio' });
      expect(result.success, id).toBe(false);
      expect(result.content).toContain('stdio');
    }
    expect(callTool).not.toHaveBeenCalled();
  });

  it('mcp-arckep-*: адрес только из белого списка — шлюз и MCP студии', async () => {
    for (const url of [
      'http://127.0.0.1:8410/mcp/figma',
      'http://127.0.0.1:8410/mcp/e2b-sandbox',
      'http://127.0.0.1:8410/mcp/wordstat',
    ]) {
      const ok = await run('mcp-arckep-wordstat', { headers: {}, type: 'http', url });
      expect(ok.success, url).toBe(true);
    }
    // MCP студии у `mcp-arckep-*` вне префикса studio — тоже можно
    expect((await run('mcp-arckep-x', { type: 'http', url: 'http://127.0.0.1:8422/mcp' })).success).toBe(true);
    expect(callTool).toHaveBeenCalledTimes(4);
  });

  it('mcp-arckep-*: чужой, внутренний и «похожий» адрес отклоняется; шесть подключений на https://arckep.ru/mcp/mcp/ — тоже', async () => {
    callTool.mockClear();
    for (const url of [
      'https://evil.example/mcp',
      'https://arckep.ru/mcp/mcp/postgres',
      'http://127.0.0.1:8410/admin',
      'http://127.0.0.1:8410/mcp/../admin',
      'http://127.0.0.1:8410/mcp/%2e%2e/admin',
      'http://127.0.0.1:8410@evil.example/mcp/figma',
      'http://user:pw@127.0.0.1:8410/mcp/figma',
      'http://127.0.0.1:8411/mcp/figma',
      'http://localhost:8410/mcp/figma',
      'https://127.0.0.1:8410/mcp/figma',
      'http://127.0.0.1:8422/other',
      'not a url',
      undefined,
    ]) {
      const result = await run('mcp-arckep-postgres', { headers: {}, type: 'http', url });
      expect(result.success, String(url)).toBe(false);
      expect(result.error?.code).toBe('MCP_CONNECTION_NOT_ALLOWED');
    }
    expect(callTool).not.toHaveBeenCalled();
  });

  it('ARCKEP_STUDIO_MCP_URL и префикс шлюза берутся из окружения', async () => {
    process.env.ARCKEP_STUDIO_MCP_URL = 'http://127.0.0.1:9422/mcp';
    process.env.ARCKEP_MCP_GATEWAY_URL_PREFIX = 'http://127.0.0.1:9410/mcp/';
    expect((await run('mcp-arckep-x', { type: 'http', url: 'http://127.0.0.1:9422/mcp' })).success).toBe(true);
    expect((await run('mcp-arckep-x', { type: 'http', url: 'http://127.0.0.1:9410/mcp/figma' })).success).toBe(true);
    expect((await run('mcp-arckep-x', { type: 'http', url: 'http://127.0.0.1:8410/mcp/figma' })).success).toBe(false);
    // служебный токен студии уходит на адрес из окружения, не из манифеста
    callTool.mockClear();
    await run('mcp-arckep-studio-images', { type: 'http', url: 'https://evil.example/mcp' });
    expect(callTool.mock.calls[0][0].clientParams.url).toBe('http://127.0.0.1:9422/mcp');
  });

  it('безголовый режим: прочие сетевые подключения (не mcp-arckep-*, не umcp-*) отклоняются, остальные работают', async () => {
    process.env.ARCKEP_HEADLESS_TOOLS = '1';
    for (const [id, mcpParams] of [
      ['mcp-custom-thing', { type: 'http', url: 'https://example.com/mcp' }],
      ['mcp-custom-thing', { type: 'http', url: 'http://127.0.0.1:8410/mcp/figma' }],
      ['some-plugin', { type: 'sse', url: 'https://example.com/sse' }],
      ['some-plugin', { type: 'cloud' }],
    ] as const) {
      const result = await run(id, mcpParams);
      expect(result.success, id).toBe(false);
      expect(result.content).toContain('каталога');
    }
    expect(callTool).not.toHaveBeenCalled();

    expect((await run('mcp-arckep-figma', { type: 'http', url: 'http://127.0.0.1:8410/mcp/figma' })).success).toBe(true);
    expect((await run('mcp-arckep-studio-video', { type: 'http', url: 'http://127.0.0.1:8422/mcp' })).success).toBe(true);
    expect((await run(UMCP, { type: 'http', url: GATEWAY })).success).toBe(true);
  });

  it('вне безголового режима сторонние подключения работают, как раньше, но без X-Arckep-User', async () => {
    mockFindById.mockResolvedValue({ settings: { 'X-MCP-Host': 'db.local', 'x-arckep-user': '999' } });
    const result = await run('mcp-custom-thing', {
      headers: { 'X-Arckep-User': '1', 'x-mcp-user-id': '2', 'X-Static': '1' },
      type: 'http',
      url: 'https://example.com/mcp',
    });
    expect(result.success).toBe(true);
    const headers = callTool.mock.calls[0][0].clientParams.headers;
    expect(headers).toEqual({ 'X-MCP-Host': 'db.local', 'X-Static': '1' });
  });

  it('X-Arckep-User уходит на шлюз и MCP студии и только с серверным номером (в манифесте любой регистр отброшен)', async () => {
    await run('mcp-arckep-wordstat', {
      headers: { 'x-arckep-user': '1', 'X-MCP-User-Id': '2' },
      type: 'http',
      url: 'http://127.0.0.1:8410/mcp/wordstat',
    });
    expect(callTool.mock.calls[0][0].clientParams.headers).toEqual({ 'X-Arckep-User': '15' });

    callTool.mockClear();
    mockResolveArckepUserId.mockRejectedValue(new Error('not studio'));
    await run('mcp-arckep-wordstat', {
      headers: { 'x-arckep-user': '1' },
      type: 'http',
      url: 'http://127.0.0.1:8410/mcp/wordstat',
    });
    // аккаунт не из студии: подделанный номер из манифеста тоже не уходит
    expect(callTool.mock.calls[0][0].clientParams.headers).toEqual({});
  });
});
