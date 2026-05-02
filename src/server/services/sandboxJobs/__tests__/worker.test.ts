// @vitest-environment node
import { and, eq, inArray } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { SandboxJobModel } from '@/database/server/models/sandboxJob';
import type { NewSandboxJob } from '@/database/schemas';
import { sandboxJobs, topics, users } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';

import { getSandboxJobWorker, SandboxJobWorker } from '../worker';

const serverDB: LobeChatDatabase = await getTestDB();

const userId = 'sandbox-worker-test-user-id';
const otherUserId = 'sandbox-worker-test-other-user-id';
const topicId = 'sandbox-worker-test-topic-id';

let jobSeq = 0;

const cleanup = async () => {
  await serverDB.delete(sandboxJobs).where(inArray(sandboxJobs.userId, [userId, otherUserId]));
  await serverDB.delete(topics).where(inArray(topics.userId, [userId, otherUserId]));
  await serverDB.delete(users).where(inArray(users.id, [userId, otherUserId]));
};

const sleep = async (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (assertion: () => Promise<void> | void, timeoutMs: number = 5_000) => {
  const startedAt = Date.now();
  let lastError: unknown;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await sleep(25);
    }
  }

  throw lastError;
};

const jsonResponse = (body: unknown, status: number = 200) =>
  new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    status,
  });

const mockGatewaySuccess = (text: string = 'done') => {
  const fetchMock = vi.fn().mockResolvedValue(
    jsonResponse({
      jsonrpc: '2.0',
      result: {
        content: [{ text }],
        session_id: 'sandbox-session-test',
      },
    }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

const mockAbortableGateway = () => {
  const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
    const signal = init?.signal as AbortSignal | undefined;

    return new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener('abort', () => {
        reject(new DOMException('Aborted', 'AbortError'));
      });
    });
  });

  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

const findJob = async (id: string) => {
  const [job] = await serverDB.select().from(sandboxJobs).where(eq(sandboxJobs.id, id)).limit(1);
  return job;
};

const createJob = async (overrides: Partial<NewSandboxJob> = {}) => {
  jobSeq += 1;
  const id = overrides.id ?? `sbj_worker_test_${jobSeq}`;

  const [job] = await serverDB
    .insert(sandboxJobs)
    .values({
      apiName: 'runCommand',
      args: { command: `echo ${jobSeq}` },
      id,
      identifier: 'lobe-cloud-sandbox',
      parentMessageId: `msg_worker_parent_${jobSeq}`,
      toolCallId: `tool_call_worker_${jobSeq}`,
      topicId,
      userId,
      ...overrides,
    })
    .returning();

  return job;
};

beforeEach(async () => {
  jobSeq = 0;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await getSandboxJobWorker()?.stop();
  await cleanup();
  await serverDB.insert(users).values([{ id: userId }, { id: otherUserId }]);
  await serverDB.insert(topics).values({
    id: topicId,
    title: 'Sandbox Worker Test Topic',
    userId,
  });
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await getSandboxJobWorker()?.stop();
  await cleanup();
});

describe('SandboxJobWorker', () => {
  it('tickLoop picks queued jobs and processes them sequentially', async () => {
    await createJob({ toolCallId: 'tool_call_tick_loop_1' });
    await createJob({ toolCallId: 'tool_call_tick_loop_2' });

    let activeCalls = 0;
    let maxActiveCalls = 0;
    const fetchMock = vi.fn(async () => {
      activeCalls += 1;
      maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
      await sleep(30);
      activeCalls -= 1;

      return jsonResponse({ result: { content: [{ text: 'ok' }] } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const worker = new SandboxJobWorker(serverDB, 1);

    try {
      await worker.start();

      await waitFor(async () => {
        const rows = await serverDB
          .select()
          .from(sandboxJobs)
          .where(and(eq(sandboxJobs.userId, userId), eq(sandboxJobs.state, 'success')));
        expect(rows).toHaveLength(2);
      }, 6_000);
    } finally {
      await worker.stop();
    }

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(maxActiveCalls).toBe(1);
  });

  it('SandboxJobWorker.ensureRunning is singleton and does not double-process jobs', async () => {
    await createJob({ toolCallId: 'tool_call_singleton' });
    const fetchMock = mockGatewaySuccess('singleton-ok');

    const first = await SandboxJobWorker.ensureRunning(serverDB);
    const second = await SandboxJobWorker.ensureRunning(serverDB);

    expect(second).toBe(first);

    await waitFor(async () => {
      const rows = await serverDB
        .select()
        .from(sandboxJobs)
        .where(and(eq(sandboxJobs.userId, userId), eq(sandboxJobs.state, 'success')));
      expect(rows).toHaveLength(1);
    });

    await first.stop();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('claim race lets two parallel pickAndExecute calls claim different jobs or return null safely', async () => {
    await createJob({ toolCallId: 'tool_call_race_1' });
    await createJob({ toolCallId: 'tool_call_race_2' });
    mockGatewaySuccess('race-ok');

    const worker = new SandboxJobWorker(serverDB, 2);
    const [first, second] = await Promise.all([worker.pickAndExecute(), worker.pickAndExecute()]);

    const claimedIds = [first?.id, second?.id].filter(Boolean);
    expect(claimedIds.length).toBeGreaterThanOrEqual(1);
    expect(new Set(claimedIds).size).toBe(claimedIds.length);

    const rows = await serverDB
      .select()
      .from(sandboxJobs)
      .where(and(eq(sandboxJobs.userId, userId), eq(sandboxJobs.state, 'success')));
    expect(rows.length).toBe(claimedIds.length);
  });

  it('heartbeat keeps the lock alive during long execution', async () => {
    vi.useFakeTimers();
    const job = await createJob({ toolCallId: 'tool_call_heartbeat_long' });
    const model = new SandboxJobModel(serverDB, userId);
    const claimed = await model.claimNext('worker-heartbeat-long', 60);
    expect(claimed?.id).toBe(job.id);

    let resolveGateway: (response: Response) => void = () => {};
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveGateway = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const heartbeatSpy = vi.spyOn(SandboxJobModel.prototype, 'heartbeat');
    const worker = new SandboxJobWorker(serverDB, 1);
    const execution = worker.executeJob(claimed!);

    await vi.advanceTimersByTimeAsync(15_000);

    expect(heartbeatSpy).toHaveBeenCalled();
    const afterHeartbeat = await findJob(job.id);
    expect(afterHeartbeat?.lastHeartbeatAt).toBeInstanceOf(Date);
    expect(afterHeartbeat?.lockedUntil).toBeInstanceOf(Date);

    resolveGateway(jsonResponse({ result: { content: [{ text: 'long-ok' }] } }));
    await execution;

    const finished = await findJob(job.id);
    expect(finished?.state).toBe('success');
  });

  it('heartbeat lost aborts execution and leaves the job running until recovery', async () => {
    vi.useFakeTimers();
    const job = await createJob({ toolCallId: 'tool_call_heartbeat_lost' });
    const model = new SandboxJobModel(serverDB, userId);
    const claimed = await model.claimNext('worker-heartbeat-lost', 60);
    expect(claimed?.id).toBe(job.id);

    mockAbortableGateway();
    vi.spyOn(SandboxJobModel.prototype, 'heartbeat').mockResolvedValue(false);

    const worker = new SandboxJobWorker(serverDB, 1);
    const execution = worker.executeJob(claimed!);

    await vi.advanceTimersByTimeAsync(15_000);
    await execution;

    const found = await findJob(job.id);
    expect(found?.state).toBe('running');
    expect(found?.completedAt).toBeNull();
  });

  it('recoverStaleJobs requeues stuck jobs', async () => {
    const stale = await createJob({
      lockedUntil: new Date('2026-01-01T10:00:00Z'),
      state: 'running',
      toolCallId: 'tool_call_stale_worker',
      workerId: 'stale-worker',
    });

    const worker = new SandboxJobWorker(serverDB, 1);
    const recoveredCount = await worker.recoverStaleJobsAcrossUsers();

    const found = await findJob(stale.id);
    expect(recoveredCount).toBe(1);
    expect(found?.state).toBe('queued');
    expect(found?.workerId).toBeNull();
  });

  it('executeJob success parses gateway response and marks success with payload', async () => {
    const job = await createJob({ toolCallId: 'tool_call_success_payload' });
    const model = new SandboxJobModel(serverDB, userId);
    const claimed = await model.claimNext('worker-success-payload', 60);
    expect(claimed?.id).toBe(job.id);

    mockGatewaySuccess('hello from gateway');

    const worker = new SandboxJobWorker(serverDB, 1);
    await worker.executeJob(claimed!);

    const found = await findJob(job.id);
    expect(found?.state).toBe('success');
    expect(found?.sandboxSessionId).toBe('sandbox-session-test');
    expect(found?.resultPayload).toEqual(
      expect.objectContaining({
        content: 'hello from gateway',
        result: { output: 'hello from gateway', success: true },
      }),
    );
  });

  it('executeJob error marks gateway 500 as error payload', async () => {
    const job = await createJob({ toolCallId: 'tool_call_gateway_500' });
    const model = new SandboxJobModel(serverDB, userId);
    const claimed = await model.claimNext('worker-gateway-500', 60);
    expect(claimed?.id).toBe(job.id);

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(
          {
            error: { message: 'gateway exploded' },
          },
          500,
        ),
      ),
    );

    const worker = new SandboxJobWorker(serverDB, 1);
    await worker.executeJob(claimed!);

    const found = await findJob(job.id);
    expect(found?.state).toBe('error');
    expect(found?.errorPayload).toEqual(
      expect.objectContaining({
        message: 'E2B gateway returned 500',
        type: 'gateway_http_error',
      }),
    );
  });

  it('executeJob timeout marks error with timeout type', async () => {
    vi.useFakeTimers();
    const job = await createJob({ toolCallId: 'tool_call_timeout' });
    const model = new SandboxJobModel(serverDB, userId);
    const claimed = await model.claimNext('worker-timeout', 60);
    expect(claimed?.id).toBe(job.id);

    mockAbortableGateway();

    const worker = new SandboxJobWorker(serverDB, 1);
    const execution = worker.executeJob(claimed!);

    await vi.advanceTimersByTimeAsync(120_000);
    await execution;

    const found = await findJob(job.id);
    expect(found?.state).toBe('error');
    expect(found?.errorPayload).toEqual(
      expect.objectContaining({
        type: 'timeout',
      }),
    );
  });

  it('stop aborts in-flight execution and waits for graceful shutdown', async () => {
    const job = await createJob({ toolCallId: 'tool_call_stop' });
    mockAbortableGateway();

    const worker = new SandboxJobWorker(serverDB, 1);

    await worker.start();

    await waitFor(async () => {
      const found = await findJob(job.id);
      expect(found?.state).toBe('running');
    });

    await expect(worker.stop()).resolves.not.toThrow();
    expect(worker.isRunning).toBe(false);

    const found = await findJob(job.id);
    expect(found?.state).toBe('running');
  });

  it('create remains idempotent on toolCallId for enqueue callers', async () => {
    const model = new SandboxJobModel(serverDB, userId);

    const first = await model.create({
      apiName: 'runCommand',
      args: { command: 'echo first' },
      identifier: 'lobe-cloud-sandbox',
      parentMessageId: 'msg_enqueue_idempotent',
      toolCallId: 'tool_call_enqueue_idempotent',
      topicId,
    });

    const second = await model.create({
      apiName: 'runCommand',
      args: { command: 'echo second' },
      identifier: 'lobe-cloud-sandbox',
      parentMessageId: 'msg_enqueue_idempotent',
      toolCallId: 'tool_call_enqueue_idempotent',
      topicId,
    });

    expect(second.id).toBe(first.id);

    const rows = await serverDB
      .select()
      .from(sandboxJobs)
      .where(eq(sandboxJobs.toolCallId, 'tool_call_enqueue_idempotent'));
    expect(rows).toHaveLength(1);
    expect(rows[0].args).toEqual({ command: 'echo first' });
  });
});
