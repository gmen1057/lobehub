// @vitest-environment node
import { LOADING_FLAT } from '@lobechat/const';
import type { ChatStreamPayload } from '@lobechat/model-runtime';
import type { UIChatMessage } from '@lobechat/types';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as compressionThresholds from '@/server/modules/AgentRuntime/compressionThresholds';
import { estimateDeepSeekUserTurnTokens } from '@/server/modules/AgentRuntime/RuntimeExecutors';
import {
  compactTopic,
  hasInFlightTopicCompaction,
  hasInFlightTopicCompactionsForUser,
  resetInFlightTopicCompactionsForTests,
} from '@/server/services/topic/compactTopic';

import {
  beginResponseExecution,
  resetEngineSlotActivityForTests,
} from '../../services/engineSlotActivity';
import { responsesStreamHub } from '../../services/responsesStreamHub';
import TopicsRoutes from '../topics.route';

const {
  mockAgentsTable,
  mockChat,
  mockConsumeStreamUntilDone,
  mockInitModelRuntimeFromDB,
  mockMessagesTable,
  mockQueryWithWhere,
  mockTopicsTable,
  mockUpsertRollingCompressionGroup,
  state,
} = vi.hoisted(() => ({
  mockAgentsTable: { __table: 'agents', chatConfig: 'chatConfig', id: 'id', userId: 'userId' },
  mockChat: vi.fn(),
  mockConsumeStreamUntilDone: vi.fn(async () => undefined),
  mockInitModelRuntimeFromDB: vi.fn(),
  mockMessagesTable: {
    __table: 'messages',
    id: 'id',
    messageGroupId: 'messageGroupId',
    threadId: 'threadId',
    topicId: 'topicId',
    userId: 'userId',
  },
  mockQueryWithWhere: vi.fn(),
  mockTopicsTable: {
    __table: 'topics',
    agentId: 'agentId',
    groupId: 'groupId',
    id: 'id',
    sessionId: 'sessionId',
    userId: 'userId',
  },
  mockUpsertRollingCompressionGroup: vi.fn(),
  state: {
    agentRow: null as { chatConfig?: Record<string, unknown> | null } | null,
    messageRow: null as { id: string; messageGroupId: string | null } | null,
    topicRow: null as {
      agentId: string | null;
      groupId: string | null;
      id: string;
      sessionId: string | null;
    } | null,
  },
}));

const mockDb = {
  select: () => ({
    from: (table: unknown) => ({
      where: () => ({
        limit: async () => {
          if (table === mockTopicsTable) return state.topicRow ? [state.topicRow] : [];
          if (table === mockAgentsTable) return state.agentRow ? [state.agentRow] : [];
          if (table === mockMessagesTable) return state.messageRow ? [state.messageRow] : [];
          return [];
        },
      }),
    }),
  }),
};

vi.mock('@/const/rbac', () => ({ ALL_SCOPE: 'all', RBAC_PERMISSIONS: {} }));
vi.mock('@/utils/rbac', () => ({
  getAllScopePermissions: () => ['topic:update:all'],
  getScopePermissions: () => ['topic:update:all'],
}));
vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: async () => mockDb,
}));
vi.mock('@/database/models/rbac', () => ({
  RbacModel: class {
    hasAnyPermission = async () => true;
  },
}));
vi.mock('@/database/schemas', () => ({
  agents: mockAgentsTable,
  agentsToSessions: {},
  aiModels: {},
  aiProviders: {},
  files: {},
  knowledgeBases: {},
  messages: mockMessagesTable,
  sessions: {},
  topics: mockTopicsTable,
  users: {},
}));
vi.mock('@/database/models/message', () => ({
  MessageModel: class {
    queryWithWhere = mockQueryWithWhere;
  },
}));
vi.mock('@/server/services/message', () => ({
  MessageService: class {
    upsertRollingCompressionGroup = mockUpsertRollingCompressionGroup;
  },
}));
vi.mock('@/server/modules/ModelRuntime', () => ({
  initModelRuntimeFromDB: mockInitModelRuntimeFromDB,
}));
vi.mock('@lobechat/model-runtime', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    consumeStreamUntilDone: mockConsumeStreamUntilDone,
  };
});
vi.mock('../../controllers', async () => {
  const actual = await import('../../controllers/topic.controller');
  return { TopicController: actual.TopicController };
});
vi.mock('../../middleware', () => ({
  requireAuth: async (c: any, next: any) => {
    c.set('userId', 'user_1');
    await next();
  },
}));
vi.mock('../../middleware/permission-check', () => ({
  requireAnyPermission: () => async (_c: any, next: any) => {
    await next();
  },
}));

const app = new Hono().route('/api/v1/topics', TopicsRoutes);

const makeMsg = (overrides: Partial<UIChatMessage> & { id: string; role: string }): UIChatMessage =>
  ({
    content: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }) as unknown as UIChatMessage;

const postCompact = (topicId: string, body?: unknown, rawBody?: string) =>
  app.request(`/api/v1/topics/${topicId}/compact`, {
    body: rawBody !== undefined ? rawBody : body === undefined ? undefined : JSON.stringify(body),
    headers:
      rawBody !== undefined || body !== undefined
        ? { 'Content-Type': 'application/json' }
        : undefined,
    method: 'POST',
  });

describe('POST /api/v1/topics/:id/compact', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    responsesStreamHub.clear();
    resetEngineSlotActivityForTests();
    resetInFlightTopicCompactionsForTests();

    state.topicRow = {
      agentId: 'agent_1',
      groupId: null,
      id: 'tpc_1',
      sessionId: 'sess_1',
    };
    state.agentRow = { chatConfig: {} };
    state.messageRow = null;

    mockQueryWithWhere.mockResolvedValue([
      makeMsg({ content: 'Привет, разберём архитектуру.', id: 'msg_u1', role: 'user' }),
      makeMsg({
        content: 'Конечно! Давайте рассмотрим три ключевых модуля.',
        id: 'msg_a1',
        parentId: 'msg_u1',
        role: 'assistant',
      }),
    ]);

    mockChat.mockImplementation(async (_payload: ChatStreamPayload, options: any) => {
      await options?.callback?.onText?.('### Context\nСжатое резюме диалога.');
      return new Response('');
    });
    mockInitModelRuntimeFromDB.mockResolvedValue({
      chat: mockChat,
    });
    mockConsumeStreamUntilDone.mockResolvedValue(undefined);
    mockUpsertRollingCompressionGroup.mockResolvedValue({
      messageGroupId: 'grp_1',
      messages: [],
    });
  });

  afterEach(() => {
    responsesStreamHub.clear();
    resetEngineSlotActivityForTests();
    resetInFlightTopicCompactionsForTests();
  });

  it('1. успешно сжимает тему: studioWebChat=true, topicId, без assistantMessageId, enabledContextCaching=false, и принимает пустое тело и {}', async () => {
    const res = await postCompact('tpc_1', {});
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({
      data: {
        compacted: true,
        compressedCount: 2,
        messageGroupId: 'grp_1',
      },
      success: true,
    });

    expect(mockInitModelRuntimeFromDB).toHaveBeenCalledTimes(1);
    const [, calledUserId, calledProvider, conversationCtx] =
      mockInitModelRuntimeFromDB.mock.calls[0];
    expect(calledUserId).toBe('user_1');
    expect(calledProvider).toBe('deepseek');
    expect(conversationCtx).toEqual({
      sessionId: 'sess_1',
      studioWebChat: true,
      topicId: 'tpc_1',
    });
    expect('assistantMessageId' in conversationCtx).toBe(false);

    expect(mockChat).toHaveBeenCalledTimes(1);
    const [chatPayload] = mockChat.mock.calls[0];
    expect(chatPayload.enabledContextCaching).toBe(false);
    expect(chatPayload.stream).toBe(true);
    expect(chatPayload.model).toBe('deepseek-flash');

    expect(mockUpsertRollingCompressionGroup).toHaveBeenCalledTimes(1);
    expect(mockUpsertRollingCompressionGroup).toHaveBeenCalledWith(
      'tpc_1',
      ['msg_u1', 'msg_a1'],
      { agentId: 'agent_1', topicId: 'tpc_1' },
      '### Context\nСжатое резюме диалога.',
    );

    // Пустое тело без JSON также валидно
    const emptyBodyRes = await postCompact('tpc_1');
    expect(emptyBodyRes.status).toBe(200);
    expect((await emptyBodyRes.json()).data.compacted).toBe(true);

    // Невалидный JSON или поля возвращают 400
    const badJsonRes = await postCompact('tpc_1', undefined, '{broken');
    expect(badJsonRes.status).toBe(400);
    const badFieldRes = await postCompact('tpc_1', { dataGuardProtected: 'yes' });
    expect(badFieldRes.status).toBe(400);
    const emptyBeforeIdRes = await postCompact('tpc_1', { beforeMessageId: '' });
    expect(emptyBeforeIdRes.status).toBe(400);
  });

  it('2. пустая тема, < 2 осмысленных (включая 1 user + LOADING_FLAT "...") и повтор сразу после сжатия → 200 compacted=false и 0 вызовов LLM', async () => {
    // 2a. Пустая тема
    mockQueryWithWhere.mockResolvedValueOnce([]);
    const emptyRes = await postCompact('tpc_1', {});
    expect(emptyRes.status).toBe(200);
    expect((await emptyRes.json()).data).toEqual({
      compacted: false,
      compressedCount: 0,
      messageGroupId: null,
    });

    // 2b. 1 user + 1 пустой LOADING_FLAT '...' placeholder
    mockQueryWithWhere.mockResolvedValueOnce([
      makeMsg({ content: 'Единственное сообщение', id: 'msg_u1', role: 'user' }),
      makeMsg({ content: LOADING_FLAT, id: 'msg_a1_loading', role: 'assistant' }),
      makeMsg({ content: '', id: 'msg_a2_empty', role: 'assistant' }),
    ]);
    const stubRes = await postCompact('tpc_1', {});
    expect(stubRes.status).toBe(200);
    expect((await stubRes.json()).data).toEqual({
      compacted: false,
      compressedCount: 0,
      messageGroupId: null,
    });

    // 2c. Повторный вызов сразу после сжатия (1 compressedGroup и 0 новых осмысленных сообщений)
    mockQueryWithWhere.mockResolvedValueOnce([
      makeMsg({ content: 'Уже сжатое резюме', id: 'grp_existing', role: 'compressedGroup' }),
    ]);
    const repeatRes = await postCompact('tpc_1', {});
    expect(repeatRes.status).toBe(200);
    expect((await repeatRes.json()).data).toEqual({
      compacted: false,
      compressedCount: 0,
      messageGroupId: 'grp_existing',
    });

    expect(mockInitModelRuntimeFromDB).not.toHaveBeenCalled();
    expect(mockChat).not.toHaveBeenCalled();
    expect(mockUpsertRollingCompressionGroup).not.toHaveBeenCalled();
  });

  it('3. beforeMessageId сжимает строго до границы и безопасно откатывает границу перед assistant(tool_calls) → tool → assistant', async () => {
    // 3a. Обычный beforeMessageId на user-сообщении (сценарий 413)
    mockQueryWithWhere.mockResolvedValueOnce([
      makeMsg({ content: 'Ход 1 вопрос', id: 'u1', role: 'user' }),
      makeMsg({ content: 'Ход 1 ответ', id: 'a1', parentId: 'u1', role: 'assistant' }),
      makeMsg({ content: 'Ход 2 тяжёлый запрос (413)', id: 'u2', parentId: 'a1', role: 'user' }),
      makeMsg({ content: LOADING_FLAT, id: 'a2_stub', parentId: 'u2', role: 'assistant' }),
    ]);

    const resNormal = await postCompact('tpc_1', { beforeMessageId: 'u2' });
    expect(resNormal.status).toBe(200);
    expect((await resNormal.json()).data).toEqual({
      compacted: true,
      compressedCount: 2,
      messageGroupId: 'grp_1',
    });
    expect(mockUpsertRollingCompressionGroup).toHaveBeenLastCalledWith(
      'tpc_1',
      ['u1', 'a1'],
      { agentId: 'agent_1', topicId: 'tpc_1' },
      expect.any(String),
    );

    // 3b. beforeMessageId указывает на `tool` внутри assistant(tool_calls) → tool → assistant
    const toolChainMessages: UIChatMessage[] = [
      makeMsg({ content: 'Старый вопрос', id: 'u0', role: 'user' }),
      makeMsg({ content: 'Старый ответ', id: 'a0', parentId: 'u0', role: 'assistant' }),
      makeMsg({ content: 'Запусти инструмент', id: 'u1', parentId: 'a0', role: 'user' }),
      makeMsg({
        content: 'Вызываю чтение файла',
        id: 'a1_call',
        parentId: 'u1',
        role: 'assistant',
        tools: [
          {
            apiName: 'readFile',
            arguments: '{"path":"a.ts"}',
            id: 'tc_1',
            identifier: 'lobe-local-system',
            type: 'builtin',
          },
        ],
      }),
      makeMsg({
        content: 'Содержимое a.ts',
        id: 't1_res',
        parentId: 'a1_call',
        role: 'tool',
        tool_call_id: 'tc_1',
      }),
      makeMsg({
        content: 'Итоговый ответ по файлу',
        id: 'a2_final',
        parentId: 't1_res',
        role: 'assistant',
      }),
    ];

    mockQueryWithWhere.mockResolvedValueOnce(toolChainMessages);
    const resAtTool = await postCompact('tpc_1', { beforeMessageId: 't1_res' });
    expect(resAtTool.status).toBe(200);
    expect((await resAtTool.json()).data).toEqual({
      compacted: true,
      compressedCount: 3,
      messageGroupId: 'grp_1',
    });
    // Граница откатилась строго ДО a1_call — вся связка a1_call -> t1_res -> a2_final осталась целой в хвосте!
    expect(mockUpsertRollingCompressionGroup).toHaveBeenLastCalledWith(
      'tpc_1',
      ['u0', 'a0', 'u1'],
      { agentId: 'agent_1', topicId: 'tpc_1' },
      expect.any(String),
    );

    // 3c. beforeMessageId указывает на финальный assistant `a2_final` той же tool-группы
    mockQueryWithWhere.mockResolvedValueOnce(toolChainMessages);
    const resAtFinalAssistant = await postCompact('tpc_1', { beforeMessageId: 'a2_final' });
    expect(resAtFinalAssistant.status).toBe(200);
    expect(mockUpsertRollingCompressionGroup).toHaveBeenLastCalledWith(
      'tpc_1',
      ['u0', 'a0', 'u1'],
      { agentId: 'agent_1', topicId: 'tpc_1' },
      expect.any(String),
    );

    // 3d. beforeMessageId уже в messageGroupId в БД → compacted=false без вызова LLM
    mockChat.mockClear();
    mockQueryWithWhere.mockResolvedValueOnce([
      makeMsg({ content: 'Старое резюме', id: 'grp_1', role: 'compressedGroup' }),
    ]);
    state.messageRow = { id: 'msg_already_compressed', messageGroupId: 'grp_1' };
    const resAlreadyCompressed = await postCompact('tpc_1', {
      beforeMessageId: 'msg_already_compressed',
    });
    expect(resAlreadyCompressed.status).toBe(200);
    expect((await resAlreadyCompressed.json()).data).toEqual({
      compacted: false,
      compressedCount: 0,
      messageGroupId: null,
    });
    expect(mockChat).not.toHaveBeenCalled();
  });

  it('4. 409 Conflict: (а) активная операция в responsesStreamHub, (б) hasInFlightResponseTopic, (в) параллельный двойной /compact', async () => {
    // 4a. Активная операция в responsesStreamHub
    responsesStreamHub.register({
      operationId: 'op_live',
      params: { input: 'Привет', model: 'agent_1', stream: true } as any,
      responseId: 'tpc_1',
      topicId: 'tpc_1',
      userId: 'user_1',
    });

    const hubConflict = await postCompact('tpc_1', {});
    expect(hubConflict.status).toBe(409);
    expect(await hubConflict.json()).toMatchObject({
      error: 'Response is already in progress for this topic',
      success: false,
    });
    expect(mockChat).not.toHaveBeenCalled();

    responsesStreamHub.markDone('op_live', { status: 'done' } as any);

    // 4b. Активный tracker в hasInFlightResponseTopic
    const tracker = beginResponseExecution({ initialTopicId: 'tpc_1', userId: 'user_1' });
    const slotConflict = await postCompact('tpc_1', {});
    expect(slotConflict.status).toBe(409);
    expect(await slotConflict.json()).toMatchObject({
      error: 'Response is already in progress for this topic',
      success: false,
    });
    expect(mockChat).not.toHaveBeenCalled();
    tracker.finish();

    // 4c. Параллельный двойной /compact на ту же тему → второй получает 409, ровно 1 вызов LLM
    let releaseFirstLlm!: () => void;
    let markFirstLlmEntered!: () => void;
    const firstLlmEntered = new Promise<void>((resolve) => {
      markFirstLlmEntered = resolve;
    });
    mockChat.mockImplementationOnce(async (_payload: ChatStreamPayload, options: any) => {
      markFirstLlmEntered();
      await new Promise<void>((resolve) => {
        releaseFirstLlm = resolve;
      });
      await options?.callback?.onText?.('Резюме первого запроса');
      return new Response('');
    });

    const firstPromise = postCompact('tpc_1', {});
    await firstLlmEntered;

    const secondRes = await postCompact('tpc_1', {});
    expect(secondRes.status).toBe(409);
    expect(await secondRes.json()).toMatchObject({
      error: 'Compaction is already in progress for this topic',
      success: false,
    });

    releaseFirstLlm();
    const firstRes = await firstPromise;
    expect(firstRes.status).toBe(200);
    expect(mockChat).toHaveBeenCalledTimes(1);

    // После завершения первого запроса замок освобождён — следующий вызов проходит
    const thirdRes = await postCompact('tpc_1', {});
    expect(thirdRes.status).toBe(200);
    expect(mockChat).toHaveBeenCalledTimes(2);
  });

  it('5. 404 Not Found для чужой/несуществующей темы и несуществующего beforeMessageId', async () => {
    // 5a. Несуществующая или чужая тема
    state.topicRow = null;
    const missingTopicRes = await postCompact('tpc_foreign', {});
    expect(missingTopicRes.status).toBe(404);
    expect(await missingTopicRes.json()).toMatchObject({
      error: 'Topic not found',
      success: false,
    });
    expect(mockQueryWithWhere).not.toHaveBeenCalled();
    expect(mockChat).not.toHaveBeenCalled();

    // 5b. Существующая тема, но beforeMessageId отсутствует в теме
    state.topicRow = { agentId: 'agent_1', groupId: null, id: 'tpc_1', sessionId: 'sess_1' };
    state.messageRow = null;
    const missingMsgRes = await postCompact('tpc_1', { beforeMessageId: 'msg_nonexistent' });
    expect(missingMsgRes.status).toBe(404);
    expect(await missingMsgRes.json()).toMatchObject({
      error: 'Message not found in topic',
      success: false,
    });
    expect(mockChat).not.toHaveBeenCalled();
  });

  it('6. Data Guard: при dataGuardProtected=true или agent.chatConfig.deepseekDataGuardProtected всегда выбирается deepseek/deepseek-flash', async () => {
    // 6a. Через HTTP body dataGuardProtected=true (даже при попытке внешнего override в resolveCompressionModelConfig)
    const resolveSpy = vi.spyOn(compressionThresholds, 'resolveCompressionModelConfig');
    const httpRes = await postCompact('tpc_1', { dataGuardProtected: true });
    expect(httpRes.status).toBe(200);
    expect(resolveSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        agentConfig: expect.objectContaining({
          chatConfig: expect.objectContaining({ deepseekDataGuardProtected: true }),
        }),
      }),
    );
    expect(mockInitModelRuntimeFromDB).toHaveBeenLastCalledWith(
      expect.anything(),
      'user_1',
      'deepseek',
      expect.objectContaining({ studioWebChat: true, topicId: 'tpc_1' }),
    );
    expect(mockChat.mock.calls.at(-1)?.[0]).toMatchObject({ model: 'deepseek-flash' });

    // 6b. При explicitCompressionModel = anthropic/claude-haiku-5-5 и agent.chatConfig.deepseekDataGuardProtected=true
    state.agentRow = { chatConfig: { deepseekDataGuardProtected: true } };
    const directResult = await compactTopic({
      db: mockDb as any,
      explicitCompressionModel: { model: 'claude-haiku-5-5', provider: 'anthropic' },
      topicId: 'tpc_1',
      userId: 'user_1',
    });
    expect(directResult.compacted).toBe(true);
    expect(mockInitModelRuntimeFromDB).toHaveBeenLastCalledWith(
      expect.anything(),
      'user_1',
      'deepseek',
      expect.objectContaining({ studioWebChat: true, topicId: 'tpc_1' }),
    );
    expect(mockChat.mock.calls.at(-1)?.[0]).toMatchObject({ model: 'deepseek-flash' });

    // 6c. При explicitCompressionModel = anthropic/claude-haiku-5-5 и dataGuardProtected=true (без флага у агента)
    state.agentRow = { chatConfig: {} };
    const directFlagResult = await compactTopic({
      dataGuardProtected: true,
      db: mockDb as any,
      explicitCompressionModel: { model: 'claude-haiku-5-5', provider: 'anthropic' },
      topicId: 'tpc_1',
      userId: 'user_1',
    });
    expect(directFlagResult.compacted).toBe(true);
    expect(mockInitModelRuntimeFromDB).toHaveBeenLastCalledWith(
      expect.anything(),
      'user_1',
      'deepseek',
      expect.objectContaining({ studioWebChat: true, topicId: 'tpc_1' }),
    );
    expect(mockChat.mock.calls.at(-1)?.[0]).toMatchObject({ model: 'deepseek-flash' });
  });

  it('7. огромная тема: (>20K user-ход → DeepSeek alternating chunks; >safeBudget при узком окне → multi-pass rolling fold без 413)', async () => {
    // 7a. Один большой user-ход (> 20K токенов на кириллице) на DeepSeek 1M → alternating user / assistant chunks в одном вызове
    const bigRussianChunk = 'Архитектурное описание системы и требований. '.repeat(1_200);
    mockQueryWithWhere.mockResolvedValueOnce([
      makeMsg({ content: bigRussianChunk, id: 'u_big_1', role: 'user' }),
      makeMsg({ content: bigRussianChunk, id: 'a_big_1', parentId: 'u_big_1', role: 'assistant' }),
    ]);

    const alternatingRes = await postCompact('tpc_1', {});
    expect(alternatingRes.status).toBe(200);
    expect(mockChat).toHaveBeenCalledTimes(1);

    const sentMessages = mockChat.mock.calls[0][0].messages as Array<{
      content: string;
      role: string;
    }>;
    expect(sentMessages[0].role).toBe('system');
    expect(sentMessages.at(-1)?.role).toBe('user');
    // Должны быть чередующиеся assistant-подтверждения 'Фрагмент истории принят.'
    const ackMessages = sentMessages.filter(
      (m) => m.role === 'assistant' && m.content === 'Фрагмент истории принят.',
    );
    expect(ackMessages.length).toBeGreaterThanOrEqual(2);
    // Ни один user-ход не превышает 20_000 токенов и нет двух подряд user-ходов
    for (let i = 1; i < sentMessages.length; i++) {
      if (sentMessages[i].role === 'user') {
        expect(sentMessages[i - 1].role).not.toBe('user');
        expect(estimateDeepSeekUserTurnTokens(sentMessages[i].content)).toBeLessThanOrEqual(20_000);
      }
    }

    // 7b. Узкое окно суммаризатора (physicalWindowToken = 34_000 → safeBudget = 24_480) + 4 тяжёлых сообщения (~45K токенов суммарно)
    //     → последовательный multi-pass rolling fold (batch1 → summary1, batch2 + summary1 → summary2, ...)
    mockChat.mockClear();
    mockUpsertRollingCompressionGroup.mockClear();
    vi.spyOn(compressionThresholds, 'resolveCompressionThresholds').mockReturnValue({
      maxWindowToken: 34_000,
      midTurnThresholdRatio: 0.85,
      physicalWindowToken: 34_000,
      recompressionThresholdRatio: 0.65,
      thresholdRatio: 0.5,
    });

    const mediumBlock = 'Detailed technical context record for rolling batch fold. '.repeat(550);
    mockQueryWithWhere.mockResolvedValueOnce([
      makeMsg({ content: mediumBlock, id: 'm1', role: 'user' }),
      makeMsg({ content: mediumBlock, id: 'm2', parentId: 'm1', role: 'assistant' }),
      makeMsg({ content: mediumBlock, id: 'm3', parentId: 'm2', role: 'user' }),
      makeMsg({ content: mediumBlock, id: 'm4', parentId: 'm3', role: 'assistant' }),
    ]);

    let passNum = 0;
    mockChat.mockImplementation(async (_payload: ChatStreamPayload, options: any) => {
      passNum += 1;
      await options?.callback?.onText?.(`Rolling summary pass ${passNum}`);
      return new Response('');
    });

    const multiPassRes = await postCompact('tpc_1', {});
    expect(multiPassRes.status).toBe(200);
    expect((await multiPassRes.json()).data).toEqual({
      compacted: true,
      compressedCount: 4,
      messageGroupId: 'grp_1',
    });

    expect(mockChat.mock.calls.length).toBeGreaterThanOrEqual(2);
    // Второй проход получил rolling summary первого прохода
    const secondPassText = (mockChat.mock.calls[1][0].messages as Array<{ content: string }>)
      .map((m) => m.content)
      .join('\n');
    expect(secondPassText).toContain('Rolling summary pass 1');

    // Сохраняется итоговое резюме последнего прохода и все 4 ID сообщений
    expect(mockUpsertRollingCompressionGroup).toHaveBeenCalledTimes(1);
    expect(mockUpsertRollingCompressionGroup).toHaveBeenCalledWith(
      'tpc_1',
      ['m1', 'm2', 'm3', 'm4'],
      { agentId: 'agent_1', topicId: 'tpc_1' },
      `Rolling summary pass ${passNum}`,
    );

    // 7c. Одиночное гигантское сообщение больше бюджета батча обрезается по середине с пометкой архива и сохраняет source_message_id
    mockChat.mockClear();
    const giantBody =
      'HEAD_MARKER ' + 'Gigantic single message body content. '.repeat(3_500) + ' TAIL_MARKER';
    mockQueryWithWhere.mockResolvedValueOnce([
      makeMsg({ content: giantBody, id: 'giant_u1', role: 'user' }),
      makeMsg({
        content: 'Короткий ответ',
        id: 'giant_a1',
        parentId: 'giant_u1',
        role: 'assistant',
      }),
    ]);
    mockChat.mockImplementation(async (_payload: ChatStreamPayload, options: any) => {
      await options?.callback?.onText?.('Summary of truncated giant');
      return new Response('');
    });

    const giantRes = await postCompact('tpc_1', {});
    expect(giantRes.status).toBe(200);
    const giantPassJoined = (mockChat.mock.calls[0][0].messages as Array<{ content: string }>)
      .map((m) => m.content)
      .join('\n');
    expect(giantPassJoined).toContain('[source_message_id: giant_u1');
    expect(giantPassJoined).toContain(
      'omitted during summarization; full original is preserved in getTopicContext(mode="archive")',
    );
    expect(giantPassJoined).toContain('HEAD_MARKER');
    expect(giantPassJoined).toContain('TAIL_MARKER');
  });

  it('8. 402 от billing_proxy (и 429 / пустой ответ) → пробрасывает HTTP статус и НЕ вызывает upsertRollingCompressionGroup', async () => {
    // 8a. 402 через onError с телом billing_proxy
    mockChat.mockImplementationOnce(async (_payload: ChatStreamPayload, options: any) => {
      await options?.callback?.onError?.({
        body: { code: 'studio_insufficient_balance', status: 402 },
        error: {
          code: 'billing_error',
          message: 'Недостаточно средств на балансе',
          type: 'insufficient_balance',
        },
        status: 402,
      });
      return new Response('');
    });

    const res402Callback = await postCompact('tpc_1', {});
    expect(res402Callback.status).toBe(402);
    expect(await res402Callback.json()).toMatchObject({
      error: 'Insufficient balance',
      success: false,
    });
    expect(mockUpsertRollingCompressionGroup).not.toHaveBeenCalled();

    // 8b. 402 через reject (throw) с code=insufficient_balance
    mockChat.mockRejectedValueOnce({
      code: 'insufficient_balance',
      message: 'Balance is empty',
    });
    const res402Throw = await postCompact('tpc_1', {});
    expect(res402Throw.status).toBe(402);
    expect(mockUpsertRollingCompressionGroup).not.toHaveBeenCalled();

    // 8c. 429 от провайдера/прокси → HTTP 429
    mockChat.mockImplementationOnce(async (_payload: ChatStreamPayload, options: any) => {
      await options?.callback?.onError?.({
        message: 'Too many requests',
        status: 429,
      });
      return new Response('');
    });
    const res429 = await postCompact('tpc_1', {});
    expect(res429.status).toBe(429);
    expect(mockUpsertRollingCompressionGroup).not.toHaveBeenCalled();

    // 8d. Пустой текст от суммаризатора → ошибка, не сохраняет пустую группу
    mockChat.mockImplementationOnce(async (_payload: ChatStreamPayload, options: any) => {
      await options?.callback?.onText?.('   ');
      return new Response('');
    });
    const resEmptySummary = await postCompact('tpc_1', {});
    expect(resEmptySummary.status).toBe(500);
    expect(mockUpsertRollingCompressionGroup).not.toHaveBeenCalled();
  });

  it('9. multi-pass rolling fold держит фактический размер каждого прохода <= safeBudget при большом nextSummary и огромных fileReferences (а single-pass не режет fileReferences)', async () => {
    const safeBudget = Math.floor(34_000 * 0.72); // 24_480
    vi.spyOn(compressionThresholds, 'resolveCompressionThresholds').mockReturnValue({
      maxWindowToken: 34_000,
      midTurnThresholdRatio: 0.85,
      physicalWindowToken: 34_000,
      recompressionThresholdRatio: 0.65,
      thresholdRatio: 0.5,
    });

    const makeManyFiles = (prefix: string, count: number) =>
      Array.from({ length: count }, (_, idx) => ({
        id: `file_${prefix}_${idx}`,
        name: `very-long-specification-document-name-${prefix}-${idx}-revision-2026.pdf`,
      }));

    const heavyBody = 'Detailed technical context record for rolling batch fold. '.repeat(550);
    mockQueryWithWhere.mockResolvedValueOnce([
      makeMsg({
        content: 'Prior rolling summary text.',
        fileList: makeManyFiles('prior', 45) as any,
        id: 'grp_0',
        role: 'compressedGroup',
      }),
      makeMsg({
        content: heavyBody,
        fileList: makeManyFiles('m1', 45) as any,
        id: 'm1',
        role: 'user',
      }),
      makeMsg({
        content: heavyBody,
        fileList: makeManyFiles('m2', 45) as any,
        id: 'm2',
        parentId: 'm1',
        role: 'assistant',
      }),
      makeMsg({
        content: heavyBody,
        fileList: makeManyFiles('m3', 45) as any,
        id: 'm3',
        parentId: 'm2',
        role: 'user',
      }),
      makeMsg({
        content: heavyBody,
        fileList: makeManyFiles('m4', 45) as any,
        id: 'm4',
        parentId: 'm3',
        role: 'assistant',
      }),
    ]);

    // На проходе i = 0 суммаризатор возвращает огромный nextSummary (> 10K токенов, выше maxSummaryTokens = 6_120)
    const oversizedSummary =
      'SUMMARY_HEAD ' +
      'Extensive rolling summary detail with exact identifiers and file cursors. '.repeat(900) +
      ' SUMMARY_TAIL';
    let pass = 0;
    mockChat.mockImplementation(async (_payload: ChatStreamPayload, options: any) => {
      pass += 1;
      await options?.callback?.onText?.(
        pass === 1 ? oversizedSummary : `Bounded rolling summary pass ${pass}`,
      );
      return new Response('');
    });

    const res = await postCompact('tpc_1', {});
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({
      compacted: true,
      compressedCount: 4,
      messageGroupId: 'grp_1',
    });

    expect(mockChat.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const [payload] of mockChat.mock.calls) {
      const promptMsgs = payload.messages as Array<{ content: unknown; role: string }>;
      const actualPromptTokens = promptMsgs.reduce((sum, msg) => {
        const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        return sum + estimateDeepSeekUserTurnTokens(text) + 4;
      }, 0);
      expect(actualPromptTokens).toBeLessThanOrEqual(safeBudget);
    }

    // На проходе i = 0 fileReferences были аккуратно обрезаны под fileRefsReserve
    const pass0Text = (mockChat.mock.calls[0][0].messages as Array<{ content: string }>)
      .map((m) => m.content)
      .join('\n');
    expect(pass0Text).toContain('<original_files>');
    expect(pass0Text).toContain('of file references omitted during summarization');

    // На проходе i = 1 огромный nextSummary с прохода 0 был обрезан до maxSummaryTokens
    const pass1Text = (mockChat.mock.calls[1][0].messages as Array<{ content: string }>)
      .map((m) => m.content)
      .join('\n');
    expect(pass1Text).toContain('SUMMARY_HEAD');
    expect(pass1Text).toContain('SUMMARY_TAIL');
    expect(pass1Text).toContain('of rolling summary omitted during summarization');

    // Single-pass: умеренный список fileReferences не обрезается
    mockChat.mockClear();
    mockQueryWithWhere.mockResolvedValueOnce([
      makeMsg({
        content: 'Короткий вопрос с файлами',
        fileList: makeManyFiles('single', 12) as any,
        id: 's1',
        role: 'user',
      }),
      makeMsg({
        content: 'Короткий ответ',
        id: 's2',
        parentId: 's1',
        role: 'assistant',
      }),
    ]);
    mockChat.mockImplementationOnce(async (_payload: ChatStreamPayload, options: any) => {
      await options?.callback?.onText?.('Single-pass summary');
      return new Response('');
    });

    const singleRes = await postCompact('tpc_1', {});
    expect(singleRes.status).toBe(200);
    expect(mockChat).toHaveBeenCalledTimes(1);
    const singlePassText = (mockChat.mock.calls[0][0].messages as Array<{ content: string }>)
      .map((m) => m.content)
      .join('\n');
    expect(singlePassText).not.toContain('of file references omitted during summarization');
    expect(singlePassText).toContain('file_single_0');
    expect(singlePassText).toContain('file_single_11');
  });

  it('10. compressedGroup после beforeMessageId → compacted=false без потери summary; 1 compressedGroup + 1 новое сообщение → compacted=true', async () => {
    // 10a. В сохранённом хвосте после safeCutoff есть более поздняя compressedGroup → безопасный отказ без LLM
    mockQueryWithWhere.mockResolvedValueOnce([
      makeMsg({ content: 'Старое резюме 1', id: 'grp_1', role: 'compressedGroup' }),
      makeMsg({ content: 'Промежуточный вопрос', id: 'u_mid', role: 'user' }),
      makeMsg({
        content: 'Промежуточный ответ',
        id: 'a_mid',
        parentId: 'u_mid',
        role: 'assistant',
      }),
      makeMsg({ content: 'Позднее резюме 2', id: 'grp_2', role: 'compressedGroup' }),
      makeMsg({ content: 'Свежий вопрос', id: 'u_new', role: 'user' }),
    ]);

    const guardedRes = await postCompact('tpc_1', { beforeMessageId: 'a_mid' });
    expect(guardedRes.status).toBe(200);
    expect((await guardedRes.json()).data).toEqual({
      compacted: false,
      compressedCount: 0,
      messageGroupId: null,
    });
    expect(mockChat).not.toHaveBeenCalled();
    expect(mockUpsertRollingCompressionGroup).not.toHaveBeenCalled();

    // 10b. 1 priorCompressedGroup + 1 новое тяжёлое сообщение перед упавшим с 413 beforeMessageId → сжимается!
    mockQueryWithWhere.mockResolvedValueOnce([
      makeMsg({ content: 'Базовое резюме', id: 'grp_existing', role: 'compressedGroup' }),
      makeMsg({ content: 'Огромный дамп перед 413', id: 'u_heavy', role: 'user' }),
      makeMsg({ content: 'Новый запрос, упавший с 413', id: 'u_413', role: 'user' }),
    ]);

    const onePlusOneRes = await postCompact('tpc_1', { beforeMessageId: 'u_413' });
    expect(onePlusOneRes.status).toBe(200);
    expect((await onePlusOneRes.json()).data).toEqual({
      compacted: true,
      compressedCount: 1,
      messageGroupId: 'grp_1',
    });
    expect(mockChat).toHaveBeenCalledTimes(1);
    const promptJoined = (mockChat.mock.calls[0][0].messages as Array<{ content: string }>)
      .map((m) => m.content)
      .join('\n');
    expect(promptJoined).toContain('Базовое резюме');
    expect(promptJoined).toContain('Огромный дамп перед 413');
    expect(promptJoined).not.toContain('Новый запрос, упавший с 413');
    expect(mockUpsertRollingCompressionGroup).toHaveBeenCalledWith(
      'tpc_1',
      ['u_heavy'],
      { agentId: 'agent_1', topicId: 'tpc_1' },
      '### Context\nСжатое резюме диалога.',
    );

    // 10c. 1 priorCompressedGroup + 0 новых сообщений перед beforeMessageId → compacted=false, 0 вызовов LLM
    mockChat.mockClear();
    mockUpsertRollingCompressionGroup.mockClear();
    mockQueryWithWhere.mockResolvedValueOnce([
      makeMsg({ content: 'Базовое резюме', id: 'grp_existing', role: 'compressedGroup' }),
      makeMsg({ content: 'Запрос сразу после группы', id: 'u_413', role: 'user' }),
    ]);
    const zeroNewRes = await postCompact('tpc_1', { beforeMessageId: 'u_413' });
    expect(zeroNewRes.status).toBe(200);
    expect((await zeroNewRes.json()).data).toEqual({
      compacted: false,
      compressedCount: 0,
      messageGroupId: 'grp_existing',
    });
    expect(mockChat).not.toHaveBeenCalled();
    expect(mockUpsertRollingCompressionGroup).not.toHaveBeenCalled();
  });

  it('11. обратная гонка: hasInFlightTopicCompactionsForUser выставлен во время LLM и если тема стала busy до записи — 409 без upsertRollingCompressionGroup', async () => {
    let releaseLlm!: () => void;
    let markLlmEntered!: () => void;
    const llmEntered = new Promise<void>((resolve) => {
      markLlmEntered = resolve;
    });

    mockChat.mockImplementationOnce(async (_payload: ChatStreamPayload, options: any) => {
      markLlmEntered();
      await new Promise<void>((resolve) => {
        releaseLlm = resolve;
      });
      await options?.callback?.onText?.('Резюме, которое нельзя записывать поверх идущего ответа');
      return new Response('');
    });

    const compactPromise = postCompact('tpc_1', {});
    await llmEntered;

    expect(hasInFlightTopicCompaction('user_1', 'tpc_1')).toBe(true);
    expect(hasInFlightTopicCompactionsForUser('user_1')).toBe(true);
    expect(hasInFlightTopicCompactionsForUser('user_other')).toBe(false);

    // Симулируем, что тема стала занята (например, параллельный ответ) до завершения LLM-вызова
    responsesStreamHub.register({
      operationId: 'op_raced',
      params: { input: 'Гонка', model: 'agent_1', stream: true } as any,
      responseId: 'tpc_1',
      topicId: 'tpc_1',
      userId: 'user_1',
    });

    releaseLlm();
    const racedRes = await compactPromise;
    expect(racedRes.status).toBe(409);
    expect(await racedRes.json()).toMatchObject({
      error: 'Response is already in progress for this topic',
      success: false,
    });
    expect(mockUpsertRollingCompressionGroup).not.toHaveBeenCalled();
    expect(hasInFlightTopicCompaction('user_1', 'tpc_1')).toBe(false);
    expect(hasInFlightTopicCompactionsForUser('user_1')).toBe(false);
  });

  it('12. provider_credits_exhausted (status: 402) → HTTP 503, а голый upstream 402 без клиентских маркеров НЕ превращается в клиентский 402', async () => {
    // 12a. provider_credits_exhausted c status=402 → 503 (не 402 и не 500)
    mockChat.mockImplementationOnce(async (_payload: ChatStreamPayload, options: any) => {
      await options?.callback?.onError?.({
        body: { code: 'provider_credits_exhausted', status: 402 },
        message: 'Сейчас эта модель временно недоступна. Мы уже в процессе её восстановления.',
        status: 402,
      });
      return new Response('');
    });

    const creditsRes = await postCompact('tpc_1', {});
    expect(creditsRes.status).toBe(503);
    expect(await creditsRes.json()).toMatchObject({
      error: 'Сейчас эта модель временно недоступна. Мы уже в процессе её восстановления.',
      success: false,
    });
    expect(mockUpsertRollingCompressionGroup).not.toHaveBeenCalled();

    // 12b. provider_credits_exhausted без текста сообщения → 503 с fallback-сообщением
    mockChat.mockRejectedValueOnce({
      body: { code: 'provider_credits_exhausted' },
      status: 402,
    });
    const creditsFallbackRes = await postCompact('tpc_1', {});
    expect(creditsFallbackRes.status).toBe(503);
    expect(await creditsFallbackRes.json()).toMatchObject({
      error: 'Provider credits exhausted',
      success: false,
    });
    expect(mockUpsertRollingCompressionGroup).not.toHaveBeenCalled();

    // 12c. Голый upstream status=402 без клиентских маркеров баланса → НЕ 402
    mockChat.mockImplementationOnce(async (_payload: ChatStreamPayload, options: any) => {
      await options?.callback?.onError?.({
        message: 'Upstream vendor credits depleted',
        status: 402,
      });
      return new Response('');
    });
    const bare402Res = await postCompact('tpc_1', {});
    expect(bare402Res.status).toBe(500);
    expect(mockUpsertRollingCompressionGroup).not.toHaveBeenCalled();
  });
});
