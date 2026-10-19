import { beforeEach, describe, expect, it, vi } from 'vitest';

const callTool = vi.fn();

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn().mockImplementation(() => ({ callTool })),
}));

const params = { name: 'studio', type: 'http', url: 'http://127.0.0.1:8422/mcp' } as const;

const load = async () => {
  vi.resetModules();
  return (await import('../client')).MCPClient;
};

describe('MCPClient.callTool — calls that wait for a job (arckep, studio chat F9)', () => {
  beforeEach(() => {
    callTool.mockReset().mockResolvedValue({ content: [{ text: 'ok', type: 'text' }] });
    delete process.env.MCP_TOOL_TIMEOUT;
    delete process.env.MCP_TOOL_MAX_TOTAL_TIMEOUT;
  });

  it('renews the call timer on every progress notification, capped by a total timeout', async () => {
    const MCPClient = await load();

    await new MCPClient({ ...params }).callTool('create_video', { request: {} });

    const [call, schema, options] = callTool.mock.calls[0];
    expect(call).toEqual({ arguments: { request: {} }, name: 'create_video' });
    expect(schema).toBeUndefined();
    expect(options.resetTimeoutOnProgress).toBe(true);
    expect(options.timeout).toBe(60_000); // a silent server still fails in a minute
    expect(options.maxTotalTimeout).toBe(35 * 60_000);
    // a handler is what makes the SDK send a progress token: without one the server cannot report progress
    expect(typeof options.onprogress).toBe('function');
    expect(() => options.onprogress({ progress: 20, message: 'processing' })).not.toThrow();
  });

  it('takes both limits from the environment', async () => {
    process.env.MCP_TOOL_TIMEOUT = '90000';
    process.env.MCP_TOOL_MAX_TOTAL_TIMEOUT = '120000';
    const MCPClient = await load();

    await new MCPClient({ ...params }).callTool('create_image', {});

    const options = callTool.mock.calls[0][2];
    expect([options.timeout, options.maxTotalTimeout]).toEqual([90_000, 120_000]);
  });

  it('ignores a nonsense limit and keeps the defaults', async () => {
    process.env.MCP_TOOL_MAX_TOTAL_TIMEOUT = 'soon';
    process.env.MCP_TOOL_TIMEOUT = '-5';
    const MCPClient = await load();

    await new MCPClient({ ...params }).callTool('create_image', {});

    const options = callTool.mock.calls[0][2];
    expect([options.timeout, options.maxTotalTimeout]).toEqual([60_000, 35 * 60_000]);
  });
});
