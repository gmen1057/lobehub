import { describe, expect, it } from 'vitest';

import {
  isReasoningLevel,
  reasoningCallParams,
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
