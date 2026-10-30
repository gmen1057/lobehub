import { describe, expect, it } from 'vitest';

import {
  isReasoningLevel,
  levelFromCallParams,
  reasoningCallParams,
  resolveReasoningAuto,
  resolveReasoningProfile,
  snapReasoningLevel,
} from '../reasoningLevels';

describe('resolveReasoningProfile (arckep: ступени модели)', () => {
  it('по полю карточки: GPT-5.x, GPT-6, Grok, Gemini, o3', () => {
    expect(
      resolveReasoningProfile('gpt-5.5', 'openai', ['gpt5_2ReasoningEffort', 'textVerbosity']),
    ).toEqual({
      kind: 'reasoningEffort',
      levels: ['none', 'low', 'medium', 'high', 'xhigh'],
    });
    expect(
      resolveReasoningProfile('gpt-6-astra', 'openai', ['gpt6ReasoningEffort'])?.levels,
    ).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(resolveReasoningProfile('grok-4.7', 'xai', ['grok4_20ReasoningEffort'])?.levels).toEqual(
      ['low', 'medium', 'high', 'xhigh'],
    );
    expect(resolveReasoningProfile('gemini-x', 'google', ['thinkingLevel3', 'urlContext'])).toEqual(
      {
        kind: 'geminiLevel',
        levels: ['low', 'medium', 'high'],
      },
    );
    expect(resolveReasoningProfile('o3', 'openai', ['reasoningEffort'])?.levels).toEqual([
      'low',
      'medium',
      'high',
    ]);
  });

  it('Claude 4.6 — effort важнее бюджета; тумблер enableReasoning даёт «не думать»', () => {
    expect(
      resolveReasoningProfile('claude-sonnet-4-6', 'anthropic', [
        'disableContextCaching',
        'enableAdaptiveThinking',
        'enableReasoning',
        'reasoningBudgetToken',
        'effort',
      ]),
    ).toEqual({ kind: 'anthropicEffort', levels: ['none', 'low', 'medium', 'high', 'max'] });
    expect(
      resolveReasoningProfile('claude-haiku-4-5-20251001', 'anthropic', [
        'enableReasoning',
        'reasoningBudgetToken',
      ]),
    ).toEqual({ kind: 'budget', levels: ['none', 'low', 'medium', 'high'] });
    expect(
      resolveReasoningProfile('qwen3.8-max', 'qwen', ['enableReasoning', 'reasoningBudgetToken'])
        ?.kind,
    ).toBe('budget');
  });

  it('таблица студии раньше карточки и для моделей без карточки', () => {
    expect(resolveReasoningProfile('claude-fable-5', 'anthropic', undefined)).toEqual({
      kind: 'anthropicEffort',
      levels: ['low', 'medium', 'high', 'xhigh', 'max'],
    });
    expect(resolveReasoningProfile('claude-opus-5-5', 'anthropic', undefined)?.kind).toBe(
      'anthropicEffort',
    );
    expect(resolveReasoningProfile('gpt-5.6-sol', 'openai', undefined)?.levels).toEqual([
      'none',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    for (const id of ['gpt-6-sol', 'gpt-6-luna', 'gpt-6.1-terra']) {
      expect(resolveReasoningProfile(id, 'openai', undefined)?.levels).toEqual([
        'none',
        'low',
        'medium',
        'high',
        'xhigh',
        'max',
      ]);
    }
    expect(resolveReasoningProfile('gpt-6.1-sol', 'openai', undefined)?.levels).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    expect(
      resolveReasoningProfile('mistralai/mistral-large-4-0', 'openrouter', [])?.levels,
    ).toEqual(['none', 'high']);
    // У карточки Gemini 3.7 Flash бюджет токенов, студия проверила уровни.
    expect(
      resolveReasoningProfile('gemini-3.7-flash', 'google', ['thinkingBudget', 'urlContext']),
    ).toEqual({
      kind: 'geminiLevel',
      levels: ['low', 'medium', 'high'],
    });
    expect(
      resolveReasoningProfile('gemini-3.6-flash', 'google', ['thinkingBudget'])?.levels[0],
    ).toBe('minimal');
    expect(resolveReasoningProfile('grok-4.6', 'xai', [])?.kind).toBe('reasoningEffort');
    expect(resolveReasoningProfile('meta/muse-wonder', 'openrouter', [])?.levels).toHaveLength(6);
    for (const id of [
      'deepseek-v4-pro',
      'deepseek-v4-flash',
      'deepseek-v4-flash-vision-exp',
      'deepseek-flash',
    ]) {
      expect(resolveReasoningProfile(id, 'deepseek', undefined)).toEqual({
        kind: 'deepseek',
        levels: ['none', 'low', 'high', 'max'],
      });
    }
  });

  it('OpenRouter — три ступени для любой модели; без модели и неизвестное — нет ступеней', () => {
    expect(resolveReasoningProfile('moonshotai/kimi-k3', 'openrouter', [])).toEqual({
      kind: 'reasoningEffort',
      levels: ['low', 'medium', 'high'],
    });
    expect(resolveReasoningProfile('qwen-unknown', 'qwen', undefined)).toBeUndefined();
    expect(resolveReasoningProfile('claude-opus-5', 'openrouter', [])?.levels).toHaveLength(3);
    expect(resolveReasoningProfile(undefined, 'openai', ['reasoningEffort'])).toBeUndefined();
  });
});

describe('snapReasoningLevel', () => {
  it('своя ступень — как есть, чужая — ближайшая, при равенстве меньшая', () => {
    expect(snapReasoningLevel('medium', ['low', 'medium', 'high'])).toBe('medium');
    expect(snapReasoningLevel('max', ['low', 'medium', 'high'])).toBe('high');
    expect(snapReasoningLevel('none', ['low', 'medium', 'high'])).toBe('low');
    expect(snapReasoningLevel('medium', ['low', 'high'])).toBe('low');
    expect(snapReasoningLevel('xhigh', ['minimal', 'high'])).toBe('high');
    expect(snapReasoningLevel('high', [])).toBeUndefined();
  });
});

describe('reasoningCallParams', () => {
  it('поле вызова по семейству', () => {
    expect(reasoningCallParams({ kind: 'reasoningEffort', levels: [] }, 'xhigh')).toEqual({
      reasoning_effort: 'xhigh',
    });
    expect(reasoningCallParams({ kind: 'anthropicEffort', levels: [] }, 'high')).toEqual({
      effort: 'high',
      thinking: { type: 'adaptive' },
    });
    expect(reasoningCallParams({ kind: 'budget', levels: [] }, 'medium')).toEqual({
      thinking: { budget_tokens: 8000, type: 'enabled' },
    });
    expect(reasoningCallParams({ kind: 'budget', levels: [] }, 'none')).toEqual({
      thinking: { budget_tokens: 0, type: 'disabled' },
    });
    expect(reasoningCallParams({ kind: 'geminiLevel', levels: [] }, 'minimal')).toEqual({
      thinkingLevel: 'minimal',
    });
    expect(reasoningCallParams({ kind: 'geminiBudget', levels: [] }, 'high')).toEqual({
      thinkingBudget: 24_000,
    });
    expect(reasoningCallParams({ kind: 'deepseek', levels: [] }, 'max')).toEqual({
      reasoning_effort: 'max',
      thinking: { type: 'enabled' },
    });
    expect(reasoningCallParams({ kind: 'deepseek', levels: [] }, 'none')).toEqual({
      thinking: { type: 'disabled' },
    });
  });

  it('isReasoningLevel — только известные ступени', () => {
    expect(isReasoningLevel('xhigh')).toBe(true);
    expect(isReasoningLevel('ultra')).toBe(false);
    expect(isReasoningLevel(3)).toBe(false);
  });
});

describe('resolveReasoningAuto (что значит «Авто», 19.10)', () => {
  it('то, что шлёт сам движок, важнее умолчания провайдера', () => {
    expect(levelFromCallParams({ thinking: { budget_tokens: 0, type: 'disabled' } })).toBe('none');
    expect(levelFromCallParams({ reasoning_effort: 'high' })).toBe('high');
    expect(levelFromCallParams({ effort: 'max', thinking: { type: 'adaptive' } })).toBe('max');
    expect(levelFromCallParams({ thinkingLevel: 'low' })).toBe('low');
    expect(
      levelFromCallParams({ thinking: { budget_tokens: 2000, type: 'enabled' } }),
    ).toBeUndefined();
    // Claude 4.6 и Qwen: движок по умолчанию выключает рассуждения; Grok 4.7 — всегда high
    expect(
      resolveReasoningAuto('claude-sonnet-4-6', 'anthropic', {
        thinking: { budget_tokens: 0, type: 'disabled' },
      }),
    ).toBe('none');
    expect(resolveReasoningAuto('grok-4.7', 'xai', { reasoning_effort: 'high' })).toBe('high');
  });

  it('умолчания провайдеров по пробам и документации', () => {
    const auto = (model: string, provider: string) => resolveReasoningAuto(model, provider, {});
    expect(auto('gpt-5.4', 'openai')).toBe('none');
    expect(auto('gpt-5.4-nano', 'openai')).toBe('none');
    expect(auto('gpt-5.5', 'openai')).toBe('medium');
    expect(auto('gpt-6-astra', 'openai')).toBe('medium');
    expect(auto('gpt-6-sol', 'openai')).toBe('medium');
    expect(auto('gpt-6.1-sol', 'openai')).toBe('medium');
    expect(auto('gpt-6.1-terra', 'openai')).toBe('medium');
    expect(auto('gpt-5.6-luna', 'openai')).toBe('medium');
    expect(auto('o3', 'openai')).toBe('medium');
    expect(auto('claude-fable-5', 'anthropic')).toBe('high');
    expect(auto('claude-fable-5-1', 'anthropic')).toBe('high');
    expect(auto('claude-sonnet-5-5', 'anthropic')).toBe('high');
    expect(auto('claude-opus-5', 'anthropic')).toBe('high');
    expect(auto('claude-opus-5-5', 'anthropic')).toBe('medium');
    expect(auto('deepseek-v4-pro', 'deepseek')).toBe('high');
    expect(auto('gemini-4-argon', 'google')).toBe('medium');
    expect(auto('gemini-3.8-flash', 'google')).toBe('medium');
    expect(auto('gemini-3.6-flash', 'google')).toBe('auto');
    expect(auto('grok-4.6', 'xai')).toBe('auto');
    expect(auto('moonshotai/kimi-k3', 'openrouter')).toBe('auto');
    expect(auto('gpt-7', 'openai')).toBeUndefined();
    expect(auto('mystery', 'qwen')).toBeUndefined();
  });
});
