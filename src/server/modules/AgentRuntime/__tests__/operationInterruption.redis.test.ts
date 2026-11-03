// @vitest-environment node
import { execFile, spawn } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { AgentRuntime, type AgentState } from '@lobechat/agent-runtime';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { watchOperationInterruption } from '@/server/services/agentRuntime/operationInterruption';

import { AgentRuntimeCoordinator } from '../AgentRuntimeCoordinator';
import { AgentStateManager } from '../AgentStateManager';
import { WRITE_AGENT_STATE } from '../agentStateWrite';
import { getAgentRuntimeRedisClient } from '../redis';
import { StreamEventManager } from '../StreamEventManager';

vi.mock('../redis', () => ({ getAgentRuntimeRedisClient: vi.fn() }));
vi.mock('@/envs/app', () => ({ appEnv: { enableQueueAgentRuntime: false } }));

const run = promisify(execFile);
let directory: string;
let socket: string;
let server: ReturnType<typeof spawn>;
let client: Redis;
let writer: Redis;

const state = (status: AgentState['status'] = 'running', stepCount = 0): AgentState =>
  AgentRuntime.createInitialState({
    operationId: 'test-operation',
    messages: [],
    metadata: { topicId: 'test-topic', userId: 'test-user' },
    status,
    stepCount,
  });

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'chat-stop-test-'));
  socket = path.join(directory, 'redis.sock');
  // Isolated process: no TCP, persistence, production Redis, or paid providers.
  server = spawn(
    'redis-server',
    ['--port', '0', '--unixsocket', socket, '--save', '', '--appendonly', 'no'],
    { stdio: 'ignore' },
  );
  await vi.waitFor(() => access(socket));
  client = new Redis({ lazyConnect: true, path: socket, retryStrategy: () => 10 });
  client.on('error', () => {});
  await client.connect();
  writer = client.duplicate();
  vi.mocked(getAgentRuntimeRedisClient).mockReturnValue(client);
}, 5000);

afterAll(async () => {
  client?.disconnect();
  writer?.disconnect();
  if (server && server.exitCode === null) {
    await new Promise<void>((resolve) => {
      server.once('exit', () => resolve());
      server.kill('SIGTERM');
    });
  }
  if (directory) await rm(directory, { force: true, recursive: true });
});

describe('operation cancellation through the shared Redis state and event bus', () => {
  it('aborts a waiting worker from another process without the UI end event', async () => {
    const id = 'cross-process-stop';
    const states = new AgentStateManager();
    await states.saveAgentState(id, state());
    const streams = new StreamEventManager();
    const watching = await watchOperationInterruption(
      id,
      states.loadAgentState.bind(states),
      streams,
    );
    try {
      await run('redis-cli', [
        '-s',
        socket,
        'EVAL',
        WRITE_AGENT_STATE,
        '5',
        `agent_runtime_state:${id}`,
        `agent_runtime_meta:${id}`,
        `agent_runtime_steps:${id}`,
        `agent_runtime_events:${id}`,
        `agent_runtime_stream:${id}`,
        'interrupt',
        '',
        '7200',
        new Date().toISOString(),
        '',
        '',
        '',
        id,
        String(Date.now()),
      ]);
      await vi.waitFor(() => expect(watching.signal.aborted).toBe(true));
      expect((await states.loadAgentState(id))?.status).toBe('interrupted');
    } finally {
      await watching.dispose();
    }
  });

  it('preserves a Stop arriving after the worker read but before saving late progress', async () => {
    const id = 'late-step-stop';
    const states = new AgentStateManager();
    await states.saveAgentState(id, state());
    const stale = (await states.loadAgentState(id))!;
    vi.mocked(getAgentRuntimeRedisClient).mockReturnValueOnce(writer);
    const otherProcess = new AgentStateManager();
    expect(await otherProcess.interruptAgentState(id)).toMatchObject({ status: 'interrupted' });
    stale.messages = [{ role: 'assistant', content: 'Received partial result' }] as any;
    stale.cost = { total: 0.25 } as any;
    stale.stepCount = 1;
    await states.saveStepResult(id, {
      executionTime: 15,
      newState: stale,
      stepIndex: 0,
      nextContext: { phase: 'llm_result', payload: { tools: [] } } as any,
    });
    expect(stale.status).toBe('interrupted');
    expect(await states.loadAgentState(id)).toMatchObject({
      cost: { total: 0.25 },
      messages: [{ content: 'Received partial result' }],
      status: 'interrupted',
      stepCount: 1,
    });
    expect(await states.getOperationMetadata(id)).toMatchObject({
      status: 'interrupted',
      totalCost: 0.25,
    });
    expect((await states.getExecutionHistory(id))[0]).toMatchObject({
      status: 'interrupted',
      context: { payload: { tools: [] } },
    });
    expect(await otherProcess.interruptAgentState(id)).toBeNull();
  });

  it('keeps a completed result when Stop loses the completion race', async () => {
    const states = new AgentStateManager();
    await states.saveAgentState('finished-first', state('done', 1));
    expect(await states.interruptAgentState('finished-first')).toBeNull();
    expect(await states.loadAgentState('finished-first')).toMatchObject({
      status: 'done',
      messages: [],
    });
  });

  it('still permits an explicit resume of a client-tool pause', async () => {
    const states = new AgentStateManager();
    const streams = new StreamEventManager();
    const paused = state('interrupted');
    paused.interruption = {
      canResume: true,
      interruptedAt: new Date().toISOString(),
      reason: 'client_tool_execution',
    };
    await states.saveAgentState('client-pause', paused);
    await streams.publishAgentRuntimeEnd('client-pause', 0, paused, 'interrupted');
    await states.saveAgentState('client-pause', state('running', 1));
    expect((await states.loadAgentState('client-pause'))?.status).toBe('running');
    let replayed!: () => void;
    const replay = new Promise<void>((resolve) => {
      replayed = resolve;
    });
    const subscribe = streams.subscribeStreamEvents.bind(streams);
    vi.spyOn(streams, 'subscribeStreamEvents').mockImplementation((id, last, onEvents, signal) =>
      subscribe(
        id,
        last,
        (events) => {
          onEvents(events);
          if (events.some((event) => event.type === 'agent_runtime_end')) replayed();
        },
        signal,
      ),
    );
    const watching = await watchOperationInterruption(
      'client-pause',
      states.loadAgentState.bind(states),
      streams,
    );
    try {
      await replay;
      expect(watching.signal.aborted).toBe(false);
      await states.interruptAgentState('client-pause');
      await vi.waitFor(() => expect(watching.signal.aborted).toBe(true));
    } finally {
      await watching.dispose();
    }
  });

  it('sees cancellation stored before subscribing and preserves empty arrays', async () => {
    const states = new AgentStateManager();
    const streams = new StreamEventManager();
    const id = 'already-stopped';
    await states.saveAgentState(id, state());
    await states.interruptAgentState(id);
    const watching = await watchOperationInterruption(
      id,
      states.loadAgentState.bind(states),
      streams,
    );
    try {
      expect(watching.signal.aborted).toBe(true);
      expect((await states.loadAgentState(id))?.messages).toEqual([]);
    } finally {
      await watching.dispose();
    }
  });

  it('accepts user Stop during a resumable pause and prevents a stale resume', async () => {
    const states = new AgentStateManager();
    const paused = state('interrupted');
    paused.interruption = {
      canResume: true,
      interruptedAt: new Date().toISOString(),
      reason: 'client_tool_execution',
    };
    await states.saveAgentState('stop-paused', paused);
    expect(await states.interruptAgentState('stop-paused')).toMatchObject({
      interruption: { canResume: false, reason: 'user_cancelled' },
    });
    await states.saveAgentState('stop-paused', state('running', 1));
    expect(await states.loadAgentState('stop-paused')).toMatchObject({
      status: 'interrupted',
      interruption: { canResume: false, reason: 'user_cancelled' },
    });
  });

  it('does not block state writes while a subscription waits for an event', async () => {
    const states = new AgentStateManager();
    const streams = new StreamEventManager();
    const id = 'independent-reader';
    await states.saveAgentState(id, state());
    const watching = await watchOperationInterruption(
      id,
      states.loadAgentState.bind(states),
      streams,
    );
    try {
      await states.saveAgentState(id, state('running', 2));
      expect((await states.loadAgentState(id))?.stepCount).toBe(2);
      expect(watching.signal.aborted).toBe(false);
    } finally {
      await watching.dispose();
    }
  });

  it('interrupts once through two coordinators sharing the same operation', async () => {
    const states = new AgentStateManager();
    const streams = new StreamEventManager();
    const a = new AgentRuntimeCoordinator({ stateManager: states, streamEventManager: streams });
    const b = new AgentRuntimeCoordinator({
      stateManager: new AgentStateManager(),
      streamEventManager: new StreamEventManager(),
    });
    await states.saveAgentState('two-stops', state());
    expect(
      await Promise.all([a.interruptOperation('two-stops'), b.interruptOperation('two-stops')]),
    ).toEqual([true, false]);
  });
});
