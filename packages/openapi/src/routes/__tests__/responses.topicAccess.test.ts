import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ResponsesServiceModule from '../../services/responses.service';
import ResponsesRoutes from '../responses.route';

const { findTopic, findOwner, createResponse, createStreamingResponse } = vi.hoisted(() => ({
  createResponse: vi.fn(),
  createStreamingResponse: vi.fn(),
  findOwner: vi.fn(),
  findTopic: vi.fn(),
}));

vi.mock('@/const/rbac', () => ({ RBAC_PERMISSIONS: {} }));
vi.mock('@/database/core/db-adaptor', () => ({ getServerDB: async () => ({}) }));
vi.mock('@/database/models/rbac', () => ({ RbacModel: class {} }));
vi.mock('@/database/models/file', () => ({ FileModel: class {} }));
vi.mock('@/database/schemas', () => ({}));
vi.mock('../../middleware/auth', () => ({
  requireAuth: async (c: any, next: any) => {
    c.set('userId', 'user_1');
    await next();
  },
}));
vi.mock('@/server/modules/AgentRuntime/reasoningLevels', () => ({
  ARCKEP_REASONING_LEVEL_KEY: 'arckepReasoningLevel',
}));
vi.mock('@/server/services/agentRuntime', () => ({ AgentRuntimeService: class {} }));
// Настоящая проверка владельца темы (topicAccess.ts) поверх подмены модели тем: так проверяется всё от
// контроллера до ответа 404, кроме самой базы (её покрывает topicAccess.db.test.ts).
vi.mock('@/server/services/aiAgent', async () => {
  const { assertTopicAccess } = await import('@/server/services/aiAgent/topicAccess');
  return {
    AiAgentService: class {
      constructor(
        _db: unknown,
        private userId: string,
      ) {}

      assertTopicAccess = (topicId: string) =>
        assertTopicAccess({
          topicId,
          topicModel: { findById: findTopic, findOwnerId: findOwner } as any,
          userId: this.userId,
        });
    },
  };
});
vi.mock('@/server/services/file', () => ({ FileService: class {} }));
vi.mock('../../services/responses.service', async (importOriginal) => {
  const actual = await importOriginal<typeof ResponsesServiceModule>();
  actual.ResponsesService.prototype.createResponse = createResponse as any;
  actual.ResponsesService.prototype.createStreamingResponse = createStreamingResponse as any;
  return actual;
});

// arckep (19.10.2026): тема из previous_response_id принадлежит человеку — иначе HTTP 404 «Тема не найдена»
// до начала ответа, в потоковом режиме тоже (иначе ошибка пришла бы событием посреди потока).

const app = new Hono().route('/responses', ResponsesRoutes);
const post = (body: Record<string, unknown>) =>
  app.request('/responses', {
    body: JSON.stringify({ input: 'Привет', model: 'agent-1', ...body }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  });

beforeEach(() => {
  vi.clearAllMocks();
  createResponse.mockResolvedValue({ id: 'resp_1', object: 'response' });
  createStreamingResponse.mockImplementation(async function* () {
    yield { type: 'response.created' };
  });
});

describe('POST /responses — тема из previous_response_id', () => {
  it.each([false, true])(
    'чужая тема (stream=%s): 404 «Тема не найдена», ответ не начинается',
    async (stream) => {
      findTopic.mockResolvedValue(undefined);

      const response = await post({ previous_response_id: 'tpc_victim', stream });

      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: 'Тема не найдена', success: false });
      expect(createResponse).not.toHaveBeenCalled();
      expect(createStreamingResponse).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])('несуществующая тема (stream=%s): тоже 404', async (stream) => {
    findTopic.mockResolvedValue(undefined);
    const response = await post({ previous_response_id: 'tpc_gone', stream });
    expect(response.status).toBe(404);
    expect(createResponse).not.toHaveBeenCalled();
    expect(createStreamingResponse).not.toHaveBeenCalled();
  });

  it('своя тема: ответ создаётся', async () => {
    findTopic.mockResolvedValue({ id: 'tpc_mine' });
    const response = await post({ previous_response_id: 'tpc_mine' });
    expect(response.status).toBe(200);
    expect(findTopic).toHaveBeenCalledWith('tpc_mine');
    expect(createResponse).toHaveBeenCalledTimes(1);
  });

  it('своя тема, поток: поток открывается', async () => {
    findTopic.mockResolvedValue({ id: 'tpc_mine' });
    const response = await post({ previous_response_id: 'tpc_mine', stream: true });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
  });

  it('без previous_response_id (новый разговор): темы проверять нечего', async () => {
    const response = await post({});
    expect(response.status).toBe(200);
    expect(findTopic).not.toHaveBeenCalled();
    expect(createResponse).toHaveBeenCalledTimes(1);
  });
});
