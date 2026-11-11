import { ENABLE_BUSINESS_FEATURES } from '@lobechat/business-const';

import {
  type AIChatModelCard,
  type AiFullModelCard,
  type LobeDefaultAiModelListItem,
  type Pricing,
} from '../types/aiModel';
import { default as ai21 } from './ai21';
import { default as ai302 } from './ai302';
import { default as ai360 } from './ai360';
import { default as aihubmix } from './aihubmix';
import { default as akashchat } from './akashchat';
import { default as baseAnthropic } from './anthropic';
import {
  ARCKEP_STUDIO_MODEL_CARDS,
  type ArckepStudioProviderId,
} from './arckepStudioModels.generated';
import { default as azure } from './azure';
import { default as azureai } from './azureai';
import { default as baichuan } from './baichuan';
import { default as bailiancodingplan } from './bailianCodingPlan';
import { default as bedrock } from './bedrock';
import { default as bfl } from './bfl';
import { default as cerebras } from './cerebras';
import { default as cloudflare } from './cloudflare';
import { default as cohere } from './cohere';
import { default as cometapi } from './cometapi';
import { default as comfyui } from './comfyui';
import { default as baseDeepseek } from './deepseek';
import { default as fal } from './fal';
import { default as fireworksai } from './fireworksai';
import { default as giteeai } from './giteeai';
import { default as github } from './github';
import { default as githubcopilot } from './githubCopilot';
import { default as glmcodingplan } from './glmCodingPlan';
import { default as baseGoogle } from './google';
import { default as groq } from './groq';
import { default as higress } from './higress';
import { default as huggingface } from './huggingface';
import { default as hunyuan } from './hunyuan';
import { default as infiniai } from './infiniai';
import { default as internlm } from './internlm';
import { default as jina } from './jina';
import { default as kimicodingplan } from './kimiCodingPlan';
import { default as lmstudio } from './lmstudio';
import { default as lobehub } from './lobehub/index';
import { default as longcat } from './longcat';
import { default as minimax } from './minimax';
import { default as minimaxcodingplan } from './minimaxCodingPlan';
import { default as mistral } from './mistral';
import { default as modelscope } from './modelscope';
import { default as moonshot } from './moonshot';
import { default as nebius } from './nebius';
import { default as newapi } from './newapi';
import { default as novita } from './novita';
import { default as nvidia } from './nvidia';
import { default as ollama } from './ollama';
import { default as ollamacloud } from './ollamacloud';
import { default as baseOpenai } from './openai';
import { default as baseOpenrouter } from './openrouter';
import { default as perplexity } from './perplexity';
import { default as ppio } from './ppio';
import { default as qiniu } from './qiniu';
import { default as baseQwen } from './qwen';
import { default as replicate } from './replicate';
import { default as sambanova } from './sambanova';
import { default as search1api } from './search1api';
import { default as sensenova } from './sensenova';
import { default as siliconcloud } from './siliconcloud';
import { default as spark } from './spark';
import { default as stepfun } from './stepfun';
import { default as straico } from './straico';
import { default as taichu } from './taichu';
import { default as tencentcloud } from './tencentcloud';
import { default as togetherai } from './togetherai';
import { default as upstage } from './upstage';
import { default as v0 } from './v0';
import { default as vercelaigateway } from './vercelaigateway';
import { default as vertexai } from './vertexai';
import { default as vllm } from './vllm';
import { default as volcengine } from './volcengine';
import { default as volcenginecodingplan } from './volcengineCodingPlan';
import { default as wenxin } from './wenxin';
import { default as baseXai } from './xai';
import { default as xiaomimimo } from './xiaomimimo';
import { default as xinference } from './xinference';
import { default as zenmux } from './zenmux';
import { default as zeroone } from './zeroone';
import { default as zhipu } from './zhipu';

type ModelsMap = Record<string, AiFullModelCard[]>;

const mergeArckepPricing = (
  existingPricing: Pricing | undefined,
  studioPricing: Pricing | undefined,
): Pricing | undefined => {
  if (!existingPricing) return studioPricing;
  if (!studioPricing) return existingPricing;

  const studioFixedRates = new Map<string, number>();
  for (const unit of studioPricing.units) {
    if (unit.strategy === 'fixed') {
      studioFixedRates.set(unit.name, unit.rate);
    }
  }

  const seenNames = new Set<string>();
  const mergedUnits = existingPricing.units.map((unit) => {
    seenNames.add(unit.name);
    if (unit.strategy === 'fixed' && studioFixedRates.has(unit.name)) {
      return { ...unit, rate: studioFixedRates.get(unit.name)! };
    }
    return unit;
  });

  for (const unit of studioPricing.units) {
    if (!seenNames.has(unit.name)) {
      mergedUnits.push(unit);
    }
  }

  return { ...existingPricing, units: mergedUnits };
};

export const withArckepOverlay = (
  provider: ArckepStudioProviderId,
  baseModels: AiFullModelCard[],
): AiFullModelCard[] => {
  const studioCards = ARCKEP_STUDIO_MODEL_CARDS[provider];
  const studioIds = new Set(studioCards.map((card) => card.id));

  const overlaid: AiFullModelCard[] = studioCards.map((studioCard) => {
    const existing = baseModels.find(
      (item): item is AIChatModelCard => item.id === studioCard.id && item.type === 'chat',
    );
    if (!existing) return studioCard;

    return {
      ...existing,
      ...studioCard,
      abilities: { ...existing.abilities, ...studioCard.abilities },
      pricing: mergeArckepPricing(existing.pricing, studioCard.pricing),
      settings: studioCard.settings
        ? { ...existing.settings, ...studioCard.settings }
        : existing.settings,
    };
  });

  const rest = baseModels.filter((model) => model.type !== 'chat' || !studioIds.has(model.id));
  return [...overlaid, ...rest];
};

export const anthropic = withArckepOverlay('anthropic', baseAnthropic);
export const deepseek = withArckepOverlay('deepseek', baseDeepseek);
export const google = withArckepOverlay('google', baseGoogle);
export const openai = withArckepOverlay('openai', baseOpenai);
export const openrouter = withArckepOverlay('openrouter', baseOpenrouter);
export const qwen = withArckepOverlay('qwen', baseQwen);
export const xai = withArckepOverlay('xai', baseXai);

const buildDefaultModelList = (map: ModelsMap): LobeDefaultAiModelListItem[] => {
  let models: LobeDefaultAiModelListItem[] = [];

  Object.entries(map).forEach(([provider, providerModels]) => {
    const newModels = providerModels.map((model) => ({
      ...model,
      abilities: model.abilities ?? {},
      enabled: model.enabled || false,
      providerId: provider,
      source: 'builtin',
    }));
    models = models.concat(newModels);
  });

  return models;
};

export const LOBE_DEFAULT_MODEL_LIST = buildDefaultModelList({
  ai21,
  ai302,
  ai360,
  aihubmix,
  akashchat,
  anthropic,
  azure,
  azureai,
  baichuan,
  bailiancodingplan,
  bedrock,
  bfl,
  cerebras,
  cloudflare,
  cohere,
  cometapi,
  comfyui,
  deepseek,
  fal,
  fireworksai,
  giteeai,
  github,
  githubcopilot,
  google,
  glmcodingplan,
  groq,
  higress,
  huggingface,
  hunyuan,
  infiniai,
  internlm,
  jina,
  kimicodingplan,
  lmstudio,
  longcat,
  ...(ENABLE_BUSINESS_FEATURES ? { lobehub } : {}),
  minimax,
  minimaxcodingplan,
  mistral,
  modelscope,
  moonshot,
  nebius,
  newapi,
  novita,
  nvidia,
  ollama,
  ollamacloud,
  openai,
  openrouter,
  perplexity,
  ppio,
  qiniu,
  qwen,
  replicate,
  sambanova,
  search1api,
  sensenova,
  siliconcloud,
  spark,
  stepfun,
  straico,
  taichu,
  tencentcloud,
  togetherai,
  upstage,
  v0,
  vercelaigateway,
  vertexai,
  vllm,
  volcengine,
  volcenginecodingplan,
  wenxin,
  xai,
  xiaomimimo,
  xinference,
  zenmux,
  zeroone,
  zhipu,
});

export { default as ai21 } from './ai21';
export { default as ai302 } from './ai302';
export { default as ai360 } from './ai360';
export { default as aihubmix } from './aihubmix';
export { default as akashchat } from './akashchat';
export * from './arckepStudioModels.generated';
export { default as azure } from './azure';
export { default as azureai } from './azureai';
export { default as baichuan } from './baichuan';
export { default as bailiancodingplan } from './bailianCodingPlan';
export { default as bedrock } from './bedrock';
export { default as bfl } from './bfl';
export { default as cerebras } from './cerebras';
export { default as cloudflare } from './cloudflare';
export { default as cohere } from './cohere';
export { default as cometapi } from './cometapi';
export { default as comfyui } from './comfyui';
export { default as fal, fluxSchnellParamsSchema } from './fal';
export { default as fireworksai } from './fireworksai';
export { default as giteeai } from './giteeai';
export { default as github } from './github';
export { default as githubcopilot } from './githubCopilot';
export { default as glmcodingplan } from './glmCodingPlan';
export { default as groq } from './groq';
export { default as higress } from './higress';
export { default as huggingface } from './huggingface';
export { default as hunyuan } from './hunyuan';
export { default as infiniai } from './infiniai';
export { default as internlm } from './internlm';
export { default as jina } from './jina';
export { default as kimicodingplan } from './kimiCodingPlan';
export { default as lmstudio } from './lmstudio';
export { default as lobehub } from './lobehub/index';
export { default as longcat } from './longcat';
export { default as minimax } from './minimax';
export { default as minimaxcodingplan } from './minimaxCodingPlan';
export { default as mistral } from './mistral';
export { default as modelscope } from './modelscope';
export { default as moonshot } from './moonshot';
export { default as nebius } from './nebius';
export { default as newapi } from './newapi';
export { default as novita } from './novita';
export { default as nvidia } from './nvidia';
export { default as ollama } from './ollama';
export { default as ollamacloud } from './ollamacloud';
export { gptImage1ParamsSchema, openaiChatModels } from './openai';
export { default as perplexity } from './perplexity';
export { default as ppio } from './ppio';
export { default as qiniu } from './qiniu';
export { default as replicate } from './replicate';
export { default as sambanova } from './sambanova';
export { default as search1api } from './search1api';
export { default as sensenova } from './sensenova';
export { default as siliconcloud } from './siliconcloud';
export { default as spark } from './spark';
export { default as stepfun } from './stepfun';
export { default as straico } from './straico';
export { default as taichu } from './taichu';
export { default as tencentcloud } from './tencentcloud';
export { default as togetherai } from './togetherai';
export { default as upstage } from './upstage';
export { default as v0 } from './v0';
export { default as vercelaigateway } from './vercelaigateway';
export { default as vertexai } from './vertexai';
export { default as vllm } from './vllm';
export { default as volcengine } from './volcengine';
export { default as volcenginecodingplan } from './volcengineCodingPlan';
export { default as wenxin } from './wenxin';
export { default as xiaomimimo } from './xiaomimimo';
export { default as xinference } from './xinference';
export { default as zenmux } from './zenmux';
export { default as zeroone } from './zeroone';
export { default as zhipu } from './zhipu';
