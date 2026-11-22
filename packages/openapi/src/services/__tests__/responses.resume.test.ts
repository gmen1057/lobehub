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

  it('passes the Studio origin into execution and keeps the quota reset in the replay', async () => {
    const sender = new ResponsesService({} as any, 'u1');
    const pending = drain(sender.createStreamingResponse(params, undefined, true));
    await vi.waitFor(() => expect(responsesStreamHub.get(OP)).toBeDefined());
    expect(mockExecAgent).toHaveBeenCalledWith(expect.objectContaining({ studioWebChat: true }));

    const body = { code: 'studio_chat_hourly_limit', reset_at: 1_800_000_000, status: 429 };
    finish({
      error: { body, message: 'Details from the underlying failure', type: 429 },
      messages: [],
      status: 'error',
    });
    const events = await pending;
    expect(events.at(-1).response).toMatchObject({
      error: { ...body, message: 'Hourly chat request limit reached.' },
      status: 'failed',
    });
    const replay = await drain(sender.resumeStreamingResponse('tpc_1'));
    expect(replay.at(-1).response.error).toEqual(events.at(-1).response.error);
  });

  it.each([402, 404, 429, 504])(
    'ошибка HTTP %s сохраняет причину при отправке и переподключении',
    async (status) => {
      const sender = new ResponsesService({} as any, 'u1');
      const gen = sender.createStreamingResponse(params);
      await take(gen, 2);
      const pending = drain(gen);
      await vi.waitFor(() => expect(responsesStreamHub.get(OP)).toBeDefined());
      finish({
        error: { body: { status }, message: 'Model request failed', type: status },
        messages: [],
        status: 'error',
      });
      const events = await pending;
      const last = events.at(-1);
      expect(last.type).toBe('response.completed');
      expect(last.response.status).toBe('failed');
      expect(last.response.error).toEqual({
        code: 'model_error',
        message: 'Model request failed',
        status,
      });
      expect(sender.getResponseStatus('tpc_1')).toMatchObject({ status: 'failed' });
      const replay = await drain(
        new ResponsesService({} as any, 'u1').resumeStreamingResponse('tpc_1'),
      );
      expect(replay.at(-1).response.error).toEqual(last.response.error);
    },
  );

  it.each([
    {
      code: 'provider_credits_exhausted',
      message: 'Сейчас эта модель временно недоступна. Мы уже в процессе её восстановления.',
      status: 503,
    },
    {
      code: 'context_length_exceeded',
      message: 'Текст слишком длинный для этой модели. Сократите сообщение или начните новый чат.',
      status: 413,
    },
    { code: 'studio_insufficient_balance', message: 'Insufficient balance', status: 402 },
    {
      code: 'provider_moderation',
      message: 'Фильтр безопасности модели отклонил запрос. Измените описание или вложение.',
      status: 400,
    },
  ])('preserves $code for HTTP responses, streamed responses and replay', async (expected) => {
    const sender = new ResponsesService({} as any, 'u1');
    const finalState = {
      error: {
        body: { code: expected.code, status: expected.status },
        message: expected.message,
        type: expected.status,
      },
      messages: [],
      status: 'error',
    };
    mockExecuteSync.mockResolvedValue(finalState);
    expect((await sender.createResponse({ ...params, stream: false })).error).toEqual(expected);
    const live = await drain(sender.createStreamingResponse(params));
    expect(live.at(-1).response.error).toEqual(expected);
    const replay = await drain(sender.resumeStreamingResponse('tpc_1'));
    expect(replay.at(-1).response.error).toEqual(expected);
  });

  it('does not certify the historical ambiguous wallet record on a response or replay', async () => {
    const sender = new ResponsesService({} as any, 'u1');
    mockExecuteSync.mockResolvedValue({
      error: {
        body: { code: 'INSUFFICIENT_BALANCE', status: 402 },
        message: 'Insufficient balance',
        type: 402,
      },
      messages: [],
      status: 'error',
    });
    expect((await sender.createResponse({ ...params, stream: false })).error).toBeNull();
    const expected = { code: 'model_error', message: 'Insufficient balance', status: 402 };
    const live = await drain(sender.createStreamingResponse(params));
    expect(live.at(-1).response.error).toEqual(expected);
    const replay = await drain(sender.resumeStreamingResponse('tpc_1'));
    expect(replay.at(-1).response.error).toEqual(expected);
  });

  it('1000+ чанков tools_calling до >50 КБ не усекают историю и при resumeStreamingResponse отдают полный вызов инструмента', async () => {
    const sender = new ResponsesService({} as any, 'u1');
    const abortSender = new AbortController();
    const gen = sender.createStreamingResponse(params, abortSender.signal);
    await take(gen, 2);
    const firstPending = take(gen, 2);
    await vi.waitFor(() => expect(responsesStreamHub.get(OP)).toBeDefined());

    let codeBody = '';
    const piece = 'x'.repeat(50);
    for (let i = 0; i < 1050; i++) {
      codeBody += piece;
      await responsesStreamHub.publishStreamChunk(OP, 1, {
        chunkType: 'tools_calling',
        toolsCalling: [
          {
            apiName: 'executeCode',
            arguments: `{"code":"${codeBody}`,
            id: 'call_1',
            identifier: 'lobe-cloud-sandbox',
            type: 'builtin',
          } as any,
        ],
      });
      if (i === 0) {
        await firstPending;
        abortSender.abort();
        await gen.next();
      }
    }

    expect(codeBody.length).toBe(52_500);
    expect(responsesStreamHub.get(OP)?.truncated).toBe(false);
    expect(sender.getResponseStatus('tpc_1')).toMatchObject({
      resumable: true,
      status: 'in_progress',
    });

    const reader = new ResponsesService({} as any, 'u1');
    const resumed = reader.resumeStreamingResponse('tpc_1');
    const replay = await take(resumed, 4);
    expect(replay.map((e) => e.type)).toEqual([
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.function_call_arguments.delta',
    ]);
    expect(replay[3].delta).toBe(`{"code":"${codeBody}`);

    const tailPromise = drain(resumed);
    const fullArgs = `{"code":"${codeBody}"}`;
    await responsesStreamHub.publishStreamChunk(OP, 1, {
      chunkType: 'tools_calling',
      toolsCalling: [
        {
          apiName: 'executeCode',
          arguments: fullArgs,
          id: 'call_1',
          identifier: 'lobe-cloud-sandbox',
          type: 'builtin',
        } as any,
      ],
    });
    await responsesStreamHub.publishStreamEvent(OP, {
      data: {
        isSuccess: true,
        payload: { toolCalling: { id: 'call_1' } },
        result: { content: 'ok' },
      },
      stepIndex: 1,
      type: 'tool_end',
    });
    finish({
      messages: [
        {
          content: '',
          role: 'assistant',
          tool_calls: [
            {
              function: {
                arguments: fullArgs,
                name: 'lobe-cloud-sandbox____executeCode____builtin',
              },
              id: 'call_1',
              type: 'function',
            },
          ],
        },
        { content: 'ok', role: 'tool', tool_call_id: 'call_1' },
        { content: 'Готово', role: 'assistant' },
      ],
      status: 'done',
    });

    const tail = await tailPromise;
    const argsDone = tail.find((e) => e.type === 'response.function_call_arguments.done');
    expect(argsDone?.arguments).toBe(fullArgs);
    const completed = tail.at(-1);
    expect(completed.type).toBe('response.completed');
    expect(completed.response.output_text).toBe('Готово');
    const fcItem = completed.response.output.find((o: any) => o.type === 'function_call');
    expect(fcItem).toMatchObject({
      arguments: fullArgs,
      call_id: 'call_1',
      name: 'lobe-cloud-sandbox/executeCode',
    });
  });

  it('waitStreamingResponse (mode=wait) ждёт завершения даже при op.truncated === true и чисто отписывается по AbortSignal', async () => {
    const sender = new ResponsesService({} as any, 'u1');
    const abortSender = new AbortController();
    const gen = sender.createStreamingResponse(params, abortSender.signal);
    await take(gen, 2);
    const pendingInit = take(gen, 3);
    await vi.waitFor(() => expect(responsesStreamHub.get(OP)).toBeDefined());
    await responsesStreamHub.publishStreamChunk(OP, 0, { chunkType: 'text', content: 'старт' });
    await pendingInit;
    abortSender.abort();
    await gen.next();

    // Имитируем переполнение истории длинного ответа
    const op = responsesStreamHub.get(OP)!;
    op.truncated = true;
    op.events = [];
    expect(sender.getResponseStatus('tpc_1')).toMatchObject({
      resumable: false,
      status: 'in_progress',
    });
    await expect(drain(sender.resumeStreamingResponse('tpc_1'))).rejects.toMatchObject({
      name: 'NotFoundError',
    });

    // Первый ожидающий подключается и отменяет чтение по AbortSignal — отписка происходит сразу
    const abortWaiter1 = new AbortController();
    const waiter1 = new ResponsesService({} as any, 'u1').waitStreamingResponse(
      'tpc_1',
      abortWaiter1.signal,
    );
    const head1 = await take(waiter1, 2);
    expect(head1.map((e) => e.type)).toEqual(['response.created', 'response.in_progress']);
    const next1 = waiter1.next();
    await vi.waitFor(() => expect(op.subscribers.size).toBe(1));
    abortWaiter1.abort();
    expect((await next1).done).toBe(true);
    expect(op.subscribers.size).toBe(0);
    expect(op.done).toBe(false);

    // Второй ожидающий дожидается финала без промежуточных дельт
    const waiter2 = new ResponsesService({} as any, 'u1').waitStreamingResponse('tpc_1');
    const head2 = await take(waiter2, 2);
    expect(head2.map((e) => e.type)).toEqual(['response.created', 'response.in_progress']);
    const finalPromise = drain(waiter2);
    await vi.waitFor(() => expect(op.subscribers.size).toBe(1));

    await responsesStreamHub.publishStreamChunk(OP, 0, {
      chunkType: 'text',
      content: 'промежуточный кусок',
    });
    finish({
      messages: [{ content: 'Полный ответ после усечения', role: 'assistant' }],
      status: 'done',
      usage: { llm: { tokens: { input: 10, output: 20, total: 30 } } },
    });

    const tail2 = await finalPromise;
    expect(tail2).toHaveLength(1);
    expect(tail2[0].type).toBe('response.completed');
    expect(tail2[0].response).toMatchObject({
      id: 'tpc_1',
      output_text: 'Полный ответ после усечения',
      status: 'completed',
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        total_tokens: 30,
      },
    });
  });

  it('параллельный запуск ответа в той же теме при !op.done отклоняется ConflictError до второго execAgent', async () => {
    const sender = new ResponsesService({} as any, 'u1');
    const gen = sender.createStreamingResponse(params);
    await take(gen, 2);
    const pending = take(gen, 3);
    await vi.waitFor(() => expect(responsesStreamHub.get(OP)).toBeDefined());
    expect(mockExecAgent).toHaveBeenCalledTimes(1);

    const duplicate = new ResponsesService({} as any, 'u1');
    await expect(
      duplicate.createResponse({
        input: 'второе сообщение подряд',
        model: 'agt_1',
        previous_response_id: 'tpc_1',
      } as any),
    ).rejects.toMatchObject({ name: 'ConflictError' });

    await expect(
      drain(
        duplicate.createStreamingResponse({
          input: 'второе потоковое сообщение',
          model: 'agt_1',
          previous_response_id: 'tpc_1',
          stream: true,
        } as any),
      ),
    ).rejects.toMatchObject({ name: 'ConflictError' });

    expect(mockExecAgent).toHaveBeenCalledTimes(1);

    // Завершаем первый ответ — после этого следующий запрос в тему разрешён
    await responsesStreamHub.publishStreamChunk(OP, 0, { chunkType: 'text', content: 'ок' });
    await pending;
    finish({ messages: [{ content: 'ок', role: 'assistant' }], status: 'done' });
    await drain(gen);

    mockExecAgent.mockResolvedValueOnce({
      operationId: 'op_2',
      success: true,
      topicId: 'tpc_1',
    });
    mockExecuteSync.mockResolvedValueOnce({
      messages: [{ content: 'второй ок', role: 'assistant' }],
      status: 'done',
    });
    const afterDone = await duplicate.createResponse({
      input: 'теперь можно',
      model: 'agt_1',
      previous_response_id: 'tpc_1',
    } as any);
    expect(afterDone.status).toBe('completed');
    expect(mockExecAgent).toHaveBeenCalledTimes(2);
  });
});

it('emits native grounding and clears already accumulated partial text on terminal refusal, including replay', async () => {
  responsesStreamHub.clear();
  const metadata = { finish_reason: 'content_filter', annotations: [], server_tool_calls: [] };
  mockExecAgent.mockResolvedValue({ operationId: OP, success: true, topicId: 'tpc_1' });
  mockExecuteSync.mockImplementation(async () => {
    await responsesStreamHub.publishStreamChunk(OP, 0, {
      chunkType: 'text',
      content: 'unsafe partial',
    });
    await responsesStreamHub.publishStreamChunk(OP, 0, {
      chunkType: 'grounding',
      grounding: { citations: [], deepseek: metadata },
    });
    await responsesStreamHub.publishStreamChunk(OP, 0, { chunkType: 'text', content: 'refusal' });
    return {
      messages: [{ role: 'assistant', content: 'refusal', search: { deepseek: metadata } }],
      status: 'done',
    };
  });
  const service = new ResponsesService({} as any, 'u1');
  const events = await drain(service.createStreamingResponse(params));
  const grounding = events.find((event) => event.type === 'response.grounding');
  expect(grounding.grounding).toEqual({ citations: [], deepseek: metadata });
  expect(events.find((event) => event.type === 'response.output_text.done').text).toBe('refusal');
  expect(events.at(-1).response.output_text).toBe('refusal');
  expect(JSON.stringify(events.at(-1))).not.toContain('unsafe partial');
  const replay = await drain(service.resumeStreamingResponse('tpc_1'));
  expect(
    replay.find((event) => event.type === 'response.grounding').grounding.deepseek.finish_reason,
  ).toBe('content_filter');
  expect(replay.at(-1).response.output_text).toBe('refusal');
});

it('resets accumulatedText on stream_retry with resetText=true so repair retry never concatenates discarded Step 1 intro', async () => {
  responsesStreamHub.clear();
  mockExecAgent.mockResolvedValue({ operationId: OP, success: true, topicId: 'tpc_1' });
  mockExecuteSync.mockImplementation(async () => {
    await responsesStreamHub.publishStreamChunk(OP, 0, {
      chunkType: 'text',
      content: 'Вот часть 2 (черновик):\n',
    });
    await responsesStreamHub.publishStreamEvent(OP, {
      data: { reason: 'code_artifact_repair', resetText: true },
      stepIndex: 0,
      type: 'stream_retry',
    });
    await responsesStreamHub.publishStreamChunk(OP, 1, {
      chunkType: 'text',
      content: 'Чистый финальный ответ с кодом.',
    });
    return {
      messages: [
        { content: 'Write code', role: 'user' },
        {
          content: 'Вот часть 2 (черновик):\n[omitted invalid empty file reference tag]',
          metadata: { internalRepairAttempt: true },
          role: 'assistant',
        },
        { content: 'Repeat with fenced code', role: 'user' },
        { content: 'Чистый финальный ответ с кодом.', role: 'assistant' },
      ],
      status: 'done',
    };
  });

  const service = new ResponsesService({} as any, 'u1');
  const events = await drain(service.createStreamingResponse(params));

  const textDone = events.find((e) => e.type === 'response.output_text.done');
  const partDone = events.find((e) => e.type === 'response.content_part.done');
  const itemDone = events.find((e) => e.type === 'response.output_item.done');
  const completed = events.at(-1);

  expect(textDone.text).toBe('Чистый финальный ответ с кодом.');
  expect(partDone.part.text).toBe('Чистый финальный ответ с кодом.');
  expect(itemDone.item.content[0].text).toBe('Чистый финальный ответ с кодом.');
  expect(completed.response.output_text).toBe('Чистый финальный ответ с кодом.');
  expect(JSON.stringify(completed)).not.toContain('черновик');
  expect(JSON.stringify(completed)).not.toContain('omitted invalid');
});
