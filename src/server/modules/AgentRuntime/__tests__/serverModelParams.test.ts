import type * as ModelBankModule from 'model-bank';
import { describe, expect, it, vi } from 'vitest';

import {
  applyEffortToChatConfig,
  resolveExtendParams,
  resolveServerModelParams,
} from '../serverModelParams';

vi.mock('model-bank', async (importOriginal) => {
  const actual = await importOriginal<typeof ModelBankModule>();
  return {
    ...actual,
    LOBE_DEFAULT_MODEL_LIST: [
      {
        id: 'gemini-flash',
        providerId: 'google',
        settings: { extendParams: ['thinkingLevel3', 'urlContext'] },
      },
      {
        id: 'claude-sonnet',
        providerId: 'anthropic',
        settings: {
          extendParams: ['disableContextCaching', 'enableReasoning', 'reasoningBudgetToken'],
        },
      },
      { id: 'plain-model', providerId: 'openai' },
    ],
  };
});

describe('resolveExtendParams (arckep: порт клиентского резолвера)', () => {
  it('без extendParams — ничего', () => {
    expect(resolveExtendParams(undefined, { enableReasoning: true })).toEqual({});
    expect(resolveExtendParams([], { enableReasoning: true })).toEqual({});
  });

  it('Claude: рассуждения с бюджетом, выключенные — явный disabled', () => {
    const params = ['disableContextCaching', 'enableReasoning', 'reasoningBudgetToken'];
    expect(
      resolveExtendParams(params, { enableReasoning: true, reasoningBudgetToken: 4096 }),
    ).toEqual({ thinking: { budget_tokens: 4096, type: 'enabled' } });
    expect(resolveExtendParams(params, { enableReasoning: true })).toEqual({
      thinking: { budget_tokens: 1024, type: 'enabled' },
    });
    expect(resolveExtendParams(params, {})).toEqual({
      thinking: { budget_tokens: 0, type: 'disabled' },
    });
    expect(resolveExtendParams(params, { disableContextCaching: true })).toMatchObject({
      enabledContextCaching: false,
    });
  });

  it('Claude 4.6: адаптивное мышление перекрывает бюджет', () => {
    const params = ['enableAdaptiveThinking', 'enableReasoning', 'effort'];
    expect(resolveExtendParams(params, { effort: 'max', enableAdaptiveThinking: true })).toEqual({
      effort: 'max',
      thinking: { type: 'adaptive' },
    });
  });

  it('Gemini: уровень мышления по полю своего поколения', () => {
    expect(
      resolveExtendParams(['thinkingLevel3', 'urlContext'], { thinkingLevel3: 'high' }),
    ).toEqual({ thinkingLevel: 'high' });
    expect(resolveExtendParams(['thinkingBudget'], { thinkingBudget: 0 })).toEqual({
      thinkingBudget: 0,
    });
    expect(resolveExtendParams(['thinkingLevel2'], { thinkingLevel3: 'high' })).toEqual({});
  });

  it('OpenAI/xAI: reasoning_effort; у Grok 4.20 по умолчанию high', () => {
    expect(resolveExtendParams(['reasoningEffort'], { reasoningEffort: 'low' })).toEqual({
      reasoning_effort: 'low',
    });
    expect(
      resolveExtendParams(['gpt5ReasoningEffort'], { gpt5ReasoningEffort: 'minimal' }),
    ).toEqual({ reasoning_effort: 'minimal' });
    expect(resolveExtendParams(['grok4_20ReasoningEffort'], {})).toEqual({
      reasoning_effort: 'high',
    });
    expect(resolveExtendParams(['textVerbosity'], { textVerbosity: 'low' })).toEqual({
      verbosity: 'low',
    });
  });
});

describe('applyEffortToChatConfig (arckep: «думать дольше» одним словом)', () => {
  it('заполняет поля всех семейств, не теряя остальное', () => {
    const cfg = applyEffortToChatConfig({ historyCount: 8, searchMode: 'off' }, 'high');
    expect(cfg).toMatchObject({
      effort: 'high',
      enableReasoning: true,
      historyCount: 8,
      reasoningBudgetToken: 24_000,
      reasoningEffort: 'high',
      searchMode: 'off',
      thinkingLevel: 'high',
      thinkingLevel2: 'high',
      thinkingLevel4: 'high',
    });
    expect(applyEffortToChatConfig(undefined, 'low')).toMatchObject({
      reasoningBudgetToken: 1024,
      thinkingLevel2: 'low',
      thinkingLevel4: 'minimal',
    });
  });

  it('сходится с резолвером: Gemini получает thinkingLevel, Claude — бюджет', () => {
    const cfg = applyEffortToChatConfig({}, 'medium');
    expect(resolveExtendParams(['thinkingLevel3', 'urlContext'], cfg)).toEqual({
      thinkingLevel: 'medium',
    });
    expect(resolveExtendParams(['enableReasoning', 'reasoningBudgetToken'], cfg)).toEqual({
      thinking: { budget_tokens: 8000, type: 'enabled' },
    });
  });
});

describe('resolveServerModelParams (arckep: параметры серверного вызова)', () => {
  it('числовые параметры помощника; max_tokens и reasoning_effort из params — только по тумблерам', async () => {
    const params = {
      frequency_penalty: 0,
      max_tokens: 2048,
      reasoning_effort: 'low',
      temperature: 0.7,
      top_p: 1,
    };
    expect(
      await resolveServerModelParams({ chatConfig: {}, params }, 'plain-model', 'openai'),
    ).toEqual({
      frequency_penalty: 0,
      temperature: 0.7,
      top_p: 1,
    });
    expect(
      await resolveServerModelParams(
        { chatConfig: { enableMaxTokens: true, enableReasoningEffort: true }, params },
        'plain-model',
        'openai',
      ),
    ).toEqual({
      frequency_penalty: 0,
      max_tokens: 2048,
      reasoning_effort: 'low',
      temperature: 0.7,
      top_p: 1,
    });
  });

  it('extendParams модели берутся из model-bank', async () => {
    expect(
      await resolveServerModelParams(
        { chatConfig: applyEffortToChatConfig({}, 'high'), params: { temperature: 1 } },
        'gemini-flash',
        'google',
      ),
    ).toEqual({ temperature: 1, thinkingLevel: 'high' });
    expect(
      await resolveServerModelParams(
        { chatConfig: { enableReasoning: true, reasoningBudgetToken: 2000 }, params: {} },
        'claude-sonnet',
        'anthropic',
      ),
    ).toEqual({ thinking: { budget_tokens: 2000, type: 'enabled' } });
  });

  it('без модели/провайдера или помощника — только то, что есть', async () => {
    expect(await resolveServerModelParams(undefined, undefined, undefined)).toEqual({});
    expect(
      await resolveServerModelParams({ params: { temperature: 'hot' as any } }, 'x', 'y'),
    ).toEqual({});
  });
});
