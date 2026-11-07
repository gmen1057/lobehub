// @vitest-environment node
import { readFileSync } from 'node:fs';

import type { AgentState } from '@lobechat/agent-runtime';
import { AgentRuntime } from '@lobechat/agent-runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { initModelRuntimeFromDB } from '@/server/modules/ModelRuntime';

import { LobeGoogleAI } from '../../../../../packages/model-runtime/src/providers/google';
import { consumeStreamUntilDone } from '../../../../../packages/model-runtime/src/utils/consumeStream';
import { parseGoogleErrorMessage } from '../../../../../packages/model-runtime/src/utils/googleErrorParser';
import { classifyLLMError } from '../llmErrorClassification';
import type { RuntimeExecutorContext } from '../RuntimeExecutors';
import { createRuntimeExecutors } from '../RuntimeExecutors';

vi.mock('@/server/modules/ModelRuntime', () => ({ initModelRuntimeFromDB: vi.fn() }));
vi.mock('@/server/modules/Mecha/ContextEngineering', () => ({ serverMessagesEngine: vi.fn() }));
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
    messages: [{ content: 'Continue working', role: 'user' as const }],
    model: 'gemini-4-argon',
    provider: 'google',
    tools: [],
  },
  type: 'call_llm' as const,
};
const initialState = (): AgentState =>
  AgentRuntime.createInitialState({
    messages: [
      { content: 'Previously completed tool result', role: 'tool', tool_call_id: 'completed-tool' },
    ],
    metadata: { agentId: 'agent', topicId: 'topic' },
    operationId: 'operation',
    status: 'running',
  });
const googleError = (status: number, retrySafe: boolean) => {
  const error = {
    code: status,
    details: [{ reason: 'UPSTREAM_ERROR', retryOwner: 'engine', retrySafe }],
    message: 'Upstream request could not complete',
    status: status === 504 ? 'DEADLINE_EXCEEDED' : 'INVALID_ARGUMENT',
  };
  return {
    error,
    promptFeedback: {
      blockReason: 'OTHER',
      blockReasonMessage: JSON.stringify({ arckepProxyError: 1, error }),
    },
  };
};
const eventResponse = (body: unknown) =>
  new Response(`data: ${JSON.stringify(body)}\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  });
const completed = () =>
  eventResponse({
    candidates: [
      {
        content: { parts: [{ text: 'Recovered answer' }], role: 'model' },
        finishReason: 'STOP',
        index: 0,
      },
    ],
    usageMetadata: { candidatesTokenCount: 3, promptTokenCount: 7, totalTokenCount: 10 },
  });

describe('same-turn recovery through native Google SDK streams', () => {
  let ctx: RuntimeExecutorContext;
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    ctx = {
      loadAgentState: vi.fn(async () => initialState()),
      messageModel: {
        create: vi.fn(async () => ({ id: 'msg_recovery_placeholder' })),
        query: vi.fn(async () => []),
        update: vi.fn(),
      } as unknown as RuntimeExecutorContext['messageModel'],
      operationId: 'operation',
      serverDB: undefined as unknown as RuntimeExecutorContext['serverDB'],
      stepIndex: 0,
      streamManager: {
        publishStreamChunk: vi.fn(),
        publishStreamEvent: vi.fn(),
      } as unknown as RuntimeExecutorContext['streamManager'],
      toolExecutionService: {
        executeTool: vi.fn(),
      } as unknown as RuntimeExecutorContext['toolExecutionService'],
      userId: 'user',
    };
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('recovers a transient empty native SSE attempt within the same answer and keeps completed work', async () => {
    vi.useFakeTimers();
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(eventResponse(googleError(504, true)))
      .mockResolvedValueOnce(completed());
    const google = new LobeGoogleAI({
      apiKey: 'test',
      baseURL: 'http://proxy.test',
      defaultHeaders: { 'X-Arckep-Token': 'internal-test', 'x-arckep-retry-owner': 'engine' },
    });
    vi.mocked(initModelRuntimeFromDB).mockResolvedValue({
      chat: google.chat.bind(google),
    } as unknown as Awaited<ReturnType<typeof initModelRuntimeFromDB>>);
    const resultPromise = createRuntimeExecutors(ctx).call_llm!(instruction, initialState());
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result.newState.messages.at(-1)).toMatchObject({
      content: 'Recovered answer',
      role: 'assistant',
    });
    expect(result.newState.messages[0].content).toBe('Previously completed tool result');
    expect(ctx.toolExecutionService.executeTool).not.toHaveBeenCalled();
    expect(ctx.messageModel.create).toHaveBeenCalledOnce();
    expect(
      vi.mocked(ctx.streamManager.publishStreamEvent).mock.calls.map(([, event]) => event.type),
    ).not.toContain('error');
    expect(
      vi
        .mocked(ctx.streamManager.publishStreamEvent)
        .mock.calls.filter(([, event]) => event.type === 'stream_retry'),
    ).toHaveLength(1);
  });

  it.each([400, 402, 413, 451, 504])(
    'keeps native status %s and a no-replay decision after SDK and model-runtime normalization',
    async (status) => {
      const fetch = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(eventResponse(googleError(status, false)));
      const google = new LobeGoogleAI({
        apiKey: 'test',
        baseURL: 'http://proxy.test',
        defaultHeaders: { 'X-Arckep-Token': 'internal-test', 'x-arckep-retry-owner': 'engine' },
      });
      const onError = vi.fn();
      await consumeStreamUntilDone(
        await google.chat(instruction.payload, { callback: { onError } }),
      );
      expect(fetch).toHaveBeenCalledOnce();
      expect(onError).toHaveBeenCalledOnce();
      expect(classifyLLMError(onError.mock.calls[0][0])).toMatchObject({
        kind: 'stop',
        retrySafe: false,
        status,
      });
    },
  );

  it.each([1, 3, 17, 1000])(
    'keeps proxy error metadata across SSE chunks of %s bytes',
    async (size) => {
      // Fixture emitted by Studio's actual transport_failure_event encoder.
      const wire = readFileSync(
        new URL('../__fixtures__/google-proxy-timeout.sse', import.meta.url),
        'utf8',
      );
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(
          new ReadableStream({
            start(controller) {
              const bytes = new TextEncoder().encode(wire);
              for (let offset = 0; offset < bytes.length; offset += size)
                controller.enqueue(bytes.slice(offset, offset + size));
              controller.close();
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
      );
      const google = new LobeGoogleAI({
        apiKey: 'test',
        baseURL: 'http://proxy.test',
        defaultHeaders: { 'X-Arckep-Token': 'internal-test', 'x-arckep-retry-owner': 'engine' },
      });
      const onError = vi.fn();
      await consumeStreamUntilDone(
        await google.chat(instruction.payload, { callback: { onError } }),
      );
      expect(classifyLLMError(onError.mock.calls[0][0])).toMatchObject({
        kind: 'retry',
        retrySafe: true,
        status: 504,
      });
    },
  );

  it('does not decode the internal recovery carrier for ordinary provider requests', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(eventResponse(googleError(504, true)));
    const google = new LobeGoogleAI({ apiKey: 'test', baseURL: 'http://provider.test' });
    const onError = vi.fn();
    await consumeStreamUntilDone(await google.chat(instruction.payload, { callback: { onError } }));
    expect(onError.mock.calls[0][0].body).not.toHaveProperty('details');
  });

  it.each(['eof', 'disconnect', 'empty-candidate', 'whitespace'])(
    'preserves standalone usage before %s without success or replay',
    async (end) => {
      const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        let sent = false;
        return new Response(
          new ReadableStream({
            pull(controller) {
              if (!sent) {
                sent = true;
                controller.enqueue(
                  new TextEncoder().encode(
                    'data: ' +
                      JSON.stringify({
                        ...(end === 'empty-candidate'
                          ? { candidates: [{ index: 0 }] }
                          : end === 'whitespace'
                            ? {
                                candidates: [
                                  {
                                    content: { parts: [{ text: '   ' }], role: 'model' },
                                    index: 0,
                                  },
                                ],
                              }
                            : {}),
                        usageMetadata: { promptTokenCount: 7, totalTokenCount: 7 },
                      }) +
                      '\n\n',
                  ),
                );
              } else if (end === 'disconnect') controller.error(new Error('Connection reset'));
              else controller.close();
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      });
      const google = new LobeGoogleAI({
        apiKey: 'test',
        baseURL: 'http://proxy.test',
        defaultHeaders: { 'X-Arckep-Token': 'internal-test', 'x-arckep-retry-owner': 'engine' },
      });
      vi.mocked(initModelRuntimeFromDB).mockResolvedValue({
        chat: google.chat.bind(google),
      } as unknown as Awaited<ReturnType<typeof initModelRuntimeFromDB>>);
      await expect(
        createRuntimeExecutors(ctx).call_llm!(instruction, initialState()),
      ).rejects.toBeDefined();
      expect(fetch).toHaveBeenCalledOnce();
      expect(ctx.messageModel.update).toHaveBeenCalledWith(
        'msg_recovery_placeholder',
        expect.objectContaining({
          metadata: expect.objectContaining({
            finishReason: 'error',
            totalInputTokens: 7,
            usageReported: true,
          }),
        }),
      );
      expect(
        vi.mocked(ctx.streamManager.publishStreamEvent).mock.calls.map(([, event]) => event.type),
      ).not.toContain('stream_retry');
    },
  );

  it('does not replay a received tool call after the connection fails', async () => {
    const chat = vi.fn(
      async (
        _payload: unknown,
        options: { callback: { onToolsCalling: (data: unknown) => Promise<void> } },
      ) => {
        await options.callback.onToolsCalling({
          toolsCalling: [
            { function: { arguments: '{}', name: 'search' }, id: 'pending-tool', type: 'function' },
          ],
        });
        throw new Error('Connection reset after tool call');
      },
    );
    vi.mocked(initModelRuntimeFromDB).mockResolvedValue({ chat } as unknown as Awaited<
      ReturnType<typeof initModelRuntimeFromDB>
    >);
    await expect(
      createRuntimeExecutors(ctx).call_llm!(instruction, initialState()),
    ).rejects.toThrow('Connection reset');
    expect(chat).toHaveBeenCalledOnce();
    expect(ctx.toolExecutionService.executeTool).not.toHaveBeenCalled();
  });

  it('keeps partial text and reported usage on stream failure without replaying a paid attempt', async () => {
    const chat = vi.fn(
      async (
        _payload: unknown,
        options: {
          callback: {
            onText: (text: string) => Promise<void>;
            onCompletion: (data: unknown) => Promise<void>;
          };
        },
      ) => {
        await options.callback.onText('Useful partial answer');
        await options.callback.onCompletion({
          usage: { totalInputTokens: 7, totalOutputTokens: 3, totalTokens: 10 },
        });
        throw new Error('Connection reset');
      },
    );
    vi.mocked(initModelRuntimeFromDB).mockResolvedValue({ chat } as unknown as Awaited<
      ReturnType<typeof initModelRuntimeFromDB>
    >);
    await expect(
      createRuntimeExecutors(ctx).call_llm!(instruction, initialState()),
    ).rejects.toThrow('Connection reset');
    expect(chat).toHaveBeenCalledOnce();
    expect(ctx.messageModel.update).toHaveBeenCalledWith(
      'msg_recovery_placeholder',
      expect.objectContaining({
        content: 'Useful partial answer',
        metadata: expect.objectContaining({
          finishReason: 'error',
          totalTokens: 10,
          usageReported: true,
        }),
      }),
    );
    expect(ctx.messageModel.update).toHaveBeenCalledWith(
      'msg_recovery_placeholder',
      expect.objectContaining({ error: expect.any(Object) }),
    );
    expect(
      vi.mocked(ctx.streamManager.publishStreamEvent).mock.calls.map(([, event]) => event.type),
    ).not.toContain('stream_retry');
  });
});

describe('recovery metadata through provider envelopes', () => {
  it.each([400, 401, 402, 403, 404, 409, 422])(
    'never retries a real provider %s hidden in body/code',
    (status) => {
      const parsed = parseGoogleErrorMessage(JSON.stringify(googleError(status, false)));
      expect(classifyLLMError({ body: parsed.error, type: 'StreamChunkError' })).toMatchObject({
        kind: 'stop',
        status,
      });
    },
  );
  it('does not let a generic outer 500 hide a permanent refusal or a no-replay flag', () => {
    expect(
      classifyLLMError({ status: 500, body: googleError(400, false), type: 'StreamChunkError' }),
    ).toMatchObject({ kind: 'stop', retrySafe: false, status: 400 });
  });
});
