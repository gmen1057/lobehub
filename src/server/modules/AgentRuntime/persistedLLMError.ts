import type { ChatMessageError } from '@lobechat/types';

import { classifyLLMError } from './llmErrorClassification';

const TYPE_STATUS: Record<string, number> = {
  ExceededContextWindow: 400,
  InsufficientQuota: 429,
  InvalidProviderAPIKey: 401,
  ModelNotFound: 404,
  PermissionDenied: 403,
  QuotaLimitReached: 429,
  Unauthorized: 401,
};

/** Persist only an HTTP category and a stable code, never a provider body or credentials. */
export const formatPersistedLLMError = (error: unknown): ChatMessageError => {
  const signal = classifyLLMError(error);
  const candidate = signal.status ?? TYPE_STATUS[signal.type || ''];
  const status = signal.billing
    ? 402
    : candidate && Number.isInteger(candidate) && candidate >= 400 && candidate <= 599
      ? candidate
      : 500;

  return {
    body: { code: status === 402 ? 'INSUFFICIENT_BALANCE' : `HTTP_${status}`, status },
    message: status === 402 ? 'Insufficient balance' : 'Model request failed',
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
