import { AsyncLocalStorage } from 'node:async_hooks';

import debug from 'debug';

import type { LobeChatDatabase } from '@/database/type';

const log = debug('lobe-server:bot:slot-activity');

const BOT_ACTIVE_THREAD_PREFIX = 'arckep:bot:active_thread:';
const BOT_STOP_REQUEST_PREFIX = 'arckep:bot:stop_requested:';
const BOT_ACTIVE_THREAD_TTL_SEC = 2100;
const BOT_STOP_REQUEST_TTL_SEC = 120;
const TERMINAL_STATUSES = new Set(['done', 'error', 'interrupted']);

interface BotWebhookStore {
  hasSpawnedThreadRun: boolean;
  id: number;
}

interface BotThreadRunEntry {
  agentId: string;
  id: number;
  operationId?: string;
  startedAt: number;
  threadId: string;
  token: string;
  topicId?: string;
  userId: string;
}

interface PersistedBotThreadRecord {
  agentId: string;
  operationId?: string | null;
  startedAt: number;
  threadId: string;
  token: string;
  topicId?: string | null;
  userId: string;
}

interface BotSlotActivityState {
  als: AsyncLocalStorage<BotWebhookStore>;
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
      seq: 0,
      threadRuns: new Map(),
      webhooks: new Map(),
    };
  }
  return globalForBotSlot.__arckepBotSlotActivity;
};

// Lazy dynamic imports avoid pulling server-only ModelRuntime/DB schemas at module load time
// in client/jsdom or partial-schema unit tests.
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
  try {
    await redis.set(
      `${BOT_ACTIVE_THREAD_PREFIX}${record.threadId}`,
      JSON.stringify(record),
      'EX',
      BOT_ACTIVE_THREAD_TTL_SEC,
    );
  } catch (error) {
    log('writeRedisThreadRecord failed for %s: %O', record.threadId, error);
  }
};

const deleteRedisThreadRecordIfOwned = async (threadId: string, token?: string): Promise<void> => {
  const redis = await tryGetRedis();
  if (!redis) return;
  const key = `${BOT_ACTIVE_THREAD_PREFIX}${threadId}`;
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
    log('deleteRedisThreadRecordIfOwned failed for %s: %O', threadId, error);
  }
};

const readRedisThreadRecord = async (
  threadId: string,
): Promise<PersistedBotThreadRecord | null> => {
  const redis = await tryGetRedis();
  if (!redis) return null;
  try {
    const raw = await redis.get(`${BOT_ACTIVE_THREAD_PREFIX}${threadId}`);
    if (!raw) return null;
    return JSON.parse(raw) as PersistedBotThreadRecord;
  } catch (error) {
    log('readRedisThreadRecord failed for %s: %O', threadId, error);
    return null;
  }
};

export const runWithBotWebhookTracking = async <T>(fn: () => Promise<T>): Promise<T> => {
  const state = getState();
  const existing = state.als.getStore();
  if (existing) {
    return fn();
  }

  const id = ++state.seq;
  const store: BotWebhookStore = { hasSpawnedThreadRun: false, id };
  state.webhooks.set(id, store);

  try {
    return await state.als.run(store, fn);
  } finally {
    state.webhooks.delete(id);
  }
};

export interface BotThreadRunTracker {
  finish: () => Promise<void>;
  setOperation: (operationId?: string | null, topicId?: string | null) => Promise<void>;
  setTopicId: (topicId?: string | null) => Promise<void>;
}

export const beginBotThreadExecution = async (params: {
  agentId: string;
  initialTopicId?: string | null;
  threadId: string;
  userId: string;
}): Promise<BotThreadRunTracker> => {
  const state = getState();
  const id = ++state.seq;
  const token = `botrun_${id}_${Date.now()}`;
  const entry: BotThreadRunEntry = {
    agentId: params.agentId,
    id,
    startedAt: Date.now(),
    threadId: params.threadId,
    token,
    topicId: params.initialTopicId || undefined,
    userId: params.userId,
  };
  state.threadRuns.set(params.threadId, entry);

  const enclosingWebhook = state.als.getStore();
  if (enclosingWebhook) {
    enclosingWebhook.hasSpawnedThreadRun = true;
  }

  await writeRedisThreadRecord({
    agentId: entry.agentId,
    operationId: null,
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
      if (state.threadRuns.get(params.threadId)?.token === token) {
        state.threadRuns.delete(params.threadId);
      }
      await deleteRedisThreadRecordIfOwned(params.threadId, token);
    },
    setOperation: async (operationId?: string | null, topicId?: string | null) => {
      if (finished) return;
      if (operationId) entry.operationId = operationId;
      if (topicId) entry.topicId = topicId;
      await writeRedisThreadRecord({
        agentId: entry.agentId,
        operationId: entry.operationId ?? null,
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
        operationId: entry.operationId ?? null,
        startedAt: entry.startedAt,
        threadId: entry.threadId,
        token: entry.token,
        topicId: entry.topicId ?? null,
        userId: entry.userId,
      });
    },
  };
};

export const clearRedisBotThreadRecord = async (threadId: string): Promise<void> => {
  const state = getState();
  state.threadRuns.delete(threadId);
  await deleteRedisThreadRecordIfOwned(threadId);
};

export const isBotThreadActiveAcrossSlots = async (threadId: string): Promise<boolean> => {
  if (!threadId) return false;
  const state = getState();
  if (state.threadRuns.has(threadId)) return true;

  const record = await readRedisThreadRecord(threadId);
  if (!record) return false;

  if (record.operationId) {
    try {
      const { createAgentStateManager } = await import('@/server/modules/AgentRuntime/factory');
      const meta = await createAgentStateManager().getOperationMetadata(record.operationId);
      if (!meta || TERMINAL_STATUSES.has(meta.status)) {
        await deleteRedisThreadRecordIfOwned(threadId, record.token);
        return false;
      }
      return true;
    } catch {
      return true;
    }
  }

  // Startup phase on draining slot: treat as active for up to 2 minutes
  if (Date.now() - record.startedAt > BOT_STOP_REQUEST_TTL_SEC * 1000) {
    await deleteRedisThreadRecordIfOwned(threadId, record.token);
    return false;
  }
  return true;
};

export const consumeCrossSlotBotStopRequest = async (threadId: string): Promise<boolean> => {
  const redis = await tryGetRedis();
  if (!redis || !threadId) return false;
  const key = `${BOT_STOP_REQUEST_PREFIX}${threadId}`;
  try {
    const val = await redis.get(key);
    if (!val) return false;
    await redis.del(key);
    return true;
  } catch (error) {
    log('consumeCrossSlotBotStopRequest failed for %s: %O', threadId, error);
    return false;
  }
};

export const stopCrossSlotBotExecution = async (params: {
  defaultUserId: string;
  fallbackTopicId?: string | null;
  serverDB: LobeChatDatabase;
  threadId: string;
}): Promise<'interrupted' | 'queued' | 'not_found' | 'failed'> => {
  const { defaultUserId, fallbackTopicId, serverDB, threadId } = params;
  const record = await readRedisThreadRecord(threadId);

  if (record) {
    const targetUserId = record.userId || defaultUserId;
    if (record.operationId) {
      try {
        const { AiAgentService } = await import('@/server/services/aiAgent');
        const aiAgentService = new AiAgentService(serverDB, targetUserId);
        const result = await aiAgentService.interruptTask({ operationId: record.operationId });
        if (result.success) {
          await deleteRedisThreadRecordIfOwned(threadId, record.token);
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
          `${BOT_STOP_REQUEST_PREFIX}${threadId}`,
          '1',
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

  const candidateTopicId = record?.topicId || fallbackTopicId;
  if (candidateTopicId) {
    try {
      const { AgentRuntimeService } = await import('@/server/services/agentRuntime');
      const runtimeService = new AgentRuntimeService(serverDB, defaultUserId, {
        queueService: null,
      });
      const count = await runtimeService.interruptTopicOperations(candidateTopicId);
      if (count > 0) {
        await deleteRedisThreadRecordIfOwned(threadId);
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
    if (!wh.hasSpawnedThreadRun) {
      unlinkedWebhooks += 1;
    }
  }

  const topics = new Set<string>();
  for (const run of state.threadRuns.values()) {
    if (run.topicId) {
      topics.add(run.topicId);
    }
  }

  return {
    activeCount: state.threadRuns.size + unlinkedWebhooks,
    activeTopicIds: [...topics],
  };
};

export const resetBotSlotActivityForTests = (): void => {
  const state = getState();
  state.webhooks.clear();
  state.threadRuns.clear();
};
