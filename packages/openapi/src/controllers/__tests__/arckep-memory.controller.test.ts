import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as memoryBilling from '@/server/services/memory/userMemory/arckepAttemptReceipt';

import MemoriesRoutes from '../../routes/memories.route';

// arckep (20.10.2026, автосбор памяти): REST /api/v1/memories/settings и /api/v1/memories/extract.
// Модель пользователя и сам разбор подменены; проверяется слой REST: поле autoExtract, частичный PATCH,
// служебный вход, пропуск при выключенном автосборе и лимиты запуска.

const mocks = vi.hoisted(() => ({
  createRule: vi.fn(),
  deleteRule: vi.fn(),
  memory: undefined as Record<string, unknown> | undefined,
  queryMemories: vi.fn(),
  queryPreferencesExcludingRules: vi.fn(),
  queryRules: vi.fn(),
  runAutoExtract: vi.fn(),
  runDailyDigest: vi.fn(),
  updateRule: vi.fn(),
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
  UserMemoryModel: class {
    queryMemories = mocks.queryMemories;
  },
  UserMemoryPreferenceModel: class {
    queryRules = mocks.queryRules;
    createRule = mocks.createRule;
    updateRule = mocks.updateRule;
    deleteRule = mocks.deleteRule;
    queryPreferencesExcludingRules = mocks.queryPreferencesExcludingRules;
  },
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
    c.set('authData', { studioUserId: 15 });
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

  it('attaches an optional Studio billing run only on service-authenticated digests', async () => {
    mocks.memory = { autoExtract: true };
    const billingOperationId = 'memauto-123456789012345678901234';
    const body = { billingOperationId, mode: 'digest', studioUserId: 15 };
    const scope = vi.spyOn(memoryBilling, 'withMemoryBillingRun');
    mocks.runDailyDigest.mockResolvedValue({});

    expect((await call('POST', '/extract', body)).status).toBe(200);
    expect((await call('POST', '/extract', body, buildApp('api-key'))).status).toBe(403);
    expect((await call('POST', '/extract', { ...body, studioUserId: 99 })).status).toBe(403);
    expect((await call('POST', '/extract', { ...body, studioUserId: undefined })).status).toBe(400);
    expect((await call('POST', '/extract', { ...body, mode: 'topics' })).status).toBe(400);
    expect((await call('POST', '/extract', { ...body, billingOperationId: 'bad' })).status).toBe(
      400,
    );
    expect(mocks.runDailyDigest).toHaveBeenCalledTimes(1);
    expect(scope).toHaveBeenCalledWith({ billingOperationId, userId: 15 }, expect.any(Function));
    scope.mockRestore();
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

  it('прокидывает excludeTopicIds в runDailyDigest и runAutoExtract', async () => {
    mocks.memory = { autoExtract: true };
    mocks.runDailyDigest.mockResolvedValue({
      extracted: 0,
      failed: 0,
      memories: 0,
      topics: 0,
      usage: {},
    });

    const resDigest = await call('POST', '/extract', {
      excludeTopicIds: ['tpc_guard_1', 'tpc_guard_2'],
      mode: 'digest',
    });
    expect(resDigest.status).toBe(200);
    expect(mocks.runDailyDigest).toHaveBeenCalledWith(
      expect.anything(),
      USER,
      expect.objectContaining({
        excludeTopicIds: ['tpc_guard_1', 'tpc_guard_2'],
      }),
    );

    const resTopics = await call('POST', '/extract', {
      excludeTopicIds: ['tpc_guard_1'],
      mode: 'topics',
    });
    expect(resTopics.status).toBe(200);
    expect(mocks.runAutoExtract).toHaveBeenCalledWith(
      expect.anything(),
      USER,
      expect.objectContaining({
        excludeTopicIds: ['tpc_guard_1'],
      }),
    );
  });
});

describe('CRUD /api/v1/memories/rules и исключение правил из GET /api/v1/memories?layer=preference', () => {
  it('GET /rules считает кириллические токены и возвращает лимиты 15 / 500', async () => {
    mocks.queryRules.mockResolvedValue([
      {
        conclusionDirectives: 'Отвечай кратко и по делу',
        createdAt: new Date('2026-11-22T15:00:00.000Z'),
        id: 'mem_rule_1',
        updatedAt: new Date('2026-11-22T15:00:00.000Z'),
      },
    ]);

    const { body, status } = await call('GET', '/rules');
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toEqual({
      items: [
        {
          createdAt: '2026-11-22T15:00:00.000Z',
          id: 'mem_rule_1',
          text: 'Отвечай кратко и по делу',
          tokens: 15,
          updatedAt: '2026-11-22T15:00:00.000Z',
        },
      ],
      maxRules: 15,
      maxTokens: 500,
      total: 1,
      usedTokens: 15,
    });
  });

  it('POST / PATCH / DELETE /rules возвращают 200 и коды ошибок 400 / 404', async () => {
    mocks.createRule.mockResolvedValueOnce({
      item: {
        createdAt: '2026-11-22T15:00:00.000Z',
        id: 'mem_rule_1',
        text: 'Цены всегда в ₽',
        tokens: 10,
        updatedAt: '2026-11-22T15:00:00.000Z',
      },
      maxRules: 15,
      maxTokens: 500,
      total: 1,
      usedTokens: 10,
    });

    const created = await call('POST', '/rules', { text: 'Цены всегда в ₽' });
    expect(created.status).toBe(200);
    expect(created.body.data.item.id).toBe('mem_rule_1');

    for (const code of [
      'RULE_LENGTH_INVALID',
      'RULE_DUPLICATE',
      'RULE_COUNT_LIMIT',
      'RULE_TOKEN_LIMIT',
    ]) {
      mocks.createRule.mockRejectedValueOnce(Object.assign(new Error(code), { code }));
      const bad = await call('POST', '/rules', { text: 'x' });
      expect(bad.status).toBe(400);
      expect(bad.body).toMatchObject({ error: code, success: false });
    }

    mocks.updateRule.mockRejectedValueOnce(
      Object.assign(new Error('RULE_NOT_FOUND'), { code: 'RULE_NOT_FOUND' }),
    );
    const notFound = await call('PATCH', '/rules/missing', { text: 'Новое правило' });
    expect(notFound.status).toBe(404);
    expect(notFound.body).toMatchObject({ error: 'RULE_NOT_FOUND', success: false });

    // Static /rules/:id route MUST NOT be captured by DELETE /:id?layer=...
    mocks.deleteRule.mockResolvedValueOnce({ deleted: true, id: 'mem_rule_1' });
    const deleted = await call('DELETE', '/rules/mem_rule_1');
    expect(deleted.status).toBe(200);
    expect(deleted.body).toMatchObject({ data: { id: 'mem_rule_1' }, success: true });
  });

  it('GET /?layer=preference вызывает queryPreferencesExcludingRules вместо общего queryMemories', async () => {
    mocks.queryPreferencesExcludingRules.mockResolvedValueOnce({
      items: [],
      page: 1,
      pageSize: 50,
      total: 0,
    });

    const prefRes = await call('GET', '?layer=preference&page=1&pageSize=50');
    expect(prefRes.status).toBe(200);
    expect(mocks.queryPreferencesExcludingRules).toHaveBeenCalledWith({
      order: 'desc',
      page: 1,
      pageSize: 50,
      q: undefined,
    });
    expect(mocks.queryMemories).not.toHaveBeenCalled();

    mocks.queryMemories.mockResolvedValueOnce({ items: [], page: 1, pageSize: 50, total: 0 });
    const ctxRes = await call('GET', '?layer=context');
    expect(ctxRes.status).toBe(200);
    expect(mocks.queryMemories).toHaveBeenCalledTimes(1);
  });
});
