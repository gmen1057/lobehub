import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ArckepRoutes from '../../routes/arckep.route';

// arckep (19.10.2026, задачи помощника по расписанию): REST /api/v1/arckep/cron-jobs.
// Модели, база и сам запуск подменены; проверяется то, что делает слой REST: проверка входа, расписания,
// владельца помощника, 404 для чужого/несуществующего, форма ответов и передача userId в модели.

const mocks = vi.hoisted(() => ({
  agentRows: [] as Array<{ id: string }>,
  create: vi.fn(),
  delete: vi.fn(),
  findByAgentId: vi.fn(),
  findById: vi.fn(),
  findByUserId: vi.fn(),
  getCronTopicsByCronJobId: vi.fn(),
  modelUserIds: [] as string[],
  runCronJob: vi.fn(),
  topicUserIds: [] as string[],
  update: vi.fn(),
}));

vi.mock('@/const/rbac', () => ({ RBAC_PERMISSIONS: {} }));
vi.mock('@/envs/file', () => ({ fileEnv: {} }));
vi.mock('@/database/models/rbac', () => ({ RbacModel: class {} }));
vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: vi.fn(async () => ({
    select: () => ({ from: () => ({ where: () => ({ limit: async () => mocks.agentRows }) }) }),
  })),
}));
vi.mock('@/database/schemas', () => ({ agents: { id: 'id', userId: 'user_id' } }));
vi.mock('@/database/models/agentCronJob', () => ({
  AgentCronJobModel: class {
    constructor(_db: unknown, userId: string) {
      mocks.modelUserIds.push(userId);
    }
    create = mocks.create;
    delete = mocks.delete;
    findByAgentId = mocks.findByAgentId;
    findById = mocks.findById;
    findByUserId = mocks.findByUserId;
    update = mocks.update;
  },
}));
vi.mock('@/database/models/topic', () => ({
  TopicModel: class {
    constructor(_db: unknown, userId: string) {
      mocks.topicUserIds.push(userId);
    }
    getCronTopicsByCronJobId = mocks.getCronTopicsByCronJobId;
  },
}));
vi.mock('@/server/services/arckepCron/run', () => ({ runCronJob: mocks.runCronJob }));
vi.mock('../../middleware/auth', () => ({
  requireAuth: async (c: any, next: () => Promise<void>) => {
    if (!c.get('userId')) throw new HTTPException(401, { message: 'Authentication required' });
    await next();
  },
}));

const USER = 'user-1';

const buildApp = (userId: string | null = USER) => {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('userId', userId);
    await next();
  });
  app.route('/api/v1/arckep', ArckepRoutes);
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
  const res = await app.request(`/api/v1/arckep${path}`, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
    method,
  });
  return { body: await res.json(), status: res.status };
};

const jobRow = (over: Record<string, unknown> = {}) => ({
  agentId: 'agt_1',
  content: 'Собери новости',
  createdAt: new Date('2026-10-19T08:00:00Z'),
  cronPattern: '0 9 * * *',
  description: null,
  editData: { secret: 'rich' },
  enabled: true,
  executionConditions: null,
  groupId: null,
  id: 'cron_1',
  lastExecutedAt: null,
  maxExecutions: null,
  name: 'Дайджест',
  remainingExecutions: null,
  timezone: 'Europe/Moscow',
  totalExecutions: 0,
  updatedAt: new Date('2026-10-19T08:00:00Z'),
  userId: USER,
  ...over,
});

const createBody = (over: Record<string, unknown> = {}) => ({
  agentId: 'agt_1',
  content: 'Собери новости',
  cronPattern: '0 9 * * *',
  name: 'Дайджест',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.agentRows = [{ id: 'agt_1' }];
  mocks.modelUserIds.length = 0;
  mocks.topicUserIds.length = 0;
  mocks.create.mockImplementation(async (data) =>
    jobRow({ ...data, remainingExecutions: data.maxExecutions ?? null }),
  );
  mocks.update.mockImplementation(async (_id, data) => jobRow(data));
  mocks.findById.mockResolvedValue(jobRow());
  mocks.delete.mockResolvedValue(true);
});

describe('доступ', () => {
  it('без входа — 401', async () => {
    const { status } = await call('GET', '/cron-jobs', undefined, buildApp(null));
    expect(status).toBe(401);
  });

  it('все модели строятся по пользователю из контекста', async () => {
    mocks.findByUserId.mockResolvedValue([]);
    await call('GET', '/cron-jobs');
    await call('POST', '/cron-jobs', createBody());
    await call('PATCH', '/cron-jobs/cron_1', { enabled: false });
    await call('DELETE', '/cron-jobs/cron_1');
    mocks.runCronJob.mockResolvedValue({ operationId: 'op', success: true, topicId: 't' });
    await call('POST', '/cron-jobs/cron_1/run', { runId: 'r1' });
    mocks.getCronTopicsByCronJobId.mockResolvedValue([]);
    await call('GET', '/cron-jobs/cron_1/topics');

    expect(new Set(mocks.modelUserIds)).toEqual(new Set([USER]));
    expect(mocks.modelUserIds.length).toBeGreaterThanOrEqual(6);
    expect(new Set(mocks.topicUserIds)).toEqual(new Set([USER]));
  });
});

describe('GET /cron-jobs', () => {
  it('отдаёт задачи в camelCase без служебных полей, новые первыми', async () => {
    mocks.findByUserId.mockResolvedValue([
      jobRow({ createdAt: new Date('2026-10-01T00:00:00Z'), id: 'cron_old' }),
      jobRow({
        createdAt: new Date('2026-10-18T00:00:00Z'),
        id: 'cron_new',
        lastExecutedAt: new Date('2026-10-19T06:00:00Z'),
        maxExecutions: 5,
        remainingExecutions: 3,
        totalExecutions: 2,
      }),
    ]);

    const { body, status } = await call('GET', '/cron-jobs');

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.map((job: any) => job.id)).toEqual(['cron_new', 'cron_old']);
    expect(body.data[0]).toEqual({
      agentId: 'agt_1',
      content: 'Собери новости',
      createdAt: '2026-10-18T00:00:00.000Z',
      cronPattern: '0 9 * * *',
      description: null,
      enabled: true,
      executionConditions: null,
      id: 'cron_new',
      lastExecutedAt: '2026-10-19T06:00:00.000Z',
      maxExecutions: 5,
      name: 'Дайджест',
      remainingExecutions: 3,
      timezone: 'Europe/Moscow',
      totalExecutions: 2,
      updatedAt: '2026-10-19T08:00:00.000Z',
    });
    expect(body.data[0]).not.toHaveProperty('userId');
    expect(body.data[0]).not.toHaveProperty('editData');
    expect(body.data[0]).not.toHaveProperty('groupId');
  });

  it('?agentId= ограничивает помощником', async () => {
    mocks.findByAgentId.mockResolvedValue([jobRow()]);

    const { body } = await call('GET', '/cron-jobs?agentId=agt_1');

    expect(mocks.findByAgentId).toHaveBeenCalledWith('agt_1');
    expect(mocks.findByUserId).not.toHaveBeenCalled();
    expect(body.data).toHaveLength(1);
  });

  it('странный agentId — 400', async () => {
    const { status } = await call('GET', '/cron-jobs?agentId=a%20b;drop');
    expect(status).toBe(400);
  });
});

describe('POST /cron-jobs', () => {
  it('создаёт задачу: шаблон нормализован, пояс по умолчанию Europe/Moscow', async () => {
    const { body, status } = await call(
      'POST',
      '/cron-jobs',
      createBody({ cronPattern: '  @daily ', maxExecutions: 10, name: '  Дайджест  ' }),
    );

    expect(status).toBe(200);
    expect(mocks.create).toHaveBeenCalledWith({
      agentId: 'agt_1',
      content: 'Собери новости',
      cronPattern: '0 0 * * *',
      description: null,
      enabled: true,
      maxExecutions: 10,
      name: 'Дайджест',
      timezone: 'Europe/Moscow',
    });
    expect(body.data).toMatchObject({ id: 'cron_1', maxExecutions: 10, remainingExecutions: 10 });
  });

  it('пояс и enabled=false сохраняются', async () => {
    await call(
      'POST',
      '/cron-jobs',
      createBody({ description: 'каждое утро', enabled: false, timezone: 'Asia/Yekaterinburg' }),
    );

    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        description: 'каждое утро',
        enabled: false,
        timezone: 'Asia/Yekaterinburg',
      }),
    );
  });

  it.each([
    ['*/5 * * * *', /Minimum interval is 30 minutes/],
    ['* * * * *', /Minimum interval is 30 minutes/],
    ['0,10 * * * *', /Minimum interval is 30 minutes/],
    ['@every 1h', /Unsupported cron macro/],
    ['0 0 9 * * *', /exactly 5 fields/],
    ['61 * * * *', /minute value 61/],
  ])('шаблон %s — 400 с понятным текстом', async (cronPattern, message) => {
    const { body, status } = await call('POST', '/cron-jobs', createBody({ cronPattern }));

    expect(status).toBe(400);
    expect(body.error).toMatch(message);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('несуществующий пояс — 400', async () => {
    const { body, status } = await call(
      'POST',
      '/cron-jobs',
      createBody({ timezone: 'Mars/Phobos' }),
    );

    expect(status).toBe(400);
    expect(body.error).toMatch(/Unknown timezone/);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('чужой помощник — 400, задача не создаётся', async () => {
    mocks.agentRows = [];

    const { body, status } = await call('POST', '/cron-jobs', createBody({ agentId: 'agt_foreign' }));

    expect(status).toBe(400);
    expect(body.error).toBe('Agent not found');
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it.each([
    ['пустое имя', { name: '   ' }],
    ['имя длиннее 80', { name: 'я'.repeat(81) }],
    ['пустой текст', { content: '  ' }],
    ['текст длиннее 8000', { content: 'я'.repeat(8001) }],
    ['нет помощника', { agentId: undefined }],
    ['maxExecutions 0', { maxExecutions: 0 }],
    ['maxExecutions дробный', { maxExecutions: 1.5 }],
    ['enabled строкой', { enabled: 'yes' }],
  ])('%s — 400', async (_title, over) => {
    const { status } = await call('POST', '/cron-jobs', createBody(over));
    expect(status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('границы name 80 и content 8000 проходят', async () => {
    const { status } = await call(
      'POST',
      '/cron-jobs',
      createBody({ content: 'я'.repeat(8000), name: 'я'.repeat(80) }),
    );
    expect(status).toBe(200);
  });
});

describe('PATCH /cron-jobs/:id', () => {
  it('меняет переданные поля, расписание проверяется и нормализуется', async () => {
    const { body, status } = await call('PATCH', '/cron-jobs/cron_1', {
      cronPattern: '@hourly',
      description: null,
      enabled: false,
      maxExecutions: null,
      name: 'Новое имя',
      timezone: 'europe/moscow',
    });

    expect(status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith('cron_1', {
      cronPattern: '0 * * * *',
      description: null,
      enabled: false,
      maxExecutions: null,
      name: 'Новое имя',
      timezone: 'Europe/Moscow',
    });
    expect(body.data.id).toBe('cron_1');
  });

  it('чужая или несуществующая задача — 404', async () => {
    mocks.findById.mockResolvedValue(null);

    const { status } = await call('PATCH', '/cron-jobs/cron_foreign', { enabled: false });

    expect(status).toBe(404);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('новый шаблон чаще 30 минут — 400', async () => {
    const { body, status } = await call('PATCH', '/cron-jobs/cron_1', { cronPattern: '*/10 * * * *' });

    expect(status).toBe(400);
    expect(body.error).toMatch(/Minimum interval/);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('перенос на чужого помощника — 400; на своего — проходит', async () => {
    mocks.agentRows = [];
    const bad = await call('PATCH', '/cron-jobs/cron_1', { agentId: 'agt_foreign' });
    expect(bad.status).toBe(400);
    expect(mocks.update).not.toHaveBeenCalled();

    mocks.agentRows = [{ id: 'agt_2' }];
    const ok = await call('PATCH', '/cron-jobs/cron_1', { agentId: 'agt_2' });
    expect(ok.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith('cron_1', { agentId: 'agt_2' });
  });

  it('тот же помощник не проверяется заново', async () => {
    mocks.agentRows = [];
    const { status } = await call('PATCH', '/cron-jobs/cron_1', { agentId: 'agt_1' });
    expect(status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith('cron_1', {});
  });

  it('пустое тело — 400', async () => {
    const { status } = await call('PATCH', '/cron-jobs/cron_1', {});
    expect(status).toBe(400);
  });
});

describe('DELETE /cron-jobs/:id', () => {
  it('удаляет свою задачу', async () => {
    const { body, status } = await call('DELETE', '/cron-jobs/cron_1');

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(mocks.delete).toHaveBeenCalledWith('cron_1');
  });

  it('чужая или несуществующая — 404', async () => {
    mocks.delete.mockResolvedValue(false);

    const { status } = await call('DELETE', '/cron-jobs/cron_foreign');

    expect(status).toBe(404);
  });
});

describe('POST /cron-jobs/:id/run', () => {
  it('запускает задачу и отдаёт topicId/operationId', async () => {
    mocks.runCronJob.mockResolvedValue({ operationId: 'op_1', success: true, topicId: 'tpc_1' });

    const { body, status } = await call('POST', '/cron-jobs/cron_1/run', { runId: 'run-42' });

    expect(status).toBe(200);
    expect(body.data).toEqual({ operationId: 'op_1', success: true, topicId: 'tpc_1' });
    expect(mocks.runCronJob).toHaveBeenCalledWith(
      expect.anything(),
      USER,
      expect.objectContaining({ id: 'cron_1' }),
      'run-42',
    );
  });

  it('запуск выключенной задачи разрешён', async () => {
    mocks.findById.mockResolvedValue(jobRow({ enabled: false }));
    mocks.runCronJob.mockResolvedValue({ operationId: 'op_1', success: true, topicId: 'tpc_1' });

    const { body, status } = await call('POST', '/cron-jobs/cron_1/run', { runId: 'manual-1' });

    expect(status).toBe(200);
    expect(body.data.success).toBe(true);
  });

  it('не стартовало — 200 и success:false с текстом внутри data', async () => {
    mocks.runCronJob.mockResolvedValue({
      error: 'Agent operation failed to start',
      operationId: 'op_1',
      success: false,
      topicId: 'tpc_1',
    });

    const { body, status } = await call('POST', '/cron-jobs/cron_1/run', { runId: 'r2' });

    expect(status).toBe(200);
    expect(body.data).toEqual({
      error: 'Agent operation failed to start',
      operationId: 'op_1',
      success: false,
      topicId: 'tpc_1',
    });
  });

  it('чужая или несуществующая задача — 404, запуска нет', async () => {
    mocks.findById.mockResolvedValue(null);

    const { status } = await call('POST', '/cron-jobs/cron_foreign/run', { runId: 'r3' });

    expect(status).toBe(404);
    expect(mocks.runCronJob).not.toHaveBeenCalled();
  });

  it('без runId — 400', async () => {
    const { status } = await call('POST', '/cron-jobs/cron_1/run', {});
    expect(status).toBe(400);
    expect(mocks.runCronJob).not.toHaveBeenCalled();
  });
});

describe('GET /cron-jobs/:id/topics', () => {
  it('переписки запусков: id, title, createdAt, updatedAt', async () => {
    mocks.getCronTopicsByCronJobId.mockResolvedValue([
      {
        createdAt: new Date('2026-10-19T09:00:00Z'),
        id: 'tpc_2',
        title: 'Дайджест · 19.10 12:00',
        updatedAt: new Date('2026-10-19T09:05:00Z'),
      },
      {
        createdAt: new Date('2026-10-18T09:00:00Z'),
        id: 'tpc_1',
        title: null,
        updatedAt: new Date('2026-10-18T09:03:00Z'),
      },
    ]);

    const { body, status } = await call('GET', '/cron-jobs/cron_1/topics?limit=10');

    expect(status).toBe(200);
    expect(mocks.getCronTopicsByCronJobId).toHaveBeenCalledWith('cron_1', 10);
    expect(body.data).toEqual([
      {
        createdAt: '2026-10-19T09:00:00.000Z',
        id: 'tpc_2',
        title: 'Дайджест · 19.10 12:00',
        updatedAt: '2026-10-19T09:05:00.000Z',
      },
      {
        createdAt: '2026-10-18T09:00:00.000Z',
        id: 'tpc_1',
        title: null,
        updatedAt: '2026-10-18T09:03:00.000Z',
      },
    ]);
  });

  it('по умолчанию 50, чужая задача — 404', async () => {
    mocks.getCronTopicsByCronJobId.mockResolvedValue([]);
    await call('GET', '/cron-jobs/cron_1/topics');
    expect(mocks.getCronTopicsByCronJobId).toHaveBeenCalledWith('cron_1', 50);

    mocks.findById.mockResolvedValue(null);
    const { status } = await call('GET', '/cron-jobs/cron_foreign/topics');
    expect(status).toBe(404);
  });
});
