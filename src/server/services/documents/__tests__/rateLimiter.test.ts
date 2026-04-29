import { describe, expect, it } from 'vitest';

import { DocumentRateLimiter, type DocumentRateLimitRedis } from '../rateLimiter';

class MemoryRedis implements DocumentRateLimitRedis {
  private buckets = new Map<string, Array<{ member: string; score: number }>>();

  async eval<T>(_script: string, _numkeys: number, ...args: Array<number | string>): Promise<T> {
    const [key, nowInput, windowInput, , member] = args;
    const now = Number(nowInput);
    const window = Number(windowInput);
    const redisKey = String(key);
    const bucket = (this.buckets.get(redisKey) ?? []).filter(
      (entry) => entry.score >= now - window,
    );
    bucket.push({ member: String(member), score: now });
    this.buckets.set(redisKey, bucket);

    return bucket.length as T;
  }
}

describe('DocumentRateLimiter', () => {
  it('allows requests under the hourly limit', async () => {
    const redis = new MemoryRedis();
    const limiter = new DocumentRateLimiter(async () => redis);

    for (let index = 0; index < 30; index += 1) {
      const result = await limiter.check('user-1', 1000 + index);
      expect(result.allowed).toBe(true);
    }
  });

  it('blocks requests over the hourly limit', async () => {
    const redis = new MemoryRedis();
    const limiter = new DocumentRateLimiter(async () => redis);

    for (let index = 0; index < 30; index += 1) {
      await limiter.check('user-1', 1000 + index);
    }

    const result = await limiter.check('user-1', 2000);

    expect(result.allowed).toBe(false);
    expect(result.count).toBe(31);
    expect(result.limit).toBe(30);
  });
});
