import { describe, expect, it } from 'vitest';

import { ChatMessageErrorSchema } from '../../../../../packages/types/src/message/common/base';
import {
  formatPersistedLLMError,
  getPersistedLLMError,
  rememberPersistedLLMError,
} from '../persistedLLMError';

describe('persisted model errors', () => {
  it.each([400, 401, 402, 403, 404, 429, 500, 502, 503, 504])(
    'keeps HTTP %s through the message schema and JSON round trip without provider details',
    (status) => {
      const original = Object.assign(new Error('secret sk-private at https://private.example'), {
        error: { message: 'provider details', status },
        errorType: 'ProviderBizError',
      });
      const saved = formatPersistedLLMError(original);
      const serialized = JSON.stringify(saved);
      const restored = ChatMessageErrorSchema.parse(JSON.parse(serialized));
      expect(restored.type).toBe(status);
      expect(restored.body.status).toBe(status);
      expect(restored.body.code).toBe(`HTTP_${status}`);
      expect(JSON.stringify(restored)).not.toMatch(/sk-private|private\.example|provider details/);
      expect(rememberPersistedLLMError(original, saved)).toBe(original);
      expect(getPersistedLLMError(original)).toEqual(restored);
      expect(original.message).toContain('secret');
    },
  );

  it.each([
    { errorType: 'ProviderBizError', error: { status: 402, code: 'provider_credits_exhausted' } },
    { status: 429, body: { error: { code: 429, type: 'provider_credits_exhausted' } } },
    { cause: { message: JSON.stringify({ error: { code: 'provider_credits_exhausted' } }) } },
    new Error('402 Сейчас эта модель временно недоступна. Мы уже в процессе её восстановления.'),
  ])('preserves a vendor wallet failure without proposing a user top-up', (error) => {
    const saved = ChatMessageErrorSchema.parse(formatPersistedLLMError(error));
    expect(saved).toEqual({
      body: { code: 'provider_credits_exhausted', status: 503 },
      message: 'Сейчас эта модель временно недоступна. Мы уже в процессе её восстановления.',
      type: 503,
    });
  });

  it.each([
    ['context_length_exceeded', 'context_length_exceeded', 413],
    ['content_policy_violation', 'provider_moderation', 400],
    ['openai_url_timeout', 'provider_invalid_media', 400],
    ['invalid_parameter', 'provider_invalid_parameters', 400],
    ['rate_limit_exceeded', 'provider_rate_limit', 429],
    ['overloaded_error', 'provider_overloaded', 503],
    ['upstream_timeout', 'provider_timeout', 504],
    ['free_router_unavailable', 'provider_unavailable', 503],
  ])('preserves the reason behind a generic wrapper for %s', (vendorCode, code, status) => {
    const saved = formatPersistedLLMError({
      status: 500,
      body: { error: { code: vendorCode, message: 'private provider details' } },
    });
    expect(saved.body).toEqual({ code, status });
    expect(saved.type).toBe(status);
    expect(saved.message).not.toContain('private');
  });

  it('recognizes a nested billing refusal without mistaking provider quota for customer balance', () => {
    const billing = formatPersistedLLMError({
      errorType: 'ProviderBizError',
      error: {
        error: { code: 'billing_error', type: 'insufficient_balance', message: 'hidden' },
      },
    });
    expect(billing.body).toEqual({ code: 'studio_insufficient_balance', status: 402 });
    expect(formatPersistedLLMError(new Error('Insufficient balance')).body.code).not.toBe(
      'studio_insufficient_balance',
    );
    expect(formatPersistedLLMError({ errorType: 'InsufficientQuota' }).body.status).toBe(429);
  });

  it('persists the Studio quota reset from Google details without retaining the provider body', () => {
    const resetAt = 1_800_000_000;
    const original = {
      body: {
        error: {
          code: 429,
          details: [
            { reason: 'studio_chat_hourly_limit', reset_at: resetAt },
            { reason: 'studio_chat_hourly_limit', retrySafe: false },
          ],
          message: 'private provider details',
          status: 'RESOURCE_EXHAUSTED',
        },
      },
      status: 500,
    };
    const serialized = JSON.stringify(formatPersistedLLMError(original));
    const restored = ChatMessageErrorSchema.parse(JSON.parse(serialized));
    expect(restored).toEqual({
      body: { code: 'studio_chat_hourly_limit', reset_at: resetAt, status: 429 },
      message: 'Hourly chat request limit reached.',
      type: 429,
    });
  });

  it('keeps old generic 402 rows unverified and recognizes verified Studio rows', () => {
    const legacy = {
      body: { code: 'INSUFFICIENT_BALANCE', status: 402 },
      message: 'Insufficient balance',
      type: 402,
    };
    expect(formatPersistedLLMError(legacy).body).toEqual({ code: 'HTTP_402', status: 402 });
    const fresh = { ...legacy, body: { code: 'studio_insufficient_balance', status: 402 } };
    expect(formatPersistedLLMError(fresh)).toEqual(fresh);
  });

  it('uses known error types when no HTTP status survived and keeps unknown errors generic', () => {
    expect(formatPersistedLLMError({ errorType: 'ModelNotFound' }).body.status).toBe(404);
    expect(formatPersistedLLMError({ errorType: 'ExceededContextWindow' }).body).toEqual({
      code: 'context_length_exceeded',
      status: 413,
    });
    expect(formatPersistedLLMError('unknown secret').body.status).toBe(500);
    expect(getPersistedLLMError(new Error('another error'))).toBeUndefined();
  });
});
