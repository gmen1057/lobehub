import { describe, expect, it, vi } from 'vitest';

import {
  ARCKEP_WEB_SEARCH_CONNECTOR,
  modelHasBuiltinSearch,
  resolveArckepSearchPluginIds,
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
