import { describe, expect, it, vi } from 'vitest';

import {
  ARCKEP_WEB_SEARCH_CONNECTOR,
  modelHasBuiltinSearch,
  offersArckepSearchChoice,
  prefersArckepSearchOnSchedule,
  resolveArckepSearchPluginIds,
  resolveServerEnabledSearch,
} from '../arckepSearch';

// The real model-bank index does NOT export DEFAULT_MODEL_PROVIDER_LIST, so the mock must not either.
vi.mock('model-bank', () => ({
  LOBE_DEFAULT_MODEL_LIST: [
    { abilities: { search: true }, id: 'searchy-model', providerId: 'test-provider' },
    { abilities: {}, id: 'plain-model', providerId: 'test-provider' },
  ],
}));

describe('modelHasBuiltinSearch', () => {
  it('is true for every model of the five providers with native search', async () => {
    for (const [provider, model] of [
      ['anthropic', 'claude-opus-5'],
      ['google', 'gemini-3.1-flash-lite'],
      ['openai', 'gpt-5.6-luna'],
      ['qwen', 'qwen3.7-flash'],
      ['xai', 'grok-4.3'],
    ]) {
      expect(await modelHasBuiltinSearch(model, provider), `${provider}/${model}`).toBe(true);
    }
  });

  it('is false for OpenRouter and DeepSeek, true for other providers only by model card', async () => {
    expect(await modelHasBuiltinSearch('z-ai/glm-5.3-flash', 'openrouter')).toBe(false);
    expect(await modelHasBuiltinSearch('deepseek-v4-flash', 'deepseek')).toBe(false);
    expect(await modelHasBuiltinSearch('searchy-model', 'test-provider')).toBe(true);
    expect(await modelHasBuiltinSearch('plain-model', 'test-provider')).toBe(false);
    expect(await modelHasBuiltinSearch(undefined, 'openai')).toBe(false);
  });
});

describe('resolveArckepSearchPluginIds', () => {
  it('gives the paid Arckep search to models without built-in search', async () => {
    expect(
      await resolveArckepSearchPluginIds({ chatConfig: {} }, 'z-ai/glm-5.3-flash', 'openrouter'),
    ).toEqual([ARCKEP_WEB_SEARCH_CONNECTOR]);
    expect(await resolveArckepSearchPluginIds(undefined, 'deepseek-v4-flash', 'deepseek')).toEqual([
      ARCKEP_WEB_SEARCH_CONNECTOR,
    ]);
    expect(
      await resolveArckepSearchPluginIds(
        { chatConfig: { searchMode: 'on' } },
        'openrouter/auto',
        'openrouter',
      ),
    ).toEqual([ARCKEP_WEB_SEARCH_CONNECTOR]);
  });

  it('adds nothing to models that search natively', async () => {
    expect(
      await resolveArckepSearchPluginIds({ chatConfig: {} }, 'claude-opus-5', 'anthropic'),
    ).toEqual([]);
    expect(await resolveArckepSearchPluginIds(undefined, 'gpt-5.6-luna', 'openai')).toEqual([]);
  });

  it('adds nothing when search is switched off, whatever the model', async () => {
    expect(
      await resolveArckepSearchPluginIds(
        { chatConfig: { searchMode: 'off' } },
        'deepseek-v4-flash',
        'deepseek',
      ),
    ).toEqual([]);
    expect(
      await resolveArckepSearchPluginIds(
        { chatConfig: { searchMode: 'off' } },
        'z-ai/glm-5.3-flash',
        'openrouter',
      ),
    ).toEqual([]);
  });

  it('falls back to Arckep search when the person declined the built-in one', async () => {
    expect(
      await resolveArckepSearchPluginIds(
        { chatConfig: { useModelBuiltinSearch: false } },
        'grok-4.3',
        'xai',
      ),
    ).toEqual([ARCKEP_WEB_SEARCH_CONNECTOR]);
  });

  it('adds nothing without a model or provider', async () => {
    expect(await resolveArckepSearchPluginIds({ chatConfig: {} }, undefined, 'openrouter')).toEqual(
      [],
    );
    expect(await resolveArckepSearchPluginIds({ chatConfig: {} }, 'x', undefined)).toEqual([]);
  });
});

describe('prefersArckepSearchOnSchedule', () => {
  it('is true for the four providers whose built-in search is paid per call', () => {
    for (const provider of ['anthropic', 'google', 'openai', 'xai']) {
      expect(prefersArckepSearchOnSchedule({ chatConfig: {} }, provider), provider).toBe(true);
    }
    expect(prefersArckepSearchOnSchedule(undefined, 'openai')).toBe(true);
  });

  it('is false for Qwen (search not billed), models without built-in search and missing provider', () => {
    expect(prefersArckepSearchOnSchedule({ chatConfig: {} }, 'qwen')).toBe(false);
    expect(prefersArckepSearchOnSchedule({ chatConfig: {} }, 'deepseek')).toBe(false);
    expect(prefersArckepSearchOnSchedule({ chatConfig: {} }, 'openrouter')).toBe(false);
    expect(prefersArckepSearchOnSchedule({ chatConfig: {} }, undefined)).toBe(false);
  });

  it('is false when search is off or the built-in one is already declined', () => {
    expect(prefersArckepSearchOnSchedule({ chatConfig: { searchMode: 'off' } }, 'openai')).toBe(
      false,
    );
    expect(
      prefersArckepSearchOnSchedule({ chatConfig: { useModelBuiltinSearch: false } }, 'openai'),
    ).toBe(false);
  });
});

describe('offersArckepSearchChoice', () => {
  it('offers the cheap search as a second one to models with paid built-in search', async () => {
    expect(await offersArckepSearchChoice({ chatConfig: {} }, 'claude-opus-5', 'anthropic')).toBe(
      true,
    );
    expect(await offersArckepSearchChoice(undefined, 'gemini-3.7-flash', 'google')).toBe(true);
  });

  it('does not offer it to Qwen, to models without built-in search or when search is off', async () => {
    expect(await offersArckepSearchChoice({ chatConfig: {} }, 'qwen3.7-flash', 'qwen')).toBe(false);
    expect(
      await offersArckepSearchChoice({ chatConfig: {} }, 'deepseek-v4-flash', 'deepseek'),
    ).toBe(false);
    expect(
      await offersArckepSearchChoice(
        { chatConfig: { searchMode: 'off' } },
        'gpt-5.6-luna',
        'openai',
      ),
    ).toBe(false);
    // встроенный снят человеком — «Поиск Arckep» уже идёт сразу (resolveArckepSearchPluginIds), не вторым
    expect(
      await offersArckepSearchChoice(
        { chatConfig: { useModelBuiltinSearch: false } },
        'gpt-5.6-luna',
        'openai',
      ),
    ).toBe(false);
  });
});

it('gives only direct DeepSeek Flash native search, retaining Pro/OpenRouter fallback', async () => {
  expect(await modelHasBuiltinSearch('deepseek-flash', 'deepseek')).toBe(true);
  expect(await modelHasBuiltinSearch('deepseek-v4-pro', 'deepseek')).toBe(false);
  expect(await modelHasBuiltinSearch('deepseek/deepseek-flash', 'openrouter')).toBe(false);
  expect(await resolveArckepSearchPluginIds(undefined, 'deepseek-flash', 'deepseek')).toEqual([]);
  expect(await resolveArckepSearchPluginIds(undefined, 'deepseek-v4-pro', 'deepseek')).toEqual([
    ARCKEP_WEB_SEARCH_CONNECTOR,
  ]);
});

describe('Gemini 4 routing away from Google native googleSearch to mcp-arckep-studio-web', () => {
  const gemini4Models = [
    'gemini-4-carbon',
    'gemini-4-neon',
    'gemini-4-hydrogen',
    'gemini-4-argon',
    'GEMINI-4-FUTURE',
  ];

  it.each(gemini4Models)(
    'google/%s disables builtin search and routes to mcp-arckep-studio-web across default, on, and explicit useModelBuiltinSearch=true',
    async (model) => {
      expect(await modelHasBuiltinSearch(model, 'google')).toBe(false);

      for (const cfg of [
        undefined,
        { chatConfig: {} },
        { chatConfig: { searchMode: 'auto' } },
        { chatConfig: { searchMode: 'on' } },
        { chatConfig: { useModelBuiltinSearch: true } },
        { chatConfig: { searchMode: 'on', useModelBuiltinSearch: true } },
      ]) {
        expect(await resolveServerEnabledSearch(cfg, model, 'google')).toBe(false);
        expect(await resolveArckepSearchPluginIds(cfg, model, 'google')).toEqual([
          ARCKEP_WEB_SEARCH_CONNECTOR,
        ]);
        expect(await offersArckepSearchChoice(cfg, model, 'google')).toBe(false);
        expect(prefersArckepSearchOnSchedule(cfg, 'google', model)).toBe(false);
      }

      for (const offMode of ['off', 'disabled'] as const) {
        const offCfg = { chatConfig: { searchMode: offMode, useModelBuiltinSearch: true } };
        expect(await resolveServerEnabledSearch(offCfg, model, 'google')).toBe(false);
        expect(await resolveArckepSearchPluginIds(offCfg, model, 'google')).toEqual([]);
        expect(await offersArckepSearchChoice(offCfg, model, 'google')).toBe(false);
        expect(prefersArckepSearchOnSchedule(offCfg, 'google', model)).toBe(false);
      }
    },
  );

  it('preserves Google native search for Gemini 3 models', async () => {
    for (const model of ['gemini-3.7-flash', 'gemini-3.1-flash-lite']) {
      expect(await modelHasBuiltinSearch(model, 'google')).toBe(true);
      expect(await resolveServerEnabledSearch(undefined, model, 'google')).toBe(true);
      expect(
        await resolveServerEnabledSearch(
          { chatConfig: { searchMode: 'on', useModelBuiltinSearch: true } },
          model,
          'google',
        ),
      ).toBe(true);
      expect(await resolveArckepSearchPluginIds(undefined, model, 'google')).toEqual([]);
      expect(await offersArckepSearchChoice(undefined, model, 'google')).toBe(true);
      expect(prefersArckepSearchOnSchedule({ chatConfig: {} }, 'google', model)).toBe(true);
    }
  });
});
