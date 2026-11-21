import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildExecOverrides, ResponsesService } from '../responses.service';
import { responsesStreamHub } from '../responsesStreamHub';

const { mockExecAgent, mockExecuteSync } = vi.hoisted(() => ({
  mockExecAgent: vi.fn(),
  mockExecuteSync: vi.fn(),
}));

vi.mock('@/server/modules/AgentRuntime/StreamEventManager', () => ({}));
vi.mock('@/server/services/agentRuntime', () => ({
  AgentRuntimeService: class {
    executeSync = mockExecuteSync;
  },
}));
vi.mock('@/server/services/aiAgent', () => ({
  AiAgentService: class {
    execAgent = mockExecAgent;
  },
}));
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

describe('ResponsesService — headless auto-run & empty securityBlacklist guard', () => {
  beforeEach(() => {
    responsesStreamHub.clear();
    mockExecAgent.mockReset();
    mockExecuteSync.mockReset();
    mockExecAgent.mockResolvedValue({
      operationId: 'op_1_agt_1_tpc_1_auto',
      success: true,
      topicId: 'tpc_1',
    });
    mockExecuteSync.mockResolvedValue({
      messages: [{ content: 'Готово', role: 'assistant' }],
      status: 'done',
      usage: { llm: { tokens: { input: 4, output: 2, total: 6 } } },
    });
  });

  it('passes approvalMode: auto-run and securityBlacklist: [] in createResponse without altering buildExecOverrides', async () => {
    const request = { input: 'проверь файл .env', model: 'agt_1' } as any;
    expect(buildExecOverrides(request)).toEqual({});

    const service = new ResponsesService({} as any, 'u1');
    const response = await service.createResponse(request);

    expect(response.status).toBe('completed');
    expect(mockExecAgent).toHaveBeenCalledOnce();
    expect(mockExecAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agt_1',
        prompt: 'проверь файл .env',
        securityBlacklist: [],
        stream: false,
        userInterventionConfig: { approvalMode: 'auto-run' },
      }),
    );
  });

  it('passes approvalMode: auto-run and securityBlacklist: [] in createStreamingResponse', async () => {
    const request = { input: 'проверь скрипт', model: 'agt_1', stream: true } as any;
    const service = new ResponsesService({} as any, 'u1');

    const events: any[] = [];
    for await (const event of service.createStreamingResponse(request)) {
      events.push(event);
    }

    expect(events.at(-1)?.type).toBe('response.completed');
    expect(mockExecAgent).toHaveBeenCalledOnce();
    expect(mockExecAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agt_1',
        prompt: 'проверь скрипт',
        securityBlacklist: [],
        stream: true,
        userInterventionConfig: { approvalMode: 'auto-run' },
      }),
    );
  });

  it('strips internal __arckep_unresolved_tool__ function_call and function_call_output from response.output', async () => {
    mockExecuteSync.mockResolvedValueOnce({
      messages: [
        { content: 'привет', role: 'user' },
        {
          content: '',
          role: 'assistant',
          tool_calls: [
            {
              function: { arguments: '{}', name: '__arckep_unresolved_tool______bad_tool' },
              id: 'call_syn_1',
              type: 'function',
            },
            {
              function: { arguments: '{"q":"test"}', name: 'lobe-web-browsing____search' },
              id: 'call_real_1',
              type: 'function',
            },
          ],
        },
        {
          content: '{"error":"Tool not active","success":false,"synthetic":true}',
          role: 'tool',
          tool_call_id: 'call_syn_1',
        },
        {
          content: '{"results":[]}',
          role: 'tool',
          tool_call_id: 'call_real_1',
        },
        { content: 'Итоговый ответ', role: 'assistant' },
      ],
      status: 'done',
      usage: { llm: { tokens: { input: 10, output: 5, total: 15 } } },
    });

    const service = new ResponsesService({} as any, 'u1');
    const response = await service.createResponse({ input: 'привет', model: 'agt_1' } as any);

    expect(response.output_text).toBe('Итоговый ответ');
    expect(JSON.stringify(response.output)).not.toContain('__arckep_unresolved_tool__');
    expect(JSON.stringify(response.output)).not.toContain('call_syn_1');
    expect(response.output.map((item: any) => item.type)).toEqual([
      'function_call',
      'function_call_output',
      'message',
    ]);
  });
});
