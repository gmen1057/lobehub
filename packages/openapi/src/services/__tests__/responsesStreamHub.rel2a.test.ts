import { EventEmitter } from 'node:events';

import { LOADING_FLAT } from '@lobechat/const';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentStateManager } from '@/server/modules/AgentRuntime/AgentStateManager';
import { InMemoryAgentStateManager } from '@/server/modules/AgentRuntime/InMemoryAgentStateManager';
import { InMemoryStreamEventManager } from '@/server/modules/AgentRuntime/InMemoryStreamEventManager';
import { AgentRuntimeService } from '@/server/services/agentRuntime/AgentRuntimeService';
import {
  extractStreamedPartialFromEvents,
  isStaleOrphanLoadingCandidate,
  ORPHAN_PLACEHOLDER_ERROR,
  SERVER_SHUTDOWN_PLACEHOLDER_ERROR,
} from '@/server/services/agentRuntime/orphanPlaceholders';
import {
  isEngineSlotDraining,
  resetEngineSlotStateForTests,
} from '@/server/services/sandboxJobs/slotState';

import { ResponsesService } from '../responses.service';
import {
  registerResponsesStreamHubSigtermHandler,
  ResponsesStreamHub,
  responsesStreamHub,
} from '../responsesStreamHub';

const params = { input: 'привет', model: 'agt_1' } as any;

describe('REL-2A: ResponsesStreamHub SIGTERM drain & Blue-Green safe orphan LOADING_FLAT cleanup', () => {
  beforeEach(() => {
    resetEngineSlotStateForTests();
  });

  it('gracefulShutdown(SIGTERM) interrupts active operations, preserves partial responses, and closes subscribers without HTTP drop', async () => {
    const hub = new ResponsesStreamHub();
    const dbRow = {
      content: LOADING_FLAT,
      error: null as any,
      id: 'msg_partial',
      role: 'assistant',
    };

    let interruptCalled = false;
    hub.register({
      onShutdownFinalize: async () => {
        // Paid partial content was saved by preservePartialResponse — never overwrite with empty error
        expect(dbRow.content).toBe('Часть оплаченного ответа');
        return undefined;
      },
      onShutdownInterrupt: async () => {
        interruptCalled = true;
        // Simulate RuntimeExecutors preservePartialResponse completing during grace window
        dbRow.content = 'Часть оплаченного ответа';
        setTimeout(() => {
          hub.markDone('op_partial', {
            interruption: {
              canResume: false,
              interruptedAt: new Date().toISOString(),
              reason: 'user_cancelled',
            },
            messages: [{ content: 'Часть оплаченного ответа', role: 'assistant' }],
            status: 'interrupted',
          } as any);
        }, 15);
      },
      operationId: 'op_partial',
      params,
      responseId: 'tpc_partial',
      topicId: 'tpc_partial',
      userId: 'u1',
    });

    await hub.publishStreamChunk('op_partial', 0, {
      chunkType: 'text',
      content: 'Часть оплаченного ответа',
    });

    let subscriberClosedCleanly = false;
    hub.attach('op_partial', {
      onDone: () => {
        subscriberClosedCleanly = true;
      },
      onEvents: () => undefined,
    });

    const summary = await hub.gracefulShutdown('SIGTERM', { graceWindowMs: 500 });
    expect(isEngineSlotDraining()).toBe(true);
    expect(interruptCalled).toBe(true);
    expect(subscriberClosedCleanly).toBe(true);
    expect(summary).toEqual({ finalized: 1, forced: 0, interrupted: 1 });
    expect(dbRow.content).toBe('Часть оплаченного ответа');
    expect(dbRow.error).toBeNull();
    expect(hub.get('op_partial')?.finalState?.status).toBe('interrupted');
  });

  it('gracefulShutdown(SIGTERM) marks empty LOADING_FLAT rows with explicit server_shutdown error and force-closes hung operations', async () => {
    const hub = new ResponsesStreamHub();
    const dbRow = {
      content: LOADING_FLAT,
      error: null as any,
      id: 'msg_empty',
      role: 'assistant',
    };

    hub.register({
      onShutdownFinalize: async () => {
        if (dbRow.content === LOADING_FLAT) {
          dbRow.content = '';
          dbRow.error = SERVER_SHUTDOWN_PLACEHOLDER_ERROR;
        }
        return {
          error: SERVER_SHUTDOWN_PLACEHOLDER_ERROR,
          messages: [],
          status: 'error',
        } as any;
      },
      onShutdownInterrupt: async () => {
        // Simulate hung upstream where executeSync does NOT finish within graceWindowMs
      },
      operationId: 'op_hung_empty',
      params,
      responseId: 'tpc_empty',
      topicId: 'tpc_empty',
      userId: 'u1',
    });

    let subscriberClosed = false;
    hub.attach('op_hung_empty', {
      onDone: () => {
        subscriberClosed = true;
      },
      onEvents: () => undefined,
    });

    const summary = await hub.gracefulShutdown('SIGTERM', { graceWindowMs: 30 });
    expect(subscriberClosed).toBe(true);
    expect(summary).toEqual({ finalized: 1, forced: 1, interrupted: 1 });
    expect(dbRow.content).toBe('');
    expect(dbRow.error).toEqual(SERVER_SHUTDOWN_PLACEHOLDER_ERROR);
    expect(hub.get('op_hung_empty')?.finalState).toMatchObject({
      error: SERVER_SHUTDOWN_PLACEHOLDER_ERROR,
      status: 'error',
    });
  });

  it('registerResponsesStreamHubSigtermHandler prevents duplicate registration and awaits gracefulShutdown before Next.js cleanup', async () => {
    const hub = new ResponsesStreamHub();
    const emitter = new EventEmitter();
    const order: string[] = [];

    function cleanup(signal: string) {
      order.push(`next-cleanup:${signal}`);
    }
    emitter.on('SIGTERM', cleanup);

    hub.register({
      onShutdownFinalize: async () => {
        await new Promise((r) => setTimeout(r, 20));
        order.push('hub-finalized');
        return undefined;
      },
      onShutdownInterrupt: async () => {
        order.push('hub-interrupted');
        hub.markDone('op_sigterm', { status: 'interrupted' } as any);
      },
      operationId: 'op_sigterm',
      params,
      responseId: 'tpc_sig',
      topicId: 'tpc_sig',
      userId: 'u1',
    });

    const unregister = registerResponsesStreamHubSigtermHandler(hub, emitter);
    expect(emitter.listenerCount('SIGTERM')).toBe(1);

    emitter.emit('SIGTERM');
    await vi.waitFor(() => expect(order).toContain('next-cleanup:SIGTERM'));
    expect(order).toEqual(['hub-interrupted', 'hub-finalized', 'next-cleanup:SIGTERM']);

    unregister();
  });

  it('Blue-Green multi-slot safety: Slot B NEVER reaps a >2m LOADING_FLAT row while Slot A holds a live heartbeat (including #39 compress_context)', async () => {
    const sharedCoordinatorState = new InMemoryAgentStateManager();
    const streamEvents = new InMemoryStreamEventManager();

    const nowMs = Date.now();
    const threeMinutesAgo = new Date(nowMs - 3 * 60 * 1000);

    const mockRows = [
      {
        content: LOADING_FLAT,
        createdAt: threeMinutesAgo,
        error: null as any,
        id: 'msg_live_slot_a',
        metadata: null,
        reasoning: null,
        role: 'assistant',
        topicId: 'tpc_bg_race',
        tools: null,
        updatedAt: threeMinutesAgo,
        userId: 'u1',
      },
    ];

    const updateSpy = vi.fn();
    const fakeDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: async () => mockRows,
          }),
        }),
      }),
      update: () => ({
        set: (patch: any) => ({
          where: () => ({
            returning: async () => {
              updateSpy(patch);
              mockRows[0].content = patch.content;
              mockRows[0].error = patch.error;
              return [{ id: mockRows[0].id }];
            },
          }),
        }),
      }),
    } as any;

    // Slot A (:3404) created operation 3 minutes ago (e.g., long #39 rolling compression or tool call)
    // and keeps refreshing its heartbeat in shared Redis/stateManager:
    const slotAService = new AgentRuntimeService(fakeDb, 'u1', {
      coordinatorOptions: {
        stateManager: sharedCoordinatorState,
        streamEventManager: streamEvents,
      },
      queueService: null,
    });
    const opId = `op_${nowMs - 180_000}_agt1_tpc_bg_race_slotA001`;
    await slotAService.createOperation({
      agentConfig: { model: 'deepseek-flash', provider: 'deepseek' },
      appContext: { agentId: 'agt1', topicId: 'tpc_bg_race' },
      autoStart: false,
      initialContext: {
        payload: {
          assistantMessageId: 'msg_live_slot_a',
          isFirstMessage: true,
          message: [{ content: 'Summarize huge history' }],
          parentMessageId: 'u_msg_1',
        },
        phase: 'user_input',
        session: { messageCount: 1, sessionId: opId, status: 'running', stepCount: 0 },
      },
      modelRuntimeConfig: { model: 'deepseek-flash', provider: 'deepseek' },
      operationId: opId,
      toolSet: { manifestMap: {}, sourceMap: {}, tools: [] },
      userId: 'u1',
    });
    // Refresh heartbeat as Slot A's 25s interval does
    await sharedCoordinatorState.touchOperationHeartbeat(opId, 90);

    // Slot B (:3405) has an EMPTY local ResponsesStreamHub, and receives GET /messages for tpc_bg_race!
    const slotBHub = new ResponsesStreamHub();
    expect(slotBHub.hasTopic('tpc_bg_race', { activeOnly: true })).toBe(false);

    const slotBService = new AgentRuntimeService(fakeDb, 'u1', {
      coordinatorOptions: {
        stateManager: sharedCoordinatorState,
        streamEventManager: streamEvents,
      },
      queueService: null,
    });

    const reapedWhileSlotAActive = await slotBService.reapOrphanTopicPlaceholders('tpc_bg_race', {
      isTopicActiveLocally: () => slotBHub.hasTopic('tpc_bg_race', { activeOnly: true }),
      nowMs,
    });

    // MUST NOT clobber Slot A's live turn!
    expect(reapedWhileSlotAActive).toEqual([]);
    expect(updateSpy).not.toHaveBeenCalled();
    expect(mockRows[0].content).toBe(LOADING_FLAT);
    expect(mockRows[0].error).toBeNull();

    // Now simulate Slot A dying via SIGKILL (its 90s heartbeat expires, while status stayed 'idle'/'running'):
    await sharedCoordinatorState.clearOperationHeartbeat(opId);
    const afterCrashNowMs = nowMs + 120_000;

    const reapedAfterCrash = await slotBService.reapOrphanTopicPlaceholders('tpc_bg_race', {
      isTopicActiveLocally: () => slotBHub.hasTopic('tpc_bg_race', { activeOnly: true }),
      nowMs: afterCrashNowMs,
    });

    expect(reapedAfterCrash).toEqual(['msg_live_slot_a']);
    expect(mockRows[0].content).toBe('');
    expect(mockRows[0].error).toEqual(ORPHAN_PLACEHOLDER_ERROR);
  });

  it('never reaps fresh (<2m) LOADING_FLAT rows or assistant rows that already hold tools, reasoning, or files', () => {
    const nowMs = 1_000_000;
    const oneMinuteAgo = new Date(nowMs - 60_000);
    const fiveMinutesAgo = new Date(nowMs - 5 * 60_000);

    expect(
      isStaleOrphanLoadingCandidate(
        { content: LOADING_FLAT, createdAt: oneMinuteAgo, id: 'm_fresh', role: 'assistant' },
        { nowMs },
      ),
    ).toBe(false);

    expect(
      isStaleOrphanLoadingCandidate(
        {
          content: LOADING_FLAT,
          createdAt: fiveMinutesAgo,
          id: 'm_with_tools',
          role: 'assistant',
          tools: [{ apiName: 'search', id: 'tc_1', identifier: 'web' }],
        },
        { nowMs },
      ),
    ).toBe(false);

    expect(
      isStaleOrphanLoadingCandidate(
        {
          content: LOADING_FLAT,
          createdAt: fiveMinutesAgo,
          id: 'm_with_reasoning',
          reasoning: { content: 'Thinking...' },
          role: 'assistant',
        },
        { nowMs },
      ),
    ).toBe(false);

    expect(
      isStaleOrphanLoadingCandidate(
        {
          content: LOADING_FLAT,
          createdAt: fiveMinutesAgo,
          files: [{ id: 'f_1' }],
          id: 'm_with_files',
          role: 'assistant',
        },
        { nowMs },
      ),
    ).toBe(false);

    expect(
      isStaleOrphanLoadingCandidate(
        { content: LOADING_FLAT, createdAt: fiveMinutesAgo, id: 'm_orphan', role: 'assistant' },
        { nowMs },
      ),
    ).toBe(true);
  });

  it('multi-step turn (step 0 call_llm -> step 1 call_tool -> step 2 empty call_llm) on SIGTERM: never duplicates step-0 text onto step-2 row and preserves usage, cost, and tool history', async () => {
    responsesStreamHub.clear();
    const nowSec = Math.floor(Date.now() / 1000);
    const dbAssistantRows = [
      {
        // Newest row first (ORDER BY createdAt DESC): step 2 empty placeholder
        content: '',
        createdAt: new Date((nowSec + 1) * 1000),
        error: null as any,
        id: 'msg_asst_step2',
        metadata: null,
        reasoning: null,
        role: 'assistant',
        topicId: 'tpc_multistep',
        tools: null,
        updatedAt: new Date((nowSec + 1) * 1000),
        userId: 'u1',
      },
      {
        // Step 0 assistant row with pre-tool text + tool call
        content: 'Сейчас проверю через инструмент...',
        createdAt: new Date(nowSec * 1000),
        error: null as any,
        id: 'msg_asst_step0',
        metadata: { totalTokens: 80 },
        reasoning: { content: 'Step 0 thinking' },
        role: 'assistant',
        topicId: 'tpc_multistep',
        tools: [{ apiName: 'search', arguments: '{"q":"test"}', id: 'call_1', identifier: 'web' }],
        updatedAt: new Date(nowSec * 1000),
        userId: 'u1',
      },
    ];

    const dbUpdates: Array<{ patch: any }> = [];
    const fakeDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: async () => dbAssistantRows,
            }),
          }),
        }),
      }),
      update: () => ({
        set: (patch: any) => ({
          where: async () => {
            dbUpdates.push({ patch });
            dbAssistantRows[0] = { ...dbAssistantRows[0], ...patch };
            return [];
          },
        }),
      }),
    } as any;

    const hubOp = responsesStreamHub.register({
      operationId: 'op_multistep_sigterm',
      params,
      responseId: 'tpc_multistep',
      topicId: 'tpc_multistep',
      userId: 'u1',
    });

    // Step 0: stream_start -> text -> tools_calling -> tool_end -> Step 2: step_start -> stream_start (no text yet!)
    await responsesStreamHub.publishStreamEvent('op_multistep_sigterm', {
      data: { assistantMessage: { id: 'msg_asst_step0' } },
      stepIndex: 0,
      type: 'stream_start',
    });
    await responsesStreamHub.publishStreamChunk('op_multistep_sigterm', 0, {
      chunkType: 'text',
      content: 'Сейчас проверю через инструмент...',
    });
    await responsesStreamHub.publishStreamChunk('op_multistep_sigterm', 0, {
      chunkType: 'tools_calling',
      toolsCalling: [
        { apiName: 'search', arguments: '{"q":"test"}', id: 'call_1', identifier: 'web' },
      ] as any,
    });
    await responsesStreamHub.publishStreamEvent('op_multistep_sigterm', {
      data: {
        isSuccess: true,
        payload: { toolCalling: { id: 'call_1' } },
        result: { content: 'Результат платного поиска' },
      },
      stepIndex: 1,
      type: 'tool_end',
    });
    await responsesStreamHub.publishStreamEvent('op_multistep_sigterm', {
      data: {},
      stepIndex: 2,
      type: 'step_start',
    });
    await responsesStreamHub.publishStreamEvent('op_multistep_sigterm', {
      data: { assistantMessage: { id: 'msg_asst_step2' } },
      stepIndex: 2,
      type: 'stream_start',
    });

    expect(extractStreamedPartialFromEvents(hubOp.events)).toEqual({
      assistantMessageId: 'msg_asst_step2',
      reasoning: '',
      text: '',
    });

    const completedState = {
      cost: { total: 0.042 },
      interruption: {
        canResume: false,
        interruptedAt: '2026-11-22T15:45:00.000Z',
        reason: 'user_cancelled',
      },
      messages: [
        { content: 'Вопрос', role: 'user' },
        {
          content: 'Сейчас проверю через инструмент...',
          role: 'assistant',
          tool_calls: [
            {
              function: { arguments: '{"q":"test"}', name: 'web____search' },
              id: 'call_1',
              type: 'function',
            },
          ],
        },
        { content: 'Результат платного поиска', role: 'tool', tool_call_id: 'call_1' },
        { content: '', role: 'assistant' },
      ],
      status: 'interrupted',
      usage: { llm: { apiCalls: 1, tokens: { input: 60, output: 20, total: 80 } } },
    } as any;

    const service = new ResponsesService(fakeDb, 'u1');
    const finalizedState = await (service as any).finalizeTopicTurnOnServerShutdown({
      completedState,
      createdAtSec: nowSec,
      hubOp,
      topicId: 'tpc_multistep',
    });

    // Step 2 DB row must NOT receive duplicated step-0 text and must NOT get a false 503 error
    expect(dbUpdates).toHaveLength(0);
    expect(dbAssistantRows[0].content).toBe('');
    expect(dbAssistantRows[0].error).toBeNull();
    expect(dbAssistantRows[1].content).toBe('Сейчас проверю через инструмент...');

    // Returned state preserves status='interrupted', accumulated usage/cost, and step 0 + step 1 messages!
    expect(finalizedState.status).toBe('interrupted');
    expect(finalizedState.usage).toEqual(completedState.usage);
    expect(finalizedState.cost).toEqual(completedState.cost);
    expect(finalizedState.messages).toHaveLength(3);
    expect(finalizedState.messages[1].content).toBe('Сейчас проверю через инструмент...');
    expect(finalizedState.messages[2]).toMatchObject({
      content: 'Результат платного поиска',
      role: 'tool',
    });
  });

  it('fails closed (preserves LOADING_FLAT) when Redis SCAN throws a transient error during Blue-Green orphan check', async () => {
    const brokenRedis = {
      scan: vi.fn().mockRejectedValue(new Error('Redis connection lost momentarily')),
    };
    const stateManager = Object.create(AgentStateManager.prototype) as AgentStateManager;
    (stateManager as any).redis = brokenRedis;
    (stateManager as any).STATE_PREFIX = 'agent_runtime_state';

    await expect(stateManager.getActiveOperationsForTopic('tpc_redis_flap')).rejects.toThrow(
      'Redis connection lost momentarily',
    );

    const updateSpy = vi.fn();
    const fakeDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: async () => [
              {
                content: LOADING_FLAT,
                createdAt: new Date(Date.now() - 5 * 60_000),
                error: null,
                id: 'msg_protected_on_redis_flap',
                role: 'assistant',
              },
            ],
          }),
        }),
      }),
      update: updateSpy,
    } as any;

    const service = new AgentRuntimeService(fakeDb, 'u1', {
      coordinatorOptions: {
        stateManager,
        streamEventManager: new InMemoryStreamEventManager(),
      },
      queueService: null,
    });

    expect(await service.hasLiveTopicOperation('tpc_redis_flap')).toBe(true);
    const reaped = await service.reapOrphanTopicPlaceholders('tpc_redis_flap');
    expect(reaped).toEqual([]);
    expect(updateSpy).not.toHaveBeenCalled();
  });
});
