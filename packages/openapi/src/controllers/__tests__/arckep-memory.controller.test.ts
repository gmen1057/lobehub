import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import MemoriesRoutes from '../../routes/memories.route';

// arckep (20.10.2026, автосбор памяти): REST /api/v1/memories/settings и /api/v1/memories/extract.
// Модель пользователя и сам разбор подменены; проверяется слой REST: поле autoExtract, частичный PATCH,
// служебный вход, пропуск при выключенном автосборе и лимиты запуска.

const mocks = vi.hoisted(() => ({
  memory: undefined as Record<string, unknown> | undefined,
  runAutoExtract: vi.fn(),
  runDailyDigest: vi.fn(),
  updateSetting: vi.fn(),
  userIds: [] as string[],
}));

vi.mock('@/const/rbac', () => ({ RBAC_PERMISSIONS: {} }));
vi.mock('@/envs/file', () => ({ fileEnv: {} }));
vi.mock('@/database/models/rbac', () => ({ RbacModel: class {} }));
vi.mock('@/database/core/db-adaptor', () => ({ getServerDB: vi.fn(async () => ({})) }));
// Контроллер большой: всё, что он тянет и что в этом тесте не нужно, подменено пустышками.
vi.mock('@/database/models/agent', () => ({ AgentModel: class {} }));
vi.mock('@/database/models/session', () => ({ SessionModel: class {} }));
vi.mock('@/database/models/userMemory', () => ({
  UserMemoryActivityModel: class {},
  UserMemoryContextModel: class {},
  UserMemoryExperienceModel: class {},
  UserMemoryModel: class {},
  UserMemoryPreferenceModel: class {},
}));
vi.mock('@/database/repositories/aiInfra', () => ({ AiInfraRepos: class {} }));
vi.mock('@/database/schemas', () => ({ agents: {}, knowledgeBases: {} }));
vi.mock('@/server/globalConfig', () => ({ getServerGlobalConfig: vi.fn() }));
vi.mock('@/server/modules/AgentRuntime/arckepSearch', () => ({ modelHasBuiltinSearch: vi.fn() }));
vi.mock('@/server/modules/AgentRuntime/reasoningLevels', () => ({
  resolveReasoningAuto: vi.fn(),
  resolveReasoningProfile: vi.fn(),
}));
vi.mock('@/server/modules/AgentRuntime/serverModelParams', () => ({
  findModelExtendParams: vi.fn(),
  resolveServerModelParams: vi.fn(),
}));
vi.mock('@/server/services/agent', () => ({ AgentService: class {} }));
vi.mock('@/server/services/toolExecution/serverRuntimes/arckepStudio', () => ({
  resolveArckepUserId: vi.fn(),
}));
vi.mock('@/server/services/userMcp/gateway', () => ({ UserMcpGatewayError: class {} }));
vi.mock('../../services/plugin.service', () => ({ PluginService: class {} }));
vi.mock('@/database/models/user', () => ({
  UserModel: class {
    constructor(_db: unknown, userId: string) {
      mocks.userIds.push(userId);
    }
    getUserSettings = async () => ({ memory: mocks.memory });
    updateSetting = mocks.updateSetting;
  },
}));
vi.mock('@/server/services/memory/userMemory/arckepAutoExtract', () => ({
  runAutoExtract: mocks.runAutoExtract,
  runDailyDigest: mocks.runDailyDigest,
}));
vi.mock('../../middleware/auth', () => ({
  requireAuth: async (c: any, next: () => Promise<void>) => {
    if (!c.get('userId')) throw new HTTPException(401, { message: 'Authentication required' });
    await next();
  },
}));

const USER = 'user-1';

const buildApp = (authType: string | null = 'arckep-service') => {
  const app = new Hono();
  app.use('*', async (c: any, next) => {
    c.set('userId', USER);
    c.set('authType', authType);
    await next();
  });
  app.route('/api/v1/memories', MemoriesRoutes);
  app.onError((err, c) =>
    c.json({ error: err.message }, ((err as HTTPException).status as 401) || 500),
  );
  return app;
};

const call = async (
  method: string,
  path: string,
  body?: unknown,
  app: Hono = buildApp(),
): Promise<{ body: any; status: number }> => {
  const res = await app.request(`/api/v1/memories${path}`, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
    method,
  });
  return { body: await res.json(), status: res.status };
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.memory = undefined;
  mocks.userIds.length = 0;
  mocks.runAutoExtract.mockResolvedValue({
    extracted: 1,
    failed: 0,
    memories: 2,
    topics: 1,
    usage: {},
  });
});

describe('настройки памяти', () => {
  it('по умолчанию память включена, автосбор выключен', async () => {
    const { body, status } = await call('GET', '/settings');
    expect(status).toBe(200);
    expect(body.data).toEqual({ autoExtract: false, enabled: true });
  });

  it('читает сохранённые значения', async () => {
    mocks.memory = { autoExtract: true, effort: 'high', enabled: false };
    const { body } = await call('GET', '/settings');
    expect(body.data).toEqual({ autoExtract: true, enabled: false });
  });

  it('PATCH одного autoExtract не трогает enabled и остальные поля', async () => {
    mocks.memory = { effort: 'high', enabled: true };
    const { body, status } = await call('PATCH', '/settings', { autoExtract: true });
    expect(status).toBe(200);
    expect(mocks.updateSetting).toHaveBeenCalledWith({
      memory: { autoExtract: true, effort: 'high', enabled: true },
    });
    expect(body.data).toEqual({ autoExtract: true, enabled: true });
  });

  it('PATCH одного enabled — как раньше', async () => {
    const { body } = await call('PATCH', '/settings', { enabled: false });
    expect(mocks.updateSetting).toHaveBeenCalledWith({ memory: { enabled: false } });
    expect(body.data).toEqual({ autoExtract: false, enabled: false });
  });

  it('PATCH без полей — 400', async () => {
    const { status } = await call('PATCH', '/settings', {});
    expect(status).toBe(400);
    expect(mocks.updateSetting).not.toHaveBeenCalled();
  });
});

describe('POST /extract', () => {
  it('только служебный вход студии', async () => {
    mocks.memory = { autoExtract: true };
    const { status } = await call('POST', '/extract', {}, buildApp('oidc'));
    expect(status).toBe(403);
    expect(mocks.runAutoExtract).not.toHaveBeenCalled();
  });

  it('автосбор не включён — пропуск без разбора', async () => {
    mocks.memory = { enabled: true };
    const { body, status } = await call('POST', '/extract', {});
    expect(status).toBe(200);
    expect(body.data).toEqual({ skipped: 'disabled', topics: 0 });
    expect(mocks.runAutoExtract).not.toHaveBeenCalled();
  });

  it('память выключена — пропуск, даже если автосбор включён', async () => {
    mocks.memory = { autoExtract: true, enabled: false };
    const { body } = await call('POST', '/extract', {});
    expect(body.data.skipped).toBe('disabled');
    expect(mocks.runAutoExtract).not.toHaveBeenCalled();
  });

  it('включён — разбор своего пользователя с лимитами по умолчанию', async () => {
    mocks.memory = { autoExtract: true };
    const { body, status } = await call('POST', '/extract', {});
    expect(status).toBe(200);
    expect(mocks.runAutoExtract).toHaveBeenCalledWith(expect.anything(), USER, {
      days: 30,
      idleMinutes: 30,
      limit: 3,
    });
    expect(body.data.memories).toBe(2);
  });

  it('лимит больше 10 тем — 400', async () => {
    mocks.memory = { autoExtract: true };
    const { status } = await call('POST', '/extract', { limit: 11 });
    expect(status).toBe(400);
    expect(mocks.runAutoExtract).not.toHaveBeenCalled();
  });

  it('mode=digest — суточный разбор: до 50 тем, тишина 60 мин, бюджет и память из окружения', async () => {
    mocks.memory = { autoExtract: true };
    mocks.runDailyDigest.mockResolvedValue({
      extracted: 4,
      failed: 0,
      memories: 3,
      topics: 4,
      usage: {},
    });
    const { body, status } = await call('POST', '/extract', { mode: 'digest' });
    expect(status).toBe(200);
    expect(mocks.runDailyDigest).toHaveBeenCalledWith(expect.anything(), USER, {
      contextLimit: 60_000,
      days: 30,
      idleMinutes: 60,
      maxMemories: 300,
      maxTopics: 50,
    });
    expect(mocks.runAutoExtract).not.toHaveBeenCalled();
    expect(body.data.memories).toBe(3);
  });

  it('mode=digest принимает limit до 100; почасовой — до 10', async () => {
    mocks.memory = { autoExtract: true };
    mocks.runDailyDigest.mockResolvedValue({
      extracted: 0,
      failed: 0,
      memories: 0,
      topics: 0,
      usage: {},
    });
    expect((await call('POST', '/extract', { limit: 80, mode: 'digest' })).status).toBe(200);
    expect(mocks.runDailyDigest.mock.calls[0][2].maxTopics).toBe(80);
    expect((await call('POST', '/extract', { limit: 101, mode: 'digest' })).status).toBe(400);
    expect((await call('POST', '/extract', { limit: 11, mode: 'topics' })).status).toBe(400);
  });
});
