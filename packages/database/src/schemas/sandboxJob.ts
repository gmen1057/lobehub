import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';

import { idGenerator } from '../utils/idGenerator';
import { timestamptz } from './_helpers';
import { topics } from './topic';
import { users } from './user';

export const sandboxJobStates = [
  'queued',
  'running',
  'success',
  'error',
  'timeout',
  'cancelled',
] as const;

export const sandboxJobContinuationClaimants = ['server', 'client'] as const;

export type SandboxJobState = (typeof sandboxJobStates)[number];
export type SandboxJobContinuationClaimedBy = (typeof sandboxJobContinuationClaimants)[number];
export type SandboxJobArgs = Record<string, unknown>;

export interface SandboxJobResultPayload {
  content?: unknown;
  files?: unknown;
  state?: unknown;
  [key: string]: unknown;
}

export interface SandboxJobErrorPayload {
  body?: unknown;
  message?: string;
  type?: string;
  [key: string]: unknown;
}

export const sandboxJobs = pgTable(
  'sandbox_jobs',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => idGenerator('sandboxJobs'))
      .notNull(),

    userId: text('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    topicId: text('topic_id')
      .references(() => topics.id, { onDelete: 'cascade' })
      .notNull(),
    parentMessageId: text('parent_message_id').notNull(),
    toolCallId: text('tool_call_id').notNull(),

    identifier: text('identifier').notNull(),
    apiName: text('api_name').notNull(),
    args: jsonb('args').$type<SandboxJobArgs>().notNull(),

    state: text('state', { enum: sandboxJobStates }).default('queued').notNull(),
    sandboxSessionId: text('sandbox_session_id'),
    resultPayload: jsonb('result_payload').$type<SandboxJobResultPayload | null>(),
    errorPayload: jsonb('error_payload').$type<SandboxJobErrorPayload | null>(),
    attempts: integer('attempts').default(0).notNull(),

    workerId: text('worker_id'),
    lockedUntil: timestamptz('locked_until'),
    lastHeartbeatAt: timestamptz('last_heartbeat_at'),
    claimAttempts: integer('claim_attempts').default(0).notNull(),

    continuationMessageId: text('continuation_message_id'),
    continuationClaimedBy: text('continuation_claimed_by', {
      enum: sandboxJobContinuationClaimants,
    }),
    continuationCompletedAt: timestamptz('continuation_completed_at'),

    createdAt: timestamptz('created_at').defaultNow().notNull(),
    startedAt: timestamptz('started_at'),
    completedAt: timestamptz('completed_at'),
    expiresAt: timestamptz('expires_at')
      .default(sql`now() + interval '30 minutes'`)
      .notNull(),
  },
  (t) => [
    uniqueIndex('sandbox_jobs_tool_call_id_unique').on(t.toolCallId),
    index('sandbox_jobs_user_state_idx').on(t.userId, t.state),
    index('sandbox_jobs_state_created_active_idx')
      .on(t.state, t.createdAt)
      .where(sql`${t.state} IN ('queued', 'running')`),
    index('sandbox_jobs_topic_id_idx').on(t.topicId),
  ],
);

export type NewSandboxJob = typeof sandboxJobs.$inferInsert;
export type SandboxJobSelectItem = typeof sandboxJobs.$inferSelect;
