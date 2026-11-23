import { AgentRuntime } from '@lobechat/agent-runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { inMemoryAgentStateManager } from '@/server/modules/AgentRuntime/InMemoryAgentStateManager';
import { AgentRuntimeService } from '@/server/services/agentRuntime';
import { createAbortError } from '@/server/services/agentRuntime/abort';
import {
  clearLocalOperationAbortControllersForTests,
  hasLocalOperationAbortController,
} from '@/server/services/agentRuntime/operationInterruption';

import { consumeStreamUntilDone } from '../../../../model-runtime/src/utils/consumeStream';
import { resetEngineSlotActivityForTests } from '../engineSlotActivity';
import { ResponsesService } from '../responses.service';
import { responsesStreamHub } from '../responsesStreamHub';

const { mockExecAgent } = vi.hoisted(() => ({
  mockExecAgent: vi.fn(),
}));

vi.mock('@/server/modules/AgentRuntime/factory', async () => {
  const { inMemoryAgentStateManager: stateManager } =
    await import('@/server/modules/AgentRuntime/InMemoryAgentStateManager');
  const { inMemoryStreamEventManager: streamEventManager } =
    await import('@/server/modules/AgentRuntime/InMemoryStreamEventManager');
  return {
    createAgentStateManager: () => stateManager,
    createStreamEventManager: () => streamEventManager,
    isRedisAvailable: () => false,
  };
});
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

const OP_ID = 'op_1795428873158_agt_1_tpc_abort_e2e_npIsai7B';
const TOPIC_ID = 'tpc_abort_e2e';
const USER_ID = 'user_856';

const drain = async <T>(gen: AsyncGenerator<T>): Promise<T[]> => {
  const out: T[] = [];
  for await (const item of gen) out.push(item);
  return out;
};

describe('ResponsesService Stop/Abort end-to-end (real AgentRuntimeService + consumeStreamUntilDone)', () => {
  beforeEach(() => {
    responsesStreamHub.clear();
    inMemoryAgentStateManager.clear();
    resetEngineSlotActivityForTests();
    clearLocalOperationAbortControllersForTests();
    mockExecAgent.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    responsesStreamHub.clear();
    inMemoryAgentStateManager.clear();
    resetEngineSlotActivityForTests();
    clearLocalOperationAbortControllersForTests();
  });

  it('aborts a hung in-flight LLM stream immediately on cancelResponse, emits incomplete (no 500), unblocks 409, and cleans up AbortController', async () => {
    let streamStarted!: () => void;
    const llmStreamEntered = new Promise<void>((resolve) => {
      streamStarted = resolve;
    });
    let llmSignalAborted = false;
    let streamCancelledByAbort = false;

    mockExecAgent.mockImplementation(async () => {
      await inMemoryAgentStateManager.createOperationMetadata(OP_ID, { userId: USER_ID });
      await inMemoryAgentStateManager.saveAgentState(
        OP_ID,
        AgentRuntime.createInitialState({
          messages: [{ content: 'Изучи доставку озон', role: 'user' }],
          metadata: { agentId: 'agt_1', topicId: TOPIC_ID, userId: USER_ID },
          operationId: OP_ID,
          status: 'running',
          stepCount: 0,
        }),
      );
      return { operationId: OP_ID, success: true, topicId: TOPIC_ID };
    });

    vi.spyOn(AgentRuntimeService.prototype as any, 'createAgentRuntime').mockImplementation(
      async ({ signal }: any) => ({
        runtime: new AgentRuntime(
          {
            runner: async () => ({ payload: {}, type: 'call_llm' }),
          } as any,
          {
            executors: {
              call_llm: async (_instruction, state) => {
                await responsesStreamHub.publishStreamChunk(OP_ID, 0, {
                  chunkType: 'text',
                  content: 'Ответ полностью достримился.',
                });

                // Simulate a hung SSE stream (e.g. billing_proxy holding stream open after last chunk)
                const hungBody = new ReadableStream<Uint8Array>({
                  cancel() {
                    streamCancelledByAbort = true;
                  },
                  start() {
                    streamStarted();
                  },
                });
                signal?.addEventListener(
                  'abort',
                  () => {
                    llmSignalAborted = true;
                  },
                  { once: true },
                );

                try {
                  await consumeStreamUntilDone(new Response(hungBody), signal);
                } catch (err) {
                  if (signal?.aborted) {
                    const nextState = structuredClone(state);
                    nextState.status = 'interrupted';
                    nextState.interruption = {
                      canResume: false,
                      interruptedAt: new Date().toISOString(),
                      reason: 'user_cancelled',
                    };
                    nextState.messages.push({
                      content: 'Ответ полностью достримился.',
                      role: 'assistant',
                    });
                    return { events: [], newState: nextState };
                  }
                  throw err;
                }
                return { events: [], newState: state };
              },
            },
          },
        ),
      }),
    );

    const service = new ResponsesService({} as any, USER_ID);
    const streamPromise = drain(
      service.createStreamingResponse({
        input: 'Изучи доставку озон',
        model: 'agt_1',
        stream: true,
      } as any),
    );

    await llmStreamEntered;

    // While hung: status is in_progress, AbortController registered, new message blocked with 409
    expect(hasLocalOperationAbortController(OP_ID)).toBe(true);
    expect(service.getResponseStatus(TOPIC_ID)).toMatchObject({ status: 'in_progress' });
    expect(() =>
      service.assertPreviousTopicIdle({
        input: 'Так зачастую же часов в 18 еще довозят',
        model: 'agt_1',
        previous_response_id: TOPIC_ID,
      } as any),
    ).toThrowError(/already in progress/);

    // User clicks Stop
    const cancelResult = await service.cancelResponse(TOPIC_ID);
    expect(cancelResult).toEqual({ cancelled: 1, id: TOPIC_ID });

    // Immediately unblocked — no 409 and no in_progress
    expect(llmSignalAborted).toBe(true);
    expect(service.getResponseStatus(TOPIC_ID)).toMatchObject({ status: 'incomplete' });
    expect(service.listRunningTopics()).toEqual([]);
    expect(() =>
      service.assertPreviousTopicIdle({
        input: 'Так зачастую же часов в 18 еще довозят',
        model: 'agt_1',
        previous_response_id: TOPIC_ID,
      } as any),
    ).not.toThrow();

    // Stream settles cleanly as response.incomplete (NOT failed / 500)
    const events = await streamPromise;
    expect(streamCancelledByAbort).toBe(true);
    const terminal = events.at(-1) as any;
    expect(terminal.type).toBe('response.incomplete');
    expect(terminal.response.status).toBe('incomplete');
    expect(terminal.response.incomplete_details).toEqual({ reason: 'user_cancelled' });
    expect(terminal.response.output_text).toBe('Ответ полностью достримился.');
    expect(terminal.response.error).toBeNull();

    // AbortController registry cleaned up (zero memory leaks)
    await vi.waitFor(() => expect(hasLocalOperationAbortController(OP_ID)).toBe(false));
    expect(responsesStreamHub.get(OP_ID)?.done).toBe(true);
  });

  it('does not swallow an unrelated upstream AbortError as user_cancelled when cancel was not requested', async () => {
    mockExecAgent.mockResolvedValueOnce({
      operationId: OP_ID,
      success: true,
      topicId: TOPIC_ID,
    });

    vi.spyOn(AgentRuntimeService.prototype, 'executeSync').mockRejectedValueOnce(
      createAbortError('Upstream request timed out'),
    );

    const service = new ResponsesService({} as any, USER_ID);
    const logSpy = vi.spyOn(service as any, 'log');

    const events = await drain(
      service.createStreamingResponse({
        input: 'Тест стороннего AbortError',
        model: 'agt_1',
        stream: true,
      } as any),
    );

    const terminal = events.at(-1) as any;
    expect(terminal.type).toBe('response.completed');
    expect(terminal.response.status).toBe('failed');
    expect(terminal.response.incomplete_details).toBeNull();
    expect(responsesStreamHub.get(OP_ID)?.finalState?.status).toBe('error');
    expect(logSpy).toHaveBeenCalledWith(
      'error',
      'Streaming execution failed',
      expect.objectContaining({
        error: expect.objectContaining({
          message: 'Upstream request timed out',
          name: 'AbortError',
        }),
      }),
    );
  });
});
