/**
 * Phase 29 — unit tests for botRateLimit.ts
 *
 * These tests exercise the fixed-window INCR algorithm plus its fail-open
 * contracts.  No Redis instance is needed — we mock ioredis operations.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  checkRateLimit,
  DEFAULT_RATE_LIMIT,
  DEFAULT_RATE_WINDOW_SEC,
  RATE_LIMIT_EXCEEDED_MESSAGE,
} from '../botRateLimit';

// ---- helpers ---------------------------------------------------------------

function makeRedis(
  overrides: Partial<{
    incr: (key: string) => Promise<number>;
    expire: (key: string, sec: number) => Promise<number>;
  }> = {},
) {
  return {
    incr: overrides.incr ?? vi.fn(),
    expire: overrides.expire ?? vi.fn(),
  } as any;
}

const BASE: Parameters<typeof checkRateLimit>[0] = {
  botProviderId: 'bot-1',
  endUserId: '372730771',
  redis: makeRedis(),
};

beforeEach(() => {
  vi.restoreAllMocks();
});

// ---- tests -----------------------------------------------------------------

describe('checkRateLimit', () => {
  it('allows messages within the limit', async () => {
    let count = 0;
    const redis = makeRedis({
      incr: vi.fn(async () => {
        count += 1;
        return count;
      }),
      expire: vi.fn(async () => 1),
    });

    // First DEFAULT_RATE_LIMIT calls should all be allowed
    for (let i = 0; i < DEFAULT_RATE_LIMIT; i++) {
      const result = await checkRateLimit({ ...BASE, redis });
      expect(result.allowed).toBe(true);
    }

    // Now exceeded
    const blocked = await checkRateLimit({ ...BASE, redis });
    expect(blocked.allowed).toBe(false);
    expect(blocked.message).toBe(RATE_LIMIT_EXCEEDED_MESSAGE);
  });

  it('fail-open when redis is null', async () => {
    const result = await checkRateLimit({ ...BASE, redis: null });
    expect(result.allowed).toBe(true);
  });

  it('fail-open when redis is undefined', async () => {
    const result = await checkRateLimit({ ...BASE, redis: undefined });
    expect(result.allowed).toBe(true);
  });

  it('fail-open when INCR throws', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const redis = makeRedis({
      incr: vi.fn(async () => {
        throw new Error('connection refused');
      }),
    });

    const result = await checkRateLimit({ ...BASE, redis });
    expect(result.allowed).toBe(true);
    expect(consoleWarn).toHaveBeenCalled();
  });

  it('fail-open when EXPIRE throws (counter still incremented)', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const redis = makeRedis({
      incr: vi.fn(async () => 1),
      expire: vi.fn(async () => {
        throw new Error('timeout');
      }),
    });

    // First call: INCR returns 1, EXPIRE throws → still allowed (fail-open)
    const result = await checkRateLimit({ ...BASE, redis });
    expect(result.allowed).toBe(true);
    expect(consoleWarn).toHaveBeenCalled();
  });

  it('sets EXPIRE only on the first hit in the window', async () => {
    let count = 0;
    const expireMock = vi.fn(async () => 1);
    const redis = makeRedis({
      incr: vi.fn(async () => {
        count += 1;
        return count;
      }),
      expire: expireMock,
    });

    // First call → EXPIRE should be called
    await checkRateLimit({ ...BASE, redis });
    expect(expireMock).toHaveBeenCalledTimes(1);
    expect(expireMock).toHaveBeenCalledWith(
      expect.stringContaining('botrl:bot-1:372730771'),
      DEFAULT_RATE_WINDOW_SEC,
    );

    // Second call → EXPIRE should NOT be called again
    await checkRateLimit({ ...BASE, redis });
    expect(expireMock).toHaveBeenCalledTimes(1); // still 1
  });

  it('uses custom limit and window from params', async () => {
    let count = 0;
    const expireMock = vi.fn(async () => 1);
    const redis = makeRedis({
      incr: vi.fn(async () => {
        count += 1;
        return count;
      }),
      expire: expireMock,
    });

    const limit = 3;
    const windowSec = 10;

    for (let i = 0; i < limit; i++) {
      const r = await checkRateLimit({ ...BASE, redis, limit, windowSec });
      expect(r.allowed).toBe(true);
    }

    const blocked = await checkRateLimit({ ...BASE, redis, limit, windowSec });
    expect(blocked.allowed).toBe(false);

    // EXPIRE should use the custom window
    expect(expireMock).toHaveBeenCalledWith(
      expect.stringContaining('botrl:bot-1:372730771'),
      windowSec,
    );
  });

  it('different end users have separate counters', async () => {
    const counters: Record<string, number> = {};
    const redis = makeRedis({
      incr: vi.fn(async (key: string) => {
        counters[key] = (counters[key] || 0) + 1;
        return counters[key];
      }),
      expire: vi.fn(async () => 1),
    });

    // User A hits the limit
    for (let i = 0; i < DEFAULT_RATE_LIMIT; i++) {
      await checkRateLimit({ ...BASE, redis, endUserId: 'user-a' });
    }
    const blockedA = await checkRateLimit({ ...BASE, redis, endUserId: 'user-a' });
    expect(blockedA.allowed).toBe(false);

    // User B should still be allowed (separate counter)
    const allowedB = await checkRateLimit({ ...BASE, redis, endUserId: 'user-b' });
    expect(allowedB.allowed).toBe(true);
  });
});
