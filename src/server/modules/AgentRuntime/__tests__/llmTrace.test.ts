import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ModelRuntimeTraceModule from '@/server/modules/ModelRuntime/trace';

import { createEngineTraceCallbacks, withEngineTrace } from '../llmTrace';

// arckep (19.10.2026): трассировка Langfuse для серверного пути — без сети, TraceClient подменён.

const { shutdownAsync, traceFn, generationFn } = vi.hoisted(() => {
  const shutdownAsync = vi.fn().mockResolvedValue(undefined);
  const generationFn = vi.fn(() => ({ id: 'gen-1', update: vi.fn() }));
  const traceFn = vi.fn(() => ({ generation: generationFn, id: 'trace-1', update: vi.fn() }));
  return { generationFn, shutdownAsync, traceFn };
});

vi.mock('@/libs/traces', () => ({
  TraceClient: vi.fn().mockImplementation(() => ({
    createTrace: traceFn,
    shutdownAsync,
  })),
}));

// after() из next/server вне веб-запроса бросает; в серверном пути он вызываться не должен
const afterMock = vi.hoisted(() =>
  vi.fn(() => Promise.reject(new Error('after() outside request'))),
);
vi.mock('next/server', () => ({ after: afterMock }));

// модуль ModelRuntime тянет БД и провайдеров, для трассы нужен только createTraceOptions
vi.mock('@/server/modules/ModelRuntime', async () => {
  const actual = await vi.importActual<typeof ModelRuntimeTraceModule>(
    '@/server/modules/ModelRuntime/trace',
  );
  return { createTraceOptions: actual.createTraceOptions };
});

const payload = {
  messages: [
    { content: 'Ты помощник', role: 'system' },
    { content: 'Привет', role: 'user' },
  ],
  model: 'gpt-4',
  temperature: 0.5,
  tools: [{ function: { name: 'x' }, type: 'function' }],
} as any;

const context = { provider: 'openai', sessionId: 'agent-1', topicId: 'topic-1', userId: 'user-1' };

describe('createEngineTraceCallbacks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('при выключенном ENABLE_LANGFUSE трассы нет и клиент Langfuse не создаётся', () => {
    vi.stubEnv('ENABLE_LANGFUSE', '0');

    expect(createEngineTraceCallbacks(payload, context)).toBeUndefined();
    expect(traceFn).not.toHaveBeenCalled();
  });

  it('создаёт трассу «Engine Chat» с пользователем, темой, помощником и тегом чата', () => {
    vi.stubEnv('ENABLE_LANGFUSE', '1');

    const callbacks = createEngineTraceCallbacks(payload, context);

    expect(callbacks).toBeDefined();
    expect(traceFn).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Engine Chat',
        sessionId: 'topic-1',
        tags: ['Chat Competition'],
        userId: 'user-1',
      }),
    );
    expect(generationFn).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-4', name: 'Chat Completion (openai)' }),
    );
  });

  it('onFinal закрывает трассу без after(), не ждёт сброса и гасит его ошибку', async () => {
    vi.stubEnv('ENABLE_LANGFUSE', '1');
    shutdownAsync.mockRejectedValueOnce(new Error('langfuse недоступен'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const callbacks = createEngineTraceCallbacks(payload, context)!;
    // onFinal не возвращает обещание сброса: конец ответа не ждёт Langfuse
    expect(callbacks.onFinal?.({} as any)).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(shutdownAsync).toHaveBeenCalledTimes(1);
    expect(afterMock).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith('TraceClient shutdown error:', expect.any(Error));
    errorSpy.mockRestore();
  });

  it('если трассу начать не удалось (нет ключей), ответ не ломается', async () => {
    vi.stubEnv('ENABLE_LANGFUSE', '1');
    const { TraceClient } = await import('@/libs/traces');
    vi.mocked(TraceClient).mockImplementationOnce(() => {
      throw new TypeError('NO_LANGFUSE_KEY_ERROR');
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(createEngineTraceCallbacks(payload, context)).toBeUndefined();
    errorSpy.mockRestore();
  });
});

describe('withEngineTrace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('без трассы возвращает колбэки серверного пути как есть', () => {
    const callbacks = { onText: vi.fn() };

    expect(withEngineTrace(undefined, callbacks)).toBe(callbacks);
  });

  it('вызывает колбэки серверного пути как раньше и трассировочные — дополнительно, в этом порядке', async () => {
    const order: string[] = [];
    const server = {
      onCompletion: vi.fn(async () => void order.push('server:onCompletion')),
      onError: vi.fn(),
      onText: vi.fn(),
      onToolsCalling: vi.fn(async () => void order.push('server:onToolsCalling')),
    };
    const trace = {
      onCompletion: vi.fn(async () => void order.push('trace:onCompletion')),
      onFinal: vi.fn(async () => void order.push('trace:onFinal')),
      onStart: vi.fn(async () => void order.push('trace:onStart')),
      onToolsCalling: vi.fn(async () => void order.push('trace:onToolsCalling')),
    };

    const merged = withEngineTrace(trace as any, server as any);

    await merged.onStart?.();
    await merged.onToolsCalling?.({ toolsCalling: [] } as any);
    await merged.onCompletion?.({ text: 'ответ' } as any);
    await merged.onFinal?.({} as any);

    expect(order).toEqual([
      'trace:onStart',
      'server:onToolsCalling',
      'trace:onToolsCalling',
      'server:onCompletion',
      'trace:onCompletion',
      'trace:onFinal',
    ]);
    // аргументы доходят в обе стороны без изменений
    expect(server.onCompletion).toHaveBeenCalledWith({ text: 'ответ' });
    expect(trace.onCompletion).toHaveBeenCalledWith({ text: 'ответ' });
    // колбэки серверного пути, которых трасса не касается, остаются теми же функциями
    expect(merged.onText).toBe(server.onText);
    expect(merged.onError).toBe(server.onError);
  });

  it('ошибка трассировки не ломает ответ и не мешает остальным колбэкам', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const server = { onCompletion: vi.fn() };
    const trace = {
      onCompletion: vi.fn().mockRejectedValue(new Error('langfuse упал')),
      onFinal: vi.fn().mockImplementation(() => {
        throw new Error('и синхронно тоже');
      }),
    };

    const merged = withEngineTrace(trace as any, server as any);

    await expect(merged.onCompletion?.({ text: 'ok' } as any)).resolves.toBeUndefined();
    await expect(merged.onFinal?.({} as any)).resolves.toBeUndefined();
    expect(server.onCompletion).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('ошибка колбэка серверного пути уходит дальше как раньше, но трасса всё равно пишется', async () => {
    const server = { onCompletion: vi.fn().mockRejectedValue(new Error('сбой сохранения')) };
    const trace = { onCompletion: vi.fn() };

    const merged = withEngineTrace(trace as any, server as any);

    await expect(merged.onCompletion?.({ text: 'ok' } as any)).rejects.toThrow('сбой сохранения');
    expect(trace.onCompletion).toHaveBeenCalledTimes(1);
  });
});
