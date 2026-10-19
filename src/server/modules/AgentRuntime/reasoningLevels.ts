/**
 * arckep (19.10.2026): ступени рассуждений модели для поля ввода студии — «Авто / Немного / Средне /
 * Больше / …» вместо одной кнопки «Думать дольше».
 *
 * Экран показывает только ступени, которые модель принимает (`GET /models/runtime` → `reasoningLevels`),
 * а серверный вызов переводит выбранную ступень в параметр своего семейства (`reasoningCallParams`).
 * Источник ступеней — `settings.extendParams` карточки model-bank: те же списки, что у ползунков
 * браузерного чата (`src/features/ModelSwitchPanel/components/ControlsForm/*Slider.tsx`). Для моделей без
 * карточки (подключены строкой `*_MODEL_LIST`) и там, где карточка расходится с проверенным в студии, —
 * таблица `ARCKEP_PROFILES` (сверено с `backend/app/services/direct_llm_service.py` студии и справкой
 * Anthropic по thinking/effort).
 */

/** Ступени по возрастанию: по этому порядку ищется ближайшая, если модель не знает выбранную. */
export const REASONING_LEVELS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

/** Ключ `chatConfig`, в котором `/responses` передаёт ступень одного запроса до серверного вызова. */
export const ARCKEP_REASONING_LEVEL_KEY = 'arckepReasoningLevel';

/** Через какое поле вызова ступень доходит до модели. */
export type ReasoningKind =
  /** OpenAI, xAI, OpenRouter: `reasoning_effort`. */
  | 'reasoningEffort'
  /** Claude 4.6 и новее: адаптивное мышление и `output_config.effort`; `none` — мышление выключено. */
  | 'anthropicEffort'
  /** Claude 4.5 и раньше, Qwen: мышление с бюджетом токенов; `none` — выключено. */
  | 'budget'
  /** Gemini 3 и новее: `thinkingLevel`. */
  | 'geminiLevel'
  /** Gemini 2.5: `thinkingBudget`. */
  | 'geminiBudget'
  /** DeepSeek: `thinking.type` включает и выключает, глубина — `reasoning_effort`. */
  | 'deepseek';

export interface ReasoningProfile {
  kind: ReasoningKind;
  levels: readonly ReasoningLevel[];
}

export interface ReasoningCallParams {
  effort?: string;
  reasoning_effort?: string;
  thinking?: { budget_tokens?: number; type?: string };
  thinkingBudget?: number;
  thinkingLevel?: string;
}

/** Поле `extendParams` карточки → ступени. Порядок — приоритет: у Claude 4.6 есть и `effort`, и бюджет. */
const KEY_PROFILES: ReadonlyArray<{ key: string } & ReasoningProfile> = [
  {
    key: 'gpt6ReasoningEffort',
    kind: 'reasoningEffort',
    levels: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  { key: 'gpt5_2ProReasoningEffort', kind: 'reasoningEffort', levels: ['medium', 'high', 'xhigh'] },
  {
    key: 'gpt5_2ReasoningEffort',
    kind: 'reasoningEffort',
    levels: ['none', 'low', 'medium', 'high', 'xhigh'],
  },
  {
    key: 'gpt5_1ReasoningEffort',
    kind: 'reasoningEffort',
    levels: ['none', 'low', 'medium', 'high'],
  },
  {
    key: 'gpt5ReasoningEffort',
    kind: 'reasoningEffort',
    levels: ['minimal', 'low', 'medium', 'high'],
  },
  {
    key: 'codexMaxReasoningEffort',
    kind: 'reasoningEffort',
    levels: ['low', 'medium', 'high', 'xhigh'],
  },
  {
    key: 'grok4_20ReasoningEffort',
    kind: 'reasoningEffort',
    levels: ['low', 'medium', 'high', 'xhigh'],
  },
  { key: 'reasoningEffort', kind: 'reasoningEffort', levels: ['low', 'medium', 'high'] },
  { key: 'effort', kind: 'anthropicEffort', levels: ['low', 'medium', 'high', 'max'] },
  { key: 'thinkingLevel', kind: 'geminiLevel', levels: ['minimal', 'low', 'medium', 'high'] },
  { key: 'thinkingLevel2', kind: 'geminiLevel', levels: ['low', 'high'] },
  { key: 'thinkingLevel3', kind: 'geminiLevel', levels: ['low', 'medium', 'high'] },
  { key: 'thinkingLevel4', kind: 'geminiLevel', levels: ['minimal', 'high'] },
  { key: 'thinkingLevel5', kind: 'geminiLevel', levels: ['minimal', 'low', 'medium', 'high'] },
  { key: 'reasoningBudgetToken', kind: 'budget', levels: ['low', 'medium', 'high'] },
  { key: 'reasoningBudgetToken32k', kind: 'budget', levels: ['low', 'medium', 'high'] },
  { key: 'reasoningBudgetToken80k', kind: 'budget', levels: ['low', 'medium', 'high'] },
  { key: 'thinkingBudget', kind: 'geminiBudget', levels: ['low', 'medium', 'high'] },
];

/** Модели без карточки или с проверенными студией ступенями — раньше карточки. */
const ARCKEP_PROFILES: ReadonlyArray<{
  match: RegExp;
  profile: ReasoningProfile;
  provider: string;
}> = [
  // Claude 5-го поколения: мышление адаптивное всегда (Fable, Opus 5.5) или выключается только до high
  // (Opus 5) — выключение не предлагаем, глубина задаётся effort.
  {
    match: /^claude-(?:fable|mythos|opus|sonnet|haiku)-5(?:-|$)/,
    profile: { kind: 'anthropicEffort', levels: ['low', 'medium', 'high', 'xhigh', 'max'] },
    provider: 'anthropic',
  },
  // GPT-5.6 Sol / Terra / Luna: none…max (студия, пакет мониторинга 22.09.2026).
  {
    match: /^gpt-5\.6-/,
    profile: { kind: 'reasoningEffort', levels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] },
    provider: 'openai',
  },
  // Gemini: уровни мышления проверены студией вживую (GEMINI_THINKING_LEVELS); выключить нельзя.
  {
    match: /^gemini-(?:4-argon|3\.8-flash|3\.7-flash|3\.1-pro-preview)$/,
    profile: { kind: 'geminiLevel', levels: ['low', 'medium', 'high'] },
    provider: 'google',
  },
  {
    match: /^gemini-(?:3\.6-flash|3\.5-flash|3\.1-flash-lite)$/,
    profile: { kind: 'geminiLevel', levels: ['minimal', 'low', 'medium', 'high'] },
    provider: 'google',
  },
  {
    match: /^grok-4\.(?:5|6|20-0309-reasoning)$/,
    profile: { kind: 'reasoningEffort', levels: ['low', 'medium', 'high', 'xhigh'] },
    provider: 'xai',
  },
  // DeepSeek V4 (api-docs.deepseek.com/guides/thinking_mode, 19.10.2026): `thinking: {type: disabled}`
  // выключает, `reasoning_effort` low|high|max (medium и xhigh DeepSeek сводит к high); по умолчанию
  // рассуждения включены на high.
  {
    match: /^deepseek-(?:flash|v4)/,
    profile: { kind: 'deepseek', levels: ['none', 'low', 'high', 'max'] },
    provider: 'deepseek',
  },
  // Muse Wonder: рассуждения не выключаются, ступени minimal…max.
  {
    match: /^meta\/muse-wonder/,
    profile: {
      kind: 'reasoningEffort',
      levels: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    },
    provider: 'openrouter',
  },
];

/** OpenRouter сам сводит `reasoning.effort` к параметру каждой модели: три ступени — для любой рассуждающей. */
const OPENROUTER_PROFILE: ReasoningProfile = {
  kind: 'reasoningEffort',
  levels: ['low', 'medium', 'high'],
};

/** Бюджет токенов на ступень — прежние значения «думать дольше» (low/medium/high). */
const BUDGET_TOKENS: Record<ReasoningLevel, number> = {
  high: 24_000,
  low: 1024,
  max: 24_000,
  medium: 8000,
  minimal: 1024,
  none: 0,
  xhigh: 24_000,
};

export const isReasoningLevel = (value: unknown): value is ReasoningLevel =>
  typeof value === 'string' && (REASONING_LEVELS as readonly string[]).includes(value);

/** Ступени модели или `undefined`, если ступенями её не настроить. */
export const resolveReasoningProfile = (
  model: string | undefined,
  provider: string | undefined,
  extendParams: readonly string[] | undefined,
): ReasoningProfile | undefined => {
  if (!model || !provider) return undefined;
  const override = ARCKEP_PROFILES.find(
    (item) => item.provider === provider && item.match.test(model),
  );
  if (override) return override.profile;

  const keys = extendParams ?? [];
  const found = KEY_PROFILES.find((item) => keys.includes(item.key));
  if (found) {
    // Тумблер `enableReasoning` у карточки — мышление можно выключить совсем.
    const canDisable =
      (found.kind === 'anthropicEffort' || found.kind === 'budget') &&
      keys.includes('enableReasoning');
    return { kind: found.kind, levels: canDisable ? ['none', ...found.levels] : found.levels };
  }
  if (provider === 'openrouter') return OPENROUTER_PROFILE;
  return undefined;
};

/** Ступень, которую модель примет: сама выбранная или ближайшая к ней (при равенстве — меньшая). */
export const snapReasoningLevel = (
  level: ReasoningLevel,
  levels: readonly ReasoningLevel[],
): ReasoningLevel | undefined => {
  if (levels.length === 0) return undefined;
  if (levels.includes(level)) return level;
  const target = REASONING_LEVELS.indexOf(level);
  let best = levels[0];
  for (const candidate of levels) {
    const distance = Math.abs(REASONING_LEVELS.indexOf(candidate) - target);
    if (distance < Math.abs(REASONING_LEVELS.indexOf(best) - target)) best = candidate;
  }
  return best;
};

/** Поля вызова для ступени, которую модель принимает (после `snapReasoningLevel`). */
export const reasoningCallParams = (
  profile: ReasoningProfile,
  level: ReasoningLevel,
): ReasoningCallParams => {
  switch (profile.kind) {
    case 'reasoningEffort': {
      return { reasoning_effort: level };
    }
    case 'anthropicEffort': {
      return level === 'none'
        ? { thinking: { budget_tokens: 0, type: 'disabled' } }
        : { effort: level, thinking: { type: 'adaptive' } };
    }
    case 'budget': {
      return level === 'none'
        ? { thinking: { budget_tokens: 0, type: 'disabled' } }
        : { thinking: { budget_tokens: BUDGET_TOKENS[level], type: 'enabled' } };
    }
    case 'geminiLevel': {
      return { thinkingLevel: level };
    }
    case 'geminiBudget': {
      return { thinkingBudget: BUDGET_TOKENS[level] };
    }
    case 'deepseek': {
      return level === 'none'
        ? { thinking: { type: 'disabled' } }
        : { reasoning_effort: level, thinking: { type: 'enabled' } };
    }
  }
};
