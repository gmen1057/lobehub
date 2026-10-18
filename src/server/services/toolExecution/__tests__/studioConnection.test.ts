import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * arckep (план chat-next-redesign, F6): подключения студии mcp-arckep-studio-* ходят в MCP Arckep доверенным
 * путём — служебный токен студии и номер человека, без ключа у человека и без его настроек.
 */

const mockFindById = vi.hoisted(() => vi.fn());
const mockResolveArckepUserId = vi.hoisted(() => vi.fn());

vi.mock('@/database/models/plugin', () => ({
  PluginModel: vi.fn(() => ({ findById: mockFindById })),
}));

vi.mock('../serverRuntimes/arckepStudio', () => ({
  resolveArckepUserId: mockResolveArckepUserId,
}));

import { ToolExecutionService } from '../index';

const context = { serverDB: {} as any, toolManifestMap: {}, userId: 'user-1' } as any;
const http = { headers: { 'X-Static': '1' }, type: 'http', url: 'http://127.0.0.1:8422/mcp' };

describe('withUserConnectionParams — подключения студии (F6)', () => {
  let service: ToolExecutionService;
  const env = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.ARCKEP_INTERNAL_TOKEN;
    delete process.env.LOBECHAT_BACKEND_KEY;
    mockResolveArckepUserId.mockResolvedValue(15);
    mockFindById.mockResolvedValue({ settings: { 'X-MCP-Host': 'db.local', 'X-Arckep-User': '999' } });
    service = new ToolExecutionService({ builtinToolsExecutor: {} as any, mcpService: {} as any });
  });

  afterEach(() => {
    process.env = { ...env };
  });

  const params = (identifier: string) =>
    (service as any).withUserConnectionParams(identifier, http, context) as Promise<any>;

  it('служебный токен + номер человека; адрес и заголовки — только серверные, настройки человека не читаются', async () => {
    process.env.ARCKEP_INTERNAL_TOKEN = 'internal-secret';
    const evil = { headers: { 'Authorization': 'Bearer stolen', 'X-Arckep-User': '1' }, type: 'http', url: 'https://evil.example/mcp' };
    const result = await (service as any).withUserConnectionParams('mcp-arckep-studio-images', evil, context);
    expect(result).toEqual({
      headers: { 'Authorization': 'Bearer internal-secret', 'X-Arckep-User': '15' },
      type: 'http',
      url: 'http://127.0.0.1:8422/mcp',
    });
    expect(mockFindById).not.toHaveBeenCalled();
  });

  it('без ARCKEP_INTERNAL_TOKEN берётся LOBECHAT_BACKEND_KEY (тот же INTERNAL_API_KEY студии)', async () => {
    process.env.LOBECHAT_BACKEND_KEY = 'backend-key';
    const result = await params('mcp-arckep-studio-video');
    expect(result.headers.Authorization).toBe('Bearer backend-key');
  });

  it('нет токена или аккаунт не из студии — ошибка текстом, а не анонимный запрос в API', async () => {
    await expect(params('mcp-arckep-studio-3d')).rejects.toThrow('нет служебного токена');
    process.env.ARCKEP_INTERNAL_TOKEN = 'internal-secret';
    mockResolveArckepUserId.mockResolvedValue(null);
    await expect(params('mcp-arckep-studio-3d')).rejects.toThrow('только аккаунтам студии');
  });

  it('обычные подключения как раньше: настройки человека в заголовки, без Authorization', async () => {
    process.env.ARCKEP_INTERNAL_TOKEN = 'internal-secret';
    const result = await params('mcp-arckep-postgres');
    expect(result.headers).toEqual({ 'X-Arckep-User': '15', 'X-MCP-Host': 'db.local', 'X-Static': '1' });
    expect(result.headers.Authorization).toBeUndefined();
  });
});
