import { describe, expect, it } from 'vitest';

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

  it('переполнение истории: события дальше идут подписчикам, история пуста и помечена усечённой', async () => {
    const hub = makeHub({ t: 1 }, 1000, 100);
    register(hub, 'op_1');
    const live: number[] = [];
    hub.attach('op_1', { onDone: () => undefined, onEvents: (events) => live.push(events.length) });
    await hub.publishStreamChunk('op_1', 0, { chunkType: 'text', content: 'x'.repeat(60) });
    await hub.publishStreamChunk('op_1', 0, { chunkType: 'text', content: 'y'.repeat(60) });
    const op = hub.get('op_1')!;
    expect(op.truncated).toBe(true);
    expect(op.events).toEqual([]);
    expect(live).toEqual([1, 1]);
    expect(
      hub.attach('op_1', { onDone: () => undefined, onEvents: () => undefined }).truncated,
    ).toBe(true);
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
});
