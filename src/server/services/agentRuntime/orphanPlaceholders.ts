import { LOADING_FLAT } from '@lobechat/const';
import type { ChatMessageError } from '@lobechat/types';
import { and, asc, eq, isNull } from 'drizzle-orm';

import { messages } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import type {
  StreamChunkData,
  StreamEvent,
} from '@/server/modules/AgentRuntime/StreamEventManager';

/** Minimum age (2 minutes) before an unowned `LOADING_FLAT` row can be reaped as an orphan. */
export const ORPHAN_LOADING_MIN_AGE_MS = 2 * 60 * 1000;

/** Persisted error recorded on orphaned `LOADING_FLAT` placeholders after a crash/unclean stop. */
export const ORPHAN_PLACEHOLDER_ERROR: ChatMessageError = {
  body: {
    code: 'ProviderStreamInterrupted',
    reason: 'orphan_loading_placeholder',
    status: 502,
  },
  message: 'Соединение с моделью прервалось во время ответа. Попробуйте ещё раз.',
  type: 502 as ChatMessageError['type'],
};

/** Persisted error recorded on empty `LOADING_FLAT` placeholders interrupted by server SIGTERM. */
export const SERVER_SHUTDOWN_PLACEHOLDER_ERROR: ChatMessageError = {
  body: {
    code: 'provider_unavailable',
    reason: 'server_shutdown',
    status: 503,
  },
  message: 'Модель временно недоступна из-за перезапуска сервера. Попробуйте ещё раз.',
  type: 503 as ChatMessageError['type'],
};

export interface OrphanCandidateLike {
  content?: unknown;
  createdAt?: Date | string | null;
  error?: unknown;
  fileList?: unknown;
  files?: unknown;
  filesToMessages?: unknown;
  id: string;
  imageList?: unknown;
  metadata?: unknown;
  reasoning?: unknown;
  role?: string;
  tools?: unknown;
  updatedAt?: Date | string | null;
}

const hasNonEmptyReasoning = (reasoning: unknown): boolean => {
  if (!reasoning) return false;
  if (typeof reasoning === 'string') return reasoning.trim().length > 0;
  if (typeof reasoning === 'object') {
    const rec = reasoning as Record<string, unknown>;
    if (rec.isMultimodal === true) return true;
    if (typeof rec.signature === 'string' && rec.signature.trim().length > 0) return true;
    if (typeof rec.content === 'string' && rec.content.trim().length > 0) return true;
    if (Array.isArray(rec.content) && rec.content.length > 0) return true;
  }
  return false;
};

export const hasPaidOrMeaningfulAssistantPayload = (row: OrphanCandidateLike): boolean => {
  const content = typeof row.content === 'string' ? row.content.trim() : '';
  if (content.length > 0 && content !== LOADING_FLAT) return true;
  if (Array.isArray(row.tools) && row.tools.length > 0) return true;
  if (hasNonEmptyReasoning(row.reasoning)) return true;
  if (Array.isArray(row.files) && row.files.length > 0) return true;
  if (Array.isArray(row.filesToMessages) && row.filesToMessages.length > 0) return true;
  if (Array.isArray(row.imageList) && row.imageList.length > 0) return true;
  if (Array.isArray(row.fileList) && row.fileList.length > 0) return true;
  const meta =
    row.metadata && typeof row.metadata === 'object'
      ? (row.metadata as Record<string, unknown>)
      : undefined;
  if (meta?.isMultimodal === true) return true;
  return false;
};

export const isStaleOrphanLoadingCandidate = (
  row: OrphanCandidateLike,
  options?: { excludeMessageId?: string; minAgeMs?: number; nowMs?: number },
): boolean => {
  if (row.role !== 'assistant') return false;
  if (!row.id || row.id === options?.excludeMessageId) return false;
  if (row.content !== LOADING_FLAT) return false;
  if (row.error !== null && row.error !== undefined) return false;
  if (hasPaidOrMeaningfulAssistantPayload(row)) return false;

  const rawTs = row.updatedAt ?? row.createdAt;
  if (!rawTs) return false;
  const rowMs = rawTs instanceof Date ? rawTs.getTime() : new Date(rawTs).getTime();
  if (!Number.isFinite(rowMs)) return false;

  const nowMs = options?.nowMs ?? Date.now();
  const minAgeMs = options?.minAgeMs ?? ORPHAN_LOADING_MIN_AGE_MS;
  return nowMs - rowMs > minAgeMs;
};

/**
 * Extract streamed text/reasoning belonging ONLY to the current trailing LLM sub-step.
 * Resets accumulated text/reasoning across multi-step boundaries (`step_start`, `stream_start`,
 * `tool_end`, `tools_calling`) so text emitted before a tool call on step 0 is never copied onto
 * a subsequent empty step-2 assistant row on SIGTERM.
 */
export const extractStreamedPartialFromEvents = (
  events: readonly StreamEvent[],
): { assistantMessageId?: string; reasoning: string; text: string } => {
  let text = '';
  let reasoning = '';
  let assistantMessageId: string | undefined;

  for (const event of events) {
    if (event.type === 'step_start' || event.type === 'tool_end') {
      text = '';
      reasoning = '';
      assistantMessageId = undefined;
      continue;
    }
    if (event.type === 'stream_start') {
      text = '';
      reasoning = '';
      const data =
        event.data && typeof event.data === 'object'
          ? (event.data as { assistantMessage?: { id?: unknown } })
          : undefined;
      assistantMessageId =
        typeof data?.assistantMessage?.id === 'string' && data.assistantMessage.id.length > 0
          ? data.assistantMessage.id
          : undefined;
      continue;
    }
    if (event.type === 'stream_retry') {
      if ((event.data as { resetText?: boolean } | undefined)?.resetText === true) {
        text = '';
        reasoning = '';
      }
      continue;
    }
    if (event.type !== 'stream_chunk' || !event.data || typeof event.data !== 'object') continue;
    const chunk = event.data as StreamChunkData;
    if (chunk.chunkType === 'tools_calling') {
      // Once the LLM transitions to tool_calls in this step, its pre-tool text belongs to that
      // assistant message and must not spill into any later post-tool assistant placeholder.
      continue;
    }
    if (chunk.chunkType === 'text' && typeof chunk.content === 'string') {
      text += chunk.content;
    } else if (chunk.chunkType === 'reasoning' && typeof chunk.reasoning === 'string') {
      reasoning += chunk.reasoning;
    }
  }
  return { assistantMessageId, reasoning, text };
};

/**
 * Atomically marks confirmed orphan `LOADING_FLAT` rows in PostgreSQL.
 * Uses a CAS guard (`content = '...' AND error IS NULL`) so a concurrent completion can never be overwritten.
 */
export const markOrphanPlaceholdersInDB = async (params: {
  candidateIds: string[];
  db: LobeChatDatabase;
  error?: ChatMessageError;
  nowMs?: number;
  userId: string;
}): Promise<string[]> => {
  const { db, userId, candidateIds, error = ORPHAN_PLACEHOLDER_ERROR } = params;
  if (!userId || candidateIds.length === 0) return [];

  const updatedAt = new Date(params.nowMs ?? Date.now());
  const reapedIds: string[] = [];

  for (const candidateId of candidateIds) {
    const updated = await db
      .update(messages)
      .set({
        content: '',
        error,
        updatedAt,
      })
      .where(
        and(
          eq(messages.id, candidateId),
          eq(messages.userId, userId),
          eq(messages.content, LOADING_FLAT),
          isNull(messages.error),
        ),
      )
      .returning({ id: messages.id });

    if (updated.length > 0) {
      reapedIds.push(candidateId);
    }
  }

  return reapedIds;
};

/**
 * Query recent assistant rows of a topic to find orphan `LOADING_FLAT` candidates when the caller
 * has not already loaded the topic's message list.
 */
export const findOrphanPlaceholderIdsInTopic = async (params: {
  db: LobeChatDatabase;
  excludeMessageId?: string;
  minAgeMs?: number;
  nowMs?: number;
  topicId: string;
  userId: string;
}): Promise<string[]> => {
  const { db, userId, topicId, excludeMessageId, minAgeMs, nowMs } = params;
  if (!userId || !topicId) return [];

  const rows = await db
    .select({
      content: messages.content,
      createdAt: messages.createdAt,
      error: messages.error,
      id: messages.id,
      metadata: messages.metadata,
      reasoning: messages.reasoning,
      role: messages.role,
      tools: messages.tools,
      updatedAt: messages.updatedAt,
    })
    .from(messages)
    .where(
      and(
        eq(messages.userId, userId),
        eq(messages.topicId, topicId),
        eq(messages.role, 'assistant'),
        eq(messages.content, LOADING_FLAT),
        isNull(messages.error),
      ),
    )
    .orderBy(asc(messages.createdAt));

  return rows
    .filter((row) => isStaleOrphanLoadingCandidate(row, { excludeMessageId, minAgeMs, nowMs }))
    .map((row) => row.id);
};
