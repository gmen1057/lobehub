// @vitest-environment node
import { DEFAULT_LLM_REQUEST_TIMEOUT_MS } from '@lobechat/model-runtime';
import { getGlobalDispatcher } from 'undici';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ensureServerUndiciDispatcher,
  resetServerUndiciDispatcherForTest,
} from './undiciDispatcher';

describe('ensureServerUndiciDispatcher', () => {
  afterEach(() => {
    resetServerUndiciDispatcherForTest();
  });

  it('configures Node global undici dispatcher with 25-minute headersTimeout and bodyTimeout once', () => {
    resetServerUndiciDispatcherForTest();

    expect(ensureServerUndiciDispatcher()).toBe(true);
    expect(ensureServerUndiciDispatcher()).toBe(false);

    const dispatcher = getGlobalDispatcher() as unknown as Record<symbol, any>;
    const kOptions = Object.getOwnPropertySymbols(dispatcher).find(
      (s) => s.description === 'options',
    );
    expect(kOptions).toBeDefined();
    expect(dispatcher[kOptions!]).toMatchObject({
      bodyTimeout: DEFAULT_LLM_REQUEST_TIMEOUT_MS,
      headersTimeout: DEFAULT_LLM_REQUEST_TIMEOUT_MS,
    });

    // Verify both Node 24 (globalDispatcher.2) and Node 22 (globalDispatcher.1) symbols point to the same Agent
    expect((globalThis as any)[Symbol.for('undici.globalDispatcher.2')]).toBe(dispatcher);
    expect((globalThis as any)[Symbol.for('undici.globalDispatcher.1')]).toBe(dispatcher);
  });
});
