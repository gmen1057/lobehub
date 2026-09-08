import { describe, expect, it } from 'vitest';

import { ABANDONED_OPERATION_TTL_MS, isOperationAlive } from '../liveness';
import { type Operation } from '../types';

const liveOperation = (overrides: Partial<Operation> = {}): Operation =>
  ({
    abortController: new AbortController(),
    childOperationIds: [],
    context: { agentId: 'agent-1', topicId: 'topic-1' },
    id: 'op-1',
    metadata: { startTime: Date.now() },
    status: 'running',
    type: 'execAgentRuntime',
    ...overrides,
  }) as Operation;

describe('isOperationAlive', () => {
  it('returns false when the operation is missing', () => {
    expect(isOperationAlive(undefined)).toBe(false);
    expect(isOperationAlive(null)).toBe(false);
  });

  it('returns true for a running operation with a live abort controller', () => {
    expect(isOperationAlive(liveOperation())).toBe(true);
  });

  it('returns false when status is not running', () => {
    expect(isOperationAlive(liveOperation({ status: 'completed' }))).toBe(false);
    expect(isOperationAlive(liveOperation({ status: 'failed' }))).toBe(false);
    expect(isOperationAlive(liveOperation({ status: 'cancelled' }))).toBe(false);
  });

  it('returns false when the abort controller is missing', () => {
    expect(isOperationAlive(liveOperation({ abortController: undefined as any }))).toBe(false);
  });

  it('returns false when the abort controller is already aborted', () => {
    const abortController = new AbortController();
    abortController.abort();
    expect(isOperationAlive(liveOperation({ abortController }))).toBe(false);
  });

  it('returns false while the operation is aborting', () => {
    expect(
      isOperationAlive(
        liveOperation({
          metadata: { isAborting: true, startTime: Date.now() },
        }),
      ),
    ).toBe(false);
  });

  it('returns false when startTime is older than the abandoned TTL', () => {
    expect(
      isOperationAlive(
        liveOperation({
          metadata: { startTime: Date.now() - ABANDONED_OPERATION_TTL_MS - 1 },
        }),
      ),
    ).toBe(false);
  });
});
