import type { AgentState } from '@lobechat/agent-runtime';

import type { IStreamEventManager } from '@/server/modules/AgentRuntime/types';

import { createAbortError } from './abort';

export interface OperationInterruption {
  dispose: () => Promise<void>;
  signal: AbortSignal;
}

interface LocalOperationAbortRegistryGlobal {
  __arckepOperationAbortControllers?: Map<string, Set<AbortController>>;
}

const globalForAbortRegistry = globalThis as unknown as LocalOperationAbortRegistryGlobal;

const getAbortRegistry = (): Map<string, Set<AbortController>> => {
  if (!globalForAbortRegistry.__arckepOperationAbortControllers) {
    globalForAbortRegistry.__arckepOperationAbortControllers = new Map();
  }
  return globalForAbortRegistry.__arckepOperationAbortControllers;
};

/**
 * Registers an in-process AbortController for `operationId` so same-slot Stop /
 * `interruptOperation` immediately aborts the active LLM stream regardless of which
 * `IStreamEventManager` instance (`responsesStreamHub` vs Redis `StreamEventManager`)
 * the caller constructed.
 */
export const registerLocalOperationAbortController = (
  operationId: string,
  controller: AbortController,
): (() => void) => {
  const registry = getAbortRegistry();
  let set = registry.get(operationId);
  if (!set) {
    set = new Set();
    registry.set(operationId, set);
  }
  set.add(controller);

  return () => {
    const current = registry.get(operationId);
    if (!current) return;
    current.delete(controller);
    if (current.size === 0) {
      registry.delete(operationId);
    }
  };
};

export const abortLocalOperation = (
  operationId: string,
  reason: string = 'user_cancelled',
): boolean => {
  const registry = getAbortRegistry();
  const controllers = registry.get(operationId);
  if (!controllers || controllers.size === 0) return false;

  let abortedAny = false;
  const abortError = createAbortError(reason);
  for (const controller of Array.from(controllers)) {
    if (!controller.signal.aborted) {
      controller.abort(abortError);
      abortedAny = true;
    }
  }
  return abortedAny;
};

export const hasLocalOperationAbortController = (operationId: string): boolean => {
  const controllers = getAbortRegistry().get(operationId);
  return Boolean(controllers && controllers.size > 0);
};

export const clearLocalOperationAbortControllersForTests = (): void => {
  getAbortRegistry().clear();
};

/** Connect the existing persisted operation and stream bus to the running call. */
export const watchOperationInterruption = async (
  operationId: string,
  loadState: (id: string) => Promise<AgentState | null>,
  streamManager: IStreamEventManager,
): Promise<OperationInterruption> => {
  const execution = new AbortController();
  const subscription = new AbortController();
  const interrupt = (reason: string = 'user_cancelled') => {
    if (!execution.signal.aborted) {
      execution.abort(createAbortError(reason));
    }
  };
  const unregisterLocal = registerLocalOperationAbortController(operationId, execution);
  let watching: Promise<void> | undefined;
  const dispose = async () => {
    unregisterLocal();
    subscription.abort();
    await watching;
  };
  try {
    // Replay is intentional: a cancellation before XREAD starts must not be lost.
    watching = streamManager.subscribeStreamEvents(
      operationId,
      '0',
      (events) => {
        if (
          events.some(
            (event) =>
              event.type === 'operation_interrupted' ||
              (event.type === 'agent_runtime_end' &&
                event.data.finalState?.interruption?.reason === 'user_cancelled'),
          )
        ) {
          interrupt('user_cancelled');
        }
      },
      subscription.signal,
    );
    if ((await loadState(operationId))?.interruption?.reason === 'user_cancelled') {
      interrupt('user_cancelled');
    }
  } catch (error) {
    await dispose();
    throw error;
  }
  return { dispose, signal: execution.signal };
};
