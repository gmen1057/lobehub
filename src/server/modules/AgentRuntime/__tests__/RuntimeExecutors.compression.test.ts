// @vitest-environment node
import {
  AgentRuntime,
  calculatePromptTokens,
  estimateTokens,
  GeneralChatAgent,
  shouldCompress,
} from '@lobechat/agent-runtime';
import { LOADING_FLAT } from '@lobechat/const';
import { type ChatStreamPayload } from '@lobechat/model-runtime';
import { chainCompressContext } from '@lobechat/prompts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { initModelRuntimeFromDB } from '@/server/modules/ModelRuntime';
import { MessageService } from '@/server/services/message';

import { buildDefaultAnthropicPayload } from '../../../../../packages/model-runtime/src/core/anthropicCompatibleFactory';
import {
  DATA_GUARD_COMPRESSION_MODEL,
  DEFAULT_COMPRESSION_MODEL,
  EFFECTIVE_AUTO_COMPRESS_WINDOW_CAP,
  FLAT_LONG_CONTEXT_INITIAL_RATIO,
  FLAT_LONG_CONTEXT_RECOMPRESSION_RATIO,
  resolveCompressionModelConfig,
  resolveCompressionThresholds,
} from '../compressionThresholds';
import {
  createRuntimeExecutors,
  estimateDeepSeekUserTurnTokens,
  splitTextToTokenBudget,
} from '../RuntimeExecutors';

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
vi.mock('@lobechat/prompts', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    chainCompressContext: vi.fn(actual.chainCompressContext as typeof chainCompressContext),
  };
});

const makeMessagesWithTokens = (approxTokens: number) => [
  {
    content: 'Earlier reply',
    id: 'msg-history-asst',
    metadata: { usage: { totalOutputTokens: approxTokens } },
    role: 'assistant',
  },
  { content: 'Follow-up question', id: 'msg-user-latest', role: 'user' },
];

describe('ENG-2A: compressionThresholds & GeneralChatAgent auto-compression limits', () => {
  it('resolves deepseek/deepseek-flash to the flat 1M policy (345K initial, 415K recompression, 850K mid-turn emergency)', async () => {
    const policy = resolveCompressionThresholds('deepseek-flash', 'deepseek');
    expect(policy).toEqual({
      maxWindowToken: EFFECTIVE_AUTO_COMPRESS_WINDOW_CAP,
      midTurnThresholdRatio: 0.85,
      physicalWindowToken: 1_000_000,
      recompressionThresholdRatio: FLAT_LONG_CONTEXT_RECOMPRESSION_RATIO,
      thresholdRatio: FLAT_LONG_CONTEXT_INITIAL_RATIO,
    });
    expect(resolveCompressionThresholds('deepseek-flash')).toEqual(policy);

    // Must NOT prematurely compress below 345K (regression: 32_768 override caused 22K/26K loops)
    for (const tokens of [24_000, 35_000, 70_000, 150_000, 340_000]) {
      expect(shouldCompress(makeMessagesWithTokens(tokens), policy).needsCompression).toBe(false);
    }

    // Triggers above 345K
    const check350k = shouldCompress(makeMessagesWithTokens(350_000), policy);
    expect(check350k.threshold).toBe(345_000);
    expect(check350k.needsCompression).toBe(true);

    // Hysteresis after first compression holds until 415K
    const agent = new GeneralChatAgent({
      compressionConfig: { ...policy, enabled: true },
      modelRuntimeConfig: { model: 'deepseek-flash', provider: 'deepseek' },
      operationId: 'op-ds-flash',
    });
    const stateAfterFirstCompress = AgentRuntime.createInitialState({
      messages: [
        { content: 'Summary of earlier turns', id: 'grp-1', role: 'compressedGroup' },
        ...makeMessagesWithTokens(390_000),
      ] as any,
      operationId: 'op-ds-flash',
      status: 'running',
    });
    await expect(
      agent.runner({ payload: {}, phase: 'user_input' }, stateAfterFirstCompress),
    ).resolves.toMatchObject({ type: 'call_llm' });

    // Mid-turn (tool_result) uses emergency physical window (850K), NOT Step-0 working threshold (345K):
    // 450K mid-turn finishes uninterrupted on warm cache, while 860K mid-turn emergency-compresses
    // and 360K at Step 0 compresses normally.
    const makeMidTurnState = (tokens: number) =>
      AgentRuntime.createInitialState({
        messages: [
          ...makeMessagesWithTokens(tokens),
          { content: 'Tool result', id: 'msg-t1', role: 'tool' },
        ] as any,
        operationId: 'op-ds-flash',
        status: 'running',
      });
    await expect(
      agent.runner(
        { payload: { parentMessageId: 'msg-t1' }, phase: 'tool_result' },
        makeMidTurnState(450_000),
      ),
    ).resolves.toMatchObject({ type: 'call_llm' });
    await expect(
      agent.runner(
        { payload: { parentMessageId: 'msg-t1' }, phase: 'tool_result' },
        makeMidTurnState(860_000),
      ),
    ).resolves.toMatchObject({ payload: { parentMessageId: 'msg-t1' }, type: 'compress_context' });
    await expect(
      agent.runner(
        { payload: { parentMessageId: 'msg-user-latest' }, phase: 'user_input' },
        AgentRuntime.createInitialState({
          messages: makeMessagesWithTokens(360_000) as any,
          operationId: 'op-ds-flash',
          status: 'running',
        }),
      ),
    ).resolves.toMatchObject({ type: 'compress_context' });
  });

  it.each([
    ['anthropic', 'claude-sonnet-5-5'],
    ['anthropic', 'claude-opus-5-5'],
    ['anthropic', 'claude-fable-5-2'],
    ['google', 'gemini-4-carbon'],
    ['deepseek', 'deepseek-flash'],
    ['deepseek', 'deepseek-v4-pro'],
    ['qwen', 'qwen4-max'],
  ])(
    'resolves flat 1M model %s/%s to 345K initial / 415K recompression',
    async (provider, model) => {
      const policy = resolveCompressionThresholds(model, provider);
      expect(policy).toEqual({
        maxWindowToken: 1_000_000,
        midTurnThresholdRatio: 0.85,
        physicalWindowToken: expect.any(Number),
        recompressionThresholdRatio: 0.415,
        thresholdRatio: 0.345,
      });
      expect(policy.physicalWindowToken).toBeGreaterThanOrEqual(1_000_000);

      expect(shouldCompress(makeMessagesWithTokens(70_000), policy).needsCompression).toBe(false);
      expect(shouldCompress(makeMessagesWithTokens(340_000), policy).needsCompression).toBe(false);

      const over345k = shouldCompress(makeMessagesWithTokens(350_000), policy);
      expect(over345k.threshold).toBe(345_000);
      expect(over345k.needsCompression).toBe(true);

      const agent = new GeneralChatAgent({
        compressionConfig: { ...policy, enabled: true },
        modelRuntimeConfig: { model, provider },
        operationId: 'op-1m',
      });
      const at390kWithSummary = AgentRuntime.createInitialState({
        messages: [
          { content: 'Prior summary', id: 'grp-1', role: 'compressedGroup' },
          ...makeMessagesWithTokens(390_000),
        ] as any,
        operationId: 'op-1m',
        status: 'running',
      });
      const stepAt390k = await agent.runner(
        { payload: {}, phase: 'user_input' },
        at390kWithSummary,
      );
      expect((stepAt390k as any).type).toBe('call_llm');

      const at420kWithSummary = AgentRuntime.createInitialState({
        messages: [
          { content: 'Prior summary', id: 'grp-1', role: 'compressedGroup' },
          ...makeMessagesWithTokens(420_000),
        ] as any,
        operationId: 'op-1m',
        status: 'running',
      });
      const stepAt420k = await agent.runner(
        { payload: {}, phase: 'user_input' },
        at420kWithSummary,
      );
      expect((stepAt420k as any).type).toBe('compress_context');
    },
  );

  it.each([
    ['openai', 'gpt-6-luna'],
    ['openai', 'gpt-6.1-terra'],
    ['openai', 'gpt-6.2-sol'],
    ['openai', 'gpt-6.2-astra'],
  ])(
    'resolves OpenAI 1M model %s/%s to 240K initial / 255K recompression (below 272K cliff)',
    async (provider, model) => {
      const policy = resolveCompressionThresholds(model, provider);
      expect(policy).toEqual({
        maxWindowToken: 1_000_000,
        midTurnThresholdRatio: 0.85,
        physicalWindowToken: expect.any(Number),
        recompressionThresholdRatio: 0.255,
        thresholdRatio: 0.24,
      });
      expect(policy.physicalWindowToken).toBeGreaterThanOrEqual(1_000_000);
      expect(shouldCompress(makeMessagesWithTokens(235_000), policy).needsCompression).toBe(false);
      const over240k = shouldCompress(makeMessagesWithTokens(245_000), policy);
      expect(over240k.threshold).toBe(240_000);
      expect(over240k.needsCompression).toBe(true);
    },
  );

  it('resolves claude-haiku-5-5 (85K/92K), grok-4.7 (180K/190K), and smaller models (50%/65%)', () => {
    const haikuPolicy = resolveCompressionThresholds('claude-haiku-5-5', 'anthropic');
    expect(haikuPolicy).toEqual({
      maxWindowToken: 100_000,
      midTurnThresholdRatio: 0.85,
      physicalWindowToken: 1_000_000,
      recompressionThresholdRatio: 0.92,
      thresholdRatio: 0.85,
    });
    expect(shouldCompress(makeMessagesWithTokens(84_000), haikuPolicy).needsCompression).toBe(
      false,
    );
    expect(shouldCompress(makeMessagesWithTokens(86_000), haikuPolicy)).toMatchObject({
      needsCompression: true,
      threshold: 85_000,
    });

    const grokPolicy = resolveCompressionThresholds('grok-4.7', 'xai');
    expect(grokPolicy).toEqual({
      maxWindowToken: 200_000,
      midTurnThresholdRatio: 0.85,
      physicalWindowToken: 500_000,
      recompressionThresholdRatio: 0.95,
      thresholdRatio: 0.9,
    });
    expect(shouldCompress(makeMessagesWithTokens(175_000), grokPolicy).needsCompression).toBe(
      false,
    );
    expect(shouldCompress(makeMessagesWithTokens(185_000), grokPolicy)).toMatchObject({
      needsCompression: true,
      threshold: 180_000,
    });

    // Smaller 200K model uses standard 50%/65% ratios (100K/130K)
    const openRouterFreePolicy = resolveCompressionThresholds('openrouter/free', 'openrouter');
    expect(openRouterFreePolicy).toEqual({
      maxWindowToken: 200_000,
      midTurnThresholdRatio: 0.85,
      physicalWindowToken: 200_000,
      recompressionThresholdRatio: 0.65,
      thresholdRatio: 0.5,
    });
    expect(shouldCompress(makeMessagesWithTokens(105_000), openRouterFreePolicy)).toMatchObject({
      needsCompression: true,
      threshold: 100_000,
    });
  });

  it.each([
    ['openai', 'gpt-5.4-mini'],
    ['openai', 'gpt-5.4-nano'],
  ])(
    'does NOT apply the 272K cliff or inflate physicalWindowToken to 1M for %s/%s (400K fixed-price window: 200K/260K/340K)',
    async (provider, model) => {
      const policy = resolveCompressionThresholds(model, provider);
      expect(policy).toEqual({
        maxWindowToken: 400_000,
        midTurnThresholdRatio: 0.85,
        physicalWindowToken: 400_000,
        recompressionThresholdRatio: 0.65,
        thresholdRatio: 0.5,
      });

      // Step-0 initial threshold = 200K (50% of 400K), NOT 240K
      expect(shouldCompress(makeMessagesWithTokens(195_000), policy).needsCompression).toBe(false);
      expect(shouldCompress(makeMessagesWithTokens(205_000), policy)).toMatchObject({
        needsCompression: true,
        threshold: 200_000,
      });

      const agent = new GeneralChatAgent({
        compressionConfig: { ...policy, enabled: true },
        modelRuntimeConfig: { model, provider },
        operationId: `op-${model}`,
      });

      // Step-0 recompression threshold = 260K (65% of 400K)
      const at255kWithSummary = AgentRuntime.createInitialState({
        messages: [
          { content: 'Prior summary', id: 'grp-1', role: 'compressedGroup' },
          ...makeMessagesWithTokens(255_000),
        ] as any,
        operationId: `op-${model}`,
        status: 'running',
      });
      await expect(
        agent.runner({ payload: {}, phase: 'user_input' }, at255kWithSummary),
      ).resolves.toMatchObject({ type: 'call_llm' });

      const at265kWithSummary = AgentRuntime.createInitialState({
        messages: [
          { content: 'Prior summary', id: 'grp-1', role: 'compressedGroup' },
          ...makeMessagesWithTokens(265_000),
        ] as any,
        operationId: `op-${model}`,
        status: 'running',
      });
      await expect(
        agent.runner({ payload: {}, phase: 'user_input' }, at265kWithSummary),
      ).resolves.toMatchObject({ type: 'compress_context' });

      // Mid-turn emergency threshold = 340K (85% of real 400K window), NOT 850K!
      const makeMidTurnState = (tokens: number) =>
        AgentRuntime.createInitialState({
          messages: [
            ...makeMessagesWithTokens(tokens),
            { content: 'Tool result', id: 'msg-t1', role: 'tool' },
          ] as any,
          operationId: `op-${model}`,
          status: 'running',
        });
      await expect(
        agent.runner(
          { payload: { parentMessageId: 'msg-t1' }, phase: 'tool_result' },
          makeMidTurnState(335_000),
        ),
      ).resolves.toMatchObject({ type: 'call_llm' });
      await expect(
        agent.runner(
          { payload: { parentMessageId: 'msg-t1' }, phase: 'tool_result' },
          makeMidTurnState(345_000),
        ),
      ).resolves.toMatchObject({
        payload: { parentMessageId: 'msg-t1' },
        type: 'compress_context',
      });
    },
  );
});

describe('ENG-2A: RuntimeExecutors.compress_context cache disable & LOADING_FLAT preservation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes enabledContextCaching: false to compressionRuntime.chat so Anthropic emits zero cache_control blocks', async () => {
    let capturedCompressionPayload: ChatStreamPayload | undefined;
    const compressionChat = vi.fn(async (payload: ChatStreamPayload, options: any) => {
      capturedCompressionPayload = payload;
      await options?.callback?.onText?.('Condensed topic summary.');
      return new Response('');
    });
    vi.mocked(initModelRuntimeFromDB).mockResolvedValueOnce({ chat: compressionChat } as any);

    const upsertRollingCompressionGroup = vi.fn(async () => ({
      messageGroupId: 'grp-no-cache',
      messages: [
        { content: 'Condensed topic summary.', id: 'grp-no-cache', role: 'compressedGroup' },
      ],
    }));
    vi.mocked(MessageService).mockImplementationOnce(function () {
      return { upsertRollingCompressionGroup } as unknown as MessageService;
    });

    const state = AgentRuntime.createInitialState({
      messages: [
        { content: 'Earlier user message', id: 'msg-u1', role: 'user' },
        { content: 'Earlier assistant answer', id: 'msg-a1', role: 'assistant' },
        { content: 'New user question', id: 'msg-u2', role: 'user' },
      ] as any,
      metadata: {
        agentId: 'agent-1',
        sessionId: 'sess-1',
        studioWebChat: true,
        topicId: 'topic-1',
      },
      modelRuntimeConfig: {
        compressionModel: { effort: 'low', model: 'claude-haiku-5-5', provider: 'anthropic' },
        model: 'claude-sonnet-5-5',
        provider: 'anthropic',
      },
      operationId: 'op-cache-off',
      status: 'running',
    });

    const ctx: any = {
      messageModel: {
        create: vi.fn(),
        query: vi.fn(async () => [
          { content: 'Earlier user message', id: 'msg-u1', role: 'user' },
          { content: 'Earlier assistant answer', id: 'msg-a1', role: 'assistant' },
          { content: 'New user question', id: 'msg-u2', role: 'user' },
          { content: LOADING_FLAT, id: 'asst-live-2', role: 'assistant' },
        ]),
        update: vi.fn(),
      },
      operationId: 'op-cache-off',
      serverDB: {},
      stepIndex: 0,
      streamManager: { publishStreamChunk: vi.fn(), publishStreamEvent: vi.fn() },
      toolExecutionService: { executeTool: vi.fn() },
      userId: 'user-1',
    };

    await createRuntimeExecutors(ctx).compress_context!(
      {
        payload: {
          assistantMessageId: 'asst-live-2',
          currentTokenCount: 190_000,
          messages: state.messages,
          parentMessageId: 'msg-u2',
        },
        type: 'compress_context',
      },
      state,
    );

    expect(compressionChat).toHaveBeenCalledOnce();
    expect(capturedCompressionPayload).toBeDefined();
    expect(capturedCompressionPayload!.enabledContextCaching).toBe(false);
    expect(capturedCompressionPayload!.effort).toBe('low');
    // Must NOT forward assistantMessageId (x-assistant-message-id) to compressionRuntime,
    // otherwise billing_proxy overwrites the live LOADING_FLAT assistant row with the summary!
    expect(initModelRuntimeFromDB).toHaveBeenCalledWith(ctx.serverDB, 'user-1', 'anthropic', {
      sessionId: 'sess-1',
      studioWebChat: true,
      topicId: 'topic-1',
    });
    expect(vi.mocked(initModelRuntimeFromDB).mock.calls[0][3]).not.toHaveProperty(
      'assistantMessageId',
    );

    // Verify wire-level Anthropic payload has zero cache_control blocks anywhere
    const wirePayload = await buildDefaultAnthropicPayload({
      ...capturedCompressionPayload!,
      tools: [
        {
          function: { description: 'test tool', name: 'search', parameters: { type: 'object' } },
          type: 'function',
        },
      ],
    });
    expect(JSON.stringify(wirePayload)).not.toContain('cache_control');
  });

  it('preserves live assistantMessageId (LOADING_FLAT), filters historical empty stubs, and reuses assistantMessageId in follow-up call_llm', async () => {
    const policy = resolveCompressionThresholds('deepseek-flash', 'deepseek');
    const agent = new GeneralChatAgent({
      compressionConfig: { ...policy, enabled: true },
      modelRuntimeConfig: { model: 'deepseek-flash', provider: 'deepseek' },
      operationId: 'op-placeholder',
    });

    const historyMessages = [
      { content: 'Turn 1 user', id: 'msg-u1', role: 'user' },
      {
        content: 'Turn 1 assistant answer',
        id: 'msg-a1',
        metadata: { usage: { totalOutputTokens: 350_000 } },
        role: 'assistant',
      },
      // Historical tool-only assistant message (empty text, but HAS tools -> must be kept!)
      {
        content: '',
        id: 'msg-a2-tools',
        role: 'assistant',
        tools: [
          {
            apiName: 'readKnowledge',
            arguments: '{}',
            id: 'tc-1',
            identifier: 'kb',
            type: 'builtin',
          },
        ],
      },
      { content: 'Tool output', id: 'msg-t2', role: 'tool', tool_call_id: 'tc-1' },
    ];
    const currentUserMsg = { content: 'Turn 2 question', id: 'msg-u2', role: 'user' };

    const state = AgentRuntime.createInitialState({
      messages: [...historyMessages, currentUserMsg] as any,
      metadata: { agentId: 'agent-1', topicId: 'topic-1' },
      modelRuntimeConfig: { model: 'deepseek-flash', provider: 'deepseek' },
      operationId: 'op-placeholder',
      status: 'running',
    });

    // Step 0: execAgent created user msg-u2 and placeholder asst-live-2 ('...')
    const step0Instruction = await agent.runner(
      {
        payload: {
          assistantMessageId: 'asst-live-2',
          isFirstMessage: true,
          parentMessageId: 'msg-u2',
          tools: [],
        },
        phase: 'user_input',
      },
      state,
    );
    expect(step0Instruction).toMatchObject({
      payload: {
        assistantMessageId: 'asst-live-2',
        parentMessageId: 'msg-u2',
      },
      type: 'compress_context',
    });

    // DB contains historical orphaned stubs ('', '...') AND the live placeholder asst-live-2 ('...')
    const dbRows = [
      ...historyMessages,
      { content: LOADING_FLAT, id: 'msg-orphan-loading', role: 'assistant' },
      { content: '   ', id: 'msg-orphan-empty', role: 'assistant' },
      currentUserMsg,
      { content: LOADING_FLAT, id: 'asst-live-2', parentId: 'msg-u2', role: 'assistant' },
    ];

    const upsertRollingCompressionGroup = vi.fn(async () => ({
      messageGroupId: 'grp-clean',
      // Simulate MessageService.upsertRollingCompressionGroup re-querying DB where asst-live-2 still sits uncompressed
      messages: [
        { content: 'Clean summary', id: 'grp-clean', role: 'compressedGroup' },
        currentUserMsg,
        { content: LOADING_FLAT, id: 'asst-live-2', parentId: 'msg-u2', role: 'assistant' },
      ],
    }));
    vi.mocked(MessageService).mockImplementationOnce(function () {
      return { upsertRollingCompressionGroup } as unknown as MessageService;
    });

    const summarizeChat = vi.fn(async (_payload: unknown, options: any) => {
      await options.callback.onText('Clean summary');
      return new Response('');
    });
    const answerChat = vi.fn(async (_payload: ChatStreamPayload, options: any) => {
      // Ensure the live LOADING_FLAT placeholder was NOT leaked into call_llm prompt messages
      expect(
        _payload.messages.some((m: any) => m.id === 'asst-live-2' || m.content === LOADING_FLAT),
      ).toBe(false);
      await options.callback.onText('Final answer in existing placeholder.');
      return new Response('');
    });
    vi.mocked(initModelRuntimeFromDB)
      .mockResolvedValueOnce({ chat: summarizeChat } as any)
      .mockResolvedValueOnce({ chat: answerChat } as any);

    const ctx: any = {
      loadAgentState: vi.fn(async () => state),
      messageModel: {
        create: vi.fn(async () => ({ id: 'unexpected-duplicate-assistant' })),
        query: vi.fn(async () => dbRows),
        update: vi.fn(),
      },
      operationId: 'op-placeholder',
      serverDB: {},
      stepIndex: 0,
      streamManager: { publishStreamChunk: vi.fn(), publishStreamEvent: vi.fn() },
      toolExecutionService: { executeTool: vi.fn() },
      userId: 'user-1',
    };

    const executors = createRuntimeExecutors(ctx);
    const compressStep = await executors.compress_context!(step0Instruction as any, state);

    // 1. Live placeholder and historical empty stubs were excluded from upsertRollingCompressionGroup & chainCompressContext,
    //    while assistant message with tool calls (msg-a2-tools) WAS preserved in summarization!
    expect(upsertRollingCompressionGroup).toHaveBeenCalledWith(
      'topic-1',
      ['msg-u1', 'msg-a1', 'msg-a2-tools', 'msg-t2'],
      expect.any(Object),
      'Clean summary',
    );
    const summarizedIds = (vi.mocked(chainCompressContext).mock.calls[0]?.[0] ?? []).map(
      (m: any) => m.id,
    );
    expect(summarizedIds).toEqual(['msg-u1', 'msg-a1', 'msg-a2-tools', 'msg-t2']);

    // 2. compression_result forwards assistantMessageId & parentMessageId to GeneralChatAgent
    const step1Instruction = await agent.runner(compressStep.nextContext!, compressStep.newState);
    expect(step1Instruction).toMatchObject({
      payload: {
        assistantMessageId: 'asst-live-2',
        parentMessageId: 'msg-u2',
      },
      type: 'call_llm',
    });
    expect((step1Instruction as any).payload.createAssistantMessage).toBeUndefined();

    // 3. call_llm writes into existing asst-live-2 and NEVER creates a second assistant row
    await createRuntimeExecutors({ ...ctx, stepIndex: 1 }).call_llm!(
      step1Instruction as any,
      compressStep.newState,
    );
    expect(ctx.messageModel.create).not.toHaveBeenCalled();
    expect(ctx.messageModel.update).toHaveBeenCalledWith(
      'asst-live-2',
      expect.objectContaining({
        content: 'Final answer in existing placeholder.',
      }),
    );
  });

  it('preserves assistantMessageId even when compress_context fails and falls back with skipped: true', async () => {
    vi.mocked(initModelRuntimeFromDB).mockResolvedValueOnce({
      chat: vi.fn(async () => {
        throw new Error('Upstream transient failure');
      }),
    } as any);

    const state = AgentRuntime.createInitialState({
      messages: [
        { content: 'Old', id: 'msg-1', role: 'user' },
        { content: 'New', id: 'msg-2', role: 'user' },
      ] as any,
      metadata: { agentId: 'agent-1', topicId: 'topic-1' },
      modelRuntimeConfig: { model: 'deepseek-flash', provider: 'deepseek' },
      operationId: 'op-fail',
      status: 'running',
    });

    const ctx: any = {
      messageModel: {
        create: vi.fn(),
        query: vi.fn(async () => [
          { content: 'Old', id: 'msg-1', role: 'user' },
          { content: 'New', id: 'msg-2', role: 'user' },
          { content: LOADING_FLAT, id: 'asst-live-fail', role: 'assistant' },
        ]),
        update: vi.fn(),
      },
      operationId: 'op-fail',
      serverDB: {},
      stepIndex: 0,
      streamManager: { publishStreamChunk: vi.fn(), publishStreamEvent: vi.fn() },
      toolExecutionService: { executeTool: vi.fn() },
      userId: 'user-1',
    };

    const result = await createRuntimeExecutors(ctx).compress_context!(
      {
        payload: {
          assistantMessageId: 'asst-live-fail',
          currentTokenCount: 30_000,
          messages: state.messages,
          parentMessageId: 'msg-2',
        },
        type: 'compress_context',
      },
      state,
    );

    expect(result.nextContext?.payload).toMatchObject({
      assistantMessageId: 'asst-live-fail',
      parentMessageId: 'msg-2',
      skipped: true,
    });
  });

  it('ENG-2B: routes default and Data Guard compression to deepseek/deepseek-flash while honoring explicit non-Data-Guard overrides', async () => {
    expect(DEFAULT_COMPRESSION_MODEL).toEqual({
      model: 'deepseek-flash',
      provider: 'deepseek',
    });
    expect(resolveCompressionModelConfig()).toEqual(DEFAULT_COMPRESSION_MODEL);
    expect(
      resolveCompressionModelConfig({
        agentConfig: { chatConfig: { deepseekDataGuardProtected: false } },
      }),
    ).toEqual({
      model: 'deepseek-flash',
      provider: 'deepseek',
    });
    expect(
      resolveCompressionModelConfig({
        agentConfig: { chatConfig: { deepseekDataGuardProtected: false } },
        explicitCompressionModel: {
          effort: 'low',
          model: 'claude-haiku-5-5',
          provider: 'anthropic',
        },
      }),
    ).toEqual({
      effort: 'low',
      model: 'claude-haiku-5-5',
      provider: 'anthropic',
    });
    expect(
      resolveCompressionModelConfig({
        agentConfig: { chatConfig: { deepseekDataGuardProtected: true } },
        explicitCompressionModel: {
          effort: 'low',
          model: 'claude-haiku-5-5',
          provider: 'anthropic',
        },
      }),
    ).toEqual(DATA_GUARD_COMPRESSION_MODEL);

    // Defense-in-depth inside RuntimeExecutors.compress_context: even if state carries anthropic,
    // deepseekDataGuardProtected = true forces deepseek/deepseek-flash without anthropic effort.
    let capturedProtectedPayload: ChatStreamPayload | undefined;
    const deepseekChat = vi.fn(async (payload: ChatStreamPayload, options: any) => {
      capturedProtectedPayload = payload;
      await options?.callback?.onText?.('Protected summary on DeepSeek.');
      return new Response('');
    });
    vi.mocked(initModelRuntimeFromDB).mockResolvedValueOnce({ chat: deepseekChat } as any);

    const upsertRollingCompressionGroup = vi.fn(async () => ({
      messageGroupId: 'grp-guard',
      messages: [
        { content: 'Protected summary on DeepSeek.', id: 'grp-guard', role: 'compressedGroup' },
      ],
    }));
    vi.mocked(MessageService).mockImplementationOnce(function () {
      return { upsertRollingCompressionGroup } as unknown as MessageService;
    });

    const protectedState = AgentRuntime.createInitialState({
      messages: [
        { content: 'Confidential contract clause', id: 'msg-g1', role: 'user' },
        { content: 'Follow-up', id: 'msg-g2', role: 'user' },
      ] as any,
      metadata: {
        agentConfig: { chatConfig: { deepseekDataGuardProtected: true } },
        agentId: 'agent-guard',
        studioWebChat: true,
        topicId: 'topic-guard',
      },
      modelRuntimeConfig: {
        compressionModel: { effort: 'low', model: 'claude-haiku-5-5', provider: 'anthropic' },
        model: 'deepseek-flash',
        provider: 'deepseek',
      },
      operationId: 'op-guard',
      status: 'running',
    });

    const ctx: any = {
      agentConfig: { chatConfig: { deepseekDataGuardProtected: true } },
      messageModel: {
        create: vi.fn(),
        query: vi.fn(async () => [
          { content: 'Confidential contract clause', id: 'msg-g1', role: 'user' },
          { content: 'Follow-up', id: 'msg-g2', role: 'user' },
          { content: LOADING_FLAT, id: 'asst-guard-2', role: 'assistant' },
        ]),
        update: vi.fn(),
      },
      operationId: 'op-guard',
      serverDB: {},
      stepIndex: 0,
      streamManager: { publishStreamChunk: vi.fn(), publishStreamEvent: vi.fn() },
      toolExecutionService: { executeTool: vi.fn() },
      userId: 'user-guard',
    };

    await createRuntimeExecutors(ctx).compress_context!(
      {
        payload: {
          assistantMessageId: 'asst-guard-2',
          currentTokenCount: 25_000,
          messages: protectedState.messages,
          parentMessageId: 'msg-g2',
        },
        type: 'compress_context',
      },
      protectedState,
    );

    expect(initModelRuntimeFromDB).toHaveBeenCalledWith(ctx.serverDB, 'user-guard', 'deepseek', {
      sessionId: undefined,
      studioWebChat: true,
      topicId: 'topic-guard',
    });
    expect(vi.mocked(initModelRuntimeFromDB).mock.calls[0][3]).not.toHaveProperty(
      'assistantMessageId',
    );
    expect(capturedProtectedPayload).toBeDefined();
    expect(capturedProtectedPayload!.model).toBe('deepseek-flash');
    expect(capturedProtectedPayload!.enabledContextCaching).toBe(false);
    expect(capturedProtectedPayload!.effort).toBeUndefined();
  });

  it('preserves active user turn, non-empty broken HTML draft, and repair prompt across compress_context while compressing prior turn', async () => {
    const brokenHtml = '<lobeArtifact identifier="dash" type="text/html"><div>broken';
    const repairPrompt = {
      content: 'Line 1: unclosed <div>. Исправь синтаксическую ошибку...',
      role: 'user',
    };
    const dbMessages = [
      { content: 'Earlier request', id: 'msg-u0', role: 'user' },
      { content: 'Earlier reply', id: 'msg-a0', role: 'assistant' },
      { content: 'Build dashboard', id: 'msg-u1', role: 'user' },
      { content: brokenHtml, id: 'asst-broken', role: 'assistant' },
    ];
    const state = AgentRuntime.createInitialState({
      messages: [...dbMessages, repairPrompt] as any,
      metadata: { agentId: 'agent-html', topicId: 'topic-html' },
      modelRuntimeConfig: {
        compressionModel: { effort: 'low', model: 'claude-haiku-5-5', provider: 'anthropic' },
        model: 'claude-sonnet-5-5',
        provider: 'anthropic',
      },
      operationId: 'op-html-repair',
      status: 'running',
    });

    const upsertRollingCompressionGroup = vi.fn(async () => ({
      messageGroupId: 'grp-html',
      messages: [
        { content: 'Earlier request summary', id: 'grp-html', role: 'compressedGroup' },
        { content: 'Build dashboard', id: 'msg-u1', role: 'user' },
        { content: brokenHtml, id: 'asst-broken', role: 'assistant' },
      ],
    }));
    vi.mocked(MessageService).mockImplementationOnce(function () {
      return { upsertRollingCompressionGroup } as unknown as MessageService;
    });

    vi.mocked(initModelRuntimeFromDB).mockResolvedValueOnce({
      chat: vi.fn(async (_payload: unknown, options: any) => {
        await options.callback.onText('Earlier request summary');
        return new Response('');
      }),
    } as any);

    const ctx: any = {
      messageModel: {
        create: vi.fn(),
        query: vi.fn(async () => dbMessages),
        update: vi.fn(),
      },
      operationId: 'op-html-repair',
      serverDB: {},
      stepIndex: 1,
      streamManager: { publishStreamChunk: vi.fn(), publishStreamEvent: vi.fn() },
      toolExecutionService: { executeTool: vi.fn() },
      userId: 'user-html',
    };

    const result = await createRuntimeExecutors(ctx).compress_context!(
      {
        payload: {
          assistantMessageId: 'asst-broken',
          currentTokenCount: 350_000,
          messages: state.messages,
          parentMessageId: 'asst-broken',
        },
        type: 'compress_context',
      },
      state,
    );

    // Only the prior turn (msg-u0, msg-a0) was compressed; active turn (msg-u1, asst-broken) stays intact
    expect(upsertRollingCompressionGroup).toHaveBeenCalledWith(
      'topic-html',
      ['msg-u0', 'msg-a0'],
      expect.any(Object),
      'Earlier request summary',
    );
    expect((result.nextContext?.payload as any).compressedMessages).toEqual([
      { content: 'Earlier request summary', id: 'grp-html', role: 'compressedGroup' },
      { content: 'Build dashboard', id: 'msg-u1', role: 'user' },
      { content: brokenHtml, id: 'asst-broken', role: 'assistant' },
      repairPrompt,
    ]);
    expect((result.nextContext?.payload as any).assistantMessageId).toBe('asst-broken');
  });

  it('mid-turn compression after call_tool and call_tools_batch preserves active user + active tool results without duplicating virtual assistantGroup', async () => {
    const priorGroup = { content: 'Prior rolling summary', id: 'grp-0', role: 'compressedGroup' };
    const priorUser = { content: 'Turn 1 request', id: 'msg-u1', role: 'user' };
    const priorAsst = { content: 'Turn 1 answer', id: 'msg-a1', role: 'assistant' };
    const activeUser = { content: 'Turn 2 multi-tool task', id: 'msg-u2', role: 'user' };
    const activeAsst = {
      content: 'Calling two tools',
      id: 'msg-a2',
      role: 'assistant',
      tools: [
        { apiName: 'readFile', arguments: '{}', id: 'tc-1', identifier: 'local', type: 'builtin' },
        { apiName: 'readFile', arguments: '{}', id: 'tc-2', identifier: 'local', type: 'builtin' },
      ],
    };
    const activeTool1 = { content: 'Result 1', id: 'msg-t1', role: 'tool', tool_call_id: 'tc-1' };
    const activeTool2 = { content: 'Result 2', id: 'msg-t2', role: 'tool', tool_call_id: 'tc-2' };

    // Simulate hydrated assistantGroup in state.messages after call_tools_batch
    const hydratedActiveGroup = {
      children: [
        {
          content: 'Calling two tools',
          id: 'msg-a2',
          tools: [
            {
              apiName: 'readFile',
              arguments: '{}',
              id: 'tc-1',
              identifier: 'local',
              result: { content: 'Result 1', id: 'msg-t1' },
              type: 'builtin',
            },
            {
              apiName: 'readFile',
              arguments: '{}',
              id: 'tc-2',
              identifier: 'local',
              result: { content: 'Result 2', id: 'msg-t2' },
              type: 'builtin',
            },
          ],
        },
      ],
      content: '',
      id: 'group-active-a2',
      role: 'assistantGroup',
    };

    const dbMessages = [
      priorGroup,
      priorUser,
      priorAsst,
      activeUser,
      activeAsst,
      activeTool1,
      activeTool2,
    ];
    const state = AgentRuntime.createInitialState({
      messages: [priorGroup, priorUser, priorAsst, activeUser, hydratedActiveGroup] as any,
      metadata: { agentId: 'agent-mid', topicId: 'topic-mid' },
      modelRuntimeConfig: {
        compressionModel: { model: 'deepseek-flash', provider: 'deepseek' },
        model: 'claude-sonnet-5-5',
        provider: 'anthropic',
      },
      operationId: 'op-mid-turn',
      status: 'running',
    });

    const upsertRollingCompressionGroup = vi.fn(async () => ({
      messageGroupId: 'grp-0',
      messages: [
        { content: 'Updated rolling summary', id: 'grp-0', role: 'compressedGroup' },
        activeUser,
        activeAsst,
        activeTool1,
        activeTool2,
      ],
    }));
    vi.mocked(MessageService).mockImplementationOnce(function () {
      return { upsertRollingCompressionGroup } as unknown as MessageService;
    });
    vi.mocked(initModelRuntimeFromDB).mockResolvedValueOnce({
      chat: vi.fn(async (_payload: unknown, options: any) => {
        await options.callback.onText('Updated rolling summary');
        return new Response('');
      }),
    } as any);

    const ctx: any = {
      messageModel: {
        create: vi.fn(),
        query: vi.fn(async () => dbMessages),
        update: vi.fn(),
      },
      operationId: 'op-mid-turn',
      serverDB: {},
      stepIndex: 2,
      streamManager: { publishStreamChunk: vi.fn(), publishStreamEvent: vi.fn() },
      toolExecutionService: { executeTool: vi.fn() },
      userId: 'user-mid',
    };

    const result = await createRuntimeExecutors(ctx).compress_context!(
      {
        payload: {
          currentTokenCount: 360_000,
          existingSummary: 'Prior rolling summary',
          messages: state.messages,
          parentMessageId: 'msg-t2',
        },
        type: 'compress_context',
      },
      state,
    );

    // Prior summary + priorMessages passed to chainCompressContext; ONLY prior turn compressed
    expect(chainCompressContext).toHaveBeenCalledWith(
      [priorUser, priorAsst],
      expect.objectContaining({
        existingSummary: 'Prior rolling summary',
        priorMessages: [priorGroup],
      }),
    );
    expect(upsertRollingCompressionGroup).toHaveBeenCalledWith(
      'topic-mid',
      ['msg-u1', 'msg-a1'],
      { agentId: 'agent-mid', threadId: undefined, topicId: 'topic-mid' },
      'Updated rolling summary',
    );
    // Preserves active turn flat DB rows without duplicating the virtual assistantGroup wrapper
    expect((result.nextContext?.payload as any).compressedMessages).toEqual([
      { content: 'Updated rolling summary', id: 'grp-0', role: 'compressedGroup' },
      activeUser,
      activeAsst,
      activeTool1,
      activeTool2,
    ]);
    // Keeps parentMessageId pointing to the latest tool message
    expect((result.nextContext?.payload as any).parentMessageId).toBe('msg-t2');
    expect(result.newState.metadata?.compressionConsecutiveFailures).toBe(0);
  });

  it('skips cleanly on Turn 1 single-turn bloat without calling the summarizer or DB', async () => {
    const dbMessages = [
      { content: 'Single turn prompt', id: 'msg-u1', role: 'user' },
      { content: 'Tool call', id: 'msg-a1', role: 'assistant' },
      { content: 'Huge tool output '.repeat(1000), id: 'msg-t1', role: 'tool' },
    ];
    const state = AgentRuntime.createInitialState({
      messages: dbMessages as any,
      metadata: { agentId: 'agent-single', topicId: 'topic-single' },
      modelRuntimeConfig: {
        compressionModel: { model: 'deepseek-flash', provider: 'deepseek' },
        model: 'deepseek-flash',
        provider: 'deepseek',
      },
      operationId: 'op-single',
      status: 'running',
    });

    const ctx: any = {
      messageModel: {
        create: vi.fn(),
        query: vi.fn(async () => dbMessages),
        update: vi.fn(),
      },
      operationId: 'op-single',
      serverDB: {},
      stepIndex: 1,
      streamManager: { publishStreamChunk: vi.fn(), publishStreamEvent: vi.fn() },
      toolExecutionService: { executeTool: vi.fn() },
      userId: 'user-single',
    };

    const result = await createRuntimeExecutors(ctx).compress_context!(
      {
        payload: {
          currentTokenCount: 360_000,
          messages: state.messages,
          parentMessageId: 'msg-t1',
        },
        type: 'compress_context',
      },
      state,
    );

    expect(initModelRuntimeFromDB).not.toHaveBeenCalled();
    expect(result.nextContext?.payload).toMatchObject({
      compressedMessages: dbMessages,
      parentMessageId: 'msg-t1',
      skipped: true,
    });
  });

  it('consolidates >= 2 legacy stacked compressedGroups into 1 rolling summary even with 0 new uncompressed turns', async () => {
    const grp1 = { content: 'Legacy summary part 1', id: 'grp-1', role: 'compressedGroup' };
    const grp2 = { content: 'Legacy summary part 2', id: 'grp-2', role: 'compressedGroup' };
    const activeUser = { content: 'Next question', id: 'msg-u3', role: 'user' };
    const dbMessages = [grp1, grp2, activeUser];

    const state = AgentRuntime.createInitialState({
      messages: dbMessages as any,
      metadata: { agentId: 'agent-legacy', topicId: 'topic-legacy' },
      modelRuntimeConfig: {
        compressionModel: { model: 'deepseek-flash', provider: 'deepseek' },
        model: 'deepseek-flash',
        provider: 'deepseek',
      },
      operationId: 'op-legacy',
      status: 'running',
    });

    const upsertRollingCompressionGroup = vi.fn(async () => ({
      messageGroupId: 'grp-1',
      messages: [
        { content: 'Single consolidated summary', id: 'grp-1', role: 'compressedGroup' },
        activeUser,
      ],
    }));
    vi.mocked(MessageService).mockImplementationOnce(function () {
      return { upsertRollingCompressionGroup } as unknown as MessageService;
    });
    vi.mocked(initModelRuntimeFromDB).mockResolvedValueOnce({
      chat: vi.fn(async (_payload: unknown, options: any) => {
        await options.callback.onText('Single consolidated summary');
        return new Response('');
      }),
    } as any);

    const ctx: any = {
      messageModel: {
        create: vi.fn(),
        query: vi.fn(async () => dbMessages),
        update: vi.fn(),
      },
      operationId: 'op-legacy',
      serverDB: {},
      stepIndex: 0,
      streamManager: { publishStreamChunk: vi.fn(), publishStreamEvent: vi.fn() },
      toolExecutionService: { executeTool: vi.fn() },
      userId: 'user-legacy',
    };

    const result = await createRuntimeExecutors(ctx).compress_context!(
      {
        payload: {
          currentTokenCount: 420_000,
          messages: state.messages,
          parentMessageId: 'msg-u3',
        },
        type: 'compress_context',
      },
      state,
    );

    expect(chainCompressContext).toHaveBeenCalledWith([], {
      existingSummary: 'Legacy summary part 1\n\nLegacy summary part 2',
      priorMessages: [grp1, grp2],
    });
    expect(upsertRollingCompressionGroup).toHaveBeenCalledWith(
      'topic-legacy',
      [],
      expect.any(Object),
      'Single consolidated summary',
    );
    expect((result.nextContext?.payload as any).compressedMessages).toEqual([
      { content: 'Single consolidated summary', id: 'grp-1', role: 'compressedGroup' },
      activeUser,
    ]);
  });

  it('splits large >35K-token history into alternating user/assistant turns in ONE DeepSeek chat() call and caps oversized tool bodies without mutating DB rows', async () => {
    const hugeToolOriginal = 'ROW_DATA_PAYLOAD_1234567890 '.repeat(800); // > 22K chars
    const priorHistory = [
      { content: 'Start big investigation', id: 'msg-u1', role: 'user' },
      {
        content: 'Detailed audit chapter A '.repeat(2500),
        id: 'msg-a1',
        role: 'assistant',
      },
      { content: hugeToolOriginal, id: 'msg-t1', role: 'tool' },
      { content: 'Continue deep dive', id: 'msg-u2', role: 'user' },
      {
        content: 'Detailed audit chapter B '.repeat(2500),
        id: 'msg-a2',
        role: 'assistant',
      },
      {
        content: 'Detailed audit chapter C '.repeat(2500),
        id: 'msg-a3',
        role: 'assistant',
      },
    ];
    const activeUser = { content: 'Now summarize next steps', id: 'msg-u3', role: 'user' };
    const dbMessages = [...priorHistory, activeUser];

    let capturedPayload: ChatStreamPayload | undefined;
    const deepseekChat = vi.fn(async (payload: ChatStreamPayload, options: any) => {
      capturedPayload = payload;
      await options.callback.onText('Compact rolling summary from single DeepSeek call.');
      return new Response('');
    });
    vi.mocked(initModelRuntimeFromDB).mockResolvedValueOnce({ chat: deepseekChat } as any);

    const upsertRollingCompressionGroup = vi.fn(async () => ({
      messageGroupId: 'grp-ds-single',
      messages: [
        {
          content: 'Compact rolling summary from single DeepSeek call.',
          id: 'grp-ds-single',
          role: 'compressedGroup',
        },
        activeUser,
      ],
    }));
    vi.mocked(MessageService).mockImplementationOnce(function () {
      return { upsertRollingCompressionGroup } as unknown as MessageService;
    });

    const state = AgentRuntime.createInitialState({
      messages: dbMessages as any,
      metadata: { agentId: 'agent-ds', topicId: 'topic-ds' },
      modelRuntimeConfig: {
        compressionModel: { model: 'deepseek-flash', provider: 'deepseek' },
        model: 'deepseek-flash',
        provider: 'deepseek',
      },
      operationId: 'op-ds-chunk',
      status: 'running',
    });

    const ctx: any = {
      messageModel: {
        create: vi.fn(),
        query: vi.fn(async () => dbMessages),
        update: vi.fn(),
      },
      operationId: 'op-ds-chunk',
      serverDB: {},
      stepIndex: 0,
      streamManager: { publishStreamChunk: vi.fn(), publishStreamEvent: vi.fn() },
      toolExecutionService: { executeTool: vi.fn() },
      userId: 'user-ds',
    };

    await createRuntimeExecutors(ctx).compress_context!(
      {
        payload: {
          currentTokenCount: 360_000,
          messages: state.messages,
          parentMessageId: 'msg-u3',
        },
        type: 'compress_context',
      },
      state,
    );

    // Must complete in ONE single DeepSeek call!
    expect(deepseekChat).toHaveBeenCalledOnce();
    expect(capturedPayload).toBeDefined();
    const sentMessages = capturedPayload!.messages;
    expect(sentMessages[0].role).toBe('system');
    expect(sentMessages.at(-1)?.role).toBe('user');

    // Must have split into multiple user turns separated by assistant acks (ZERO consecutive user turns)
    const userMessages = sentMessages.filter((m) => m.role === 'user');
    expect(userMessages.length).toBeGreaterThan(2);
    for (let i = 1; i < sentMessages.length; i++) {
      expect(sentMessages[i - 1].role === 'user' && sentMessages[i].role === 'user').toBe(false);
    }

    // Every individual role='user' turn stays safely below DeepSeek's 32,768-token per-turn ceiling
    for (const userMsg of userMessages) {
      expect(calculatePromptTokens([userMsg])).toBeLessThan(24_000);
    }

    // Oversized tool body was capped in summarizer input with archive hint while original DB row stayed intact
    const joinedSent = sentMessages.map((m) => String(m.content)).join('\n');
    expect(joinedSent).toContain('getTopicContext(mode="archive")');
    expect(priorHistory[2].content).toBe(hugeToolOriginal);
  });

  it('tracks consecutive compression failures and stops retrying after 2 failures in the same operation', async () => {
    const dbMessages = [
      { content: 'Earlier turn', id: 'msg-u1', role: 'user' },
      { content: 'Earlier reply', id: 'msg-a1', role: 'assistant' },
      { content: 'Current turn', id: 'msg-u2', role: 'user' },
    ];
    const agent = new GeneralChatAgent({
      compressionConfig: { enabled: true, maxWindowToken: 1 },
      modelRuntimeConfig: {
        compressionModel: { model: 'deepseek-flash', provider: 'deepseek' },
        model: 'deepseek-flash',
        provider: 'deepseek',
      },
      operationId: 'op-fail-cap',
    });

    vi.mocked(initModelRuntimeFromDB)
      .mockResolvedValueOnce({
        chat: vi.fn(async () => {
          throw new Error('Transient error 1');
        }),
      } as any)
      .mockResolvedValueOnce({
        chat: vi.fn(async () => {
          throw new Error('Transient error 2');
        }),
      } as any);

    const ctx: any = {
      messageModel: {
        create: vi.fn(),
        query: vi.fn(async () => dbMessages),
        update: vi.fn(),
      },
      operationId: 'op-fail-cap',
      serverDB: {},
      stepIndex: 0,
      streamManager: { publishStreamChunk: vi.fn(), publishStreamEvent: vi.fn() },
      toolExecutionService: { executeTool: vi.fn() },
      userId: 'user-fail',
    };

    const initial = AgentRuntime.createInitialState({
      messages: dbMessages as any,
      metadata: { agentId: 'agent-fail', topicId: 'topic-fail' },
      modelRuntimeConfig: {
        compressionModel: { model: 'deepseek-flash', provider: 'deepseek' },
        model: 'deepseek-flash',
        provider: 'deepseek',
      },
      operationId: 'op-fail-cap',
      status: 'running',
    });

    const fail1 = await createRuntimeExecutors(ctx).compress_context!(
      {
        payload: {
          currentTokenCount: 360_000,
          messages: initial.messages,
          parentMessageId: 'msg-u2',
        },
        type: 'compress_context',
      },
      initial,
    );
    expect(fail1.newState.metadata?.compressionConsecutiveFailures).toBe(1);

    // After 1 failure, GeneralChatAgent still allows a retry
    const retryDecision = await agent.runner(
      { payload: { parentMessageId: 'msg-u2' }, phase: 'tool_result' },
      fail1.newState,
    );
    expect((retryDecision as any).type).toBe('compress_context');

    const fail2 = await createRuntimeExecutors({ ...ctx, stepIndex: 1 }).compress_context!(
      {
        payload: {
          currentTokenCount: 360_000,
          messages: fail1.newState.messages,
          parentMessageId: 'msg-u2',
        },
        type: 'compress_context',
      },
      fail1.newState,
    );
    expect(fail2.newState.metadata?.compressionConsecutiveFailures).toBe(2);

    // After 2 consecutive failures, GeneralChatAgent stops retrying compress_context
    const cappedDecision = await agent.runner(
      { payload: { parentMessageId: 'msg-u2' }, phase: 'tool_result' },
      fail2.newState,
    );
    expect((cappedDecision as any).type).toBe('call_llm');
  });

  const hasLoneSurrogate = (text: string): boolean => {
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = text.charCodeAt(i + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
        i += 1;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        return true;
      }
    }
    return false;
  };

  it('Finding #1A: 85,000-char Russian summary/history on deepseek-flash triggers alternating chunking with <= 60,000 UTF-8 bytes and <= 20,000 tokenx tokens per user turn', async () => {
    const russianSentence =
      'Анализ документальной архитектуры корпоративной инфраструктуры и производственного регламента. ';
    const russian85k = russianSentence
      .repeat(Math.ceil(85_000 / russianSentence.length))
      .slice(0, 85_000);
    expect(russian85k.length).toBe(85_000);
    // Proves tokenx alone would have underestimated Cyrillic below the 20K budget and skipped chunking!
    expect(estimateTokens(russian85k)).toBeLessThanOrEqual(20_000);
    expect(estimateDeepSeekUserTurnTokens(russian85k)).toBeGreaterThan(20_000);

    const dbMessages = [
      { content: 'Проанализируй полный отчёт', id: 'msg-u1', role: 'user' },
      { content: russian85k, id: 'msg-a1', role: 'assistant' },
      { content: 'Сделай выводы', id: 'msg-u2', role: 'user' },
    ];

    let capturedPayload: ChatStreamPayload | undefined;
    const deepseekChat = vi.fn(async (payload: ChatStreamPayload, options: any) => {
      capturedPayload = payload;
      await options.callback.onText('Краткое резюме русского диалога.');
      return new Response('');
    });
    vi.mocked(initModelRuntimeFromDB).mockResolvedValueOnce({ chat: deepseekChat } as any);

    const upsertRollingCompressionGroup = vi.fn(async () => ({
      messageGroupId: 'grp-ru-85k',
      messages: [
        { content: 'Краткое резюме русского диалога.', id: 'grp-ru-85k', role: 'compressedGroup' },
        dbMessages[2],
      ],
    }));
    vi.mocked(MessageService).mockImplementationOnce(function () {
      return { upsertRollingCompressionGroup } as unknown as MessageService;
    });

    const state = AgentRuntime.createInitialState({
      messages: dbMessages as any,
      metadata: { agentId: 'agent-ru-85k', topicId: 'topic-ru-85k' },
      modelRuntimeConfig: {
        compressionModel: { model: 'deepseek-flash', provider: 'deepseek' },
        model: 'deepseek-flash',
        provider: 'deepseek',
      },
      operationId: 'op-ru-85k',
      status: 'running',
    });

    const ctx: any = {
      messageModel: {
        create: vi.fn(),
        query: vi.fn(async () => dbMessages),
        update: vi.fn(),
      },
      operationId: 'op-ru-85k',
      serverDB: {},
      stepIndex: 0,
      streamManager: { publishStreamChunk: vi.fn(), publishStreamEvent: vi.fn() },
      toolExecutionService: { executeTool: vi.fn() },
      userId: 'user-ru-85k',
    };

    await createRuntimeExecutors(ctx).compress_context!(
      {
        payload: {
          currentTokenCount: 360_000,
          messages: state.messages,
          parentMessageId: 'msg-u2',
        },
        type: 'compress_context',
      },
      state,
    );

    expect(deepseekChat).toHaveBeenCalledOnce();
    expect(capturedPayload).toBeDefined();
    const sentMessages = capturedPayload!.messages;
    expect(sentMessages[0].role).toBe('system');
    expect(sentMessages.at(-1)?.role).toBe('user');

    const userMessages = sentMessages.filter((m) => m.role === 'user');
    expect(userMessages.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < sentMessages.length; i++) {
      expect(sentMessages[i - 1].role === 'user' && sentMessages[i].role === 'user').toBe(false);
    }
    for (const userMsg of userMessages) {
      const content = String(userMsg.content);
      expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(60_000);
      expect(estimateTokens(content)).toBeLessThanOrEqual(20_000);
      expect(hasLoneSurrogate(content)).toBe(false);
    }
  });

  it('Finding #1B: 137,642-char Russian legacy 21-summary consolidation (messagesToSummarize = []) runs in ONE deepseek-flash call with <= 60,000 UTF-8 bytes per user turn', async () => {
    const russianBase =
      'Итоги этапа согласования архитектуры, ключевые ограничения заказчика и проверенные параметры системы. ';
    const makeExactRussianBlock = (targetLen: number, idx: number): string => {
      const prefix = `Сводка №${idx + 1}: `;
      const repeated = russianBase.repeat(
        Math.ceil((targetLen - prefix.length) / russianBase.length),
      );
      // Ensure the final character is non-whitespace so `.trim()` keeps the exact length
      return (prefix + repeated).slice(0, targetLen - 1) + 'Я';
    };

    // 20 * 6,552 + 6,562 = 137,602 chars + 20 * 2 ('\n\n') = 137,642 exact chars
    const priorGroups = Array.from({ length: 21 }, (_, idx) => ({
      content: makeExactRussianBlock(idx === 20 ? 6562 : 6552, idx),
      id: `grp-legacy-${idx + 1}`,
      role: 'compressedGroup',
    }));
    const joinedSummary = priorGroups.map((g) => g.content).join('\n\n');
    expect(joinedSummary.length).toBe(137_642);

    const activeUser = {
      content: 'Продолжаем работу по проекту',
      id: 'msg-u-active',
      role: 'user',
    };
    const dbMessages = [...priorGroups, activeUser];

    let capturedPayload: ChatStreamPayload | undefined;
    const deepseekChat = vi.fn(async (payload: ChatStreamPayload, options: any) => {
      capturedPayload = payload;
      await options.callback.onText('Единая консолидированная сводка.');
      return new Response('');
    });
    vi.mocked(initModelRuntimeFromDB).mockResolvedValueOnce({ chat: deepseekChat } as any);

    const upsertRollingCompressionGroup = vi.fn(async () => ({
      messageGroupId: 'grp-legacy-1',
      messages: [
        {
          content: 'Единая консолидированная сводка.',
          id: 'grp-legacy-1',
          role: 'compressedGroup',
        },
        activeUser,
      ],
    }));
    vi.mocked(MessageService).mockImplementationOnce(function () {
      return { upsertRollingCompressionGroup } as unknown as MessageService;
    });

    const state = AgentRuntime.createInitialState({
      messages: dbMessages as any,
      metadata: { agentId: 'agent-ru-137k', topicId: 'topic-ru-137k' },
      modelRuntimeConfig: {
        compressionModel: { model: 'deepseek-flash', provider: 'deepseek' },
        model: 'deepseek-flash',
        provider: 'deepseek',
      },
      operationId: 'op-ru-137k',
      status: 'running',
    });

    const ctx: any = {
      messageModel: {
        create: vi.fn(),
        query: vi.fn(async () => dbMessages),
        update: vi.fn(),
      },
      operationId: 'op-ru-137k',
      serverDB: {},
      stepIndex: 0,
      streamManager: { publishStreamChunk: vi.fn(), publishStreamEvent: vi.fn() },
      toolExecutionService: { executeTool: vi.fn() },
      userId: 'user-ru-137k',
    };

    await createRuntimeExecutors(ctx).compress_context!(
      {
        payload: {
          currentTokenCount: 420_000,
          messages: state.messages,
          parentMessageId: 'msg-u-active',
        },
        type: 'compress_context',
      },
      state,
    );

    expect(deepseekChat).toHaveBeenCalledOnce();
    expect(upsertRollingCompressionGroup).toHaveBeenCalledWith(
      'topic-ru-137k',
      [],
      expect.any(Object),
      'Единая консолидированная сводка.',
    );
    expect(capturedPayload).toBeDefined();
    const sentMessages = capturedPayload!.messages;
    expect(sentMessages[0].role).toBe('system');
    expect(sentMessages.at(-1)?.role).toBe('user');

    // ZERO consecutive role='user' messages
    for (let i = 1; i < sentMessages.length; i++) {
      expect(sentMessages[i - 1].role === 'user' && sentMessages[i].role === 'user').toBe(false);
    }

    const userMessages = sentMessages.filter((m) => m.role === 'user');
    const summaryChunks = userMessages.filter((m) =>
      String(m.content).includes('<existing_summary part='),
    );
    // ~250KB UTF-8 Russian text must split into >= 4 chunks (each <= 60,000 UTF-8 bytes)
    expect(summaryChunks.length).toBeGreaterThanOrEqual(4);
    for (const userMsg of userMessages) {
      const content = String(userMsg.content);
      expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(60_000);
      expect(estimateTokens(content)).toBeLessThanOrEqual(20_000);
      expect(hasLoneSurrogate(content)).toBe(false);
    }
  });

  it('Finding #1C: splitTextToTokenBudget never splits UTF-16 surrogate pairs across chunk boundaries', () => {
    // 297 ASCII bytes + 1 lone high surrogate (3 UTF-8 bytes) = 300 bytes (exact budget*3 limit),
    // whereas 297 ASCII bytes + complete '🚀' (4 UTF-8 bytes) = 301 bytes (> 300).
    // Without the surrogate-pair guard, slicing lands right between high & low surrogate!
    const budget = 100;
    const emojiAtExactBoundary =
      'a'.repeat(budget * 3 - 3) + '🚀' + '🔥'.repeat(10) + 'b'.repeat(50);
    const slices = splitTextToTokenBudget(emojiAtExactBoundary, budget);

    expect(slices.length).toBeGreaterThanOrEqual(2);
    expect(slices.join('')).toBe(emojiAtExactBoundary);
    for (const slice of slices) {
      expect(hasLoneSurrogate(slice)).toBe(false);
      expect(Buffer.byteLength(slice, 'utf8')).toBeLessThanOrEqual(budget * 3);
      expect(estimateTokens(slice)).toBeLessThanOrEqual(budget);
    }
    expect(slices[0].endsWith('a')).toBe(true);
    expect(slices[1].startsWith('🚀')).toBe(true);

    // Also verify high-volume Russian + emoji summary at the real 20K summary slice budget
    const summaryBudget = 20_000 - 256;
    const prefix = 'Б'.repeat((summaryBudget * 3 - 4) / 2); // exact even Cyrillic byte fill near boundary
    const largeWithEmoji = `${prefix}🚀🎉🔥${'В'.repeat(20_000)}`;
    const largeSlices = splitTextToTokenBudget(largeWithEmoji, summaryBudget);
    expect(largeSlices.length).toBeGreaterThanOrEqual(2);
    expect(largeSlices.join('')).toBe(largeWithEmoji);
    for (const slice of largeSlices) {
      expect(hasLoneSurrogate(slice)).toBe(false);
      expect(Buffer.byteLength(slice, 'utf8')).toBeLessThanOrEqual(summaryBudget * 3);
    }
  });

  it('Finding #3: mid-turn compression never emits orphan role=tool for synthetic unresolved tool calls when persisted assistant has tools: undefined or was filtered as an empty placeholder', async () => {
    const priorUser = { content: 'Turn 1', id: 'msg-u1', role: 'user' };
    const priorAsst = { content: 'Turn 1 reply', id: 'msg-a1', role: 'assistant' };
    const activeUser = { content: 'Turn 2', id: 'msg-u2', role: 'user' };

    // Case A: Persisted assistant row exists with non-empty text, but tools: undefined
    // (because all tool calls were unresolved and omitted from DB persistence).
    const activeAsstNoTools = {
      content: 'Attempting unavailable tool',
      id: 'msg-a2-notools',
      role: 'assistant',
      tools: undefined,
    };
    const syntheticToolA = {
      apiName: 'missing_tool',
      arguments: '{"q":"test"}',
      id: 'tc-syn-a',
      identifier: '__arckep_unresolved_tool__',
      result: {
        content: 'Tool missing_tool is not available.',
        id: 'synthetic-tc-syn-a',
      },
      type: 'default',
    };
    const hydratedGroupA = {
      children: [
        {
          content: 'Attempting unavailable tool',
          id: 'msg-a2-notools',
          tools: [syntheticToolA],
        },
      ],
      content: '',
      id: 'group-a',
      role: 'assistantGroup',
    };

    const dbMessagesA = [priorUser, priorAsst, activeUser, activeAsstNoTools];
    const stateA = AgentRuntime.createInitialState({
      messages: [priorUser, priorAsst, activeUser, hydratedGroupA] as any,
      metadata: { agentId: 'agent-syn-a', topicId: 'topic-syn-a' },
      modelRuntimeConfig: {
        compressionModel: { model: 'deepseek-flash', provider: 'deepseek' },
        model: 'deepseek-flash',
        provider: 'deepseek',
      },
      operationId: 'op-syn-a',
      status: 'running',
    });

    vi.mocked(MessageService).mockImplementationOnce(function () {
      return {
        upsertRollingCompressionGroup: vi.fn(async () => ({
          messageGroupId: 'grp-syn-a',
          messages: [
            { content: 'Summary A', id: 'grp-syn-a', role: 'compressedGroup' },
            activeUser,
            { ...activeAsstNoTools },
          ],
        })),
      } as unknown as MessageService;
    });
    vi.mocked(initModelRuntimeFromDB).mockResolvedValueOnce({
      chat: vi.fn(async (_payload: unknown, options: any) => {
        await options.callback.onText('Summary A');
        return new Response('');
      }),
    } as any);

    const ctxA: any = {
      messageModel: {
        create: vi.fn(),
        query: vi.fn(async () => dbMessagesA),
        update: vi.fn(),
      },
      operationId: 'op-syn-a',
      serverDB: {},
      stepIndex: 1,
      streamManager: { publishStreamChunk: vi.fn(), publishStreamEvent: vi.fn() },
      toolExecutionService: { executeTool: vi.fn() },
      userId: 'user-syn-a',
    };

    const resultA = await createRuntimeExecutors(ctxA).compress_context!(
      {
        payload: {
          currentTokenCount: 360_000,
          messages: stateA.messages,
          parentMessageId: 'msg-a2-notools',
        },
        type: 'compress_context',
      },
      stateA,
    );

    const compressedA = (resultA.nextContext?.payload as any).compressedMessages as any[];
    const toolIdxA = compressedA.findIndex(
      (m) => m.role === 'tool' && m.tool_call_id === 'tc-syn-a',
    );
    expect(toolIdxA).toBeGreaterThan(0);
    const owningAsstA = compressedA[toolIdxA - 1];
    expect(owningAsstA).toMatchObject({
      content: 'Attempting unavailable tool',
      id: 'msg-a2-notools',
      role: 'assistant',
      tools: [
        {
          apiName: 'missing_tool',
          arguments: '{"q":"test"}',
          id: 'tc-syn-a',
          identifier: '__arckep_unresolved_tool__',
          type: 'default',
        },
      ],
    });
    expect(owningAsstA.tools[0]).not.toHaveProperty('result');

    // Case B: Persisted assistant row was an empty placeholder (shouldReuseAssistantForFollowUp = true)
    // and was filtered out by isEmptyAssistantPlaceholder -> must restore minimal assistant carrying
    // ALL synthetic tool calls immediately before the synthetic role='tool' messages.
    const emptyPersistedAsst = {
      content: '',
      id: 'msg-a2-empty',
      role: 'assistant',
      tools: undefined,
    };
    const syntheticToolB1 = {
      apiName: 'unknown_one',
      arguments: '{}',
      id: 'tc-syn-b1',
      identifier: '__arckep_unresolved_tool__',
      result: { content: 'Tool unknown_one unavailable.', id: 'synthetic-tc-syn-b1' },
      type: 'default',
    };
    const syntheticToolB2 = {
      apiName: 'unknown_two',
      arguments: '{}',
      id: 'tc-syn-b2',
      identifier: '__arckep_unresolved_tool__',
      result: { content: 'Tool unknown_two unavailable.', id: 'synthetic-tc-syn-b2' },
      type: 'default',
    };
    const hydratedGroupB = {
      children: [
        {
          content: '',
          id: 'msg-a2-empty',
          tools: [syntheticToolB1, syntheticToolB2],
        },
      ],
      content: '',
      id: 'group-b',
      role: 'assistantGroup',
    };

    const dbMessagesB = [priorUser, priorAsst, activeUser, emptyPersistedAsst];
    const stateB = AgentRuntime.createInitialState({
      messages: [priorUser, priorAsst, activeUser, hydratedGroupB] as any,
      metadata: {
        agentId: 'agent-syn-b',
        reuseAssistantMessageId: 'msg-a2-empty',
        topicId: 'topic-syn-b',
      },
      modelRuntimeConfig: {
        compressionModel: { model: 'deepseek-flash', provider: 'deepseek' },
        model: 'deepseek-flash',
        provider: 'deepseek',
      },
      operationId: 'op-syn-b',
      status: 'running',
    });

    vi.mocked(MessageService).mockImplementationOnce(function () {
      return {
        upsertRollingCompressionGroup: vi.fn(async () => ({
          messageGroupId: 'grp-syn-b',
          messages: [
            { content: 'Summary B', id: 'grp-syn-b', role: 'compressedGroup' },
            activeUser,
            { ...emptyPersistedAsst },
          ],
        })),
      } as unknown as MessageService;
    });
    vi.mocked(initModelRuntimeFromDB).mockResolvedValueOnce({
      chat: vi.fn(async (_payload: unknown, options: any) => {
        await options.callback.onText('Summary B');
        return new Response('');
      }),
    } as any);

    const ctxB: any = {
      messageModel: {
        create: vi.fn(),
        query: vi.fn(async () => dbMessagesB),
        update: vi.fn(),
      },
      operationId: 'op-syn-b',
      serverDB: {},
      stepIndex: 1,
      streamManager: { publishStreamChunk: vi.fn(), publishStreamEvent: vi.fn() },
      toolExecutionService: { executeTool: vi.fn() },
      userId: 'user-syn-b',
    };

    const resultB = await createRuntimeExecutors(ctxB).compress_context!(
      {
        payload: {
          currentTokenCount: 360_000,
          messages: stateB.messages,
          parentMessageId: 'msg-a2-empty',
        },
        type: 'compress_context',
      },
      stateB,
    );

    const compressedB = (resultB.nextContext?.payload as any).compressedMessages as any[];
    expect(compressedB).toEqual([
      { content: 'Summary B', id: 'grp-syn-b', role: 'compressedGroup' },
      activeUser,
      {
        content: '',
        id: 'msg-a2-empty',
        role: 'assistant',
        tools: [
          {
            apiName: 'unknown_one',
            arguments: '{}',
            id: 'tc-syn-b1',
            identifier: '__arckep_unresolved_tool__',
            type: 'default',
          },
          {
            apiName: 'unknown_two',
            arguments: '{}',
            id: 'tc-syn-b2',
            identifier: '__arckep_unresolved_tool__',
            type: 'default',
          },
        ],
      },
      {
        content: 'Tool unknown_one unavailable.',
        role: 'tool',
        tool_call_id: 'tc-syn-b1',
      },
      {
        content: 'Tool unknown_two unavailable.',
        role: 'tool',
        tool_call_id: 'tc-syn-b2',
      },
    ]);
  });

  it('deduplicates flat call_tool messages already present in DB and merges missing synthetic tool_calls onto matched DB assistant', async () => {
    const priorUser = { content: 'Prior turn question', id: 'msg-u0', role: 'user' };
    const priorAsst = { content: 'Prior turn answer', id: 'msg-a0', role: 'assistant' };
    const activeUser = { content: 'Active question', id: 'msg-u1', role: 'user' };
    const dbAsstRealTool = {
      content: 'Let me inspect that.',
      id: 'msg-a1',
      role: 'assistant',
      tools: [
        {
          apiName: 'readKnowledge',
          arguments: '{}',
          id: 'tc-real-1',
          identifier: 'lobe-knowledge-base',
          type: 'builtin',
        },
      ],
    };
    const dbRealTool = {
      content: 'DB tool output',
      id: 'msg-t1',
      role: 'tool',
      tool_call_id: 'tc-real-1',
    };

    // Case A: flat call_tool pushed a no-id assistant + no-id tool that are already persisted in DB
    const executorsA = createRuntimeExecutors({
      messageModel: {
        query: vi
          .fn()
          .mockResolvedValue([priorUser, priorAsst, activeUser, dbAsstRealTool, dbRealTool]),
      } as any,
      operationId: 'op-flat-dedup',
      serverDB: {} as any,
      stepIndex: 2,
      streamManager: {
        publishStreamChunk: vi.fn(),
        publishStreamEvent: vi.fn(),
      } as any,
      userId: 'user-1',
    });

    vi.mocked(MessageService).mockImplementationOnce(function () {
      return {
        upsertRollingCompressionGroup: vi.fn(async () => ({
          messageGroupId: 'grp-flat-dedup',
          messages: [
            { content: 'Summary flat', id: 'grp-flat-dedup', role: 'compressedGroup' },
            activeUser,
            dbAsstRealTool,
            dbRealTool,
          ],
        })),
      } as unknown as MessageService;
    });
    vi.mocked(initModelRuntimeFromDB).mockResolvedValueOnce({
      chat: vi.fn(async (_payload: unknown, options: any) => {
        await options?.callback?.onText?.('Summary flat');
        return new Response('');
      }),
    } as any);

    const stateA = AgentRuntime.createInitialState({
      messages: [
        priorUser,
        priorAsst,
        activeUser,
        {
          content: 'Let me inspect that.',
          role: 'assistant',
          tool_calls: [
            {
              function: {
                arguments: '{}',
                name: 'lobe-knowledge-base____readKnowledge____builtin',
              },
              id: 'tc-real-1',
              type: 'function',
            },
          ],
        },
        { content: 'DB tool output', role: 'tool', tool_call_id: 'tc-real-1' },
      ] as any,
      metadata: { agentId: 'agent-1', topicId: 'topic-1' },
      modelRuntimeConfig: {
        compressionModel: { model: 'deepseek-flash', provider: 'deepseek' },
        model: 'deepseek-flash',
        provider: 'deepseek',
      },
      operationId: 'op-flat-dedup',
      status: 'running',
    });

    const resA = await executorsA.compress_context!(
      {
        payload: {
          currentTokenCount: 900_000,
          messages: stateA.messages,
          parentMessageId: 'msg-t1',
        },
        type: 'compress_context',
      },
      stateA,
    );
    const outA = (resA.nextContext?.payload as any).compressedMessages as any[];
    expect(outA.filter((m) => m.role === 'tool' && m.tool_call_id === 'tc-real-1')).toHaveLength(1);

    // Case B: purely-synthetic flat batch where DB assistant has text + tools: undefined,
    // while in-memory assistant carries synthetic tool_calls and a no-id synthetic tool message
    const dbAsstTextOnly = {
      content: 'Trying tool...',
      id: 'msg-a2',
      role: 'assistant',
    };
    const executorsB = createRuntimeExecutors({
      messageModel: {
        query: vi.fn().mockResolvedValue([priorUser, priorAsst, activeUser, dbAsstTextOnly]),
      } as any,
      operationId: 'op-flat-syn',
      serverDB: {} as any,
      stepIndex: 2,
      streamManager: {
        publishStreamChunk: vi.fn(),
        publishStreamEvent: vi.fn(),
      } as any,
      userId: 'user-1',
    });

    vi.mocked(MessageService).mockImplementationOnce(function () {
      return {
        upsertRollingCompressionGroup: vi.fn(async () => ({
          messageGroupId: 'grp-flat-syn',
          messages: [
            { content: 'Summary syn', id: 'grp-flat-syn', role: 'compressedGroup' },
            activeUser,
            dbAsstTextOnly,
          ],
        })),
      } as unknown as MessageService;
    });
    vi.mocked(initModelRuntimeFromDB).mockResolvedValueOnce({
      chat: vi.fn(async (_payload: unknown, options: any) => {
        await options?.callback?.onText?.('Summary syn');
        return new Response('');
      }),
    } as any);

    const stateB = AgentRuntime.createInitialState({
      messages: [
        priorUser,
        priorAsst,
        activeUser,
        {
          content: 'Trying tool...',
          role: 'assistant',
          tool_calls: [
            {
              function: { arguments: '{}', name: '__arckep_unresolved_tool____missing_fn' },
              id: 'tc-syn-flat',
              type: 'function',
            },
          ],
        },
        { content: 'Tool missing_fn unavailable.', role: 'tool', tool_call_id: 'tc-syn-flat' },
        { content: 'Stray orphan without owner', role: 'tool', tool_call_id: 'tc-orphan-none' },
      ] as any,
      metadata: { agentId: 'agent-1', topicId: 'topic-1' },
      modelRuntimeConfig: {
        compressionModel: { model: 'deepseek-flash', provider: 'deepseek' },
        model: 'deepseek-flash',
        provider: 'deepseek',
      },
      operationId: 'op-flat-syn',
      status: 'running',
    });

    const resB = await executorsB.compress_context!(
      {
        payload: {
          currentTokenCount: 900_000,
          messages: stateB.messages,
          parentMessageId: 'msg-a2',
        },
        type: 'compress_context',
      },
      stateB,
    );
    const outB = (resB.nextContext?.payload as any).compressedMessages as any[];
    const matchedAsst = outB.find((m) => m.id === 'msg-a2');
    expect(matchedAsst?.tool_calls).toEqual([
      {
        function: { arguments: '{}', name: '__arckep_unresolved_tool____missing_fn' },
        id: 'tc-syn-flat',
        type: 'function',
      },
    ]);
    // Immutability: original DB object was not mutated
    expect((dbAsstTextOnly as any).tool_calls).toBeUndefined();
    // Synthetic tool is spliced right after its owning assistant; orphan tool is dropped
    const asstIdx = outB.findIndex((m) => m.id === 'msg-a2');
    expect(outB[asstIdx + 1]).toEqual({
      content: 'Tool missing_fn unavailable.',
      role: 'tool',
      tool_call_id: 'tc-syn-flat',
    });
    expect(outB.some((m) => m.tool_call_id === 'tc-orphan-none')).toBe(false);
  });
});
