import * as modelBank from 'model-bank';

/**
 * Effective working context ceiling for automatic compression on long-context (500K–1M+) models.
 * With initial thresholdRatio = 0.5 and recompressionThresholdRatio = 0.65:
 * - Initial auto-compression triggers above 180,000 tokens
 * - Subsequent recompression triggers above 234,000 tokens
 * Avoiding premature 64K compressions preserves prompt cache prefixes and tool read cursors.
 */
export const EFFECTIVE_AUTO_COMPRESS_WINDOW_CAP = 360_000;

export const DEFAULT_AUTO_COMPRESS_WINDOW = 128_000;
export const DEFAULT_INITIAL_THRESHOLD_RATIO = 0.5;
export const DEFAULT_RECOMPRESSION_THRESHOLD_RATIO = 0.65;

export interface CompressionWindowPolicy {
  maxWindowToken: number;
  recompressionThresholdRatio: number;
  thresholdRatio: number;
}

export interface CompressionModelConfig {
  effort?: 'low' | 'medium' | 'high' | 'max';
  model: string;
  provider: string;
}

export const DEFAULT_COMPRESSION_MODEL: Readonly<CompressionModelConfig> = {
  effort: 'low',
  model: 'claude-haiku-5-5',
  provider: 'anthropic',
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

/**
 * Explicit provider route input token ceilings where the upstream gateway enforces
 * a tighter total-context limit than the model card's nominal contextWindowTokens.
 *
 * NOTE: Do NOT pin `deepseek/deepseek-flash` to 32,768 here. `api.deepseek.com` accepts the full
 * 1M total context window; DeepSeek's 32,768-token error (`user input too long, N tokens exceeds
 * max 32768 tokens`) is a per-user-turn limit, not a total context window ceiling. Pinning
 * `maxWindowToken: 32_768` caused premature compression at ~22K–26K tokens and mid-turn loops
 * (incident 2026-11-22, tpc_58kV1gVvDwa1).
 */
export const ROUTE_INPUT_LIMIT_OVERRIDES: Readonly<Record<string, CompressionWindowPolicy>> = {};

export const resolveCompressionThresholds = (
  model?: string,
  provider?: string,
): CompressionWindowPolicy => {
  if (!model) {
    return {
      maxWindowToken: DEFAULT_AUTO_COMPRESS_WINDOW,
      recompressionThresholdRatio: DEFAULT_RECOMPRESSION_THRESHOLD_RATIO,
      thresholdRatio: DEFAULT_INITIAL_THRESHOLD_RATIO,
    };
  }

  const routeKey = provider ? `${provider}/${model}` : model;
  const routeOverride = ROUTE_INPUT_LIMIT_OVERRIDES[routeKey] ?? ROUTE_INPUT_LIMIT_OVERRIDES[model];

  if (routeOverride) {
    return { ...routeOverride };
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

  const cardWindow =
    typeof matchedCard?.contextWindowTokens === 'number' && matchedCard.contextWindowTokens > 0
      ? matchedCard.contextWindowTokens
      : DEFAULT_AUTO_COMPRESS_WINDOW;

  return {
    maxWindowToken: Math.min(cardWindow, EFFECTIVE_AUTO_COMPRESS_WINDOW_CAP),
    recompressionThresholdRatio: DEFAULT_RECOMPRESSION_THRESHOLD_RATIO,
    thresholdRatio: DEFAULT_INITIAL_THRESHOLD_RATIO,
  };
};
