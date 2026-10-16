import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearArckepUserCache } from '../helpers/arckepServiceAuth';
import { requireAuth, userAuthMiddleware } from './auth';

const findByEmail = vi.fn();
const onConflictDoNothing = vi.fn(async () => undefined);
const findByKey = vi.fn(async () => null);
let accountRows: Array<{ password: string | null }> = [];

vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: vi.fn(async () => ({
    insert: () => ({ values: () => ({ onConflictDoNothing }) }),
    select: () => ({ from: () => ({ where: () => ({ limit: async () => accountRows }) }) }),
  })),
}));
vi.mock('@/database/models/user', () => ({
  UserModel: { findByEmail: (...args: unknown[]) => findByEmail(...args) },
}));
vi.mock('@/database/models/apiKey', () => ({
  ApiKeyModel: class {
    findByKey = findByKey;
    updateLastUsed = vi.fn(async () => undefined);
  },
}));
vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => args,
  eq: (...args: unknown[]) => args,
}));
vi.mock('better-auth/crypto', () => ({
  verifyPassword: async ({ hash, password }: { hash: string; password: string }) =>
    hash === `hash:${password}`,
}));
vi.mock('@/database/schemas', () => ({
  account: { password: 'password', providerId: 'provider_id', userId: 'user_id' },
  userRoles: {},
}));
vi.mock('@/envs/auth', () => ({ authEnv: { ENABLE_OIDC: false } }));
vi.mock('@/libs/oidc-provider/jwt', () => ({ validateOIDCJWT: vi.fn() }));
vi.mock('@/utils/apiKey', () => ({
  validateApiKeyFormat: (key: string) => /^sk-lh-[\da-z]{16}$/.test(key),
}));
vi.mock('@/utils/server/auth', () => ({
  extractBearerToken: (header?: string) =>
    header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null,
}));

const SERVICE_KEY = 'a'.repeat(64);

const buildApp = () => {
  const app = new Hono();
  app.use('*', userAuthMiddleware);
  app.get('/me', requireAuth, (c) =>
    c.json({ authType: c.get('authType'), userId: c.get('userId') }),
  );
  app.onError((err, c) => c.json({ error: err.message }, (err as any).status || 500));
  return app;
};

const call = (headers: Record<string, string>) => buildApp().request('/me', { headers });

describe('arckep service auth', () => {
  beforeEach(() => {
    clearArckepUserCache();
    findByEmail.mockReset();
    onConflictDoNothing.mockClear();
    findByKey.mockClear();
    process.env.ARCKEP_ENGINE_SERVICE_KEY = SERVICE_KEY;
    process.env.AUTH_SECRET = 'secret-for-tests-0123456789';
    process.env.PORT = '3403';
    accountRows = [{ password: 'hash:arckep_bridge_4_secret-f' }];
  });

  afterEach(() => {
    delete process.env.ARCKEP_ENGINE_SERVICE_KEY;
    vi.unstubAllGlobals();
  });

  it('без переменной окружения служебный ключ не принимается', async () => {
    delete process.env.ARCKEP_ENGINE_SERVICE_KEY;
    const res = await call({ 'Authorization': `Bearer ${SERVICE_KEY}`, 'X-Arckep-User-Id': '4' });
    expect(res.status).toBe(401);
    expect(findByEmail).not.toHaveBeenCalled();
  });

  it('ключ без заголовка пользователя → 401', async () => {
    const res = await call({ Authorization: `Bearer ${SERVICE_KEY}` });
    expect(res.status).toBe(401);
    expect(findByEmail).not.toHaveBeenCalled();
  });

  it('некорректный id пользователя → 401', async () => {
    const res = await call({ 'Authorization': `Bearer ${SERVICE_KEY}`, 'X-Arckep-User-Id': 'abc' });
    expect(res.status).toBe(401);
    expect(findByEmail).not.toHaveBeenCalled();
  });

  it('чужой bearer не проходит как служебный', async () => {
    const res = await call({
      'Authorization': `Bearer ${'b'.repeat(64)}`,
      'X-Arckep-User-Id': '4',
    });
    expect(res.status).toBe(401);
    expect(findByEmail).not.toHaveBeenCalled();
  });

  it('существующий пользователь user4@arckep.ru → userId и роль', async () => {
    findByEmail.mockResolvedValueOnce({ id: 'user_4' });
    const res = await call({ 'Authorization': `Bearer ${SERVICE_KEY}`, 'X-Arckep-User-Id': '4' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authType: 'arckep-service', userId: 'user_4' });
    expect(findByEmail).toHaveBeenCalledWith(expect.anything(), 'user4@arckep.ru');
    expect(onConflictDoNothing).toHaveBeenCalledTimes(1);
  });

  it('учётка с таким email заведена не bridge (чужой пароль) → 401', async () => {
    accountRows = [{ password: 'hash:attacker-password' }];
    findByEmail.mockResolvedValueOnce({ id: 'user_4' });
    const res = await call({ 'Authorization': `Bearer ${SERVICE_KEY}`, 'X-Arckep-User-Id': '4' });
    expect(res.status).toBe(401);
    expect(onConflictDoNothing).not.toHaveBeenCalled();
  });

  it('учётка без credential-пароля → 401', async () => {
    accountRows = [];
    findByEmail.mockResolvedValueOnce({ id: 'user_4' });
    const res = await call({ 'Authorization': `Bearer ${SERVICE_KEY}`, 'X-Arckep-User-Id': '4' });
    expect(res.status).toBe(401);
  });

  it('пользователя нет → sign-up как в bridge, затем userId', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    accountRows = [{ password: 'hash:arckep_bridge_7_secret-f' }];
    findByEmail.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'user_7' });

    const res = await call({ 'Authorization': `Bearer ${SERVICE_KEY}`, 'X-Arckep-User-Id': '7' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authType: 'arckep-service', userId: 'user_7' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:3403/chat/api/auth/sign-up/email');
    const body = JSON.parse(String(init.body));
    expect(body.email).toBe('user7@arckep.ru');
    expect(body.password).toBe('arckep_bridge_7_secret-f');
  });

  it('sign-up не удался → 401', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('x', { status: 500 })),
    );
    findByEmail.mockResolvedValue(null);
    const res = await call({ 'Authorization': `Bearer ${SERVICE_KEY}`, 'X-Arckep-User-Id': '9' });
    expect(res.status).toBe(401);
  });
});
