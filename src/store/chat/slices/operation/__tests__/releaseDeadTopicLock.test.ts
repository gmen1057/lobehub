import { produce } from 'immer';
import { describe, expect, it } from 'vitest';

import { messageMapKey } from '@/store/chat/utils/messageMapKey';

import { OperationActionsImpl } from '../actions';
import { ABANDONED_OPERATION_TTL_MS } from '../liveness';
import { type Operation } from '../types';

const context = { agentId: 'session1', topicId: 'topic1' };
const contextKey = messageMapKey(context);

const createStore = (operation: Partial<Operation> & { id: string }) => {
  const full: Operation = {
    abortController: new AbortController(),
    childOperationIds: [],
    context,
    metadata: { startTime: Date.now() },
    status: 'running',
    type: 'execAgentRuntime',
    ...operation,
  } as Operation;

  let state: any = {
    operations: { [full.id]: full },
    operationsByContext: { [contextKey]: [full.id] },
    operationsByType: { [full.type]: [full.id] },
    operationsByMessage: {},
    messageOperationMap: {},
    queuedMessages: {},
  };

  const get = () =>
    ({
      ...state,
      cancelOperation: actions.cancelOperation,
      cleanupCompletedOperations: actions.cleanupCompletedOperations,
      failOperation: actions.failOperation,
      releaseDeadTopicLock: actions.releaseDeadTopicLock,
      updateOperationMetadata: actions.updateOperationMetadata,
    }) as any;

  const set = (updater: any) => {
    state = typeof updater === 'function' ? produce(state, updater) : { ...state, ...updater };
  };

  const actions = new OperationActionsImpl(set, get);

  return { actions, getOperation: () => state.operations[full.id] as Operation };
};

describe('releaseDeadTopicLock', () => {
  it('fails aborted running operations in the same topic', () => {
    const abortController = new AbortController();
    abortController.abort();
    const { actions, getOperation } = createStore({
      abortController,
      id: 'op-dead',
    });

    expect(actions.releaseDeadTopicLock(context)).toEqual(['op-dead']);
    expect(getOperation().status).toBe('cancelled');
    expect(getOperation().metadata.cancelReason).toBe('dead_topic_lock');
  });

  it('keeps a live running operation locked', () => {
    const { actions, getOperation } = createStore({ id: 'op-live' });

    expect(actions.releaseDeadTopicLock(context)).toEqual([]);
    expect(getOperation().status).toBe('running');
  });

  it('fails a running operation older than the abandoned TTL', () => {
    const { actions, getOperation } = createStore({
      id: 'op-stale',
      metadata: { startTime: Date.now() - ABANDONED_OPERATION_TTL_MS - 1 },
    });

    expect(actions.releaseDeadTopicLock(context)).toEqual(['op-stale']);
    expect(getOperation().status).toBe('cancelled');
  });

  it('releases a dead lock when startOperation begins a new top-level run', () => {
    const abortController = new AbortController();
    abortController.abort();
    const { actions, getOperation } = createStore({
      abortController,
      id: 'op-dead',
    });

    const started = actions.startOperation({
      context,
      type: 'sendMessage',
    });

    expect(getOperation().status).toBe('cancelled');
    expect(started.operationId).toBeTruthy();
  });
});
