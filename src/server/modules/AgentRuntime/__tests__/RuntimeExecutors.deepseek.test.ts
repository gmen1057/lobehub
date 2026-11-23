// @vitest-environment node
import { AgentRuntime } from '@lobechat/agent-runtime';
import {
  DisabledToolCallFilter,
  MessageCleanupProcessor,
  ToolMessageReorder,
} from '@lobechat/context-engine';
import { expect, it, vi } from 'vitest';

import { initModelRuntimeFromDB } from '@/server/modules/ModelRuntime';
import { compactWriterContext } from '@/server/services/textFiles/context';

import { convertOpenAIMessages } from '../../../../../packages/model-runtime/src/core/contextBuilders/openai';
import { params as deepseekParams } from '../../../../../packages/model-runtime/src/providers/deepseek';
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

it('preserves deepseek-v4-pro reasoning_content in agent state across single-tool steps', async () => {
  const state = AgentRuntime.createInitialState({
    operationId: 'op-v4-pro',
    metadata: { agentId: 'a', topicId: 't' },
    status: 'running',
  });
  const call = {
    id: 'call_00_activate',
    type: 'function',
    function: {
      name: 'lobe-activator____activateTools____builtin',
      arguments: '{"identifiers":["mcp-arckep-e2b-sandbox"]}',
    },
  };
  const chat = vi.fn(async (_payload, options) => {
    await options.callback.onThinking('Need to activate sandbox before reading anchors.');
    await options.callback.onText('Активирую песочницу.');
    await options.callback.onToolsCalling({ toolsCalling: [call] });
    return new Response('');
  });
  vi.mocked(initModelRuntimeFromDB).mockResolvedValue({ chat } as any);
  const ctx: any = {
    operationId: 'op-v4-pro',
    stepIndex: 0,
    userId: 'user',
    messageModel: {
      create: vi.fn(async () => ({ id: 'assistant-1' })),
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
      payload: { model: 'deepseek-v4-pro', provider: 'deepseek', messages: [], tools: [] },
    } as any,
    state,
  );

  const message = result.newState.messages.at(-1);
  expect(message).toMatchObject({
    content: 'Активирую песочницу.',
    reasoning_content: 'Need to activate sandbox before reading anchors.',
    role: 'assistant',
    tool_calls: [call],
  });
  expect(ctx.messageModel.update.mock.calls.at(-1)[1].reasoning).toEqual({
    content: 'Need to activate sandbox before reading anchors.',
  });
});

it('prefers deepseek-flash grounding final-step reasoning_content, falling back to thinkingContent when grounding omits it', async () => {
  const runFlash = async (groundingData: any, thought: string) => {
    const state = AgentRuntime.createInitialState({
      operationId: 'op-flash',
      metadata: { agentId: 'a', topicId: 't' },
      status: 'running',
    });
    const chat = vi.fn(async (_payload, options) => {
      await options.callback.onThinking(thought);
      await options.callback.onText('Готово');
      await options.callback.onGrounding(groundingData);
      return new Response('');
    });
    vi.mocked(initModelRuntimeFromDB).mockResolvedValue({ chat } as any);
    const ctx: any = {
      operationId: 'op-flash',
      stepIndex: 0,
      userId: 'user',
      messageModel: {
        create: vi.fn(async () => ({ id: 'assistant-flash' })),
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
    return result.newState.messages.at(-1);
  };

  const withGroundingReasoning = await runFlash(
    {
      citations: [],
      deepseek: { annotations: [], reasoning_content: 'final step only', server_tool_calls: [] },
    },
    'step1 + final step only',
  );
  expect(withGroundingReasoning.reasoning_content).toBe('final step only');

  const withoutGroundingReasoning = await runFlash(
    {
      citations: [],
      deepseek: { annotations: [], finish_reason: 'tool_calls', server_tool_calls: [] },
    },
    'thinking without native step',
  );
  expect(withoutGroundingReasoning.reasoning_content).toBe('thinking without native step');
});

it('keeps reasoning_content end-to-end when consecutive deepseek-v4-pro assistant turns survive unresolved-tool filtering or compactWriterContext', async () => {
  // Scenario 1 (BACKEND-XZ): step 0 produces unresolved tool call -> step 1 unresolved feedback ->
  // step 2 produces activateTools -> step 3 activates tool -> step 4 filters out __arckep_unresolved_tool__,
  // leaving two consecutive assistant messages before the final tool result.
  const unresolvedFiltered = await new DisabledToolCallFilter({
    disabledToolIdentifiers: ['__arckep_unresolved_tool__'],
  }).process({
    initialState: { messages: [], model: 'deepseek-v4-pro', provider: 'deepseek' },
    isAborted: false,
    messages: [
      { content: 'Давай обе', id: 'u1', role: 'user' },
      {
        content: 'Отлично, делаю обе.',
        id: 'a1',
        reasoning_content: 'Step 0 thinking (45k chars)',
        role: 'assistant',
        tool_calls: [
          {
            function: { arguments: '{}', name: '__arckep_unresolved_tool______sandbox_exec' },
            id: 'call_unresolved',
            type: 'function',
          },
        ],
      },
      {
        content: '{"error":"not active"}',
        id: 't1',
        role: 'tool',
        tool_call_id: 'call_unresolved',
      },
      {
        content: '',
        id: 'a2',
        reasoning_content: 'Step 2 thinking (5k chars)',
        role: 'assistant',
        tool_calls: [
          {
            function: {
              arguments: '{"identifiers":["mcp-arckep-e2b-sandbox"]}',
              name: 'lobe-activator____activateTools____builtin',
            },
            id: 'call_activate',
            type: 'function',
          },
        ],
      },
      { content: 'Activated tools', id: 't2', role: 'tool', tool_call_id: 'call_activate' },
    ],
    metadata: {},
  });
  const reordered = await new ToolMessageReorder().process(unresolvedFiltered);
  const cleaned = await new MessageCleanupProcessor(
    {},
    { model: 'deepseek-v4-pro', provider: 'deepseek' },
  ).process(reordered);
  const handled = deepseekParams.chatCompletion.handlePayload({
    messages: cleaned.messages,
    model: 'deepseek-v4-pro',
  } as any);
  const wireMessages = (await convertOpenAIMessages(handled.messages)) as any[];

  expect(wireMessages.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant', 'tool']);
  expect(wireMessages[1].tool_calls).toBeUndefined();
  expect(wireMessages[1].reasoning_content).toBe('Step 0 thinking (45k chars)');
  expect(wireMessages[2].reasoning_content).toBe('Step 2 thinking (5k chars)');

  // Scenario 2 (61d90145): compactWriterContext strips superseded patchFile #1 from the first
  // assistant message while keeping its prose, leaving consecutive assistant messages.
  const compacted = compactWriterContext(
    [
      { content: 'Обнови файл', id: 'u-req', role: 'user' },
      {
        content: 'Применяю первую правку:',
        reasoning_content: 'Patch 1 thinking',
        role: 'assistant',
        tool_calls: [
          {
            function: {
              arguments: '{"documentId":"doc1","edits":[{}]}',
              name: 'arckep-text-file____patchFile____builtin',
            },
            id: 'call_patch_1',
            type: 'function',
          },
        ],
      },
      {
        content: 'ARCKEP_TEXT_FILE_V1\n{"documentId":"doc1","part":3,"status":"ready"}\nPatch 1 ok',
        role: 'tool',
        tool_call_id: 'call_patch_1',
      },
      {
        content: 'Исправляю вторую ошибку:',
        reasoning_content: 'Patch 2 thinking',
        role: 'assistant',
        tool_calls: [
          {
            function: {
              arguments: '{"documentId":"doc1","edits":[{}]}',
              name: 'arckep-text-file____patchFile____builtin',
            },
            id: 'call_patch_2',
            type: 'function',
          },
        ],
      },
      {
        content: 'ARCKEP_TEXT_FILE_V1\n{"documentId":"doc1","part":4,"status":"ready"}\nPatch 2 ok',
        role: 'tool',
        tool_call_id: 'call_patch_2',
      },
    ],
    'u-req',
  );
  const compactedCleaned = await new MessageCleanupProcessor(
    {},
    { model: 'deepseek-v4-pro', provider: 'deepseek' },
  ).process({
    initialState: { messages: [], model: 'deepseek-v4-pro', provider: 'deepseek' },
    isAborted: false,
    messages: compacted,
    metadata: {},
  });
  const compactedHandled = deepseekParams.chatCompletion.handlePayload({
    messages: compactedCleaned.messages,
    model: 'deepseek-v4-pro',
  } as any);
  const compactedWire = (await convertOpenAIMessages(compactedHandled.messages)) as any[];

  expect(compactedWire.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant', 'tool']);
  expect(compactedWire[1].tool_calls).toBeUndefined();
  expect(compactedWire[1].reasoning_content).toBe('Patch 1 thinking');
  expect(compactedWire[2].reasoning_content).toBe('Patch 2 thinking');
});
