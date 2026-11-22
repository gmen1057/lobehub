import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getActiveTopicCompactions,
  resetInFlightTopicCompactionsForTests,
} from '@/server/services/topic/compactionRegistry';

import { responsesStreamHub } from '../../services/responsesStreamHub';
import MessageRoutes from '../messages.route';
import ResponsesRoutes from '../responses.route';

const {
  mockAssertTopicAccess,
  mockDeleteWhere,
  mockExecAgent,
  mockExecuteSync,
  mockFindFirstMessage,
  mockFindManyMessages,
  mockTransaction,
} = vi.hoisted(() => {
  const deleteWhere = vi.fn(async () => undefined);
  const transaction = vi.fn(async (cb: (trx: any) => Promise<void>) => {
    await cb({
      delete: () => ({ where: deleteWhere }),
    });
  });
  return {
    mockAssertTopicAccess: vi.fn(),
    mockDeleteWhere: deleteWhere,
    mockExecAgent: vi.fn(),
    mockExecuteSync: vi.fn(),
    mockFindFirstMessage: vi.fn(),
    mockFindManyMessages: vi.fn(),
    mockTransaction: transaction,
  };
});

vi.mock('@/const/rbac', () => ({ ALL_SCOPE: 'all', RBAC_PERMISSIONS: {} }));
vi.mock('@/utils/rbac', () => ({
  getAllScopePermissions: () => ['message:delete:all'],
  getScopePermissions: () => ['message:delete:all'],
}));
vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: async () => ({
    query: {
      messages: {
        findFirst: mockFindFirstMessage,
        findMany: mockFindManyMessages,
      },
    },
    transaction: mockTransaction,
  }),
}));
vi.mock('@/database/models/rbac', () => ({
  RbacModel: class {
    hasAnyPermission = async () => true;
  },
}));
vi.mock('@/database/models/file', () => ({ FileModel: class {} }));
vi.mock('@/database/schemas', () => ({
  agents: {},
  aiModels: {},
  aiProviders: {},
  files: {},
  knowledgeBases: {},
  messages: { createdAt: 'createdAt', id: 'id', topicId: 'topicId', userId: 'userId' },
  messagesFiles: { messageId: 'messageId' },
  sessions: {},
  topics: {},
}));
vi.mock('@/database/utils/idGenerator', () => ({ idGenerator: () => 'msg_gen_1' }));
vi.mock('@/server/modules/AgentRuntime/StreamEventManager', () => ({}));
vi.mock('@/server/modules/AgentRuntime/reasoningLevels', () => ({
  ARCKEP_REASONING_LEVEL_KEY: 'arckepReasoningLevel',
}));
vi.mock('@/server/services/agentRuntime', () => ({
  AgentRuntimeService: class {
    executeSync = mockExecuteSync;
  },
}));
vi.mock('@/server/services/aiAgent', () => ({
  AiAgentService: class {
    assertTopicAccess = mockAssertTopicAccess;
    execAgent = mockExecAgent;
  },
}));
vi.mock('@/server/services/file', () => ({ FileService: class {} }));
vi.mock('../../services/chat.service', () => ({ ChatService: class {} }));
vi.mock('../../controllers', async () => {
  const actual = await import('../../controllers/message.controller');
  return { MessageController: actual.MessageController };
});
vi.mock('../../middleware', () => ({
  requireAuth: async (c: any, next: any) => {
    c.set('userId', 'user_1');
    await next();
  },
}));
vi.mock('../../middleware/auth', () => ({
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

const app = new Hono()
  .route('/api/v1/responses', ResponsesRoutes)
  .route('/api/v1/messages', MessageRoutes);

const parseSseEvents = (raw: string): Array<{ data: any; event: string }> =>
  raw
    .split('\n\n')
    .map((block) => block.trim())
    .filter((block) => block && !block.startsWith(':'))
    .map((block) => {
      let event = 'message';
      let data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data = line.slice(5).trim();
      }
      return { data: data ? JSON.parse(data) : null, event };
    });

describe('chat-resume-guard HTTP routes (В1 + Г1)', () => {
  beforeEach(() => {
    responsesStreamHub.clear();
    resetInFlightTopicCompactionsForTests();
    vi.clearAllMocks();
    mockAssertTopicAccess.mockResolvedValue(undefined);
    mockExecAgent.mockResolvedValue({
      operationId: 'op_new',
      success: true,
      topicId: 'tpc_1',
    });
    mockExecuteSync.mockResolvedValue({
      messages: [{ content: 'ok', role: 'assistant' }],
      status: 'done',
    });
  });

  afterEach(() => {
    resetInFlightTopicCompactionsForTests();
  });

  it('GET /responses/:id/stream?mode=wait отдаёт SSE и ждёт завершения даже при truncated=true, тогда как обычный /stream даёт 404', async () => {
    const missing = await app.request('/api/v1/responses/tpc_missing/stream?mode=wait');
    expect(missing.status).toBe(404);

    const op = responsesStreamHub.register({
      operationId: 'op_trunc',
      params: { input: 'длинный запрос', model: 'agent-1', stream: true } as any,
      responseId: 'tpc_1',
      topicId: 'tpc_1',
      userId: 'user_1',
    });
    op.truncated = true;

    const normalRes = await app.request('/api/v1/responses/tpc_1/stream');
    expect(normalRes.status).toBe(404);

    const waitResPromise = app
      .request('/api/v1/responses/tpc_1/stream?mode=wait')
      .then(async (res) => ({
        events: parseSseEvents(await res.text()),
        status: res.status,
      }));

    await vi.waitFor(() => expect(op.subscribers.size).toBe(1));
    await responsesStreamHub.publishStreamChunk('op_trunc', 0, {
      chunkType: 'text',
      content: 'скрытая дельта',
    });
    responsesStreamHub.markDone('op_trunc', {
      messages: [{ content: 'Итоговый ответ', role: 'assistant' }],
      status: 'done',
      usage: { llm: { tokens: { input: 5, output: 7, total: 12 } } },
    } as any);

    const waitRes = await waitResPromise;
    expect(waitRes.status).toBe(200);
    expect(waitRes.events.map((e) => e.event)).toEqual([
      'response.created',
      'response.in_progress',
      'response.completed',
    ]);
    expect(waitRes.events[2].data.response).toMatchObject({
      id: 'tpc_1',
      output_text: 'Итоговый ответ',
      status: 'completed',
      usage: { input_tokens: 5, output_tokens: 7, total_tokens: 12 },
    });
  });

  it.each([false, true])(
    'POST /responses (stream=%s) с идущей темой (!op.done) возвращает 409 до вызова execAgent, но пропускает function_call_output',
    async (stream) => {
      responsesStreamHub.register({
        operationId: 'op_running',
        params: { input: 'первый', model: 'agent-1', stream: true } as any,
        responseId: 'tpc_1',
        topicId: 'tpc_1',
        userId: 'user_1',
      });

      const conflictRes = await app.request('/api/v1/responses', {
        body: JSON.stringify({
          input: 'параллельный второй запрос',
          model: 'agent-1',
          previous_response_id: 'tpc_1',
          stream,
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      });

      expect(conflictRes.status).toBe(409);
      expect(await conflictRes.json()).toMatchObject({
        error: 'Response is already in progress for this topic',
        success: false,
      });
      expect(mockExecAgent).not.toHaveBeenCalled();

      // Resume flow (function_call_output) не блокируется проверкой конфликта
      const resumeRes = await app.request('/api/v1/responses', {
        body: JSON.stringify({
          input: [{ call_id: 'call_1', output: '{"ok":true}', type: 'function_call_output' }],
          model: 'agent-1',
          previous_response_id: 'tpc_1',
          stream: false,
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      });
      expect(resumeRes.status).toBe(200);
      expect(mockExecAgent).toHaveBeenCalledTimes(1);
    },
  );

  it('DELETE /messages/:id и DELETE /messages возвращают 409 без удаления из БД, пока в теме идёт ответ', async () => {
    responsesStreamHub.register({
      operationId: 'op_running',
      params: { input: 'первый', model: 'agent-1', stream: true } as any,
      responseId: 'tpc_busy',
      topicId: 'tpc_busy',
      userId: 'user_1',
    });

    mockFindManyMessages.mockResolvedValue([{ topicId: 'tpc_busy' }]);
    mockFindFirstMessage.mockResolvedValue({ userId: 'user_1' });

    const singleRes = await app.request('/api/v1/messages/msg_1', {
      method: 'DELETE',
    });
    expect(singleRes.status).toBe(409);
    expect(await singleRes.json()).toMatchObject({
      error: 'Response is already in progress for this topic',
      success: false,
    });
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockDeleteWhere).not.toHaveBeenCalled();

    // Пакетное удаление, где хотя бы одно сообщение из занятой темы — тоже 409 и ни одной строки не удалено
    mockFindManyMessages.mockResolvedValue([{ topicId: 'tpc_idle' }, { topicId: 'tpc_busy' }]);
    const batchRes = await app.request('/api/v1/messages', {
      body: JSON.stringify({ messageIds: ['msg_idle', 'msg_busy'] }),
      headers: { 'Content-Type': 'application/json' },
      method: 'DELETE',
    });
    expect(batchRes.status).toBe(409);
    expect(await batchRes.json()).toMatchObject({
      error: 'Response is already in progress for this topic',
      success: false,
    });
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockDeleteWhere).not.toHaveBeenCalled();

    // После завершения ответа удаление проходит штатно
    responsesStreamHub.markDone('op_running', { status: 'done' } as any);
    const okRes = await app.request('/api/v1/messages/msg_1', {
      method: 'DELETE',
    });
    expect(okRes.status).toBe(200);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });

  it('POST /responses и DELETE /messages возвращают 409 Conflict во время активного /compact темы и пропускают после его завершения', async () => {
    getActiveTopicCompactions().add('user_1:tpc_1');

    // POST /responses (stream=false и stream=true) блокируются 409 до вызова execAgent
    for (const stream of [false, true]) {
      const respConflict = await app.request('/api/v1/responses', {
        body: JSON.stringify({
          input: 'сообщение во время сжатия',
          model: 'agent-1',
          previous_response_id: 'tpc_1',
          stream,
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      });
      expect(respConflict.status).toBe(409);
      expect(await respConflict.json()).toMatchObject({
        error: 'Compaction is already in progress for this topic',
        success: false,
      });
    }
    expect(mockExecAgent).not.toHaveBeenCalled();

    // DELETE /messages/:id и DELETE /messages (batch) для темы в сжатии → 409 без удаления из БД
    mockFindManyMessages.mockResolvedValue([{ topicId: 'tpc_1' }]);
    mockFindFirstMessage.mockResolvedValue({ userId: 'user_1' });

    const singleDeleteConflict = await app.request('/api/v1/messages/msg_1', {
      method: 'DELETE',
    });
    expect(singleDeleteConflict.status).toBe(409);
    expect(await singleDeleteConflict.json()).toMatchObject({
      error: 'Compaction is already in progress for this topic',
      success: false,
    });

    mockFindManyMessages.mockResolvedValue([{ topicId: 'tpc_other' }, { topicId: 'tpc_1' }]);
    const batchDeleteConflict = await app.request('/api/v1/messages', {
      body: JSON.stringify({ messageIds: ['msg_other', 'msg_1'] }),
      headers: { 'Content-Type': 'application/json' },
      method: 'DELETE',
    });
    expect(batchDeleteConflict.status).toBe(409);
    expect(await batchDeleteConflict.json()).toMatchObject({
      error: 'Compaction is already in progress for this topic',
      success: false,
    });
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockDeleteWhere).not.toHaveBeenCalled();

    // После завершения сжатия запросы снова проходят штатно
    getActiveTopicCompactions().delete('user_1:tpc_1');

    const okResp = await app.request('/api/v1/responses', {
      body: JSON.stringify({
        input: 'сообщение после сжатия',
        model: 'agent-1',
        previous_response_id: 'tpc_1',
        stream: false,
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    expect(okResp.status).toBe(200);
    expect(mockExecAgent).toHaveBeenCalledTimes(1);

    const okDelete = await app.request('/api/v1/messages/msg_1', {
      method: 'DELETE',
    });
    expect(okDelete.status).toBe(200);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });
});
