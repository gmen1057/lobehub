import { type Operation } from './types';

/**
 * How long an operation that still claims `running` may hold the topic before
 * it is treated as abandoned.
 *
 * Client operations have no heartbeat. A killed tab/runtime never writes a
 * terminal status, and every clear site is best-effort, so a dead marker would
 * otherwise block send forever. Parked/live generations are identified by a
 * non-aborted AbortController; this TTL is only a backstop for rows that still
 * claim `running` with a live controller.
 */
export const ABANDONED_OPERATION_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Whether an in-memory operation is still a legitimate topic lock.
 *
 * Missing / aborted / aborting / aged-out operations are dead: send must
 * proceed instead of enqueueing into a queue that will never drain.
 */
export const isOperationAlive = (operation?: Operation | null): boolean => {
  if (!operation) return false;
  if (operation.status !== 'running') return false;
  if (operation.metadata?.isAborting) return false;

  const abortController = operation.abortController;
  if (!abortController || abortController.signal.aborted) return false;

  const startedAt = operation.metadata?.startTime;
  if (typeof startedAt === 'number' && Date.now() - startedAt >= ABANDONED_OPERATION_TTL_MS) {
    return false;
  }

  return true;
};
