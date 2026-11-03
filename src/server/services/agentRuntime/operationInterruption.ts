import type { AgentState } from '@lobechat/agent-runtime';

import type { IStreamEventManager } from '@/server/modules/AgentRuntime/types';

import { createAbortError } from './abort';

export interface OperationInterruption {
  dispose: () => Promise<void>;
  signal: AbortSignal;
}

/** Connect the existing persisted operation and stream bus to the running call. */
export const watchOperationInterruption = async (
  operationId: string,
  loadState: (id: string) => Promise<AgentState | null>,
  streamManager: IStreamEventManager,
): Promise<OperationInterruption> => {
  const execution = new AbortController();
  const subscription = new AbortController();
  const interrupt = () => execution.abort(createAbortError('Agent execution interrupted'));
  // Replay is intentional: a cancellation before XREAD starts must not be lost.
  const watching = streamManager.subscribeStreamEvents(
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
        interrupt();
      }
    },
    subscription.signal,
  );
  const dispose = async () => {
    subscription.abort();
    await watching;
  };
  try {
    if ((await loadState(operationId))?.interruption?.reason === 'user_cancelled') interrupt();
  } catch (error) {
    await dispose();
    throw error;
  }
  return { dispose, signal: execution.signal };
};
