import { describe, expect, it } from 'vitest';

import anthropicChatModels from './aiModels/anthropic';

describe('anthropic cards: Claude Haiku 5.5', () => {
  const ids = anthropicChatModels.map((model) => model.id);
  const haiku55 = anthropicChatModels.find((model) => model.id === 'claude-haiku-5-5');
  const haiku45 = anthropicChatModels.find((model) => model.id === 'claude-haiku-4-5-20251001');

  it('has unique card ids', () => {
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('exposes the Haiku 5.5 card with the vendor limits and abilities', () => {
    expect(haiku55).toMatchObject({
      abilities: {
        functionCall: true,
        reasoning: true,
        search: true,
        structuredOutput: true,
        vision: true,
      },
      contextWindowTokens: 1_000_000,
      displayName: 'Claude Haiku 5.5',
      enabled: true,
      maxOutput: 128_000,
      releasedAt: '2026-10-07',
      settings: { extendParams: ['disableContextCaching', 'effort'], searchImpl: 'params' },
      type: 'chat',
    });
  });

  it('does not offer the budget-based thinking controls of Haiku 4.5', () => {
    const extendParams = haiku55?.settings?.extendParams ?? [];

    expect(extendParams).not.toContain('enableReasoning');
    expect(extendParams).not.toContain('reasoningBudgetToken');
    expect(extendParams).not.toContain('enableAdaptiveThinking');
  });

  it('prices the short tier and switches the whole request to x5 above 100K prompt tokens', () => {
    const units = haiku55?.pricing?.units ?? [];
    const tiers = (name: string) => {
      const unit = units.find((item) => item.name === name);
      return unit?.strategy === 'tiered' ? unit.tiers : undefined;
    };

    expect(tiers('textInput')).toEqual([
      { rate: 0.1, upTo: 100_000 },
      { rate: 0.5, upTo: 'infinity' },
    ]);
    expect(tiers('textOutput')).toEqual([
      { rate: 0.5, upTo: 100_000 },
      { rate: 2.5, upTo: 'infinity' },
    ]);
    expect(tiers('textInput_cacheRead')).toEqual([
      { rate: 0.01, upTo: 100_000 },
      { rate: 0.05, upTo: 'infinity' },
    ]);

    const cacheWrite = units.find((unit) => unit.name === 'textInput_cacheWrite');
    expect(cacheWrite).toMatchObject({
      lookup: { prices: { '1h': 0.2, '5m': 0.125 }, pricingParams: ['ttl'] },
      strategy: 'lookup',
    });
  });

  it('keeps Haiku 4.5 enabled, labelled legacy and after Haiku 5.5', () => {
    expect(haiku45?.enabled).toBe(true);
    expect(haiku45?.displayName).toBe('Claude Haiku 4.5 (legacy)');
    expect(haiku45?.description).toContain('Claude Haiku 5.5');
    expect(ids.indexOf('claude-haiku-5-5')).toBeLessThan(ids.indexOf('claude-haiku-4-5-20251001'));
  });
});
