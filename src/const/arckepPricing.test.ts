import { describe, expect, it } from 'vitest';

import { isOpenRouterRoute, recordsSpendRub, spendToRub, usdToRub } from './arckepPricing';

describe('arckep stats pricing', () => {
  it('treats provider openrouter as OpenRouter, even for openai/* models', () => {
    expect(isOpenRouterRoute('openrouter', 'openai/gpt-6-astra')).toBe(true);
    expect(isOpenRouterRoute('openrouter', 'openrouter/auto')).toBe(true);
  });

  it('decides by the vendor prefix when the provider is not openrouter', () => {
    expect(isOpenRouterRoute(undefined, 'moonshotai/kimi-k3')).toBe(true);
    expect(isOpenRouterRoute('custom', 'meta/muse-wonder')).toBe(true);
    expect(isOpenRouterRoute('openai', 'gpt-6-astra')).toBe(false);
    expect(isOpenRouterRoute('deepseek', 'deepseek-v4-pro')).toBe(false);
    // a prefix must match exactly, like the backend
    expect(isOpenRouterRoute('openai', 'metaverse/x')).toBe(false);
  });

  it('adds 5.5% to OpenRouter requests only', () => {
    expect(spendToRub(1, { model: 'gpt-6-astra', provider: 'openai' })).toBeCloseTo(110, 10);
    expect(spendToRub(1, { model: 'openrouter/auto', provider: 'openrouter' })).toBeCloseTo(
      116.05,
      10,
    );
    expect(usdToRub(1)).toBe(110);
  });

  it('keeps requests charged before the switch at the plain rate', () => {
    const or = { model: 'z-ai/glm-5.3', provider: 'openrouter' };
    expect(spendToRub(1, { ...or, createdAt: new Date('2026-10-13T11:00:00Z') })).toBeCloseTo(
      110,
      10,
    );
    expect(spendToRub(1, { ...or, createdAt: '2026-10-13T11:06:47Z' })).toBeCloseTo(116.05, 10);
    expect(spendToRub(1, { ...or, createdAt: Date.parse('2026-10-14T00:00:00Z') })).toBeCloseTo(
      116.05,
      10,
    );
  });

  it('sums records each at its own rate', () => {
    const total = recordsSpendRub([
      { model: 'gpt-6-astra', provider: 'openai', spend: 1 },
      { model: 'z-ai/glm-5.3', provider: 'openrouter', spend: 2 },
      { model: 'deepseek-v4-pro', provider: 'deepseek', spend: null },
    ]);
    expect(total).toBeCloseTo(110 + 2 * 116.05, 10);
    expect(recordsSpendRub(undefined)).toBe(0);
  });
});
