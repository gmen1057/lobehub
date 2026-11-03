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
        error: { message: 'provider details', status }, errorType: 'ProviderBizError',
      });
      const saved = formatPersistedLLMError(original);
      const serialized = JSON.stringify(saved);
      const restored = ChatMessageErrorSchema.parse(JSON.parse(serialized));
      expect(restored.type).toBe(status);
      expect(restored.body.status).toBe(status);
      expect(restored.body.code).toBe(status === 402 ? 'INSUFFICIENT_BALANCE' : `HTTP_${status}`);
      expect(JSON.stringify(restored)).not.toMatch(/sk-private|private\.example|provider details/);
      expect(rememberPersistedLLMError(original, saved)).toBe(original);
      expect(getPersistedLLMError(original)).toEqual(restored);
      expect(original.message).toContain('secret');
    },
  );

  it('recognizes a nested billing refusal without mistaking provider quota for customer balance', () => {
    const billing = formatPersistedLLMError({ errorType: 'ProviderBizError', error: {
      error: { code: 'billing_error', type: 'insufficient_balance', message: 'hidden' },
    } });
    expect(billing.body.status).toBe(402);
    expect(formatPersistedLLMError({ errorType: 'InsufficientQuota' }).body.status).toBe(429);
  });

  it('uses known error types when no HTTP status survived and keeps unknown errors generic', () => {
    expect(formatPersistedLLMError({ errorType: 'ModelNotFound' }).body.status).toBe(404);
    expect(formatPersistedLLMError({ errorType: 'ExceededContextWindow' }).body.status).toBe(400);
    expect(formatPersistedLLMError('unknown secret').body.status).toBe(500);
    expect(getPersistedLLMError(new Error('another error'))).toBeUndefined();
  });
});
