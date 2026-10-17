import { describe, expect, it, vi } from 'vitest';

// Now import the real service — only the stubs above are faked
import { ResponsesService } from '../responses.service';

// Stub external dependencies so ResponsesService can be imported in isolation
vi.mock('@/server/modules/AgentRuntime/InMemoryStreamEventManager', () => ({
  InMemoryStreamEventManager: class {},
}));
vi.mock('@/server/modules/AgentRuntime/StreamEventManager', () => ({}));
vi.mock('@/server/services/agentRuntime', () => ({ AgentRuntimeService: class {} }));
vi.mock('@/server/services/aiAgent', () => ({ AiAgentService: class {} }));
// arckep: extractAttachments тянет модель файлов и файловый сервис — здесь они не нужны
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

// Helper: call the private extractOutputItems via bracket notation
const callExtractOutputItems = (messages: any[], responseId: string) => {
  const svc = new (ResponsesService as any)(null, null);
  return svc['extractOutputItems']({ messages }, responseId);
};

describe('ResponsesService.resolveIncompleteReason (arckep: headless REST)', () => {
  const service = new ResponsesService({} as any, 'user-1');
  const resolve = (state: any) => (service as any).resolveIncompleteReason(state);

  it('returns nothing for finished runs', () => {
    expect(resolve(undefined)).toBeUndefined();
    expect(resolve({ status: 'done' })).toBeUndefined();
    expect(resolve({ status: 'error' })).toBeUndefined();
  });

  it('keeps the client tool interruption reason', () => {
    expect(resolve({ status: 'interrupted', interruption: { reason: 'client_tool_execution' } })).toBe(
      'client_tool_execution',
    );
    expect(resolve({ status: 'interrupted' })).toBe('interrupted');
  });

  it('reports a human approval stop instead of a completed empty answer', () => {
    expect(resolve({ status: 'waiting_for_human' })).toBe('human_approval_required');
  });
});
