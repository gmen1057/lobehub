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

describe('Haiku 5.5 payload', () => {
  const basePayload = {
    messages: [{ role: 'user' as const, content: 'Hello' }],
    model: 'claude-haiku-5-5',
  };

  it('uses adaptive summarized thinking and drops budgets and sampling', async () => {
    const result = await buildDefaultAnthropicPayload({
      ...basePayload,
      thinking: { type: 'enabled', budget_tokens: 1024 },
      temperature: 0.7,
      top_p: 0.9,
      top_k: 5,
    } as any);

    expect(result.thinking).toEqual({ display: 'summarized', type: 'adaptive' });
    expect(result).not.toHaveProperty('temperature');
    expect(result).not.toHaveProperty('top_p');
    expect(result).not.toHaveProperty('top_k');
    expect(JSON.stringify(result)).not.toContain('budget_tokens');
  });

  it('defaults to adaptive summarized thinking when thinking is not set', async () => {
    const result = await buildDefaultAnthropicPayload(basePayload);

    expect(result.thinking).toEqual({ display: 'summarized', type: 'adaptive' });
  });

  it('keeps adaptive thinking when the caller asks for it', async () => {
    const result = await buildDefaultAnthropicPayload({
      ...basePayload,
      thinking: { type: 'adaptive', budget_tokens: 0 },
    });

    expect(result.thinking).toEqual({ display: 'summarized', type: 'adaptive' });
  });

  it('defaults effort to low and sends it as output_config', async () => {
    const result = await buildDefaultAnthropicPayload(basePayload);

    expect(result.output_config).toEqual({ effort: 'low' });
    expect(result).not.toHaveProperty('effort');
  });

  it('keeps an explicit effort', async () => {
    const result = await buildDefaultAnthropicPayload({ ...basePayload, effort: 'high' });

    expect(result.output_config).toEqual({ effort: 'high' });
  });

  it.each(['low', 'medium', 'high'] as const)(
    'keeps thinking disabled with effort %s',
    async (effort) => {
      const result = await buildDefaultAnthropicPayload({
        ...basePayload,
        effort,
        thinking: { type: 'disabled', budget_tokens: 0 },
      });

      expect(result.thinking).toEqual({ type: 'disabled' });
      expect(result.output_config).toEqual({ effort });
    },
  );

  it('keeps thinking disabled with the default effort', async () => {
    const result = await buildDefaultAnthropicPayload({
      ...basePayload,
      thinking: { type: 'disabled', budget_tokens: 0 },
    });

    expect(result.thinking).toEqual({ type: 'disabled' });
    expect(result.output_config).toEqual({ effort: 'low' });
  });

  it.each(['xhigh', 'max'])(
    'falls back to adaptive summarized when thinking is disabled with effort %s',
    async (effort) => {
      const result = await buildDefaultAnthropicPayload({
        ...basePayload,
        effort: effort as any,
        thinking: { type: 'disabled', budget_tokens: 0 },
      });

      expect(result.thinking).toEqual({ display: 'summarized', type: 'adaptive' });
      expect(result.output_config).toEqual({ effort });
    },
  );

  it('drops a trailing assistant turn so messages end with a user turn', async () => {
    const result = await buildDefaultAnthropicPayload({
      model: 'claude-haiku-5-5',
      messages: [
        { role: 'user', content: 'Return JSON' },
        { role: 'assistant', content: '{' },
      ],
    });

    expect(result.messages).toHaveLength(1);
    expect(result.messages.at(-1)?.role).toBe('user');
  });

  it('keeps the cache breakpoint on the last user turn after dropping a prefill', async () => {
    const result = await buildDefaultAnthropicPayload({
      model: 'claude-haiku-5-5',
      messages: [
        { role: 'user', content: 'Return JSON' },
        { role: 'assistant', content: '{' },
      ],
    });

    expect(JSON.stringify(result.messages.at(-1))).toContain('cache_control');
  });

  it('never empties messages', async () => {
    const result = await buildDefaultAnthropicPayload({
      model: 'claude-haiku-5-5',
      messages: [{ role: 'assistant', content: 'Only me' }],
    });

    expect(result.messages).toHaveLength(1);
  });

  it('keeps earlier assistant turns', async () => {
    const result = await buildDefaultAnthropicPayload({
      model: 'claude-haiku-5-5',
      messages: [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello' },
        { role: 'user', content: 'Again' },
      ],
    });

    expect(result.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
  });

  it('keeps system prompt, tools and the search tool', async () => {
    const result = await buildDefaultAnthropicPayload({
      enabledSearch: true,
      messages: [
        { role: 'system', content: 'Be brief' },
        { role: 'user', content: 'Weather?' },
      ],
      model: 'claude-haiku-5-5',
      tools: [
        {
          type: 'function',
          function: { name: 'weather', description: 'Get weather', parameters: { type: 'object' } },
        },
      ],
    });

    expect(result.system).toEqual([
      { cache_control: { type: 'ephemeral' }, text: 'Be brief', type: 'text' },
    ]);
    expect((result.tools as Array<{ name: string }>).map((tool) => tool.name)).toEqual([
      'weather',
      'web_search',
    ]);
  });

  it('does not change Haiku 4.5 (budget thinking and sampling stay, prefill is kept)', async () => {
    const result = await buildDefaultAnthropicPayload({
      model: 'claude-haiku-4-5-20251001',
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: '{' },
      ],
      thinking: { type: 'enabled', budget_tokens: 1024 },
    });

    expect(result.thinking).toEqual({ budget_tokens: 1024, type: 'enabled' });
    expect(result.output_config).toBeUndefined();
    expect(result.messages).toHaveLength(2);
  });
});
