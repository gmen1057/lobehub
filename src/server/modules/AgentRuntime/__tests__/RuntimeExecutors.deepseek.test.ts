// @vitest-environment node
import { AgentRuntime } from '@lobechat/agent-runtime';
import { expect, it, vi } from 'vitest';

import { initModelRuntimeFromDB } from '@/server/modules/ModelRuntime';

import { createRuntimeExecutors } from '../RuntimeExecutors';

vi.mock('@/server/modules/ModelRuntime', () => ({ initModelRuntimeFromDB: vi.fn() }));
vi.mock('@/server/modules/Mecha/ContextEngineering', () => ({ serverMessagesEngine: vi.fn() }));
vi.mock('@/server/services/message', () => ({ MessageService: vi.fn() }));
vi.mock('@/server/services/file', () => ({ FileService: vi.fn() }));
vi.mock('@/server/services/agentDocuments', () => ({ AgentDocumentsService: vi.fn() }));
vi.mock('../arckepSearch', () => ({ resolveServerEnabledSearch: vi.fn(async () => true) }));
vi.mock('../serverModelParams', () => ({ resolveServerModelParams: vi.fn(async () => ({})) }));
vi.mock('../llmTrace', () => ({
  createEngineTraceCallbacks: vi.fn(),
  withEngineTrace: (_: unknown, callbacks: unknown) => callbacks,
}));

it('withdraws refused partial text and thinking from persisted message, state and terminal events', async () => {
  const state = AgentRuntime.createInitialState({
    operationId: 'op',
    metadata: { agentId: 'a', topicId: 't' },
    status: 'running',
  });
  const metadata = {
    finish_reason: 'content_filter',
    annotations: [],
    server_tool_calls: [{ index: 0, reasoning_content: '', calls: [{ signature: 'signed' }] }],
  };
  const chat = vi.fn(async (_payload, options) => {
    await options.callback.onText('unsafe partial answer');
    await options.callback.onThinking('private partial reasoning');
    await options.callback.onGrounding({ citations: [], deepseek: metadata });
    return new Response('');
  });
  vi.mocked(initModelRuntimeFromDB).mockResolvedValue({ chat } as any);
  const ctx: any = {
    operationId: 'op',
    stepIndex: 0,
    userId: 'user',
    messageModel: {
      create: vi.fn(async () => ({ id: 'assistant' })),
      query: vi.fn(async () => []),
      update: vi.fn(),
    },
    streamManager: { publishStreamEvent: vi.fn(), publishStreamChunk: vi.fn() },
    toolExecutionService: { executeTool: vi.fn() },
    loadAgentState: vi.fn(async () => state),
  };
  const result: any = await createRuntimeExecutors(ctx).call_llm!(
    {
      type: 'call_llm',
      payload: { model: 'deepseek-flash', provider: 'deepseek', messages: [], tools: [] },
    } as any,
    state,
  );
  const update = ctx.messageModel.update.mock.calls.at(-1)[1];
  expect(update.content).toBe('Модель отказалась отвечать на этот запрос.');
  expect(update.reasoning).toBeUndefined();
  expect(update.search.deepseek).toEqual(metadata);
  expect(result.newState.messages.at(-1)).toMatchObject({
    content: update.content,
    server_tool_calls: metadata.server_tool_calls,
    annotations: [],
  });
  expect(JSON.stringify(result)).not.toContain('unsafe partial');
  expect(JSON.stringify(ctx.streamManager.publishStreamChunk.mock.calls)).not.toContain(
    'unsafe partial',
  );
  expect(chat).toHaveBeenCalledOnce();
});
