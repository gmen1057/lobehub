import {
  type ProviderFailureCode,
  providerFailureFromCode,
  providerFailureFromMessage,
} from './providerModelFailure';

export const STUDIO_CHAT_HOURLY_LIMIT = 'studio_chat_hourly_limit';

export const studioChatHourlyLimitError = (resetAt: unknown) =>
  ({
    code: STUDIO_CHAT_HOURLY_LIMIT,
    message: 'Hourly chat request limit reached.',
    reset_at:
      typeof resetAt === 'number' && Number.isSafeInteger(resetAt) && resetAt > 0
        ? resetAt
        : undefined,
    status: 429,
  }) as const;

export interface RejectedInputSize {
  inputTokens: number;
  maxTokens: number;
}

interface LLMRecoverySignal {
  customerBalance: boolean;
  providerCode?: ProviderFailureCode;
  rejectedInput?: RejectedInputSize;
  retrySafe?: boolean;
  status?: number;
  studioChatHourlyLimit?: ReturnType<typeof studioChatHourlyLimitError>;
}

/** Read the proxy's recovery decision through SDK/error/SSE wrappers. */
export const readLLMRecoverySignal = (error: unknown): LLMRecoverySignal => {
  const seen = new Set<object>();
  const statuses: number[] = [];
  let customerBalance = false;
  let providerCode: ProviderFailureCode | undefined;
  const rememberCode = (code?: ProviderFailureCode) => {
    if (!providerCode || code === 'provider_credits_exhausted') providerCode = code;
  };
  let retrySafe: boolean | undefined;
  let studioChatHourlyLimit: LLMRecoverySignal['studioChatHourlyLimit'];
  let rejectedInput: RejectedInputSize | undefined;
  let emptyUpstreamRefusal = false;
  let upstreamReportedWork = false;
  let remaining = 128;

  const visit = (value: unknown, depth = 0): void => {
    if (depth > 8 || remaining-- <= 0) return;
    if (typeof value === 'string') {
      if (value.length > 64_000) return;
      if (!/^\s*[[{]/.test(value)) {
        if (
          value.includes(
            'Недостаточно средств на балансе. Пополните баланс: https://arckep.ru/settings#balance',
          )
        ) {
          customerBalance = true;
        }
        // A measured input rejection is distinct from a generic HTTP body-size or max_output error.
        const counts =
          /user input too long, (\d+) tokens exceeds max (\d+) tokens/i.exec(value) ??
          /prompt is too long:\s*(\d+)(?: tokens)?\s*>\s*(\d+) maximum/i.exec(value) ??
          /input token count \((\d+)\) exceeds the maximum number of tokens allowed \((\d+)\)/i.exec(
            value,
          );
        if (counts) {
          const inputTokens = Number(counts[1]);
          const maxTokens = Number(counts[2]);
          if (Number.isSafeInteger(inputTokens) && inputTokens > maxTokens && maxTokens > 0) {
            rejectedInput = { inputTokens, maxTokens };
          }
        }
        rememberCode(providerFailureFromMessage(value));
        return;
      }
      try {
        visit(JSON.parse(value), depth + 1);
      } catch {
        // Ordinary provider text is not a JSON envelope.
      }
      return;
    }
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    const record = value as Record<string, unknown>;
    if (
      (record.code === STUDIO_CHAT_HOURLY_LIMIT || record.reason === STUDIO_CHAT_HOURLY_LIMIT) &&
      studioChatHourlyLimit?.reset_at === undefined
    ) {
      studioChatHourlyLimit = studioChatHourlyLimitError(record.reset_at);
    }
    if (
      record.code === 'studio_insufficient_balance' ||
      (record.code === 'billing_error' && record.type === 'insufficient_balance')
    ) {
      customerBalance = true;
    }
    for (const field of ['code', 'type', 'status', 'errorType']) {
      rememberCode(providerFailureFromCode(record[field]));
    }
    if (record.hasOutput === true || record.hasUsage === true) upstreamReportedWork = true;
    if (
      record.retryOwner === 'engine' &&
      record.reason === 'upstream_error' &&
      record.hasOutput === false &&
      record.hasUsage === false
    )
      emptyUpstreamRefusal = true;
    // A refusal to replay wins over every outer wrapper's generic retry flag.
    if (record.retrySafe === false) retrySafe = false;
    else if (record.retrySafe === true && retrySafe === undefined) retrySafe = true;
    for (const key of ['status', 'statusCode', 'code']) {
      const candidate = record[key];
      const status = typeof candidate === 'number' ? candidate : Number(candidate);
      if (Number.isInteger(status) && status >= 400 && status <= 599) statuses.push(status);
    }
    for (const key of ['error', 'body', 'details', 'cause', 'message']) {
      visit(record[key], depth + 1);
    }
  };

  visit(error);
  // A transport wrapper's 500 must not hide the actual permanent provider refusal.
  const permanent = statuses.find(
    (status) => status >= 400 && status < 500 && ![408, 425, 429].includes(status),
  );
  return {
    customerBalance,
    providerCode,
    rejectedInput:
      permanent === 413 && emptyUpstreamRefusal && !upstreamReportedWork && !customerBalance
        ? rejectedInput
        : undefined,
    retrySafe,
    status: permanent ?? statuses.at(-1),
    studioChatHourlyLimit,
  };
};
