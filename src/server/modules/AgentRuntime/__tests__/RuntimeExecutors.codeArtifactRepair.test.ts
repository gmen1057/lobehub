// @vitest-environment node
import { AgentRuntime, GeneralChatAgent } from '@lobechat/agent-runtime';
import { ArckepLayoutIdentifier, ArckepLayoutManifest } from '@lobechat/builtin-tool-arckep-layout';
import { describe, expect, it, vi } from 'vitest';

import { initModelRuntimeFromDB } from '@/server/modules/ModelRuntime';

import {
  createRuntimeExecutors,
  prepareMessageForSummarizer,
  type RuntimeExecutorContext,
} from '../RuntimeExecutors';

const { uploadFromBuffer, createSpreadsheetFile, upsertRollingCompressionGroup } = vi.hoisted(
  () => ({
    createSpreadsheetFile: vi.fn(),
    uploadFromBuffer: vi.fn(),
    upsertRollingCompressionGroup: vi.fn(),
  }),
);

vi.mock('@/server/modules/ModelRuntime', () => ({ initModelRuntimeFromDB: vi.fn() }));
vi.mock('@/server/modules/Mecha/ContextEngineering', () => ({ serverMessagesEngine: vi.fn() }));
vi.mock('@/server/services/message', () => ({
  MessageService: class {
    createSpreadsheetFile = createSpreadsheetFile;
    upsertRollingCompressionGroup = upsertRollingCompressionGroup;
  },
}));
vi.mock('@/server/services/file', () => ({
  FileService: class {
    uploadFromBuffer = uploadFromBuffer;
  },
}));
vi.mock('@/envs/file', () => ({ fileEnv: { NEXT_PUBLIC_S3_FILE_PATH: 'files' } }));
vi.mock('@/server/services/agentDocuments', () => ({ AgentDocumentsService: vi.fn() }));
vi.mock('../arckepSearch', () => ({ resolveServerEnabledSearch: vi.fn(async () => false) }));
vi.mock('../serverModelParams', () => ({ resolveServerModelParams: vi.fn(async () => ({})) }));
vi.mock('../llmTrace', () => ({
  createEngineTraceCallbacks: vi.fn(),
  withEngineTrace: (_trace: unknown, callbacks: unknown) => callbacks,
}));

const OLD_VALID_FILE_ID = '849f7fc2-dd0e-4b18-9aa8-aab327c49b30';
const NEW_SAVED_FILE_ID = 'f994edcd-bfb3-4d15-9ceb-924f63675569';
const LONG_VBA_SOURCE = Array.from(
  { length: 28 },
  (_, index) => `  Debug.Print "Part2 line ${index}"`,
).join('\n');
const LONG_VBA_FENCED = `Вот вторая часть модуля:\n\n\`\`\`vba Module2.bas\nSub RunPart2()\n${LONG_VBA_SOURCE}\nEnd Sub\n\`\`\``;
const SPOOFED_EMPTY_TAG = `<lobeArtifact type="application/lobe.artifacts.code" identifier="code-vb-old" title="Module2.bas" language="vb" src="/chat/code-artifact/${OLD_VALID_FILE_ID}/"></lobeArtifact>`;

const makeCtx = (
  state: ReturnType<typeof AgentRuntime.createInitialState>,
  overrides: Partial<RuntimeExecutorContext> = {},
) => {
  const create = vi.fn(async () => ({ id: 'asst_msg_1' }));
  const update = vi.fn();
  const publishStreamChunk = vi.fn();
  const publishStreamEvent = vi.fn();

  const ctx = {
    loadAgentState: vi.fn(async () => state),
    messageModel: {
      create,
      query: vi.fn(async () => []),
      update,
    },
    operationId: 'op_code_repair',
    serverDB: {},
    stepIndex: 0,
    streamManager: { publishStreamChunk, publishStreamEvent },
    toolExecutionService: { executeTool: vi.fn() },
    userId: 'owner_1',
    ...overrides,
  } as unknown as RuntimeExecutorContext;

  return { create, ctx, publishStreamChunk, publishStreamEvent, update };
};

describe('RuntimeExecutors code-artifact mimic self-healing repair', () => {
  it('intercepts model-emitted bodyless /chat/code-artifact/ tag, schedules seamless repair without activating arckep-layout, and saves real fenced code on retry', async () => {
    uploadFromBuffer.mockReset().mockResolvedValue({ fileId: NEW_SAVED_FILE_ID });
    createSpreadsheetFile.mockReset();

    const chat = vi
      .fn()
      .mockImplementationOnce(async (_payload, options) => {
        await options.callback.onText(`Вот часть 2:\n${SPOOFED_EMPTY_TAG}\nГотово.`);
        return new Response('data: [DONE]\n\n', {
          headers: { 'Content-Type': 'text/event-stream' },
        });
      })
      .mockImplementationOnce(async (_payload, options) => {
        await options.callback.onText(LONG_VBA_FENCED);
        return new Response('data: [DONE]\n\n', {
          headers: { 'Content-Type': 'text/event-stream' },
        });
      });

    vi.mocked(initModelRuntimeFromDB).mockResolvedValue({ chat } as any);

    const state = AgentRuntime.createInitialState({
      messages: [{ content: 'Выдай часть 2 модуля Module2.bas', role: 'user' }],
      metadata: { agentId: 'agt_1', studioWebChat: true, topicId: 'tpc_1' },
      operationId: 'op_code_repair',
      status: 'running',
      toolManifestMap: { [ArckepLayoutIdentifier]: ArckepLayoutManifest },
    });

    const { create, ctx, publishStreamChunk, publishStreamEvent, update } = makeCtx(state);
    const agent = new GeneralChatAgent({
      compressionConfig: { enabled: false },
      modelRuntimeConfig: { model: 'deepseek-flash', provider: 'deepseek' },
      operationId: 'op_code_repair',
    });

    // Step 1: model mimics empty server tag referencing an old valid UUID
    const step1 = await createRuntimeExecutors(ctx).call_llm!(
      {
        payload: {
          messages: state.messages,
          model: 'deepseek-flash',
          provider: 'deepseek',
          tools: [],
        },
        type: 'call_llm',
      } as any,
      state,
    );

    expect(uploadFromBuffer).not.toHaveBeenCalled();
    expect(createSpreadsheetFile).not.toHaveBeenCalled();
    expect((step1.nextContext?.payload as any)?.codeArtifactRepairError).toContain(
      `/chat/code-artifact/${OLD_VALID_FILE_ID}/`,
    );
    expect(step1.newState.metadata?.codeArtifactRepairAttempts).toBe(1);
    // Must NOT activate HTML layout tool for a code-artifact repair
    expect(step1.newState.activatedStepTools ?? []).toEqual([]);

    // Step 1 must not flush premature fallback text or leak the raw tag over SSE
    const step1Chunks = publishStreamChunk.mock.calls.map(([, , chunk]) => chunk.content ?? '');
    expect(step1Chunks.join('')).not.toContain('/chat/code-artifact/');
    expect(step1Chunks.join('')).not.toContain('Файл не сохранён.');

    // H3: stream_retry with resetText=true must be published so ResponsesService resets accumulatedText
    expect(publishStreamEvent).toHaveBeenCalledWith(
      'op_code_repair',
      expect.objectContaining({
        data: expect.objectContaining({ reason: 'code_artifact_repair', resetText: true }),
        stepIndex: 0,
        type: 'stream_retry',
      }),
    );

    // Sanitized repair attempt + repair user prompt pushed into state (with id matching assistant row)
    const attemptMsg = step1.newState.messages.at(-2);
    const repairUserMsg = step1.newState.messages.at(-1);
    expect(attemptMsg).toMatchObject({
      content: 'Вот часть 2:\n[omitted invalid empty file reference tag]\nГотово.',
      id: 'asst_msg_1',
      metadata: { internalRepairAttempt: true },
      role: 'assistant',
    });
    expect(attemptMsg?.content).not.toContain('/chat/code-artifact/');
    expect(repairUserMsg?.role).toBe('user');
    expect(repairUserMsg?.content).toContain('Markdown-блоком кода');
    expect(repairUserMsg?.content).toContain('arckep-text-file/writePart');
    expect(repairUserMsg?.content).toContain('arckep-text-file/patchFile');

    // Agent schedules Step 2 reusing the same assistantMessageId
    const nextInstruction = await agent.runner(step1.nextContext!, step1.newState);
    expect(nextInstruction).toMatchObject({
      payload: {
        assistantMessageId: 'asst_msg_1',
        parentMessageId: 'asst_msg_1',
      },
      type: 'call_llm',
    });

    // Step 2: model responds with real fenced VBA code; saveLongCodeArtifacts persists it cleanly
    const step2 = await createRuntimeExecutors({ ...ctx, stepIndex: 1 }).call_llm!(
      nextInstruction as any,
      step1.newState,
    );

    expect(create).toHaveBeenCalledOnce();
    expect(uploadFromBuffer).toHaveBeenCalledOnce();
    expect((step2.nextContext?.payload as any)?.codeArtifactRepairError).toBeUndefined();

    const finalSaved = update.mock.calls.at(-1)?.[1];
    expect(finalSaved.content).toContain(`src="/chat/code-artifact/${NEW_SAVED_FILE_ID}/"`);
    expect(finalSaved.content).not.toContain(OLD_VALID_FILE_ID);
    expect(finalSaved.metadata).toMatchObject({
      codeArtifactFallback: LONG_VBA_FENCED,
    });
    expect(publishStreamEvent).toHaveBeenLastCalledWith(
      'op_code_repair',
      expect.objectContaining({
        data: expect.objectContaining({ finalContent: finalSaved.content }),
        stepIndex: 1,
        type: 'stream_end',
      }),
    );

    const terminal = await agent.runner(step2.nextContext!, step2.newState);
    expect(terminal).toMatchObject({ reason: 'completed', type: 'finish' });
  });

  it.each([
    { forceFinish: false, label: 'repair attempts exhausted', prevAttempts: 2 },
    { forceFinish: true, label: 'forceFinish=true', prevAttempts: 0 },
  ])(
    'emits and persists clean fallback without leaking raw tag when $label',
    async ({ forceFinish, prevAttempts }) => {
      uploadFromBuffer.mockReset();

      const chat = vi.fn(async (_payload, options) => {
        await options.callback.onText(`До тега ${SPOOFED_EMPTY_TAG} после тега.`);
        return new Response('data: [DONE]\n\n', {
          headers: { 'Content-Type': 'text/event-stream' },
        });
      });
      vi.mocked(initModelRuntimeFromDB).mockResolvedValue({ chat } as any);

      const state = AgentRuntime.createInitialState({
        forceFinish,
        messages: [{ content: 'Выдай код', role: 'user' }],
        metadata: {
          agentId: 'agt_1',
          codeArtifactRepairAttempts: prevAttempts,
          studioWebChat: true,
          topicId: 'tpc_1',
        },
        operationId: 'op_code_repair',
        status: 'running',
      });

      const { ctx, publishStreamChunk, update } = makeCtx(state);
      const res = await createRuntimeExecutors(ctx).call_llm!(
        {
          payload: {
            messages: state.messages,
            model: 'deepseek-flash',
            provider: 'deepseek',
            tools: [],
          },
          type: 'call_llm',
        } as any,
        state,
      );

      expect((res.nextContext?.payload as any)?.codeArtifactRepairError).toBeUndefined();
      const expected = 'До тега Файл не сохранён. после тега.';
      expect(update.mock.calls.at(-1)?.[1]?.content).toBe(expected);
      expect(res.newState.messages.at(-1)?.content).toBe(expected);
      const streamed = publishStreamChunk.mock.calls
        .map(([, , chunk]) => chunk.content ?? '')
        .join('');
      expect(streamed).toBe(expected);
      expect(streamed).not.toContain('/chat/code-artifact/');
    },
  );
});

describe('prepareMessageForSummarizer code-artifact tag sanitization', () => {
  it('rewrites /chat/code-artifact/ tags in assistant and assistantGroup.children without mutating originals', () => {
    const assistantMsg = {
      content: `Готово:\n${SPOOFED_EMPTY_TAG}`,
      id: 'm1',
      role: 'assistant',
    } as any;

    const preparedAssistant = prepareMessageForSummarizer(assistantMsg);
    expect(preparedAssistant.content).toContain(`fileId=${OLD_VALID_FILE_ID}`);
    expect(preparedAssistant.content).not.toContain('/chat/code-artifact/');
    expect(preparedAssistant.content).not.toContain('<lobeArtifact');
    expect(assistantMsg.content).toContain(SPOOFED_EMPTY_TAG);

    const groupMsg = {
      children: [
        { content: `Child 1:\n${SPOOFED_EMPTY_TAG}`, id: 'c1', role: 'assistant' },
        { content: 'Child 2 plain text', id: 'c2', role: 'assistant' },
      ],
      content: '',
      id: 'g1',
      role: 'assistantGroup',
    } as any;

    const preparedGroup = prepareMessageForSummarizer(groupMsg) as any;
    expect(preparedGroup.children[0].content).toContain(`fileId=${OLD_VALID_FILE_ID}`);
    expect(preparedGroup.children[0].content).not.toContain('/chat/code-artifact/');
    expect(preparedGroup.children[1]).toBe(groupMsg.children[1]);
    expect(groupMsg.children[0].content).toContain(SPOOFED_EMPTY_TAG);

    // H1: serialized multimodal JSON DB row in assistant and assistantGroup.children
    const multimodalJson = JSON.stringify([
      { text: `Image + code:\n${SPOOFED_EMPTY_TAG}`, type: 'text' },
      { image: 'https://example.com/a.png', type: 'image' },
    ]);
    const preparedMulti = prepareMessageForSummarizer({
      content: multimodalJson,
      id: 'm2',
      role: 'assistant',
    } as any);
    expect(preparedMulti.content).toContain(`fileId=${OLD_VALID_FILE_ID}`);
    expect(preparedMulti.content).not.toContain('/chat/code-artifact/');
    expect(JSON.parse(preparedMulti.content)).toHaveLength(2);
  });
});

describe('H4 mid-turn compress_context reconciliation & M2 simultaneous HTML + code-artifact repair', () => {
  it('replaces the Step 1 DB stub in-place during mid-turn compress_context with zero consecutive assistant messages', async () => {
    uploadFromBuffer.mockReset();
    upsertRollingCompressionGroup.mockReset();

    const chat = vi.fn(async (_payload, options) => {
      await options.callback.onText(`Вот часть 2:\n${SPOOFED_EMPTY_TAG}\nГотово.`);
      return new Response('data: [DONE]\n\n', {
        headers: { 'Content-Type': 'text/event-stream' },
      });
    });
    const summarizeChat = vi.fn(async (_payload, options) => {
      await options.callback.onText('Сводка первого хода');
      return new Response('data: [DONE]\n\n', {
        headers: { 'Content-Type': 'text/event-stream' },
      });
    });
    vi.mocked(initModelRuntimeFromDB)
      .mockResolvedValueOnce({ chat } as any)
      .mockResolvedValueOnce({ chat: summarizeChat } as any);

    const turn1User = { content: 'Напиши часть 1', id: 'msg_u1', role: 'user' as const };
    const turn1Asst = { content: 'Часть 1 готова', id: 'msg_a1', role: 'assistant' as const };
    const turn2User = { content: 'Теперь часть 2', id: 'msg_u2', role: 'user' as const };

    const state = AgentRuntime.createInitialState({
      messages: [turn1User, turn1Asst, turn2User],
      metadata: { agentId: 'agt_1', studioWebChat: true, topicId: 'tpc_1' },
      modelRuntimeConfig: {
        compressionModel: { model: 'deepseek-flash', provider: 'deepseek' },
        model: 'deepseek-flash',
        provider: 'deepseek',
      },
      operationId: 'op_code_repair',
      status: 'running',
    });

    const { ctx } = makeCtx(state);
    const step1 = await createRuntimeExecutors(ctx).call_llm!(
      {
        payload: {
          messages: state.messages,
          model: 'deepseek-flash',
          provider: 'deepseek',
          tools: [],
        },
        type: 'call_llm',
      } as any,
      state,
    );

    // DB now contains Turn 1 + Turn 2 user + Step 1's partial non-empty stub (without internalRepairAttempt)
    const dbStep1Stub = { content: 'Вот часть 2:\n', id: 'asst_msg_1', role: 'assistant' };
    vi.mocked(ctx.messageModel.query).mockResolvedValue([
      turn1User,
      turn1Asst,
      turn2User,
      dbStep1Stub,
    ] as any);

    const compressedGroupNode = {
      content: 'Сводка первого хода',
      id: 'grp_1',
      role: 'compressedGroup',
      topicId: 'tpc_1',
    };
    upsertRollingCompressionGroup.mockResolvedValue({
      messageGroupId: 'grp_1',
      messages: [compressedGroupNode, turn2User, dbStep1Stub],
    });

    const compressed = await createRuntimeExecutors({ ...ctx, stepIndex: 1 }).compress_context!(
      {
        payload: {
          assistantMessageId: 'asst_msg_1',
          currentTokenCount: 900_000,
          messages: step1.newState.messages,
          parentMessageId: 'asst_msg_1',
        },
        type: 'compress_context',
      } as any,
      step1.newState,
    );

    const roles = compressed.newState.messages.map((m: any) => m.role);
    expect(roles).toEqual(['compressedGroup', 'user', 'assistant', 'user']);
    expect(compressed.newState.messages[2]).toMatchObject({
      content: 'Вот часть 2:\n[omitted invalid empty file reference tag]\nГотово.',
      id: 'asst_msg_1',
      metadata: { internalRepairAttempt: true },
      role: 'assistant',
    });
    expect(compressed.newState.messages[3].content).toContain('Markdown-блоком кода');
    // No consecutive assistant messages and no stale DB stub left behind
    for (let i = 1; i < roles.length; i++) {
      expect(!(roles[i] === 'assistant' && roles[i - 1] === 'assistant')).toBe(true);
    }
  });

  it('M2: prioritizes HTML repair without burning codeArtifactRepairAttempts, sanitizes pushed attempt, and suppresses premature HTML failure notice when code repair is scheduled', async () => {
    const brokenHtmlTag =
      '<lobeArtifact identifier="bad" type="text/html" title="Bad"><html><body><script>function broken( {</script></body></html></lobeArtifact>';

    // Case A: HTML repair takes priority (prev htmlSyntaxRepairAttempts = 0)
    const chatA = vi.fn(async (_payload, options) => {
      await options.callback.onText(`Ответ:\n${brokenHtmlTag}\n${SPOOFED_EMPTY_TAG}`);
      return new Response('data: [DONE]\n\n', {
        headers: { 'Content-Type': 'text/event-stream' },
      });
    });
    vi.mocked(initModelRuntimeFromDB).mockResolvedValueOnce({ chat: chatA } as any);

    const stateA = AgentRuntime.createInitialState({
      messages: [{ content: 'Сделай HTML и код', role: 'user' }],
      metadata: { agentId: 'agt_1', studioWebChat: true, topicId: 'tpc_1' },
      operationId: 'op_m2_a',
      status: 'running',
      toolManifestMap: { [ArckepLayoutIdentifier]: ArckepLayoutManifest },
    });
    const { ctx: ctxA, publishStreamEvent: eventsA } = makeCtx(stateA, { operationId: 'op_m2_a' });
    const resA = await createRuntimeExecutors(ctxA).call_llm!(
      {
        payload: {
          messages: stateA.messages,
          model: 'deepseek-flash',
          provider: 'deepseek',
          tools: [],
        },
        type: 'call_llm',
      } as any,
      stateA,
    );

    expect((resA.nextContext?.payload as any)?.htmlArtifactSyntaxError).toBeTruthy();
    expect((resA.nextContext?.payload as any)?.codeArtifactRepairError).toBeUndefined();
    expect(resA.newState.metadata?.htmlSyntaxRepairAttempts).toBe(1);
    expect(resA.newState.metadata?.codeArtifactRepairAttempts).toBeUndefined();
    expect(resA.newState.messages.at(-2)).toMatchObject({
      id: 'asst_msg_1',
      metadata: { internalRepairAttempt: true },
      role: 'assistant',
    });
    expect(resA.newState.messages.at(-2)?.content).not.toContain('/chat/code-artifact/');
    expect(eventsA).toHaveBeenCalledWith(
      'op_m2_a',
      expect.objectContaining({
        data: expect.objectContaining({ reason: 'html_artifact_repair', resetText: true }),
        type: 'stream_retry',
      }),
    );

    // Case B: HTML repair budget exhausted (2), code-artifact repair IS scheduled -> no premature HTML notice
    const chatB = vi.fn(async (_payload, options) => {
      await options.callback.onText(`Ответ:\n${brokenHtmlTag}\n${SPOOFED_EMPTY_TAG}`);
      return new Response('data: [DONE]\n\n', {
        headers: { 'Content-Type': 'text/event-stream' },
      });
    });
    vi.mocked(initModelRuntimeFromDB).mockResolvedValueOnce({ chat: chatB } as any);

    const stateB = AgentRuntime.createInitialState({
      messages: [{ content: 'Сделай HTML и код', role: 'user' }],
      metadata: {
        agentId: 'agt_1',
        htmlSyntaxRepairAttempts: 2,
        studioWebChat: true,
        topicId: 'tpc_1',
      },
      operationId: 'op_m2_b',
      status: 'running',
    });
    const { ctx: ctxB, update: updateB } = makeCtx(stateB, { operationId: 'op_m2_b' });
    const resB = await createRuntimeExecutors(ctxB).call_llm!(
      {
        payload: {
          messages: stateB.messages,
          model: 'deepseek-flash',
          provider: 'deepseek',
          tools: [],
        },
        type: 'call_llm',
      } as any,
      stateB,
    );

    expect((resB.nextContext?.payload as any)?.htmlArtifactSyntaxError).toBeUndefined();
    expect((resB.nextContext?.payload as any)?.codeArtifactRepairError).toBeTruthy();
    expect(updateB.mock.calls.at(-1)?.[1]?.content).not.toContain(
      'Не удалось показать готовую HTML-страницу',
    );
  });
});

describe('RuntimeExecutors hallucinated [Saved ... — previous code block stored by server.] repair', () => {
  const HALLUCINATED_SAVED_NOTE = `[Saved "Module2.bas" (vb), fileId=${OLD_VALID_FILE_ID} — previous code block stored by server. Use getTopicContext(mode="code_artifacts", fileId="${OLD_VALID_FILE_ID}") if you need to inspect it.]`;

  it('intercepts streamed [Saved ...] placeholder before SSE, triggers codeArtifactRepairError with updated prompt, keeps attempt #2 guarded, and saves real code on retry', async () => {
    uploadFromBuffer.mockReset().mockResolvedValue({ fileId: NEW_SAVED_FILE_ID });
    createSpreadsheetFile.mockReset();

    const chat = vi
      .fn()
      // Attempt 1: emits bare hallucinated [Saved ...] split across chunks
      .mockImplementationOnce(async (_payload, options) => {
        await options.callback.onText('Вот модуль:\n[Sav');
        await options.callback.onText(`ed "Module2.bas" (vb), fileId=${OLD_VALID_FILE_ID}`);
        await options.callback.onText(
          ` — previous code block stored by server. Use getTopicContext(mode="code_artifacts", fileId="${OLD_VALID_FILE_ID}") if you need to inspect it.]\nГотово.`,
        );
        return new Response('data: [DONE]\n\n', {
          headers: { 'Content-Type': 'text/event-stream' },
        });
      })
      // Attempt 2: tries backtick-wrapped hallucination — must STILL be blocked even though
      // Attempt 1's synthetic repair user prompt contains "previous code block stored by server"!
      .mockImplementationOnce(async (_payload, options) => {
        await options.callback.onText(`Вот:\n\`${HALLUCINATED_SAVED_NOTE}\``);
        return new Response('data: [DONE]\n\n', {
          headers: { 'Content-Type': 'text/event-stream' },
        });
      })
      // Attempt 3 (after 2nd repair): emits real fenced VBA code
      .mockImplementationOnce(async (_payload, options) => {
        await options.callback.onText(LONG_VBA_FENCED);
        return new Response('data: [DONE]\n\n', {
          headers: { 'Content-Type': 'text/event-stream' },
        });
      });

    vi.mocked(initModelRuntimeFromDB).mockResolvedValue({ chat } as any);

    const state = AgentRuntime.createInitialState({
      messages: [{ content: 'Выдай полный модуль Module2.bas', role: 'user' }],
      metadata: { agentId: 'agt_1', studioWebChat: true, topicId: 'tpc_1' },
      operationId: 'op_saved_note_repair',
      status: 'running',
    });

    const { ctx, publishStreamChunk, publishStreamEvent, update } = makeCtx(state, {
      operationId: 'op_saved_note_repair',
    });
    const agent = new GeneralChatAgent({
      compressionConfig: { enabled: false },
      modelRuntimeConfig: { model: 'deepseek-flash', provider: 'deepseek' },
      operationId: 'op_saved_note_repair',
    });

    // Step 1: bare hallucinated [Saved ...]
    const step1 = await createRuntimeExecutors(ctx).call_llm!(
      {
        payload: {
          messages: state.messages,
          model: 'deepseek-flash',
          provider: 'deepseek',
          tools: [],
        },
        type: 'call_llm',
      } as any,
      state,
    );

    expect((step1.nextContext?.payload as any)?.codeArtifactRepairError).toContain(
      'hallucinated saved code-artifact placeholder',
    );
    expect(step1.newState.metadata?.codeArtifactRepairAttempts).toBe(1);
    const step1Streamed = publishStreamChunk.mock.calls.map(([, , chunk]) => chunk.content ?? '');
    expect(step1Streamed.join('')).toBe('Вот модуль:\n');
    expect(step1Streamed.join('')).not.toContain('previous code block stored by server');
    expect(step1Streamed.join('')).not.toContain('Файл не сохранён.');

    const repairPrompt = step1.newState.messages.at(-1)?.content;
    expect(repairPrompt).toContain('<lobeArtifact>');
    expect(repairPrompt).toContain('[Saved ... — previous code block stored by server.]');
    expect(repairPrompt).toContain(
      'В твоём предыдущем ответе вместо реального кода оказался пустой служебный тег',
    );

    expect(publishStreamEvent).toHaveBeenCalledWith(
      'op_saved_note_repair',
      expect.objectContaining({
        data: expect.objectContaining({ reason: 'code_artifact_repair', resetText: true }),
        stepIndex: 0,
        type: 'stream_retry',
      }),
    );

    // Step 2: model wraps hallucinated note in backticks — still caught because REAL user didn't quote it
    const next2 = await agent.runner(step1.nextContext!, step1.newState);
    const step2 = await createRuntimeExecutors({ ...ctx, stepIndex: 1 }).call_llm!(
      next2 as any,
      step1.newState,
    );
    expect((step2.nextContext?.payload as any)?.codeArtifactRepairError).toContain(
      'hallucinated saved code-artifact placeholder',
    );
    expect(step2.newState.metadata?.codeArtifactRepairAttempts).toBe(2);

    // Step 3: model finally emits real fenced code
    const next3 = await agent.runner(step2.nextContext!, step2.newState);
    const step3 = await createRuntimeExecutors({ ...ctx, stepIndex: 2 }).call_llm!(
      next3 as any,
      step2.newState,
    );
    expect((step3.nextContext?.payload as any)?.codeArtifactRepairError).toBeUndefined();
    expect(uploadFromBuffer).toHaveBeenCalledOnce();
    const finalSaved = update.mock.calls.at(-1)?.[1];
    expect(finalSaved.content).toContain(`src="/chat/code-artifact/${NEW_SAVED_FILE_ID}/"`);
  });

  it('allows backtick-quoted [Saved ...] when the active user message literally mentions "previous code block stored by server", but still intercepts bare ones', async () => {
    uploadFromBuffer.mockReset();

    const userQuestion =
      'Почему в истории написано "[Saved "Module2.bas" (vb) — previous code block stored by server.]"?';

    // Case A: quoted in inline backticks -> allowed through
    const quotedAnswer = `Заглушка \`${HALLUCINATED_SAVED_NOTE}\` означает, что сервер сохранил файл.`;
    const chatQuoted = vi.fn(async (_payload, options) => {
      await options.callback.onText(quotedAnswer);
      return new Response('data: [DONE]\n\n', {
        headers: { 'Content-Type': 'text/event-stream' },
      });
    });
    vi.mocked(initModelRuntimeFromDB).mockResolvedValueOnce({ chat: chatQuoted } as any);

    const stateQuoted = AgentRuntime.createInitialState({
      messages: [{ content: userQuestion, id: 'u_quote', role: 'user' }],
      metadata: { agentId: 'agt_1', studioWebChat: true, topicId: 'tpc_1' },
      operationId: 'op_user_quote_ok',
      status: 'running',
    });
    const { ctx: ctxQuoted, update: updateQuoted } = makeCtx(stateQuoted, {
      operationId: 'op_user_quote_ok',
    });
    const resQuoted = await createRuntimeExecutors(ctxQuoted).call_llm!(
      {
        payload: {
          messages: stateQuoted.messages,
          model: 'deepseek-flash',
          provider: 'deepseek',
          tools: [],
        },
        type: 'call_llm',
      } as any,
      stateQuoted,
    );

    expect((resQuoted.nextContext?.payload as any)?.codeArtifactRepairError).toBeUndefined();
    expect(updateQuoted.mock.calls.at(-1)?.[1]?.content).toBe(quotedAnswer);

    // Case B: bare (not in backticks) -> still intercepted even when user asked about it
    const chatBare = vi.fn(async (_payload, options) => {
      await options.callback.onText(`Вот:\n${HALLUCINATED_SAVED_NOTE}`);
      return new Response('data: [DONE]\n\n', {
        headers: { 'Content-Type': 'text/event-stream' },
      });
    });
    vi.mocked(initModelRuntimeFromDB).mockResolvedValueOnce({ chat: chatBare } as any);

    const stateBare = AgentRuntime.createInitialState({
      messages: [{ content: userQuestion, id: 'u_quote', role: 'user' }],
      metadata: { agentId: 'agt_1', studioWebChat: true, topicId: 'tpc_1' },
      operationId: 'op_user_quote_bare',
      status: 'running',
    });
    const { ctx: ctxBare } = makeCtx(stateBare, { operationId: 'op_user_quote_bare' });
    const resBare = await createRuntimeExecutors(ctxBare).call_llm!(
      {
        payload: {
          messages: stateBare.messages,
          model: 'deepseek-flash',
          provider: 'deepseek',
          tools: [],
        },
        type: 'call_llm',
      } as any,
      stateBare,
    );

    expect((resBare.nextContext?.payload as any)?.codeArtifactRepairError).toContain(
      'hallucinated saved code-artifact placeholder',
    );
  });
});
