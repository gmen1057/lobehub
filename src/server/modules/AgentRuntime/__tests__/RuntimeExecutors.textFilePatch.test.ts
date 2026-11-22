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
});
