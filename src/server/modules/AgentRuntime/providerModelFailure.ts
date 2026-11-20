/** Safe public reasons shared by message persistence and Responses. Vendor diagnostics stay private. */
const failures = {
  context_length_exceeded: [
    413,
    'Текст слишком длинный для этой модели. Сократите сообщение или начните новый чат.',
  ],
  provider_credits_exhausted: [
    503,
    'Сейчас эта модель временно недоступна. Мы уже в процессе её восстановления.',
  ],
  provider_invalid_media: [
    400,
    'Не удалось прочитать вложение. Проверьте файл или загрузите его заново.',
  ],
  provider_invalid_parameters: [400, 'Модель не приняла параметры запроса. Проверьте настройки.'],
  provider_moderation: [
    400,
    'Фильтр безопасности модели отклонил запрос. Измените описание или вложение.',
  ],
  provider_overloaded: [
    503,
    'Модель сейчас перегружена. Попробуйте позже или выберите другую модель.',
  ],
  provider_rate_limit: [429, 'Слишком много запросов к модели. Подождите немного и повторите.'],
  provider_timeout: [504, 'Модель не ответила вовремя. Попробуйте ещё раз.'],
  provider_unavailable: [
    503,
    'Модель временно недоступна. Попробуйте позже или выберите другую модель.',
  ],
} as const;

export type ProviderFailureCode = keyof typeof failures;

export const isProviderFailureCode = (code: unknown): code is ProviderFailureCode =>
  typeof code === 'string' && Object.hasOwn(failures, code);

export const providerModelFailure = (code: ProviderFailureCode) => {
  const [status, message] = failures[code];
  return { code, message, status };
};

// Only map diagnostic codes with a known meaning. A bare 403 may also concern permissions.
const aliases: Record<string, ProviderFailureCode> = {
  exceededcontextwindow: 'context_length_exceeded',
  content_policy_violation: 'provider_moderation',
  content_filter: 'provider_moderation',
  safety_violations: 'provider_moderation',
  content_moderated: 'provider_moderation',
  openai_url_timeout: 'provider_invalid_media',
  context_images_too_large: 'provider_invalid_media',
  image_load_error: 'provider_invalid_media',
  invalid_image: 'provider_invalid_media',
  invalid_image_url: 'provider_invalid_media',
  invalid_parameter: 'provider_invalid_parameters',
  rate_limit_exceeded: 'provider_rate_limit',
  rate_limit_error: 'provider_rate_limit',
  overloaded_error: 'provider_overloaded',
  upstream_timeout: 'provider_timeout',
  request_timeout: 'provider_timeout',
  upstream_unavailable: 'provider_unavailable',
  downstream_service_unavailable: 'provider_unavailable',
  service_unavailable: 'provider_unavailable',
  free_router_unavailable: 'provider_unavailable',
};

export const providerFailureFromCode = (value: unknown): ProviderFailureCode | undefined => {
  if (typeof value !== 'string') return;
  const normalized = value.trim().toLowerCase().replaceAll('-', '_');
  if (isProviderFailureCode(normalized)) return normalized;
  if (Object.hasOwn(aliases, normalized)) return aliases[normalized];
};

// Some SDKs keep the upstream message but discard its code.
export const providerFailureFromMessage = (message: string): ProviderFailureCode | undefined => {
  if (message.includes(failures.provider_credits_exhausted[1])) return 'provider_credits_exhausted';
  if (
    /content[_ -]policy violation|blocked by (?:the )?(?:content|safety) filter|rejected by (?:the )?safety system/i.test(
      message,
    )
  )
    return 'provider_moderation';
  if (
    /failed to (?:download|load) (?:input )?image|unable to download content from the provided url/i.test(
      message,
    )
  )
    return 'provider_invalid_media';
  if (/model is (?:currently |temporarily )?overloaded/i.test(message))
    return 'provider_overloaded';
};
