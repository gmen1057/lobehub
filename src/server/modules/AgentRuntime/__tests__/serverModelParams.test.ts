import type * as ModelBankModule from 'model-bank';
import { describe, expect, it, vi } from 'vitest';

import { ARCKEP_REASONING_LEVEL_KEY } from '../reasoningLevels';
import {
  findModelExtendParams,
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
      {
        id: 'claude-legacy',
        providerId: 'anthropic',
        settings: {
          extendParams: [
            'enableAdaptiveThinking',
            'enableReasoning',
            'reasoningBudgetToken',
            'effort',
          ],
        },
      },
      {
        id: 'gpt-card',
        providerId: 'openai',
        settings: { extendParams: ['gpt5_2ReasoningEffort'] },
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
        { chatConfig: { thinkingLevel3: 'high' }, params: { temperature: 1 } },
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

describe('ступень рассуждений одного запроса (arckep, 19.10)', () => {
  const withLevel = (level: string, chatConfig: Record<string, unknown> = {}) => ({
    chatConfig: { ...chatConfig, [ARCKEP_REASONING_LEVEL_KEY]: level } as any,
    params: { temperature: 1 },
  });

  it('заменяет рассуждения помощника и сохраняет остальные параметры', async () => {
    expect(
      await resolveServerModelParams(
        withLevel('low', { enableReasoning: true, reasoningBudgetToken: 2000 }),
        'claude-sonnet',
        'anthropic',
      ),
    ).toEqual({ temperature: 1, thinking: { budget_tokens: 1024, type: 'enabled' } });
  });

  it('Claude 4.6: адаптивное мышление и effort; «не думать» выключает мышление', async () => {
    expect(await resolveServerModelParams(withLevel('max'), 'claude-legacy', 'anthropic')).toEqual({
      effort: 'max',
      temperature: 1,
      thinking: { type: 'adaptive' },
    });
    expect(await resolveServerModelParams(withLevel('none'), 'claude-legacy', 'anthropic')).toEqual(
      {
        temperature: 1,
        thinking: { budget_tokens: 0, type: 'disabled' },
      },
    );
  });

  it('ступени, которой нет у модели, — ближайшая', async () => {
    expect(await resolveServerModelParams(withLevel('max'), 'gpt-card', 'openai')).toEqual({
      reasoning_effort: 'xhigh',
      temperature: 1,
    });
    expect(await resolveServerModelParams(withLevel('none'), 'gemini-flash', 'google')).toEqual({
      temperature: 1,
      thinkingLevel: 'low',
    });
  });

  it('модели без карточки — по таблице студии; без ступеней — как было', async () => {
    expect(
      await resolveServerModelParams(withLevel('xhigh'), 'claude-opus-5', 'anthropic'),
    ).toEqual({
      effort: 'xhigh',
      temperature: 1,
      thinking: { type: 'adaptive' },
    });
    expect(await resolveServerModelParams(withLevel('high'), 'plain-model', 'openai')).toEqual({
      temperature: 1,
    });
    expect(await resolveServerModelParams(withLevel('loud'), 'gpt-card', 'openai')).toEqual({
      temperature: 1,
    });
  });

  it('findModelExtendParams — поля карточки или undefined', async () => {
    expect(await findModelExtendParams('gpt-card', 'openai')).toEqual(['gpt5_2ReasoningEffort']);
    expect(await findModelExtendParams('nope', 'openai')).toBeUndefined();
  });
});
