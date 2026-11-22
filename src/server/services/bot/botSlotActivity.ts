import { AsyncLocalStorage } from 'node:async_hooks';

import debug from 'debug';

import type { LobeChatDatabase } from '@/database/type';

const log = debug('lobe-server:bot:slot-activity');

const BOT_ACTIVE_THREAD_PREFIX = 'arckep:bot:active_thread:';
const BOT_STOP_REQUEST_PREFIX = 'arckep:bot:stop_requested:';
const BOT_ACTIVE_THREAD_TTL_SEC = 2100;
const BOT_STOP_REQUEST_TTL_SEC = 120;
const LOCAL_BOT_WORK_SAFETY_TTL_MS = 2 * 60 * 60 * 1000; // 2h safety cap against leaked orphan tokens
const TERMINAL_STATUSES = new Set(['done', 'error', 'interrupted']);

export interface BotThreadScope {
  applicationId?: string | null;
  platform?: string | null;
  threadId: string;
}

export interface BotWebhookTrackingContext {
  waitUntil: (task: Promise<unknown>) => void;
}

interface BotWebhookStore {
  activeThreadRunCount: number;
  id: number;
  pendingTasks: Set<Promise<unknown>>;
  waitUntil: (task: Promise<unknown>) => void;
}

interface BotThreadRunEntry {
  agentId: string;
  applicationId: string;
  id: number;
  operationId?: string;
  platform: string;
  queueMode: boolean;
  scopedKey: string;
  startedAt: number;
  threadId: string;
  token: string;
  topicId?: string;
  userId: string;
}

interface PersistedBotThreadRecord {
  agentId: string;
  applicationId: string;
  operationId?: string | null;
  platform: string;
  startedAt: number;
  threadId: string;
  token: string;
  topicId?: string | null;
  userId: string;
}

interface LocalBotOperationWorkEntry {
  id: number;
  operationId?: string;
  scopedKey?: string;
  startedAt: number;
  topicId?: string;
}

interface BotSlotActivityState {
  als: AsyncLocalStorage<BotWebhookStore>;
  localWorks: Map<number, LocalBotOperationWorkEntry>;
  seq: number;
  threadRuns: Map<string, BotThreadRunEntry>;
  webhooks: Map<number, BotWebhookStore>;
}

interface BotSlotActivityGlobal {
  __arckepBotSlotActivity?: BotSlotActivityState;
}

const globalForBotSlot = globalThis as unknown as BotSlotActivityGlobal;

const getState = (): BotSlotActivityState => {
  if (!globalForBotSlot.__arckepBotSlotActivity) {
    globalForBotSlot.__arckepBotSlotActivity = {
      als: new AsyncLocalStorage<BotWebhookStore>(),
      localWorks: new Map(),
      seq: 0,
      threadRuns: new Map(),
      webhooks: new Map(),
    };
  } else if (!globalForBotSlot.__arckepBotSlotActivity.localWorks) {
    globalForBotSlot.__arckepBotSlotActivity.localWorks = new Map();
  }
  return globalForBotSlot.__arckepBotSlotActivity;
};

const normalizeScope = (scope: BotThreadScope) => {
  const inferredPlatform = scope.threadId.includes(':') ? scope.threadId.split(':')[0] : '';
  const platform = (scope.platform || inferredPlatform || 'unknown').trim() || 'unknown';
  const applicationId = (scope.applicationId || 'default').trim() || 'default';
  return {
    applicationId,
    platform,
    threadId: scope.threadId,
  };
};

export const buildScopedBotThreadKey = (scope: BotThreadScope): string => {
  const norm = normalizeScope(scope);
  return `${norm.platform}:${norm.applicationId}:${norm.threadId}`;
};

const buildRedisActiveThreadKey = (scope: BotThreadScope): string =>
  `${BOT_ACTIVE_THREAD_PREFIX}${buildScopedBotThreadKey(scope)}`;

const buildRedisStopRequestKey = (scope: BotThreadScope): string =>
  `${BOT_STOP_REQUEST_PREFIX}${buildScopedBotThreadKey(scope)}`;

const tryGetStateManager = async (redis: Awaited<ReturnType<typeof tryGetRedis>>) => {
  try {
    if (redis) {
      const { AgentStateManager } = await import('@/server/modules/AgentRuntime/AgentStateManager');
      return new AgentStateManager();
    }
    const { inMemoryAgentStateManager } =
      await import('@/server/modules/AgentRuntime/InMemoryAgentStateManager');
    return inMemoryAgentStateManager;
  } catch {
    return null;
  }
};
const tryGetRedis = async () => {
  try {
    const { getAgentRuntimeRedisClient } = await import('@/server/modules/AgentRuntime/redis');
    return getAgentRuntimeRedisClient();
  } catch {
    return null;
  }
};

const writeRedisThreadRecord = async (record: PersistedBotThreadRecord): Promise<void> => {
  const redis = await tryGetRedis();
  if (!redis) return;
  const key = buildRedisActiveThreadKey(record);
  try {
    await redis.set(key, JSON.stringify(record), 'EX', BOT_ACTIVE_THREAD_TTL_SEC);
  } catch (error) {
    log('writeRedisThreadRecord failed for %s: %O', key, error);
  }
};

const deleteRedisThreadRecordIfOwned = async (
  scope: BotThreadScope,
  token?: string,
): Promise<void> => {
  const redis = await tryGetRedis();
  if (!redis) return;
  const key = buildRedisActiveThreadKey(scope);
  try {
    if (!token) {
      await redis.del(key);
      return;
    }
    const raw = await redis.get(key);
    if (!raw) return;
    const parsed = JSON.parse(raw) as PersistedBotThreadRecord;
    if (parsed.token === token) {
      await redis.del(key);
    }
  } catch (error) {
    log('deleteRedisThreadRecordIfOwned failed for %s: %O', key, error);
  }
};

const readRedisThreadRecord = async (
  scope: BotThreadScope,
): Promise<PersistedBotThreadRecord | null> => {
  const redis = await tryGetRedis();
  if (!redis) return null;
  const key = buildRedisActiveThreadKey(scope);
  try {
    const raw = await redis.get(key);
    if (!raw) return null;
    return JSON.parse(raw) as PersistedBotThreadRecord;
  } catch (error) {
    log('readRedisThreadRecord failed for %s: %O', key, error);
    return null;
  }
};

/**
 * Tracks a bot webhook HTTP request AND any background `waitUntil` promises spawned
 * by the Chat SDK (such as 30s debounce timers, private typing tasks, and message processing)
 * until ALL of them settle.
 */
export const runWithBotWebhookTracking = async <T>(
  fn: (ctx: BotWebhookTrackingContext) => Promise<T>,
): Promise<T> => {
  const state = getState();
  const existing = state.als.getStore();
  if (existing) {
    return fn({ waitUntil: existing.waitUntil });
  }

  const id = ++state.seq;
  const pendingTasks = new Set<Promise<unknown>>();
  let syncFinished = false;

  const maybeCleanup = () => {
    if (syncFinished && pendingTasks.size === 0) {
      state.webhooks.delete(id);
    }
  };

  const waitUntil = (task: Promise<unknown>) => {
    if (!task || typeof (task as Promise<unknown>).then !== 'function') return;
    const tracked: Promise<unknown> = Promise.resolve(task)
      .catch((error) => {
        log('bot webhook waitUntil background task failed: %O', error);
      })
      .finally(() => {
        pendingTasks.delete(tracked);
        maybeCleanup();
      });
    pendingTasks.add(tracked);
  };

  const store: BotWebhookStore = {
    activeThreadRunCount: 0,
    id,
    pendingTasks,
    waitUntil,
  };
  state.webhooks.set(id, store);

  try {
    return await state.als.run(store, () => fn({ waitUntil }));
  } finally {
    syncFinished = true;
    maybeCleanup();
  }
};

export interface BotWorkHandle {
  finish: () => void;
  setOperation: (operationId?: string | null, topicId?: string | null) => void;
}

/**
 * Registers an in-process local bot operation lifecycle token (`executeWithHooksLocalMode`)
 * that stays active from `execAgent()` until `onComplete` finishes delivering messages/media
 * (or startup fails), even if the outer 30-minute `EXECUTION_TIMEOUT` rejects the caller early!
 */
export const registerBotWork = (params?: {
  applicationId?: string | null;
  platform?: string | null;
  threadId?: string | null;
  topicId?: string | null;
}): BotWorkHandle => {
  const state = getState();
  const id = ++state.seq;
  const scopedKey = params?.threadId
    ? buildScopedBotThreadKey({
        applicationId: params.applicationId,
        platform: params.platform,
        threadId: params.threadId,
      })
    : undefined;
  const entry: LocalBotOperationWorkEntry = {
    id,
    scopedKey,
    startedAt: Date.now(),
    topicId: params?.topicId || undefined,
  };
  state.localWorks.set(id, entry);

  let finished = false;
  return {
    finish: () => {
      if (finished) return;
      finished = true;
      state.localWorks.delete(id);
    },
    setOperation: (operationId?: string | null, topicId?: string | null) => {
      if (finished) return;
      if (operationId) entry.operationId = operationId;
      if (topicId) entry.topicId = topicId;
    },
  };
};

export interface BotThreadRunTracker {
  finish: () => Promise<void>;
  markQueueHandoff: () => void;
  setOperation: (operationId?: string | null, topicId?: string | null) => Promise<void>;
  setTopicId: (topicId?: string | null) => Promise<void>;
}

export const beginBotThreadExecution = async (params: {
  agentId: string;
  applicationId?: string | null;
  initialTopicId?: string | null;
  platform?: string | null;
  threadId: string;
  userId: string;
}): Promise<BotThreadRunTracker> => {
  const state = getState();
  const norm = normalizeScope(params);
  const scopedKey = buildScopedBotThreadKey(norm);
  const id = ++state.seq;
  const token = `botrun_${id}_${Date.now()}`;
  const entry: BotThreadRunEntry = {
    agentId: params.agentId,
    applicationId: norm.applicationId,
    id,
    platform: norm.platform,
    queueMode: false,
    scopedKey,
    startedAt: Date.now(),
    threadId: norm.threadId,
    token,
    topicId: params.initialTopicId || undefined,
    userId: params.userId,
  };
  state.threadRuns.set(scopedKey, entry);

  const enclosingWebhook = state.als.getStore();
  let decrementedEnclosing = false;
  const releaseEnclosingLink = () => {
    if (!enclosingWebhook || decrementedEnclosing) return;
    decrementedEnclosing = true;
    enclosingWebhook.activeThreadRunCount = Math.max(0, enclosingWebhook.activeThreadRunCount - 1);
  };
  if (enclosingWebhook) {
    enclosingWebhook.activeThreadRunCount += 1;
  }

  await writeRedisThreadRecord({
    agentId: entry.agentId,
    applicationId: entry.applicationId,
    operationId: null,
    platform: entry.platform,
    startedAt: entry.startedAt,
    threadId: entry.threadId,
    token: entry.token,
    topicId: entry.topicId ?? null,
    userId: entry.userId,
  });

  let finished = false;
  return {
    finish: async () => {
      if (finished) return;
      finished = true;
      releaseEnclosingLink();
      if (state.threadRuns.get(scopedKey)?.token === token) {
        state.threadRuns.delete(scopedKey);
      }
      await deleteRedisThreadRecordIfOwned(norm, token);
    },
    markQueueHandoff: () => {
      if (finished) return;
      entry.queueMode = true;
    },
    setOperation: async (operationId?: string | null, topicId?: string | null) => {
      if (finished) return;
      if (operationId) entry.operationId = operationId;
      if (topicId) entry.topicId = topicId;
      await writeRedisThreadRecord({
        agentId: entry.agentId,
        applicationId: entry.applicationId,
        operationId: entry.operationId ?? null,
        platform: entry.platform,
        startedAt: entry.startedAt,
        threadId: entry.threadId,
        token: entry.token,
        topicId: entry.topicId ?? null,
        userId: entry.userId,
      });
    },
    setTopicId: async (topicId?: string | null) => {
      if (finished || !topicId) return;
      entry.topicId = topicId;
      await writeRedisThreadRecord({
        agentId: entry.agentId,
        applicationId: entry.applicationId,
        operationId: entry.operationId ?? null,
        platform: entry.platform,
        startedAt: entry.startedAt,
        threadId: entry.threadId,
        token: entry.token,
        topicId: entry.topicId ?? null,
        userId: entry.userId,
      });
    },
  };
};

export const clearRedisBotThreadRecord = async (
  threadId: string,
  opts?: { applicationId?: string | null; platform?: string | null },
): Promise<void> => {
  const state = getState();
  const scope: BotThreadScope = {
    applicationId: opts?.applicationId,
    platform: opts?.platform,
    threadId,
  };
  const scopedKey = buildScopedBotThreadKey(scope);
  state.threadRuns.delete(scopedKey);
  await deleteRedisThreadRecordIfOwned(scope);
};

/**
 * Reconcile local `queue`-mode bot thread runs against shared Redis state and
 * `AgentStateManager` operation metadata before reporting `/arckep/engine-slot/status`.
 *
 * In `queue` mode, the completion webhook (`BotCallbackService`) may arrive on the new
 * active slot after a Blue-Green switch, leaving the local `threadRuns` entry on the
 * draining slot. Checking Redis / `AgentStateManager` clears finished queue runs cleanly.
 */
export const refreshActiveBotSlotRuns = async (now = Date.now()): Promise<void> => {
  const state = getState();
  for (const [workId, work] of state.localWorks.entries()) {
    if (now - work.startedAt > LOCAL_BOT_WORK_SAFETY_TTL_MS) {
      state.localWorks.delete(workId);
    }
  }
  if (state.threadRuns.size === 0) return;

  const redis = await tryGetRedis();

  for (const [scopedKey, entry] of state.threadRuns.entries()) {
    const expired = now - entry.startedAt > BOT_ACTIVE_THREAD_TTL_SEC * 1000;
    if (!entry.queueMode && !expired) {
      continue;
    }

    const scope: BotThreadScope = {
      applicationId: entry.applicationId,
      platform: entry.platform,
      threadId: entry.threadId,
    };

    if (redis) {
      const record = await readRedisThreadRecord(scope);
      if (!record || record.token !== entry.token) {
        if (state.threadRuns.get(scopedKey)?.token === entry.token) {
          state.threadRuns.delete(scopedKey);
        }
        continue;
      }
    }

    if (entry.operationId) {
      try {
        const stateManager = await tryGetStateManager(redis);
        if (stateManager) {
          const meta = await stateManager.getOperationMetadata(entry.operationId);
          if (!meta || TERMINAL_STATUSES.has(meta.status)) {
            if (state.threadRuns.get(scopedKey)?.token === entry.token) {
              state.threadRuns.delete(scopedKey);
            }
            await deleteRedisThreadRecordIfOwned(scope, entry.token);
            continue;
          }
        }
      } catch (error) {
        log('refreshActiveBotSlotRuns metadata check failed for %s: %O', entry.operationId, error);
      }
    }

    if (expired) {
      if (state.threadRuns.get(scopedKey)?.token === entry.token) {
        state.threadRuns.delete(scopedKey);
      }
      await deleteRedisThreadRecordIfOwned(scope, entry.token);
    }
  }
};

export const isBotThreadActiveAcrossSlots = async (
  threadId: string,
  opts?: { applicationId?: string | null; platform?: string | null },
): Promise<boolean> => {
  if (!threadId) return false;
  const scope: BotThreadScope = {
    applicationId: opts?.applicationId,
    platform: opts?.platform,
    threadId,
  };
  const scopedKey = buildScopedBotThreadKey(scope);
  const state = getState();
  for (const work of state.localWorks.values()) {
    if (work.scopedKey === scopedKey) {
      return true;
    }
  }
  const localEntry = state.threadRuns.get(scopedKey);
  if (localEntry) {
    if (localEntry.queueMode) {
      await refreshActiveBotSlotRuns();
      if (state.threadRuns.has(scopedKey)) return true;
    } else {
      return true;
    }
  }

  const record = await readRedisThreadRecord(scope);
  if (!record) return false;

  if (record.operationId) {
    try {
      const redis = await tryGetRedis();
      const stateManager = await tryGetStateManager(redis);
      if (stateManager) {
        const meta = await stateManager.getOperationMetadata(record.operationId);
        if (!meta || TERMINAL_STATUSES.has(meta.status)) {
          await deleteRedisThreadRecordIfOwned(scope, record.token);
          return false;
        }
      }
      return true;
    } catch {
      return true;
    }
  }

  // Startup phase on draining slot: treat as active for up to 2 minutes
  if (Date.now() - record.startedAt > BOT_STOP_REQUEST_TTL_SEC * 1000) {
    await deleteRedisThreadRecordIfOwned(scope, record.token);
    return false;
  }
  return true;
};

export const consumeCrossSlotBotStopRequest = async (
  threadId: string,
  opts?: { applicationId?: string | null; platform?: string | null },
): Promise<boolean> => {
  const redis = await tryGetRedis();
  if (!redis || !threadId) return false;
  const key = buildRedisStopRequestKey({
    applicationId: opts?.applicationId,
    platform: opts?.platform,
    threadId,
  });
  try {
    const val = await redis.get(key);
    if (!val) return false;
    await redis.del(key);
    return true;
  } catch (error) {
    log('consumeCrossSlotBotStopRequest failed for %s: %O', key, error);
    return false;
  }
};

export const stopCrossSlotBotExecution = async (params: {
  applicationId?: string | null;
  defaultUserId: string;
  fallbackTopicId?: string | null;
  platform?: string | null;
  serverDB: LobeChatDatabase;
  threadId: string;
}): Promise<'interrupted' | 'queued' | 'not_found' | 'failed'> => {
  const { applicationId, defaultUserId, fallbackTopicId, platform, serverDB, threadId } = params;
  if (!defaultUserId) return 'not_found';

  const scope: BotThreadScope = { applicationId, platform, threadId };
  const scopedKey = buildScopedBotThreadKey(scope);
  const record = await readRedisThreadRecord(scope);

  if (record) {
    // Strict owner isolation (#16): NEVER interrupt or touch another owner's execution!
    if (!record.userId || record.userId !== defaultUserId) {
      log(
        'stopCrossSlotBotExecution: owner mismatch for %s (recordUserId=%s, callerUserId=%s) — refusing cross-owner stop',
        scopedKey,
        record.userId,
        defaultUserId,
      );
      return 'not_found';
    }

    if (record.operationId) {
      try {
        const { AiAgentService } = await import('@/server/services/aiAgent');
        const aiAgentService = new AiAgentService(serverDB, defaultUserId);
        const result = await aiAgentService.interruptTask({ operationId: record.operationId });
        if (result.success) {
          await deleteRedisThreadRecordIfOwned(scope, record.token);
          return 'interrupted';
        }
        return 'failed';
      } catch (error) {
        log('stopCrossSlotBotExecution interruptTask failed: %O', error);
        return 'failed';
      }
    }

    // Operation is still starting up on the draining slot — queue cross-slot stop in Redis
    const redis = await tryGetRedis();
    if (redis) {
      try {
        await redis.set(
          buildRedisStopRequestKey(scope),
          defaultUserId,
          'EX',
          BOT_STOP_REQUEST_TTL_SEC,
        );
        return 'queued';
      } catch (error) {
        log('stopCrossSlotBotExecution failed to queue stop in Redis: %O', error);
        return 'failed';
      }
    }
  }

  const candidateTopicId =
    (record && record.userId === defaultUserId ? record.topicId : undefined) || fallbackTopicId;
  if (candidateTopicId) {
    try {
      const { AgentRuntimeService } = await import('@/server/services/agentRuntime');
      const runtimeService = new AgentRuntimeService(serverDB, defaultUserId, {
        queueService: null,
      });
      const count = await runtimeService.interruptTopicOperations(candidateTopicId);
      if (count > 0) {
        if (record && record.userId === defaultUserId) {
          await deleteRedisThreadRecordIfOwned(scope, record.token);
        }
        return 'interrupted';
      }
    } catch (error) {
      log('stopCrossSlotBotExecution topic fallback failed: %O', error);
      return 'failed';
    }
  }

  return 'not_found';
};

export const getActiveBotSlotSnapshot = (): {
  activeCount: number;
  activeTopicIds: string[];
} => {
  const state = getState();
  let unlinkedWebhooks = 0;
  for (const wh of state.webhooks.values()) {
    if (wh.activeThreadRunCount === 0) {
      unlinkedWebhooks += 1;
    }
  }

  let extraLocalWorks = 0;
  const topics = new Set<string>();
  for (const run of state.threadRuns.values()) {
    if (run.topicId) {
      topics.add(run.topicId);
    }
  }
  for (const work of state.localWorks.values()) {
    if (work.topicId) {
      topics.add(work.topicId);
    }
    if (!work.scopedKey || !state.threadRuns.has(work.scopedKey)) {
      extraLocalWorks += 1;
    }
  }

  return {
    activeCount: state.threadRuns.size + extraLocalWorks + unlinkedWebhooks,
    activeTopicIds: [...topics],
  };
};

export const resetBotSlotActivityForTests = (): void => {
  const state = getState();
  state.webhooks.clear();
  state.threadRuns.clear();
  state.localWorks.clear();
};
