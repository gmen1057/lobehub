import { MemorySourceType, type ModelUsage } from '@lobechat/types';
import { and, eq, sql } from 'drizzle-orm';

import { UserModel } from '@/database/models/user';
import { UserPersonaModel } from '@/database/models/userMemory/persona';
import { topics } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { parseMemoryExtractionConfig } from '@/server/globalConfig/parseMemoryExtractionConfig';

import { MemoryExtractionExecutor } from './extract';
import { buildUserPersonaJobInput, UserPersonaService } from './persona/service';

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
  excludeTopicIds?: string[];
  idleMinutes: number;
  limit: number;
}

export interface AutoExtractCallBreakdown {
  inputCachedTokens: number;
  inputTokens: number;
  outputReasoningTokens: number;
  outputTokens: number;
  serviceTier?: string;
}

export interface AutoExtractUsage {
  calls: number;
  callsBreakdown?: AutoExtractCallBreakdown[];
  inputCachedTokens: number;
  inputTokens: number;
  outputReasoningTokens: number;
  outputTokens: number;
  /**
   * Режим, в котором прошёл суточный разбор: `flex` (цена Batch, −50 %) ТОЛЬКО если все вызовы прошли во `flex`,
   * иначе `default`. Нет поля — обычная цена. Студия списывает с человека по `callsBreakdown` / `serviceTier`.
   */
  serviceTier?: string;
}

export interface AutoExtractResult {
  extracted: number;
  failed: number;
  memories: number;
  topics: number;
  usage: AutoExtractUsage;
}

export const AUTO_EXTRACT_FAILED_KEY = 'arckepMemoryAutoFailedAt';

const PERSONA_MIN_MEMORIES = 5;
const PERSONA_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;

const buildExcludeTopicIdsClause = (excludeTopicIds?: string[]) => {
  const validIds = (excludeTopicIds ?? []).filter(
    (id): id is string => typeof id === 'string' && id.length > 0,
  );
  if (validIds.length === 0) return sql``;
  return sql`AND t.id NOT IN (${sql.join(
    validIds.map((id) => sql`${id}`),
    sql`, `,
  )})`;
};

export const listAutoExtractTopics = async (
  db: LobeChatDatabase,
  userId: string,
  { days, excludeTopicIds, idleMinutes, limit }: AutoExtractOptions,
): Promise<string[]> => {
  const excludeClause = buildExcludeTopicIdsClause(excludeTopicIds);
  // lastMessageAt пишется из JS с точностью до миллисекунд, а created_at в базе — до микросекунд: без запаса
  // в секунду каждая разобранная тема выглядела бы продолженной и разбиралась бы каждый час.
  const result = await db.execute(sql`
    SELECT t.id
    FROM topics t
    LEFT JOIN agents a
      ON a.id = t.agent_id AND a.user_id = t.user_id
    JOIN messages m
      ON m.topic_id = t.id AND m.user_id = t.user_id AND m.role IN ('user', 'assistant')
    WHERE t.user_id = ${userId}
      AND LOWER(COALESCE(a.chat_config -> 'memory' ->> 'enabled', 'true')) <> 'false'
      AND COALESCE(jsonb_typeof(t.metadata -> 'dataGuardProtected'), '') <> 'object'
      AND LOWER(COALESCE(t.metadata ->> 'dataGuardProtected', 'false')) <> 'true'
      AND COALESCE(jsonb_typeof(t.metadata -> 'arckepUntrusted'), '') <> 'object'
      AND LOWER(COALESCE(t.metadata ->> 'arckepUntrusted', 'false')) <> 'true'
      AND COALESCE(t.trigger, '') <> 'cron'
      ${excludeClause}
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

// ── суточный разбор (20.10.2026) ─────────────────────────────────────────────────────────────

/**
 * Владелец 20.10.2026: «кэш и отказ от повторов точно надо сделать. Пусть грузит все новые и с ними факты из прошлой
 * памяти и сравнивает… раз в день». Раз в сутки — один разбор на человека: все новые сообщения его затихших переписок
 * и вся прежняя память одним контекстом (`MemoryExtractionExecutor.extractUserDigest`). У продолженной переписки
 * берутся только сообщения после прошлого разбора — повторно ничего не разбирается.
 */
export interface DigestOptions {
  contextLimit: number;
  days: number;
  excludeTopicIds?: string[];
  idleMinutes: number;
  maxMemories: number;
  maxTopics: number;
}

// Разбор раз в сутки: упавшую тему повторяем на следующий день (20 ч — чтобы следующий ночной запуск её взял).
const DIGEST_FAILED_RETRY_HOURS = 20;

export const listDigestTopics = async (
  db: LobeChatDatabase,
  userId: string,
  {
    days,
    excludeTopicIds,
    idleMinutes,
    maxTopics,
  }: Pick<DigestOptions, 'days' | 'excludeTopicIds' | 'idleMinutes' | 'maxTopics'>,
): Promise<{ after?: Date; topicId: string }[]> => {
  const excludeClause = buildExcludeTopicIdsClause(excludeTopicIds);
  // Тот же отбор, что у ежечасного разбора, плюс «курсор»: до какого сообщения тема уже разобрана.
  const result = await db.execute(sql`
    SELECT t.id,
      CASE WHEN t.metadata ->> 'userMemoryExtractStatus' = 'completed'
        THEN t.metadata -> 'userMemoryExtractRunState' ->> 'lastMessageAt' END AS after
    FROM topics t
    LEFT JOIN agents a
      ON a.id = t.agent_id AND a.user_id = t.user_id
    JOIN messages m
      ON m.topic_id = t.id AND m.user_id = t.user_id AND m.role IN ('user', 'assistant')
    WHERE t.user_id = ${userId}
      AND LOWER(COALESCE(a.chat_config -> 'memory' ->> 'enabled', 'true')) <> 'false'
      AND COALESCE(jsonb_typeof(t.metadata -> 'dataGuardProtected'), '') <> 'object'
      AND LOWER(COALESCE(t.metadata ->> 'dataGuardProtected', 'false')) <> 'true'
      AND COALESCE(jsonb_typeof(t.metadata -> 'arckepUntrusted'), '') <> 'object'
      AND LOWER(COALESCE(t.metadata ->> 'arckepUntrusted', 'false')) <> 'true'
      AND COALESCE(t.trigger, '') <> 'cron'
      ${excludeClause}
      AND COALESCE((t.metadata ->> ${AUTO_EXTRACT_FAILED_KEY})::timestamptz, 'epoch'::timestamptz)
          < now() - make_interval(hours => ${DIGEST_FAILED_RETRY_HOURS})
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
    LIMIT ${maxTopics}
  `);

  return (result.rows as { after: string | null; id: string }[]).map((row) => ({
    after: row.after ? new Date(row.after) : undefined,
    topicId: row.id,
  }));
};

export const runDailyDigest = async (
  db: LobeChatDatabase,
  userId: string,
  options: DigestOptions,
): Promise<AutoExtractResult> => {
  const usage: AutoExtractUsage = {
    calls: 0,
    inputCachedTokens: 0,
    inputTokens: 0,
    outputReasoningTokens: 0,
    outputTokens: 0,
  };
  const result: AutoExtractResult = { extracted: 0, failed: 0, memories: 0, topics: 0, usage };

  const topicsList = await listDigestTopics(db, userId, options);
  if (!topicsList.length) return result;

  const callsBreakdown: AutoExtractCallBreakdown[] = [];
  const executor = await MemoryExtractionExecutor.create();
  executor.setUsageListener((item) => {
    addUsage(usage, item);
    callsBreakdown.push({
      inputCachedTokens: item.inputCachedTokens ?? 0,
      inputTokens: item.totalInputTokens ?? 0,
      outputReasoningTokens: item.outputReasoningTokens ?? 0,
      outputTokens: item.totalOutputTokens ?? 0,
    });
  });

  const digest = await executor.extractUserDigest({
    contextLimit: options.contextLimit,
    maxMemories: options.maxMemories,
    topics: topicsList,
    userId,
  });

  const digestTier = digest.serviceTier ?? 'default';
  for (const call of callsBreakdown) {
    call.serviceTier ??= digestTier;
  }

  result.topics = digest.topicIds.length;
  if (digest.error) {
    result.failed = digest.topicIds.length;
    if (callsBreakdown.length > 0) {
      usage.callsBreakdown = callsBreakdown;
      usage.serviceTier = callsBreakdown.every((c) => c.serviceTier === 'flex')
        ? 'flex'
        : 'default';
    }
    for (const topicId of digest.topicIds) await markAutoExtractFailed(db, userId, topicId);
    return result;
  }

  result.extracted = digest.extracted ? digest.topicIds.length : 0;
  result.memories = digest.memoryIds.length;

  if (digest.extracted || digest.memoryIds.length > 0) {
    try {
      const countRes = await db.execute(
        sql`SELECT COUNT(*)::int AS total FROM user_memories WHERE user_id = ${userId}`,
      );
      const totalMemories = Number(
        (countRes.rows as { total?: number }[] | undefined)?.[0]?.total ?? 0,
      );
      if (totalMemories >= PERSONA_MIN_MEMORIES) {
        const personaModel = new UserPersonaModel(db, userId);
        const latestPersona = await personaModel.getLatestPersonaDocument();
        const updatedAtMs = latestPersona?.updatedAt
          ? new Date(latestPersona.updatedAt).getTime()
          : Number.NaN;
        const shouldRefreshPersona =
          !latestPersona?.persona?.trim() ||
          !Number.isFinite(updatedAtMs) ||
          Date.now() - updatedAtMs >= PERSONA_REFRESH_MS;

        if (shouldRefreshPersona) {
          const extractionConfig = parseMemoryExtractionConfig();
          const jobInput = await buildUserPersonaJobInput(db, userId);
          let responseLanguage: string | undefined;
          try {
            const settings = await new UserModel(db, userId).getUserSettings();
            responseLanguage = (settings?.general as { responseLanguage?: string } | undefined)
              ?.responseLanguage;
          } catch {
            // non-critical
          }
          await new UserPersonaService(db).composeWriting(
            {
              ...jobInput,
              language: extractionConfig.language || responseLanguage,
              sourceIds: digest.topicIds,
              userId,
            },
            {
              observeDigestCalls: true,
              onUsage: (item, meta) => {
                addUsage(usage, item);
                callsBreakdown.push({
                  inputCachedTokens: item.inputCachedTokens ?? 0,
                  inputTokens: item.totalInputTokens ?? 0,
                  outputReasoningTokens: item.outputReasoningTokens ?? 0,
                  outputTokens: item.totalOutputTokens ?? 0,
                  serviceTier: meta?.serviceTier ?? 'default',
                });
              },
              reasoningEffort: extractionConfig.reasoningEffort,
              serviceTier: extractionConfig.serviceTier,
            },
          );
        }
      }
    } catch (error) {
      console.error('[memory-daily-digest] persona update failed', userId, error);
    }
  }

  if (callsBreakdown.length > 0) {
    usage.callsBreakdown = callsBreakdown;
    usage.serviceTier = callsBreakdown.every((call) => call.serviceTier === 'flex')
      ? 'flex'
      : 'default';
  } else if (digest.serviceTier) {
    usage.serviceTier = digest.serviceTier;
  }

  return result;
};
