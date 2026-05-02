import { and, asc, count, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';

import type {
  NewSandboxJob,
  SandboxJobContinuationClaimedBy,
  SandboxJobErrorPayload,
  SandboxJobResultPayload,
  SandboxJobSelectItem,
} from '../schemas';
import { sandboxJobs } from '../schemas';
import type { LobeChatDatabase } from '../type';

const ACTIVE_SANDBOX_JOB_STATES = ['queued', 'running'] as const;
const DEFAULT_LOCK_TTL_SEC = 60;
const STALE_JOB_MAX_CLAIM_ATTEMPTS = 3;

export interface CreateSandboxJobParams {
  apiName: string;
  args: NewSandboxJob['args'];
  identifier: string;
  parentMessageId: string;
  toolCallId: string;
  topicId: string;
}

export class SandboxJobModel {
  private readonly db: LobeChatDatabase;
  private readonly userId: string;

  constructor(db: LobeChatDatabase, userId: string) {
    this.db = db;
    this.userId = userId;
  }

  create = async (params: CreateSandboxJobParams): Promise<SandboxJobSelectItem> => {
    const [created] = await this.db
      .insert(sandboxJobs)
      .values({ ...params, userId: this.userId })
      .onConflictDoNothing({ target: sandboxJobs.toolCallId })
      .returning();

    if (created) return created;

    const existing = await this.findByToolCallId(params.toolCallId);

    if (!existing) {
      throw new Error('Sandbox job toolCallId conflict belongs to a different user');
    }

    return existing;
  };

  findById = async (id: string): Promise<SandboxJobSelectItem | undefined> => {
    const [result] = await this.db
      .select()
      .from(sandboxJobs)
      .where(and(eq(sandboxJobs.id, id), eq(sandboxJobs.userId, this.userId)))
      .limit(1);

    return result;
  };

  findByToolCallId = async (toolCallId: string): Promise<SandboxJobSelectItem | undefined> => {
    const [result] = await this.db
      .select()
      .from(sandboxJobs)
      .where(and(eq(sandboxJobs.toolCallId, toolCallId), eq(sandboxJobs.userId, this.userId)))
      .limit(1);

    return result;
  };

  claimNext = async (
    workerId: string,
    lockTtlSec: number = DEFAULT_LOCK_TTL_SEC,
  ): Promise<SandboxJobSelectItem | null> => {
    const ttlSec = normalizeTtl(lockTtlSec);
    const [claimed] = await this.db
      .update(sandboxJobs)
      .set({
        lastHeartbeatAt: sql`now()`,
        lockedUntil: sql`now() + (${ttlSec} * interval '1 second')`,
        startedAt: sql`now()`,
        state: 'running',
        workerId,
      })
      .where(
        eq(
          sandboxJobs.id,
          sql`(
            SELECT "id"
            FROM "sandbox_jobs"
            WHERE "state" = 'queued'
            ORDER BY "created_at" ASC
            LIMIT 1
            FOR UPDATE SKIP LOCKED
          )`,
        ),
      )
      .returning();

    return claimed ?? null;
  };

  heartbeat = async (
    id: string,
    workerId: string,
    lockTtlSec: number = DEFAULT_LOCK_TTL_SEC,
  ): Promise<boolean> => {
    const ttlSec = normalizeTtl(lockTtlSec);
    const result = await this.db
      .update(sandboxJobs)
      .set({
        lastHeartbeatAt: sql`now()`,
        lockedUntil: sql`now() + (${ttlSec} * interval '1 second')`,
      })
      .where(
        and(
          eq(sandboxJobs.id, id),
          eq(sandboxJobs.workerId, workerId),
          eq(sandboxJobs.state, 'running'),
        ),
      )
      .returning({ id: sandboxJobs.id });

    return result.length > 0;
  };

  markSuccess = async (
    id: string,
    resultPayload: SandboxJobResultPayload,
    sandboxSessionId?: string | null,
  ): Promise<SandboxJobSelectItem | null> => {
    const [result] = await this.db
      .update(sandboxJobs)
      .set({
        completedAt: sql`now()`,
        lastHeartbeatAt: null,
        lockedUntil: null,
        resultPayload,
        sandboxSessionId,
        state: 'success',
        workerId: null,
      })
      .where(
        and(
          eq(sandboxJobs.id, id),
          eq(sandboxJobs.userId, this.userId),
          eq(sandboxJobs.state, 'running'),
        ),
      )
      .returning();

    return result ?? null;
  };

  markError = async (
    id: string,
    errorPayload: SandboxJobErrorPayload,
  ): Promise<SandboxJobSelectItem | null> => {
    const [result] = await this.db
      .update(sandboxJobs)
      .set({
        completedAt: sql`now()`,
        errorPayload,
        lastHeartbeatAt: null,
        lockedUntil: null,
        state: 'error',
        workerId: null,
      })
      .where(
        and(
          eq(sandboxJobs.id, id),
          eq(sandboxJobs.userId, this.userId),
          eq(sandboxJobs.state, 'running'),
        ),
      )
      .returning();

    return result ?? null;
  };

  markTimeout = async (id: string): Promise<SandboxJobSelectItem | null> => {
    const [result] = await this.db
      .update(sandboxJobs)
      .set({
        completedAt: sql`now()`,
        lastHeartbeatAt: null,
        lockedUntil: null,
        state: 'timeout',
        workerId: null,
      })
      .where(
        and(
          eq(sandboxJobs.id, id),
          eq(sandboxJobs.userId, this.userId),
          eq(sandboxJobs.state, 'running'),
        ),
      )
      .returning();

    return result ?? null;
  };

  markCancelled = async (id: string): Promise<SandboxJobSelectItem | null> => {
    const [result] = await this.db
      .update(sandboxJobs)
      .set({
        completedAt: sql`now()`,
        lastHeartbeatAt: null,
        lockedUntil: null,
        state: 'cancelled',
        workerId: null,
      })
      .where(
        and(
          eq(sandboxJobs.id, id),
          eq(sandboxJobs.userId, this.userId),
          inArray(sandboxJobs.state, ACTIVE_SANDBOX_JOB_STATES),
        ),
      )
      .returning();

    return result ?? null;
  };

  recoverStaleJobs = async (
    lockTtlSec: number = DEFAULT_LOCK_TTL_SEC,
  ): Promise<SandboxJobSelectItem[]> => {
    const ttlSec = normalizeTtl(lockTtlSec);

    return this.db
      .update(sandboxJobs)
      .set({
        claimAttempts: sql`${sandboxJobs.claimAttempts} + 1`,
        completedAt: sql`CASE
          WHEN ${sandboxJobs.claimAttempts} + 1 >= ${STALE_JOB_MAX_CLAIM_ATTEMPTS} THEN now()
          ELSE NULL
        END`,
        errorPayload: sql`CASE
          WHEN ${sandboxJobs.claimAttempts} + 1 >= ${STALE_JOB_MAX_CLAIM_ATTEMPTS}
            THEN jsonb_build_object(
              'type',
              'stale_job',
              'message',
              'Sandbox job exceeded maximum claim attempts'
            )
          ELSE ${sandboxJobs.errorPayload}
        END`,
        lastHeartbeatAt: null,
        lockedUntil: null,
        state: sql`CASE
          WHEN ${sandboxJobs.claimAttempts} + 1 >= ${STALE_JOB_MAX_CLAIM_ATTEMPTS} THEN 'error'
          ELSE 'queued'
        END`,
        workerId: null,
      })
      .where(
        and(
          eq(sandboxJobs.state, 'running'),
          or(
            lt(sandboxJobs.lockedUntil, sql`now()`),
            and(
              isNull(sandboxJobs.lockedUntil),
              lt(sandboxJobs.startedAt, sql`now() - (${ttlSec} * interval '1 second')`),
            ),
          ),
        ),
      )
      .returning();
  };

  listActiveByTopic = async (topicId: string): Promise<SandboxJobSelectItem[]> => {
    return this.db
      .select()
      .from(sandboxJobs)
      .where(
        and(
          eq(sandboxJobs.topicId, topicId),
          eq(sandboxJobs.userId, this.userId),
          inArray(sandboxJobs.state, ACTIVE_SANDBOX_JOB_STATES),
        ),
      )
      .orderBy(asc(sandboxJobs.createdAt));
  };

  listByUser = async (
    userId: string = this.userId,
    limit: number = 50,
  ): Promise<SandboxJobSelectItem[]> => {
    return this.db
      .select()
      .from(sandboxJobs)
      .where(eq(sandboxJobs.userId, userId))
      .orderBy(desc(sandboxJobs.createdAt))
      .limit(limit);
  };

  countActiveByUser = async (userId: string = this.userId): Promise<number> => {
    const [result] = await this.db
      .select({ count: count() })
      .from(sandboxJobs)
      .where(
        and(eq(sandboxJobs.userId, userId), inArray(sandboxJobs.state, ACTIVE_SANDBOX_JOB_STATES)),
      );

    return Number(result?.count ?? 0);
  };

  setContinuation = async (
    id: string,
    messageId: string,
    claimedBy: SandboxJobContinuationClaimedBy,
  ): Promise<boolean> => {
    const result = await this.db
      .update(sandboxJobs)
      .set({
        continuationClaimedBy: claimedBy,
        continuationMessageId: messageId,
      })
      .where(
        and(
          eq(sandboxJobs.id, id),
          eq(sandboxJobs.userId, this.userId),
          isNull(sandboxJobs.continuationClaimedBy),
        ),
      )
      .returning({ id: sandboxJobs.id });

    return result.length > 0;
  };
}

const normalizeTtl = (lockTtlSec: number) => Math.max(1, Math.floor(lockTtlSec));
