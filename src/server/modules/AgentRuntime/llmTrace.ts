import { type ChatStreamCallbacks, type ChatStreamPayload } from '@lobechat/model-runtime';
import { TraceNameMap, TraceTagMap } from '@lobechat/types';
import debug from 'debug';

import { createTraceOptions } from '@/server/modules/ModelRuntime';

const log = debug('lobe-server:agent-runtime:llm-trace');

/**
 * arckep (19.10.2026): трассировка Langfuse для серверного пути.
 *
 * Браузерный путь (`/webapi/chat/[provider]`) пишет трассу через `createTraceOptions`. Серверная
 * операция движка (чат студии после переключения 18.10, REST /responses, боты) вызывает модель сама, и
 * в Langfuse с тех пор ничего не попадало. Здесь — то же самое, но вне веб-запроса: трасса закрывается
 * без `after()` (outsideRequest), а её колбэки добавляются к существующим, ничего в них не заменяя.
 */

/** Колбэки трассы, которые дописываются к колбэкам серверного пути. */
const TRACE_CALLBACK_KEYS = ['onStart', 'onCompletion', 'onToolsCalling', 'onFinal'] as const;

type TraceCallbackKey = (typeof TRACE_CALLBACK_KEYS)[number];

export interface EngineTraceContext {
  provider: string;
  sessionId?: string;
  topicId?: string;
  userId?: string;
}

/**
 * Колбэки трассы для одного вызова модели; `undefined`, если трассировка выключена
 * (ENABLE_LANGFUSE !== '1') или не удалось её начать. Ошибка трассировки не должна ломать ответ.
 */
export const createEngineTraceCallbacks = (
  payload: ChatStreamPayload,
  { provider, sessionId, topicId, userId }: EngineTraceContext,
): ChatStreamCallbacks | undefined => {
  // process.env, а не getLangfuseConfig — как в браузерном маршруте: тесты остаются изолированными
  if (process.env.ENABLE_LANGFUSE !== '1') return undefined;

  try {
    return createTraceOptions(payload, {
      outsideRequest: true,
      provider,
      trace: {
        enabled: true,
        sessionId,
        tags: [TraceTagMap.Chat],
        topicId,
        traceName: TraceNameMap.EngineChat,
        userId,
      },
    }).callback;
  } catch (error) {
    log('failed to start langfuse trace: %O', error);
    console.error('[EngineTrace] failed to start langfuse trace:', error);
    return undefined;
  }
};

/**
 * Добавляет колбэки трассы к колбэкам серверного пути. Сначала всегда вызывается колбэк серверного
 * пути (как раньше), затем — трассировочный; его сбой гасится и в ответ не попадает. Остальные колбэки
 * серверного пути (onText, onError, onContentPart…) возвращаются как есть.
 */
export const withEngineTrace = (
  trace: ChatStreamCallbacks | undefined,
  callbacks: ChatStreamCallbacks,
): ChatStreamCallbacks => {
  if (!trace) return callbacks;

  const merged: ChatStreamCallbacks = { ...callbacks };
  const mergedAny = merged as Record<TraceCallbackKey, (...args: any[]) => Promise<void>>;

  for (const key of TRACE_CALLBACK_KEYS) {
    const traceCallback = trace[key] as ((...args: any[]) => unknown) | undefined;
    if (!traceCallback) continue;

    const original = callbacks[key] as ((...args: any[]) => unknown) | undefined;

    mergedAny[key] = async (...args: any[]) => {
      try {
        await original?.(...args);
      } finally {
        // трасса пишется даже если колбэк серверного пути упал; его ошибка уйдёт дальше как раньше
        try {
          await traceCallback(...args);
        } catch (error) {
          log('trace %s callback failed: %O', key, error);
          console.error(`[EngineTrace] ${key} failed:`, error);
        }
      }
    };
  }

  return merged;
};
