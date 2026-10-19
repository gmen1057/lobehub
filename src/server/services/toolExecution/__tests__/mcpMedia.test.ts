import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MCPService } from '../../mcp';
import { ToolExecutionService } from '../index';

/**
 * arckep (19.10.2026): серверный путь MCP (движок чата, без браузера). Картинки из ответа инструмента
 * (Figma `get_screenshot` → `{type: 'image', data: <base64>, mimeType}`) уходят в хранилище, модели
 * достаётся текст ответа без JSON-обёртки `{content, state, success}`, структура — в state (pluginState).
 */

const mocks = vi.hoisted(() => ({
  callCloudMcpEndpoint: vi.fn(),
  fileServiceCtor: vi.fn(),
  resolveArckepUserId: vi.fn(),
  uploadBase64: vi.fn(),
}));

vi.mock('@/database/models/plugin', () => ({ PluginModel: vi.fn(() => ({ findById: vi.fn() })) }));
vi.mock('../serverRuntimes/arckepStudio', () => ({
  resolveArckepUserId: mocks.resolveArckepUserId,
}));
vi.mock('@/server/services/discover', () => ({
  DiscoverService: class {
    callCloudMcpEndpoint = mocks.callCloudMcpEndpoint;
  },
}));
vi.mock('@/server/services/file', () => ({
  FileService: class {
    constructor(...args: unknown[]) {
      mocks.fileServiceCtor(...args);
    }

    uploadBase64 = mocks.uploadBase64;
  },
}));

// Реальный размер кадра Figma — сотни КБ; здесь достаточно длинной строки, по которой видно, где она оказалась.
const BASE64 = 'iVBORw0KGgo'.repeat(2000);
const PROXY_URL = 'https://arckep.ru/chat/f/file-uuid-1';

const serverDB = {} as any;
const context = {
  serverDB,
  toolManifestMap: {
    'mcp-figma': {
      identifier: 'mcp-figma',
      mcpParams: { type: 'http', url: 'https://figma.example/mcp' },
    },
    'mcp-cloud': { identifier: 'mcp-cloud', mcpParams: { type: 'cloud' } },
  },
  userId: 'user-1',
} as any;

const payload = (identifier = 'mcp-figma', apiName = 'get_screenshot') =>
  ({ apiName, arguments: '{}', id: 'call-1', identifier, type: 'mcp' }) as any;

/** callTool как в настоящем MCPService: тот же processToolCallResult, что вызывает processContentBlocks. */
const serviceReturning = (raw: { content: any[]; isError?: boolean }) => {
  const callTool = vi.fn(async (options: any) =>
    MCPService.processToolCallResult(raw, options.processContentBlocks),
  );
  const service = new ToolExecutionService({
    builtinToolsExecutor: {} as any,
    mcpService: { callTool } as any,
  });
  return { callTool, service };
};

describe('executeMCPTool — картинки и формат ответа', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.uploadBase64.mockResolvedValue({ fileId: 'file-uuid-1', key: 'k/1.png', url: PROXY_URL });
  });

  const figmaFrame = () => ({
    content: [
      { text: 'Frame 1:2 "Login"', type: 'text' },
      { data: BASE64, mimeType: 'image/png', type: 'image' },
    ],
  });

  it('картинка уходит в хранилище пользователя, base64 нет ни в тексте, ни в state', async () => {
    const { callTool, service } = serviceReturning(figmaFrame());

    const result = await service.executeTool(payload(), context);

    expect(mocks.fileServiceCtor).toHaveBeenCalledWith(serverDB, 'user-1');
    expect(mocks.uploadBase64).toHaveBeenCalledWith(
      BASE64,
      expect.stringMatching(/\/mcp\/images\/.+\.png$/),
    );
    expect(callTool.mock.calls[0][0].processContentBlocks).toBeTypeOf('function');

    expect(result.success).toBe(true);
    expect(result.content).toBe(`Frame 1:2 "Login"\n\n![](${PROXY_URL})`);
    expect(result.state).toEqual({
      content: [
        { text: 'Frame 1:2 "Login"', type: 'text' },
        { data: PROXY_URL, fileId: 'file-uuid-1', mimeType: 'image/png', type: 'image' },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('iVBORw0KGgo');
  });

  it('модели уходит текст ответа, а не JSON-обёртка; текст ответа один раз', async () => {
    const { service } = serviceReturning(figmaFrame());

    const result = await service.executeTool(payload(), context);

    expect(result.content.startsWith('{')).toBe(false);
    expect(result.content.match(/Frame 1:2/g)).toHaveLength(1);
    expect(result.content).not.toContain('"success"');
    expect(result.content).not.toContain('"state"');
  });

  it('загрузка упала — вместо картинки текст с причиной, инструмент не падает, base64 не остаётся', async () => {
    mocks.uploadBase64.mockRejectedValue(new Error('S3 is down'));
    const { service } = serviceReturning(figmaFrame());

    const result = await service.executeTool(payload(), context);

    expect(result.success).toBe(true);
    expect(result.content).toBe('Frame 1:2 "Login"\n\n[картинка не сохранена: S3 is down]');
    expect(JSON.stringify(result)).not.toContain('iVBORw0KGgo');
    expect(result.state?.content[1]).toEqual({
      text: '[картинка не сохранена: S3 is down]',
      type: 'text',
    });
  });

  it('нет пользователя или базы — картинка заменена текстом, хранилище не трогаем', async () => {
    const { service } = serviceReturning(figmaFrame());

    for (const ctx of [
      { ...context, userId: undefined },
      { ...context, serverDB: undefined },
    ]) {
      const result = await service.executeTool(payload(), ctx);
      expect(result.success).toBe(true);
      expect(result.content).toContain('[картинка не сохранена: нет пользователя или хранилища]');
      expect(JSON.stringify(result)).not.toContain('iVBORw0KGgo');
    }
    expect(mocks.fileServiceCtor).not.toHaveBeenCalled();
    expect(mocks.uploadBase64).not.toHaveBeenCalled();
  });

  it('текстовый ответ (подключения студии) хранилища не касается и приходит как есть', async () => {
    // Подключение студии ходит доверенным путём: служебный токен и номер человека (F6)
    process.env.ARCKEP_INTERNAL_TOKEN = 'internal-secret';
    mocks.resolveArckepUserId.mockResolvedValue(15);
    const json = JSON.stringify({ id: 12, object: 'generation', status: 'queued' });
    const { service } = serviceReturning({ content: [{ text: json, type: 'text' }] });

    const result = await service.executeTool(payload('mcp-arckep-studio-images', 'create_image'), {
      ...context,
      toolManifestMap: { 'mcp-arckep-studio-images': context.toolManifestMap['mcp-figma'] },
    });

    expect(mocks.fileServiceCtor).not.toHaveBeenCalled();
    expect(result.content).toBe(json);
    expect(JSON.parse(result.content)).toEqual({ id: 12, object: 'generation', status: 'queued' });
    expect(result.state).toEqual({ content: [{ text: json, type: 'text' }] });
    delete process.env.ARCKEP_INTERNAL_TOKEN;
  });

  it('ошибка инструмента (isError): текст ошибки как есть, success не меняется — повторы не включаются', async () => {
    const { service } = serviceReturning({
      content: [{ text: 'Node 9:9 not found', type: 'text' }],
      isError: true,
    });

    const result = await service.executeTool(payload(), context);

    expect(result.success).toBe(true);
    expect(result.content).toBe('Node 9:9 not found');
    expect(result.state).toEqual({
      content: [{ text: 'Node 9:9 not found', type: 'text' }],
      isError: true,
    });
    expect(mocks.uploadBase64).not.toHaveBeenCalled();
  });

  it('ошибка протокола MCP (McpError) — сообщение как есть', async () => {
    const callTool = vi.fn().mockResolvedValue({
      content: 'Invalid params',
      error: new Error('Invalid params'),
      state: { content: [{ text: 'Invalid params', type: 'text' }], isError: true },
      success: false,
    });
    const service = new ToolExecutionService({
      builtinToolsExecutor: {} as any,
      mcpService: { callTool } as any,
    });

    const result = await service.executeTool(payload(), context);

    expect(result.success).toBe(true);
    expect(result.content).toBe('Invalid params');
    expect(result.state).toEqual({
      content: [{ text: 'Invalid params', type: 'text' }],
      isError: true,
    });
  });

  it('вызов инструмента упал (исключение) — success=false, как раньше', async () => {
    const callTool = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED'));
    const service = new ToolExecutionService({
      builtinToolsExecutor: {} as any,
      mcpService: { callTool } as any,
    });

    const result = await service.executeTool(payload(), context);

    expect(result.success).toBe(false);
    expect(result.content).toBe('connect ECONNREFUSED');
  });
});

describe('executeCloudMCPTool — те же правила для картинок', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.uploadBase64.mockResolvedValue({ fileId: 'file-uuid-1', key: 'k/1.png', url: PROXY_URL });
  });

  const service = () =>
    new ToolExecutionService({ builtinToolsExecutor: {} as any, mcpService: {} as any });

  it('картинка облачного подключения — в хранилище, не base64 в тексте', async () => {
    mocks.callCloudMcpEndpoint.mockResolvedValue({
      content: [{ data: BASE64, mimeType: 'image/png', type: 'image' }],
    });

    const result = await service().executeTool(payload('mcp-cloud', 'shot'), context);

    expect(result.success).toBe(true);
    expect(result.content).toBe(`![](${PROXY_URL})`);
    expect(JSON.stringify(result)).not.toContain('iVBORw0KGgo');
  });

  it('isError: блоки не трогаем, success=false', async () => {
    mocks.callCloudMcpEndpoint.mockResolvedValue({
      content: [{ text: 'quota exceeded', type: 'text' }],
      isError: true,
    });

    const result = await service().executeTool(payload('mcp-cloud', 'shot'), context);

    expect(result.success).toBe(false);
    expect(result.content).toBe('quota exceeded');
    expect(mocks.uploadBase64).not.toHaveBeenCalled();
  });
});
