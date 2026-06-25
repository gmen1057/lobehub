import { beforeEach, describe, expect, it, vi } from 'vitest';

import { POST } from './route';

const setBotEnabled = vi.fn();
const setGreeting = vi.fn();
const setCommands = vi.fn();
const setAccessRule = vi.fn();
const setModel = vi.fn();

vi.mock('@/server/services/bot/botEnableService', () => ({
  setBotEnabled: (...a: unknown[]) => setBotEnabled(...a),
}));

vi.mock('@/server/services/bot/botMutationService', () => ({
  setAccessRule: (...a: unknown[]) => setAccessRule(...a),
  setCommands: (...a: unknown[]) => setCommands(...a),
  setGreeting: (...a: unknown[]) => setGreeting(...a),
  setModel: (...a: unknown[]) => setModel(...a),
}));

const SECRET = 'shared-internal-secret';

const makeReq = (opts: { body?: unknown; rawBody?: string; secret?: string | null }) => {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (opts.secret) headers.set('x-arckep-token', opts.secret);
  const init: RequestInit = { headers, method: 'POST' };
  if (opts.rawBody !== undefined) init.body = opts.rawBody;
  else if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  return new Request('http://localhost/chat/api/bot-tool/', init) as never;
};

beforeEach(() => {
  setBotEnabled.mockReset();
  setGreeting.mockReset();
  setCommands.mockReset();
  setAccessRule.mockReset();
  setModel.mockReset();
  process.env.LOBECHAT_BACKEND_KEY = SECRET;
  delete process.env.ARCKEP_INTERNAL_TOKEN;
});

describe('bot-tool POST', () => {
  // ── auth ──────────────────────────────────────────────────────────────
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

  // ── enable / disable (Phase 13) ───────────────────────────────────────
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

  // ── setGreeting (Phase 22) ────────────────────────────────────────────
  it('setGreeting: 400 when greeting is missing', async () => {
    const res = await POST(
      makeReq({ body: { action: 'setGreeting', botId: 'b', userId: 'u' }, secret: SECRET }),
    );
    expect(res.status).toBe(400);
    expect(setGreeting).not.toHaveBeenCalled();
  });

  it('setGreeting: 400 when greeting is empty', async () => {
    const res = await POST(
      makeReq({ body: { action: 'setGreeting', botId: 'b', userId: 'u', greeting: '' }, secret: SECRET }),
    );
    expect(res.status).toBe(400);
    expect(setGreeting).not.toHaveBeenCalled();
  });

  it('setGreeting: 200 when greeting is valid', async () => {
    setGreeting.mockResolvedValue({ botId: 'b', ok: true });
    const res = await POST(
      makeReq({ body: { action: 'setGreeting', botId: 'b', userId: 'u', greeting: 'Hello' }, secret: SECRET }),
    );
    expect(res.status).toBe(200);
    expect(setGreeting).toHaveBeenCalledWith('u', 'b', 'Hello');
  });

  // ── setCommands (Phase 22) ────────────────────────────────────────────
  it('setCommands: 400 when commands is not an array', async () => {
    const res = await POST(
      makeReq({ body: { action: 'setCommands', botId: 'b', userId: 'u', commands: 'not-array' }, secret: SECRET }),
    );
    expect(res.status).toBe(400);
    expect(setCommands).not.toHaveBeenCalled();
  });

  it('setCommands: 400 when a command has no name', async () => {
    const res = await POST(
      makeReq({
        body: { action: 'setCommands', botId: 'b', userId: 'u', commands: [{ description: 'x', name: '', response: 'y' }] },
        secret: SECRET,
      }),
    );
    expect(res.status).toBe(400);
    expect(setCommands).not.toHaveBeenCalled();
  });

  // ── setModel (Phase 22) ───────────────────────────────────────────────
  it('setModel: 404 when bot not owned by caller (anti-IDOR)', async () => {
    setModel.mockResolvedValue(null);
    const res = await POST(
      makeReq({
        body: { action: 'setModel', botId: 'foreign', userId: 'u', model: 'gpt-5', provider: 'openai' },
        secret: SECRET,
      }),
    );
    expect(res.status).toBe(404);
    expect(setModel).toHaveBeenCalledWith('u', 'foreign', 'gpt-5', 'openai');
  });

  it('setModel: 200 when valid', async () => {
    setModel.mockResolvedValue({ botId: 'b', ok: true });
    const res = await POST(
      makeReq({
        body: { action: 'setModel', botId: 'b', userId: 'u', model: 'claude-sonnet', provider: 'anthropic' },
        secret: SECRET,
      }),
    );
    expect(res.status).toBe(200);
    expect(setModel).toHaveBeenCalledWith('u', 'b', 'claude-sonnet', 'anthropic');
  });

  // ── setAccessRule (Phase 22) ──────────────────────────────────────────
  it('setAccessRule: 400 when charLimit is a string', async () => {
    const res = await POST(
      makeReq({
        body: { action: 'setAccessRule', botId: 'b', userId: 'u', charLimit: 'big' },
        secret: SECRET,
      }),
    );
    expect(res.status).toBe(400);
    expect(setAccessRule).not.toHaveBeenCalled();
  });

  it('setAccessRule: 200 with dmPolicy only', async () => {
    setAccessRule.mockResolvedValue({ botId: 'b', ok: true });
    const res = await POST(
      makeReq({
        body: { action: 'setAccessRule', botId: 'b', userId: 'u', dmPolicy: 'allowlist' },
        secret: SECRET,
      }),
    );
    expect(res.status).toBe(200);
    expect(setAccessRule).toHaveBeenCalledWith('u', 'b', 'allowlist', undefined);
  });
});
