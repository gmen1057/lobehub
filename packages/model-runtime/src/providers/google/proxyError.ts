import type { GenerateContentResponse } from '@google/genai';

/** The internal proxy uses SDK-preserved metadata because the SDK discards SSE error fields. */
export const readInternalProxyError = (chunk: GenerateContentResponse) => {
  if (
    chunk.candidates?.length ||
    chunk.usageMetadata ||
    chunk.promptFeedback?.blockReason !== 'OTHER'
  ) {
    return;
  }
  const message = chunk.promptFeedback.blockReasonMessage;
  if (!message || message.length > 64_000) return;
  try {
    const envelope = JSON.parse(message);
    const error = envelope?.error;
    if (envelope?.arckepProxyError !== 1 || !error || typeof error !== 'object') return;
    if (!Number.isInteger(error.code) || error.code < 400 || error.code > 599) return;
    if (typeof error.message !== 'string' || typeof error.status !== 'string') return;
    if (
      !Array.isArray(error.details) ||
      !error.details.some((detail: unknown) => {
        if (!detail || typeof detail !== 'object') return false;
        const decision = detail as Record<string, unknown>;
        return decision.retryOwner === 'engine' && typeof decision.retrySafe === 'boolean';
      })
    )
      return;
    return {
      code: error.code as number,
      details: error.details as unknown[],
      message: error.message as string,
      status: error.status as string,
    };
  } catch {
    return;
  }
};
