import { type AgentInstructionCompressContext } from '@lobechat/agent-runtime';
import { describe, expect, it, vi } from 'vitest';

import { chatService } from '@/services/chat';
import { messageService } from '@/services/message';

import { createMockStore } from './fixtures';
import { createInitialState, createTestContext, executeWithMockContext } from './helpers';

vi.mock('@/services/chat', () => ({
  chatService: {
    fetchPresetTaskResult: vi.fn(),
  },
}));

vi.mock('@/services/message', () => ({
  messageService: {
    createCompressionGroup: vi.fn(),
    finalizeCompression: vi.fn(),
  },
}));

const createCompressInstruction = (
  messages: any[] = [{ content: 'Hello', id: 'user-1', role: 'user' }],
): AgentInstructionCompressContext => ({
  payload: {
    currentTokenCount: 12_000,
    messages,
  },
  type: 'compress_context',
});

describe('compress_context executor', () => {
  it('should skip without re-queueing messages when a compression is already running', async () => {
    const context = createTestContext();
    const mockStore = createMockStore();
    mockStore.operations['op-running-compress'] = {
      abortController: new AbortController(),
      context: { agentId: context.agentId, threadId: null, topicId: context.topicId },
      id: 'op-running-compress',
      metadata: { startTime: Date.now() },
      status: 'running',
      type: 'contextCompression',
    } as any;
    mockStore.dbMessagesMap[context.messageKey] = [
      { id: 'user-1', role: 'user' },
      { id: 'assistant-1', role: 'assistant' },
    ] as any;

    const result = await executeWithMockContext({
      context,
      executor: 'compress_context',
      instruction: createCompressInstruction(),
      mockStore,
      state: createInitialState({ operationId: 'test-session' }),
    });

    expect(result.nextContext?.phase).toBe('compression_result');
    expect(result.nextContext?.payload).toMatchObject({ skipped: true });
    expect((result.nextContext?.payload as any).compressedMessages).toBeUndefined();
    expect(messageService.createCompressionGroup).not.toHaveBeenCalled();
  });

  it('should skip when remaining messages are already compressed groups', async () => {
    const context = createTestContext();
    const mockStore = createMockStore();
    mockStore.dbMessagesMap[context.messageKey] = [
      { id: 'group-1', role: 'compressedGroup' },
    ] as any;

    const result = await executeWithMockContext({
      context,
      executor: 'compress_context',
      instruction: createCompressInstruction([
        { content: 'Existing summary', id: 'group-1', role: 'compressedGroup' },
      ]),
      mockStore,
      state: createInitialState({
        messages: [{ content: 'Existing summary', id: 'group-1', role: 'compressedGroup' }] as any,
        operationId: 'test-session',
      }),
    });

    expect(result.newState.messages).toEqual([
      { content: 'Existing summary', id: 'group-1', role: 'compressedGroup' },
    ]);
    expect(result.nextContext?.payload).toMatchObject({ skipped: true });
    expect((result.nextContext?.payload as any).compressedMessages).toBeUndefined();
    expect(messageService.createCompressionGroup).not.toHaveBeenCalled();
  });

  it('should keep compressed messages in state and omit them from the next queue payload', async () => {
    const context = createTestContext();
    const mockStore = createMockStore();
    mockStore.replaceMessages = vi.fn();
    mockStore.dbMessagesMap[context.messageKey] = [
      { id: 'user-1', role: 'user' },
      { id: 'assistant-1', role: 'assistant' },
    ] as any;

    const compressedMessages = [
      { content: 'summary', id: 'group-123', role: 'compressedGroup' },
    ];

    vi.mocked(messageService.createCompressionGroup).mockResolvedValue({
      messageGroupId: 'group-123',
      messages: compressedMessages,
      messagesToSummarize: [{ id: 'user-1', role: 'user' }] as any,
    } as any);
    vi.mocked(chatService.fetchPresetTaskResult).mockResolvedValue(undefined as any);
    vi.mocked(messageService.finalizeCompression).mockResolvedValue({
      messages: compressedMessages,
    } as any);

    const result = await executeWithMockContext({
      context,
      executor: 'compress_context',
      instruction: createCompressInstruction(),
      mockStore,
      state: createInitialState({
        messages: [
          { content: 'Hello', id: 'user-1', role: 'user' },
          { content: 'Hi', id: 'assistant-1', role: 'assistant' },
        ] as any,
        operationId: 'test-session',
      }),
    });

    expect(result.newState.messages).toEqual(compressedMessages);
    expect((result.nextContext?.payload as any).compressedMessages).toBeUndefined();
    expect(result.nextContext?.payload).toMatchObject({
      groupId: 'group-123',
      parentMessageId: 'assistant-1',
    });
    expect(messageService.createCompressionGroup).toHaveBeenCalledWith({
      agentId: context.agentId,
      messageIds: ['user-1', 'assistant-1'],
      topicId: context.topicId,
    });
  });
});
