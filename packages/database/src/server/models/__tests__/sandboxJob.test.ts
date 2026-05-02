// @vitest-environment node
import { and, eq, inArray } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../../core/getTestDB';
import type { NewSandboxJob } from '../../../schemas';
import { sandboxJobs, topics, users } from '../../../schemas';
import type { LobeChatDatabase } from '../../../type';
import { SandboxJobModel } from '../sandboxJob';

const serverDB: LobeChatDatabase = await getTestDB();

const userId = 'sandbox-job-test-user-id';
const otherUserId = 'sandbox-job-test-other-user-id';
const topicId = 'sandbox-job-test-topic-id';
const otherTopicId = 'sandbox-job-test-other-topic-id';

let jobSeq = 0;

const cleanup = async () => {
  await serverDB.delete(sandboxJobs).where(inArray(sandboxJobs.userId, [userId, otherUserId]));
  await serverDB.delete(topics).where(inArray(topics.userId, [userId, otherUserId]));
  await serverDB.delete(users).where(inArray(users.id, [userId, otherUserId]));
};

beforeEach(async () => {
  jobSeq = 0;
  await cleanup();
  await serverDB.insert(users).values([{ id: userId }, { id: otherUserId }]);
  await serverDB.insert(topics).values([
    { id: topicId, title: 'Sandbox Job Test Topic', userId },
    { id: otherTopicId, title: 'Sandbox Job Other Test Topic', userId },
  ]);
});

afterEach(async () => {
  await cleanup();
});

const createJob = async (overrides: Partial<NewSandboxJob> = {}) => {
  jobSeq += 1;
  const id = overrides.id ?? `sbj_test_${jobSeq}`;

  const [job] = await serverDB
    .insert(sandboxJobs)
    .values({
      apiName: 'runCommand',
      args: { command: `echo ${jobSeq}` },
      id,
      identifier: 'lobe-cloud-sandbox',
      parentMessageId: `msg_parent_${jobSeq}`,
      toolCallId: `tool_call_${jobSeq}`,
      topicId,
      userId,
      ...overrides,
    })
    .returning();

  return job;
};

describe('SandboxJobModel', () => {
  describe('create', () => {
    it('should return the existing row when creating twice with the same toolCallId', async () => {
      const model = new SandboxJobModel(serverDB, userId);

      const first = await model.create({
        apiName: 'runCommand',
        args: { command: 'echo first' },
        identifier: 'lobe-cloud-sandbox',
        parentMessageId: 'msg_parent_idempotent',
        toolCallId: 'tool_call_idempotent',
        topicId,
      });

      const second = await model.create({
        apiName: 'runCommand',
        args: { command: 'echo second' },
        identifier: 'lobe-cloud-sandbox',
        parentMessageId: 'msg_parent_idempotent',
        toolCallId: 'tool_call_idempotent',
        topicId,
      });

      expect(second.id).toBe(first.id);

      const rows = await serverDB
        .select()
        .from(sandboxJobs)
        .where(eq(sandboxJobs.toolCallId, 'tool_call_idempotent'));
      expect(rows).toHaveLength(1);
      expect(rows[0].args).toEqual({ command: 'echo first' });
    });
  });

  describe('claimNext', () => {
    it('should pick the oldest queued job and return null when none are available', async () => {
      const model = new SandboxJobModel(serverDB, userId);
      const oldJob = await createJob({
        createdAt: new Date('2026-01-01T10:00:00Z'),
        toolCallId: 'tool_call_oldest',
      });
      const newJob = await createJob({
        createdAt: new Date('2026-01-01T10:01:00Z'),
        toolCallId: 'tool_call_newest',
      });

      const first = await model.claimNext('worker-1', 60);
      const second = await model.claimNext('worker-1', 60);
      const third = await model.claimNext('worker-1', 60);

      expect(first?.id).toBe(oldJob.id);
      expect(second?.id).toBe(newJob.id);
      expect(third).toBeNull();
    });

    it('should let two parallel claimNext calls claim different jobs', async () => {
      const model = new SandboxJobModel(serverDB, userId);
      await createJob({ toolCallId: 'tool_call_concurrency_1' });
      await createJob({ toolCallId: 'tool_call_concurrency_2' });

      const [first, second] = await Promise.all([
        model.claimNext('worker-a', 60),
        model.claimNext('worker-b', 60),
      ]);

      const claimedIds = [first?.id, second?.id].filter(Boolean);
      expect(new Set(claimedIds).size).toBe(claimedIds.length);
      expect(claimedIds.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('heartbeat', () => {
    it('should refresh heartbeat and lock for the owning worker', async () => {
      const model = new SandboxJobModel(serverDB, userId);
      await createJob({ toolCallId: 'tool_call_heartbeat_success' });
      const claimed = await model.claimNext('worker-heartbeat', 60);

      const result = await model.heartbeat(claimed!.id, 'worker-heartbeat');

      expect(result).toBe(true);

      const found = await model.findById(claimed!.id);
      expect(found?.lastHeartbeatAt).toBeInstanceOf(Date);
      expect(found?.lockedUntil).toBeInstanceOf(Date);
    });

    it('should return false when heartbeat is sent by the wrong workerId', async () => {
      const model = new SandboxJobModel(serverDB, userId);
      await createJob({ toolCallId: 'tool_call_heartbeat_wrong_worker' });
      const claimed = await model.claimNext('worker-owner', 60);

      const result = await model.heartbeat(claimed!.id, 'worker-intruder');

      expect(result).toBe(false);
    });
  });

  describe('markSuccess', () => {
    it('should transition a running job to success and set completedAt', async () => {
      const model = new SandboxJobModel(serverDB, userId);
      await createJob({ toolCallId: 'tool_call_success' });
      const claimed = await model.claimNext('worker-success', 60);

      const result = await model.markSuccess(
        claimed!.id,
        { content: 'done', files: [], state: 'finished' },
        'sandbox-session-1',
      );

      expect(result?.state).toBe('success');
      expect(result?.completedAt).toBeInstanceOf(Date);
      expect(result?.resultPayload).toEqual({ content: 'done', files: [], state: 'finished' });
      expect(result?.sandboxSessionId).toBe('sandbox-session-1');
    });
  });

  describe('recoverStaleJobs', () => {
    it('should requeue a running job with an expired lock and increment claimAttempts', async () => {
      const model = new SandboxJobModel(serverDB, userId);
      const job = await createJob({
        lockedUntil: new Date('2026-01-01T10:00:00Z'),
        state: 'running',
        toolCallId: 'tool_call_stale_requeue',
        workerId: 'stale-worker',
      });

      const recovered = await model.recoverStaleJobs(60);

      expect(recovered).toHaveLength(1);
      expect(recovered[0].id).toBe(job.id);
      expect(recovered[0].state).toBe('queued');
      expect(recovered[0].claimAttempts).toBe(1);
      expect(recovered[0].workerId).toBeNull();
    });

    it('should mark a stale job as error after 3 claim attempts', async () => {
      const model = new SandboxJobModel(serverDB, userId);
      const job = await createJob({
        claimAttempts: 2,
        lockedUntil: new Date('2026-01-01T10:00:00Z'),
        state: 'running',
        toolCallId: 'tool_call_stale_error',
        workerId: 'stale-worker',
      });

      const recovered = await model.recoverStaleJobs(60);

      expect(recovered).toHaveLength(1);
      expect(recovered[0].id).toBe(job.id);
      expect(recovered[0].state).toBe('error');
      expect(recovered[0].claimAttempts).toBe(3);
      expect(recovered[0].completedAt).toBeInstanceOf(Date);
      expect(recovered[0].errorPayload).toEqual({
        message: 'Sandbox job exceeded maximum claim attempts',
        type: 'stale_job',
      });
    });
  });

  describe('setContinuation', () => {
    it('should allow only the first continuation claimant to win', async () => {
      const model = new SandboxJobModel(serverDB, userId);
      const job = await createJob({ toolCallId: 'tool_call_continuation_race' });

      const serverClaimed = await model.setContinuation(
        job.id,
        'msg_server_continuation',
        'server',
      );
      const clientClaimed = await model.setContinuation(
        job.id,
        'msg_client_continuation',
        'client',
      );

      expect(serverClaimed).toBe(true);
      expect(clientClaimed).toBe(false);

      const found = await model.findById(job.id);
      expect(found?.continuationClaimedBy).toBe('server');
      expect(found?.continuationMessageId).toBe('msg_server_continuation');
    });
  });

  describe('listActiveByTopic', () => {
    it('should return only queued and running jobs for the requested topic', async () => {
      const model = new SandboxJobModel(serverDB, userId);
      const queued = await createJob({ toolCallId: 'tool_call_active_queued' });
      const running = await createJob({
        state: 'running',
        toolCallId: 'tool_call_active_running',
        workerId: 'worker-active',
      });
      await createJob({ state: 'success', toolCallId: 'tool_call_inactive_success' });
      await createJob({
        toolCallId: 'tool_call_other_topic',
        topicId: otherTopicId,
      });

      const active = await model.listActiveByTopic(topicId);

      expect(active.map((job) => job.id)).toEqual([queued.id, running.id]);

      const leaked = await serverDB
        .select()
        .from(sandboxJobs)
        .where(and(eq(sandboxJobs.topicId, topicId), eq(sandboxJobs.state, 'success')));
      expect(leaked).toHaveLength(1);
    });
  });
});
