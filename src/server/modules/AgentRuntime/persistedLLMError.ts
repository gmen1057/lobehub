import type { ChatMessageError } from '@lobechat/types';

import { classifyLLMError } from './llmErrorClassification';
import { STUDIO_CHAT_HOURLY_LIMIT } from './llmErrorRecovery';
import { isProviderFailureCode, providerModelFailure } from './providerModelFailure';

const TYPE_STATUS: Record<string, number> = {
  ExceededContextWindow: 400,
  InsufficientQuota: 429,
  InvalidProviderAPIKey: 401,
  ModelNotFound: 404,
  PermissionDenied: 403,
  QuotaLimitReached: 429,
  Unauthorized: 401,
};

/** Persist a stable code, HTTP category, and quota reset time when present. */
export const formatPersistedLLMError = (error: unknown): ChatMessageError => {
  const signal = classifyLLMError(error);
  if (signal.code === STUDIO_CHAT_HOURLY_LIMIT) {
    return {
      body: { code: signal.code, reset_at: signal.resetAt, status: 429 },
      message: signal.message,
      type: 429 as ChatMessageError['type'],
    };
  }
  if (!signal.billing && isProviderFailureCode(signal.code)) {
    const { code, message, status } = providerModelFailure(signal.code);
    return { body: { code, status }, message, type: status as ChatMessageError['type'] };
  }
  const candidate = signal.status ?? TYPE_STATUS[signal.type || ''];
  const status = signal.billing
    ? 402
    : candidate && Number.isInteger(candidate) && candidate >= 400 && candidate <= 599
      ? candidate
      : 500;

  return {
    body: { code: signal.billing ? 'studio_insufficient_balance' : `HTTP_${status}`, status },
    message: signal.billing ? 'Insufficient balance' : 'Model request failed',
    // ChatMessageErrorSchema accepts any numeric HTTP status, including 402.
    type: status as ChatMessageError['type'],
  };
};

const persistedErrors = new WeakMap<object, ChatMessageError>();

/** Keep the original exception for diagnostics while state/stream use the saved safe cause. */
export const rememberPersistedLLMError = (error: unknown, messageError: ChatMessageError) => {
  const original = error && typeof error === 'object' ? error : new Error(String(error));
  persistedErrors.set(original, messageError);
  return original;
};

export const getPersistedLLMError = (error: unknown) =>
  error && typeof error === 'object' ? persistedErrors.get(error) : undefined;
