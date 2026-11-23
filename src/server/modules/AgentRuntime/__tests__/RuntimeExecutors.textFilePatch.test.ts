// @vitest-environment node
import { AgentRuntime } from '@lobechat/agent-runtime';
import { TopicReferenceIdentifier } from '@lobechat/builtin-tool-topic-reference';
import { TEXT_FILE_TOOL } from '@lobechat/builtin-tools';
import { describe, expect, it, vi } from 'vitest';

import { RECEIPT_PREFIX } from '@/server/services/textFiles/store';

import { createRuntimeExecutors, type RuntimeExecutorContext } from '../RuntimeExecutors';

vi.mock('@/server/modules/ModelRuntime', () => ({ initModelRuntimeFromDB: vi.fn() }));
vi.mock('@/server/modules/Mecha/ContextEngineering', () => ({ serverMessagesEngine: vi.fn() }));
vi.mock('@/server/services/message', () => ({ MessageService: class {} }));
vi.mock('@/server/services/file', () => ({ FileService: class {} }));
vi.mock('@/envs/file', () => ({ fileEnv: { NEXT_PUBLIC_S3_FILE_PATH: 'files' } }));
vi.mock('@/server/services/agentDocuments', () => ({ AgentDocumentsService: vi.fn() }));
vi.mock('../arckepSearch', () => ({ resolveServerEnabledSearch: vi.fn(async () => false) }));
vi.mock('../serverModelParams', () => ({ resolveServerModelParams: vi.fn(async () => ({})) }));
vi.mock('../llmTrace', () => ({
  createEngineTraceCallbacks: vi.fn(),
  withEngineTrace: (_trace: unknown, callbacks: unknown) => callbacks,
}));

const CANONICAL_RECEIPT =
  RECEIPT_PREFIX +
  JSON.stringify({
    documentId: '11111111-1111-5111-a111-111111111111',
    fileId: '22222222-2222-5222-a222-222222222222',
    fileName: 'Module1.bas',
    part: 2,
    status: 'ready',
  });

const FULL_PATCH_OUTPUT =
  CANONICAL_RECEIPT +
  '\nPatch applied: 1 edit, lines 10 -> 11 (+1 / -0), encoding utf-8 -> utf-8, lineEnding CRLF.\n@@ -1,2 +1,3 @@\n+Dim x As Long';

const manifest = (identifier: string, apiName: string) =>
  ({
    api: [{ description: 'desc', name: apiName, parameters: { properties: {}, type: 'object' } }],
    identifier,
    meta: { title: identifier },
    type: 'builtin',
  }) as any;

const makeRuntimeCtx = (executeTool: ReturnType<typeof vi.fn>) => {
  const create = vi.fn(async () => ({ id: 'tool_msg_1' }));
  const publishStreamEvent = vi.fn();
  const ctx = {
    messageModel: {
      addFiles: vi.fn(),
      create,
      query: vi.fn(async () => []),
      update: vi.fn(),
    },
    operationId: 'op_patch_exec',
    serverDB: {},
    stepIndex: 1,
    streamManager: {
      publishStreamChunk: vi.fn(),
      publishStreamEvent,
    },
    toolExecutionService: { executeTool },
    topicId: 'topic_1',
    userId: 'user_1',
  } as unknown as RuntimeExecutorContext;

  return { create, ctx, publishStreamEvent };
};

describe('RuntimeExecutors arckep-text-file/patchFile & co-activation', () => {
  it('strips diff tail in DB messages and tool_end events while keeping full diff in newState.messages for LLM (call_tool & call_tools_batch)', async () => {
    const patchResult = {
      content: FULL_PATCH_OUTPUT,
      executionTime: 12,
      state: {
        documentId: '11111111-1111-5111-a111-111111111111',
        part: 2,
        status: 'ready',
      },
      success: true,
    };

    const toolCall = {
      apiName: 'patchFile',
      arguments: JSON.stringify({
        documentId: '11111111-1111-5111-a111-111111111111',
        edits: [{ newText: 'Dim x As Long', oldText: 'Dim y As Long' }],
      }),
      id: 'tc_patch_1',
      identifier: TEXT_FILE_TOOL,
      type: 'builtin' as const,
    };

    const baseState = () => {
      const s = AgentRuntime.createInitialState({
        messages: [
          { content: 'Patch file', id: 'user_req_1', role: 'user' },
          {
            content: '',
            role: 'assistant',
            tool_calls: [
              {
                function: {
                  arguments: toolCall.arguments,
                  name: 'arckep-text-file____patchFile____builtin',
                },
                id: toolCall.id,
                type: 'function',
              },
            ],
          },
        ] as any,
        metadata: {
          agentId: 'agent_1',
          studioTextFileEnabled: true,
          studioTextFileRequestId: 'user_req_1',
          topicId: 'topic_1',
        },
        operationId: 'op_patch_exec',
      });
      s.operationToolSet = {
        enabledToolIds: [TEXT_FILE_TOOL],
        manifestMap: { [TEXT_FILE_TOOL]: manifest(TEXT_FILE_TOOL, 'patchFile') },
        sourceMap: {},
        tools: [],
      };
      return s;
    };

    // 1. call_tool
    {
      const executeTool = vi.fn(async () => patchResult);
      const { create, ctx, publishStreamEvent } = makeRuntimeCtx(executeTool);
      const executors = createRuntimeExecutors(ctx);
      const { newState } = await executors.call_tool!(
        {
          payload: { parentMessageId: 'asst_1', toolCalling: toolCall },
          type: 'call_tool',
        } as any,
        baseState(),
      );

      // DB receives canonical 2-line receipt + masked arguments '{}'
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          content: CANONICAL_RECEIPT,
          plugin: expect.objectContaining({ arguments: '{}', identifier: TEXT_FILE_TOOL }),
        }),
      );
      // SSE tool_end receives canonical 2-line receipt
      const toolEndCall = publishStreamEvent.mock.calls.find((c) => c[1]?.type === 'tool_end');
      expect(toolEndCall?.[1].data.result.content).toBe(CANONICAL_RECEIPT);
      // LLM in-memory state keeps FULL diff tail AND folds patchFile edits in compactWriterContext!
      const toolMsg = newState.messages.find((m: any) => m.role === 'tool');
      expect(toolMsg?.content).toBe(FULL_PATCH_OUTPUT);
      const asstMsg = newState.messages.find((m: any) => m.role === 'assistant');
      expect(JSON.parse(asstMsg.tool_calls[0].function.arguments)).toEqual({
        _appliedEditsCount: 1,
        documentId: '11111111-1111-5111-a111-111111111111',
      });
    }

    // 2. call_tools_batch
    {
      const executeTool = vi.fn(async () => patchResult);
      const { create, ctx, publishStreamEvent } = makeRuntimeCtx(executeTool);
      const executors = createRuntimeExecutors(ctx);
      const { newState } = await executors.call_tools_batch!(
        {
          payload: { parentMessageId: 'asst_1', toolsCalling: [toolCall] },
          type: 'call_tools_batch',
        } as any,
        baseState(),
      );

      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          content: CANONICAL_RECEIPT,
          plugin: expect.objectContaining({ arguments: '{}', identifier: TEXT_FILE_TOOL }),
        }),
      );
      const toolEndCall = publishStreamEvent.mock.calls.find((c) => c[1]?.type === 'tool_end');
      expect(toolEndCall?.[1].data.result.content).toBe(CANONICAL_RECEIPT);
      const toolMsg = newState.messages.find((m: any) => m.role === 'tool');
      expect(toolMsg?.content).toBe(FULL_PATCH_OUTPUT);
    }
  });

  it('co-activates lobe-topic-reference when arckep-text-file is discovered in call_tool', async () => {
    const executeTool = vi.fn(async () => ({
      content: 'Activated arckep-text-file',
      executionTime: 5,
      state: {
        activatedTools: [{ identifier: TEXT_FILE_TOOL, name: 'Текстовый файл' }],
      },
      success: true,
    }));
    const { ctx } = makeRuntimeCtx(executeTool);
    const executors = createRuntimeExecutors(ctx);

    const state = AgentRuntime.createInitialState({
      messages: [{ content: 'Edit file', role: 'user' }] as any,
      metadata: { agentId: 'agent_1', studioTextFileEnabled: true, topicId: 'topic_1' },
      operationId: 'op_patch_exec',
    });
    state.operationToolSet = {
      enabledToolIds: ['lobe-activator'],
      manifestMap: {
        [TEXT_FILE_TOOL]: manifest(TEXT_FILE_TOOL, 'patchFile'),
        [TopicReferenceIdentifier]: manifest(TopicReferenceIdentifier, 'getTopicContext'),
      },
      sourceMap: {},
      tools: [],
    };

    const { newState } = await executors.call_tool!(
      {
        payload: {
          parentMessageId: 'asst_1',
          toolCalling: {
            apiName: 'activateTools',
            arguments: JSON.stringify({ identifiers: [TEXT_FILE_TOOL] }),
            id: 'tc_act_1',
            identifier: 'lobe-activator',
            type: 'builtin',
          },
        },
        type: 'call_tool',
      } as any,
      state,
    );

    expect((newState.activatedStepTools ?? []).map((t) => t.id)).toEqual([
      TEXT_FILE_TOOL,
      TopicReferenceIdentifier,
    ]);
  });

  it('preserves deterministic toolsToExecute order in call_tools_batch even when earlier tools finish later', async () => {
    const slowPageContent =
      JSON.stringify({ endLine: 250, nextStartLine: 251, startLine: 1, totalLines: 500 }) +
      '\n' +
      'A'.repeat(5000);
    const fastPageContent =
      JSON.stringify({ endLine: 500, nextStartLine: null, startLine: 251, totalLines: 500 }) +
      '\n' +
      'B'.repeat(5000);

    const callSlow = {
      apiName: 'getTopicContext',
      arguments: JSON.stringify({ fileId: 'f1', mode: 'code_artifacts', startLine: 1 }),
      id: 'tc_page_1',
      identifier: TopicReferenceIdentifier,
      type: 'builtin' as const,
    };
    const callFast = {
      apiName: 'getTopicContext',
      arguments: JSON.stringify({ fileId: 'f1', mode: 'code_artifacts', startLine: 251 }),
      id: 'tc_page_2',
      identifier: TopicReferenceIdentifier,
      type: 'builtin' as const,
    };

    const executeTool = vi.fn(async (payload: any) => {
      if (payload.id === 'tc_page_1') {
        await new Promise((resolve) => setTimeout(resolve, 35));
        return { content: slowPageContent, executionTime: 35, state: undefined, success: true };
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
      return { content: fastPageContent, executionTime: 1, state: undefined, success: true };
    });

    let msgSeq = 0;
    const { ctx } = makeRuntimeCtx(executeTool);
    ctx.messageModel.create = vi.fn(async (input: any) => ({
      id: `msg_${input.tool_call_id}_${++msgSeq}`,
    })) as any;

    const state = AgentRuntime.createInitialState({
      messages: [
        { content: 'Read and continue', id: 'user_req_order', role: 'user' },
        {
          content: '',
          role: 'assistant',
          tool_calls: [
            {
              function: {
                arguments: callSlow.arguments,
                name: 'lobe-topic-reference____getTopicContext____builtin',
              },
              id: callSlow.id,
              type: 'function',
            },
            {
              function: {
                arguments: callFast.arguments,
                name: 'lobe-topic-reference____getTopicContext____builtin',
              },
              id: callFast.id,
              type: 'function',
            },
          ],
        },
      ] as any,
      metadata: {
        agentId: 'agent_1',
        studioTextFileCheckpoint: {
          documentId: '11111111-1111-5111-a111-111111111111',
          part: 1,
          status: 'ready',
        },
        studioTextFileEnabled: true,
        studioTextFileRequestId: 'user_req_order',
        topicId: 'topic_1',
      },
      operationId: 'op_patch_order',
    });
    state.operationToolSet = {
      enabledToolIds: [TopicReferenceIdentifier],
      manifestMap: {
        [TopicReferenceIdentifier]: manifest(TopicReferenceIdentifier, 'getTopicContext'),
      },
      sourceMap: {},
      tools: [],
    };

    const executors = createRuntimeExecutors(ctx);
    const { newState, nextContext } = await executors.call_tools_batch!(
      {
        payload: { parentMessageId: 'asst_1', toolsCalling: [callSlow, callFast] },
        type: 'call_tools_batch',
      } as any,
      state,
    );

    const batchToolResults = (nextContext?.payload as any)?.toolResults ?? [];
    expect(batchToolResults.map((r: any) => r.toolCallId)).toEqual(['tc_page_1', 'tc_page_2']);
    // lastToolMessageId follows toolsToExecute order (tc_page_2), not settlement order
    expect((nextContext?.payload as any)?.parentMessageId).toMatch(/^msg_tc_page_2_/);
    // In compactWriterContext, tc_page_2 is the last page so tc_page_1 is compacted and tc_page_2 is retained in full
    const toolMessages = newState.messages.filter((m: any) => m.role === 'tool');
    expect(toolMessages.map((m: any) => m.tool_call_id)).toEqual(['tc_page_1', 'tc_page_2']);
    expect(toolMessages[0].content).toContain('Original source page retained.');
    expect(toolMessages[1].content).toBe(fastPageContent);
  });

  it('restores in-memory patchFile edits[] arguments after DB reload in call_tools_batch when patchFile fails before any checkpoint', async () => {
    const patchArgs = JSON.stringify({
      edits: [
        { newText: '    x = 10', oldText: '    x = 1' },
        { newText: '    y = 20', oldText: '    MISSING_LINE' },
      ],
      sourceFileId: 'f_src_1',
    });
    const readCall = {
      apiName: 'getTopicContext',
      arguments: JSON.stringify({ fileId: 'f_src_1', mode: 'code_artifacts', startLine: 1 }),
      id: 'tc_read_1',
      identifier: TopicReferenceIdentifier,
      type: 'builtin' as const,
    };
    const failedPatchCall = {
      apiName: 'patchFile',
      arguments: patchArgs,
      id: 'tc_patch_fail_1',
      identifier: TEXT_FILE_TOOL,
      type: 'builtin' as const,
    };

    const patchErrorContent =
      'ARCKEP_TEXT_FILE_ERROR_V1\n' +
      JSON.stringify({
        diagnostics: [
          { index: 0, level: 'exact', message: 'Matched L2..2 (exact).', ok: true },
          { code: 'not_found', index: 1, message: 'oldText was not found in the file.', ok: false },
        ],
        message: 'Atomic patch rejected (1/2 failed, 0 changes saved)',
        reason: 'patch_failed',
      });

    const executeTool = vi.fn(async (payload: any) => {
      if (payload.id === 'tc_read_1') {
        return { content: 'page body', executionTime: 4, state: undefined, success: true };
      }
      return {
        content: patchErrorContent,
        error: { code: 'INVALID_ARGUMENT', message: 'patch_failed' },
        executionTime: 6,
        state: undefined,
        success: false,
      };
    });

    const { create, ctx } = makeRuntimeCtx(executeTool);
    // Simulate Postgres rows where call_llm & call_tools_batch persisted '{}' for arckep-text-file
    ctx.messageModel.query = vi.fn(async () => [
      {
        content: 'Fix file',
        createdAt: 1000,
        id: 'user_req_fail',
        role: 'user',
        updatedAt: 1000,
      },
      {
        content: '',
        createdAt: 1001,
        id: 'asst_fail_1',
        parentId: 'user_req_fail',
        role: 'assistant',
        tools: [{ ...readCall }, { ...failedPatchCall, arguments: '{}' }],
        updatedAt: 1001,
      },
      {
        content: 'page body',
        createdAt: 1002,
        id: 'tool_msg_read',
        parentId: 'asst_fail_1',
        plugin: { ...readCall },
        role: 'tool',
        tool_call_id: readCall.id,
        updatedAt: 1002,
      },
      {
        content: patchErrorContent,
        createdAt: 1003,
        id: 'tool_msg_patch',
        parentId: 'asst_fail_1',
        plugin: { ...failedPatchCall, arguments: '{}' },
        role: 'tool',
        tool_call_id: failedPatchCall.id,
        updatedAt: 1003,
      },
    ]) as any;

    const state = AgentRuntime.createInitialState({
      messages: [
        { content: 'Fix file', id: 'user_req_fail', role: 'user' },
        {
          content: '',
          role: 'assistant',
          tool_calls: [
            {
              function: {
                arguments: readCall.arguments,
                name: 'lobe-topic-reference____getTopicContext____builtin',
              },
              id: readCall.id,
              type: 'function',
            },
            {
              function: {
                arguments: patchArgs,
                name: 'arckep-text-file____patchFile____builtin',
              },
              id: failedPatchCall.id,
              type: 'function',
            },
          ],
        },
      ] as any,
      metadata: {
        agentId: 'agent_1',
        studioTextFileEnabled: true,
        studioTextFileRequestId: 'user_req_fail',
        topicId: 'topic_1',
      },
      operationId: 'op_patch_fail',
    });
    state.operationToolSet = {
      enabledToolIds: [TEXT_FILE_TOOL, TopicReferenceIdentifier],
      manifestMap: {
        [TEXT_FILE_TOOL]: manifest(TEXT_FILE_TOOL, 'patchFile'),
        [TopicReferenceIdentifier]: manifest(TopicReferenceIdentifier, 'getTopicContext'),
      },
      sourceMap: {},
      tools: [],
    };

    const executors = createRuntimeExecutors(ctx);
    const { newState } = await executors.call_tools_batch!(
      {
        payload: { parentMessageId: 'asst_fail_1', toolsCalling: [readCall, failedPatchCall] },
        type: 'call_tools_batch',
      } as any,
      state,
    );

    // Postgres still received masked '{}' arguments
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        plugin: expect.objectContaining({ arguments: '{}', id: failedPatchCall.id }),
        tool_call_id: failedPatchCall.id,
      }),
    );

    // But in-memory newState.messages restored the original edits[] for the next LLM retry step!
    const allToolsInState: any[] = [];
    for (const msg of newState.messages as any[]) {
      if (Array.isArray(msg.tools)) allToolsInState.push(...msg.tools);
      if (Array.isArray(msg.children)) {
        for (const child of msg.children) {
          if (Array.isArray(child?.tools)) allToolsInState.push(...child.tools);
        }
      }
    }
    const restoredPatchTool = allToolsInState.find((t) => t.id === failedPatchCall.id);
    expect(restoredPatchTool).toBeDefined();
    expect(restoredPatchTool.arguments).toBe(patchArgs);
    expect(JSON.parse(restoredPatchTool.arguments).edits).toHaveLength(2);
  });
});
