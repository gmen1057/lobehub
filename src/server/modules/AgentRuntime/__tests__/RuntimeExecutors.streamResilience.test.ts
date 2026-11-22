// @vitest-environment node
import type { AgentState } from '@lobechat/agent-runtime';
import { AgentRuntime } from '@lobechat/agent-runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InMemoryAgentStateManager } from '@/server/modules/AgentRuntime/InMemoryAgentStateManager';
import { InMemoryStreamEventManager } from '@/server/modules/AgentRuntime/InMemoryStreamEventManager';
import { initModelRuntimeFromDB } from '@/server/modules/ModelRuntime';
import { AgentRuntimeService } from '@/server/services/agentRuntime/AgentRuntimeService';

import { LobeGoogleAI } from '../../../../../packages/model-runtime/src/providers/google';
import { classifyLLMError } from '../llmErrorClassification';
import { formatPersistedLLMError, getFailedLLMPartialResult } from '../persistedLLMError';
import type { RuntimeExecutorContext } from '../RuntimeExecutors';
import { createRuntimeExecutors, LONG_LLM_ATTEMPT_NO_RETRY_MS } from '../RuntimeExecutors';

vi.mock('@/server/modules/ModelRuntime', () => ({ initModelRuntimeFromDB: vi.fn() }));
vi.mock('@/server/modules/Mecha/ContextEngineering', () => ({
  serverMessagesEngine: vi.fn(async ({ messages }: any) => messages),
}));
vi.mock('@/server/services/message', () => ({ MessageService: vi.fn() }));
vi.mock('@/server/services/file', () => ({ FileService: vi.fn() }));
vi.mock('@/server/services/agentDocuments', () => ({ AgentDocumentsService: vi.fn() }));
vi.mock('../arckepSearch', () => ({ resolveServerEnabledSearch: vi.fn(async () => false) }));
vi.mock('../serverModelParams', () => ({ resolveServerModelParams: vi.fn(async () => ({})) }));
vi.mock('../llmTrace', () => ({
  createEngineTraceCallbacks: vi.fn(),
  withEngineTrace: (_trace: unknown, callbacks: unknown) => callbacks,
}));
vi.mock('@lobechat/model-runtime', async () => ({
  consumeStreamUntilDone: (
    await import('../../../../../packages/model-runtime/src/utils/consumeStream')
  ).consumeStreamUntilDone,
}));

const instruction = {
  payload: {
    messages: [{ content: 'Explain stream resilience', role: 'user' as const }],
    model: 'gemini-3-pro',
    provider: 'google',
    tools: [],
  },
  type: 'call_llm' as const,
};

const initialState = (): AgentState =>
  AgentRuntime.createInitialState({
    messages: [{ content: 'Explain stream resilience', role: 'user' }],
    metadata: { agentId: 'agent_1', topicId: 'tpc_rel2a' },
    modelRuntimeConfig: { model: 'gemini-3-pro', provider: 'google' },
    operationId: 'op_1_agent_1_tpc_rel2a_abcd1234',
    status: 'running',
  });

describe('REL-2A: PR #19 money invariants & ProviderStreamInterrupted persistence', () => {
  let ctx: RuntimeExecutorContext;

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    ctx = {
      loadAgentState: vi.fn(async () => initialState()),
      messageModel: {
        create: vi.fn(async () => ({ id: 'msg_asst_1' })),
        query: vi.fn(async () => []),
        update: vi.fn(async () => ({ success: true })),
      } as unknown as RuntimeExecutorContext['messageModel'],
      operationId: 'op_1_agent_1_tpc_rel2a_abcd1234',
      serverDB: undefined as unknown as RuntimeExecutorContext['serverDB'],
      stepIndex: 0,
      streamManager: {
        publishStreamChunk: vi.fn(),
        publishStreamEvent: vi.fn(),
      } as unknown as RuntimeExecutorContext['streamManager'],
      toolExecutionService: {
        executeTool: vi.fn(),
      } as unknown as RuntimeExecutorContext['toolExecutionService'],
      userId: 'user_1',
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('classifies socket drop errors as ProviderStreamInterrupted (502, never HTTP_500) and respects retrySafe=false', () => {
    const drop = new TypeError('terminated', {
      cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
    });
    expect(classifyLLMError(drop)).toMatchObject({
      code: 'ProviderStreamInterrupted',
      kind: 'retry',
      type: 'ProviderStreamInterrupted',
    });
    expect(formatPersistedLLMError(drop)).toEqual({
      body: { code: 'ProviderStreamInterrupted', status: 502 },
      message: 'Соединение с моделью прервалось во время ответа. Попробуйте ещё раз.',
      type: 502,
    });

    const nonReplayableDrop = {
      body: { details: [{ retrySafe: false }] },
      code: 'ECONNRESET',
      message: 'incomplete chunked read',
    };
    expect(classifyLLMError(nonReplayableDrop)).toMatchObject({
      code: 'ProviderStreamInterrupted',
      kind: 'stop',
      retrySafe: false,
    });
  });

  it('(1) mid-stream ECONNRESET after 1 chunk of text -> 1 fetch call (0 retries), partial text & usage preserved, ProviderStreamInterrupted saved', async () => {
    const encoder = new TextEncoder();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      let step = 0;
      return new Response(
        new ReadableStream({
          pull(controller) {
            if (step === 0) {
              step += 1;
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    candidates: [
                      {
                        content: { parts: [{ text: 'Оплаченное начало ответа' }], role: 'model' },
                        index: 0,
                      },
                    ],
                    usageMetadata: {
                      candidatesTokenCount: 6,
                      promptTokenCount: 20,
                      totalTokenCount: 26,
                    },
                  })}\n\n`,
                ),
              );
              return;
            }
            controller.error(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    });

    const google = new LobeGoogleAI({ apiKey: 'test', baseURL: 'http://proxy.test' });
    vi.mocked(initModelRuntimeFromDB).mockResolvedValue({
      chat: google.chat.bind(google),
    } as any);

    let caughtError: unknown;
    try {
      await createRuntimeExecutors(ctx).call_llm!(instruction, initialState());
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeDefined();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(ctx.streamManager.publishStreamEvent).mock.calls.map(([, e]) => e.type),
    ).not.toContain('stream_retry');

    // Partial output persisted first, then ProviderStreamInterrupted error persisted without wiping content
    expect(ctx.messageModel.update).toHaveBeenNthCalledWith(
      1,
      'msg_asst_1',
      expect.objectContaining({
        content: 'Оплаченное начало ответа',
        metadata: expect.objectContaining({
          finishReason: 'error',
          totalTokens: 26,
          usageReported: true,
        }),
      }),
    );
    expect(ctx.messageModel.update).toHaveBeenNthCalledWith(2, 'msg_asst_1', {
      error: {
        body: { code: 'ProviderStreamInterrupted', status: 502 },
        message: 'Соединение с моделью прервалось во время ответа. Попробуйте ещё раз.',
        type: 502,
      },
    });

    expect(getFailedLLMPartialResult(caughtError)).toMatchObject({
      content: 'Оплаченное начало ответа',
      usage: expect.objectContaining({ totalTokens: 26 }),
    });
  });

  it('(2) ECONNRESET at 65s with 0 chunks -> 1 fetch call (0 retries)', async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              setTimeout(() => {
                controller.error(
                  Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
                );
              }, LONG_LLM_ATTEMPT_NO_RETRY_MS + 5000);
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    );

    const google = new LobeGoogleAI({ apiKey: 'test', baseURL: 'http://proxy.test' });
    vi.mocked(initModelRuntimeFromDB).mockResolvedValue({
      chat: google.chat.bind(google),
    } as any);

    const callPromise = createRuntimeExecutors(ctx).call_llm!(instruction, initialState());
    const assertion = expect(callPromise).rejects.toThrow(/ECONNRESET/);
    await vi.advanceTimersByTimeAsync(LONG_LLM_ATTEMPT_NO_RETRY_MS + 6000);
    await assertion;

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(ctx.streamManager.publishStreamEvent).mock.calls.map(([, e]) => e.type),
    ).not.toContain('stream_retry');
  });

  it('(3) instant ECONNRESET at 1s before first chunk with retrySafe !== false -> 1 safe retry succeeds', async () => {
    vi.useFakeTimers();
    const encoder = new TextEncoder();
    let callCount = 0;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1) {
        return new Response(
          new ReadableStream({
            start(controller) {
              setTimeout(() => {
                controller.error(
                  Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
                );
              }, 1000);
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      }
      return new Response(
        encoder.encode(
          `data: ${JSON.stringify({
            candidates: [
              {
                content: { parts: [{ text: 'Успешный ответ со второй попытки' }], role: 'model' },
                finishReason: 'STOP',
                index: 0,
              },
            ],
            usageMetadata: { candidatesTokenCount: 5, promptTokenCount: 10, totalTokenCount: 15 },
          })}\n\n`,
        ),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    });

    const google = new LobeGoogleAI({ apiKey: 'test', baseURL: 'http://proxy.test' });
    vi.mocked(initModelRuntimeFromDB).mockResolvedValue({
      chat: google.chat.bind(google),
    } as any);

    const resultPromise = createRuntimeExecutors(ctx).call_llm!(instruction, initialState());
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result.newState.messages.at(-1)).toMatchObject({
      content: 'Успешный ответ со второй попытки',
      role: 'assistant',
    });
  });

  it('preserves paid partial output and token accounting on AgentState in AgentRuntimeService.executeStep when mid-stream drop occurs', async () => {
    const stateManager = new InMemoryAgentStateManager();
    const streamEventManager = new InMemoryStreamEventManager();
    const service = new AgentRuntimeService(undefined as any, 'user_1', {
      coordinatorOptions: { stateManager, streamEventManager },
      queueService: null,
      streamEventManager,
    });
    (service as any).messageModel = ctx.messageModel;

    const opId = 'op_1_agent_1_tpc_rel2a_stepstate';
    await service.createOperation({
      agentConfig: { model: 'gpt-5.4', provider: 'openai' },
      appContext: { agentId: 'agent_1', topicId: 'tpc_rel2a' },
      autoStart: false,
      initialContext: {
        payload: {
          assistantMessageId: 'msg_asst_1',
          isFirstMessage: true,
          message: [{ content: 'Hi' }],
          parentMessageId: 'msg_user_1',
        },
        phase: 'user_input',
        session: { messageCount: 1, sessionId: opId, status: 'idle', stepCount: 0 },
      },
      initialMessages: [{ content: 'Hi', id: 'msg_user_1', role: 'user' }],
      modelRuntimeConfig: { model: 'gpt-5.4', provider: 'openai' },
      operationId: opId,
      toolSet: { manifestMap: {}, sourceMap: {}, tools: [] },
      userId: 'user_1',
    });

    vi.mocked(initModelRuntimeFromDB).mockResolvedValue({
      chat: vi.fn(async (_payload: unknown, options: { callback: any }) => {
        await options.callback.onText('Часть платного ответа до обрыва');
        await options.callback.onUsage({
          totalInputTokens: 100,
          totalOutputTokens: 25,
          totalTokens: 125,
        });
        await options.callback.onError({
          code: 'UND_ERR_SOCKET',
          message: 'terminated',
          type: 'ProviderStreamInterrupted',
        });
        return new Response();
      }),
    } as any);

    const stepRes = await service.executeStep({
      context: {
        payload: {
          assistantMessageId: 'msg_asst_1',
          isFirstMessage: true,
          message: [{ content: 'Hi' }],
          parentMessageId: 'msg_user_1',
        },
        phase: 'user_input',
        session: { messageCount: 1, sessionId: opId, status: 'idle', stepCount: 0 },
      },
      operationId: opId,
      stepIndex: 0,
    });

    expect(stepRes.state.status).toBe('error');
    expect(stepRes.state.error).toEqual({
      body: { code: 'ProviderStreamInterrupted', status: 502 },
      message: 'Соединение с моделью прервалось во время ответа. Попробуйте ещё раз.',
      type: 502,
    });
    expect(stepRes.state.messages?.at(-1)).toEqual({
      content: 'Часть платного ответа до обрыва',
      role: 'assistant',
    });
    expect(stepRes.state.usage?.llm.tokens.total).toBe(125);
  });

  it('blocks retry and persists grounding when paid server search citations or DeepSeek server_tool_calls arrived before socket drop', async () => {
    const mockChat = vi.fn(async (_payload: unknown, options: { callback: any }) => {
      await options.callback.onGrounding?.({
        citations: [{ title: 'Arckép Docs', url: 'https://arckep.ru' }],
        deepseek: { server_tool_calls: [{ id: 'srv_1', name: 'web_search' }] },
      });
      throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    });
    vi.mocked(initModelRuntimeFromDB).mockResolvedValue({ chat: mockChat } as any);

    await expect(
      createRuntimeExecutors(ctx).call_llm!(instruction, initialState()),
    ).rejects.toThrow(/ECONNRESET/);

    expect(mockChat).toHaveBeenCalledTimes(1);
    expect(ctx.messageModel.update).toHaveBeenNthCalledWith(
      1,
      'msg_asst_1',
      expect.objectContaining({
        search: expect.objectContaining({
          citations: [{ title: 'Arckép Docs', url: 'https://arckep.ru' }],
        }),
      }),
    );
  });
});
