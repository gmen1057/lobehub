import { describe, expect, it, vi } from 'vitest';

import {
  ARCKEP_WEB_SEARCH_CONNECTOR,
  offersArckepSearchChoice,
  prefersArckepSearchOnSchedule,
  resolveArckepSearchPluginIds,
  resolveSandboxAllowInternet,
  resolveServerEnabledSearch,
} from '../arckepSearch';

vi.mock('model-bank', () => ({
  LOBE_DEFAULT_MODEL_LIST: [
    { abilities: { search: true }, id: 'searchy-model', providerId: 'test-provider' },
    { abilities: {}, id: 'plain-model', providerId: 'test-provider' },
  ],
}));

describe('resolveSandboxAllowInternet', () => {
  describe('native search providers (Claude, Gemini, OpenAI, Qwen, xAI, DeepSeek Flash)', () => {
    const nativeCases: Array<[string, string]> = [
      ['anthropic', 'claude-opus-5'],
      ['google', 'gemini-3.7-flash'],
      ['openai', 'gpt-5.6-luna'],
      ['qwen', 'qwen3.7-flash'],
      ['xai', 'grok-4.3'],
      ['deepseek', 'deepseek-flash'],
    ];

    it.each(nativeCases)(
      '%s/%s: allows internet for undefined, auto, and on searchMode even if Arckep web connector is disabled',
      async (provider, model) => {
        for (const searchMode of [undefined, 'auto', 'on'] as const) {
          expect(
            await resolveSandboxAllowInternet({
              agentConfig: searchMode ? { chatConfig: { searchMode } } : undefined,
              disabledToolIds: [ARCKEP_WEB_SEARCH_CONNECTOR],
              model,
              provider,
            }),
            `${provider}/${model} searchMode=${String(searchMode)}`,
          ).toBe(true);
        }
      },
    );

    it.each(nativeCases)(
      '%s/%s: denies internet when searchMode is off',
      async (provider, model) => {
        expect(
          await resolveSandboxAllowInternet({
            agentConfig: { chatConfig: { searchMode: 'off' } },
            disabledToolIds: [],
            model,
            provider,
          }),
        ).toBe(false);
      },
    );
  });

  describe('non-native search models (Gemini 4, DeepSeek Pro, OpenRouter)', () => {
    const connectorCases: Array<[string, string]> = [
      ['google', 'gemini-4-carbon'],
      ['google', 'gemini-4-neon'],
      ['google', 'gemini-4-hydrogen'],
      ['google', 'gemini-4-argon'],
      ['deepseek', 'deepseek-v4-pro'],
      ['openrouter', 'z-ai/glm-5.3-flash'],
      ['openrouter', 'deepseek/deepseek-flash'],
    ];

    it.each(connectorCases)(
      '%s/%s: allows internet when search is not off and Arckep web connector is not disabled',
      async (provider, model) => {
        for (const searchMode of [undefined, 'auto', 'on'] as const) {
          expect(
            await resolveSandboxAllowInternet({
              agentConfig: searchMode ? { chatConfig: { searchMode } } : undefined,
              disabledToolIds: [],
              model,
              provider,
            }),
            `${provider}/${model} searchMode=${String(searchMode)}`,
          ).toBe(true);
        }
      },
    );

    it.each(['gemini-4-carbon', 'gemini-4-neon', 'gemini-4-hydrogen', 'gemini-4-argon'])(
      'google/%s: still routes via Arckep web connector even when useModelBuiltinSearch is true, and respects dataGuardProtected',
      async (model) => {
        expect(
          await resolveSandboxAllowInternet({
            agentConfig: { chatConfig: { searchMode: 'on', useModelBuiltinSearch: true } },
            disabledToolIds: [],
            model,
            provider: 'google',
          }),
        ).toBe(true);

        expect(
          await resolveSandboxAllowInternet({
            agentConfig: { chatConfig: { searchMode: 'on', useModelBuiltinSearch: true } },
            disabledToolIds: [ARCKEP_WEB_SEARCH_CONNECTOR],
            model,
            provider: 'google',
          }),
        ).toBe(false);

        expect(
          await resolveSandboxAllowInternet({
            agentConfig: { chatConfig: { searchMode: 'on', useModelBuiltinSearch: true } },
            dataGuardProtected: true,
            disabledToolIds: [],
            model,
            provider: 'google',
          }),
        ).toBe(false);

        expect(
          await resolveSandboxAllowInternet({
            agentConfig: {
              chatConfig: {
                deepseekDataGuardProtected: true,
                searchMode: 'on',
                useModelBuiltinSearch: true,
              },
            },
            disabledToolIds: [],
            model,
            provider: 'google',
          }),
        ).toBe(false);
      },
    );

    it.each(connectorCases)(
      '%s/%s: denies internet when Arckep web connector is explicitly disabled',
      async (provider, model) => {
        for (const searchMode of [undefined, 'auto', 'on'] as const) {
          expect(
            await resolveSandboxAllowInternet({
              agentConfig: searchMode ? { chatConfig: { searchMode } } : { chatConfig: {} },
              disabledToolIds: [ARCKEP_WEB_SEARCH_CONNECTOR],
              model,
              provider,
            }),
            `${provider}/${model} searchMode=${String(searchMode)}`,
          ).toBe(false);
        }
      },
    );

    it.each(connectorCases)(
      '%s/%s: denies internet when searchMode is off even if connector is enabled',
      async (provider, model) => {
        expect(
          await resolveSandboxAllowInternet({
            agentConfig: { chatConfig: { searchMode: 'off' } },
            disabledToolIds: [],
            model,
            provider,
          }),
        ).toBe(false);
      },
    );
  });

  describe('cron / useModelBuiltinSearch: false on paid native providers', () => {
    const paidNativeCases: Array<[string, string]> = [
      ['anthropic', 'claude-opus-5'],
      ['google', 'gemini-3.7-flash'],
      ['openai', 'gpt-5.6-luna'],
      ['xai', 'grok-4.3'],
    ];

    it.each(paidNativeCases)(
      '%s/%s: falls back to Arckep web connector availability when builtin search is disabled',
      async (provider, model) => {
        expect(
          await resolveSandboxAllowInternet({
            agentConfig: { chatConfig: { searchMode: 'auto', useModelBuiltinSearch: false } },
            disabledToolIds: [],
            model,
            provider,
          }),
        ).toBe(true);

        expect(
          await resolveSandboxAllowInternet({
            agentConfig: { chatConfig: { searchMode: 'on', useModelBuiltinSearch: false } },
            disabledToolIds: [ARCKEP_WEB_SEARCH_CONNECTOR],
            model,
            provider,
          }),
        ).toBe(false);

        expect(
          await resolveSandboxAllowInternet({
            agentConfig: { chatConfig: { searchMode: 'off', useModelBuiltinSearch: false } },
            disabledToolIds: [],
            model,
            provider,
          }),
        ).toBe(false);
      },
    );
  });

  describe('legacy searchMode: disabled (treated identically to off)', () => {
    it.each([
      ['anthropic', 'claude-opus-5'],
      ['google', 'gemini-3.7-flash'],
      ['google', 'gemini-4-carbon'],
      ['openai', 'gpt-5.6-luna'],
      ['qwen', 'qwen3.7-flash'],
      ['xai', 'grok-4.3'],
      ['deepseek', 'deepseek-flash'],
      ['deepseek', 'deepseek-v4-pro'],
      ['openrouter', 'z-ai/glm-5.3-flash'],
    ])(
      '%s/%s: closes sandbox internet and disables all search helpers when searchMode is disabled',
      async (provider, model) => {
        const cfg = { chatConfig: { searchMode: 'disabled' } };
        expect(
          await resolveSandboxAllowInternet({
            agentConfig: cfg,
            disabledToolIds: [],
            model,
            provider,
          }),
        ).toBe(false);
        expect(await resolveServerEnabledSearch(cfg, model, provider)).toBe(false);
        expect(await resolveArckepSearchPluginIds(cfg, model, provider)).toEqual([]);
        expect(prefersArckepSearchOnSchedule(cfg, provider)).toBe(false);
        expect(await offersArckepSearchChoice(cfg, model, provider)).toBe(false);
      },
    );
  });

  describe('edge cases', () => {
    it('respects searchMode=off, searchMode=disabled, and disabledToolIds when model or provider is missing', async () => {
      expect(
        await resolveSandboxAllowInternet({
          agentConfig: { chatConfig: { searchMode: 'off' } },
        }),
      ).toBe(false);

      expect(
        await resolveSandboxAllowInternet({
          agentConfig: { chatConfig: { searchMode: 'disabled' } },
        }),
      ).toBe(false);

      expect(
        await resolveSandboxAllowInternet({
          disabledToolIds: [ARCKEP_WEB_SEARCH_CONNECTOR],
        }),
      ).toBe(false);

      expect(await resolveSandboxAllowInternet({})).toBe(true);
    });
  });
});
