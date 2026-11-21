// @vitest-environment node
import { eq, inArray } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { sandboxJobs, topics, users } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';

import { getSandboxJobWorker, SandboxJobWorker } from '../worker';

const serverDB: LobeChatDatabase = await getTestDB();

const userId = 'sandbox-drain-test-user';
const topicId = 'sandbox-drain-test-topic';

const sleep = async (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (assertion: () => Promise<void> | void, timeoutMs = 5_000) => {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await sleep(20);
    }
  }
  throw lastError;
};

const cleanup = async () => {
  await serverDB.delete(sandboxJobs).where(inArray(sandboxJobs.userId, [userId]));
  await serverDB.delete(topics).where(inArray(topics.userId, [userId]));
  await serverDB.delete(users).where(inArray(users.id, [userId]));
};

let activeWorker: SandboxJobWorker | undefined;

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await activeWorker?.stop();
  activeWorker = undefined;
  await getSandboxJobWorker()?.stop();
  await cleanup();
  await serverDB.insert(users).values({ id: userId });
  await serverDB.insert(topics).values({
    id: topicId,
    title: 'Sandbox Drain Topic',
    userId,
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await activeWorker?.stop();
  activeWorker = undefined;
  await getSandboxJobWorker()?.stop();
  await cleanup();
});

describe('SandboxJobWorker.startDrain (zero-downtime)', () => {
  it('does NOT abort in-flight E2B job, lets it finish and persist result, and stops claiming queued jobs', async () => {
    const [job1] = await serverDB
      .insert(sandboxJobs)
      .values({
        apiName: 'executeCode',
        args: { code: 'print("job-1")' },
        id: 'sbj_drain_1',
        identifier: 'lobe-cloud-sandbox',
        parentMessageId: 'msg_parent_1',
        toolCallId: 'call_drain_1',
        topicId,
        userId,
      })
      .returning();

    const [job2] = await serverDB
      .insert(sandboxJobs)
      .values({
        apiName: 'executeCode',
        args: { code: 'print("job-2")' },
        id: 'sbj_drain_2',
        identifier: 'lobe-cloud-sandbox',
        parentMessageId: 'msg_parent_2',
        toolCallId: 'call_drain_2',
        topicId,
        userId,
      })
      .returning();

    let capturedSignal: AbortSignal | undefined;
    let resolveGateway!: (res: Response) => void;
    let signalAbortedDuringGateway = false;

    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      capturedSignal = init?.signal as AbortSignal | undefined;
      capturedSignal?.addEventListener('abort', () => {
        if (!resolveGatewayCalled) {
          signalAbortedDuringGateway = true;
        }
      });
      return new Promise<Response>((resolve) => {
        resolveGateway = resolve;
      });
    });
    let resolveGatewayCalled = false;
    vi.stubGlobal('fetch', fetchMock);

    const worker = new SandboxJobWorker(serverDB, 1);
    activeWorker = worker;
    await worker.start();

    // Wait until job1 is claimed and executing inside E2B gateway fetch
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(worker.getActiveJobsCount()).toBe(1);
    });

    // Enter drain mode while job1 is running in E2B
    await worker.startDrain();
    // Idempotent second call
    await worker.startDrain();

    expect(worker.isDraining()).toBe(true);
    expect(worker.isRunning).toBe(false);
    expect(capturedSignal?.aborted).toBe(false);
    expect(signalAbortedDuringGateway).toBe(false);
    expect(worker.getActiveJobsCount()).toBe(1);

    // Finish job1 from E2B gateway after drain started
    resolveGatewayCalled = true;
    resolveGateway(
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          result: {
            content: [{ text: 'job-1-output' }],
            session_id: 'sess_drain_1',
          },
        }),
        { headers: { 'Content-Type': 'application/json' }, status: 200 },
      ),
    );

    await waitFor(async () => {
      expect(worker.getActiveJobsCount()).toBe(0);
      const [row1] = await serverDB.select().from(sandboxJobs).where(eq(sandboxJobs.id, job1.id));
      expect(row1?.state).toBe('success');
      expect((row1?.resultPayload as any)?.content).toBe('job-1-output');
    });

    // Give tickLoop extra time to verify job2 is NEVER claimed by the draining worker
    await sleep(150);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [row2] = await serverDB.select().from(sandboxJobs).where(eq(sandboxJobs.id, job2.id));
    expect(row2?.state).toBe('queued');
  });
});
