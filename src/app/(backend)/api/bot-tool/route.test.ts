import { beforeEach, describe, expect, it, vi } from 'vitest';

import { POST } from './route';

const setBotEnabled = vi.fn();
vi.mock('@/server/services/bot/botEnableService', () => ({
  setBotEnabled: (...a: unknown[]) => setBotEnabled(...a),
}));

const SECRET = 'shared-internal-secret';

const makeReq = (opts: { body?: unknown; rawBody?: string; secret?: string | null }) => {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (opts.secret) headers.set('x-arckep-token', opts.secret);
  const init: RequestInit = { headers, method: 'POST' };
  if (opts.rawBody !== undefined) init.body = opts.rawBody;
  else if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  // The handler only uses req.headers.get + req.json() — both on the base Request.
  return new Request('http://localhost/chat/api/bot-tool/', init) as never;
};

beforeEach(() => {
  setBotEnabled.mockReset();
  process.env.LOBECHAT_BACKEND_KEY = SECRET;
  delete process.env.ARCKEP_INTERNAL_TOKEN;
});

describe('bot-tool POST', () => {
  it('401 when the secret header is missing (no runtime work)', async () => {
    const res = await POST(makeReq({ body: { action: 'enable', botId: 'b', userId: 'u' } }));
    expect(res.status).toBe(401);
    expect(setBotEnabled).not.toHaveBeenCalled();
  });

  it('401 when the secret is wrong', async () => {
    const res = await POST(
      makeReq({ body: { action: 'enable', botId: 'b', userId: 'u' }, secret: 'nope' }),
    );
    expect(res.status).toBe(401);
    expect(setBotEnabled).not.toHaveBeenCalled();
  });

  it('400 on a bad action or missing fields', async () => {
    const res = await POST(
      makeReq({ body: { action: 'boom', botId: 'b', userId: 'u' }, secret: SECRET }),
    );
    expect(res.status).toBe(400);
    expect(setBotEnabled).not.toHaveBeenCalled();
  });

  it('404 when the bot is not owned by the caller (setBotEnabled → null)', async () => {
    setBotEnabled.mockResolvedValue(null);
    const res = await POST(
      makeReq({ body: { action: 'disable', botId: 'b', userId: 'u' }, secret: SECRET }),
    );
    expect(res.status).toBe(404);
    expect(setBotEnabled).toHaveBeenCalledWith('u', 'b', false);
  });

  it('200 + status/runtimeStatus; threads the server-resolved owner through', async () => {
    setBotEnabled.mockResolvedValue({
      applicationId: '8677',
      enabled: true,
      platform: 'telegram',
      runtimeStatus: 'connected',
    });
    const res = await POST(
      makeReq({ body: { action: 'enable', botId: 'b1', userId: 'owner-9' }, secret: SECRET }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({
      ok: true,
      platform: 'telegram',
      runtimeStatus: 'connected',
      status: 'enabled',
    });
    expect(setBotEnabled).toHaveBeenCalledWith('owner-9', 'b1', true);
  });

  it('502 when the runtime toggle throws', async () => {
    setBotEnabled.mockRejectedValue(new Error('runtime down'));
    const res = await POST(
      makeReq({ body: { action: 'enable', botId: 'b', userId: 'u' }, secret: SECRET }),
    );
    expect(res.status).toBe(502);
  });
});
