import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ResponsesService } from '../responses.service';

const { mockInterruptTopic } = vi.hoisted(() => ({ mockInterruptTopic: vi.fn() }));

vi.mock('@/server/modules/AgentRuntime/InMemoryStreamEventManager', () => ({
  InMemoryStreamEventManager: class {},
}));
vi.mock('@/server/modules/AgentRuntime/StreamEventManager', () => ({}));
vi.mock('@/server/services/agentRuntime', () => ({
  AgentRuntimeService: class {
    interruptTopicOperations = mockInterruptTopic;
  },
}));
vi.mock('@/server/services/aiAgent', () => ({ AiAgentService: class {} }));
vi.mock('@/database/models/file', () => ({ FileModel: class {} }));
vi.mock('@/server/services/file', () => ({ FileService: class {} }));
vi.mock('../../common/base.service', () => ({
  BaseService: class {
    db: any;
    userId = '';
    constructor() {}
    log() {}
  },
}));

describe('ResponsesService.cancelResponse (arckep: кнопка «стоп»)', () => {
  const service = new ResponsesService({} as any, 'user-1');

  beforeEach(() => {
    mockInterruptTopic.mockReset();
  });

  it('останавливает операции темы, закодированной в id ответа', async () => {
    mockInterruptTopic.mockResolvedValue(1);
    expect(await service.cancelResponse('tpc_abc')).toEqual({ cancelled: 1, id: 'tpc_abc' });
    expect(mockInterruptTopic).toHaveBeenCalledWith('tpc_abc');
  });

  it('пустой id — нечего останавливать', async () => {
    expect(await service.cancelResponse('')).toEqual({ cancelled: 0, id: '' });
    expect(mockInterruptTopic).not.toHaveBeenCalled();
  });
});
