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
vi.mock('../arckepSearch', () => ({ resolveServerEnabledSearch: vi.fn(async () => false) }));
vi.mock('../serverModelParams', () => ({ resolveServerModelParams: vi.fn(async () => ({})) }));
vi.mock('../llmTrace', () => ({
  createEngineTraceCallbacks: vi.fn(),
  withEngineTrace: (_: unknown, callbacks: unknown) => callbacks,
}));

it.each([
  ['qwen4-max', 'Need a search'],
  ['qwen4-max', ''],
  ['qwen3.8-max', 'Need a search'],
])('%s retains only the supported native reasoning history (%s)', async (model, thought) => {
  const state = AgentRuntime.createInitialState({
    operationId: 'op',
    metadata: { agentId: 'a', topicId: 't' },
    status: 'running',
  });
  const call = { id: 'call-1', type: 'function', function: { name: 'search', arguments: '{}' } };
  const chat = vi.fn(async (_payload, options) => {
    if (thought) await options.callback.onThinking(thought);
    await options.callback.onText('Checking');
    await options.callback.onToolsCalling({ toolsCalling: [call] });
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
    { type: 'call_llm', payload: { model, provider: 'qwen', messages: [], tools: [] } } as any,
    state,
  );
  const message = result.newState.messages.at(-1);
  expect(message.role).toBe('assistant');
  expect(message.content).toBe('Checking');
  expect(message.reasoning_content).toBe(model === 'qwen4-max' && thought ? thought : undefined);
  expect(message.tool_calls).toEqual([call]);
  expect(ctx.messageModel.update.mock.calls.at(-1)[1].reasoning?.content).toBe(
    thought || undefined,
  );
});
