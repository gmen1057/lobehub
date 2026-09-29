// @vitest-environment node
import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';

import { buildDefaultAnthropicPayload, createDefaultAnthropicClient } from './index';

vi.mock('@anthropic-ai/sdk', () => {
  const MockAnthropic = vi.fn();
  return { default: MockAnthropic };
});

vi.mock('@lobechat/const', () => ({
  CURRENT_VERSION: '1.0.0-test',
}));

const MockedAnthropic = vi.mocked(Anthropic);

describe('createDefaultAnthropicClient', () => {
  it('should include User-Agent header with current version', () => {
    MockedAnthropic.mockClear();

    createDefaultAnthropicClient({ apiKey: 'test-key' });

    expect(MockedAnthropic).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultHeaders: expect.objectContaining({
          'User-Agent': 'lobehub/1.0.0-test',
        }),
      }),
    );
  });

  it('should preserve caller-provided default headers alongside User-Agent', () => {
    MockedAnthropic.mockClear();

    createDefaultAnthropicClient({
      apiKey: 'test-key',
      defaultHeaders: { 'X-Custom': 'value' },
    });

    const passedOptions = MockedAnthropic.mock.calls[0][0] as any;

    expect(passedOptions.defaultHeaders).toMatchObject({
      'User-Agent': 'lobehub/1.0.0-test',
      'X-Custom': 'value',
    });
  });
});

describe('Sonnet 5.5 payload', () => {
  it('uses adaptive thinking and drops obsolete budgets and sampling', async () => {
    const result = await buildDefaultAnthropicPayload({
      model: 'claude-sonnet-5-5',
      messages: [{ role: 'user', content: 'Hello' }],
      thinking: { type: 'enabled', budget_tokens: 1024 },
      temperature: 0.7,
      top_p: 0.9,
      effort: 'high',
    });
    expect(result.thinking).toEqual({ type: 'adaptive' });
    expect(result.output_config).toEqual({ effort: 'high' });
    expect(result.temperature).toBeUndefined();
    expect(result.top_p).toBeUndefined();
  });
});
