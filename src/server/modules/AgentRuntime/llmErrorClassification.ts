type LLMErrorKind = 'retry' | 'stop';

interface ClassifiedLLMError {
  code?: string;
  kind: LLMErrorKind;
  message: string;
}

interface LLMErrorSignal {
  /** Нехватка денег на балансе: HTTP 402 или её признаки в сообщении / типе / коде на любом уровне */
  billing?: boolean;
  code?: string;
  errorType?: string;
  message: string;
  status?: number;
}

const RETRY_ERROR_TYPES = new Set([
  'AgentRuntimeError',
  'OllamaServiceUnavailable',
  'ProviderBizError',
  'QuotaLimitReached',
  'StreamChunkError',
]);
const STOP_ERROR_TYPES = new Set([
  'ExceededContextWindow',
  'InsufficientQuota',
  'InvalidBedrockCredentials',
  'InvalidGithubCopilotToken',
  'InvalidGithubToken',
  'InvalidOllamaArgs',
  'InvalidProviderAPIKey',
  'InvalidVertexCredentials',
  'ModelNotFound',
  'PermissionDenied',
  'Unauthorized',
]);

const RETRY_KEYWORDS = [
  '429',
  'connection',
  'econn',
  'network',
  'rate limit',
  'timeout',
  'timed out',
  'temporarily unavailable',
];
const STOP_KEYWORDS = [
  '403',
  'context window',
  'api key',
  'billing',
  'forbidden',
  'insufficient quota',
  'invalid request',
  'maximum context length',
  'model not found',
  'permission denied',
  'payload',
  'too many tokens',
  'unauthorized',
];

const hasAnyKeyword = (text: string, keywords: string[]) =>
  keywords.some((keyword) => text.includes(keyword));

// arckep (19.10.2026): прокси студии на нехватку денег отвечает HTTP 402 с телом
// {"error":{"message":"Недостаточно средств на балансе. Пополните баланс: …","type":"insufficient_balance",
// "code":"billing_error"}}. Повторять такой запрос бессмысленно — каждый повтор снова упирается в баланс.
const BILLING_MARKERS = [
  'billing_error',
  'insufficient balance',
  'insufficient_balance',
  'недостаточно средств',
];
const PAYMENT_REQUIRED_STATUS = 402;

const isBillingText = (value: string) => {
  const text = value.toLowerCase();
  return BILLING_MARKERS.some((marker) => text.includes(marker));
};

/**
 * Признаки нехватки баланса на любой глубине ошибки. Провайдеры model-runtime оборачивают тело ответа
 * по-разному (openai-совместимые и Anthropic кладут {message,type,code} в `error`, а HTTP-статус при этом
 * теряется; Google присылает код числом), поэтому смотрим и статус, и текст сообщения, типа и кода.
 */
const hasBillingSignal = (value: unknown, depth = 4): boolean => {
  if (typeof value === 'string') return isBillingText(value);
  if (!value || typeof value !== 'object' || depth <= 0) return false;

  const raw = value as Record<string, unknown>;
  if (
    raw.status === PAYMENT_REQUIRED_STATUS ||
    raw.statusCode === PAYMENT_REQUIRED_STATUS ||
    raw.code === PAYMENT_REQUIRED_STATUS ||
    raw.code === String(PAYMENT_REQUIRED_STATUS)
  ) {
    return true;
  }

  return ['message', 'type', 'code', 'errorType', 'error', 'body'].some((key) =>
    hasBillingSignal(raw[key], depth - 1),
  );
};

const normalizeCode = (value?: unknown) => {
  // Google присылает код числом (429, 402…): .trim() на числе падал бы прямо в обработчике ошибки
  if (value === undefined || value === null || value === '') return;

  return String(value)
    .trim()
    .toUpperCase()
    .replaceAll(/[\s-]+/g, '_');
};

const normalizeErrorType = (value?: string) => value?.trim();

const tryExtractStatus = (message: string) => {
  const matches = message.match(/\b([45]\d{2})\b/);
  if (!matches) return;

  const status = Number(matches[1]);
  return Number.isNaN(status) ? undefined : status;
};

const normalizeSignal = (error: unknown): LLMErrorSignal => {
  const billing = hasBillingSignal(error);

  if (typeof error === 'string') {
    const message = error.toLowerCase();
    return { billing, message, status: tryExtractStatus(message) };
  }

  if (error instanceof Error) {
    const raw = error as Error & {
      code?: string;
      errorType?: string;
      status?: number;
      statusCode?: number;
      type?: string;
    };
    const message = (raw.message || raw.name || 'unknown error').toLowerCase();

    return {
      billing,
      code: normalizeCode(raw.code),
      errorType: normalizeErrorType(raw.errorType || raw.type),
      message,
      status:
        typeof raw.status === 'number'
          ? raw.status
          : typeof raw.statusCode === 'number'
            ? raw.statusCode
            : tryExtractStatus(message),
    };
  }

  if (error && typeof error === 'object') {
    const raw = error as {
      code?: string;
      error?: {
        code?: string;
        error?: { code?: string; message?: string; status?: number; type?: string };
        errorType?: string;
        message?: string;
        status?: number;
        type?: string;
      };
      errorType?: string;
      message?: string;
      status?: number;
      statusCode?: number;
      type?: string;
    };
    const nested = raw.error;
    const nestedError = nested?.error;
    const message = (
      raw.message ||
      nested?.message ||
      nestedError?.message ||
      'unknown error'
    ).toLowerCase();

    return {
      billing,
      code: normalizeCode(raw.code || nested?.code || nestedError?.code),
      errorType: normalizeErrorType(
        raw.errorType || raw.type || nested?.errorType || nested?.type || nestedError?.type,
      ),
      message,
      status:
        typeof raw.status === 'number'
          ? raw.status
          : typeof raw.statusCode === 'number'
            ? raw.statusCode
            : typeof nested?.status === 'number'
              ? nested.status
              : typeof nestedError?.status === 'number'
                ? nestedError.status
                : tryExtractStatus(message),
    };
  }

  return { message: 'unknown error' };
};

const classifyKind = ({
  billing,
  code,
  errorType,
  message,
  status,
}: LLMErrorSignal): LLMErrorKind => {
  // Нехватка баланса — до разбора errorType: у провайдеров она приходит как ProviderBizError (повторяемый)
  if (billing || status === PAYMENT_REQUIRED_STATUS) return 'stop';

  if (errorType === 'ProviderBizError') {
    if (status === 400 || status === 422) return 'stop';
    if (message.includes('invalid_request_error') || message.includes('invalid request')) {
      return 'stop';
    }
    if (
      message.includes('input_schema') ||
      message.includes('field required') ||
      message.includes('missing required')
    ) {
      return 'stop';
    }
  }

  if (errorType) {
    if (STOP_ERROR_TYPES.has(errorType)) return 'stop';
    if (RETRY_ERROR_TYPES.has(errorType)) return 'retry';
  }

  if (code) {
    if (code.includes('UNAUTHORIZED') || code.includes('FORBIDDEN')) return 'stop';
    if (code.includes('MODEL_NOT_FOUND')) return 'stop';
    if (code.includes('RATE_LIMIT') || code.includes('TIMEOUT')) return 'retry';
  }

  if (status !== undefined) {
    if (status === 401 || status === 403) return 'stop';
    if (status === 400 || status === 404 || status === 409 || status === 422) return 'stop';
    if (status === 408 || status === 425 || status === 429 || status >= 500) return 'retry';
  }

  if (hasAnyKeyword(message, STOP_KEYWORDS)) return 'stop';
  if (hasAnyKeyword(message, RETRY_KEYWORDS)) return 'retry';

  return 'retry';
};

export const classifyLLMError = (error: unknown): ClassifiedLLMError => {
  const signal = normalizeSignal(error);

  return {
    code: signal.code || signal.errorType,
    kind: classifyKind(signal),
    message: signal.message,
  };
};

export type { ClassifiedLLMError, LLMErrorKind };
