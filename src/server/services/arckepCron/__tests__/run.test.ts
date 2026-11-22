import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as FinishedModule from '../finished';
import {
  buildRunTitle,
  clearCronRunCache,
  formatRunTime,
  getActiveCronSnapshot,
  refreshActiveCronRuns,
  runCronJob,
  setCronStartingPollConfigForTests,
} from '../run';

// arckep (19.10.2026, задачи помощника по расписанию): запуск задачи по просьбе студии.

const { mockExecAgent, mockGetRedisClient, mockNotify, mockUpdateStats } = vi.hoisted(() => ({
  mockExecAgent: vi.fn(),
  mockGetRedisClient: vi.fn<() => any>(() => null),
  mockNotify: vi.fn(),
  mockUpdateStats: vi.fn(),
}));

vi.mock('@/server/modules/AgentRuntime/redis', () => ({
  getAgentRuntimeRedisClient: mockGetRedisClient,
}));

vi.mock('@/server/services/aiAgent', () => ({
  AiAgentService: class {
    execAgent = mockExecAgent;
  },
}));

vi.mock('@/database/models/agentCronJob', () => ({
  AgentCronJobModel: { updateExecutionStats: mockUpdateStats },
}));

vi.mock('../finished', async (importOriginal) => ({
  ...(await importOriginal<typeof FinishedModule>()),
  notifyCronFinished: mockNotify,
}));

const db = { tag: 'db' } as any;

const job = (over: Record<string, unknown> = {}) =>
  ({
    agentId: 'agt_1',
    content: 'Собери новости и пришли дайджест',
    cronPattern: '0 9 * * *',
    id: 'cron_1',
    name: 'Дайджест',
    timezone: 'Europe/Moscow',
    ...over,
  }) as any;

describe('formatRunTime', () => {
  it('dd.MM HH:mm во времени пояса задачи', () => {
    const at = new Date('2026-10-19T09:05:00Z');
    expect(formatRunTime(at, 'Europe/Moscow')).toBe('19.10 12:05');
    expect(formatRunTime(at, 'Asia/Tokyo')).toBe('19.10 18:05');
    expect(formatRunTime(at, 'UTC')).toBe('19.10 09:05');
  });

  it('полночь — 00, а не 24; переход суток по поясу', () => {
    expect(formatRunTime(new Date('2026-10-18T21:00:00Z'), 'Europe/Moscow')).toBe('19.10 00:00');
  });

  it('неверный или пустой пояс — Москва, а не ошибка', () => {
    const at = new Date('2026-10-19T09:05:00Z');
    expect(formatRunTime(at, 'Mars/Phobos')).toBe('19.10 12:05');
    expect(formatRunTime(at, null)).toBe('19.10 12:05');
    expect(formatRunTime(at)).toBe('19.10 12:05');
  });
});

describe('buildRunTitle', () => {
  it('«имя · дата время»; без имени — «Задача»', () => {
    const at = new Date('2026-10-19T09:05:00Z');
    expect(buildRunTitle({ name: 'Дайджест', timezone: 'Europe/Moscow' }, at)).toBe(
      'Дайджест · 19.10 12:05',
    );
    expect(buildRunTitle({ name: '  ', timezone: 'Europe/Moscow' }, at)).toBe(
      'Задача · 19.10 12:05',
    );
    expect(buildRunTitle({ name: null, timezone: null }, at)).toBe('Задача · 19.10 12:05');
  });
});

describe('runCronJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCronRunCache();
    mockGetRedisClient.mockReturnValue(null);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-19T09:05:00Z'));
    mockExecAgent.mockResolvedValue({
      operationId: 'op_1',
      success: true,
      topicId: 'tpc_1',
    });
    mockUpdateStats.mockResolvedValue({});
    mockNotify.mockResolvedValue(true);
  });

  afterEach(() => {
    setCronStartingPollConfigForTests();
    vi.useRealTimers();
  });

  it('запускает execAgent без человека: триггер cron, headless, готовый заголовок и текст задачи', async () => {
    const result = await runCronJob(db, 'user-1', job(), 'run-1');

    expect(result).toEqual({ operationId: 'op_1', success: true, topicId: 'tpc_1' });
    expect(mockExecAgent).toHaveBeenCalledTimes(1);
    const params = mockExecAgent.mock.calls[0][0];
    expect(params).toMatchObject({
      agentId: 'agt_1',
      autoStart: true,
      cronJobId: 'cron_1',
      prompt: 'Собери новости и пришли дайджест',
      title: 'Дайджест · 19.10 12:05',
      trigger: 'cron',
      userInterventionConfig: { approvalMode: 'headless' },
    });
    expect(params.hooks).toHaveLength(1);
    expect(params.hooks[0]).toMatchObject({ type: 'onComplete' });
    expect(typeof params.hooks[0].handler).toBe('function');
    expect(params.hooks[0].webhook).toBeUndefined();
  });

  it('без модели в execAgent model и provider не передаются — работает модель помощника', async () => {
    await runCronJob(db, 'user-1', job(), 'run-1');

    const params = mockExecAgent.mock.calls[0][0];
    expect(params).not.toHaveProperty('model');
    expect(params).not.toHaveProperty('provider');
  });

  it('модель и провайдер запуска доходят до execAgent', async () => {
    await runCronJob(db, 'user-1', job(), 'run-1', {
      model: 'claude-opus-4-8',
      provider: 'anthropic',
    });

    expect(mockExecAgent.mock.calls[0][0]).toMatchObject({
      model: 'claude-opus-4-8',
      provider: 'anthropic',
      trigger: 'cron',
    });
  });

  it('после успешного старта обновляет счётчики задачи', async () => {
    await runCronJob(db, 'user-1', job(), 'run-1');

    expect(mockUpdateStats).toHaveBeenCalledWith(db, 'cron_1');
  });

  it('ошибка счётчиков не отменяет запуск', async () => {
    mockUpdateStats.mockRejectedValue(new Error('db down'));

    const result = await runCronJob(db, 'user-1', job(), 'run-1');

    expect(result.success).toBe(true);
  });

  it('execAgent вернул success:false — это уходит в ответ, счётчики не трогаются', async () => {
    mockExecAgent.mockResolvedValue({
      error: 'Queue is down',
      operationId: 'op_9',
      success: false,
      topicId: 'tpc_9',
    });

    const result = await runCronJob(db, 'user-1', job(), 'run-1');

    expect(result).toEqual({
      error: 'Queue is down',
      operationId: 'op_9',
      success: false,
      topicId: 'tpc_9',
    });
    expect(mockUpdateStats).not.toHaveBeenCalled();
  });

  it('execAgent бросил — success:false с текстом, без исключения наружу', async () => {
    mockExecAgent.mockRejectedValue(new Error('Agent not found: agt_1'));

    const result = await runCronJob(db, 'user-1', job(), 'run-1');

    expect(result).toEqual({
      error: 'Agent not found: agt_1',
      operationId: null,
      success: false,
      topicId: null,
    });
    expect(mockUpdateStats).not.toHaveBeenCalled();
  });

  describe('хук окончания', () => {
    const hookOf = async (runId = 'run-1') => {
      await runCronJob(db, 'user-1', job(), runId);
      return mockExecAgent.mock.calls.at(-1)![0].hooks[0] as {
        handler: (event: any) => Promise<void>;
      };
    };

    it('done → студии уходит статус done с идентификаторами запуска', async () => {
      const hook = await hookOf();

      await hook.handler({ operationId: 'op_1', reason: 'done', status: 'done', topicId: 'tpc_1' });

      expect(mockNotify).toHaveBeenCalledWith({
        cronJobId: 'cron_1',
        operationId: 'op_1',
        runId: 'run-1',
        status: 'done',
        topicId: 'tpc_1',
      });
    });

    it('error → статус error и текст ошибки', async () => {
      const hook = await hookOf();

      await hook.handler({
        errorMessage: 'Insufficient funds',
        operationId: 'op_1',
        reason: 'error',
        topicId: 'tpc_1',
      });

      expect(mockNotify).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'Insufficient funds', runId: 'run-1', status: 'error' }),
      );
    });

    it('interrupted и предел шагов → interrupted', async () => {
      const hook = await hookOf();

      await hook.handler({ operationId: 'op_1', reason: 'interrupted', topicId: 'tpc_1' });
      await hook.handler({ operationId: 'op_1', reason: 'max_steps', topicId: 'tpc_1' });

      expect(mockNotify).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ status: 'interrupted' }),
      );
      expect(mockNotify).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ error: 'Stopped: max_steps', status: 'interrupted' }),
      );
    });

    it('если событие не несёт переписку и операцию — берёт из результата execAgent', async () => {
      const hook = await hookOf();

      await hook.handler({ reason: 'done' });

      expect(mockNotify).toHaveBeenCalledWith(
        expect.objectContaining({ operationId: 'op_1', topicId: 'tpc_1' }),
      );
    });

    it('сбой доставки не бросает из хука', async () => {
      mockNotify.mockRejectedValue(new Error('studio down'));
      const hook = await hookOf();

      await expect(hook.handler({ operationId: 'op_1', reason: 'done' })).resolves.toBeUndefined();
    });
  });

  describe('повтор того же runId', () => {
    it('не запускает задачу второй раз и отдаёт прежний результат', async () => {
      const first = await runCronJob(db, 'user-1', job(), 'run-1');
      const second = await runCronJob(db, 'user-1', job(), 'run-1');

      expect(second).toEqual(first);
      expect(mockExecAgent).toHaveBeenCalledTimes(1);
      expect(mockUpdateStats).toHaveBeenCalledTimes(1);
    });

    it('параллельные одинаковые запросы тоже дают один запуск', async () => {
      const [a, b] = await Promise.all([
        runCronJob(db, 'user-1', job(), 'run-1'),
        runCronJob(db, 'user-1', job(), 'run-1'),
      ]);

      expect(a).toEqual(b);
      expect(mockExecAgent).toHaveBeenCalledTimes(1);
    });

    it('другой runId, другая задача и другой пользователь — отдельные запуски', async () => {
      await runCronJob(db, 'user-1', job(), 'run-1');
      await runCronJob(db, 'user-1', job(), 'run-2');
      await runCronJob(db, 'user-1', job({ id: 'cron_2' }), 'run-1');
      await runCronJob(db, 'user-2', job(), 'run-1');

      expect(mockExecAgent).toHaveBeenCalledTimes(4);
    });

    it('неудачный старт не запоминается: тот же runId можно повторить', async () => {
      mockExecAgent.mockResolvedValueOnce({
        error: 'Queue is down',
        operationId: 'op_9',
        success: false,
        topicId: 'tpc_9',
      });

      const failed = await runCronJob(db, 'user-1', job(), 'run-1');
      expect(failed.success).toBe(false);
      await Promise.resolve();

      const retried = await runCronJob(db, 'user-1', job(), 'run-1');
      expect(retried.success).toBe(true);
      expect(mockExecAgent).toHaveBeenCalledTimes(2);
    });

    it('через 15 минут запись забывается', async () => {
      await runCronJob(db, 'user-1', job(), 'run-1');
      vi.setSystemTime(new Date('2026-10-19T09:21:00Z'));
      await runCronJob(db, 'user-1', job(), 'run-1');

      expect(mockExecAgent).toHaveBeenCalledTimes(2);
    });
  });

  describe('getActiveCronSnapshot (zero-downtime drain)', () => {
    it('учитывает запуск от старта execAgent до onComplete-хука и очищает при ошибке или по TTL 45 мин', async () => {
      let resolveExec!: (value: any) => void;
      mockExecAgent.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveExec = resolve;
          }),
      );

      const runPromise = runCronJob(db, 'user-1', job(), 'run-drain-1');
      // Во время ожидания самого execAgent слот уже видит 1 активный запуск
      expect(getActiveCronSnapshot().activeCount).toBe(1);

      resolveExec({
        operationId: 'op_cron_live',
        success: true,
        topicId: 'tpc_cron_live',
      });
      await runPromise;

      expect(getActiveCronSnapshot()).toEqual({
        activeCount: 1,
        activeTopicIds: ['tpc_cron_live'],
      });

      const onCompleteHook = mockExecAgent.mock.calls[0][0].hooks[0];
      await onCompleteHook.handler({
        operationId: 'op_cron_live',
        reason: 'done',
        status: 'done',
        topicId: 'tpc_cron_live',
      });

      expect(getActiveCronSnapshot()).toEqual({
        activeCount: 0,
        activeTopicIds: [],
      });

      // Ошибка старта не оставляет висящих записей
      mockExecAgent.mockResolvedValueOnce({
        error: 'failed to start',
        operationId: 'op_fail',
        success: false,
        topicId: 'tpc_fail',
      });
      await runCronJob(db, 'user-1', job(), 'run-drain-fail');
      expect(getActiveCronSnapshot()).toEqual({ activeCount: 0, activeTopicIds: [] });

      // Страховочный TTL 45 минут сбрасывает зависшую запись
      mockExecAgent.mockResolvedValueOnce({
        operationId: 'op_stuck',
        success: true,
        topicId: 'tpc_stuck',
      });
      await runCronJob(db, 'user-1', job(), 'run-drain-stuck');
      expect(getActiveCronSnapshot().activeTopicIds).toEqual(['tpc_stuck']);

      vi.setSystemTime(new Date('2026-10-19T09:51:00Z')); // +46 минут
      expect(getActiveCronSnapshot()).toEqual({ activeCount: 0, activeTopicIds: [] });
    });

    it('P2 #16: удерживает activeCount=1 на всём протяжении notifyCronFinished и не удаляет живую операцию по возрасту 45м', async () => {
      let resolveNotify!: (ok: boolean) => void;
      mockNotify.mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            resolveNotify = resolve;
          }),
      );

      await runCronJob(db, 'user-1', job(), 'run-notify-hold');
      const hook = mockExecAgent.mock.calls[0][0].hooks[0];

      const hookPromise = hook.handler({
        operationId: 'op_1',
        reason: 'done',
        status: 'done',
        topicId: 'tpc_1',
      });

      // Пока notifyCronFinished ретраится (до 34 с), операция обязана числиться активной!
      await Promise.resolve();
      expect(getActiveCronSnapshot()).toEqual({
        activeCount: 1,
        activeTopicIds: ['tpc_1'],
      });

      // Даже если прошло >45 минут во время доставки уведомления, запись не удаляется
      vi.setSystemTime(new Date('2026-10-19T10:00:00Z'));
      await refreshActiveCronRuns();
      expect(getActiveCronSnapshot().activeCount).toBe(1);

      resolveNotify(true);
      await hookPromise;
      expect(getActiveCronSnapshot()).toEqual({ activeCount: 0, activeTopicIds: [] });

      // Долгая живая операция в AgentStateManager НЕ удаляется на 46-й минуте, пока не завершится
      const { inMemoryAgentStateManager } =
        await import('@/server/modules/AgentRuntime/InMemoryAgentStateManager');
      inMemoryAgentStateManager.clear();
      await inMemoryAgentStateManager.createOperationMetadata('op_long_live', { userId: 'user-1' });
      await inMemoryAgentStateManager.saveAgentState('op_long_live', {
        status: 'running',
        stepCount: 3,
      } as any);

      mockExecAgent.mockResolvedValueOnce({
        operationId: 'op_long_live',
        success: true,
        topicId: 'tpc_long_live',
      });
      await runCronJob(db, 'user-1', job(), 'run-long-live');
      vi.setSystemTime(new Date('2026-10-19T11:00:00Z')); // +60 минут
      await refreshActiveCronRuns();
      expect(getActiveCronSnapshot()).toEqual({
        activeCount: 1,
        activeTopicIds: ['tpc_long_live'],
      });

      // Как только статус в AgentStateManager стал терминальным — очистка по возрасту срабатывает
      await inMemoryAgentStateManager.saveAgentState('op_long_live', {
        status: 'done',
        stepCount: 4,
      } as any);
      await refreshActiveCronRuns();
      expect(getActiveCronSnapshot()).toEqual({ activeCount: 0, activeTopicIds: [] });
      inMemoryAgentStateManager.clear();
    });

    it('P2 #16: дедуплицирует runId между двумя слотами через Redis SET NX EX 900 и очищает ключ при ошибке старта', async () => {
      const store = new Map<string, string>();
      const fakeRedis = {
        del: vi.fn(async (key: string) => {
          store.delete(key);
          return 1;
        }),
        get: vi.fn(async (key: string) => store.get(key) ?? null),
        set: vi.fn(async (key: string, val: string, _ex?: string, _ttl?: number, nx?: string) => {
          if (nx === 'NX' && store.has(key)) return null;
          store.set(key, val);
          return 'OK';
        }),
      };
      mockGetRedisClient.mockReturnValue(fakeRedis);

      // Слот 1 запускает run-redis-1
      const slot1Res = await runCronJob(db, 'user-1', job(), 'run-redis-1');
      expect(slot1Res).toEqual({ operationId: 'op_1', success: true, topicId: 'tpc_1' });
      expect(fakeRedis.set).toHaveBeenCalledWith(
        'arckep:cron:run:run-redis-1',
        expect.any(String),
        'EX',
        900,
        'NX',
      );

      // Имитируем слот 2 (пустой локальный runCache, общий Redis!)
      clearCronRunCache();
      mockGetRedisClient.mockReturnValue(fakeRedis);

      const slot2Res = await runCronJob(db, 'user-1', job(), 'run-redis-1');
      expect(slot2Res).toEqual({ operationId: 'op_1', success: true, topicId: 'tpc_1' });
      expect(mockExecAgent).toHaveBeenCalledTimes(1); // НЕ запустил второй раз!

      // Неудачный старт удаляет ключ в Redis, чтобы повтор мог запуститься
      mockExecAgent.mockResolvedValueOnce({
        error: 'temp error',
        operationId: null,
        success: false,
        topicId: null,
      });
      const failRes = await runCronJob(db, 'user-1', job(), 'run-redis-fail');
      expect(failRes.success).toBe(false);
      expect(store.has('arckep:cron:run:run-redis-fail')).toBe(false);
    });

    it('#17: ждёт завершения starting (>500 мс) на другом слоте, перехватывает при падении первого слота, и возвращает httpStatus=503 при зависании >timeout (никогда не возвращает success:true с topicId:null!)', async () => {
      const store = new Map<string, string>();
      const fakeRedis = {
        del: vi.fn(async (key: string) => {
          store.delete(key);
          return 1;
        }),
        get: vi.fn(async (key: string) => store.get(key) ?? null),
        set: vi.fn(async (key: string, val: string, _ex?: string, _ttl?: number, nx?: string) => {
          if (nx === 'NX' && store.has(key)) return null;
          store.set(key, val);
          return 'OK';
        }),
      };
      mockGetRedisClient.mockReturnValue(fakeRedis);

      // 1. Первый слот держит status='starting' 650 мс (> старых 500 мс!), затем пишет started с настоящим topicId
      setCronStartingPollConfigForTests({ stepMs: 40, timeoutMs: 3_000 });
      store.set(
        'arckep:cron:run:run-slow-start',
        JSON.stringify({
          jobId: 'cron_1',
          operationId: null,
          status: 'starting',
          topicId: null,
          userId: 'user-1',
        }),
      );
      setTimeout(() => {
        store.set(
          'arckep:cron:run:run-slow-start',
          JSON.stringify({
            jobId: 'cron_1',
            operationId: 'op_slot1_ready',
            status: 'started',
            topicId: 'tpc_slot1_ready',
            userId: 'user-1',
          }),
        );
      }, 650);

      const joined = await runCronJob(db, 'user-1', job(), 'run-slow-start');
      expect(joined).toEqual({
        operationId: 'op_slot1_ready',
        success: true,
        topicId: 'tpc_slot1_ready',
      });
      expect(mockExecAgent).not.toHaveBeenCalled();

      // 2. Если первый слот упал во время 'starting' и очистил ключ — второй слот штатно запускает задачу!
      store.set(
        'arckep:cron:run:run-slot1-crashed',
        JSON.stringify({
          jobId: 'cron_1',
          operationId: null,
          status: 'starting',
          topicId: null,
          userId: 'user-1',
        }),
      );
      setTimeout(() => {
        store.delete('arckep:cron:run:run-slot1-crashed');
      }, 80);

      const reclaimed = await runCronJob(db, 'user-1', job(), 'run-slot1-crashed');
      expect(reclaimed).toEqual({
        operationId: 'op_1',
        success: true,
        topicId: 'tpc_1',
      });
      expect(mockExecAgent).toHaveBeenCalledTimes(1);

      // 3. Если ключ завис в 'starting' дольше таймаута — возвращает success:false + httpStatus:503 (НИКОГДА success:true, topicId:null!)
      setCronStartingPollConfigForTests({ stepMs: 25, timeoutMs: 120 });
      store.set(
        'arckep:cron:run:run-stuck-starting',
        JSON.stringify({
          jobId: 'cron_1',
          operationId: null,
          status: 'starting',
          topicId: null,
          userId: 'user-1',
        }),
      );

      const timedOut = await runCronJob(db, 'user-1', job(), 'run-stuck-starting');
      expect(timedOut.success).toBe(false);
      expect(timedOut.httpStatus).toBe(503);
      expect(timedOut.topicId).toBeNull();
      expect(mockExecAgent).toHaveBeenCalledTimes(1);
    });
  });
});
