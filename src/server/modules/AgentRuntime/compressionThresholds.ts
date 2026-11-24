import * as modelBank from 'model-bank';

/**
 * Unified auto-compression policy across all models:
 * - Quality + budget ceiling: 350,000 tokens for flat-priced 500K–1M+ models
 * - Step-0 initial auto-compression: 80% of effective ceiling
 * - Step-0 recompression (with existing summary): 88% of effective ceiling (hysteresis)
 * - Mid-turn emergency (Step > 0 tool loop):
 *   - 92% of `min(cardWindow, priceCliff)` for price-cliff models and physical windows <= 350K
 *     (strictly above 88% recompression, safely below 100% cliff / 413)
 *   - 85% of real physical window for flat-priced models with physical window > 350K
 *     (e.g. 850K on 1M models), so active tool loops finish on warm cache and compress at Step 0.
 *
 * NOTE: Do NOT pin `deepseek/deepseek-flash` to 32,768 here. `api.deepseek.com` accepts the full
 * 1M total context window; DeepSeek's 32,768-token error (`user input too long, N tokens exceeds
 * max 32768 tokens`) is a per-user-turn limit, not a total context window ceiling.
 */
export const EFFECTIVE_AUTO_COMPRESS_WINDOW_CAP = 350_000;
export const DEFAULT_AUTO_COMPRESS_WINDOW = 128_000;
export const DEFAULT_INITIAL_THRESHOLD_RATIO = 0.8;
export const DEFAULT_RECOMPRESSION_THRESHOLD_RATIO = 0.88;
export const DEFAULT_MID_TURN_CLIFF_EMERGENCY_RATIO = 0.92;
export const DEFAULT_MID_TURN_EMERGENCY_RATIO = 0.85;

export interface CompressionWindowPolicy {
  maxWindowToken: number;
  midTurnThresholdRatio?: number;
  midTurnWindowToken?: number;
  physicalWindowToken?: number;
  recompressionThresholdRatio: number;
  thresholdRatio: number;
}

export interface CompressionModelConfig {
  effort?: 'low' | 'medium' | 'high' | 'max';
  model: string;
  provider: string;
}

/**
 * Default model for context summarization.
 * DeepSeek V4.1 Flash has a flat 0–1M price ($0.30/$1.20 peak, $0.15/$0.60 off-peak — 1.7–3.4x cheaper
 * than Claude Haiku 5.5 above Haiku's 100K ×5 cliff) and keeps all compressions in a single contour
 * identical to Data Guard.
 */
export const DEFAULT_COMPRESSION_MODEL: Readonly<CompressionModelConfig> = {
  model: 'deepseek-flash',
  provider: 'deepseek',
};

export const DATA_GUARD_COMPRESSION_MODEL: Readonly<CompressionModelConfig> = {
  model: 'deepseek-flash',
  provider: 'deepseek',
};

export interface AgentConfigLike {
  chatConfig?: object | null;
}

export const isDeepSeekDataGuardProtected = (agentConfig?: AgentConfigLike | null): boolean => {
  const cfg = agentConfig?.chatConfig as
    { dataGuardProtected?: unknown; deepseekDataGuardProtected?: unknown } | null | undefined;
  return Boolean(cfg?.dataGuardProtected || cfg?.deepseekDataGuardProtected);
};

/**
 * Resolves the cost-efficient model for context summarization (ENG-2B).
 * Unconditionally keeps protected Data Guard topics on deepseek/deepseek-flash
 * so protected content never leaves the approved contour.
 */
export const resolveCompressionModelConfig = (params?: {
  agentConfig?: AgentConfigLike | null;
  explicitCompressionModel?: CompressionModelConfig;
}): CompressionModelConfig => {
  if (isDeepSeekDataGuardProtected(params?.agentConfig)) {
    return { ...DATA_GUARD_COMPRESSION_MODEL };
  }
  if (params?.explicitCompressionModel?.model && params.explicitCompressionModel.provider) {
    return { ...params.explicitCompressionModel };
  }
  return { ...DEFAULT_COMPRESSION_MODEL };
};

const isOpenAI272kCliffModel = (model: string, provider?: string): boolean => {
  if (provider && provider !== 'openai') return false;
  if (/-(?:mini|nano)(?:-|$)/i.test(model)) return false;
  return /^gpt-(?:5\.[456]|6(?:\.[12])?)(?:-|$)/i.test(model);
};

const resolvePriceCliffTokens = (
  model: string,
  provider: string | undefined,
  cardWindow: number,
  hasMatchedCardWindow: boolean,
): number | undefined => {
  const priceCliffMap =
    (modelBank.ARCKEP_STUDIO_PRICE_CLIFF_TOKENS as
      Record<string, Readonly<Record<string, number>>> | undefined) ?? {};

  if (provider) {
    const providerCliffs = priceCliffMap[provider];
    if (providerCliffs && Object.hasOwn(providerCliffs, model)) {
      const cliff = providerCliffs[model];
      if (typeof cliff === 'number' && cliff > 0) return cliff;
    }
  } else {
    for (const providerCliffs of Object.values(priceCliffMap)) {
      if (providerCliffs && Object.hasOwn(providerCliffs, model)) {
        const cliff = providerCliffs[model];
        if (typeof cliff === 'number' && cliff > 0) return cliff;
      }
    }
  }

  // Fallback for legacy/retired models not listed in active ARCKEP_STUDIO_PRICE_CLIFF_TOKENS
  if (model === 'claude-haiku-5-5' && (!provider || provider === 'anthropic')) return 100_000;
  if (model === 'grok-4.7' && (!provider || provider === 'xai')) return 200_000;
  if (isOpenAI272kCliffModel(model, provider) && (!hasMatchedCardWindow || cardWindow > 272_000)) {
    return 272_000;
  }

  return undefined;
};

export const resolveCompressionThresholds = (
  model?: string,
  provider?: string,
): CompressionWindowPolicy => {
  if (!model) {
    return {
      maxWindowToken: DEFAULT_AUTO_COMPRESS_WINDOW,
      midTurnThresholdRatio: DEFAULT_MID_TURN_CLIFF_EMERGENCY_RATIO,
      midTurnWindowToken: DEFAULT_AUTO_COMPRESS_WINDOW,
      physicalWindowToken: DEFAULT_AUTO_COMPRESS_WINDOW,
      recompressionThresholdRatio: DEFAULT_RECOMPRESSION_THRESHOLD_RATIO,
      thresholdRatio: DEFAULT_INITIAL_THRESHOLD_RATIO,
    };
  }

  const modelList = Array.isArray(modelBank.LOBE_DEFAULT_MODEL_LIST)
    ? modelBank.LOBE_DEFAULT_MODEL_LIST
    : [];

  const matchedCard =
    modelList.find(
      (item) =>
        item.id === model &&
        (!provider || item.providerId === provider) &&
        (!item.type || item.type === 'chat'),
    ) ?? modelList.find((item) => item.id === model && (!item.type || item.type === 'chat'));

  const hasMatchedCardWindow =
    typeof matchedCard?.contextWindowTokens === 'number' && matchedCard.contextWindowTokens > 0;
  const cardWindow = hasMatchedCardWindow
    ? matchedCard!.contextWindowTokens!
    : DEFAULT_AUTO_COMPRESS_WINDOW;

  const priceCliff = resolvePriceCliffTokens(model, provider, cardWindow, hasMatchedCardWindow);
  const effectiveCeiling = Math.min(
    cardWindow,
    priceCliff ?? Number.POSITIVE_INFINITY,
    EFFECTIVE_AUTO_COMPRESS_WINDOW_CAP,
  );
  const midTurnWindowToken =
    priceCliff !== undefined ? Math.min(cardWindow, priceCliff) : cardWindow;
  const midTurnThresholdRatio =
    priceCliff !== undefined || cardWindow <= EFFECTIVE_AUTO_COMPRESS_WINDOW_CAP
      ? DEFAULT_MID_TURN_CLIFF_EMERGENCY_RATIO
      : DEFAULT_MID_TURN_EMERGENCY_RATIO;

  return {
    maxWindowToken: effectiveCeiling,
    midTurnThresholdRatio,
    midTurnWindowToken,
    physicalWindowToken: cardWindow,
    recompressionThresholdRatio: DEFAULT_RECOMPRESSION_THRESHOLD_RATIO,
    thresholdRatio: DEFAULT_INITIAL_THRESHOLD_RATIO,
  };
};
