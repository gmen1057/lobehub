// @vitest-environment node
import { AgentRuntime, GeneralChatAgent, shouldCompress } from '@lobechat/agent-runtime';
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
  resolveCompressionModelConfig,
  resolveCompressionThresholds,
} from '../compressionThresholds';
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
vi.mock('@lobechat/prompts', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    chainCompressContext: vi.fn(actual.chainCompressContext as typeof chainCompressContext),
  };
});

const makeMessagesWithTokens = (approxTokens: number) => [
  {
    content: '',
    id: 'msg-history-asst',
    metadata: { usage: { totalOutputTokens: approxTokens } },
    role: 'assistant',
  },
  { content: 'Follow-up question', id: 'msg-user-latest', role: 'user' },
];

describe('ENG-2A: compressionThresholds & GeneralChatAgent auto-compression limits', () => {
  it('resolves deepseek/deepseek-flash route ceiling to 32_768 (~22K initial, ~26K recompression)', () => {
    const policy = resolveCompressionThresholds('deepseek-flash', 'deepseek');
    expect(policy).toEqual({
      maxWindowToken: 32_768,
      recompressionThresholdRatio: 0.8,
      thresholdRatio: 0.68,
    });

    // ~20K tokens: below ~22,282 threshold -> no compression
    expect(shouldCompress(makeMessagesWithTokens(20_000), policy).needsCompression).toBe(false);

    // ~24K tokens: above ~22,282 threshold (well before 32,768 HTTP 413) -> triggers compression
    const check24k = shouldCompress(makeMessagesWithTokens(24_000), policy);
    expect(check24k.threshold).toBe(Math.floor(32_768 * 0.68));
    expect(check24k.needsCompression).toBe(true);

    // Hysteresis after first compression: 24K < ~26,214 -> does NOT immediately recompress
    const agent = new GeneralChatAgent({
      compressionConfig: { ...policy, enabled: true },
      modelRuntimeConfig: { model: 'deepseek-flash', provider: 'deepseek' },
      operationId: 'op-ds-flash',
    });
    const stateAfterFirstCompress = AgentRuntime.createInitialState({
      messages: [
        { content: 'Summary of earlier turns', id: 'grp-1', role: 'compressedGroup' },
        ...makeMessagesWithTokens(23_500),
      ] as any,
      operationId: 'op-ds-flash',
      status: 'running',
    });
    return expect(
      agent.runner({ payload: {}, phase: 'user_input' }, stateAfterFirstCompress),
    ).resolves.toMatchObject({ type: 'call_llm' });
  });

  it.each([
    ['anthropic', 'claude-sonnet-5-5'],
    ['anthropic', 'claude-opus-5-5'],
    ['anthropic', 'claude-fable-5-2'],
    ['anthropic', 'claude-haiku-5-5'],
    ['google', 'gemini-4-carbon'],
    ['openai', 'gpt-6.2-sol'],
    ['deepseek', 'deepseek-v4-pro'],
    ['qwen', 'qwen4-max'],
  ])(
    'resolves 1M model %s/%s to 360K effective window (180K initial, 234K recompression)',
    async (provider, model) => {
      const policy = resolveCompressionThresholds(model, provider);
      expect(policy).toEqual({
        maxWindowToken: EFFECTIVE_AUTO_COMPRESS_WINDOW_CAP,
        recompressionThresholdRatio: 0.65,
        thresholdRatio: 0.5,
      });

      // Must NOT compress at 70K or 150K (previously compressed at 64K!)
      expect(shouldCompress(makeMessagesWithTokens(70_000), policy).needsCompression).toBe(false);
      expect(shouldCompress(makeMessagesWithTokens(150_000), policy).needsCompression).toBe(false);

      // Triggers above 180K
      const over180k = shouldCompress(makeMessagesWithTokens(185_000), policy);
      expect(over180k.threshold).toBe(180_000);
      expect(over180k.needsCompression).toBe(true);

      // Recompression hysteresis holds until 234K
      const agent = new GeneralChatAgent({
        compressionConfig: { ...policy, enabled: true },
        modelRuntimeConfig: { model, provider },
        operationId: 'op-1m',
      });
      const at210kWithSummary = AgentRuntime.createInitialState({
        messages: [
          { content: 'Prior summary', id: 'grp-1', role: 'compressedGroup' },
          ...makeMessagesWithTokens(210_000),
        ] as any,
        operationId: 'op-1m',
        status: 'running',
      });
      const stepAt210k = await agent.runner(
        { payload: {}, phase: 'user_input' },
        at210kWithSummary,
      );
      expect((stepAt210k as any).type).toBe('call_llm');

      const at240kWithSummary = AgentRuntime.createInitialState({
        messages: [
          { content: 'Prior summary', id: 'grp-1', role: 'compressedGroup' },
          ...makeMessagesWithTokens(240_000),
        ] as any,
        operationId: 'op-1m',
        status: 'running',
      });
      const stepAt240k = await agent.runner(
        { payload: {}, phase: 'user_input' },
        at240kWithSummary,
      );
      expect((stepAt240k as any).type).toBe('compress_context');
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

    const createCompressionGroup = vi.fn(async () => ({
      messageGroupId: 'grp-no-cache',
      messages: [
        { content: 'Condensed topic summary.', id: 'grp-no-cache', role: 'compressedGroup' },
      ],
      messagesToSummarize: [],
      success: true,
    }));
    vi.mocked(MessageService).mockImplementationOnce(function () {
      return { createCompressionGroup } as unknown as MessageService;
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
        metadata: { usage: { totalOutputTokens: 25_000 } },
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

    const createCompressionGroup = vi.fn(async () => ({
      messageGroupId: 'grp-clean',
      // Simulate MessageService.createCompressionGroup re-querying DB where asst-live-2 still sits uncompressed
      messages: [
        { content: 'Clean summary', id: 'grp-clean', role: 'compressedGroup' },
        currentUserMsg,
        { content: LOADING_FLAT, id: 'asst-live-2', parentId: 'msg-u2', role: 'assistant' },
      ],
      messagesToSummarize: [],
      success: true,
    }));
    vi.mocked(MessageService).mockImplementationOnce(function () {
      return { createCompressionGroup } as unknown as MessageService;
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

    // 1. Live placeholder and historical empty stubs were excluded from createCompressionGroup & chainCompressContext,
    //    while assistant message with tool calls (msg-a2-tools) WAS preserved in summarization!
    expect(createCompressionGroup).toHaveBeenCalledWith(
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

  it('ENG-2B: routes normal compression to claude-haiku-5-5 (effort: low) and keeps deepseekDataGuardProtected strictly on deepseek-flash', async () => {
    expect(resolveCompressionModelConfig()).toEqual(DEFAULT_COMPRESSION_MODEL);
    expect(
      resolveCompressionModelConfig({
        agentConfig: { chatConfig: { deepseekDataGuardProtected: false } },
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

    const createCompressionGroup = vi.fn(async () => ({
      messageGroupId: 'grp-guard',
      messages: [
        { content: 'Protected summary on DeepSeek.', id: 'grp-guard', role: 'compressedGroup' },
      ],
      messagesToSummarize: [],
      success: true,
    }));
    vi.mocked(MessageService).mockImplementationOnce(function () {
      return { createCompressionGroup } as unknown as MessageService;
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

  it('preserves non-empty broken HTML draft across compress_context during htmlArtifactSyntaxError repair pass', async () => {
    const brokenHtml = '<lobeArtifact identifier="dash" type="text/html"><div>broken';
    const repairPrompt = {
      content: 'Line 1: unclosed <div>. Исправь синтаксическую ошибку...',
      role: 'user',
    };
    const dbMessages = [
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

    const createCompressionGroup = vi.fn(async () => ({
      messageGroupId: 'grp-html',
      // Verify fallback path (messages: undefined) as well as DB return path:
      // preserved non-empty asst-broken must stay between compressedGroup/history and repairPrompt
      messages: [
        { content: 'Earlier dashboard request summary', id: 'grp-html', role: 'compressedGroup' },
        { content: brokenHtml, id: 'asst-broken', role: 'assistant' },
      ],
      messagesToSummarize: [{ content: 'Build dashboard', id: 'msg-u1', role: 'user' }],
      success: true,
    }));
    vi.mocked(MessageService).mockImplementationOnce(function () {
      return { createCompressionGroup } as unknown as MessageService;
    });

    vi.mocked(initModelRuntimeFromDB).mockResolvedValueOnce({
      chat: vi.fn(async (_payload: unknown, options: any) => {
        await options.callback.onText('Earlier dashboard request summary');
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
          currentTokenCount: 190_000,
          messages: state.messages,
          parentMessageId: 'asst-broken',
        },
        type: 'compress_context',
      },
      state,
    );

    // asst-broken was NOT hidden inside compressedGroup in DB
    expect(createCompressionGroup).toHaveBeenCalledWith(
      'topic-html',
      ['msg-u1'],
      expect.any(Object),
      'Earlier dashboard request summary',
    );
    // And the broken HTML draft remains in compressedMessages right before the repair user prompt!
    expect((result.nextContext?.payload as any).compressedMessages).toEqual([
      { content: 'Earlier dashboard request summary', id: 'grp-html', role: 'compressedGroup' },
      { content: brokenHtml, id: 'asst-broken', role: 'assistant' },
      repairPrompt,
    ]);
    expect((result.nextContext?.payload as any).assistantMessageId).toBe('asst-broken');
  });
});
