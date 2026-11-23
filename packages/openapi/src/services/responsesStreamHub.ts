import type { AgentState } from '@lobechat/agent-runtime';

import type {
  StreamChunkData,
  StreamEvent,
} from '@/server/modules/AgentRuntime/StreamEventManager';
import type { IStreamEventManager } from '@/server/modules/AgentRuntime/types';
import { abortLocalOperation } from '@/server/services/agentRuntime/operationInterruption';
import { setEngineSlotDraining } from '@/server/services/sandboxJobs/slotState';

import type { CreateResponseRequest } from '../types/responses.type';

/**
 * arckep (план chat-next-redesign, F8): реестр идущих ответов `/responses` в памяти процесса.
 *
 * Ответ считается движком в фоне и не зависит от соединения с клиентом. Раньше события шли в
 * менеджер, созданный на один HTTP-запрос: обрыв связи терял их, а второй клиент не мог
 * подключиться. Теперь все ответы публикуют события сюда: история хранится до конца ответа и ещё
 * `FINISHED_TTL_MS` после, чтобы клиент, вернувшийся в переписку, получил всё с начала и дочитал
 * живьём. Остановить ответ может только явный `cancel` (кнопка «Стоп»).
 */

export interface HubSubscriber {
  /** Ответ закончился (успехом, ошибкой или остановкой) — событий больше не будет. */
  onDone: () => void;
  onEvents: (events: StreamEvent[]) => void;
}

export interface HubOperation {
  bytes: number;
  /** Пользователь уже нажал «Стоп» и отмена принята — не блокировать новые сообщения до конца фоновой очистки. */
  cancelRequested: boolean;
  /** Секунды Unix — `created_at` ответа. */
  createdAt: number;
  done: boolean;
  events: StreamEvent[];
  finalState?: AgentState;
  /** Миллисекунды — когда ответ закончился (для чистки). */
  finishedAt?: number;
  onShutdownFinalize?: (
    reason: string,
    op: HubOperation,
  ) => Promise<AgentState | undefined> | AgentState | undefined;
  onShutdownInterrupt?: (reason: string) => Promise<void> | void;
  operationId: string;
  params: CreateResponseRequest;
  responseId: string;
  /** Порядок регистрации — чтобы среди ответов одной темы выбрать самый свежий. */
  seq: number;
  /** Миллисекунды — момент регистрации операции (для межслотового сравнения свежести темы). */
  startedAtMs: number;
  subscribers: Set<HubSubscriber>;
  topicId: string;
  /** История переполнилась (очень длинный ответ): переподключение невозможно, живой поток идёт дальше. */
  truncated: boolean;
  userId: string;
}

export interface HubShutdownSummary {
  finalized: number;
  forced: number;
  interrupted: number;
}

export interface HubAttachment {
  done: boolean;
  history: StreamEvent[];
  truncated: boolean;
  unsubscribe: () => void;
}

export interface HubDrainSnapshot {
  activeCount: number;
  activeTopicIds: string[];
  retainedTopicIds: string[];
  topicSeqs: Record<string, number>;
}

/** Сколько завершённый ответ остаётся доступным для переподключения. */
export const FINISHED_TTL_MS = 10 * 60 * 1000;
/** Потолок истории одной операции (символы текста событий). */
export const MAX_HISTORY_CHARS = 4 * 1024 * 1024;
/** Окно финализации активных стримов при SIGTERM (до systemd TimeoutStopSec=30). */
export const DEFAULT_GRACEFUL_SHUTDOWN_MS = 6000;

const isToolsCallingChunk = (event: StreamEvent | undefined): boolean =>
  event?.type === 'stream_chunk' &&
  typeof event.data === 'object' &&
  event.data !== null &&
  (event.data as StreamChunkData).chunkType === 'tools_calling';

const approxSize = (event: StreamEvent): number => {
  const data = event.data;
  if (event.type === 'stream_chunk' && data && typeof data === 'object') {
    const chunk = data as StreamChunkData;
    if (typeof chunk.content === 'string' && !chunk.toolsCalling) return chunk.content.length + 32;
    if (typeof chunk.reasoning === 'string' && !chunk.toolsCalling)
      return chunk.reasoning.length + 32;
  }
  try {
    return JSON.stringify(data ?? null).length + 32;
  } catch {
    return 256;
  }
};

export class ResponsesStreamHub implements IStreamEventManager {
  private operations = new Map<string, HubOperation>();
  private counter = 0;
  private readonly now: () => number;
  private readonly finishedTtlMs: number;
  private readonly maxHistoryChars: number;
  private shutdownPromise: Promise<HubShutdownSummary> | null = null;
  private doneWaiters = new Set<() => void>();

  constructor(options?: { finishedTtlMs?: number; maxHistoryChars?: number; now?: () => number }) {
    this.now = options?.now ?? Date.now;
    this.finishedTtlMs = options?.finishedTtlMs ?? FINISHED_TTL_MS;
    this.maxHistoryChars = options?.maxHistoryChars ?? MAX_HISTORY_CHARS;
  }

  // ==================== реестр ====================

  register(input: {
    onShutdownFinalize?: HubOperation['onShutdownFinalize'];
    onShutdownInterrupt?: HubOperation['onShutdownInterrupt'];
    operationId: string;
    params: CreateResponseRequest;
    responseId: string;
    topicId: string;
    userId: string;
  }): HubOperation {
    this.prune();
    this.counter += 1;
    const nowMs = this.now();
    const op: HubOperation = {
      ...input,
      bytes: 0,
      cancelRequested: false,
      createdAt: Math.floor(nowMs / 1000),
      done: false,
      events: [],
      seq: this.counter,
      startedAtMs: nowMs,
      subscribers: new Set(),
      truncated: false,
    };
    this.operations.set(input.operationId, op);
    return op;
  }

  /**
   * Принятая отмена ответа (кнопка «Стоп»): сразу помечает `cancelRequested`, обрывает
   * локальный AbortController и шлёт `operation_interrupted` подписчикам хаба.
   */
  requestCancel(operationId: string, reason: string = 'user_cancelled'): boolean {
    const op = this.operations.get(operationId);
    if (!op || op.done) return false;
    const alreadyRequested = op.cancelRequested;
    op.cancelRequested = true;
    abortLocalOperation(operationId, reason);
    if (!alreadyRequested) {
      void this.publishStreamEvent(operationId, {
        data: { reason },
        stepIndex: 0,
        type: 'operation_interrupted',
      });
    }
    return !alreadyRequested;
  }

  /** Ответ закончился: подписчики узнают об этом и отписываются; история живёт ещё `finishedTtlMs`. */
  markDone(operationId: string, finalState?: AgentState): void {
    const op = this.operations.get(operationId);
    if (!op || op.done) return;
    op.done = true;
    op.finalState = finalState;
    op.finishedAt = this.now();
    const subscribers = [...op.subscribers];
    op.subscribers.clear();
    for (const subscriber of subscribers) {
      try {
        subscriber.onDone();
      } catch (error) {
        console.error('[ResponsesStreamHub] onDone error:', error);
      }
    }
    if (this.doneWaiters.size > 0) {
      for (const notify of this.doneWaiters) {
        try {
          notify();
        } catch {
          // ignore waiter errors
        }
      }
    }
  }

  isShuttingDown(): boolean {
    return this.shutdownPromise !== null;
  }

  /**
   * Graceful drain при получении SIGTERM:
   * 1. Переводит слот в draining (`setEngineSlotDraining(true)`).
   * 2. Сигналит активным операциям (`operation_interrupted` + `onShutdownInterrupt`), чтобы
   *    `RuntimeExecutors` сохранил уже полученный платный частичный ответ (`preservePartialResponse`).
   * 3. Ждёт до `graceWindowMs` (по умолчанию 6 с, строго меньше systemd TimeoutStopSec=30).
   * 4. Для операций, где ответ остался пустым (`LOADING_FLAT` без текста/инструментов), вызывает
   *    `onShutdownFinalize` для записи явной причины перезапуска сервера в `messages.error`,
   *    и принудительно закрывает оставшихся подписчиков через `markDone` (без обрыва чанков HTTP).
   */
  async gracefulShutdown(
    reason: string = 'SIGTERM',
    options?: { graceWindowMs?: number },
  ): Promise<HubShutdownSummary> {
    if (this.shutdownPromise) return this.shutdownPromise;

    const graceWindowMs = options?.graceWindowMs ?? DEFAULT_GRACEFUL_SHUTDOWN_MS;
    this.shutdownPromise = (async (): Promise<HubShutdownSummary> => {
      try {
        setEngineSlotDraining(true);
      } catch {
        // non-fatal in isolated test environments
      }

      const activeOps = [...this.operations.values()].filter((op) => !op.done);
      if (activeOps.length === 0) {
        return { finalized: 0, forced: 0, interrupted: 0 };
      }

      await Promise.allSettled(
        activeOps.map(async (op) => {
          await this.publishStreamEvent(op.operationId, {
            data: { reason },
            stepIndex: 0,
            type: 'operation_interrupted',
          });
          await op.onShutdownInterrupt?.(reason);
        }),
      );

      if (activeOps.some((op) => !op.done) && graceWindowMs > 0) {
        await new Promise<void>((resolve) => {
          const checkAllDone = () => {
            if (activeOps.every((op) => op.done)) {
              cleanup();
              resolve();
            }
          };
          const timer = setTimeout(() => {
            cleanup();
            resolve();
          }, graceWindowMs);
          timer.unref?.();
          const cleanup = () => {
            clearTimeout(timer);
            this.doneWaiters.delete(checkAllDone);
          };
          this.doneWaiters.add(checkAllDone);
          checkAllDone();
        });
      }

      let finalized = 0;
      let forced = 0;

      await Promise.allSettled(
        activeOps.map(async (op) => {
          let fallbackState: AgentState | undefined;
          if (op.onShutdownFinalize) {
            try {
              fallbackState = await Promise.race([
                Promise.resolve(op.onShutdownFinalize(reason, op)),
                new Promise<undefined>((resolve) => {
                  const t = setTimeout(() => resolve(undefined), 1500);
                  t.unref?.();
                }),
              ]);
              finalized += 1;
            } catch (finalizeError) {
              console.error('[ResponsesStreamHub] onShutdownFinalize error:', finalizeError);
            }
          }

          if (!op.done) {
            forced += 1;
            this.markDone(
              op.operationId,
              fallbackState ??
                ({
                  error: {
                    body: { code: 'provider_unavailable', reason: 'server_shutdown', status: 503 },
                    message:
                      'Модель временно недоступна из-за перезапуска сервера. Попробуйте ещё раз.',
                    type: 503,
                  },
                  status: 'error',
                } as unknown as AgentState),
            );
          } else if (fallbackState) {
            op.finalState = fallbackState;
          }
        }),
      );

      return {
        finalized,
        forced,
        interrupted: activeOps.length,
      };
    })();

    return this.shutdownPromise;
  }

  get(operationId: string): HubOperation | undefined {
    return this.operations.get(operationId);
  }

  /** Ответ темы этого человека: идущий (и не отменённый), иначе самый свежий по seq (пока не вычищен). */
  findByTopic(userId: string, topicId: string): HubOperation | undefined {
    this.prune();
    let best: HubOperation | undefined;
    const isActive = (o: HubOperation) => !o.done && !o.cancelRequested;
    for (const op of this.operations.values()) {
      if (op.userId !== userId || op.topicId !== topicId) continue;
      if (!best) {
        best = op;
        continue;
      }
      const bestActive = isActive(best);
      const opActive = isActive(op);
      if (bestActive !== opActive) {
        if (!bestActive) best = op;
        continue;
      }
      if (op.seq > best.seq) best = op;
    }
    return best;
  }

  /** Темы человека, в которых ответ ещё идёт и не был отменён. */
  runningTopics(userId: string): string[] {
    const out = new Set<string>();
    for (const op of this.operations.values()) {
      if (op.userId === userId && !op.done && !op.cancelRequested) out.add(op.topicId);
    }
    return [...out];
  }

  /** Чистый неразрушающий снимок состояния хаба для Blue-Green дренирования слота. */
  getDrainSnapshot(): HubDrainSnapshot {
    this.prune();
    let activeCount = 0;
    const activeTopics = new Set<string>();
    const retainedTopics = new Set<string>();
    const topicSeqs: Record<string, number> = {};

    for (const op of this.operations.values()) {
      if (op.topicId) {
        retainedTopics.add(op.topicId);
        const prev = topicSeqs[op.topicId];
        if (prev === undefined || op.startedAtMs >= prev) {
          topicSeqs[op.topicId] = op.startedAtMs;
        }
      }
      if (!op.done) {
        activeCount += 1;
        if (op.topicId) activeTopics.add(op.topicId);
      }
    }

    return {
      activeCount,
      activeTopicIds: [...activeTopics],
      retainedTopicIds: [...retainedTopics],
      topicSeqs,
    };
  }

  /** Идентификаторы активных (!done) операций в хабе (для дедупликации с in-flight трекером). */
  getActiveOperationIds(): Set<string> {
    const out = new Set<string>();
    for (const op of this.operations.values()) {
      if (!op.done) out.add(op.operationId);
    }
    return out;
  }

  /** Есть ли тема в реестре слота (активная или ещё хранимая в пределах FINISHED_TTL_MS). */
  hasTopic(topicId: string, opts?: { activeOnly?: boolean }): boolean {
    if (!topicId) return false;
    this.prune();
    const activeOnly = Boolean(opts?.activeOnly);

    for (const op of this.operations.values()) {
      if (op.topicId !== topicId) continue;
      if (activeOnly && op.done) continue;
      return true;
    }

    return false;
  }

  /**
   * История и живая подписка одним синхронным вызовом: между ними нет `await`, поэтому события
   * не теряются и не дублируются. У завершённого ответа подписки нет — только история.
   */
  attach(operationId: string, subscriber: HubSubscriber): HubAttachment {
    const op = this.operations.get(operationId);
    if (!op) return { done: true, history: [], truncated: false, unsubscribe: () => undefined };
    if (!op.done) op.subscribers.add(subscriber);
    return {
      done: op.done,
      history: op.events.slice(),
      truncated: op.truncated,
      unsubscribe: () => {
        op.subscribers.delete(subscriber);
      },
    };
  }

  /** Забыть завершённые ответы старше `finishedTtlMs`. */
  prune(): number {
    const deadline = this.now() - this.finishedTtlMs;
    let removed = 0;
    for (const [id, op] of this.operations) {
      if (op.done && (op.finishedAt ?? 0) <= deadline) {
        this.operations.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  /** Для тестов. */
  clear(): void {
    this.operations.clear();
    this.counter = 0;
    this.shutdownPromise = null;
    this.doneWaiters.clear();
  }

  // ==================== IStreamEventManager ====================

  async publishStreamEvent(
    operationId: string,
    event: Omit<StreamEvent, 'operationId' | 'timestamp'>,
  ): Promise<string> {
    this.counter += 1;
    const data: StreamEvent = {
      ...event,
      id: `${this.now()}-${this.counter}`,
      operationId,
      timestamp: this.now(),
    };
    const op = this.operations.get(operationId);
    if (op) {
      if (!op.truncated) {
        const newSize = approxSize(data);
        const lastEvent = op.events.at(-1);
        const replaceLast =
          isToolsCallingChunk(data) &&
          isToolsCallingChunk(lastEvent) &&
          lastEvent!.stepIndex === data.stepIndex;

        if (replaceLast) {
          const prevSize = approxSize(lastEvent!);
          op.bytes = Math.max(0, op.bytes - prevSize + newSize);
        } else {
          op.bytes += newSize;
        }

        if (op.bytes > this.maxHistoryChars) {
          op.truncated = true;
          op.events = [];
          console.warn('[ResponsesStreamHub] history truncated', {
            bytes: op.bytes,
            operationId,
            topicId: op.topicId,
          });
        } else if (replaceLast) {
          op.events[op.events.length - 1] = data;
        } else {
          op.events.push(data);
        }
      }
      for (const subscriber of op.subscribers) {
        try {
          subscriber.onEvents([data]);
        } catch (error) {
          console.error('[ResponsesStreamHub] subscriber error:', error);
        }
      }
    }
    return data.id!;
  }

  async publishStreamChunk(
    operationId: string,
    stepIndex: number,
    chunkData: StreamChunkData,
  ): Promise<string> {
    return this.publishStreamEvent(operationId, {
      data: chunkData,
      stepIndex,
      type: 'stream_chunk',
    });
  }

  async publishAgentRuntimeInit(operationId: string, initialState: any): Promise<string> {
    return this.publishStreamEvent(operationId, {
      data: initialState,
      stepIndex: 0,
      type: 'agent_runtime_init',
    });
  }

  async publishAgentRuntimeEnd(
    operationId: string,
    stepIndex: number,
    finalState: any,
    reason?: string,
    reasonDetail?: string,
  ): Promise<string> {
    return this.publishStreamEvent(operationId, {
      data: {
        finalState,
        operationId,
        phase: 'execution_complete',
        reason: reason || 'completed',
        reasonDetail: reasonDetail || finalState?.error?.message || reason || 'completed',
      },
      stepIndex,
      type: 'agent_runtime_end',
    });
  }

  async getStreamHistory(operationId: string, count: number = 100): Promise<StreamEvent[]> {
    return (this.operations.get(operationId)?.events ?? []).slice(-count).reverse();
  }

  /** Движок удаляет операцию (`deleteAgentOperation`) — историю ответа это не трогает, она живёт до чистки. */
  async cleanupOperation(_operationId: string): Promise<void> {}

  async getActiveOperationsCount(): Promise<number> {
    let count = 0;
    for (const op of this.operations.values()) if (!op.done) count += 1;
    return count;
  }

  async disconnect(): Promise<void> {}

  async subscribeStreamEvents(
    operationId: string,
    _lastEventId: string,
    onEvents: (events: StreamEvent[]) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      const attachment = this.attach(operationId, {
        onDone: () => resolve(),
        onEvents,
      });
      if (attachment.history.length > 0) onEvents(attachment.history);
      if (attachment.done) {
        resolve();
        return;
      }
      if (signal) {
        const onAbort = () => {
          attachment.unsubscribe();
          resolve();
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }
}

interface ResponsesStreamHubGlobal {
  __arckepResponsesStreamHub?: ResponsesStreamHub;
  __arckepResponsesStreamHubSigtermCleanup?: (() => void) | null;
}

const globalForHub = globalThis as unknown as ResponsesStreamHubGlobal;

/** Один реестр на процесс: к нему ходят и отправка, и переподключение, и состояние ответа. */
export const responsesStreamHub =
  globalForHub.__arckepResponsesStreamHub ??
  (globalForHub.__arckepResponsesStreamHub = new ResponsesStreamHub());

// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
type SigtermListenerFn = Function;

export interface SigtermTargetLike {
  listeners?: (event: 'SIGTERM') => SigtermListenerFn[];
  off?: (event: 'SIGTERM', listener: (...args: any[]) => any) => any;
  on?: (event: 'SIGTERM', listener: (...args: any[]) => any) => any;
  once: (event: 'SIGTERM', listener: (...args: any[]) => any) => any;
  removeListener?: (event: 'SIGTERM', listener: (...args: any[]) => any) => any;
}

/**
 * Registers a single idempotent SIGTERM listener (safe across HMR and test reloads).
 * If Next.js standalone's `start-server` `cleanup` listener is already registered on `target`,
 * awaits `hub.gracefulShutdown('SIGTERM')` BEFORE invoking Next's `cleanup('SIGTERM')` so even
 * detached background streams (`0` open HTTP connections) persist partial responses before exit.
 */
export const registerResponsesStreamHubSigtermHandler = (
  hub: ResponsesStreamHub = responsesStreamHub,
  target: SigtermTargetLike | undefined = typeof process !== 'undefined' ? process : undefined,
): (() => void) => {
  if (!target || typeof target.once !== 'function') {
    return () => undefined;
  }

  const isGlobalProcess = typeof process !== 'undefined' && target === process;
  if (isGlobalProcess && globalForHub.__arckepResponsesStreamHubSigtermCleanup) {
    return globalForHub.__arckepResponsesStreamHubSigtermCleanup;
  }

  const removeFn = target.off?.bind(target) ?? target.removeListener?.bind(target);
  const existingListeners = target.listeners ? [...target.listeners('SIGTERM')] : [];
  const nextJsCleanupListeners = existingListeners.filter(
    (fn) => typeof fn === 'function' && fn.name === 'cleanup',
  );

  if (removeFn && nextJsCleanupListeners.length > 0) {
    for (const fn of nextJsCleanupListeners) {
      removeFn('SIGTERM', fn as (...args: any[]) => any);
    }
  }

  let handled = false;
  const onSigterm = () => {
    if (handled) return;
    handled = true;
    void hub
      .gracefulShutdown('SIGTERM')
      .catch((error) => {
        console.error('[ResponsesStreamHub] SIGTERM gracefulShutdown error:', error);
      })
      .finally(() => {
        for (const fn of nextJsCleanupListeners) {
          try {
            (fn as (signal: 'SIGTERM') => unknown)('SIGTERM');
          } catch (error) {
            console.error('[ResponsesStreamHub] Delegated SIGTERM cleanup error:', error);
          }
        }
      });
  };

  target.once('SIGTERM', onSigterm);

  const unregister = () => {
    if (removeFn) {
      removeFn('SIGTERM', onSigterm);
      if (!handled && target.on && nextJsCleanupListeners.length > 0) {
        for (const fn of nextJsCleanupListeners) {
          target.on('SIGTERM', fn as (...args: any[]) => any);
        }
      }
    }
    if (isGlobalProcess && globalForHub.__arckepResponsesStreamHubSigtermCleanup === unregister) {
      globalForHub.__arckepResponsesStreamHubSigtermCleanup = null;
    }
  };

  if (isGlobalProcess) {
    globalForHub.__arckepResponsesStreamHubSigtermCleanup = unregister;
  }

  return unregister;
};

if (typeof process !== 'undefined' && !process.env.VITEST) {
  registerResponsesStreamHubSigtermHandler(responsesStreamHub, process);
}
