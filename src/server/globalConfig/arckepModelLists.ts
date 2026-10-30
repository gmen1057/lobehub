/**
 * arckep (30.10.2026): единый отслеживаемый в git список включённых моделей движка чата
 * (`image-studio-lobechat-next`, порт 3403) вместо неверсионируемых строк `*_MODEL_LIST` в `.env`.
 *
 * Чат-модели строго синхронизированы с `iter_studio_chat_models()` в `backend/app/data/chat_models.py`
 * (33 актуальные модели чата, включая обе `gpt-6-sol` и `gpt-6.1-sol`; 36 моделей прошлых поколений
 * и `openrouter/auto` оставлены только в публичном API студии). Картиночные и видео-движки без окна
 * контекста и флагов возможностей сохранены в конце списков для внутренних маршрутов генерации
 * (ручка `/api/chat-engine/models` студии их отфильтровывает).
 *
 * Экстренное переопределение без пересборки: переменная окружения `ARCKEP_<PROVIDER>_MODEL_LIST`.
 */
export const ARCKEP_STUDIO_MODEL_LISTS: Readonly<Record<string, string>> = {
  anthropic: [
    '-all',
    '+claude-fable-5-1=Claude Fable 5.1<1000000:fc:vision:reasoning>',
    '+claude-opus-5-5=Claude Opus 5.5<1000000:fc:vision:reasoning>',
    '+claude-sonnet-5-5=Claude Sonnet 5.5<1000000:fc:vision:reasoning>',
    '+claude-haiku-5-5=Claude Haiku 5.5<1000000:fc:vision:reasoning>',
  ].join(','),

  deepseek: [
    '-all',
    '+deepseek-flash=DeepSeek V4.1 Flash<1000000:fc:vision:reasoning>',
    '+deepseek-v4-pro=DeepSeek V4 Pro<1000000:fc:reasoning>',
  ].join(','),

  google: [
    '-all',
    '+gemini-4-argon=Gemini 4 Argon<1048576:fc:vision:reasoning>',
    '+gemini-3.8-flash=Gemini 3.8 Flash<1048576:fc:vision:reasoning>',
    '+gemini-3.1-flash-lite=Gemini 3.1 Flash Lite<1048576:fc:vision>',
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
  ].join(','),

  openai: [
    '-all',
    '+gpt-6.1-sol=GPT-6.1 Sol<1050000:fc:vision:reasoning>',
    '+gpt-6.1-terra=GPT-6.1 Terra<1050000:fc:vision:reasoning>',
    '+gpt-6-sol=GPT-6 Sol<1050000:fc:vision:reasoning>',
    '+gpt-6-luna=GPT-6 Luna<1050000:fc:vision:reasoning>',
    '+gpt-6-astra=GPT-6 Astra<1050000:fc:vision:reasoning>',
    '+gpt-image-2',
    '+gpt-image-1.5',
    '+gpt-image-1-mini',
    '+sora-2',
    '+sora-2-pro',
  ].join(','),

  openrouter: [
    '-all',
    '+openrouter/free=Бесплатные модели<200000:fc:vision>',
    '+meta/muse-wonder=Meta Muse Wonder<1048576:fc:vision:reasoning>',
    '+moonshotai/kimi-k3.1-pro=Kimi K3.1 Pro<1048576:fc:vision:reasoning>',
    '+moonshotai/kimi-k2.7-code=Kimi K2.7 Code<262144:fc:vision:reasoning>',
    '+mistralai/mistral-large-4-0=Mistral Large 4<1048576:fc:vision:reasoning>',
    '+z-ai/glm-5.3=GLM-5.3<1000000:fc:reasoning>',
    '+z-ai/glm-5.3-flash=GLM-5.3 Flash<1000000:fc:vision:reasoning>',
    '+minimax/minimax-m3.1-flash=MiniMax M3.1 Flash<1000000:fc:vision:reasoning>',
    '+xiaomi/mimo-v2.6-pro=MiMo V2.6 Pro<1048576:fc>',
    '+xiaomi/mimo-v2.6-flash=MiMo V2.6 Flash<1048576:fc>',
    '+tencent/hy4-preview=Hunyuan 4<1048576:fc:reasoning>',
    '+inception/mercury-3=Mercury 3<1000000:fc:reasoning>',
  ].join(','),

  qwen: [
    '-all',
    '+qwen3.8-max=Qwen 3.8 Max<1000000:fc:vision:reasoning>',
    '+qwen3.8-flash=Qwen 3.8 Flash<1000000:fc:vision:reasoning>',
    '+qwen3.8-omni-flash=Qwen 3.8 Omni Flash<1000000:fc:vision:reasoning>',
    '+qwen3.7-plus=Qwen 3.7 Plus<1000000:fc:vision:reasoning>',
    '+qwen3.7-flash=Qwen 3.7 Flash<1000000:fc:vision:reasoning>',
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
  ].join(','),

  xai: [
    '-all',
    '+grok-4.7=Grok 4.7<500000:fc:vision:reasoning>',
    '+grok-build-0.1=Grok Build<256000:fc>',
    '+grok-imagine-image-2.0',
    '+grok-imagine-image-pro',
    '+grok-imagine-image',
    '+grok-imagine-video',
  ].join(','),
};

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
