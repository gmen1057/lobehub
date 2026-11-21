// @vitest-environment node
import { AgentRuntime, type AgentState } from '@lobechat/agent-runtime';
import { hydrateGroupMessages } from '@lobechat/context-engine';
import { parse } from '@lobechat/conversation-flow';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { serverMessagesEngine } from '@/server/modules/Mecha/ContextEngineering';
import { initModelRuntimeFromDB } from '@/server/modules/ModelRuntime';

import { createRuntimeExecutors, type RuntimeExecutorContext } from '../RuntimeExecutors';

vi.mock('@/server/modules/ModelRuntime', () => ({ initModelRuntimeFromDB: vi.fn() }));
vi.mock('@/server/modules/Mecha/ContextEngineering', () => ({ serverMessagesEngine: vi.fn() }));
vi.mock('@/server/services/message', () => ({ MessageService: vi.fn() }));
vi.mock('@/server/services/file', () => ({
  FileService: vi.fn().mockImplementation(() => ({
    getFullFileUrl: vi.fn(async (path: string | null) => (path ? `https://s3.test/${path}` : '')),
  })),
}));
vi.mock('@/server/services/agentDocuments', () => ({ AgentDocumentsService: vi.fn() }));
vi.mock('../arckepSearch', () => ({ resolveServerEnabledSearch: vi.fn(async () => false) }));
vi.mock('../serverModelParams', () => ({ resolveServerModelParams: vi.fn(async () => ({})) }));
vi.mock('../llmTrace', () => ({
  createEngineTraceCallbacks: vi.fn(),
  withEngineTrace: (_trace: unknown, callbacks: unknown) => callbacks,
}));
vi.mock('@lobechat/model-runtime', () => ({
  consumeStreamUntilDone: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('model-bank', () => ({
  LOBE_DEFAULT_MODEL_LIST: [
    {
      abilities: { functionCall: true, video: false, vision: true },
      id: 'gpt-4',
      providerId: 'openai',
    },
  ],
}));

describe('RuntimeExecutors - toolResultTrim & assistantGroup preservation', () => {
  let ctx: RuntimeExecutorContext;
  let mockMessageModel: {
    addFiles: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    query: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    let createdSeq = 0;
    mockMessageModel = {
      addFiles: vi.fn().mockResolvedValue(undefined),
      create: vi.fn(async () => ({ id: `created-tool-${++createdSeq}` })),
      query: vi.fn(async () => []),
      update: vi.fn(async () => ({})),
    };

    ctx = {
      agentConfig: {
        chatConfig: {},
        files: [],
        id: 'agent-1',
        knowledgeBases: [],
        model: 'gpt-4',
        plugins: [],
        provider: 'openai',
        systemRole: 'You are helpful.',
      } as any,
      loadAgentState: vi.fn(async () => null),
      messageModel: mockMessageModel as any,
      operationId: 'op-trim-1',
      serverDB: undefined as unknown as RuntimeExecutorContext['serverDB'],
      stepIndex: 1,
      streamManager: {
        publishStreamChunk: vi.fn(async () => 'c1'),
        publishStreamEvent: vi.fn(async () => 'e1'),
      } as any,
      toolExecutionService: {
        executeTool: vi.fn(async () => ({
          content: 'fresh batch output',
          error: null,
          executionTime: 15,
          state: {},
          success: true,
        })),
      } as any,
      topicId: 'topic-1',
      userId: 'user-1',
    };
  });

  it('call_tools_batch assigns parse(latestMessages).flatList to newState.messages with intact assistantGroup and old tool outputs', async () => {
    const oldLargeToolContent = 'KB_RAW_CONTENT_' + 'z'.repeat(20_000) + '_TAIL';

    const latestMessages: any[] = [
      { content: 'Turn 1', createdAt: 1000, id: 'u1', role: 'user', updatedAt: 1000 },
      {
        content: '',
        createdAt: 1001,
        id: 'a1',
        parentId: 'u1',
        role: 'assistant',
        tools: [
          {
            apiName: 'readKnowledge',
            arguments: '{"fileId":"file-1"}',
            id: 'tc-old-1',
            identifier: 'lobe-knowledge-base',
            type: 'builtin',
          },
        ],
        updatedAt: 1001,
      },
      {
        content: oldLargeToolContent,
        createdAt: 1002,
        id: 't1',
        parentId: 'a1',
        plugin: {
          apiName: 'readKnowledge',
          arguments: '{"fileId":"file-1"}',
          id: 'tc-old-1',
          identifier: 'lobe-knowledge-base',
          type: 'builtin',
        },
        role: 'tool',
        tool_call_id: 'tc-old-1',
        updatedAt: 1002,
      },
      {
        content: 'Turn 1 answer',
        createdAt: 1003,
        id: 'a1-final',
        parentId: 't1',
        role: 'assistant',
        updatedAt: 1003,
      },
      {
        content: 'Turn 2',
        createdAt: 2000,
        id: 'u2',
        parentId: 'a1-final',
        role: 'user',
        updatedAt: 2000,
      },
      {
        content: 'Answer 2',
        createdAt: 2001,
        id: 'a2',
        parentId: 'u2',
        role: 'assistant',
        updatedAt: 2001,
      },
      {
        content: 'Turn 3',
        createdAt: 3000,
        id: 'u3',
        parentId: 'a2',
        role: 'user',
        updatedAt: 3000,
      },
      {
        content: 'Answer 3',
        createdAt: 3001,
        id: 'a3',
        parentId: 'u3',
        role: 'assistant',
        updatedAt: 3001,
      },
      {
        content: 'Turn 4',
        createdAt: 4000,
        id: 'u4',
        parentId: 'a3',
        role: 'user',
        updatedAt: 4000,
      },
      {
        content: 'Answer 4',
        createdAt: 4001,
        id: 'a4',
        parentId: 'u4',
        role: 'assistant',
        updatedAt: 4001,
      },
      {
        content: 'Turn 5 (current)',
        createdAt: 5000,
        id: 'u5',
        parentId: 'a4',
        role: 'user',
        updatedAt: 5000,
      },
    ];

    mockMessageModel.query.mockResolvedValue(latestMessages);

    const state: AgentState = AgentRuntime.createInitialState({
      messages: [],
      metadata: {
        agentId: 'agent-1',
        threadId: 'thread-1',
        topicId: 'topic-1',
      },
      operationId: 'op-trim-1',
      status: 'running',
    });

    const executors = createRuntimeExecutors(ctx);
    const result = await executors.call_tools_batch!(
      {
        payload: {
          parentMessageId: 'a5-batch',
          toolsCalling: [
            {
              apiName: 'readKnowledge',
              arguments: '{"fileId":"file-2"}',
              id: 'tc-batch-1',
              identifier: 'lobe-knowledge-base',
              type: 'builtin' as const,
            },
          ],
        },
        type: 'call_tools_batch',
      },
      state,
    );

    const expectedFlatList = hydrateGroupMessages(parse(latestMessages).flatList, latestMessages);
    expect(result.newState.messages).toEqual(expectedFlatList);
    const groupNode = result.newState.messages.find((m: any) => m.role === 'assistantGroup') as any;
    expect(groupNode).toBeDefined();
    expect(groupNode.updatedAt).toBe(1003);
    expect(groupNode.children.at(-1)?.updatedAt).toBe(1003);
    // Full 20 KB tool output is preserved inside assistantGroup until MessagesEngine runs
    expect(JSON.stringify(result.newState.messages)).toContain(oldLargeToolContent);
  });

  it('call_llm forwards toolResultTrim to serverMessagesEngine and preserves wireSourceIds from onSourceIds', async () => {
    const systemMsg = { content: 'System prompt', role: 'system' as const };
    const oldUserMsg = { content: 'old question '.repeat(2500), role: 'user' as const };
    const oldAssistantMsg = { content: 'old answer', role: 'assistant' as const };
    const currentUserMsg = { content: 'Current question', role: 'user' as const };

    vi.mocked(serverMessagesEngine).mockImplementation(async (params) => {
      params.onSourceIds?.([undefined, 'old-u', 'old-a', 'cur-u']);
      return [systemMsg, oldUserMsg, oldAssistantMsg, currentUserMsg];
    });

    let llmAttempt = 0;
    const chat = vi.fn(async (_payload: any) => {
      llmAttempt += 1;
      if (llmAttempt === 1) {
        throw {
          body: {
            error: {
              details: [
                {
                  hasOutput: false,
                  hasUsage: false,
                  reason: 'upstream_error',
                  retryOwner: 'engine',
                  retrySafe: false,
                },
              ],
              message: 'user input too long, 10000 tokens exceeds max 5000 tokens',
              status: 413,
            },
          },
        };
      }
      return new Response('ok');
    });
    vi.mocked(initModelRuntimeFromDB).mockResolvedValue({ chat } as any);

    const sourceMessages = [
      { ...oldUserMsg, id: 'old-u' },
      { ...oldAssistantMsg, id: 'old-a' },
      { ...currentUserMsg, id: 'cur-u' },
    ];

    const state: AgentState = AgentRuntime.createInitialState({
      messages: sourceMessages as any,
      metadata: {
        agentId: 'agent-1',
        topicCacheTtlMs: 300_000,
        topicCacheWarm: true,
        topicId: 'topic-1',
      },
      operationId: 'op-trim-1',
      status: 'running',
    });

    const executors = createRuntimeExecutors(ctx);
    const result = await executors.call_llm!(
      {
        payload: {
          messages: sourceMessages,
          model: 'gpt-4',
          provider: 'openai',
          tools: [],
        },
        type: 'call_llm',
      } as any,
      state,
    );

    expect(serverMessagesEngine).toHaveBeenCalledOnce();
    expect(serverMessagesEngine).toHaveBeenCalledWith(
      expect.objectContaining({
        onSourceIds: expect.any(Function),
        toolResultTrim: {
          cacheTtlMs: 300_000,
          cacheWarm: true,
        },
      }),
    );

    const contextEngineEvent = result.events.find(
      (e: any) => e.type === 'context_engine_result',
    ) as any;
    expect(contextEngineEvent?.input?.toolResultTrim).toEqual({
      cacheTtlMs: 300_000,
      cacheWarm: true,
    });

    // Verify wireSourceIds captured from onSourceIds enabled fitRejectedPrompt to drop old-u/old-a and keep cur-u
    expect(chat).toHaveBeenCalledTimes(2);
    const secondAttemptPayload = chat.mock.calls[1][0];
    expect(secondAttemptPayload.messages).toEqual([systemMsg, currentUserMsg]);
  });

  it('call_llm omits toolResultTrim when topicCacheWarm and topicCacheTtlMs are absent', async () => {
    vi.mocked(serverMessagesEngine).mockResolvedValue([{ content: 'Hi', role: 'user' }]);
    vi.mocked(initModelRuntimeFromDB).mockResolvedValue({
      chat: vi.fn(async () => new Response('ok')),
    } as any);

    const state: AgentState = AgentRuntime.createInitialState({
      messages: [{ content: 'Hi', id: 'u1', role: 'user' }] as any,
      metadata: {
        agentId: 'agent-1',
        topicId: 'topic-1',
      },
      operationId: 'op-trim-2',
      status: 'running',
    });

    const executors = createRuntimeExecutors(ctx);
    await executors.call_llm!(
      {
        payload: {
          messages: [{ content: 'Hi', id: 'u1', role: 'user' }],
          model: 'gpt-4',
          provider: 'openai',
          tools: [],
        },
        type: 'call_llm',
      } as any,
      state,
    );

    expect(serverMessagesEngine).toHaveBeenCalledOnce();
    const engineArgs = vi.mocked(serverMessagesEngine).mock.calls[0][0];
    expect(engineArgs.toolResultTrim).toBeUndefined();
  });
});
