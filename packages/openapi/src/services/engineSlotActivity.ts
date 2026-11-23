import { AsyncLocalStorage } from 'node:async_hooks';

import type { Context, Next } from 'hono';

interface HttpRequestTrackEntry {
  id: number;
  linkedToResponseExecution: boolean;
  method: string;
  path: string;
  startedAt: number;
}

interface ResponseExecutionTrackEntry {
  cancelled: boolean;
  id: number;
  isResumeFlow: boolean;
  operationId?: string;
  startedAt: number;
  topicId?: string;
  userId: string;
}

interface EngineSlotActivityState {
  als: AsyncLocalStorage<HttpRequestTrackEntry>;
  httpRequests: Map<number, HttpRequestTrackEntry>;
  responseExecutions: Map<number, ResponseExecutionTrackEntry>;
  seq: number;
}

interface EngineSlotActivityGlobal {
  __arckepEngineSlotActivity?: EngineSlotActivityState;
}

const globalForActivity = globalThis as unknown as EngineSlotActivityGlobal;

const getState = (): EngineSlotActivityState => {
  if (!globalForActivity.__arckepEngineSlotActivity) {
    globalForActivity.__arckepEngineSlotActivity = {
      als: new AsyncLocalStorage<HttpRequestTrackEntry>(),
      httpRequests: new Map(),
      responseExecutions: new Map(),
      seq: 0,
    };
  }
  return globalForActivity.__arckepEngineSlotActivity;
};

const isExcludedPath = (path: string): boolean => {
  if (path === '/health' || path === '/api/v1/health' || path === '/api/v1/health/') {
    return true;
  }
  if (
    path === '/api/v1/arckep/engine-slot' ||
    path.startsWith('/api/v1/arckep/engine-slot/') ||
    path === '/arckep/engine-slot' ||
    path.startsWith('/arckep/engine-slot/')
  ) {
    return true;
  }
  return false;
};

const isTrackedHttpMethod = (method: string): boolean => {
  const m = method.toUpperCase();
  return m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS';
};

/**
 * Tracks all mutating/working OpenAPI HTTP requests from byte 0 (before auth, attachment
 * resolution, or topic creation) until completion. Idempotent across nested Hono routers.
 */
export const engineSlotHttpActivityMiddleware = async (c: Context, next: Next) => {
  const state = getState();
  if (state.als.getStore()) {
    return next();
  }

  const reqPath = c.req.path || '';
  if (isExcludedPath(reqPath) || !isTrackedHttpMethod(c.req.method)) {
    return next();
  }

  const id = ++state.seq;
  const entry: HttpRequestTrackEntry = {
    id,
    linkedToResponseExecution: false,
    method: c.req.method.toUpperCase(),
    path: reqPath,
    startedAt: Date.now(),
  };
  state.httpRequests.set(id, entry);

  try {
    return await state.als.run(entry, () => next());
  } finally {
    state.httpRequests.delete(id);
  }
};

export interface ResponseExecutionTracker {
  finish: () => void;
  setOperation: (operationId?: string | null, topicId?: string | null) => void;
}

/**
 * Tracks an in-flight `ResponsesService` execution (`stream: false` or `stream: true`)
 * from service entry all the way through `.finally()` of `executeSync`.
 */
export const beginResponseExecution = (params: {
  initialTopicId?: string | null;
  isResumeFlow?: boolean;
  userId: string;
}): ResponseExecutionTracker => {
  const state = getState();
  const id = ++state.seq;
  const entry: ResponseExecutionTrackEntry = {
    cancelled: false,
    id,
    isResumeFlow: Boolean(params.isResumeFlow),
    startedAt: Date.now(),
    topicId: params.initialTopicId || undefined,
    userId: params.userId,
  };
  state.responseExecutions.set(id, entry);

  const enclosingHttp = state.als.getStore();
  if (enclosingHttp) {
    enclosingHttp.linkedToResponseExecution = true;
  }

  let finished = false;
  return {
    finish: () => {
      if (finished) return;
      finished = true;
      state.responseExecutions.delete(id);
    },
    setOperation: (operationId?: string | null, topicId?: string | null) => {
      if (finished) return;
      if (operationId) entry.operationId = operationId;
      if (topicId) entry.topicId = topicId;
    },
  };
};

export const markResponseExecutionCancelled = (userId: string, topicId: string): number => {
  if (!userId || !topicId) return 0;
  const state = getState();
  let count = 0;
  for (const entry of state.responseExecutions.values()) {
    if (entry.userId === userId && entry.topicId === topicId && !entry.cancelled) {
      entry.cancelled = true;
      count += 1;
    }
  }
  return count;
};

export const hasInFlightResponseTopic = (userId: string, topicId: string): boolean => {
  if (!userId || !topicId) return false;
  const state = getState();
  for (const entry of state.responseExecutions.values()) {
    if (entry.userId === userId && entry.topicId === topicId && !entry.cancelled) {
      return true;
    }
  }
  return false;
};

export const getInFlightResponseTopicsForUser = (userId: string): string[] => {
  if (!userId) return [];
  const state = getState();
  const topics = new Set<string>();
  for (const entry of state.responseExecutions.values()) {
    if (entry.userId === userId && entry.topicId && !entry.cancelled) {
      topics.add(entry.topicId);
    }
  }
  return [...topics];
};

export const getEngineSlotHttpAndResponseSnapshot = (
  hubActiveOperationIds: ReadonlySet<string>,
): {
  activeHttpRequests: number;
  extraActiveResponses: number;
  extraActiveTopicIds: string[];
  extraTopicSeqs: Record<string, number>;
} => {
  const state = getState();

  let extraActiveResponses = 0;
  const extraTopics = new Set<string>();
  const extraTopicSeqs: Record<string, number> = {};

  for (const exec of state.responseExecutions.values()) {
    if (exec.topicId) {
      extraTopics.add(exec.topicId);
      const prev = extraTopicSeqs[exec.topicId];
      if (prev === undefined || exec.startedAt >= prev) {
        extraTopicSeqs[exec.topicId] = exec.startedAt;
      }
    }
    if (!exec.operationId || !hubActiveOperationIds.has(exec.operationId)) {
      extraActiveResponses += 1;
    }
  }

  let activeHttpRequests = 0;
  for (const req of state.httpRequests.values()) {
    if (!req.linkedToResponseExecution) {
      activeHttpRequests += 1;
    }
  }

  return {
    activeHttpRequests,
    extraActiveResponses,
    extraActiveTopicIds: [...extraTopics],
    extraTopicSeqs,
  };
};

export const resetEngineSlotActivityForTests = (): void => {
  const state = getState();
  state.httpRequests.clear();
  state.responseExecutions.clear();
};
