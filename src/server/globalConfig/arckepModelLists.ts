import {
  ARCKEP_STUDIO_CHAT_MODEL_STRINGS,
  ARCKEP_STUDIO_PROVIDER_IDS,
  type ArckepStudioProviderId,
} from 'model-bank/arckepStudioModels';

/**
 * arckep (30.10.2026): единый отслеживаемый в git список включённых моделей движка чата
 * (`image-studio-lobechat-next`, порт 3403) вместо неверсионируемых строк `*_MODEL_LIST` в `.env`.
 *
 * Чат-модели генерируются автоматически из `iter_studio_chat_models()` в `backend/app/data/chat_models.py`
 * (`scripts/generate-lobechat-models.py` → `packages/model-bank/src/aiModels/arckepStudioModels.generated.ts`;
 * модели прошлых поколений и `openrouter/auto` оставлены только в публичном API студии). Картиночные и
 * видео-движки без окна контекста и флагов возможностей вынесены в `ARCKEP_INTERNAL_MEDIA_MODELS` в конце
 * списков для внутренних маршрутов генерации (ручка `/api/chat-engine/models` студии их отфильтровывает).
 *
 * Экстренное переопределение без пересборки: переменная окружения `ARCKEP_<PROVIDER>_MODEL_LIST`.
 */
export const ARCKEP_INTERNAL_MEDIA_MODELS: Partial<
  Record<ArckepStudioProviderId, readonly string[]>
> = {
  google: [
    '+gemini-3.1-flash-image-preview',
    '+gemini-3-pro-image-preview',
    '+gemini-3.1-flash-image-preview:image',
    '+gemini-3-pro-image-preview:image',
    '+imagen-4.0-generate-001',
    '+imagen-4.0-ultra-generate-001',
    '+imagen-4.0-fast-generate-001',
    '+veo-3.1-generate-preview',
    '+veo-3.1-fast-generate-preview',
    '+veo-3.1-lite-generate-preview',
  ],
  openai: ['+gpt-image-2', '+gpt-image-1.5', '+gpt-image-1-mini', '+sora-2', '+sora-2-pro'],
  qwen: [
    '+qwen-image',
    '+qwen-image-2.0',
    '+qwen-image-2.0-pro',
    '+wan2.6-t2v',
    '+wan2.6-i2v',
    '+wan2.6-i2v-flash',
    '+wan2.6-r2v',
    '+wan2.7-t2v',
    '+wan2.7-i2v',
    '+wan2.7-image',
    '+wan2.7-image-pro',
  ],
  xai: [
    '+grok-imagine-image-2.0',
    '+grok-imagine-image-pro',
    '+grok-imagine-image',
    '+grok-imagine-video',
  ],
};

export const ARCKEP_STUDIO_MODEL_LISTS: Readonly<Record<string, string>> = Object.fromEntries(
  ARCKEP_STUDIO_PROVIDER_IDS.map((provider) => [
    provider,
    [
      '-all',
      ...ARCKEP_STUDIO_CHAT_MODEL_STRINGS[provider],
      ...(ARCKEP_INTERNAL_MEDIA_MODELS[provider] ?? []),
    ].join(','),
  ]),
);

export const resolveArckepModelList = (
  provider: string,
  envModelString: string | undefined,
): string | undefined => {
  const override = process.env[`ARCKEP_${provider.toUpperCase()}_MODEL_LIST`];
  if (override !== undefined) return override;
  if (process.env.ARCKEP_ENGINE_SERVICE_KEY?.trim()) {
    return ARCKEP_STUDIO_MODEL_LISTS[provider] ?? envModelString;
  }
  return envModelString;
};
