import type { LobeAgentChatConfig } from '@lobechat/types';
import debug from 'debug';

const log = debug('lobe-server:agent-runtime:model-params');

/**
 * arckep (план chat-next-redesign, E1): параметры вызова модели для серверного контура
 * (REST-движок студии, боты, cron).
 *
 * Браузерный чат собирает температуру из `params` помощника и параметры рассуждений из `chatConfig`
 * по списку `settings.extendParams` модели (`src/services/chat/mecha/modelParamsResolver.ts`).
 * Серверный `call_llm` раньше не передавал ни того, ни другого: «думать дольше» и температура
 * помощника на REST не действовали. Здесь — порт того же алгоритма без картиночных параметров;
 * клиентский файл не трогаем (интерфейс в ветке движка не собирается).
 */

export type ReasoningEffort = 'low' | 'medium' | 'high';

type ChatConfig = Partial<LobeAgentChatConfig>;

export interface ServerModelParams {
  effort?: string;
  enabledContextCaching?: boolean;
  frequency_penalty?: number;
  max_tokens?: number;
  presence_penalty?: number;
  reasoning_effort?: string;
  temperature?: number;
  thinking?: { budget_tokens?: number; type?: string };
  thinkingBudget?: number;
  thinkingLevel?: string;
  top_p?: number;
  urlContext?: boolean;
  verbosity?: string;
}

/**
 * Параметры рассуждений/мышления по возможностям модели (`extendParams`) и настройкам помощника.
 * Чистая функция, порт `resolveModelExtendParams` браузерного чата.
 */
export const resolveExtendParams = (
  modelExtendParams: readonly string[] | undefined,
  chatConfig: ChatConfig | null | undefined,
): ServerModelParams => {
  const out: ServerModelParams = {};
  if (!modelExtendParams || modelExtendParams.length === 0) return out;
  const cfg = chatConfig ?? {};
  const has = (key: string) => modelExtendParams.includes(key);

  // Рассуждения с бюджетом токенов (Claude и совместимые)
  if (has('enableReasoning')) {
    if (cfg.enableReasoning) {
      let budget: number;
      if (has('reasoningBudgetToken32k')) budget = cfg.reasoningBudgetToken32k || 1024;
      else if (has('reasoningBudgetToken80k')) budget = cfg.reasoningBudgetToken80k || 1024;
      else budget = cfg.reasoningBudgetToken || 1024;
      out.thinking = { budget_tokens: budget, type: 'enabled' };
    } else {
      out.thinking = { budget_tokens: 0, type: 'disabled' };
    }
  } else if (has('reasoningBudgetToken32k')) {
    out.thinking = { budget_tokens: cfg.reasoningBudgetToken32k || 1024, type: 'enabled' };
  } else if (has('reasoningBudgetToken80k')) {
    out.thinking = { budget_tokens: cfg.reasoningBudgetToken80k || 1024, type: 'enabled' };
  } else if (has('reasoningBudgetToken')) {
    out.thinking = { budget_tokens: cfg.reasoningBudgetToken || 1024 };
  }

  // Адаптивное мышление (Claude 4.6+)
  if (has('enableAdaptiveThinking')) {
    if (cfg.enableAdaptiveThinking) out.thinking = { type: 'adaptive' };
    else if (!has('enableReasoning')) out.thinking = { type: 'disabled' };
  }

  if (has('disableContextCaching') && cfg.disableContextCaching) out.enabledContextCaching = false;

  // Усилие рассуждений — у каждого семейства своё поле настройки
  if (has('reasoningEffort') && cfg.reasoningEffort) out.reasoning_effort = cfg.reasoningEffort;
  if (has('gpt5ReasoningEffort') && cfg.gpt5ReasoningEffort)
    out.reasoning_effort = cfg.gpt5ReasoningEffort;
  if (has('gpt5_1ReasoningEffort') && cfg.gpt5_1ReasoningEffort)
    out.reasoning_effort = cfg.gpt5_1ReasoningEffort;
  if (has('gpt5_2ReasoningEffort') && cfg.gpt5_2ReasoningEffort)
    out.reasoning_effort = cfg.gpt5_2ReasoningEffort;
  if (has('gpt6ReasoningEffort') && cfg.gpt6ReasoningEffort)
    out.reasoning_effort = cfg.gpt6ReasoningEffort;
  if (has('gpt5_2ProReasoningEffort') && cfg.gpt5_2ProReasoningEffort)
    out.reasoning_effort = cfg.gpt5_2ProReasoningEffort;
  if (has('grok4_20ReasoningEffort')) out.reasoning_effort = cfg.grok4_20ReasoningEffort || 'high';
  if (has('codexMaxReasoningEffort') && cfg.codexMaxReasoningEffort)
    out.reasoning_effort = cfg.codexMaxReasoningEffort;
  if (has('effort') && cfg.effort) out.effort = cfg.effort;

  if (has('textVerbosity') && cfg.textVerbosity) out.verbosity = cfg.textVerbosity;

  // Мышление Gemini и совместимых
  if (has('thinking') && cfg.thinking) out.thinking = { type: cfg.thinking };
  if (has('thinkingBudget') && cfg.thinkingBudget !== undefined)
    out.thinkingBudget = cfg.thinkingBudget;
  if (has('thinkingLevel') && cfg.thinkingLevel) out.thinkingLevel = cfg.thinkingLevel;
  if (has('thinkingLevel2') && cfg.thinkingLevel2) out.thinkingLevel = cfg.thinkingLevel2;
  if (has('thinkingLevel3') && cfg.thinkingLevel3) out.thinkingLevel = cfg.thinkingLevel3;
  if (has('thinkingLevel4') && cfg.thinkingLevel4) out.thinkingLevel = cfg.thinkingLevel4;
  if (has('thinkingLevel5') && cfg.thinkingLevel5) out.thinkingLevel = cfg.thinkingLevel5;

  if (has('urlContext') && cfg.urlContext) out.urlContext = cfg.urlContext;

  return out;
};

/**
 * «Думать дольше» одним словом: раскладывает усилие по всем полям `chatConfig`, из которых
 * `resolveExtendParams` потом выберет нужное для конкретной модели.
 */
export const applyEffortToChatConfig = (
  chatConfig: ChatConfig | null | undefined,
  effort: ReasoningEffort,
): ChatConfig => {
  const budget = effort === 'high' ? 24_000 : effort === 'medium' ? 8000 : 1024;
  return {
    ...chatConfig,
    codexMaxReasoningEffort: effort,
    effort,
    enableAdaptiveThinking: true,
    enableReasoning: true,
    enableReasoningEffort: true,
    gpt5_1ReasoningEffort: effort,
    gpt5_2ProReasoningEffort: effort === 'low' ? 'medium' : effort,
    gpt5_2ReasoningEffort: effort,
    gpt5ReasoningEffort: effort,
    gpt6ReasoningEffort: effort,
    grok4_20ReasoningEffort: effort,
    reasoningBudgetToken: budget,
    reasoningBudgetToken32k: budget,
    reasoningBudgetToken80k: budget,
    reasoningEffort: effort,
    thinking: 'enabled',
    thinkingBudget: budget,
    thinkingLevel: effort,
    thinkingLevel2: effort === 'high' ? 'high' : 'low',
    thinkingLevel3: effort,
    thinkingLevel4: effort === 'high' ? 'high' : 'minimal',
    thinkingLevel5: effort,
  };
};

const NUMBER_PARAMS = ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty'] as const;

/**
 * Полный набор параметров вызова для `call_llm`: числовые параметры помощника (как в браузере —
 * `max_tokens` только при `enableMaxTokens`, `reasoning_effort` из params только при
 * `enableReasoningEffort`) плюс параметры рассуждений по `extendParams` модели из model-bank.
 */
export const resolveServerModelParams = async (
  agentConfig:
    { chatConfig?: ChatConfig | null; params?: Record<string, unknown> | null } | undefined,
  model: string | undefined,
  provider: string | undefined,
): Promise<ServerModelParams> => {
  const out: ServerModelParams = {};
  const params = agentConfig?.params ?? {};
  const chatConfig = agentConfig?.chatConfig ?? {};

  for (const key of NUMBER_PARAMS) {
    const value = params[key];
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
  }
  if (chatConfig.enableMaxTokens && typeof params.max_tokens === 'number') {
    out.max_tokens = params.max_tokens;
  }
  if (chatConfig.enableReasoningEffort && typeof params.reasoning_effort === 'string') {
    out.reasoning_effort = params.reasoning_effort;
  }

  if (!model || !provider) return out;

  let extendParams: readonly string[] | undefined;
  try {
    const bank: any = await import('model-bank');
    const card = (bank.LOBE_DEFAULT_MODEL_LIST ?? []).find(
      (item: any) => item.id === model && item.providerId === provider,
    );
    extendParams = card?.settings?.extendParams;
  } catch (error) {
    // Нет справочника моделей (например, подменён в тестах) — только числовые параметры.
    log('model-bank unavailable, extend params skipped: %O', error);
  }

  return { ...out, ...resolveExtendParams(extendParams, chatConfig) };
};
