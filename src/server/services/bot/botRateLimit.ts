/**
 * Phase 29 — internal rate-limit on end users (per-bot), fixed-window Redis counter.
 *
 * This is a secondary guard BEFORE any paid agent run, complementary to the
 * durable Phase 5 quota in `bot_end_users`.  It caps instant-frequency to
 * protect the bot owner's balance from spam bursts.  The durable quota remains
 * the real enforcement; this is a fast fuse.
 *
 * Fail-open: if Redis is unavailable or any operation throws, we ALLOW the
 * message.  We never block a user because of an infra glitch.
 *
 * Owner-exempt: the bot owner (ownerPlatformUserId) is never rate-limited.
 * The exemption is checked in BotMessageRouter, not here.
 */

import type { Redis } from 'ioredis';

// ── Tunable constants ────────────────────────────────────────────────────

/** Max messages per end user per bot within the window. */
export const DEFAULT_RATE_LIMIT = 20;

/** Fixed window size in seconds. */
export const DEFAULT_RATE_WINDOW_SEC = 60;

/** Redis key prefix for rate-limit counters. */
export const RATE_LIMIT_KEY_PREFIX = 'botrl';

/** User-facing message when the limit is exceeded (Russian). */
export const RATE_LIMIT_EXCEEDED_MESSAGE =
  'Слишком много сообщений подряд. Подождите немного и попробуйте снова.';

// ── Types ────────────────────────────────────────────────────────────────

export interface RateLimitParams {
  botProviderId: string;
  endUserId: string;
  limit?: number;
  redis: Redis | null | undefined;
  windowSec?: number;
}

export interface RateLimitResult {
  allowed: boolean;
  message?: string;
}

// ── Helper ───────────────────────────────────────────────────────────────

function buildKey(botProviderId: string, endUserId: string): string {
  return `${RATE_LIMIT_KEY_PREFIX}:${botProviderId}:${endUserId}`;
}

// ── Main export ──────────────────────────────────────────────────────────

/**
 * Check whether an end user is within the rate limit for a given bot.
 *
 * Fixed-window algorithm: `INCR` the counter; on first hit (counter=1) set an
 * expiry.  If the counter exceeds the limit within the window, deny.
 *
 * Fail-open: returns `{ allowed: true }` when `redis` is falsy or any Redis
 * operation throws — we never block a user because of an infrastructure
 * problem.
 */
export async function checkRateLimit(params: RateLimitParams): Promise<RateLimitResult> {
  const {
    redis,
    botProviderId,
    endUserId,
    limit = DEFAULT_RATE_LIMIT,
    windowSec = DEFAULT_RATE_WINDOW_SEC,
  } = params;

  // ── Fail-open guard ────────────────────────────────────────────────
  if (!redis) {
    return { allowed: true };
  }

  const key = buildKey(botProviderId, endUserId);

  try {
    const count = await redis.incr(key);

    // First hit in the window → set TTL.
    if (count === 1) {
      await redis.expire(key, windowSec);
    }

    if (count > limit) {
      return { allowed: false, message: RATE_LIMIT_EXCEEDED_MESSAGE };
    }

    return { allowed: true };
  } catch (error) {
    // ── Fail-open: never block on Redis error ─────────────────────────
    console.warn(`[botRateLimit] Redis operation failed for key=${key}, fail-open: allow`, error);
    return { allowed: true };
  }
}
