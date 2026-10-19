import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as FinishedModule from '../finished';
import { buildRunTitle, clearCronRunCache, formatRunTime, runCronJob } from '../run';

// arckep (19.10.2026, задачи помощника по расписанию): запуск задачи по просьбе студии.

const { mockExecAgent, mockNotify, mockUpdateStats } = vi.hoisted(() => ({
  mockExecAgent: vi.fn(),
  mockNotify: vi.fn(),
  mockUpdateStats: vi.fn(),
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
    expect(buildRunTitle({ name: '  ', timezone: 'Europe/Moscow' }, at)).toBe('Задача · 19.10 12:05');
    expect(buildRunTitle({ name: null, timezone: null }, at)).toBe('Задача · 19.10 12:05');
  });
});

describe('runCronJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCronRunCache();
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
});
