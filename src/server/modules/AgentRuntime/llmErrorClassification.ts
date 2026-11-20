import { readLLMRecoverySignal } from './llmErrorRecovery';

type LLMErrorKind = 'retry' | 'stop';

interface ClassifiedLLMError {
  billing?: boolean;
  code?: string;
  kind: LLMErrorKind;
  message: string;
  retrySafe?: boolean;
  status?: number;
  type?: string;
}

interface LLMErrorSignal {
  /** Нехватка денег на балансе: HTTP 402 или её признаки в сообщении / типе / коде на любом уровне */
  billing?: boolean;
  body?: unknown;
  code?: string;
  details?: unknown;
  errorType?: string;
  message: string;
  retrySafe?: boolean;
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
  'invalid json schema',
  'invalid_json_schema',
  'invalid request',
  'maximum context length',
  'model not found',
  'permission denied',
  'payload',
  'too many tokens',
  'unauthorized',
];

const NON_RETRYABLE_PROVIDER_BIZ_SUBSTRINGS = [
  'field required',
  'input_schema',
  'invalid json schema',
  'invalid request',
  'invalid_json_schema',
  'invalid_request_error',
  'missing required',
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

const normalizeErrorType = (value?: unknown) =>
  typeof value === 'string' ? value.trim() : undefined;

const tryExtractStatus = (message: string) => {
  const matches = message.match(/\b([45]\d{2})\b/);
  if (!matches) return;

  const status = Number(matches[1]);
  return Number.isNaN(status) ? undefined : status;
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const pickString = (...candidates: unknown[]): string | undefined => {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return undefined;
};

const extractRetrySafeFromDetails = (details: unknown): boolean | undefined => {
  if (!Array.isArray(details)) return undefined;
  let retrySafe: boolean | undefined;
  for (const item of details) {
    const record = asRecord(item);
    if (!record) continue;
    if (record.retrySafe === false) return false;
    if (record.retrySafe === true && retrySafe === undefined) retrySafe = true;
  }
  return retrySafe;
};

const extractRetrySafe = (value: unknown): boolean | undefined => {
  const raw = asRecord(value);
  if (!raw) return undefined;
  const body = asRecord(raw.body);
  const bodyError = asRecord(body?.error);
  const nested = asRecord(raw.error);
  const nestedError = asRecord(nested?.error);

  const candidates = [
    raw.retrySafe,
    body?.retrySafe,
    bodyError?.retrySafe,
    nested?.retrySafe,
    nestedError?.retrySafe,
    extractRetrySafeFromDetails(raw.details),
    extractRetrySafeFromDetails(body?.details),
    extractRetrySafeFromDetails(bodyError?.details),
    extractRetrySafeFromDetails(nested?.details),
    extractRetrySafeFromDetails(nestedError?.details),
  ];

  let retrySafe: boolean | undefined;
  for (const candidate of candidates) {
    if (candidate === false) return false;
    if (candidate === true && retrySafe === undefined) retrySafe = true;
  }
  return retrySafe;
};

const extractNumericStatus = (...candidates: unknown[]): number | undefined => {
  const statuses: number[] = [];
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      statuses.push(candidate);
    }
  }
  const permanent = statuses.find(
    (status) => status >= 400 && status < 500 && ![408, 425, 429].includes(status),
  );
  return permanent ?? statuses[0];
};

const normalizeSignal = (error: unknown): LLMErrorSignal => {
  const billing = hasBillingSignal(error);

  if (typeof error === 'string') {
    const message = error.toLowerCase();
    return { billing, message, status: tryExtractStatus(message) };
  }

  // Stream errors are rethrown as Error objects with the provider payload attached.
  // Read nested status/code for both forms instead of dropping it for instanceof Error.
  if (error && typeof error === 'object') {
    const raw = error as Record<string, unknown>;
    const body = asRecord(raw.body);
    const bodyError = asRecord(body?.error);
    const nested = asRecord(raw.error);
    const nestedError = asRecord(nested?.error);
    const message = (
      pickString(
        raw.message,
        nested?.message,
        nestedError?.message,
        body?.message,
        bodyError?.message,
        raw.name,
      ) || 'unknown error'
    ).toLowerCase();

    return {
      billing,
      body,
      code: normalizeCode(
        raw.code ?? body?.code ?? bodyError?.code ?? nested?.code ?? nestedError?.code,
      ),
      details:
        raw.details ??
        body?.details ??
        bodyError?.details ??
        nested?.details ??
        nestedError?.details,
      errorType: normalizeErrorType(
        raw.errorType ||
          raw.type ||
          nested?.errorType ||
          nested?.type ||
          nestedError?.type ||
          body?.errorType,
      ),
      message,
      retrySafe: extractRetrySafe(error),
      status:
        extractNumericStatus(
          raw.status,
          raw.statusCode,
          body?.status,
          body?.statusCode,
          bodyError?.status,
          bodyError?.statusCode,
          nested?.status,
          nested?.statusCode,
          nestedError?.status,
          nestedError?.statusCode,
        ) ?? tryExtractStatus(message),
    };
  }

  return { message: 'unknown error' };
};

const classifyKind = ({
  billing,
  body,
  code,
  details,
  errorType,
  message,
  retrySafe,
  status,
}: LLMErrorSignal): LLMErrorKind => {
  if (
    retrySafe === false ||
    extractRetrySafeFromDetails(details) === false ||
    extractRetrySafe(body) === false
  ) {
    return 'stop';
  }
  const bodyRecord = asRecord(body);
  const bodyErrorRecord = asRecord(bodyRecord?.error);
  const resolvedStatus =
    status ??
    extractNumericStatus(
      bodyRecord?.status,
      bodyRecord?.statusCode,
      bodyErrorRecord?.status,
      bodyErrorRecord?.statusCode,
    );

  // Нехватка баланса — до разбора errorType: у провайдеров она приходит как ProviderBizError (повторяемый)
  if (billing || resolvedStatus === PAYMENT_REQUIRED_STATUS) return 'stop';

  // A provider wrapper describes the source, not whether a request can succeed
  // unchanged. Preserve the permanent HTTP refusal before its generic retry type.
  if (
    resolvedStatus !== undefined &&
    resolvedStatus >= 400 &&
    resolvedStatus < 500 &&
    ![408, 425, 429].includes(resolvedStatus)
  )
    return 'stop';

  if (errorType === 'ProviderBizError') {
    if (hasAnyKeyword(message, NON_RETRYABLE_PROVIDER_BIZ_SUBSTRINGS)) {
      return 'stop';
    }
    if (code && (code.includes('INVALID_JSON_SCHEMA') || code.includes('INVALID_REQUEST'))) {
      return 'stop';
    }
  }

  if (errorType) {
    if (STOP_ERROR_TYPES.has(errorType)) return 'stop';
    if (RETRY_ERROR_TYPES.has(errorType)) return 'retry';
  }

  if (code) {
    if (code.includes('UNAUTHORIZED') || code.includes('FORBIDDEN')) return 'stop';
    if (code.includes('MODEL_NOT_FOUND') || code.includes('INVALID_JSON_SCHEMA')) return 'stop';
    if (code.includes('RATE_LIMIT') || code.includes('TIMEOUT')) return 'retry';
  }

  if (
    resolvedStatus !== undefined &&
    (resolvedStatus === 408 ||
      resolvedStatus === 425 ||
      resolvedStatus === 429 ||
      resolvedStatus >= 500)
  )
    return 'retry';

  if (hasAnyKeyword(message, STOP_KEYWORDS)) return 'stop';
  if (hasAnyKeyword(message, RETRY_KEYWORDS)) return 'retry';

  return 'retry';
};

export const classifyLLMError = (error: unknown): ClassifiedLLMError => {
  const normalized = normalizeSignal(error);
  const recovery = readLLMRecoverySignal(error);
  const retrySafe =
    recovery.retrySafe === false || normalized.retrySafe === false
      ? false
      : (recovery.retrySafe ?? normalized.retrySafe);
  const signal = {
    ...normalized,
    retrySafe,
    status: recovery.status ?? normalized.status,
  };

  const providerWallet = recovery.providerCode === 'provider_credits_exhausted';
  return {
    billing: !providerWallet && recovery.customerBalance,
    code: recovery.providerCode ?? (signal.code || signal.errorType),
    kind: providerWallet ? 'stop' : classifyKind(signal),
    message: signal.message,
    retrySafe: signal.retrySafe,
    status: signal.status,
    type: signal.errorType,
  };
};

export type { ClassifiedLLMError, LLMErrorKind };
