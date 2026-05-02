import debug from 'debug';
import { and, eq } from 'drizzle-orm';

import { MessageModel } from '@/database/models/message';
import type { SandboxJobSelectItem } from '@/database/schemas';
import { messagePlugins, messages, sandboxJobs } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';

const log = debug('lobe-server:service:sandbox-jobs:continuation');

interface ResultPayloadShape {
  content?: unknown;
  result?: { output?: unknown };
  state?: unknown;
}

interface ErrorPayloadShape {
  body?: unknown;
  message?: string;
  type?: string;
}

const stringField = (value: unknown): string => (typeof value === 'string' ? value : '');

const extractContentFromResult = (job: SandboxJobSelectItem): string => {
  if (job.state === 'success') {
    const payload = (job.resultPayload ?? {}) as ResultPayloadShape;
    const top = stringField(payload.content);
    if (top) return top;

    const inner = stringField(payload.result?.output);
    if (inner) return inner;

    return '';
  }

  const errorPayload = (job.errorPayload ?? {}) as ErrorPayloadShape;
  if (errorPayload.message) return errorPayload.message;

  // Fallback for terminal states without an explicit message.
  return `Sandbox job ended in state=${job.state}`;
};

const extractPluginStateFromResult = (job: SandboxJobSelectItem) => {
  if (job.state !== 'success') return null;

  const payload = (job.resultPayload ?? {}) as ResultPayloadShape;
  return payload.state ?? null;
};

const buildPluginError = (job: SandboxJobSelectItem) => {
  if (job.state === 'success') return null;

  const errorPayload = (job.errorPayload ?? {}) as ErrorPayloadShape;
  return {
    body: errorPayload.body,
    message: errorPayload.message ?? `Sandbox job ended in state=${job.state}`,
    type: errorPayload.type ?? job.state,
  };
};

/**
 * Atomically write the child tool message that surfaces a sandbox_jobs result
 * to the user's chat history. Idempotent: if the client (legacy path) already
 * created the row before the worker finished, we update its content and
 * plugin state instead of inserting a duplicate.
 *
 * Also marks the job's continuation_claimed_by='server' so the client poller
 * (Block D) knows not to overwrite the message later.
 *
 * Returns { created } so callers can log whether they created a new row or
 * updated an existing one.
 */
export const writeChildToolMessage = async (
  db: LobeChatDatabase,
  job: SandboxJobSelectItem,
): Promise<{ created: boolean; messageId: string | null }> => {
  // Look up an existing tool message for this tool_call_id.
  const existing = await db
    .select({
      id: messages.id,
    })
    .from(messages)
    .innerJoin(messagePlugins, eq(messagePlugins.id, messages.id))
    .where(
      and(
        eq(messages.userId, job.userId),
        eq(messages.role, 'tool'),
        eq(messagePlugins.toolCallId, job.toolCallId),
      ),
    )
    .limit(1);

  const content = extractContentFromResult(job);
  const pluginState = extractPluginStateFromResult(job);
  const pluginError = buildPluginError(job);

  if (existing.length > 0) {
    const existingId = existing[0].id;

    await db
      .update(messages)
      .set({ content, updatedAt: new Date() })
      .where(eq(messages.id, existingId));

    await db
      .update(messagePlugins)
      .set({ error: pluginError, state: pluginState as any })
      .where(eq(messagePlugins.id, existingId));

    log(
      'writeChildToolMessage: updated existing message_id=%s tool_call_id=%s state=%s',
      existingId,
      job.toolCallId,
      job.state,
    );

    await markContinuationClaimed(db, job, existingId);
    return { created: false, messageId: existingId };
  }

  // No existing tool message — create a fresh one. The worker writes on behalf
  // of the user (job.userId), not the system worker pseudo-user.
  const messageModel = new MessageModel(db, job.userId);
  const created = await messageModel.create({
    content,
    parentId: job.parentMessageId,
    plugin: {
      apiName: job.apiName,
      arguments: typeof job.args === 'string' ? job.args : JSON.stringify(job.args ?? {}),
      identifier: job.identifier,
      type: 'builtin',
    },
    pluginState: pluginState as any,
    role: 'tool',
    tool_call_id: job.toolCallId,
    topicId: job.topicId,
  });

  // The model.create insert above does not set plugin error — patch it here for
  // failure states so the UI surfaces the banner.
  if (pluginError) {
    await db
      .update(messagePlugins)
      .set({ error: pluginError })
      .where(eq(messagePlugins.id, created.id));
  }

  log(
    'writeChildToolMessage: created new message_id=%s tool_call_id=%s parent=%s state=%s',
    created.id,
    job.toolCallId,
    job.parentMessageId,
    job.state,
  );

  await markContinuationClaimed(db, job, created.id);
  return { created: true, messageId: created.id };
};

/**
 * Atomically claim continuation for the server side — losing means the client
 * already wrote the next LLM step (race control for Block E v2). Idempotent.
 */
const markContinuationClaimed = async (
  db: LobeChatDatabase,
  job: SandboxJobSelectItem,
  messageId: string,
) => {
  const result = await db
    .update(sandboxJobs)
    .set({
      continuationClaimedBy: 'server',
      continuationCompletedAt: new Date(),
      continuationMessageId: messageId,
    })
    .where(
      and(
        eq(sandboxJobs.id, job.id),
        // Only claim if not already claimed (server first-writer-wins).
        eq(sandboxJobs.userId, job.userId),
      ),
    )
    .returning({ id: sandboxJobs.id });

  if (result.length === 0) {
    log(
      'markContinuationClaimed: failed to update job_id=%s tool_call_id=%s (job vanished?)',
      job.id,
      job.toolCallId,
    );
  }
};
