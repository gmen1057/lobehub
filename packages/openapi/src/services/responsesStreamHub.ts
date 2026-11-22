import type { AgentState } from '@lobechat/agent-runtime';

import type {
  StreamChunkData,
  StreamEvent,
} from '@/server/modules/AgentRuntime/StreamEventManager';
import type { IStreamEventManager } from '@/server/modules/AgentRuntime/types';

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
  /** Секунды Unix — `created_at` ответа. */
  createdAt: number;
  done: boolean;
  events: StreamEvent[];
  finalState?: AgentState;
  /** Миллисекунды — когда ответ закончился (для чистки). */
  finishedAt?: number;
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

  constructor(options?: { finishedTtlMs?: number; maxHistoryChars?: number; now?: () => number }) {
    this.now = options?.now ?? Date.now;
    this.finishedTtlMs = options?.finishedTtlMs ?? FINISHED_TTL_MS;
    this.maxHistoryChars = options?.maxHistoryChars ?? MAX_HISTORY_CHARS;
  }

  // ==================== реестр ====================

  register(input: {
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
  }

  get(operationId: string): HubOperation | undefined {
    return this.operations.get(operationId);
  }

  /** Ответ темы этого человека: идущий, иначе самый свежий из завершённых (пока не вычищен). */
  findByTopic(userId: string, topicId: string): HubOperation | undefined {
    this.prune();
    let best: HubOperation | undefined;
    for (const op of this.operations.values()) {
      if (op.userId !== userId || op.topicId !== topicId) continue;
      if (!best) {
        best = op;
        continue;
      }
      if (best.done !== op.done) {
        if (best.done) best = op;
        continue;
      }
      if (op.seq > best.seq) best = op;
    }
    return best;
  }

  /** Темы человека, в которых ответ ещё идёт. */
  runningTopics(userId: string): string[] {
    const out = new Set<string>();
    for (const op of this.operations.values()) {
      if (op.userId === userId && !op.done) out.add(op.topicId);
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
}

const globalForHub = globalThis as unknown as ResponsesStreamHubGlobal;

/** Один реестр на процесс: к нему ходят и отправка, и переподключение, и состояние ответа. */
export const responsesStreamHub =
  globalForHub.__arckepResponsesStreamHub ??
  (globalForHub.__arckepResponsesStreamHub = new ResponsesStreamHub());
