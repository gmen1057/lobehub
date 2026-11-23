import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearLocalOperationAbortControllersForTests,
  hasLocalOperationAbortController,
  registerLocalOperationAbortController,
} from '@/server/services/agentRuntime/operationInterruption';

import {
  beginResponseExecution,
  hasInFlightResponseTopic,
  resetEngineSlotActivityForTests,
} from '../engineSlotActivity';
import { ResponsesService } from '../responses.service';
import { responsesStreamHub } from '../responsesStreamHub';

const { mockAgentRuntimeCtor, mockInterruptTopic } = vi.hoisted(() => ({
  mockAgentRuntimeCtor: vi.fn(),
  mockInterruptTopic: vi.fn(),
}));

vi.mock('@/server/modules/AgentRuntime/InMemoryStreamEventManager', () => ({
  InMemoryStreamEventManager: class {},
}));
vi.mock('@/server/modules/AgentRuntime/StreamEventManager', () => ({}));
vi.mock('@/server/services/agentRuntime', () => ({
  AgentRuntimeService: class {
    constructor(db: unknown, userId: string, options?: unknown) {
      mockAgentRuntimeCtor(db, userId, options);
    }
    interruptTopicOperations = mockInterruptTopic;
  },
}));
vi.mock('@/server/services/aiAgent', () => ({ AiAgentService: class {} }));
vi.mock('@/database/models/file', () => ({ FileModel: class {} }));
vi.mock('@/server/services/file', () => ({ FileService: class {} }));
vi.mock('../../common/base.service', () => ({
  BaseService: class {
    db: any;
    userId: string;
    constructor(db: any, userId: string) {
      this.db = db;
      this.userId = userId;
    }
    log() {}
  },
}));

describe('ResponsesService.cancelResponse (arckep: кнопка «стоп»)', () => {
  const service = new ResponsesService({} as any, 'user-1');

  beforeEach(() => {
    responsesStreamHub.clear();
    resetEngineSlotActivityForTests();
    clearLocalOperationAbortControllersForTests();
    mockAgentRuntimeCtor.mockReset();
    mockInterruptTopic.mockReset();
  });

  afterEach(() => {
    responsesStreamHub.clear();
    resetEngineSlotActivityForTests();
    clearLocalOperationAbortControllersForTests();
  });

  it('останавливает операции темы, закодированной в id ответа, прокидывая responsesStreamHub', async () => {
    mockInterruptTopic.mockResolvedValue(1);
    expect(await service.cancelResponse('tpc_abc')).toEqual({ cancelled: 1, id: 'tpc_abc' });
    expect(mockInterruptTopic).toHaveBeenCalledWith('tpc_abc');
    expect(mockAgentRuntimeCtor).toHaveBeenCalledWith(
      expect.anything(),
      'user-1',
      expect.objectContaining({
        queueService: null,
        streamEventManager: responsesStreamHub,
      }),
    );
  });

  it('пустой id — нечего останавливать', async () => {
    expect(await service.cancelResponse('')).toEqual({ cancelled: 0, id: '' });
    expect(mockInterruptTopic).not.toHaveBeenCalled();
  });

  it('мгновенно обрывает in-flight AbortController и снимает 409 / in_progress до завершения op.done', async () => {
    const opId = 'op_1_agt_1_tpc_hang_x1';
    const controller = new AbortController();
    const unregister = registerLocalOperationAbortController(opId, controller);

    try {
      const op = responsesStreamHub.register({
        operationId: opId,
        params: { input: 'долгий запрос', model: 'agt_1', stream: true } as any,
        responseId: 'tpc_hang',
        topicId: 'tpc_hang',
        userId: 'user-1',
      });
      const tracker = beginResponseExecution({
        initialTopicId: 'tpc_hang',
        userId: 'user-1',
      });
      tracker.setOperation(opId, 'tpc_hang');

      // До отмены: статус in_progress, тема в runningTopics, повторный запрос блокируется 409
      expect(service.getResponseStatus('tpc_hang')).toMatchObject({ status: 'in_progress' });
      expect(service.listRunningTopics()).toEqual(['tpc_hang']);
      expect(() =>
        service.assertPreviousTopicIdle({
          input: 'новое сообщение',
          model: 'agt_1',
          previous_response_id: 'tpc_hang',
        } as any),
      ).toThrowError(/already in progress/);

      mockInterruptTopic.mockResolvedValue(1);
      const res = await service.cancelResponse('tpc_hang');
      expect(res).toEqual({ cancelled: 1, id: 'tpc_hang' });

      // AbortController оборван немедленно с причиной user_cancelled
      expect(controller.signal.aborted).toBe(true);
      expect(controller.signal.reason).toBeInstanceOf(Error);
      expect((controller.signal.reason as Error).name).toBe('AbortError');
      expect((controller.signal.reason as Error).message).toBe('user_cancelled');

      // Даже пока op.done === false (фоновая финализация ещё идёт), 409 и in_progress уже сняты
      expect(op.done).toBe(false);
      expect(op.cancelRequested).toBe(true);
      expect(service.getResponseStatus('tpc_hang')).toMatchObject({ status: 'incomplete' });
      expect(service.listRunningTopics()).toEqual([]);
      expect(hasInFlightResponseTopic('user-1', 'tpc_hang')).toBe(false);
      expect(() =>
        service.assertPreviousTopicIdle({
          input: 'новое сообщение сразу после стопа',
          model: 'agt_1',
          previous_response_id: 'tpc_hang',
        } as any),
      ).not.toThrow();

      // Повторный клик «Стоп» идемпотентен и не раздувает cancelled
      mockInterruptTopic.mockResolvedValue(0);
      expect(await service.cancelResponse('tpc_hang')).toEqual({ cancelled: 0, id: 'tpc_hang' });

      // Новый ответ в той же теме перекрывает ещё дозаписывающуюся отменённую операцию
      const nextOp = responsesStreamHub.register({
        operationId: 'op_2_agt_1_tpc_hang_x2',
        params: { input: 'новое сообщение', model: 'agt_1', stream: true } as any,
        responseId: 'tpc_hang',
        topicId: 'tpc_hang',
        userId: 'user-1',
      });
      expect(service.getResponseStatus('tpc_hang')).toMatchObject({
        operation_id: nextOp.operationId,
        status: 'in_progress',
      });
      tracker.finish();
    } finally {
      unregister();
    }
    expect(hasLocalOperationAbortController(opId)).toBe(false);
  });
});
