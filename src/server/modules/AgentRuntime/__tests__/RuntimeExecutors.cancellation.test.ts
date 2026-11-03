import type { AgentState } from '@lobechat/agent-runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { initModelRuntimeFromDB } from '@/server/modules/ModelRuntime';

import { createRuntimeExecutors, type RuntimeExecutorContext } from '../RuntimeExecutors';

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
  type: 'call_llm' as const,
  payload: {
    model: 'gpt-4',
    provider: 'openai',
    messages: [{ content: 'Hello', role: 'user' }],
    tools: [],
  },
};
const state = (): AgentState =>
  ({
    messages: [],
    metadata: { agentId: 'test-agent', topicId: 'test-topic' },
    status: 'running',
    stepCount: 0,
    operationId: 'test-operation',
  }) as AgentState;

describe('running model cancellation', () => {
  let controller: AbortController;
  let ctx: RuntimeExecutorContext;
  let chat: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    controller = new AbortController();
    chat = vi.fn();
    vi.mocked(initModelRuntimeFromDB).mockResolvedValue({ chat } as any);
    ctx = {
      operationId: 'test-operation',
      stepIndex: 0,
      userId: 'test-user',
      serverDB: undefined as any,
      signal: controller.signal,
      messageModel: {
        create: vi.fn(async () => ({ id: 'assistant-id' })),
        query: vi.fn(async () => []),
        update: vi.fn(),
      } as any,
      streamManager: { publishStreamEvent: vi.fn(), publishStreamChunk: vi.fn() } as any,
      toolExecutionService: { executeTool: vi.fn() } as any,
      loadAgentState: vi.fn(async () => state()),
    };
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([false, true])(
    'keeps partial output and reported usage=%s without retry',
    async (hasUsage) => {
      chat.mockImplementation(async (_payload, options) => {
        expect(options.signal).toBe(controller.signal);
        await options.callback.onText('A useful partial answer');
        if (hasUsage)
          await options.callback.onCompletion({
            usage: { totalInputTokens: 10, totalOutputTokens: 3, totalTokens: 13 },
          });
        controller.abort();
        throw Object.assign(new Error('SDK request aborted'), { name: 'AbortError' });
      });
      const result = await createRuntimeExecutors(ctx).call_llm!(instruction as any, state());
      expect(chat).toHaveBeenCalledOnce();
      expect(result.newState.status).toBe('interrupted');
      expect(result.newState.messages).toEqual([
        { content: 'A useful partial answer', role: 'assistant' },
      ]);
      expect(ctx.messageModel.update).toHaveBeenCalledWith(
        'assistant-id',
        expect.objectContaining({
          content: 'A useful partial answer',
          metadata: expect.objectContaining({
            finishReason: 'interrupted',
            usageReported: hasUsage,
          }),
        }),
      );
      if (hasUsage) expect(result.newState.usage?.llm.tokens.total).toBe(13);
      else expect(result.newState.usage).toBeUndefined();
      const published = vi
        .mocked(ctx.streamManager.publishStreamEvent)
        .mock.calls.map(([, event]) => event.type);
      expect(published).not.toContain('stream_retry');
      expect(published).not.toContain('error');
    },
  );

  it('wakes a backoff immediately and never starts another paid attempt', async () => {
    vi.useFakeTimers();
    chat.mockRejectedValue(new Error('network timeout'));
    const resultPromise = createRuntimeExecutors(ctx).call_llm!(instruction as any, state());
    await vi.waitFor(() =>
      expect(ctx.streamManager.publishStreamEvent).toHaveBeenCalledWith(
        'test-operation',
        expect.objectContaining({ type: 'stream_retry' }),
      ),
    );
    controller.abort();
    expect((await resultPromise).newState.status).toBe('interrupted');
    expect(chat).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not start a model request after a previously accepted cancellation', async () => {
    controller.abort();
    const result = await createRuntimeExecutors(ctx).call_llm!(instruction as any, state());
    expect(result.newState.status).toBe('interrupted');
    expect(chat).not.toHaveBeenCalled();
  });

  it('does not start a tool after cancellation', async () => {
    controller.abort();
    await createRuntimeExecutors(ctx).call_tool!(
      {
        type: 'call_tool',
        payload: {
          parentMessageId: 'a',
          toolCalling: { id: 't', identifier: 'media', apiName: 'create', arguments: '{}' },
        },
      } as any,
      state(),
    );
    expect(ctx.toolExecutionService.executeTool).not.toHaveBeenCalled();
  });

  it.each(['call_tool', 'call_tools_batch'] as const)(
    'does not dispatch client work after Stop in %s',
    async (type) => {
      controller.abort();
      const tool = { id: 't', identifier: 'client', apiName: 'create', arguments: '{}' };
      const current = state();
      current.toolSourceMap = { client: 'client' };
      const result = await createRuntimeExecutors(ctx)[type]!(
        {
          type,
          payload: {
            parentMessageId: 'a',
            ...(type === 'call_tool' ? { toolCalling: tool } : { toolsCalling: [tool] }),
          },
        } as any,
        current,
      );
      expect(result.newState.status).toBe('interrupted');
      expect(ctx.streamManager.publishStreamChunk).not.toHaveBeenCalled();
      expect(ctx.toolExecutionService.executeTool).not.toHaveBeenCalled();
    },
  );

  it('lets an already started paid tool finish, saves its result and never repeats it', async () => {
    let finish!: (value: any) => void;
    const pending = new Promise((resolve) => {
      finish = resolve;
    });
    vi.mocked(ctx.toolExecutionService.executeTool).mockReturnValue(pending as any);
    const resultPromise = createRuntimeExecutors(ctx).call_tool!(
      {
        type: 'call_tool',
        payload: {
          parentMessageId: 'a',
          toolCalling: { id: 't', identifier: 'media', apiName: 'create', arguments: '{}' },
        },
      } as any,
      state(),
    );
    await vi.waitFor(() => expect(ctx.toolExecutionService.executeTool).toHaveBeenCalledOnce());
    controller.abort();
    finish({
      content: 'https://owned.example/result.png',
      success: true,
      executionTime: 100,
      state: {},
    });
    const result = await resultPromise;
    expect(result.newState.status).toBe('interrupted');
    expect(ctx.toolExecutionService.executeTool).toHaveBeenCalledOnce();
    expect(ctx.messageModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'tool',
        content: 'https://owned.example/result.png',
      }),
    );
  });

  it('stops a permanent provider refusal after one call', async () => {
    chat.mockRejectedValue(
      Object.assign(new Error('LLM stream error'), {
        errorType: 'ProviderBizError',
        error: { status: 404, message: 'Model unavailable for free' },
      }),
    );
    await expect(
      createRuntimeExecutors(ctx).call_llm!(instruction as any, state()),
    ).rejects.toThrow();
    expect(chat).toHaveBeenCalledOnce();
  });
});
