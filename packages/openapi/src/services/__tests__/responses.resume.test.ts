import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ResponsesService } from '../responses.service';
import { responsesStreamHub } from '../responsesStreamHub';

/**
 * arckep (план chat-next-redesign, F8): ответ идёт в общем реестре независимо от соединения;
 * второй клиент переподключается и получает историю с начала; состояние ответа по теме.
 */

const { mockExecAgent, mockExecuteSync, mockInterruptTopic } = vi.hoisted(() => ({
  mockExecAgent: vi.fn(),
  mockExecuteSync: vi.fn(),
  mockInterruptTopic: vi.fn(),
}));

vi.mock('@/server/modules/AgentRuntime/StreamEventManager', () => ({}));
vi.mock('@/server/services/agentRuntime', () => ({
  AgentRuntimeService: class {
    executeSync = mockExecuteSync;
    interruptTopicOperations = mockInterruptTopic;
  },
}));
vi.mock('@/server/services/aiAgent', () => ({
  AiAgentService: class {
    execAgent = mockExecAgent;
  },
}));
vi.mock('@/database/models/file', () => ({ FileModel: class {} }));
vi.mock('@/server/services/file', () => ({ FileService: class {} }));
vi.mock('../../common/base.service', () => ({
  BaseService: class {
    db: any;
    userId: string;
    constructor(db: any, userId: string) {
      this.db = db;
      this.userId = userId;
    }
    log() {}
  },
}));

const params = { input: 'привет', model: 'agt_1', stream: true } as any;
const OP = 'op_1_agt_1_tpc_1_x1';

/** Забрать из генератора ровно `n` событий (следующее может ждать живых событий). */
const take = async (gen: AsyncGenerator<any>, n: number) => {
  const out: any[] = [];
  for (let i = 0; i < n; i++) {
    const { value, done } = await gen.next();
    if (done) break;
    out.push(value);
  }
  return out;
};

const drain = async (gen: AsyncGenerator<any>) => {
  const out: any[] = [];
  for await (const event of gen) out.push(event);
  return out;
};

const text = (events: any[]) =>
  events
    .filter((e) => e.type === 'response.output_text.delta')
    .map((e) => e.delta)
    .join('');

describe('ResponsesService — ответ в реестре и переподключение (arckep F8)', () => {
  let finish!: (state: any) => void;

  beforeEach(() => {
    responsesStreamHub.clear();
    mockExecAgent.mockReset();
    mockExecuteSync.mockReset();
    mockExecAgent.mockResolvedValue({ operationId: OP, success: true, topicId: 'tpc_1' });
    mockExecuteSync.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
  });

  it('отправка: события из реестра, обрыв чтения ответ не останавливает, второй клиент дочитывает', async () => {
    const sender = new ResponsesService({} as any, 'u1');
    const abort = new AbortController();
    const gen = sender.createStreamingResponse(params, abort.signal);

    const head = await take(gen, 2);
    expect(head.map((e) => e.type)).toEqual(['response.created', 'response.in_progress']);
    expect(head[0].response.id).toBe('tpc_1');

    // следующее чтение регистрирует ответ и ждёт событий
    const pending = take(gen, 3);
    await vi.waitFor(() => expect(responsesStreamHub.get(OP)).toBeDefined());
    expect(mockExecuteSync).toHaveBeenCalledWith(OP);
    expect(sender.getResponseStatus('tpc_1')).toMatchObject({
      id: 'tpc_1',
      operation_id: OP,
      resumable: true,
      status: 'in_progress',
    });
    expect(sender.listRunningTopics()).toEqual(['tpc_1']);

    await responsesStreamHub.publishStreamChunk(OP, 0, { chunkType: 'text', content: 'При' });
    const first = await pending;
    expect(first.map((e) => e.type)).toEqual([
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
    ]);
    expect(first[2].delta).toBe('При');

    // клиент оборвал чтение: генератор выходит, ответ в реестре живёт
    abort.abort();
    expect((await gen.next()).done).toBe(true);
    expect(responsesStreamHub.get(OP)?.done).toBe(false);
    expect(responsesStreamHub.get(OP)?.subscribers.size).toBe(0);

    await responsesStreamHub.publishStreamChunk(OP, 0, { chunkType: 'text', content: 'вет' });

    // второй клиент (новый экземпляр сервиса того же человека) получает историю с начала и живой хвост
    const reader = new ResponsesService({} as any, 'u1');
    const resumed = reader.resumeStreamingResponse('tpc_1');
    const replay = await take(resumed, 6);
    expect(replay.map((e) => e.type)).toEqual([
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.delta',
    ]);
    expect(replay[0].response.id).toBe('tpc_1');
    expect(text(replay)).toBe('Привет');

    const tail = drain(resumed);
    await responsesStreamHub.publishStreamChunk(OP, 0, { chunkType: 'text', content: '!' });
    finish({
      messages: [{ content: 'Привет!', role: 'assistant' }],
      status: 'done',
      usage: { totalInputTokens: 3, totalOutputTokens: 2, totalTokens: 5 },
    });
    const rest = await tail;
    expect(text(rest)).toBe('!');
    const completed = rest.at(-1);
    expect(completed.type).toBe('response.completed');
    expect(completed.response.status).toBe('completed');
    expect(completed.response.output_text).toBe('Привет!');

    expect(reader.getResponseStatus('tpc_1')).toMatchObject({ status: 'completed' });
    expect(reader.listRunningTopics()).toEqual([]);
  });

  it('переподключение к завершённому ответу отдаёт всё сразу; чужая тема и пустой реестр — 404', async () => {
    const sender = new ResponsesService({} as any, 'u1');
    const gen = sender.createStreamingResponse(params);
    await take(gen, 2);
    const pending = take(gen, 3);
    await vi.waitFor(() => expect(responsesStreamHub.get(OP)).toBeDefined());
    await responsesStreamHub.publishStreamChunk(OP, 0, { chunkType: 'text', content: 'Готово' });
    await pending;
    finish({ messages: [{ content: 'Готово', role: 'assistant' }], status: 'done' });
    await drain(gen);

    const again = await drain(
      new ResponsesService({} as any, 'u1').resumeStreamingResponse('tpc_1'),
    );
    expect(text(again)).toBe('Готово');
    expect(again.at(-1).type).toBe('response.completed');

    const stranger = new ResponsesService({} as any, 'u2');
    await expect(drain(stranger.resumeStreamingResponse('tpc_1'))).rejects.toMatchObject({
      name: 'NotFoundError',
    });
    expect(stranger.getResponseStatus('tpc_1')).toBeNull();
    await expect(drain(sender.resumeStreamingResponse('tpc_none'))).rejects.toMatchObject({
      name: 'NotFoundError',
    });
  });

  it('ошибка выполнения: ответ помечается упавшим, клиент получает response.completed со status failed', async () => {
    const sender = new ResponsesService({} as any, 'u1');
    const gen = sender.createStreamingResponse(params);
    await take(gen, 2);
    const pending = drain(gen);
    await vi.waitFor(() => expect(responsesStreamHub.get(OP)).toBeDefined());
    finish({ error: { message: 'биллинг отказал' }, messages: [], status: 'error' });
    const events = await pending;
    const last = events.at(-1);
    expect(last.type).toBe('response.completed');
    expect(last.response.status).toBe('failed');
    expect(last.response.error.message).toBe('биллинг отказал');
    expect(sender.getResponseStatus('tpc_1')).toMatchObject({ status: 'failed' });
  });
});
