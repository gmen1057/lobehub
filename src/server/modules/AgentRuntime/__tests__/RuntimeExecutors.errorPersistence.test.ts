import type { AgentState } from '@lobechat/agent-runtime';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { initModelRuntimeFromDB } from '@/server/modules/ModelRuntime';

import { getPersistedLLMError } from '../persistedLLMError';
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

describe('failed model message persistence', () => {
  let ctx: RuntimeExecutorContext;
  let chat: ReturnType<typeof vi.fn>;
  const state = { messages: [], metadata: { agentId: 'a', topicId: 't' }, status: 'running', stepCount: 0 } as AgentState;
  const instruction = { type: 'call_llm', payload: { model: 'test', provider: 'openai', messages: [], tools: [] } } as any;

  beforeEach(() => {
    chat = vi.fn();
    vi.mocked(initModelRuntimeFromDB).mockResolvedValue({ chat } as any);
    ctx = {
      operationId: 'op', stepIndex: 0, userId: 'user', serverDB: undefined as any,
      messageModel: {
        create: vi.fn(async () => ({ id: 'failed-assistant' })),
        query: vi.fn(async () => []), update: vi.fn(),
      } as any,
      streamManager: { publishStreamEvent: vi.fn(), publishStreamChunk: vi.fn() } as any,
      toolExecutionService: { executeTool: vi.fn() } as any,
      loadAgentState: vi.fn(async () => state),
    };
  });

  it.each([402, 404])('saves HTTP %s before the stream error and preserves it for operation state', async (status) => {
    const original = Object.assign(new Error('private provider detail'), {
      error: { status }, errorType: 'ProviderBizError',
    });
    chat.mockRejectedValue(original);
    await expect(createRuntimeExecutors(ctx).call_llm!(instruction, state)).rejects.toBe(original);
    expect(chat).toHaveBeenCalledOnce();
    const update = vi.mocked(ctx.messageModel.update);
    expect(update).toHaveBeenCalledWith('failed-assistant', {
      error: expect.objectContaining({ body: expect.objectContaining({ status }), type: status }),
    });
    const saved = update.mock.calls.at(-1)![1].error;
    expect(getPersistedLLMError(original)).toEqual(saved);
    const publish = vi.mocked(ctx.streamManager.publishStreamEvent);
    const eventIndex = publish.mock.calls.findIndex(([, event]) => event.type === 'error');
    expect(publish.mock.calls[eventIndex][1].data).toMatchObject({ status, errorType: status });
    expect(update.mock.invocationCallOrder.at(-1)).toBeLessThan(publish.mock.invocationCallOrder[eventIndex]);
    expect(JSON.stringify(saved)).not.toContain('private provider detail');
  });
});
