import * as modelBank from 'model-bank';

/**
 * Working auto-compression thresholds for flat-priced 1M-context models (no long-context price cliff):
 * - Initial auto-compression triggers above 345,000 tokens
 * - Subsequent recompression triggers above 415,000 tokens
 */
export const EFFECTIVE_AUTO_COMPRESS_WINDOW_CAP = 1_000_000;
export const FLAT_LONG_CONTEXT_MIN_WINDOW = 500_000;
export const FLAT_LONG_CONTEXT_INITIAL_RATIO = 0.345;
export const FLAT_LONG_CONTEXT_RECOMPRESSION_RATIO = 0.415;

export const DEFAULT_AUTO_COMPRESS_WINDOW = 128_000;
export const DEFAULT_INITIAL_THRESHOLD_RATIO = 0.5;
export const DEFAULT_RECOMPRESSION_THRESHOLD_RATIO = 0.65;
/**
 * Mid-turn compression only fires as an emergency safety net near the model's real physical window
 * (e.g. 850K on a 1M model), so large active requests that fit inside the model's window finish
 * uninterrupted on warm prompt cache and compress cleanly at the next turn boundary (Step 0).
 */
export const DEFAULT_MID_TURN_EMERGENCY_RATIO = 0.85;

export interface CompressionWindowPolicy {
  maxWindowToken: number;
  midTurnThresholdRatio?: number;
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

export const isDeepSeekDataGuardProtected = (agentConfig?: AgentConfigLike | null): boolean =>
  Boolean(
    (agentConfig?.chatConfig as { deepseekDataGuardProtected?: unknown } | null | undefined)
      ?.deepseekDataGuardProtected,
  );

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

const OPENAI_272K_CLIFF_POLICY: CompressionWindowPolicy = {
  // OpenAI 1M/1.05M models double input/cache price (2x in, 1.5x out) strictly above 272K tokens.
  // Match OpenAI Codex (~240K initial, 255K recompression) to compress before the 272K cliff.
  maxWindowToken: 1_000_000,
  recompressionThresholdRatio: 0.255,
  thresholdRatio: 0.24,
};

/**
 * Explicit model/route auto-compression policies for models with hard provider long-context
 * pricing cliffs below the flat 1M default (345K / 415K).
 *
 * NOTE: Do NOT pin `deepseek/deepseek-flash` to 32,768 here. `api.deepseek.com` accepts the full
 * 1M total context window; DeepSeek's 32,768-token error (`user input too long, N tokens exceeds
 * max 32768 tokens`) is a per-user-turn limit, not a total context window ceiling.
 */
export const ROUTE_INPUT_LIMIT_OVERRIDES: Readonly<Record<string, CompressionWindowPolicy>> = {
  // Claude Haiku 5.5 charges 5x across the entire request above 100K input+cache tokens.
  'anthropic/claude-haiku-5-5': {
    maxWindowToken: 100_000,
    recompressionThresholdRatio: 0.92,
    thresholdRatio: 0.85,
  },
  // OpenAI 1M/1.05M lineup (>272K => 2x input/cache, 1.5x output)
  'openai/gpt-5.4': OPENAI_272K_CLIFF_POLICY,
  'openai/gpt-5.5': OPENAI_272K_CLIFF_POLICY,
  'openai/gpt-6-astra': OPENAI_272K_CLIFF_POLICY,
  'openai/gpt-6-luna': OPENAI_272K_CLIFF_POLICY,
  'openai/gpt-6-sol': OPENAI_272K_CLIFF_POLICY,
  'openai/gpt-6.1-sol': OPENAI_272K_CLIFF_POLICY,
  'openai/gpt-6.1-terra': OPENAI_272K_CLIFF_POLICY,
  'openai/gpt-6.2-astra': OPENAI_272K_CLIFF_POLICY,
  'openai/gpt-6.2-sol': OPENAI_272K_CLIFF_POLICY,
  // xAI Grok 4.7 (500K window) doubles upstream cost at >=200K tokens.
  'xai/grok-4.7': {
    maxWindowToken: 200_000,
    recompressionThresholdRatio: 0.95,
    thresholdRatio: 0.9,
  },
};

const isOpenAI272kCliffModel = (model: string, provider?: string): boolean => {
  if (provider && provider !== 'openai') return false;
  if (/-(?:mini|nano)(?:-|$)/i.test(model)) return false;
  return /^gpt-(?:5\.[456]|6(?:\.[12])?)(?:-|$)/i.test(model);
};

export const resolveCompressionThresholds = (
  model?: string,
  provider?: string,
): CompressionWindowPolicy => {
  if (!model) {
    return {
      maxWindowToken: DEFAULT_AUTO_COMPRESS_WINDOW,
      midTurnThresholdRatio: DEFAULT_MID_TURN_EMERGENCY_RATIO,
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

  const routeKey = provider ? `${provider}/${model}` : model;
  const routeOverride =
    ROUTE_INPUT_LIMIT_OVERRIDES[routeKey] ??
    ROUTE_INPUT_LIMIT_OVERRIDES[model] ??
    (model === 'claude-haiku-5-5'
      ? ROUTE_INPUT_LIMIT_OVERRIDES['anthropic/claude-haiku-5-5']
      : model === 'grok-4.7'
        ? ROUTE_INPUT_LIMIT_OVERRIDES['xai/grok-4.7']
        : isOpenAI272kCliffModel(model, provider) &&
            (!hasMatchedCardWindow || cardWindow >= FLAT_LONG_CONTEXT_MIN_WINDOW)
          ? OPENAI_272K_CLIFF_POLICY
          : undefined);

  if (routeOverride) {
    return {
      ...routeOverride,
      midTurnThresholdRatio:
        routeOverride.midTurnThresholdRatio ?? DEFAULT_MID_TURN_EMERGENCY_RATIO,
      physicalWindowToken: hasMatchedCardWindow
        ? cardWindow
        : Math.max(cardWindow, routeOverride.maxWindowToken),
    };
  }

  if (cardWindow >= FLAT_LONG_CONTEXT_MIN_WINDOW) {
    return {
      maxWindowToken: EFFECTIVE_AUTO_COMPRESS_WINDOW_CAP,
      midTurnThresholdRatio: DEFAULT_MID_TURN_EMERGENCY_RATIO,
      physicalWindowToken: cardWindow,
      recompressionThresholdRatio: FLAT_LONG_CONTEXT_RECOMPRESSION_RATIO,
      thresholdRatio: FLAT_LONG_CONTEXT_INITIAL_RATIO,
    };
  }

  return {
    maxWindowToken: Math.min(cardWindow, EFFECTIVE_AUTO_COMPRESS_WINDOW_CAP),
    midTurnThresholdRatio: DEFAULT_MID_TURN_EMERGENCY_RATIO,
    physicalWindowToken: cardWindow,
    recompressionThresholdRatio: DEFAULT_RECOMPRESSION_THRESHOLD_RATIO,
    thresholdRatio: DEFAULT_INITIAL_THRESHOLD_RATIO,
  };
};
