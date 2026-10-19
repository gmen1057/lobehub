import debug from 'debug';

import type { AgentHookEvent } from '@/server/services/agentRuntime/hooks/types';

const log = debug('lobe-server:arckep-cron');

/**
 * arckep (19.10.2026, задачи помощника по расписанию): сообщить студии, что запуск задачи закончился.
 *
 * Вызывается из локального хука `onComplete` (без QStash) — исключения наружу не выходят: студия и без этого
 * раз в минуту закрывает запуски старше часа по состоянию переписки.
 */

export type ArckepCronFinishStatus = 'done' | 'error' | 'interrupted';

export interface ArckepCronFinishedPayload {
  cronJobId: string;
  error?: string;
  operationId: string;
  runId: string;
  status: ArckepCronFinishStatus;
  topicId: string | null;
}

const FINISHED_PATH = '/api/internal/chat-tasks/finished';
const ATTEMPTS = 3;
const RETRY_PAUSE_MS = 2000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_ERROR_LENGTH = 1000;

const getStudioUrl = () =>
  (process.env.IMAGE_STUDIO_API_URL || 'http://127.0.0.1:8202').replace(/\/$/, '');

const getInternalToken = () => process.env.ARCKEP_INTERNAL_TOKEN || process.env.LOBECHAT_BACKEND_KEY;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const cut = (text: string) => text.trim().slice(0, MAX_ERROR_LENGTH);

/** Часть события хука, по которой выводится итог (в событии `errorDetail` бывает и объектом). */
interface FinishEvent extends Pick<AgentHookEvent, 'errorMessage' | 'reason' | 'status'> {
  errorDetail?: unknown;
}

/**
 * Итог запуска из события хука. `reason`: done | error | interrupted | max_steps | cost_limit |
 * waiting_for_human. Всё, что не «готово» и не «ошибка» (в том числе упёрлись в предел шагов или цены),
 * студия получает как `interrupted` с причиной в `error`.
 */
export const resolveFinishStatus = (
  event: FinishEvent,
): { error?: string; status: ArckepCronFinishStatus } => {
  const reason = event.reason || event.status || 'done';

  if (reason === 'done') return { status: 'done' };

  if (reason === 'error') {
    const detail =
      event.errorMessage ||
      (typeof event.errorDetail === 'string'
        ? event.errorDetail
        : event.errorDetail
          ? JSON.stringify(event.errorDetail)
          : '');
    return { error: cut(detail || 'Agent run failed'), status: 'error' };
  }

  if (reason === 'interrupted') return { status: 'interrupted' };

  return { error: cut(`Stopped: ${reason}`), status: 'interrupted' };
};

interface NotifyOptions {
  attempts?: number;
  fetchImpl?: typeof fetch;
  retryPauseMs?: number;
  timeoutMs?: number;
}

/**
 * POST в студию: до трёх попыток с паузой. Повторяем сетевые сбои, 5xx, 408 и 429; остальные 4xx
 * (нет такого запуска, неверный ключ) повтором не лечатся. Возвращает true, если студия ответила 2xx.
 * Никогда не бросает.
 */
export const notifyCronFinished = async (
  payload: ArckepCronFinishedPayload,
  options: NotifyOptions = {},
): Promise<boolean> => {
  const {
    attempts = ATTEMPTS,
    fetchImpl = fetch,
    retryPauseMs = RETRY_PAUSE_MS,
    timeoutMs = REQUEST_TIMEOUT_MS,
  } = options;

  const token = getInternalToken();
  if (!token) {
    console.error('[arckep-cron] finished-hook: internal token is not configured');
    return false;
  }

  const url = `${getStudioUrl()}${FINISHED_PATH}`;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetchImpl(url, {
        body: JSON.stringify(payload),
        headers: { 'Content-Type': 'application/json', 'X-Arckep-Token': token },
        method: 'POST',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) {
        log('finished delivered: job=%s run=%s status=%s', payload.cronJobId, payload.runId, payload.status);
        return true;
      }
      const retryable = res.status >= 500 || res.status === 408 || res.status === 429;
      log('finished rejected: HTTP %d (attempt %d/%d)', res.status, attempt, attempts);
      if (!retryable) {
        console.error(
          `[arckep-cron] finished-hook: studio answered HTTP ${res.status} for run ${payload.runId}`,
        );
        return false;
      }
    } catch (error) {
      log('finished delivery failed (attempt %d/%d): %O', attempt, attempts, error);
    }
    if (attempt < attempts) await sleep(retryPauseMs);
  }

  console.error(`[arckep-cron] finished-hook: gave up on run ${payload.runId} after ${attempts} attempts`);
  return false;
};
