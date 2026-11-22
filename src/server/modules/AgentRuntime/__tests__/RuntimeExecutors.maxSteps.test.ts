// @vitest-environment node
import { AgentRuntime, type AgentState } from '@lobechat/agent-runtime';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { serverMessagesEngine } from '@/server/modules/Mecha/ContextEngineering';
import { initModelRuntimeFromDB } from '@/server/modules/ModelRuntime';

import { ARCKEP_WEB_SEARCH_CONNECTOR } from '../arckepSearch';
import { createRuntimeExecutors, type RuntimeExecutorContext } from '../RuntimeExecutors';

vi.mock('@/server/modules/ModelRuntime', () => ({ initModelRuntimeFromDB: vi.fn() }));
vi.mock('@/server/modules/Mecha/ContextEngineering', () => ({ serverMessagesEngine: vi.fn() }));
vi.mock('@/server/services/message', () => ({ MessageService: vi.fn() }));
vi.mock('@/server/services/file', () => ({
  FileService: vi.fn().mockImplementation(() => ({
    uploadBase64: vi.fn().mockResolvedValue({
      fileId: 'file-img-1',
      url: 'https://s3.example/img-1.png',
    }),
  })),
}));
vi.mock('@/server/services/agentDocuments', () => ({ AgentDocumentsService: vi.fn() }));
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
      id: 'gpt-5.6-luna',
      providerId: 'openai',
    },
  ],
}));

const createState = (overrides: Partial<AgentState> = {}): AgentState =>
  AgentRuntime.createInitialState({
    messages: [{ content: 'Do complex work', role: 'user' }],
    metadata: { agentId: 'agent-1', topicId: 'topic-1' },
    modelRuntimeConfig: { model: 'gpt-5.6-luna', provider: 'openai' },
    operationId: 'op-max-steps',
    status: 'running',
    ...overrides,
  });

describe('RuntimeExecutors — maxSteps forceFinish & sandboxAllowInternet', () => {
  let ctx: RuntimeExecutorContext;
  let mockChat: ReturnType<typeof vi.fn>;
  let mockMessageCreate: ReturnType<typeof vi.fn>;
  let mockMessageUpdate: ReturnType<typeof vi.fn>;
  let mockExecuteTool: ReturnType<typeof vi.fn>;
  let mockPublishStreamChunk: ReturnType<typeof vi.fn>;
  let mockPublishStreamEvent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockChat = vi.fn().mockResolvedValue(new Response('done'));
    vi.mocked(initModelRuntimeFromDB).mockResolvedValue({ chat: mockChat } as any);
    vi.mocked(serverMessagesEngine).mockImplementation(async ({ messages }: any) => messages);

    let seq = 0;
    mockMessageCreate = vi.fn(async () => ({ id: `msg-${++seq}` }));
    mockMessageUpdate = vi.fn(async () => ({}));
    mockExecuteTool = vi.fn(async () => ({
      content: 'ok',
      executionTime: 10,
      success: true,
    }));
    mockPublishStreamChunk = vi.fn(async () => {});
    mockPublishStreamEvent = vi.fn(async () => {});

    ctx = {
      messageModel: {
        addFiles: vi.fn(async () => {}),
        create: mockMessageCreate,
        query: vi.fn(async () => []),
        update: mockMessageUpdate,
      } as any,
      operationId: 'op-max-steps',
      serverDB: undefined as any,
      stepIndex: 60,
      streamManager: {
        publishStreamChunk: mockPublishStreamChunk,
        publishStreamEvent: mockPublishStreamEvent,
      } as any,
      toolExecutionService: {
        executeTool: mockExecuteTool,
      } as any,
      topicId: 'topic-1',
      userId: 'user-1',
    };
  });

  describe('call_llm — max_steps_completed on forceFinish', () => {
    it('sets finishReason=max_steps_completed, preserves paid text, drops phantom tool calls, and does not set error', async () => {
      mockChat.mockImplementationOnce(async (_payload: any, options: any) => {
        await options?.callback?.onUsage?.({ totalInputTokens: 100, totalOutputTokens: 50 });
        await options?.callback?.onText?.(
          'Сделано 7 из 10 шагов. Основные результаты сохранены; напишите «Продолжить» для оставшихся 3.',
        );
        await options?.callback?.onToolsCalling?.({
          toolsCalling: [
            {
              function: { arguments: '{}', name: 'mcp-arckep-e2b-sandbox____execute_code____mcp' },
              id: 'phantom-call-1',
              type: 'function',
            },
          ],
        });
        return new Response('done');
      });

      const executors = createRuntimeExecutors(ctx);
      const state = createState({ forceFinish: true, maxSteps: 60, stepCount: 61 });

      const result = await executors.call_llm!(
        {
          payload: {
            messages: [{ content: 'Do complex work', role: 'user' }],
            model: 'gpt-5.6-luna',
            provider: 'openai',
            tools: [],
          },
          type: 'call_llm',
        },
        state,
      );

      // llm_result event carries finishReason: 'max_steps_completed' and empty tool_calls
      expect(result.events).toContainEqual(
        expect.objectContaining({
          result: expect.objectContaining({
            content:
              'Сделано 7 из 10 шагов. Основные результаты сохранены; напишите «Продолжить» для оставшихся 3.',
            finishReason: 'max_steps_completed',
            tool_calls: [],
          }),
          type: 'llm_result',
        }),
      );

      // No tools_calling chunk streamed during forceFinish
      expect(
        mockPublishStreamChunk.mock.calls.some(
          ([, , chunk]) => chunk.chunkType === 'tools_calling',
        ),
      ).toBe(false);

      // nextContext finishes cleanly without tool calls
      expect(result.nextContext?.payload).toMatchObject({
        hasToolsCalling: false,
        result: {
          content:
            'Сделано 7 из 10 шагов. Основные результаты сохранены; напишите «Продолжить» для оставшихся 3.',
          tool_calls: [],
        },
        toolsCalling: [],
      });

      // DB update persists finishReason + usage metadata, paid content, no tools, and NO error
      expect(mockMessageUpdate).toHaveBeenCalledTimes(1);
      const [updatedId, updatePayload] = mockMessageUpdate.mock.calls[0];
      expect(updatedId).toBe('msg-1');
      expect(updatePayload).toMatchObject({
        content:
          'Сделано 7 из 10 шагов. Основные результаты сохранены; напишите «Продолжить» для оставшихся 3.',
        metadata: {
          finishReason: 'max_steps_completed',
          totalInputTokens: 100,
          totalOutputTokens: 50,
        },
        tools: undefined,
      });
      expect(updatePayload.error).toBeUndefined();
    });

    it('preserves paid multimodal image content during max-steps forceFinish', async () => {
      mockChat.mockImplementationOnce(async (_payload: any, options: any) => {
        await options?.callback?.onContentPart?.({
          content: 'Итоговый график готов.',
          partType: 'text',
        });
        await options?.callback?.onContentPart?.({
          content: 'aW1hZ2U=',
          mimeType: 'image/png',
          partType: 'image',
        });
        return new Response('done');
      });

      const executors = createRuntimeExecutors(ctx);
      const state = createState({ forceFinish: true, maxSteps: 60, stepCount: 61 });

      const result = await executors.call_llm!(
        {
          payload: {
            messages: [{ content: 'Render chart', role: 'user' }],
            model: 'gemini-3.7-flash',
            provider: 'google',
            tools: [],
          },
          type: 'call_llm',
        },
        state,
      );

      expect(result.events).toContainEqual(
        expect.objectContaining({
          result: expect.objectContaining({
            finishReason: 'max_steps_completed',
          }),
          type: 'llm_result',
        }),
      );
      const [, updatePayload] = mockMessageUpdate.mock.calls[0];
      expect(updatePayload.metadata).toMatchObject({
        finishReason: 'max_steps_completed',
        isMultimodal: true,
      });
      expect(updatePayload.content).toContain('Итоговый график готов.');
      expect(updatePayload.content).toContain('data:image/png;base64,aW1hZ2U=');
      expect(updatePayload.error).toBeUndefined();
    });

    it('does NOT set max_steps_completed when circuitBreakerTripped is active', async () => {
      mockChat.mockImplementationOnce(async (_payload: any, options: any) => {
        await options?.callback?.onText?.('Инструмент вернул 4 ошибки подряд.');
        return new Response('done');
      });

      const executors = createRuntimeExecutors(ctx);
      const state = createState({
        forceFinish: true,
        toolErrorCircuitBreaker: {
          consecutiveErrors: 4,
          toolKey: 'mcp-arckep-studio-3d::create_3d',
          tripped: true,
        },
      });

      const result = await executors.call_llm!(
        {
          payload: {
            messages: [{ content: 'Make 3D model', role: 'user' }],
            model: 'gpt-5.6-luna',
            provider: 'openai',
            tools: [],
          },
          type: 'call_llm',
        },
        state,
      );

      expect(result.events).toContainEqual(
        expect.objectContaining({
          result: expect.objectContaining({
            finishReason: 'tool_error_limit',
          }),
          type: 'llm_result',
        }),
      );
      const [, updatePayload] = mockMessageUpdate.mock.calls[0];
      expect(updatePayload.metadata?.finishReason).not.toBe('max_steps_completed');
    });

    it('merges forceFinishPrompt into an existing leading system message in the !agentConfig fallback', async () => {
      mockChat.mockImplementationOnce(async (_payload: any, options: any) => {
        await options?.callback?.onText?.('Stopped after consecutive tool errors.');
        return new Response('done');
      });

      const executors = createRuntimeExecutors(ctx); // ctx.agentConfig is undefined
      const state = createState({
        forceFinish: true,
        toolErrorCircuitBreaker: {
          consecutiveErrors: 4,
          toolKey: 'mcp-arckep-studio-3d::create_3d',
          tripped: true,
        },
      });

      const originalSystem = { content: 'Base system instructions.', role: 'system' as const };
      await executors.call_llm!(
        {
          payload: {
            messages: [originalSystem, { content: 'Make 3D model', role: 'user' }],
            model: 'claude-opus-5',
            provider: 'anthropic',
            tools: [],
          },
          type: 'call_llm',
        },
        state,
      );

      expect(originalSystem.content).toBe('Base system instructions.');
      const sentMessages = mockChat.mock.calls[0][0].messages as Array<{
        content: string;
        role: string;
      }>;
      expect(sentMessages.filter((m) => m.role === 'system')).toHaveLength(1);
      expect(sentMessages[0].role).toBe('system');
      expect(sentMessages[0].content).toContain('Base system instructions.\n\n');
      expect(sentMessages[0].content).toContain('mcp-arckep-studio-3d::create_3d');
    });
  });

  describe('call_tool — sandboxAllowInternet forwarding', () => {
    const toolInstruction = {
      payload: {
        parentMessageId: 'assistant-1',
        toolCalling: {
          apiName: 'execute_code',
          arguments: '{"code":"print(1)"}',
          id: 'tc-1',
          identifier: 'mcp-arckep-e2b-sandbox',
          type: 'mcp' as const,
        },
      },
      type: 'call_tool' as const,
    };

    it('passes sandboxAllowInternet=true when native search is enabled', async () => {
      const executors = createRuntimeExecutors(ctx);
      const state = createState({
        metadata: {
          agentConfig: {
            chatConfig: { searchMode: 'auto' },
            model: 'gpt-5.6-luna',
            provider: 'openai',
          },
          agentId: 'agent-1',
          topicId: 'topic-1',
        },
        modelRuntimeConfig: { model: 'gpt-5.6-luna', provider: 'openai' },
      });

      await executors.call_tool!(toolInstruction, state);

      expect(mockExecuteTool).toHaveBeenCalledWith(
        toolInstruction.payload.toolCalling,
        expect.objectContaining({ sandboxAllowInternet: true }),
      );
    });

    it('passes sandboxAllowInternet=false when searchMode=off', async () => {
      const executors = createRuntimeExecutors(ctx);
      const state = createState({
        metadata: {
          agentConfig: {
            chatConfig: { searchMode: 'off' },
            model: 'gpt-5.6-luna',
            provider: 'openai',
          },
          agentId: 'agent-1',
          topicId: 'topic-1',
        },
        modelRuntimeConfig: { model: 'gpt-5.6-luna', provider: 'openai' },
      });

      await executors.call_tool!(toolInstruction, state);

      expect(mockExecuteTool).toHaveBeenCalledWith(
        toolInstruction.payload.toolCalling,
        expect.objectContaining({ sandboxAllowInternet: false }),
      );
    });

    it('passes sandboxAllowInternet=false when legacy searchMode=disabled', async () => {
      const executors = createRuntimeExecutors(ctx);
      const state = createState({
        metadata: {
          agentConfig: {
            chatConfig: { searchMode: 'disabled' },
            model: 'gpt-5.6-luna',
            provider: 'openai',
          },
          agentId: 'agent-1',
          topicId: 'topic-1',
        },
        modelRuntimeConfig: { model: 'gpt-5.6-luna', provider: 'openai' },
      });

      await executors.call_tool!(toolInstruction, state);

      expect(mockExecuteTool).toHaveBeenCalledWith(
        toolInstruction.payload.toolCalling,
        expect.objectContaining({ sandboxAllowInternet: false }),
      );
    });

    it('passes sandboxAllowInternet=false for DeepSeek Pro when Arckep web connector is disabled', async () => {
      const executors = createRuntimeExecutors(ctx);
      const state = createState({
        metadata: {
          agentConfig: {
            chatConfig: { searchMode: 'auto' },
            model: 'deepseek-v4-pro',
            provider: 'deepseek',
          },
          agentId: 'agent-1',
          topicId: 'topic-1',
        },
        modelRuntimeConfig: { model: 'deepseek-v4-pro', provider: 'deepseek' },
        operationToolSet: {
          disabledToolIds: [ARCKEP_WEB_SEARCH_CONNECTOR],
          enabledToolIds: [],
          manifestMap: {},
          sourceMap: {},
          tools: [],
        },
      });

      await executors.call_tool!(toolInstruction, state);

      expect(mockExecuteTool).toHaveBeenCalledWith(
        toolInstruction.payload.toolCalling,
        expect.objectContaining({ sandboxAllowInternet: false }),
      );
    });
  });

  describe('call_tools_batch — sandboxAllowInternet forwarding', () => {
    const batchInstruction = {
      payload: {
        parentMessageId: 'assistant-1',
        toolsCalling: [
          {
            apiName: 'execute_code',
            arguments: '{"code":"print(1)"}',
            id: 'tc-1',
            identifier: 'mcp-arckep-e2b-sandbox',
            type: 'mcp' as const,
          },
          {
            apiName: 'runCommand',
            arguments: '{"command":"ls"}',
            id: 'tc-2',
            identifier: 'lobe-skills',
            type: 'builtin' as const,
          },
        ],
      },
      type: 'call_tools_batch' as const,
    };

    it('forwards sandboxAllowInternet=true for every tool in batch when web search is enabled', async () => {
      const executors = createRuntimeExecutors(ctx);
      const state = createState({
        metadata: {
          agentConfig: {
            chatConfig: { searchMode: 'on' },
            model: 'claude-opus-5',
            provider: 'anthropic',
          },
          agentId: 'agent-1',
          topicId: 'topic-1',
        },
        modelRuntimeConfig: { model: 'claude-opus-5', provider: 'anthropic' },
      });

      await executors.call_tools_batch!(batchInstruction, state);

      expect(mockExecuteTool).toHaveBeenCalledTimes(2);
      for (const [, contextArg] of mockExecuteTool.mock.calls) {
        expect(contextArg.sandboxAllowInternet).toBe(true);
      }
    });

    it('forwards sandboxAllowInternet=false for every tool in batch when searchMode=off', async () => {
      const executors = createRuntimeExecutors(ctx);
      const state = createState({
        metadata: {
          agentConfig: {
            chatConfig: { searchMode: 'off' },
            model: 'claude-opus-5',
            provider: 'anthropic',
          },
          agentId: 'agent-1',
          topicId: 'topic-1',
        },
        modelRuntimeConfig: { model: 'claude-opus-5', provider: 'anthropic' },
      });

      await executors.call_tools_batch!(batchInstruction, state);

      expect(mockExecuteTool).toHaveBeenCalledTimes(2);
      for (const [, contextArg] of mockExecuteTool.mock.calls) {
        expect(contextArg.sandboxAllowInternet).toBe(false);
      }
    });

    it('forwards sandboxAllowInternet=false in cron mode (useModelBuiltinSearch=false) when web connector is disabled', async () => {
      const executors = createRuntimeExecutors(ctx);
      const state = createState({
        metadata: {
          agentConfig: {
            chatConfig: { searchMode: 'auto', useModelBuiltinSearch: false },
            model: 'gpt-5.6-luna',
            provider: 'openai',
          },
          agentId: 'agent-1',
          topicId: 'topic-1',
        },
        modelRuntimeConfig: { model: 'gpt-5.6-luna', provider: 'openai' },
        operationToolSet: {
          disabledToolIds: [ARCKEP_WEB_SEARCH_CONNECTOR],
          enabledToolIds: [],
          manifestMap: {},
          sourceMap: {},
          tools: [],
        },
      });

      await executors.call_tools_batch!(batchInstruction, state);

      expect(mockExecuteTool).toHaveBeenCalledTimes(2);
      for (const [, contextArg] of mockExecuteTool.mock.calls) {
        expect(contextArg.sandboxAllowInternet).toBe(false);
      }
    });
  });
});
