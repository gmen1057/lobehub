// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { eq, inArray } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { messagePlugins, messages, sandboxJobs, topics, users } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';

import { resetEngineSlotStateForTests } from '../slotState';
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
  await serverDB.delete(messages).where(inArray(messages.userId, [userId]));
  await serverDB.delete(topics).where(inArray(topics.userId, [userId]));
  await serverDB.delete(users).where(inArray(users.id, [userId]));
};

let activeWorker: SandboxJobWorker | undefined;
const savedSlotName = process.env.SLOT_NAME;
const savedLobeSlot = process.env.LOBECHAT_SLOT;
const savedStateFile = process.env.ENGINE_STATE_FILE;

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.SLOT_NAME;
  delete process.env.LOBECHAT_SLOT;
  delete process.env.ENGINE_STATE_FILE;
  resetEngineSlotStateForTests();
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
  await serverDB.insert(messages).values([
    {
      content: 'Running sandbox job 1',
      id: 'msg_parent_1',
      role: 'assistant',
      topicId,
      userId,
    },
    {
      content: 'Running sandbox job 2',
      id: 'msg_parent_2',
      role: 'assistant',
      topicId,
      userId,
    },
  ]);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (savedSlotName === undefined) delete process.env.SLOT_NAME;
  else process.env.SLOT_NAME = savedSlotName;
  if (savedLobeSlot === undefined) delete process.env.LOBECHAT_SLOT;
  else process.env.LOBECHAT_SLOT = savedLobeSlot;
  if (savedStateFile === undefined) delete process.env.ENGINE_STATE_FILE;
  else process.env.ENGINE_STATE_FILE = savedStateFile;
  resetEngineSlotStateForTests();
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
      expect(row1?.continuationClaimedBy).toBe('server');
      expect(row1?.continuationMessageId).toBeTruthy();

      const [childMsg1] = await serverDB
        .select()
        .from(messages)
        .where(eq(messages.id, row1!.continuationMessageId!));
      expect(childMsg1?.role).toBe('tool');
      expect(childMsg1?.parentId).toBe('msg_parent_1');
      expect(childMsg1?.content).toBe('job-1-output');

      const [plugin1] = await serverDB
        .select()
        .from(messagePlugins)
        .where(eq(messagePlugins.id, row1!.continuationMessageId!));
      expect(plugin1?.toolCallId).toBe('call_drain_1');
    });

    // Give tickLoop extra time to verify job2 is NEVER claimed by the draining worker
    await sleep(150);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [row2] = await serverDB.select().from(sandboxJobs).where(eq(sandboxJobs.id, job2.id));
    expect(row2?.state).toBe('queued');

    // P1 #3: Fast --rollback calls resumeFromDrain() -> worker resumes claiming queued jobs!
    const workerIdBeforeResume = worker.id;
    fetchMock.mockImplementationOnce(async () => {
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          result: {
            content: [{ text: 'job-2-resumed-output' }],
            session_id: 'sess_drain_2',
          },
        }),
        { headers: { 'Content-Type': 'application/json' }, status: 200 },
      );
    });

    await worker.resumeFromDrain();
    expect(worker.isDraining()).toBe(false);
    expect(worker.isRunning).toBe(true);
    expect(worker.id).toBe(workerIdBeforeResume);

    await waitFor(async () => {
      const [resumedRow2] = await serverDB
        .select()
        .from(sandboxJobs)
        .where(eq(sandboxJobs.id, job2.id));
      expect(resumedRow2?.state).toBe('success');
      expect((resumedRow2?.resultPayload as any)?.content).toBe('job-2-resumed-output');
      expect(resumedRow2?.continuationClaimedBy).toBe('server');
      expect(resumedRow2?.continuationMessageId).toBeTruthy();

      const [childMsg2] = await serverDB
        .select()
        .from(messages)
        .where(eq(messages.id, resumedRow2!.continuationMessageId!));
      expect(childMsg2?.role).toBe('tool');
      expect(childMsg2?.parentId).toBe('msg_parent_2');
      expect(childMsg2?.content).toBe('job-2-resumed-output');
    });
  });

  it('#8: starts paused in drain mode when SLOT_NAME !== state.json activeSlot until resumeFromDrain()', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-sbx-slot-state-'));
    const stateFile = path.join(tmpDir, 'state.json');
    try {
      fs.writeFileSync(stateFile, JSON.stringify({ activePort: 3411, activeSlot: 'blue' }), 'utf8');
      process.env.SLOT_NAME = 'green';
      process.env.ENGINE_STATE_FILE = stateFile;
      resetEngineSlotStateForTests();

      await serverDB.insert(sandboxJobs).values({
        apiName: 'executeCode',
        args: { code: 'print("candidate-must-not-steal")' },
        id: 'sbj_candidate_paused',
        identifier: 'lobe-cloud-sandbox',
        parentMessageId: 'msg_parent_1',
        toolCallId: 'call_candidate_paused',
        topicId,
        userId,
      });

      const fetchMock = vi.fn(async () => {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            result: { content: [{ text: 'claimed-after-undrain' }], session_id: 's1' },
          }),
          { headers: { 'Content-Type': 'application/json' }, status: 200 },
        );
      });
      vi.stubGlobal('fetch', fetchMock);

      const worker = await SandboxJobWorker.ensureRunning(serverDB, 1);
      activeWorker = worker;
      expect(worker.isDraining()).toBe(true);
      expect(worker.isRunning).toBe(false);

      // Candidate green is paused in drain mode — queued job MUST remain unclaimed!
      await sleep(150);
      expect(fetchMock).not.toHaveBeenCalled();
      const [beforeUndrain] = await serverDB
        .select()
        .from(sandboxJobs)
        .where(eq(sandboxJobs.id, 'sbj_candidate_paused'));
      expect(beforeUndrain?.state).toBe('queued');

      // Simulate POST /undrain after switching state.json to green!
      await worker.resumeFromDrain();
      expect(worker.isDraining()).toBe(false);
      expect(worker.isRunning).toBe(true);

      await waitFor(async () => {
        const [afterUndrain] = await serverDB
          .select()
          .from(sandboxJobs)
          .where(eq(sandboxJobs.id, 'sbj_candidate_paused'));
        expect(afterUndrain?.state).toBe('success');
        expect((afterUndrain?.resultPayload as any)?.content).toBe('claimed-after-undrain');
      });
    } finally {
      fs.rmSync(tmpDir, { force: true, recursive: true });
    }
  });
});
