// @vitest-environment node
import { readFileSync } from 'node:fs';

import { Stream as AnthropicSDKStream } from '@anthropic-ai/sdk/streaming';
import type { AgentState } from '@lobechat/agent-runtime';
import {
  AgentRuntime,
  calculatePromptTokens,
  estimateTokens,
  GeneralChatAgent,
} from '@lobechat/agent-runtime';
import type { ChatStreamPayload } from '@lobechat/model-runtime';
import { Stream } from 'openai/streaming';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { serverMessagesEngine } from '@/server/modules/Mecha/ContextEngineering';
import { initModelRuntimeFromDB } from '@/server/modules/ModelRuntime';
import { MessageService } from '@/server/services/message';

import { AnthropicStream } from '../../../../../packages/model-runtime/src/core/streams/anthropic';
import { OpenAIStream } from '../../../../../packages/model-runtime/src/core/streams/openai/openai';
import { OpenAIResponsesStream } from '../../../../../packages/model-runtime/src/core/streams/openai/responsesStream';
import { LobeGoogleAI } from '../../../../../packages/model-runtime/src/providers/google';
import { consumeStreamUntilDone } from '../../../../../packages/model-runtime/src/utils/consumeStream';
import { parseGoogleErrorMessage } from '../../../../../packages/model-runtime/src/utils/googleErrorParser';
import { classifyLLMError } from '../llmErrorClassification';
import type { RuntimeExecutorContext } from '../RuntimeExecutors';
import { createRuntimeExecutors, LONG_LLM_ATTEMPT_NO_RETRY_MS } from '../RuntimeExecutors';

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

  const inputRefusal = {
    code: 'invalid_request_error',
    details: [
      {
        hasOutput: false,
        hasUsage: false,
        reason: 'upstream_error',
        retryOwner: 'engine',
        retrySafe: false,
      },
    ],
    message: 'user input too long, 34968 tokens exceeds max 32768 tokens',
    retrySafe: false,
    status: 413,
    type: 'invalid_request_error',
  };

  it('answers the current task after automatic compression and an empty native DeepSeek 413', async () => {
    const modelRuntimeConfig = { model: 'deepseek-flash', provider: 'deepseek' };
    const agent = new GeneralChatAgent({ modelRuntimeConfig, operationId: ctx.operationId });
    const task = {
      content: 'Как теперь проверить последнюю версию?',
      id: 'user-task',
      role: 'user',
    };
    const unit = 'Исходный пример кода и результат проверки. '.repeat(100);
    const summaries = Array.from({ length: 12 }, (_, i) => ({
      content:
        unit.repeat(4).slice(0, Math.ceil((unit.length * 2850) / estimateTokens(unit))) + String(i),
      id: 'archive-' + i,
      role: 'compressedGroup',
      topicId: 'topic',
    }));
    const source = { content: unit.repeat(120), id: 'recent-history', role: 'assistant' };
    const state = {
      ...initialState(),
      modelRuntimeConfig,
      messages: [...summaries.slice(0, -1), source, task],
      tools: [
        {
          type: 'function' as const,
          function: {
            name: 'getTopicContext',
            description: 'Read archived conversation',
            parameters: { type: 'object', properties: {} },
          },
        },
      ],
    };
    const session = {
      messageCount: state.messages.length,
      sessionId: 'operation',
      status: 'running' as const,
      stepCount: 0,
    };
    const compression = await agent.runner({ phase: 'init', payload: {}, session }, state);
    if (Array.isArray(compression) || compression.type !== 'compress_context')
      throw new Error('Expected automatic compression');
    const upsertRollingCompressionGroup = vi.fn(async () => ({
      messageGroupId: 'archive-11',
      messages: [...summaries, task],
    }));
    vi.mocked(MessageService).mockImplementationOnce(function () {
      return { upsertRollingCompressionGroup } as unknown as MessageService;
    });
    vi.mocked(ctx.messageModel.query).mockResolvedValue(state.messages as any);
    const summarize = vi.fn(async (_request: unknown, options: { callback: any }) => {
      await options.callback.onText(summaries[11].content);
      return new Response();
    });
    vi.mocked(initModelRuntimeFromDB).mockResolvedValueOnce({ chat: summarize } as any);
    const first = await createRuntimeExecutors(ctx).compress_context!(compression, state);
    expect(first.nextContext?.phase).toBe('compression_result');
    const followUp = await agent.runner(first.nextContext!, first.newState);
    if (Array.isArray(followUp) || followUp.type !== 'call_llm')
      throw new Error('Expected answer after compression');

    const engine = await vi.importActual<{ serverMessagesEngine: typeof serverMessagesEngine }>(
      '@/server/modules/Mecha/ContextEngineering',
    );
    vi.mocked(serverMessagesEngine).mockImplementationOnce(engine.serverMessagesEngine);
    ctx.agentConfig = {
      systemRole: 'Keep project instructions',
      knowledgeBases: [{ id: 'project-docs', name: 'Project documents', enabled: true }],
    };
    const chat = vi.fn(async (payload: ChatStreamPayload, options: { callback: any }) => {
      const count = calculatePromptTokens(payload.messages, payload.tools);
      const event =
        count > 32_768
          ? { error: inputRefusal }
          : {
              choices: [
                { index: 0, delta: { content: 'Проверка завершена.' }, finish_reason: 'stop' },
              ],
            };
      const stream = Stream.fromSSEResponse<any>(eventResponse(event), new AbortController());
      return new Response(
        OpenAIStream(stream, { callbacks: options.callback, payload: modelRuntimeConfig }),
      );
    });
    vi.mocked(initModelRuntimeFromDB).mockResolvedValueOnce({ chat } as any);

    const final = await createRuntimeExecutors({ ...ctx, stepIndex: 1 }).call_llm!(
      followUp,
      first.newState,
    );
    expect(final.newState.messages.at(-1)).toMatchObject({
      content: 'Проверка завершена.',
      role: 'assistant',
    });
    expect(await agent.runner(final.nextContext!, final.newState)).toMatchObject({
      reason: 'completed',
      type: 'finish',
    });
    expect(chat).toHaveBeenCalledTimes(2);
    const [original, reduced] = chat.mock.calls.map(([payload]) => payload);
    expect(calculatePromptTokens(original.messages, original.tools)).toBeGreaterThan(32_768);
    expect(calculatePromptTokens(reduced.messages, reduced.tools)).toBeLessThan(32_768);
    expect(reduced.tools).toEqual(state.tools);
    expect(reduced.messages.at(-1)).toEqual({ content: task.content, role: 'user' });
    expect(reduced.messages.filter((m) => m.role === 'system')).toEqual(
      original.messages.filter((m) => m.role === 'system'),
    );
    const knowledge = original.messages.find((m) =>
      JSON.stringify(m.content).includes('project-docs'),
    );
    expect(knowledge).toBeDefined();
    expect(reduced.messages).toContainEqual(knowledge);
    expect(
      reduced.messages.filter((m) => String(m.content).includes('<original_history>')),
    ).toHaveLength(12);
    expect(final.newState.messages.slice(0, 12)).toEqual(summaries);
    expect(summarize).toHaveBeenCalledOnce();
    expect(upsertRollingCompressionGroup).toHaveBeenCalledOnce();
    expect(upsertRollingCompressionGroup.mock.calls[0]).toEqual([
      'topic',
      [source.id],
      expect.anything(),
      summaries[11].content,
    ]);
    expect(ctx.messageModel.create).toHaveBeenCalledOnce();
    expect(ctx.toolExecutionService.executeTool).not.toHaveBeenCalled();
    expect(
      vi.mocked(ctx.streamManager.publishStreamEvent).mock.calls.map(([, e]) => e.type),
    ).not.toContain('error');
  });

  it('stops on a second refusal even when more old turns could fit a smaller limit', async () => {
    const chat = vi.fn().mockRejectedValue(inputRefusal);
    vi.mocked(initModelRuntimeFromDB).mockResolvedValueOnce({ chat } as any);
    const messages = Array.from({ length: 12 }, (_, i) => ({
      id: String(i),
      role: 'user',
      content: 'Previous task. '.repeat(500),
    }));
    await expect(
      createRuntimeExecutors(ctx).call_llm!(
        {
          ...instruction,
          payload: { ...instruction.payload, messages },
        },
        initialState(),
      ),
    ).rejects.toBe(inputRefusal);
    expect(chat).toHaveBeenCalledTimes(2);
    expect(chat.mock.calls[1][0].messages.length).toBeLessThan(messages.length);
    expect(ctx.messageModel.create).toHaveBeenCalledOnce();
  });

  it.each(['onText', 'onUsage', 'onToolsCalling', 'onGrounding'] as const)(
    'does not resubmit a measured context rejection after %s',
    async (callback) => {
      const chat = vi.fn(async (_payload: unknown, options: { callback: any }) => {
        const delta = {
          onGrounding: { deepseek: { server_tool_calls: [{ id: 'already-executed' }] } },
          onText: 'Partial',
          onToolsCalling: {
            toolsCalling: [
              {
                id: 'started',
                type: 'function',
                function: { name: 'getTopicContext', arguments: '{}' },
              },
            ],
          },
          onUsage: { totalInputTokens: 12 },
        };
        await options.callback[callback](delta[callback]);
        throw inputRefusal;
      });
      vi.mocked(initModelRuntimeFromDB).mockResolvedValueOnce({ chat } as any);
      await expect(
        createRuntimeExecutors(ctx).call_llm!(
          {
            ...instruction,
            payload: {
              ...instruction.payload,
              messages: [
                { role: 'user', content: 'old'.repeat(20_000) },
                ...instruction.payload.messages,
              ],
            },
          },
          initialState(),
        ),
      ).rejects.toBeDefined();
      expect(chat).toHaveBeenCalledOnce();
    },
  );

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

  it('stops after 1 attempt without 5 retries on OpenAI Responses SSE invalid_json_schema error', async () => {
    const ssePayload = {
      error: {
        code: 'invalid_json_schema',
        details: [
          {
            hasOutput: false,
            hasUsage: false,
            reason: 'upstream_error',
            retryOwner: 'engine',
            retrySafe: false,
          },
        ],
        message: 'Invalid JSON schema: regex lookaround is not supported',
        status: 400,
        type: 'invalid_request_error',
      },
    };
    const chat = vi.fn(async (_payload: unknown, options: { callback?: any }) => {
      const sseResponse = new Response(
        `: ping\n\nevent: error\ndata: ${JSON.stringify(ssePayload)}\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
      const openAIStream = Stream.fromSSEResponse<any>(sseResponse, new AbortController());
      return new Response(
        OpenAIResponsesStream(openAIStream, {
          callbacks: options?.callback,
          payload: { provider: 'openai' },
        }),
      );
    });
    vi.mocked(initModelRuntimeFromDB).mockResolvedValue({ chat } as unknown as Awaited<
      ReturnType<typeof initModelRuntimeFromDB>
    >);

    await expect(
      createRuntimeExecutors(ctx).call_llm!(
        {
          ...instruction,
          payload: { ...instruction.payload, model: 'gpt-6-astra', provider: 'openai' },
        },
        initialState(),
      ),
    ).rejects.toThrow(/Invalid JSON schema: regex lookaround is not supported/);

    expect(chat).toHaveBeenCalledOnce();
    expect(
      vi.mocked(ctx.streamManager.publishStreamEvent).mock.calls.map(([, event]) => event.type),
    ).not.toContain('stream_retry');
  });

  it('stops after 1 attempt on 504 upstream_timeout (retrySafe: false) for OpenAI and Anthropic SSE streams', async () => {
    const details = [
      {
        hasOutput: false,
        hasUsage: false,
        reason: 'upstream_timeout',
        retryOwner: 'engine',
        retrySafe: false,
      },
    ];

    // 1. OpenAI chat completions SSE stream
    const openAIChat = vi.fn(async (_payload: unknown, options: { callback?: any }) => {
      const ssePayload = {
        error: {
          code: 'upstream_timeout',
          details,
          message: 'Upstream provider openai timed out.',
          status: 504,
          type: 'upstream_timeout',
        },
      };
      const sseResponse = new Response(`: ping\n\ndata: ${JSON.stringify(ssePayload)}\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      });
      const openAIStream = Stream.fromSSEResponse<any>(sseResponse, new AbortController());
      return new Response(
        OpenAIStream(openAIStream, {
          callbacks: options?.callback,
          payload: { provider: 'openai' },
        }),
      );
    });
    vi.mocked(initModelRuntimeFromDB).mockResolvedValue({ chat: openAIChat } as unknown as Awaited<
      ReturnType<typeof initModelRuntimeFromDB>
    >);

    await expect(
      createRuntimeExecutors(ctx).call_llm!(
        {
          ...instruction,
          payload: { ...instruction.payload, model: 'gpt-6-astra', provider: 'openai' },
        },
        initialState(),
      ),
    ).rejects.toThrow(/Upstream provider openai timed out/);
    expect(openAIChat).toHaveBeenCalledOnce();

    // 2. Anthropic messages SSE stream
    const anthropicChat = vi.fn(async (_payload: unknown, options: { callback?: any }) => {
      const ssePayload = {
        error: {
          code: 'upstream_timeout',
          details,
          message: 'Upstream provider anthropic timed out.',
          status: 504,
          type: 'upstream_timeout',
        },
        type: 'error',
      };
      const sseResponse = new Response(
        `: ping\n\nevent: error\ndata: ${JSON.stringify(ssePayload)}\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
      const anthropicStream = AnthropicSDKStream.fromSSEResponse(
        sseResponse,
        new AbortController(),
      );
      return new Response(
        AnthropicStream(anthropicStream, {
          callbacks: options?.callback,
          payload: { provider: 'anthropic' },
        }),
      );
    });
    vi.mocked(initModelRuntimeFromDB).mockResolvedValue({
      chat: anthropicChat,
    } as unknown as Awaited<ReturnType<typeof initModelRuntimeFromDB>>);

    await expect(
      createRuntimeExecutors(ctx).call_llm!(
        {
          ...instruction,
          payload: { ...instruction.payload, model: 'claude-sonnet-5-5', provider: 'anthropic' },
        },
        initialState(),
      ),
    ).rejects.toThrow(/Upstream provider anthropic timed out/);
    expect(anthropicChat).toHaveBeenCalledOnce();
    expect(
      vi.mocked(ctx.streamManager.publishStreamEvent).mock.calls.map(([, event]) => event.type),
    ).not.toContain('stream_retry');
  });

  it('never retries when an LLM attempt fails after >= 60s even without retrySafe: false (socket drop / AbortError)', async () => {
    vi.useFakeTimers();

    const chat = vi.fn(async (_payload: unknown, options: { callback?: any }) => {
      return new Response(
        new ReadableStream({
          start(controller) {
            setTimeout(async () => {
              // Simulate a generic StreamChunkError / AbortError without retrySafe: false
              // (which classifyLLMError alone would classify as 'retry')
              await options.callback?.onError?.({
                body: { message: 'This operation was aborted', name: 'AbortError' },
                message: 'This operation was aborted',
                name: 'AbortError',
                type: 'StreamChunkError',
              });
              controller.close();
            }, LONG_LLM_ATTEMPT_NO_RETRY_MS);
          },
        }),
      );
    });
    vi.mocked(initModelRuntimeFromDB).mockResolvedValue({ chat } as unknown as Awaited<
      ReturnType<typeof initModelRuntimeFromDB>
    >);

    const callPromise = createRuntimeExecutors(ctx).call_llm!(instruction, initialState());
    // Attach rejection handler before advancing fake timers to prevent unhandled rejection warnings
    const assertion = expect(callPromise).rejects.toThrow(/This operation was aborted/);
    await vi.advanceTimersByTimeAsync(LONG_LLM_ATTEMPT_NO_RETRY_MS + 100);
    await assertion;

    expect(chat).toHaveBeenCalledOnce();
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
