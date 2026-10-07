import { describe, expect, it } from 'vitest';

import { resolveModelSamplingParameters } from '../core/parameterResolver';
import {
  isContextCachingModel,
  isTemperatureDeprecated,
  isThinkingWithToolClaudeModel,
} from './models';

describe('Claude Haiku 5.5 capability patterns', () => {
  it.each([
    ['isContextCachingModel', isContextCachingModel],
    ['isThinkingWithToolClaudeModel', isThinkingWithToolClaudeModel],
    ['isTemperatureDeprecated', isTemperatureDeprecated],
  ])('%s matches claude-haiku-5-5 only', (_name, matcher) => {
    expect(matcher('claude-haiku-5-5')).toBe(true);
    expect(matcher('claude-haiku-5-5-20261007')).toBe(true);
    expect(matcher('claude-haiku-5-50')).toBe(false);
    expect(matcher('claude-haiku-5')).toBe(false);
  });

  it('keeps Haiku 4.5 temperature support', () => {
    expect(isTemperatureDeprecated('claude-haiku-4-5-20251001')).toBe(false);
    expect(isContextCachingModel('claude-haiku-4-5-20251001')).toBe(true);
  });

  it('skips sampling parameters for Haiku 5.5', () => {
    expect(
      resolveModelSamplingParameters('claude-haiku-5-5', { temperature: 0.7, top_p: 0.9 }),
    ).toEqual({});
  });
});
