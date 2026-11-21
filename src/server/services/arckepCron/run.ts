import debug from 'debug';

import { AgentCronJobModel } from '@/database/models/agentCronJob';
import type { AgentCronJob } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { createAgentStateManager, isRedisAvailable } from '@/server/modules/AgentRuntime/factory';
import { inMemoryAgentStateManager } from '@/server/modules/AgentRuntime/InMemoryAgentStateManager';
import { getAgentRuntimeRedisClient } from '@/server/modules/AgentRuntime/redis';
import type { AgentHook, AgentHookEvent } from '@/server/services/agentRuntime/hooks/types';
import { AiAgentService } from '@/server/services/aiAgent';

import { notifyCronFinished, resolveFinishStatus } from './finished';
import { ARCKEP_CRON_DEFAULT_TIMEZONE } from './schedule';

const log = debug('lobe-server:arckep-cron');

/**
 * arckep (19.10.2026, задачи помощника по расписанию): один запуск задачи по просьбе студии.
 *
 * Запускающий цикл живёт в студии (раз в минуту, баланс, лимиты, `chat_task_runs`); движок только выполняет:
 * `execAgent` без человека и сообщает студии об окончании локальным хуком `onComplete`.
 */

export interface CronRunResult {
  error?: string;
  operationId: string | null;
  success: boolean;
  topicId: string | null;
}

const DEFAULT_TASK_NAME = 'Задача';

/** `dd.MM HH:mm` во времени пояса задачи; неверный пояс не должен ронять запуск — берём Москву. */
export const formatRunTime = (date: Date, timezone?: string | null): string => {
  const render = (timeZone: string) => {
    const parts = new Intl.DateTimeFormat('ru-RU', {
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
      minute: '2-digit',
      month: '2-digit',
      timeZone,
    }).formatToParts(date);
    const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
    return `${pick('day')}.${pick('month')} ${pick('hour')}:${pick('minute')}`;
  };
  try {
    return render(timezone || ARCKEP_CRON_DEFAULT_TIMEZONE);
  } catch {
    return render(ARCKEP_CRON_DEFAULT_TIMEZONE);
  }
};

export const buildRunTitle = (job: Pick<AgentCronJob, 'name' | 'timezone'>, now = new Date()) =>
  `${job.name?.trim() || DEFAULT_TASK_NAME} · ${formatRunTime(now, job.timezone)}`;

/**
 * Хук окончания: локальный handler, который сообщает студии итог. Идентификаторы переписки и операции берёт
 * из события, а если события их не несут — из `ref`, который заполняется сразу после `execAgent`.
 */
const createFinishedHook = (
  job: Pick<AgentCronJob, 'id'>,
  runId: string,
  ref: { operationId?: string; topicId?: string },
): AgentHook => ({
  handler: async (event: AgentHookEvent) => {
    try {
      const { error, status } = resolveFinishStatus(event);
      await notifyCronFinished({
        cronJobId: job.id,
        ...(error ? { error } : {}),
        operationId: event.operationId || ref.operationId || '',
        runId,
        status,
        topicId: event.topicId || ref.topicId || null,
      });
    } catch (error) {
      // Хук не должен ронять завершение операции.
      log('finished hook failed for run %s: %O', runId, error);
    }
  },
  id: `arckep-cron-finished-${runId}`,
  type: 'onComplete',
});

// Повтор того же runId (студия не дождалась ответа и повторила запрос) не запускает задачу второй раз.
const RUN_CACHE_TTL_MS = 15 * 60 * 1000;
const REDIS_RUN_TTL_SEC = 900;
const CRON_ACTIVE_TTL_MS = 45 * 60 * 1000;
const TERMINAL_RUNTIME_STATUSES = new Set(['done', 'error', 'interrupted']);

interface ActiveCronEntry {
  notifying?: boolean;
  startedAt: number;
  topicId: string | null;
}

interface RedisCronRunRecord {
  jobId: string;
  operationId: string | null;
  status: 'running' | 'starting';
  topicId: string | null;
  userId: string;
}

interface ArckepCronGlobal {
  __arckepActiveCronRuns?: Map<string, ActiveCronEntry>;
}

const globalForCron = globalThis as unknown as ArckepCronGlobal;
const activeCronRuns =
  globalForCron.__arckepActiveCronRuns ??
  (globalForCron.__arckepActiveCronRuns = new Map<string, ActiveCronEntry>());

let pendingCronSeq = 0;

const tryGetRedis = () => {
  try {
    return getAgentRuntimeRedisClient();
  } catch {
    return null;
  }
};

const isStartingKey = (opId: string) => opId.startsWith('__starting_cron_');

const isOperationActiveInMemorySync = (opId: string): boolean => {
  if (isStartingKey(opId)) return false;
  // Check inMemoryAgentStateManager synchronously when Redis is not in use
  const metaMap = (inMemoryAgentStateManager as unknown as { metadata?: Map<string, any> })
    ?.metadata;
  const meta = metaMap?.get(opId);
  if (!meta) return false;
  return !TERMINAL_RUNTIME_STATUSES.has(String(meta.status));
};

const pruneActiveCronRunsSync = (now = Date.now()) => {
  const redisEnabled = isRedisAvailable();
  for (const [opId, entry] of activeCronRuns) {
    if (entry.notifying) continue;
    if (now - entry.startedAt <= CRON_ACTIVE_TTL_MS) continue;
    // Never blindly delete >45m entries when Redis state manager is active (use async check)
    // or when the operation is still genuinely running in InMemoryAgentStateManager.
    if (redisEnabled && !isStartingKey(opId)) continue;
    if (isOperationActiveInMemorySync(opId)) continue;
    activeCronRuns.delete(opId);
  }
};

/**
 * Async refresh before slot `/status`: verifies aged (>45m) cron operations against
 * `AgentStateManager` (Redis or InMemory) so active long-running operations are NEVER dropped
 * while truly dead/orphaned entries are cleaned up.
 */
export const refreshActiveCronRuns = async (now = Date.now()): Promise<void> => {
  for (const [opId, entry] of activeCronRuns.entries()) {
    if (entry.notifying) continue;
    if (now - entry.startedAt <= CRON_ACTIVE_TTL_MS) continue;

    if (isStartingKey(opId)) {
      activeCronRuns.delete(opId);
      continue;
    }

    try {
      const stateManager = createAgentStateManager();
      const metadata = await stateManager.getOperationMetadata(opId);
      if (!metadata || TERMINAL_RUNTIME_STATUSES.has(metadata.status)) {
        activeCronRuns.delete(opId);
      }
    } catch (error) {
      log('refreshActiveCronRuns metadata check failed for %s: %O', opId, error);
    }
  }
};

export const getActiveCronSnapshot = (
  now = Date.now(),
): { activeCount: number; activeTopicIds: string[] } => {
  pruneActiveCronRunsSync(now);
  const topics = new Set<string>();
  for (const entry of activeCronRuns.values()) {
    if (entry.topicId) topics.add(entry.topicId);
  }
  return {
    activeCount: activeCronRuns.size,
    activeTopicIds: [...topics],
  };
};

export const clearActiveCronRuns = () => {
  activeCronRuns.clear();
};

const runCache = new Map<string, { at: number; promise: Promise<CronRunResult> }>();

const pruneRunCache = () => {
  const now = Date.now();
  for (const [key, entry] of runCache) {
    if (now - entry.at > RUN_CACHE_TTL_MS) runCache.delete(key);
  }
};

export const clearCronRunCache = () => {
  runCache.clear();
  activeCronRuns.clear();
};

const waitBriefly = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const resolveRedisDedupeKeys = (userId: string, jobId: string, runId: string) => ({
  primaryKey: `arckep:cron:run:${runId}`,
  scopedKey: `arckep:cron:run:${userId}:${jobId}:${runId}`,
});

const tryClaimCronRunInRedis = async (
  redis: NonNullable<ReturnType<typeof tryGetRedis>>,
  userId: string,
  jobId: string,
  runId: string,
): Promise<{ claimedKey: string | null; duplicateResult: CronRunResult | null }> => {
  const { primaryKey, scopedKey } = resolveRedisDedupeKeys(userId, jobId, runId);
  const startingPayload = JSON.stringify({
    jobId,
    operationId: null,
    status: 'starting',
    topicId: null,
    userId,
  } satisfies RedisCronRunRecord);

  try {
    const claimedPrimary = await redis.set(
      primaryKey,
      startingPayload,
      'EX',
      REDIS_RUN_TTL_SEC,
      'NX',
    );
    if (claimedPrimary === 'OK') {
      return { claimedKey: primaryKey, duplicateResult: null };
    }

    const rawExisting = await redis.get(primaryKey);
    if (rawExisting) {
      const parsed = JSON.parse(rawExisting) as Partial<RedisCronRunRecord>;
      if (parsed.userId === userId && parsed.jobId === jobId) {
        // Same (userId, jobId, runId) already started on another slot!
        if (parsed.status === 'starting') {
          for (let i = 0; i < 10; i++) {
            await waitBriefly(50);
            const updatedRaw = await redis.get(primaryKey);
            if (!updatedRaw) {
              // Other slot failed startup and deleted key — try claiming now
              const retryClaim = await redis.set(
                primaryKey,
                startingPayload,
                'EX',
                REDIS_RUN_TTL_SEC,
                'NX',
              );
              if (retryClaim === 'OK') {
                return { claimedKey: primaryKey, duplicateResult: null };
              }
              break;
            }
            const updated = JSON.parse(updatedRaw) as Partial<RedisCronRunRecord>;
            if (updated.status === 'running') {
              return {
                claimedKey: null,
                duplicateResult: {
                  operationId: updated.operationId ?? null,
                  success: true,
                  topicId: updated.topicId ?? null,
                },
              };
            }
          }
        }
        return {
          claimedKey: null,
          duplicateResult: {
            operationId: parsed.operationId ?? null,
            success: true,
            topicId: parsed.topicId ?? null,
          },
        };
      }
    }

    // Fallback scoped key when synthetic runId is reused across distinct (userId, jobId) pairs
    const claimedScoped = await redis.set(
      scopedKey,
      startingPayload,
      'EX',
      REDIS_RUN_TTL_SEC,
      'NX',
    );
    if (claimedScoped === 'OK') {
      return { claimedKey: scopedKey, duplicateResult: null };
    }

    const rawScoped = await redis.get(scopedKey);
    if (rawScoped) {
      const parsedScoped = JSON.parse(rawScoped) as Partial<RedisCronRunRecord>;
      return {
        claimedKey: null,
        duplicateResult: {
          operationId: parsedScoped.operationId ?? null,
          success: true,
          topicId: parsedScoped.topicId ?? null,
        },
      };
    }
  } catch (error) {
    log('Redis cron runId dedupe check failed for %s: %O', runId, error);
  }

  return { claimedKey: null, duplicateResult: null };
};

const updateCronRunInRedis = async (
  claimedKey: string | null,
  record: RedisCronRunRecord,
): Promise<void> => {
  if (!claimedKey) return;
  const redis = tryGetRedis();
  if (!redis) return;
  try {
    await redis.set(claimedKey, JSON.stringify(record), 'EX', REDIS_RUN_TTL_SEC);
  } catch (error) {
    log('Redis cron runId update failed for %s: %O', claimedKey, error);
  }
};

const releaseCronRunInRedis = async (claimedKey: string | null): Promise<void> => {
  if (!claimedKey) return;
  const redis = tryGetRedis();
  if (!redis) return;
  try {
    await redis.del(claimedKey);
  } catch (error) {
    log('Redis cron runId release failed for %s: %O', claimedKey, error);
  }
};

/** Модель и провайдер этого запуска; без них работает модель помощника. */
export interface CronRunModel {
  model: string;
  provider: string;
}

const startRun = async (
  db: LobeChatDatabase,
  userId: string,
  job: AgentCronJob,
  runId: string,
  modelOverride?: CronRunModel,
): Promise<CronRunResult> => {
  const startedAt = Date.now();
  const ref: {
    completed?: boolean;
    notifying?: boolean;
    operationId?: string;
    pendingKey: string;
    topicId?: string;
  } = {
    pendingKey: `__starting_cron_${++pendingCronSeq}_${runId}`,
  };
  pruneActiveCronRunsSync(startedAt);
  activeCronRuns.set(ref.pendingKey, { startedAt, topicId: null });

  const redis = tryGetRedis();
  let claimedKey: string | null = null;
  if (redis) {
    const claimRes = await tryClaimCronRunInRedis(redis, userId, job.id, runId);
    claimedKey = claimRes.claimedKey;
    if (claimRes.duplicateResult) {
      activeCronRuns.delete(ref.pendingKey);
      log('Deduplicated cross-slot cron runId=%s job=%s', runId, job.id);
      return claimRes.duplicateResult;
    }
  }

  const baseFinishedHook = createFinishedHook(job, runId, ref);
  const trackedFinishedHook: AgentHook = {
    ...baseFinishedHook,
    handler: async (event: AgentHookEvent) => {
      ref.notifying = true;
      const opId = event.operationId || ref.operationId;
      const existingPending = activeCronRuns.get(ref.pendingKey);
      if (existingPending) existingPending.notifying = true;
      if (opId) {
        const existingOp = activeCronRuns.get(opId);
        if (existingOp) {
          existingOp.notifying = true;
        } else {
          activeCronRuns.set(opId, {
            notifying: true,
            startedAt,
            topicId: event.topicId || ref.topicId || null,
          });
        }
      }

      try {
        await baseFinishedHook.handler(event);
      } finally {
        ref.notifying = false;
        ref.completed = true;
        activeCronRuns.delete(ref.pendingKey);
        const finalOpId = event.operationId || ref.operationId;
        if (finalOpId) activeCronRuns.delete(finalOpId);
      }
    },
  };

  let result: Awaited<ReturnType<AiAgentService['execAgent']>>;
  try {
    result = await new AiAgentService(db, userId).execAgent({
      agentId: job.agentId,
      autoStart: true,
      cronJobId: job.id,
      hooks: [trackedFinishedHook],
      ...(modelOverride ? { model: modelOverride.model, provider: modelOverride.provider } : {}),
      prompt: job.content,
      title: buildRunTitle(job),
      trigger: 'cron',
      userInterventionConfig: { approvalMode: 'headless' },
    });
  } catch (error) {
    activeCronRuns.delete(ref.pendingKey);
    await releaseCronRunInRedis(claimedKey);
    const message = error instanceof Error ? error.message : String(error);
    log('execAgent threw for job %s run %s: %s', job.id, runId, message);
    return { error: message, operationId: null, success: false, topicId: null };
  }

  ref.operationId = result.operationId;
  ref.topicId = result.topicId;

  if (!result.success) {
    activeCronRuns.delete(ref.pendingKey);
    if (result.operationId) activeCronRuns.delete(result.operationId);
    await releaseCronRunInRedis(claimedKey);
    // Операция не стартовала: исполнение не засчитываем, хук не сработает — студия закроет запуск сама.
    return {
      error: result.error || 'Agent operation failed to start',
      operationId: result.operationId ?? null,
      success: false,
      topicId: result.topicId ?? null,
    };
  }

  if (result.operationId && !ref.completed) {
    activeCronRuns.set(result.operationId, {
      notifying: Boolean(ref.notifying),
      startedAt,
      topicId: result.topicId ?? null,
    });
  }
  activeCronRuns.delete(ref.pendingKey);

  await updateCronRunInRedis(claimedKey, {
    jobId: job.id,
    operationId: result.operationId ?? null,
    status: 'running',
    topicId: result.topicId ?? null,
    userId,
  });

  try {
    await AgentCronJobModel.updateExecutionStats(db, job.id);
  } catch (error) {
    // Счётчики — не повод останавливать уже идущий запуск.
    log('updateExecutionStats failed for job %s: %O', job.id, error);
  }

  return { operationId: result.operationId, success: true, topicId: result.topicId };
};

/**
 * Запустить задачу сейчас. Не бросает: любая ошибка старта — `success: false` с текстом.
 * Повтор с тем же `runId` в течение 15 минут отдаёт прежний результат, пока он успешен или идёт.
 */
export const runCronJob = (
  db: LobeChatDatabase,
  userId: string,
  job: AgentCronJob,
  runId: string,
  modelOverride?: CronRunModel,
): Promise<CronRunResult> => {
  pruneRunCache();
  const key = `${userId}:${job.id}:${runId}`;
  const cached = runCache.get(key);
  if (cached) return cached.promise;

  const promise = startRun(db, userId, job, runId, modelOverride);
  runCache.set(key, { at: Date.now(), promise });
  // Неудачный старт не кэшируем: повтор с тем же runId имеет право попробовать ещё раз.
  void promise.then((result) => {
    if (!result.success && runCache.get(key)?.promise === promise) runCache.delete(key);
  });
  return promise;
};
