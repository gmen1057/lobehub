import { getRedisConfig } from '@/envs/redis';
import type { BaseRedisProvider, RedisConfig } from '@/libs/redis';
import { initializeRedisWithPrefix } from '@/libs/redis';

const WINDOW_SECONDS = 3600;
const WINDOW_MS = WINDOW_SECONDS * 1000;
const LIMIT = 30;
const REDIS_PREFIX = 'documents';

const RATE_LIMIT_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
redis.call('ZADD', key, now, member)
redis.call('EXPIRE', key, math.ceil(window / 1000))
local count = redis.call('ZCOUNT', key, now - window, now)
return count
`;

export interface DocumentRateLimitRedis {
  eval: <T = unknown>(
    script: string,
    numkeys: number,
    ...args: Array<number | string>
  ) => Promise<T>;
}

export interface DocumentRateLimitResult {
  allowed: boolean;
  count: number;
  limit: number;
  retryAfterSeconds: number;
}

const buildRedisConfig = (): RedisConfig => {
  const documentsUrl = process.env.DOCUMENTS_REDIS_URL;
  if (!documentsUrl) {
    const config = getRedisConfig();
    if (config.enabled) return config;
  }

  return {
    enabled: true,
    prefix: process.env.REDIS_PREFIX || 'lobechat',
    tls: false,
    url: documentsUrl || process.env.REDIS_URL || 'redis://127.0.0.1:6379/5',
  };
};

let clientPromise: Promise<BaseRedisProvider | null> | null = null;

const getDefaultRedisClient = async () => {
  clientPromise ??= initializeRedisWithPrefix(buildRedisConfig(), REDIS_PREFIX);
  return clientPromise;
};

export class DocumentRateLimiter {
  constructor(
    private redisFactory: () => Promise<DocumentRateLimitRedis | null> = getDefaultRedisClient,
  ) {}

  async check(userId: string, now = Date.now()): Promise<DocumentRateLimitResult> {
    const redis = await this.redisFactory();
    if (!redis) throw new Error('Rate limiter Redis is not available');

    const key = `user:${userId}`;
    const member = `${now}:${Math.random().toString(36).slice(2)}`;
    const rawCount = await redis.eval<number>(
      RATE_LIMIT_SCRIPT,
      1,
      key,
      now,
      WINDOW_MS,
      LIMIT,
      member,
    );
    const count = Number(rawCount);

    return {
      allowed: count <= LIMIT,
      count,
      limit: LIMIT,
      retryAfterSeconds: WINDOW_SECONDS,
    };
  }
}

export const documentRateLimiter = new DocumentRateLimiter();
