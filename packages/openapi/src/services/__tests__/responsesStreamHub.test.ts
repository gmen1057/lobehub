import { describe, expect, it, vi } from 'vitest';

import { ResponsesStreamHub } from '../responsesStreamHub';

/**
 * arckep (план chat-next-redesign, F8): реестр идущих ответов — история, живая подписка,
 * конец ответа, поиск по теме, чистка завершённых.
 */

const params = { input: 'привет', model: 'agt_1' } as any;

const makeHub = (now: { t: number }, finishedTtlMs = 1000, maxHistoryChars?: number) =>
  new ResponsesStreamHub({ finishedTtlMs, maxHistoryChars, now: () => now.t });

const register = (hub: ResponsesStreamHub, operationId: string, topicId = 'tpc_1', userId = 'u1') =>
  hub.register({ operationId, params, responseId: topicId, topicId, userId });

describe('ResponsesStreamHub (arckep F8)', () => {
  it('история накапливается, подписчик получает живые события и конец ответа', async () => {
    const now = { t: 1_000_000 };
    const hub = makeHub(now);
    register(hub, 'op_1');
    await hub.publishStreamChunk('op_1', 0, { chunkType: 'text', content: 'При' });

    const seen: string[] = [];
    let done = false;
    const attachment = hub.attach('op_1', {
      onDone: () => {
        done = true;
      },
      onEvents: (events) => seen.push(...events.map((e) => e.data.content)),
    });
    expect(attachment.done).toBe(false);
    expect(attachment.history.map((e) => e.data.content)).toEqual(['При']);

    await hub.publishStreamChunk('op_1', 0, { chunkType: 'text', content: 'вет' });
    expect(seen).toEqual(['вет']);

    hub.markDone('op_1', { status: 'done' } as any);
    expect(done).toBe(true);
    expect(hub.get('op_1')?.finalState).toEqual({ status: 'done' });
    // после конца подписок нет, история остаётся целиком
    const late = hub.attach('op_1', { onDone: () => undefined, onEvents: () => undefined });
    expect(late.done).toBe(true);
    expect(late.history).toHaveLength(2);
    expect(await hub.getActiveOperationsCount()).toBe(0);
  });

  it('отписка: события после неё не приходят; markDone второй раз ничего не делает', async () => {
    const hub = makeHub({ t: 1 });
    register(hub, 'op_1');
    let count = 0;
    let doneCalls = 0;
    const attachment = hub.attach('op_1', {
      onDone: () => {
        doneCalls += 1;
      },
      onEvents: () => {
        count += 1;
      },
    });
    await hub.publishStreamChunk('op_1', 0, { chunkType: 'text', content: 'a' });
    attachment.unsubscribe();
    await hub.publishStreamChunk('op_1', 0, { chunkType: 'text', content: 'b' });
    expect(count).toBe(1);
    hub.markDone('op_1');
    hub.markDone('op_1');
    expect(doneCalls).toBe(0);
  });

  it('поиск по теме: только свой пользователь, идущий ответ важнее завершённого, из равных — свежий', () => {
    const hub = makeHub({ t: 1 });
    register(hub, 'op_old', 'tpc_1');
    hub.markDone('op_old');
    register(hub, 'op_other', 'tpc_1', 'u2');
    register(hub, 'op_new', 'tpc_1');
    expect(hub.findByTopic('u1', 'tpc_1')?.operationId).toBe('op_new');
    expect(hub.findByTopic('u2', 'tpc_1')?.operationId).toBe('op_other');
    expect(hub.findByTopic('u3', 'tpc_1')).toBeUndefined();
    hub.markDone('op_new');
    expect(hub.findByTopic('u1', 'tpc_1')?.operationId).toBe('op_new');
    expect(hub.runningTopics('u1')).toEqual([]);
    expect(hub.runningTopics('u2')).toEqual(['tpc_1']);
  });

  it('завершённые ответы вычищаются через finishedTtlMs, идущие — никогда', () => {
    const now = { t: 10_000 };
    const hub = makeHub(now, 1000);
    register(hub, 'op_done');
    register(hub, 'op_live');
    hub.markDone('op_done');
    now.t += 999;
    expect(hub.prune()).toBe(0);
    now.t += 1;
    expect(hub.prune()).toBe(1);
    expect(hub.get('op_done')).toBeUndefined();
    expect(hub.get('op_live')).toBeDefined();
    // поиск по теме тоже чистит
    hub.markDone('op_live');
    now.t += 5000;
    expect(hub.findByTopic('u1', 'tpc_1')).toBeUndefined();
  });

  it('переполнение истории: события дальше идут подписчикам, история пуста и помечена усечённой, пишется одиночный warn', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const hub = makeHub({ t: 1 }, 1000, 100);
      register(hub, 'op_1');
      const live: number[] = [];
      hub.attach('op_1', {
        onDone: () => undefined,
        onEvents: (events) => live.push(events.length),
      });
      await hub.publishStreamChunk('op_1', 0, { chunkType: 'text', content: 'x'.repeat(60) });
      await hub.publishStreamChunk('op_1', 0, { chunkType: 'text', content: 'y'.repeat(60) });
      await hub.publishStreamChunk('op_1', 0, { chunkType: 'text', content: 'z'.repeat(60) });
      const op = hub.get('op_1')!;
      expect(op.truncated).toBe(true);
      expect(op.events).toEqual([]);
      expect(live).toEqual([1, 1, 1]);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith('[ResponsesStreamHub] history truncated', {
        bytes: expect.any(Number),
        operationId: 'op_1',
        topicId: 'tpc_1',
      });
      expect(
        hub.attach('op_1', { onDone: () => undefined, onEvents: () => undefined }).truncated,
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('1000+ чанков tools_calling одного шага заменяются на месте и не переполняют историю, живой подписчик получает каждый чанк', async () => {
    const hub = makeHub({ t: 1 });
    register(hub, 'op_tools');
    let liveChunks = 0;
    hub.attach('op_tools', {
      onDone: () => undefined,
      onEvents: (events) => {
        liveChunks += events.length;
      },
    });

    const chunkCount = 1100;
    let args = '{"code":"';
    const piece = 'a'.repeat(50); // 1100 * 50 = 55 КБ итоговых аргументов (суммарно >30 МБ без схлопывания)
    for (let i = 0; i < chunkCount; i++) {
      args += piece;
      await hub.publishStreamChunk('op_tools', 2, {
        chunkType: 'tools_calling',
        toolsCalling: [
          {
            apiName: 'executeCode',
            arguments: i === chunkCount - 1 ? `${args}"}` : args,
            id: 'call_big',
            identifier: 'lobe-cloud-sandbox',
            type: 'builtin',
          } as any,
        ],
      });
    }

    const op = hub.get('op_tools')!;
    expect(liveChunks).toBe(chunkCount);
    expect(op.truncated).toBe(false);
    expect(op.events).toHaveLength(1);
    expect(op.bytes).toBeGreaterThan(55_000);
    expect(op.bytes).toBeLessThan(100_000);
    expect(op.events[0].data.toolsCalling[0].arguments.length).toBe(args.length + 2);

    // Следующий шаг (другой stepIndex) не затирает предыдущий шаг
    await hub.publishStreamChunk('op_tools', 3, {
      chunkType: 'tools_calling',
      toolsCalling: [
        {
          apiName: 'executeCode',
          arguments: '{"code":"step3"}',
          id: 'call_step3',
          identifier: 'lobe-cloud-sandbox',
          type: 'builtin',
        } as any,
      ],
    });
    expect(op.events).toHaveLength(2);
  });

  it('события чужой операции (не зарегистрированной) не падают и не хранятся', async () => {
    const hub = makeHub({ t: 1 });
    const id = await hub.publishAgentRuntimeInit('op_unknown', { a: 1 });
    expect(id).toMatch(/^1-\d+$/);
    expect(await hub.getStreamHistory('op_unknown')).toEqual([]);
    await hub.cleanupOperation('op_unknown');
  });

  it('subscribeStreamEvents (общий интерфейс): история, живые события, конец', async () => {
    const hub = makeHub({ t: 1 });
    register(hub, 'op_1');
    await hub.publishStreamChunk('op_1', 0, { chunkType: 'text', content: 'a' });
    const got: string[] = [];
    const finished = hub.subscribeStreamEvents('op_1', '0', (events) =>
      got.push(...events.map((e) => e.data.content)),
    );
    await hub.publishStreamChunk('op_1', 0, { chunkType: 'text', content: 'b' });
    hub.markDone('op_1');
    await finished;
    expect(got).toEqual(['a', 'b']);
  });

  it('getDrainSnapshot и hasTopic корректно разделяют активные, удерживаемые в TTL и вычищенные темы', () => {
    const now = { t: 50_000 };
    const hub = makeHub(now, 1000);

    register(hub, 'op_active_1', 'tpc_active', 'u1');
    register(hub, 'op_active_2', 'tpc_active', 'u1'); // вторая операция в той же теме
    register(hub, 'op_done_recent', 'tpc_recent', 'u2');
    hub.markDone('op_done_recent');

    expect(hub.getDrainSnapshot()).toEqual({
      activeCount: 2,
      activeTopicIds: ['tpc_active'],
      retainedTopicIds: ['tpc_active', 'tpc_recent'],
    });

    expect(hub.hasTopic('tpc_active')).toBe(true);
    expect(hub.hasTopic('tpc_active', { activeOnly: true })).toBe(true);
    expect(hub.hasTopic('tpc_recent')).toBe(true);
    expect(hub.hasTopic('tpc_recent', { activeOnly: true })).toBe(false);
    expect(hub.hasTopic('tpc_unknown')).toBe(false);
    expect(hub.hasTopic('')).toBe(false);

    // Истечение FINISHED_TTL_MS убирает завершённую тему при чтении снимка и hasTopic
    now.t += 1001;
    expect(hub.hasTopic('tpc_recent')).toBe(false);
    expect(hub.getDrainSnapshot()).toEqual({
      activeCount: 2,
      activeTopicIds: ['tpc_active'],
      retainedTopicIds: ['tpc_active'],
    });

    hub.markDone('op_active_1');
    hub.markDone('op_active_2');
    expect(hub.getDrainSnapshot()).toEqual({
      activeCount: 0,
      activeTopicIds: [],
      retainedTopicIds: ['tpc_active'],
    });
    expect(hub.hasTopic('tpc_active', { activeOnly: true })).toBe(false);
    expect(hub.hasTopic('tpc_active')).toBe(true);
  });
});
