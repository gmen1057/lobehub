import * as AiModels from 'model-bank';
import { type AiFullModelCard, LOBE_DEFAULT_MODEL_LIST } from 'model-bank';
import {
  ARCKEP_STUDIO_MODEL_CARDS,
  ARCKEP_STUDIO_MODEL_COUNT,
  ARCKEP_STUDIO_PROVIDER_IDS,
} from 'model-bank/arckepStudioModels';
import { afterEach, describe, expect, it } from 'vitest';

import { modelHasVision } from '@/server/services/aiAgent/modelVision';
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

  it('exposes Hydrogen alongside Carbon and Argon with the synchronous output limit', async () => {
    const models = await transformToAiModelList({
      defaultModels: AiModels.google,
      modelString: ARCKEP_STUDIO_MODEL_LISTS.google,
      providerId: 'google',
    });
    const hydrogen = models?.find((model) => model.id === 'gemini-4-hydrogen');
    expect(hydrogen?.abilities).toMatchObject({
      functionCall: true,
      reasoning: true,
      search: true,
      structuredOutput: true,
      video: true,
      vision: true,
    });
    expect(hydrogen?.abilities.imageOutput).toBeFalsy();
    expect(hydrogen?.contextWindowTokens).toBe(1_048_576);
    expect(hydrogen?.maxOutput).toBe(65_536);
    expect(hydrogen?.settings).toMatchObject({
      extendParams: ['thinkingLevel3', 'urlContext'],
      searchImpl: 'params',
      searchProvider: 'google',
    });
    expect(models?.some((model) => model.id === 'gemini-4-carbon')).toBe(true);
    expect(models?.some((model) => model.id === 'gemini-4-argon')).toBe(true);
  });

  it('keeps activeChatKeys, LOBE_DEFAULT_MODEL_LIST and AiModels[provider] synced with ARCKEP_STUDIO_MODEL_CARDS and excludes retired IDs', async () => {
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

    expect(activeChatKeys).toHaveLength(ARCKEP_STUDIO_MODEL_COUNT);

    for (const provider of ARCKEP_STUDIO_PROVIDER_IDS) {
      const providerModels = AiModels[provider] as AiFullModelCard[];
      for (const card of ARCKEP_STUDIO_MODEL_CARDS[provider]) {
        expect(activeChatKeys).toContain(`${provider}/${card.id}`);
        const inBank = LOBE_DEFAULT_MODEL_LIST.find(
          (item) => item.providerId === provider && item.id === card.id,
        );
        expect(inBank).toBeDefined();
        const inProvider = providerModels.find((item) => item.id === card.id);
        expect(inProvider).toBeDefined();
      }
    }

    // Owner decision: keep BOTH GPT-6 Sol and GPT-6.1 Sol, and BOTH Gemini 4 Carbon and Argon
    expect(activeChatKeys).toContain('openai/gpt-6-sol');
    expect(activeChatKeys).toContain('openai/gpt-6.1-sol');
    expect(activeChatKeys).toContain('google/gemini-4-carbon');
    expect(activeChatKeys).toContain('google/gemini-4-argon');

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

  it('returns false from modelHasVision for all 6 text-only studio models and true for vision models', async () => {
    const textOnlyStudioModels: ReadonlyArray<[string, string]> = [
      ['inception/mercury-3', 'openrouter'],
      ['xiaomi/mimo-v2.6-pro', 'openrouter'],
      ['xiaomi/mimo-v2.6-flash', 'openrouter'],
      ['z-ai/glm-5.3', 'openrouter'],
      ['deepseek-v4-pro', 'deepseek'],
      ['grok-build-0.1', 'xai'],
    ];
    for (const [model, provider] of textOnlyStudioModels) {
      expect(await modelHasVision(model, provider), `${provider}/${model}`).toBe(false);
    }

    const visionStudioModels: ReadonlyArray<[string, string]> = [
      ['gemini-4-carbon', 'google'],
      ['claude-fable-5-2', 'anthropic'],
      ['tencent/hy4', 'openrouter'],
      ['gpt-6.1-sol', 'openai'],
      ['deepseek-flash', 'deepseek'],
      ['qwen3.8-omni-flash', 'qwen'],
      ['grok-4.7', 'xai'],
    ];
    for (const [model, provider] of visionStudioModels) {
      expect(await modelHasVision(model, provider), `${provider}/${model}`).toBe(true);
    }
  });

  it('overlays studio maxOutput and video abilities onto model-bank cards while preserving upstream cache pricing', () => {
    const opus55 = AiModels.anthropic.find((item) => item.id === 'claude-opus-5-5');
    const haiku55 = AiModels.anthropic.find((item) => item.id === 'claude-haiku-5-5');
    expect(opus55?.maxOutput).toBe(128_000);
    expect(haiku55?.maxOutput).toBe(128_000);

    const fable52 = AiModels.anthropic.find((item) => item.id === 'claude-fable-5-2');
    expect(fable52?.pricing?.units.some((u) => u.name === 'textInput_cacheRead')).toBe(true);

    const kimiK31Pro = LOBE_DEFAULT_MODEL_LIST.find(
      (item) => item.providerId === 'openrouter' && item.id === 'moonshotai/kimi-k3.1-pro',
    );
    const qwenOmni = LOBE_DEFAULT_MODEL_LIST.find(
      (item) => item.providerId === 'qwen' && item.id === 'qwen3.8-omni-flash',
    );
    expect(kimiK31Pro?.abilities.video).toBe(true);
    expect(qwenOmni?.abilities.video).toBe(true);

    // Studio textInput/textOutput rates win over stale upstream rates while keeping non-chat cards intact
    const qwen37Plus = AiModels.qwen.find((item) => item.id === 'qwen3.7-plus');
    expect(qwen37Plus?.pricing?.units.find((u) => u.name === 'textInput')).toMatchObject({
      rate: 0.4,
      strategy: 'fixed',
    });
    expect(qwen37Plus?.pricing?.units.find((u) => u.name === 'textOutput')).toMatchObject({
      rate: 1.6,
      strategy: 'fixed',
    });

    const overlaidWithMedia = AiModels.withArckepOverlay('openai', [
      { id: 'gpt-6.1-sol', type: 'image' } as AiFullModelCard,
    ]);
    expect(overlaidWithMedia.filter((m) => m.id === 'gpt-6.1-sol').map((m) => m.type)).toEqual([
      'chat',
      'image',
    ]);
  });
});
