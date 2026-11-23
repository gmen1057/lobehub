// @vitest-environment node
import {
  type AgentState,
  DEFAULT_SECURITY_BLACKLIST,
  GeneralChatAgent,
} from '@lobechat/agent-runtime';
import { LobeActivatorIdentifier } from '@lobechat/builtin-tool-activator';
import type { LobeToolManifest, OperationToolSet } from '@lobechat/context-engine';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { serverMessagesEngine } from '@/server/modules/Mecha/ContextEngineering';
import { initModelRuntimeFromDB } from '@/server/modules/ModelRuntime';

import { parseToolCalls } from '../../../../../packages/model-runtime/src/helpers/parseToolCalls';
import {
  createRuntimeExecutors,
  type RuntimeExecutorContext,
  UNRESOLVED_TOOL_FEEDBACK_LIMIT,
} from '../RuntimeExecutors';

vi.mock('@/server/modules/ModelRuntime', () => ({ initModelRuntimeFromDB: vi.fn() }));
vi.mock('@/server/modules/Mecha/ContextEngineering', () => ({ serverMessagesEngine: vi.fn() }));
vi.mock('@/server/modules/Mecha/ContextEngineering/toolResultImageUrl', () => ({
  createToolImageUrlResolver: vi.fn(() => vi.fn()),
}));
vi.mock('@/server/services/message', () => ({ MessageService: vi.fn() }));
vi.mock('@/server/services/file', () => ({ FileService: vi.fn() }));
vi.mock('@/server/services/agentDocuments', () => ({
  AgentDocumentsService: vi.fn().mockImplementation(() => ({
    getAgentDocuments: vi.fn().mockResolvedValue([]),
  })),
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
vi.mock('../arckepSearch', () => ({ resolveServerEnabledSearch: vi.fn(async () => false) }));
vi.mock('../serverModelParams', () => ({ resolveServerModelParams: vi.fn(async () => ({})) }));
vi.mock('../llmTrace', () => ({
  createEngineTraceCallbacks: vi.fn(),
  withEngineTrace: (_: unknown, callbacks: unknown) => callbacks,
}));

const activatorManifest: LobeToolManifest = {
  api: [
    {
      description: 'Activate deferred tools',
      name: 'activateTools',
      parameters: {
        properties: { identifiers: { items: { type: 'string' }, type: 'array' } },
        type: 'object',
      },
    },
  ],
  identifier: LobeActivatorIdentifier,
  meta: { description: 'Tool activator', title: 'Activator' },
  type: 'builtin',
};

const kbManifest: LobeToolManifest = {
  api: [
    {
      description: 'Read knowledge file chunks',
      name: 'readKnowledge',
      parameters: { properties: { fileId: { type: 'string' } }, type: 'object' },
    },
  ],
  identifier: 'lobe-knowledge-base',
  meta: { description: 'Knowledge base reader', title: 'Knowledge Base' },
  type: 'builtin',
};

const webManifest: LobeToolManifest = {
  api: [
    {
      description: 'Search the web',
      name: 'search',
      parameters: { properties: { query: { type: 'string' } }, type: 'object' },
    },
  ],
  identifier: 'lobe-web-browsing',
  meta: { description: 'Web search', title: 'Web Browsing' },
  type: 'builtin',
};

const createBaseOperationToolSet = (overrides?: Partial<OperationToolSet>): OperationToolSet => ({
  disabledToolIds: ['arckep-studio', 'lobe-cron'],
  enabledToolIds: [LobeActivatorIdentifier, 'lobe-web-browsing'],
  manifestMap: {
    [LobeActivatorIdentifier]: activatorManifest,
    'lobe-knowledge-base': kbManifest,
    'lobe-web-browsing': webManifest,
  },
  sourceMap: {
    [LobeActivatorIdentifier]: 'builtin',
    'lobe-knowledge-base': 'builtin',
    'lobe-web-browsing': 'builtin',
  },
  tools: [],
  ...overrides,
});

const createBaseState = (overrides?: Partial<AgentState>): AgentState => ({
  cost: {
    calculatedAt: new Date().toISOString(),
    currency: 'USD',
    llm: { byModel: [], currency: 'USD', total: 0 },
    tools: { byTool: [], currency: 'USD', total: 0 },
    total: 0,
  },
  createdAt: new Date().toISOString(),
  lastModified: new Date().toISOString(),
  maxSteps: 20,
  messages: [{ content: 'Read the document', role: 'user' }],
  metadata: {
    agentId: 'agent-1',
    threadId: 'thread-1',
    topicId: 'topic-1',
  },
  modelRuntimeConfig: { model: 'gpt-4', provider: 'openai' },
  operationId: 'op-unresolved',
  operationToolSet: createBaseOperationToolSet(),
  securityBlacklist: DEFAULT_SECURITY_BLACKLIST,
  status: 'running',
  stepCount: 0,
  toolManifestMap: {
    [LobeActivatorIdentifier]: activatorManifest,
    'lobe-knowledge-base': kbManifest,
    'lobe-web-browsing': webManifest,
  },
  usage: {
    humanInteraction: {
      approvalRequests: 0,
      promptRequests: 0,
      selectRequests: 0,
      totalWaitingTimeMs: 0,
    },
    llm: { apiCalls: 0, processingTimeMs: 0, tokens: { input: 0, output: 0, total: 0 } },
    tools: { byTool: [], totalCalls: 0, totalTimeMs: 0 },
  },
  ...overrides,
});

describe('RuntimeExecutors — unresolved tool calls, diagnostics, feedback & 2-strike stop', () => {
  let ctx: RuntimeExecutorContext;
  let mockMessageModel: any;
  let mockStreamManager: any;
  let mockToolExecutionService: any;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(serverMessagesEngine).mockImplementation(async (params) => {
      params.onSourceIds?.(params.messages.map((m) => m.id));
      return params.messages as any;
    });

    let msgSeq = 0;
    mockMessageModel = {
      addFiles: vi.fn(),
      create: vi.fn(async () => ({ id: `db-msg-${++msgSeq}` })),
      query: vi.fn(async () => []),
      update: vi.fn(async () => ({})),
    };
    mockStreamManager = {
      publishStreamChunk: vi.fn(async () => 'chunk-1'),
      publishStreamEvent: vi.fn(async () => 'evt-1'),
    };
    mockToolExecutionService = {
      executeTool: vi.fn(async () => ({
        content: '{"ok":true}',
        error: null,
        executionTime: 15,
        state: {},
        success: true,
      })),
    };
    ctx = {
      agentConfig: { plugins: [], systemRole: 'Helpful assistant' },
      loadAgentState: vi.fn(async () => null),
      messageModel: mockMessageModel,
      operationId: 'op-unresolved',
      serverDB: {} as any,
      stepIndex: 0,
      streamManager: mockStreamManager,
      toolExecutionService: mockToolExecutionService,
      topicId: 'topic-1',
      userId: 'user-1',
    };
  });

  const mockLLMToolCalls = (
    rawCalls: Array<{ arguments?: string; id: string; name: string }>,
    textContent = '',
  ) => {
    const chat = vi.fn(async (_payload: any, options: any) => {
      if (textContent) {
        await options.callback.onText?.(textContent);
      }
      await options.callback.onToolsCalling?.({
        toolsCalling: rawCalls.map((c) => ({
          function: { arguments: c.arguments ?? '{}', name: c.name },
          id: c.id,
          type: 'function' as const,
        })),
      });
      return new Response('done');
    });
    vi.mocked(initModelRuntimeFromDB).mockResolvedValueOnce({ chat } as any);
    return chat;
  };

  it('forwards disabledToolIdentifiers (excluding active tools) to serverMessagesEngine and strips synthetic manifest from state fallback', async () => {
    const chat = vi.fn(async () => new Response('done'));
    vi.mocked(initModelRuntimeFromDB).mockResolvedValueOnce({ chat } as any);

    const state = createBaseState({
      operationToolSet: createBaseOperationToolSet({
        // Edge overlap: lobe-web-browsing is active in enabledToolIds and must be filtered out
        disabledToolIds: ['arckep-studio', 'lobe-cron', 'lobe-web-browsing'],
      }),
    });

    await createRuntimeExecutors(ctx).call_llm!(
      {
        payload: { messages: state.messages, model: 'gpt-4', provider: 'openai' },
        type: 'call_llm',
      } as any,
      state,
    );

    const engineCall = vi.mocked(serverMessagesEngine).mock.calls[0][0];
    expect(engineCall.toolsConfig?.disabledToolIdentifiers).toEqual(['arckep-studio', 'lobe-cron']);

    // Legacy fallback path without state.operationToolSet must also strip __arckep_unresolved_tool__
    vi.mocked(initModelRuntimeFromDB).mockResolvedValueOnce({ chat } as any);
    const legacyState = createBaseState({
      operationToolSet: undefined,
      toolManifestMap: {
        [LobeActivatorIdentifier]: activatorManifest,
        __arckep_unresolved_tool__: {
          api: [{ description: 'noop', name: 'bad', parameters: {} }],
          identifier: '__arckep_unresolved_tool__',
          meta: { title: 'Unresolved' },
          type: 'builtin',
        } as any,
      },
    });
    // Override enabledToolIds via activatedStepTools so activator is active for discovery check
    legacyState.activatedStepTools = [
      {
        activatedAtStep: 0,
        id: LobeActivatorIdentifier,
        manifest: activatorManifest,
        source: 'discovery',
      },
    ];

    await createRuntimeExecutors(ctx).call_llm!(
      {
        payload: { messages: legacyState.messages, model: 'gpt-4', provider: 'openai' },
        type: 'call_llm',
      } as any,
      legacyState,
    );

    const secondEngineCall = vi.mocked(serverMessagesEngine).mock.calls[1][0];
    expect(
      secondEngineCall.toolDiscoveryConfig?.availableTools?.map((t) => t.identifier) ?? [],
    ).not.toContain('__arckep_unresolved_tool__');
  });

  it('first unresolved call to lazy tool: sanitizes wire name, hides synthetic id from stream, bypasses human intervention in all modes, and returns structured activateTools hint via call_tool', async () => {
    mockLLMToolCalls([
      {
        arguments: '{"cmd":"rm -rf /","fileId":"f1"}',
        id: 'call-lazy-1',
        name: 'lobe-knowledge-base.readKnowledge',
      },
    ]);

    const executors = createRuntimeExecutors(ctx);
    const state = createBaseState();

    const llmOut = await executors.call_llm!(
      {
        payload: { messages: state.messages, model: 'gpt-4', provider: 'openai' },
        type: 'call_llm',
      } as any,
      state,
    );

    // 1. Synthetic tool call is NEVER published to stream chunks or stream_end
    expect(mockStreamManager.publishStreamChunk).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ chunkType: 'tools_calling' }),
    );
    const streamEndCall = mockStreamManager.publishStreamEvent.mock.calls.find(
      ([, evt]: any[]) => evt.type === 'stream_end',
    );
    expect(streamEndCall?.[1]?.data?.toolsCalling).toEqual([]);

    // 2. Wire function.name in assistant.tool_calls has no '.' or '/' and fits OpenAI/Anthropic regex
    const savedAssistantMsg = llmOut.newState.messages.at(-1)!;
    const wireFnName = savedAssistantMsg.tool_calls?.[0]?.function?.name ?? '';
    expect(wireFnName).toMatch(/^[\w-]{1,64}$/);
    expect(wireFnName).not.toContain('.');
    expect(wireFnName).not.toContain('/');

    // 3. Counter = 1 and structured error recommends lobe-activator____activateTools
    expect(llmOut.newState.metadata?.consecutiveUnresolvedToolCalls).toBe(1);
    const pendingErr = llmOut.newState.metadata?.pendingUnresolvedToolErrors?.['call-lazy-1'];
    expect(pendingErr).toBe(
      'Tool "lobe-knowledge-base.readKnowledge" is not active in this step. Call lobe-activator____activateTools first to activate it, or choose from currently enabled tools.',
    );

    // 4. Real GeneralChatAgent passes synthetic call straight to call_tool in ALL 4 approval modes
    const agent = new GeneralChatAgent({ operationId: 'op-unresolved' });
    for (const approvalMode of ['manual', 'allow-list', 'auto-run', 'headless'] as const) {
      const modeState: AgentState = {
        ...llmOut.newState,
        userInterventionConfig: { allowList: [], approvalMode },
      };
      const nextInstruction = await agent.runner(llmOut.nextContext!, modeState);
      const list = Array.isArray(nextInstruction) ? nextInstruction : [nextInstruction];
      expect(
        list.map((i) => i.type),
        `mode=${approvalMode}`,
      ).toEqual(['call_tool']);
    }

    // 5. call_tool intercepts BEFORE toolExecutionService.executeTool and cleans pending state
    const [callToolInstruction] = (await agent.runner(llmOut.nextContext!, {
      ...llmOut.newState,
      userInterventionConfig: { approvalMode: 'manual' },
    })) as any[];

    const toolOut = await executors.call_tool!(callToolInstruction, llmOut.newState);
    expect(mockToolExecutionService.executeTool).not.toHaveBeenCalled();
    // Synthetic __arckep_unresolved_tool__ MUST NEVER be persisted to PostgreSQL (neither assistant.tools nor role='tool')
    expect(mockMessageModel.update).toHaveBeenCalledWith(
      'db-msg-1',
      expect.objectContaining({
        tools: undefined,
      }),
    );
    expect(mockMessageModel.create).toHaveBeenCalledTimes(1); // Only initial assistant row db-msg-1, 0 synthetic tool rows!
    expect(llmOut.newState.metadata?.reuseAssistantMessageId).toBe('db-msg-1');

    const toolMsg = toolOut.newState.messages.at(-1)!;
    expect(toolMsg).toMatchObject({
      role: 'tool',
      tool_call_id: 'call-lazy-1',
    });
    expect(JSON.parse(toolMsg.content as string)).toEqual({
      error: pendingErr,
      success: false,
      synthetic: true,
    });
    expect(toolOut.newState.metadata?.pendingUnresolvedToolErrors).toBeUndefined();
    expect(toolOut.newState.toolManifestMap?.__arckep_unresolved_tool__).toBeUndefined();

    // Follow-up Step 1 call_llm reuses db-msg-1 (no orphan empty assistant row in DB) and keeps synthetic feedback while streak=1
    const step1Instruction = (await agent.runner(toolOut.nextContext!, toolOut.newState)) as any;
    const step1Chat = vi.fn(async (_p: any, opts: any) => {
      await opts.callback.onText?.('Исправленный ответ');
      return new Response('done');
    });
    vi.mocked(initModelRuntimeFromDB).mockResolvedValueOnce({ chat: step1Chat } as any);
    const step1Out = await executors.call_llm!(step1Instruction, toolOut.newState);
    expect(mockMessageModel.create).toHaveBeenCalledTimes(1); // Still 1: reused db-msg-1!
    expect(mockMessageModel.update).toHaveBeenLastCalledWith(
      'db-msg-1',
      expect.objectContaining({ content: 'Исправленный ответ', tools: undefined }),
    );
    expect(step1Out.newState.metadata?.reuseAssistantMessageId).toBeUndefined();
    const step1EngineInput = vi.mocked(serverMessagesEngine).mock.calls.at(-1)?.[0];
    expect(step1EngineInput?.toolsConfig?.disabledToolIdentifiers ?? []).not.toContain(
      '__arckep_unresolved_tool__',
    );
  });

  it('distinguishes disabled tools and completely unknown tools in structured feedback messages', async () => {
    mockLLMToolCalls([
      { id: 'call-dis', name: 'arckep-studio____createImage' },
      { id: 'call-unk', name: 'mystery_plugin/doMagic' },
    ]);

    const executors = createRuntimeExecutors(ctx);
    const llmOut = await executors.call_llm!(
      {
        payload: {
          messages: [{ content: 'Generate', role: 'user' }],
          model: 'gpt-4',
          provider: 'openai',
        },
        type: 'call_llm',
      } as any,
      createBaseState(),
    );

    expect(llmOut.newState.metadata?.pendingUnresolvedToolErrors).toEqual({
      'call-dis':
        'Tool "arckep-studio____createImage" is disabled in this conversation and cannot be used.',
      'call-unk':
        'Tool "mystery_plugin/doMagic" is not available in this step. Check active tool names (format: identifier____apiName) and try again.',
    });

    // Batch execution via GeneralChatAgent -> call_tools_batch
    const agent = new GeneralChatAgent({ operationId: 'op-unresolved' });
    const [batchInstruction] = (await agent.runner(llmOut.nextContext!, llmOut.newState)) as any[];
    expect(batchInstruction.type).toBe('call_tools_batch');

    const batchOut = await executors.call_tools_batch!(batchInstruction, llmOut.newState);
    expect(mockToolExecutionService.executeTool).not.toHaveBeenCalled();
    const toolMessages = batchOut.newState.messages.filter((m: any) => m.role === 'tool');
    expect(toolMessages.map((m: any) => m.tool_call_id)).toEqual(['call-dis', 'call-unk']);
    expect(batchOut.newState.metadata?.pendingUnresolvedToolErrors).toBeUndefined();
  });

  it('stops cleanly on the 2nd consecutive unresolved step without a 3rd LLM call or empty bubble', async () => {
    expect(UNRESOLVED_TOOL_FEEDBACK_LIMIT).toBe(2);
    mockLLMToolCalls([{ id: 'call-miss-2', name: 'arckep-studio____createImage' }]);

    const executors = createRuntimeExecutors(ctx);
    const stateAfterFirstMiss = createBaseState({
      metadata: {
        agentId: 'agent-1',
        consecutiveUnresolvedToolCalls: 1,
        threadId: 'thread-1',
        topicId: 'topic-1',
      },
    });

    const llmOut = await executors.call_llm!(
      {
        payload: { messages: stateAfterFirstMiss.messages, model: 'gpt-4', provider: 'openai' },
        type: 'call_llm',
      } as any,
      stateAfterFirstMiss,
    );

    expect(llmOut.newState.metadata?.consecutiveUnresolvedToolCalls).toBe(2);
    expect(llmOut.nextContext?.payload).toMatchObject({
      hasToolsCalling: false,
      toolsCalling: [],
    });
    expect((llmOut.nextContext?.payload as any)?.result?.content?.trim().length).toBeGreaterThan(0);
    // SSE text delta must be emitted when UNRESOLVED_TOOL_STOP_MESSAGE replaces empty content
    expect(mockStreamManager.publishStreamChunk).toHaveBeenCalledWith(
      'op-unresolved',
      0,
      expect.objectContaining({
        chunkType: 'text',
        content: expect.stringContaining('недоступному инструменту'),
      }),
    );
    expect(llmOut.events).toContainEqual(
      expect.objectContaining({
        chunk: expect.objectContaining({ type: 'text' }),
        type: 'llm_stream',
      }),
    );
    expect(llmOut.events).toContainEqual(
      expect.objectContaining({
        result: expect.objectContaining({ finishReason: 'unresolved_tool_call_limit' }),
        type: 'llm_result',
      }),
    );

    const agent = new GeneralChatAgent({ operationId: 'op-unresolved' });
    const nextInstruction = await agent.runner(llmOut.nextContext!, llmOut.newState);
    expect(nextInstruction).toMatchObject({ type: 'finish' });
  });

  it('resets consecutiveUnresolvedToolCalls to 0 on repaired/valid calls and handles mixed batches cleanly', async () => {
    // 1. Mixed batch: 1 repaired valid call + 1 unresolved call
    mockLLMToolCalls([
      { arguments: '{"query":"vitest"}', id: 'call-valid', name: 'lobe-web-browsing/search' },
      { arguments: '{}', id: 'call-bad', name: 'lobe-knowledge-base/readKnowledge' },
    ]);

    const executors = createRuntimeExecutors(ctx);
    const stateWithPriorMiss = createBaseState({
      metadata: {
        agentId: 'agent-1',
        consecutiveUnresolvedToolCalls: 1,
        threadId: 'thread-1',
        topicId: 'topic-1',
      },
    });

    const llmOut = await executors.call_llm!(
      {
        payload: { messages: stateWithPriorMiss.messages, model: 'gpt-4', provider: 'openai' },
        type: 'call_llm',
      } as any,
      stateWithPriorMiss,
    );

    // Valid call in mixed batch resets consecutiveUnresolvedToolCalls to 0
    expect(llmOut.newState.metadata?.consecutiveUnresolvedToolCalls).toBe(0);

    // Repaired valid call updated in raw tool_calls, synthetic call got safe wire name
    const savedToolCalls = llmOut.newState.messages.at(-1)!.tool_calls!;
    expect(savedToolCalls[0].function.name).toContain('lobe-web-browsing____search');
    expect(savedToolCalls[1].function.name).toMatch(/^__arckep_unresolved_tool______/);

    // Only the valid call was published in tools_calling stream chunk
    expect(mockStreamManager.publishStreamChunk).toHaveBeenCalledTimes(1);
    expect(mockStreamManager.publishStreamChunk).toHaveBeenCalledWith(
      'op-unresolved',
      0,
      expect.objectContaining({
        chunkType: 'tools_calling',
        toolsCalling: [
          expect.objectContaining({ apiName: 'search', identifier: 'lobe-web-browsing' }),
        ],
      }),
    );

    // Repeat guard counted ONLY the resolved tool call
    const repeatKeys = Object.keys(llmOut.newState.toolCallRepeatGuard?.counts ?? {});
    expect(repeatKeys).toHaveLength(1);
    expect(repeatKeys[0]).toContain('lobe-web-browsing');

    // Execute mixed batch: real tool runs via executeTool & persists to DB, unresolved stays in memory only (even across assistantGroup DB reload)
    const now = Date.now();
    mockMessageModel.query.mockResolvedValueOnce([
      { content: 'Search and read', createdAt: now, id: 'u-1', role: 'user', updatedAt: now },
      {
        content: '',
        createdAt: now + 1,
        id: 'db-msg-1',
        parentId: 'u-1',
        role: 'assistant',
        tools: [
          {
            apiName: 'search',
            arguments: '{"query":"vitest"}',
            id: 'call-valid',
            identifier: 'lobe-web-browsing',
            type: 'builtin',
          },
        ],
        updatedAt: now + 1,
      },
      {
        content: '{"ok":true}',
        createdAt: now + 2,
        id: 'db-msg-2',
        parentId: 'db-msg-1',
        plugin: {
          apiName: 'search',
          arguments: '{"query":"vitest"}',
          id: 'call-valid',
          identifier: 'lobe-web-browsing',
          type: 'builtin',
        },
        role: 'tool',
        tool_call_id: 'call-valid',
        updatedAt: now + 2,
      },
    ]);

    const agent = new GeneralChatAgent({ operationId: 'op-unresolved' });
    const [batchInstruction] = (await agent.runner(llmOut.nextContext!, {
      ...llmOut.newState,
      userInterventionConfig: { approvalMode: 'auto-run' },
    })) as any[];
    expect(batchInstruction.type).toBe('call_tools_batch');

    const batchOut = await executors.call_tools_batch!(batchInstruction, llmOut.newState);
    expect(mockToolExecutionService.executeTool).toHaveBeenCalledTimes(1);
    expect(mockToolExecutionService.executeTool).toHaveBeenCalledWith(
      expect.objectContaining({ apiName: 'search', identifier: 'lobe-web-browsing' }),
      expect.anything(),
    );
    // DB only persisted 1 assistant (with ONLY real tool) + 1 real tool row (0 __arckep_unresolved_tool__ rows!)
    expect(mockMessageModel.update).toHaveBeenCalledWith(
      'db-msg-1',
      expect.objectContaining({
        tools: [expect.objectContaining({ id: 'call-valid', identifier: 'lobe-web-browsing' })],
      }),
    );
    expect(mockMessageModel.create).toHaveBeenCalledTimes(2); // db-msg-1 (assistant) + db-msg-2 (real tool)
    const groupMsg: any = batchOut.newState.messages.find((m: any) => m.role === 'assistantGroup');
    expect(groupMsg).toBeDefined();
    const synChildTool = groupMsg.children[0].tools.find((t: any) => t.id === 'call-bad');
    expect(synChildTool).toBeDefined();
    expect(JSON.parse(synChildTool.result.content)).toMatchObject({
      success: false,
      synthetic: true,
    });
  });

  it('passes client function tools (source === client) via passthroughIdentifiers without marking them unresolved', async () => {
    mockLLMToolCalls([
      {
        arguments: '{"city":"Moscow"}',
        id: 'call-client-1',
        name: 'lobe-client-fn____get_weather',
      },
    ]);

    const state = createBaseState({
      operationToolSet: createBaseOperationToolSet({
        enabledToolIds: [LobeActivatorIdentifier, 'lobe-client-fn'],
        manifestMap: {
          [LobeActivatorIdentifier]: activatorManifest,
        },
        sourceMap: {
          [LobeActivatorIdentifier]: 'builtin',
          'lobe-client-fn': 'client',
        },
      }),
    });

    const llmOut = await createRuntimeExecutors(ctx).call_llm!(
      {
        payload: { messages: state.messages, model: 'gpt-4', provider: 'openai' },
        type: 'call_llm',
      } as any,
      state,
    );

    expect(llmOut.newState.metadata?.consecutiveUnresolvedToolCalls).toBe(0);
    expect(llmOut.newState.metadata?.pendingUnresolvedToolErrors).toBeUndefined();
    expect((llmOut.nextContext?.payload as any)?.toolsCalling).toEqual([
      expect.objectContaining({
        apiName: 'get_weather',
        identifier: 'lobe-client-fn',
        source: 'client',
      }),
    ]);
  });

  it('handles deeply Object.freeze and Immer-frozen parseToolCalls output across both repaired and unresolved branches without TypeError', async () => {
    // 1. Real Immer-frozen output from parseToolCalls (reproduces production 500 crash)
    const immerFrozenCalls = parseToolCalls(
      [],
      [
        {
          function: { arguments: '{"query":"immer"}', name: 'lobe-web-browsing/search' },
          id: 'call-immer-repaired',
          index: 0,
          type: 'function',
        },
        {
          function: { arguments: '{"fileId":"f1"}', name: 'lobe-knowledge-base.readKnowledge' },
          id: 'call-immer-unresolved',
          index: 1,
          type: 'function',
        },
      ],
    );
    expect(Object.isFrozen(immerFrozenCalls)).toBe(true);
    expect(Object.isFrozen(immerFrozenCalls[0])).toBe(true);
    expect(Object.isFrozen(immerFrozenCalls[0].function)).toBe(true);
    expect(Object.isFrozen(immerFrozenCalls[1].function)).toBe(true);

    const chatImmer = vi.fn(async (_payload: any, options: any) => {
      await options.callback.onToolsCalling?.({ toolsCalling: immerFrozenCalls });
      return new Response('done');
    });
    vi.mocked(initModelRuntimeFromDB).mockResolvedValueOnce({ chat: chatImmer } as any);

    const executors = createRuntimeExecutors(ctx);
    const state = createBaseState();
    const immerOut = await executors.call_llm!(
      {
        payload: { messages: state.messages, model: 'gpt-4', provider: 'openai' },
        type: 'call_llm',
      } as any,
      state,
    );

    const immerSavedCalls = immerOut.newState.messages.at(-1)!.tool_calls!;
    expect(immerSavedCalls[0].function.name).toContain('lobe-web-browsing____search');
    expect(immerSavedCalls[1].function.name).toMatch(/^__arckep_unresolved_tool______/);
    // Original frozen inputs remain untouched
    expect(immerFrozenCalls[0].function.name).toBe('lobe-web-browsing/search');
    expect(immerFrozenCalls[1].function.name).toBe('lobe-knowledge-base.readKnowledge');

    // 2. Explicitly Object.freeze'd array + objects for both branches
    const manuallyFrozenCalls = Object.freeze([
      Object.freeze({
        function: Object.freeze({
          arguments: '{"query":"frozen"}',
          name: 'lobe-web-browsing/search',
        }),
        id: 'call-freeze-repaired',
        type: 'function' as const,
      }),
      Object.freeze({
        function: Object.freeze({
          arguments: '{}',
          name: 'arckep-text-file/writePart',
        }),
        id: 'call-freeze-unresolved',
        type: 'function' as const,
      }),
    ]);

    const chatFrozen = vi.fn(async (_payload: any, options: any) => {
      await options.callback.onToolsCalling?.({ toolsCalling: manuallyFrozenCalls });
      return new Response('done');
    });
    vi.mocked(initModelRuntimeFromDB).mockResolvedValueOnce({ chat: chatFrozen } as any);

    const frozenOut = await executors.call_llm!(
      {
        payload: { messages: state.messages, model: 'gpt-4', provider: 'openai' },
        type: 'call_llm',
      } as any,
      state,
    );

    const frozenSavedCalls = frozenOut.newState.messages.at(-1)!.tool_calls!;
    expect(frozenSavedCalls[0].function.name).toContain('lobe-web-browsing____search');
    expect(frozenSavedCalls[1].function.name).toMatch(/^__arckep_unresolved_tool______/);
    expect(manuallyFrozenCalls[0].function.name).toBe('lobe-web-browsing/search');
    expect(manuallyFrozenCalls[1].function.name).toBe('arckep-text-file/writePart');
  });
});
