import {
  type AgentEvent,
  type AgentRuntimeContext,
  type AgentState,
} from '@lobechat/agent-runtime';
import debug from 'debug';
import { type Redis } from 'ioredis';

import { decodeAgentState, READ_AGENT_STATE, WRITE_AGENT_STATE } from './agentStateWrite';
import { getAgentRuntimeRedisClient } from './redis';
import { agentRuntimeStreamKey } from './StreamEventManager';

const log = debug('lobe-server:agent-runtime:agent-state-manager');

/**
 * Distributed step lock TTL (35 minutes): covers a single 25-30 minute LLM stream
 * plus transient retries; normal completion/error releases the lock immediately in finally.
 */
export const DEFAULT_STEP_LOCK_TTL_SECONDS = 35 * 60;
export const OPERATION_HEARTBEAT_TTL_SECONDS = 90;

export interface StepResult {
  events?: AgentEvent[];
  executionTime: number;
  newState: AgentState;
  nextContext?: AgentRuntimeContext;
  stepIndex: number;
}

export interface AgentOperationMetadata {
  agentConfig?: any;
  createdAt: string;
  heartbeatSupported?: boolean;
  lastActiveAt: string;
  modelRuntimeConfig?: any;
  status: AgentState['status'];
  totalCost: number;
  totalSteps: number;
  userId?: string;
}

export class AgentStateManager {
  private redis: Redis;
  private readonly STATE_PREFIX = 'agent_runtime_state';
  private readonly STEPS_PREFIX = 'agent_runtime_steps';
  private readonly METADATA_PREFIX = 'agent_runtime_meta';
  private readonly EVENTS_PREFIX = 'agent_runtime_events';
  private readonly LIVE_OP_PREFIX = 'agent_runtime_live_op';
  private readonly DEFAULT_TTL = 2 * 3600; // 2h

  constructor() {
    const redisClient = getAgentRuntimeRedisClient();
    if (!redisClient) {
      throw new Error('Redis is not available. Please configure REDIS_URL environment variable.');
    }
    this.redis = redisClient;
  }

  /**
   * Save Agent state
   */
  async saveAgentState(operationId: string, state: AgentState): Promise<void> {
    try {
      const saved = await this.writeState(operationId, 'save', state);
      // The caller schedules from this state, so it must see a concurrent Stop.
      state.status = saved!.status;
      if (saved!.interruption?.reason === 'user_cancelled')
        state.interruption = saved!.interruption;

      // State change events are recorded through the events array in saveStepResult

      log('[%s] Saved state for step %d', operationId, state.stepCount);
    } catch (error) {
      console.error('Failed to save agent state:', error);
      throw error;
    }
  }

  async interruptAgentState(operationId: string): Promise<AgentState | null> {
    return this.writeState(operationId, 'interrupt');
  }

  private async writeState(
    operationId: string,
    mode: 'save' | 'interrupt',
    state?: AgentState,
    stepResult?: StepResult,
  ): Promise<AgentState | null> {
    const result = await this.redis.eval(
      WRITE_AGENT_STATE,
      5,
      `${this.STATE_PREFIX}:${operationId}`,
      `${this.METADATA_PREFIX}:${operationId}`,
      `${this.STEPS_PREFIX}:${operationId}`,
      `${this.EVENTS_PREFIX}:${operationId}`,
      agentRuntimeStreamKey(operationId),
      mode,
      state ? JSON.stringify({ ...state, status: undefined }) : '',
      this.DEFAULT_TTL,
      new Date().toISOString(),
      stepResult
        ? JSON.stringify({
            context: stepResult.nextContext,
            cost: state?.cost?.total || 0,
            executionTime: stepResult.executionTime,
            stepIndex: stepResult.stepIndex,
            timestamp: Date.now(),
          })
        : '',
      stepResult?.events?.length ? JSON.stringify(stepResult.events) : '',
      state?.status || '',
      operationId,
      Date.now(),
    );
    return decodeAgentState(result);
  }

  /**
   * Load Agent state
   */
  async loadAgentState(operationId: string): Promise<AgentState | null> {
    const stateKey = `${this.STATE_PREFIX}:${operationId}`;

    try {
      const state = decodeAgentState(
        await this.redis.eval(
          READ_AGENT_STATE,
          2,
          stateKey,
          `${this.METADATA_PREFIX}:${operationId}`,
        ),
      );
      log('[%s] Loaded state (step %d)', operationId, state?.stepCount);

      return state;
    } catch (error) {
      console.error('Failed to load agent state:', error);
      throw error;
    }
  }

  /**
   * Save step execution result
   */
  async saveStepResult(operationId: string, stepResult: StepResult): Promise<void> {
    try {
      const saved = await this.writeState(operationId, 'save', stepResult.newState, stepResult);
      stepResult.newState.status = saved!.status;
      if (saved!.interruption?.reason === 'user_cancelled')
        stepResult.newState.interruption = saved!.interruption;

      log(
        '[%s:%d] Saved step result with %d events',
        operationId,
        stepResult.stepIndex,
        stepResult.events?.length || 0,
      );
    } catch (error) {
      console.error('Failed to save step result:', error);
      throw error;
    }
  }

  /**
   * Get execution history
   */
  async getExecutionHistory(operationId: string, limit: number = 50): Promise<any[]> {
    const stepsKey = `${this.STEPS_PREFIX}:${operationId}`;

    try {
      const history = await this.redis.lrange(stepsKey, 0, limit - 1);
      return history.map((item) => JSON.parse(item)).reverse(); // Earliest first
    } catch (error) {
      console.error('Failed to get execution history:', error);
      return [];
    }
  }

  /**
   * Get operation metadata
   */
  async getOperationMetadata(operationId: string): Promise<AgentOperationMetadata | null> {
    const metaKey = `${this.METADATA_PREFIX}:${operationId}`;

    try {
      const metadata = await this.redis.hgetall(metaKey);

      if (Object.keys(metadata).length === 0) {
        return null;
      }

      return {
        agentConfig: metadata.agentConfig ? JSON.parse(metadata.agentConfig) : undefined,
        createdAt: metadata.createdAt,
        heartbeatSupported: metadata.heartbeatSupported === '1',
        lastActiveAt: metadata.lastActiveAt,
        modelRuntimeConfig: metadata.modelRuntimeConfig
          ? JSON.parse(metadata.modelRuntimeConfig)
          : undefined,
        status: metadata.status as AgentState['status'],
        totalCost: parseFloat(metadata.totalCost) || 0,
        totalSteps: parseInt(metadata.totalSteps) || 0,
        userId: metadata.userId,
      };
    } catch (error) {
      console.error('Failed to get operation metadata:', error);
      return null;
    }
  }

  /**
   * Create new operation metadata
   */
  async createOperationMetadata(
    operationId: string,
    data: {
      agentConfig?: any;
      modelRuntimeConfig?: any;
      userId?: string;
    },
  ): Promise<void> {
    const metaKey = `${this.METADATA_PREFIX}:${operationId}`;

    try {
      const metadata: AgentOperationMetadata = {
        agentConfig: data.agentConfig,
        createdAt: new Date().toISOString(),
        heartbeatSupported: true,
        lastActiveAt: new Date().toISOString(),
        modelRuntimeConfig: data.modelRuntimeConfig,
        status: 'idle',
        totalCost: 0,
        totalSteps: 0,
        userId: data.userId,
      };

      // Serialize complex objects
      const redisData: Record<string, string> = {
        createdAt: metadata.createdAt,
        heartbeatSupported: '1',
        lastActiveAt: metadata.lastActiveAt,
        status: metadata.status,
        totalCost: metadata.totalCost.toString(),
        totalSteps: metadata.totalSteps.toString(),
      };

      if (metadata.userId) redisData.userId = metadata.userId;
      if (metadata.modelRuntimeConfig)
        redisData.modelRuntimeConfig = JSON.stringify(metadata.modelRuntimeConfig);
      if (metadata.agentConfig) redisData.agentConfig = JSON.stringify(metadata.agentConfig);

      await this.redis.hmset(metaKey, redisData);
      await this.redis.expire(metaKey, this.DEFAULT_TTL);
      await this.touchOperationHeartbeat(operationId, OPERATION_HEARTBEAT_TTL_SECONDS);

      log('[%s] Created operation metadata', operationId);
    } catch (error) {
      console.error('Failed to create operation metadata:', error);
      throw error;
    }
  }

  /**
   * Delete all data for Agent operation
   */
  async deleteAgentOperation(operationId: string): Promise<void> {
    const keys = [
      `${this.STATE_PREFIX}:${operationId}`,
      `${this.STEPS_PREFIX}:${operationId}`,
      `${this.METADATA_PREFIX}:${operationId}`,
      `${this.EVENTS_PREFIX}:${operationId}`,
      this.liveHeartbeatKey(operationId),
    ];

    try {
      await this.redis.del(...keys);
      log('Deleted operation %s', operationId);
    } catch (error) {
      console.error('Failed to delete agent operation:', error);
      throw error;
    }
  }

  /**
   * Get all active operations
   */
  async getActiveOperations(): Promise<string[]> {
    try {
      const pattern = `${this.STATE_PREFIX}:*`;
      const keys = await this.redis.keys(pattern);
      return keys.map((key) => key.replace(`${this.STATE_PREFIX}:`, ''));
    } catch (error) {
      console.error('Failed to get active operations:', error);
      return [];
    }
  }

  /**
   * Non-blocking Redis SCAN for operations belonging to a single topicId.
   * Propagates Redis errors so callers (`hasLiveTopicOperation`) fail closed instead of
   * mistaking a transient Redis hiccup for "0 active operations".
   */
  async getActiveOperationsForTopic(topicId: string): Promise<string[]> {
    if (!topicId) return [];
    const escapedTopicId = topicId.replaceAll(/[*?[\\\]]/g, '\\$&');
    const pattern = `${this.STATE_PREFIX}:*_${escapedTopicId}_*`;
    const prefix = `${this.STATE_PREFIX}:`;

    if (typeof (this.redis as any).scan !== 'function') {
      const prefixPattern = `${this.STATE_PREFIX}:*`;
      const keys = await this.redis.keys(prefixPattern);
      const marker = `_${topicId}_`;
      return keys.map((key) => key.replace(prefix, '')).filter((opId) => opId.includes(marker));
    }

    const found = new Set<string>();
    let cursor = '0';
    do {
      const [nextCursor, batch] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
      for (const key of batch) {
        if (key.startsWith(prefix)) {
          found.add(key.slice(prefix.length));
        }
      }
      cursor = nextCursor;
    } while (cursor !== '0');

    return [...found];
  }

  private liveHeartbeatKey(operationId: string): string {
    return `${this.LIVE_OP_PREFIX}:${operationId}`;
  }

  async touchOperationHeartbeat(
    operationId: string,
    ttlSeconds: number = OPERATION_HEARTBEAT_TTL_SECONDS,
  ): Promise<void> {
    try {
      const nowIso = new Date().toISOString();
      await Promise.all([
        this.redis.set(this.liveHeartbeatKey(operationId), nowIso, 'EX', ttlSeconds),
        this.redis.hset(`${this.METADATA_PREFIX}:${operationId}`, 'lastActiveAt', nowIso),
      ]);
    } catch (error) {
      console.error('Failed to touch operation heartbeat:', error);
    }
  }

  async clearOperationHeartbeat(operationId: string): Promise<void> {
    try {
      await this.redis.del(this.liveHeartbeatKey(operationId));
    } catch (error) {
      console.error('Failed to clear operation heartbeat:', error);
    }
  }

  async hasOperationHeartbeat(operationId: string): Promise<boolean | null> {
    try {
      const supported = await this.redis.hget(
        `${this.METADATA_PREFIX}:${operationId}`,
        'heartbeatSupported',
      );
      if (supported !== '1') return null;
      return (await this.redis.exists(this.liveHeartbeatKey(operationId))) === 1;
    } catch (error) {
      console.error('Failed to check operation heartbeat:', error);
      // Fail-safe: on transient Redis read failure, assume alive so we never clobber a running turn
      return true;
    }
  }

  /**
   * Clean up expired operation data
   */
  async cleanupExpiredOperations(): Promise<number> {
    try {
      const activeOperations = await this.getActiveOperations();
      let cleanedCount = 0;

      for (const operationId of activeOperations) {
        const metadata = await this.getOperationMetadata(operationId);

        if (metadata) {
          const lastActiveTime = new Date(metadata.lastActiveAt).getTime();
          const now = Date.now();
          const hoursSinceActive = (now - lastActiveTime) / (1000 * 60 * 60);

          // Clean up operations inactive for more than 2 hours
          if (hoursSinceActive > 2) {
            await this.deleteAgentOperation(operationId);
            cleanedCount++;
          }
        }
      }

      log('Cleaned up %d expired operations', cleanedCount);
      return cleanedCount;
    } catch (error) {
      console.error('Failed to cleanup expired operations:', error);
      return 0;
    }
  }

  /**
   * Get statistics
   */
  async getStats(): Promise<{
    activeOperations: number;
    completedOperations: number;
    errorOperations: number;
    totalOperations: number;
  }> {
    try {
      const operations = await this.getActiveOperations();
      const stats = {
        activeOperations: 0,
        completedOperations: 0,
        errorOperations: 0,
        totalOperations: operations.length,
      };

      for (const operationId of operations) {
        const metadata = await this.getOperationMetadata(operationId);

        if (metadata) {
          switch (metadata.status) {
            case 'running':
            case 'waiting_for_human': {
              stats.activeOperations++;
              break;
            }
            case 'done': {
              stats.completedOperations++;
              break;
            }
            case 'error':
            case 'interrupted': {
              stats.errorOperations++;
              break;
            }
          }
        }
      }

      return stats;
    } catch (error) {
      console.error('Failed to get stats:', error);
      return {
        activeOperations: 0,
        completedOperations: 0,
        errorOperations: 0,
        totalOperations: 0,
      };
    }
  }

  private stepLockKey(operationId: string, stepIndex: number): string {
    return `agent_runtime_step_lock:${operationId}:${stepIndex}`;
  }

  async tryClaimStep(
    operationId: string,
    stepIndex: number,
    ttlSeconds: number = DEFAULT_STEP_LOCK_TTL_SECONDS,
  ): Promise<boolean> {
    try {
      const result = await this.redis.set(
        this.stepLockKey(operationId, stepIndex),
        Date.now().toString(),
        'EX',
        ttlSeconds,
        'NX',
      );

      return result === 'OK';
    } catch (error) {
      // Fail-open: on Redis error, allow execution to proceed
      console.error('Failed to acquire step lock:', error);
      return true;
    }
  }

  async releaseStepLock(operationId: string, stepIndex: number): Promise<void> {
    try {
      await this.redis.del(this.stepLockKey(operationId, stepIndex));
    } catch (error) {
      console.error('Failed to release step lock:', error);
    }
  }

  /**
   * Close Redis connection
   */
  async disconnect(): Promise<void> {
    await this.redis.quit();
  }
}
