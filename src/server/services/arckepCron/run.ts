import debug from 'debug';

import { AgentCronJobModel } from '@/database/models/agentCronJob';
import type { AgentCronJob } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
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
const CRON_ACTIVE_TTL_MS = 45 * 60 * 1000;

interface ActiveCronEntry {
  startedAt: number;
  topicId: string | null;
}

interface ArckepCronGlobal {
  __arckepActiveCronRuns?: Map<string, ActiveCronEntry>;
}

const globalForCron = globalThis as unknown as ArckepCronGlobal;
const activeCronRuns =
  globalForCron.__arckepActiveCronRuns ??
  (globalForCron.__arckepActiveCronRuns = new Map<string, ActiveCronEntry>());

let pendingCronSeq = 0;

const pruneActiveCronRuns = (now = Date.now()) => {
  for (const [opId, entry] of activeCronRuns) {
    if (now - entry.startedAt > CRON_ACTIVE_TTL_MS) {
      activeCronRuns.delete(opId);
    }
  }
};

export const getActiveCronSnapshot = (
  now = Date.now(),
): { activeCount: number; activeTopicIds: string[] } => {
  pruneActiveCronRuns(now);
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
  const ref: { completed?: boolean; operationId?: string; pendingKey: string; topicId?: string } = {
    pendingKey: `__starting_cron_${++pendingCronSeq}_${runId}`,
  };
  pruneActiveCronRuns();
  activeCronRuns.set(ref.pendingKey, { startedAt: Date.now(), topicId: null });

  const baseFinishedHook = createFinishedHook(job, runId, ref);
  const trackedFinishedHook: AgentHook = {
    ...baseFinishedHook,
    handler: async (event: AgentHookEvent) => {
      ref.completed = true;
      activeCronRuns.delete(ref.pendingKey);
      const opId = event.operationId || ref.operationId;
      if (opId) activeCronRuns.delete(opId);
      await baseFinishedHook.handler(event);
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
    const message = error instanceof Error ? error.message : String(error);
    log('execAgent threw for job %s run %s: %s', job.id, runId, message);
    return { error: message, operationId: null, success: false, topicId: null };
  }

  activeCronRuns.delete(ref.pendingKey);
  ref.operationId = result.operationId;
  ref.topicId = result.topicId;

  if (!result.success) {
    if (result.operationId) activeCronRuns.delete(result.operationId);
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
      startedAt: Date.now(),
      topicId: result.topicId ?? null,
    });
  }

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
