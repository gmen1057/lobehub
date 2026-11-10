import * as AiModels from 'model-bank';
import { type AiFullModelCard } from 'model-bank';
import { afterEach, describe, expect, it } from 'vitest';

import { extractEnabledModels, transformToAiModelList } from '@/utils/server/parseModels';

import { ARCKEP_STUDIO_MODEL_LISTS, resolveArckepModelList } from '../arckepModelLists';

describe('ARCKEP_STUDIO_MODEL_LISTS', () => {
  const savedEngineKey = process.env.ARCKEP_ENGINE_SERVICE_KEY;
  const savedOverride = process.env.ARCKEP_OPENAI_MODEL_LIST;

  afterEach(() => {
    if (savedEngineKey === undefined) delete process.env.ARCKEP_ENGINE_SERVICE_KEY;
    else process.env.ARCKEP_ENGINE_SERVICE_KEY = savedEngineKey;
    if (savedOverride === undefined) delete process.env.ARCKEP_OPENAI_MODEL_LIST;
    else process.env.ARCKEP_OPENAI_MODEL_LIST = savedOverride;
  });

  it('uses git-tracked studio model lists when ARCKEP_ENGINE_SERVICE_KEY is set and honours ARCKEP_*_MODEL_LIST override', () => {
    delete process.env.ARCKEP_ENGINE_SERVICE_KEY;
    expect(resolveArckepModelList('openai', '+gpt-5.5')).toBe('+gpt-5.5');

    process.env.ARCKEP_ENGINE_SERVICE_KEY = 'test-engine-key';
    expect(resolveArckepModelList('openai', '+gpt-5.5')).toBe(ARCKEP_STUDIO_MODEL_LISTS.openai);

    process.env.ARCKEP_OPENAI_MODEL_LIST = '-all,+gpt-6.1-sol';
    expect(resolveArckepModelList('openai', '+gpt-5.5')).toBe('-all,+gpt-6.1-sol');
  });

  it('exposes final HY4 with image understanding', async () => {
    const models = await transformToAiModelList({
      defaultModels: [],
      modelString: ARCKEP_STUDIO_MODEL_LISTS.openrouter,
      providerId: 'openrouter',
    });
    const hy4 = models?.find((model) => model.id === 'tencent/hy4');
    expect(hy4?.abilities).toMatchObject({ functionCall: true, reasoning: true, vision: true });
    expect(hy4?.contextWindowTokens).toBe(1_048_576);
  });

  it('produces exact 34 studio chat models across the 7 enabled providers and excludes legacy/retired IDs', async () => {
    const activeChatKeys: string[] = [];

    for (const [provider, modelString] of Object.entries(ARCKEP_STUDIO_MODEL_LISTS)) {
      const withDeploymentName = provider === 'qwen';
      const defaultModels =
        (AiModels[provider as keyof typeof AiModels] as AiFullModelCard[]) || [];
      const enabledIds = new Set(
        (await extractEnabledModels(provider, modelString, withDeploymentName)) ?? [],
      );
      const list = await transformToAiModelList({
        defaultModels,
        modelString,
        providerId: provider,
        withDeploymentName,
      });

      for (const item of list ?? []) {
        if (!enabledIds.has(item.id) || item.type !== 'chat') continue;
        const abilities = item.abilities ?? {};
        if (abilities.imageOutput) continue;
        const hasAnyAbility = Object.values(abilities).some(Boolean);
        const hasContext =
          typeof item.contextWindowTokens === 'number' && item.contextWindowTokens > 0;
        if (!hasAnyAbility && !hasContext) continue;
        activeChatKeys.push(`${provider}/${item.id}`);
      }
    }

    expect(activeChatKeys).toHaveLength(34);

    // Owner decision: keep BOTH GPT-6 Sol and GPT-6.1 Sol, and BOTH Gemini 4 Carbon and Argon
    expect(activeChatKeys).toContain('openai/gpt-6-sol');
    expect(activeChatKeys).toContain('openai/gpt-6.1-sol');
    expect(activeChatKeys).toContain('google/gemini-4-carbon');
    expect(activeChatKeys).toContain('google/gemini-4-argon');

    // Sept–Nov 2026 additions + canonical deepseek-flash
    for (const expected of [
      'anthropic/claude-fable-5-2',
      'anthropic/claude-opus-5-5',
      'anthropic/claude-sonnet-5-5',
      'anthropic/claude-haiku-5-5',
      'google/gemini-3.8-flash',
      'qwen/qwen3.8-omni-flash',
      'openrouter/mistralai/mistral-large-4-0',
      'openrouter/xiaomi/mimo-v2.6-pro',
      'openrouter/xiaomi/mimo-v2.6-flash',
      'openrouter/tencent/hy4',
      'deepseek/deepseek-flash',
    ]) {
      expect(activeChatKeys).toContain(expected);
    }

    // Previous-generation API-only models & retired 1st-gen Qwen image IDs must not appear
    for (const excluded of [
      'openai/gpt-5.5',
      'openai/gpt-5.4',
      'openai/gpt-5.6-sol',
      'anthropic/claude-sonnet-4-6',
      'anthropic/claude-opus-5',
      'anthropic/claude-fable-5-1',
      'anthropic/claude-fable-5',
      'google/gemini-3.7-flash',
      'google/gemini-3.1-pro-preview',
      'xai/grok-4.6',
      'xai/grok-4.3',
      'deepseek/deepseek-v4-flash',
      'deepseek/deepseek-v4-flash-vision-exp',
      'qwen/qwen3.7-max',
      'qwen/qwen3.5-plus',
      'qwen/qwen-image-plus',
      'qwen/qwen-image-max',
      'qwen/qwen-image-edit',
      'qwen/qwen-image-edit-plus',
      'openrouter/tencent/hy4-preview',
      'openrouter/openrouter/auto',
      'openrouter/moonshotai/kimi-k3',
    ]) {
      expect(activeChatKeys).not.toContain(excluded);
    }
  });
});
