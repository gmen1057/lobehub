import { MemorySourceType, type ModelUsage } from '@lobechat/types';
import { and, eq, sql } from 'drizzle-orm';

import { topics } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';

import { MemoryExtractionExecutor } from './extract';

/**
 * arckep (20.10.2026): автосбор памяти без Upstash. Штатный запуск движка — только Upstash Workflow и сразу у всех
 * с включённой памятью; у нас человек включает его сам («Запоминать автоматически» = `userSettings.memory.autoExtract`),
 * а студия раз в час зовёт `POST /api/v1/memories/extract` на каждого такого человека. Разбор идёт прямо в запросе.
 *
 * Какие темы берём: есть вопрос человека; последний вопрос или ответ не новее `idleMinutes` (разговор затих)
 * и не старше `days`; тема не разобрана или в ней появились сообщения после прошлого разбора. Тему, на которой разбор
 * упал, повторяем не чаще раза в сутки (`arckepMemoryAutoFailedAt`): иначе платили бы за неё каждый час.
 */

export interface AutoExtractOptions {
  days: number;
  idleMinutes: number;
  limit: number;
}

export interface AutoExtractUsage {
  calls: number;
  inputCachedTokens: number;
  inputTokens: number;
  outputReasoningTokens: number;
  outputTokens: number;
}

export interface AutoExtractResult {
  extracted: number;
  failed: number;
  memories: number;
  topics: number;
  usage: AutoExtractUsage;
}

export const AUTO_EXTRACT_FAILED_KEY = 'arckepMemoryAutoFailedAt';

export const listAutoExtractTopics = async (
  db: LobeChatDatabase,
  userId: string,
  { days, idleMinutes, limit }: AutoExtractOptions,
): Promise<string[]> => {
  // lastMessageAt пишется из JS с точностью до миллисекунд, а created_at в базе — до микросекунд: без запаса
  // в секунду каждая разобранная тема выглядела бы продолженной и разбиралась бы каждый час.
  const result = await db.execute(sql`
    SELECT t.id
    FROM topics t
    JOIN messages m
      ON m.topic_id = t.id AND m.user_id = t.user_id AND m.role IN ('user', 'assistant')
    WHERE t.user_id = ${userId}
      AND COALESCE((t.metadata ->> ${AUTO_EXTRACT_FAILED_KEY})::timestamptz, 'epoch'::timestamptz)
          < now() - interval '24 hours'
    GROUP BY t.id, t.metadata
    HAVING bool_or(m.role = 'user')
      AND max(m.created_at) <= now() - make_interval(mins => ${idleMinutes})
      AND max(m.created_at) >= now() - make_interval(days => ${days})
      AND (
        t.metadata ->> 'userMemoryExtractStatus' IS DISTINCT FROM 'completed'
        OR max(m.created_at) > COALESCE(
          (t.metadata -> 'userMemoryExtractRunState' ->> 'lastMessageAt')::timestamptz,
          'epoch'::timestamptz
        ) + interval '1 second'
      )
    ORDER BY max(m.created_at) DESC
    LIMIT ${limit}
  `);

  return (result.rows as { id: string }[]).map((row) => row.id);
};

const markAutoExtractFailed = async (db: LobeChatDatabase, userId: string, topicId: string) => {
  const patch = JSON.stringify({ [AUTO_EXTRACT_FAILED_KEY]: new Date().toISOString() });
  await db
    .update(topics)
    .set({
      metadata: sql`(CASE WHEN jsonb_typeof(${topics.metadata}) = 'object' THEN ${topics.metadata} ELSE '{}'::jsonb END) || ${patch}::jsonb`,
      updatedAt: topics.updatedAt,
    })
    .where(and(eq(topics.id, topicId), eq(topics.userId, userId)));
};

const addUsage = (total: AutoExtractUsage, usage: ModelUsage) => {
  total.calls += 1;
  total.inputTokens += usage.totalInputTokens ?? 0;
  total.inputCachedTokens += usage.inputCachedTokens ?? 0;
  total.outputTokens += usage.totalOutputTokens ?? 0;
  total.outputReasoningTokens += usage.outputReasoningTokens ?? 0;
};

export const runAutoExtract = async (
  db: LobeChatDatabase,
  userId: string,
  options: AutoExtractOptions,
): Promise<AutoExtractResult> => {
  const usage: AutoExtractUsage = {
    calls: 0,
    inputCachedTokens: 0,
    inputTokens: 0,
    outputReasoningTokens: 0,
    outputTokens: 0,
  };
  const result: AutoExtractResult = { extracted: 0, failed: 0, memories: 0, topics: 0, usage };

  const topicIds = await listAutoExtractTopics(db, userId, options);
  if (!topicIds.length) return result;

  const executor = await MemoryExtractionExecutor.create();
  executor.setUsageListener((item) => addUsage(usage, item));

  // По одной теме: упавшая не мешает остальным и помечается, чтобы не повторяться каждый час.
  for (const topicId of topicIds) {
    result.topics += 1;
    try {
      const extracted = await executor.extractTopic({
        forceAll: false,
        forceTopics: true,
        layers: [],
        source: MemorySourceType.ChatTopic,
        topicId,
        userId,
      });
      if (extracted.extracted) result.extracted += 1;
      result.memories += extracted.memoryIds?.length ?? 0;
    } catch (error) {
      result.failed += 1;
      console.error('[memory-auto-extract] topic failed', topicId, error);
      await markAutoExtractFailed(db, userId, topicId);
    }
  }

  return result;
};
