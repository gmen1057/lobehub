// @vitest-environment node
import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_LLM_REQUEST_TIMEOUT_MS } from '../../const/timeout';
import {
  buildDefaultAnthropicPayload,
  createAnthropicCompatibleParams,
  createAnthropicCompatibleRuntime,
  createDefaultAnthropicClient,
  resolveDefaultAnthropicPricingOptions,
} from './index';

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
    expect(passedOptions.timeout).toBe(DEFAULT_LLM_REQUEST_TIMEOUT_MS);
  });

  it('should default timeout to 26m, disable SDK retries when engine owns retries, and respect explicit overrides', () => {
    MockedAnthropic.mockClear();
    createDefaultAnthropicClient({ apiKey: 'test-key', timeout: 10_000 });
    expect((MockedAnthropic.mock.calls[0][0] as any).timeout).toBe(10_000);
    expect((MockedAnthropic.mock.calls[0][0] as any).maxRetries).toBeUndefined();

    MockedAnthropic.mockClear();
    const Runtime = createAnthropicCompatibleRuntime(
      createAnthropicCompatibleParams({ provider: 'anthropic' as any }),
    );
    new Runtime({ apiKey: 'test-key' });
    expect((MockedAnthropic.mock.calls[0][0] as any).timeout).toBe(DEFAULT_LLM_REQUEST_TIMEOUT_MS);
    expect(DEFAULT_LLM_REQUEST_TIMEOUT_MS).toBe(1_560_000);

    MockedAnthropic.mockClear();
    new Runtime({
      apiKey: 'test-key',
      baseURL: 'http://proxy.test',
      defaultHeaders: {
        'X-Arckep-Token': 'internal-test',
        'x-arckep-retry-owner': 'engine',
      },
    });
    expect((MockedAnthropic.mock.calls[0][0] as any).maxRetries).toBe(0);

    MockedAnthropic.mockClear();
    new Runtime({ apiKey: 'test-key', timeout: 10_000 });
    expect((MockedAnthropic.mock.calls[0][0] as any).timeout).toBe(10_000);
  });
});

describe('Sonnet 5.5 and Fable 5.2 adaptive payloads', () => {
  it('uses adaptive thinking and drops obsolete budgets and sampling for Sonnet 5.5', async () => {
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

  it('requests summarized adaptive thinking, drops sampling, and strips trailing assistant prefill for Fable 5.2', async () => {
    const result = await buildDefaultAnthropicPayload({
      model: 'claude-fable-5-2',
      messages: [
        { role: 'user', content: 'Design the architecture' },
        { role: 'assistant', content: 'Sure, starting with:' },
      ],
      temperature: 0.5,
      top_p: 0.8,
      effort: 'xhigh' as any,
    });
    expect(result.thinking).toEqual({ display: 'summarized', type: 'adaptive' });
    expect(result.output_config).toEqual({ effort: 'xhigh' });
    expect(result.temperature).toBeUndefined();
    expect(result.top_p).toBeUndefined();
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe('user');
  });
});

describe('Anthropic 1h prompt cache TTL', () => {
  const sampleTools = [
    {
      function: {
        description: 'Read a file chunk from the knowledge base',
        name: 'readKnowledge',
        parameters: {
          properties: { fileId: { type: 'string' }, offset: { type: 'number' } },
          required: ['fileId'],
          type: 'object',
        },
      },
      type: 'function' as const,
    },
    {
      function: {
        description: 'Search the knowledge base',
        name: 'searchKnowledgeBase',
        parameters: {
          properties: { query: { type: 'string' } },
          required: ['query'],
          type: 'object',
        },
      },
      type: 'function' as const,
    },
  ];

  const collectAllCacheControls = (payload: Anthropic.MessageCreateParams) => {
    const controls: Array<{
      location: 'system' | 'tools' | 'messages';
      value: Anthropic.Messages.CacheControlEphemeral;
    }> = [];

    if (Array.isArray(payload.system)) {
      for (const block of payload.system) {
        if (block.cache_control) {
          controls.push({ location: 'system', value: block.cache_control });
        }
      }
    }

    if (Array.isArray(payload.tools)) {
      for (const tool of payload.tools) {
        if ('cache_control' in tool && tool.cache_control) {
          controls.push({ location: 'tools', value: tool.cache_control });
        }
      }
    }

    for (const message of payload.messages) {
      if (!Array.isArray(message.content)) continue;
      for (const block of message.content) {
        if ('cache_control' in block && block.cache_control) {
          controls.push({ location: 'messages', value: block.cache_control });
        }
      }
    }

    return controls;
  };

  it('keeps default { type: "ephemeral" } (no ttl property) below 30K tokens', async () => {
    const requestPayload = {
      messages: [
        { content: 'You are a concise assistant.', role: 'system' as const },
        { content: 'Hello, summarize this short note.', role: 'user' as const },
      ],
      model: 'claude-sonnet-5-5',
      tools: sampleTools,
    };

    const result = await buildDefaultAnthropicPayload(requestPayload);
    const controls = collectAllCacheControls(result);

    expect(controls).toEqual([
      { location: 'system', value: { type: 'ephemeral' } },
      { location: 'tools', value: { type: 'ephemeral' } },
      { location: 'messages', value: { type: 'ephemeral' } },
    ]);
    for (const entry of controls) {
      expect(Object.keys(entry.value)).toEqual(['type']);
    }
    expect(resolveDefaultAnthropicPricingOptions(requestPayload, result)).toEqual({
      lookupParams: { ttl: '5m' },
    });
  });

  it('switches system, tools, and messages uniformly to ttl: "1h" at >= 30K tokens (no 5m before 1h)', async () => {
    const requestPayload = {
      enabledSearch: true,
      messages: [
        { content: 'System prompt for a long session.', role: 'system' as const },
        { content: 'a'.repeat(120_000), role: 'user' as const },
      ],
      model: 'claude-sonnet-5-5',
      tools: sampleTools,
    };

    const result = await buildDefaultAnthropicPayload(requestPayload);
    const controls = collectAllCacheControls(result);

    expect(controls).toEqual([
      { location: 'system', value: { ttl: '1h', type: 'ephemeral' } },
      { location: 'tools', value: { ttl: '1h', type: 'ephemeral' } },
      { location: 'messages', value: { ttl: '1h', type: 'ephemeral' } },
    ]);
    expect(resolveDefaultAnthropicPricingOptions(requestPayload, result)).toEqual({
      lookupParams: { ttl: '1h' },
    });
  });

  it('applies ttl: "1h" uniformly when the last message is a paired tool_result block', async () => {
    const requestPayload = {
      messages: [
        { content: 'Long system prompt', role: 'system' as const },
        { content: 'Read the document', role: 'user' as const },
        {
          content: '',
          role: 'assistant' as const,
          tool_calls: [
            {
              function: { arguments: '{"fileId":"f1"}', name: 'readKnowledge' },
              id: 'toolu_read_1',
              type: 'function' as const,
            },
          ],
        },
        {
          content: 'б'.repeat(62_000),
          role: 'tool' as const,
          tool_call_id: 'toolu_read_1',
        },
      ],
      model: 'claude-haiku-5-5',
      tools: sampleTools,
    };

    const result = await buildDefaultAnthropicPayload(requestPayload);
    const controls = collectAllCacheControls(result);

    expect(controls).toEqual([
      { location: 'system', value: { ttl: '1h', type: 'ephemeral' } },
      { location: 'tools', value: { ttl: '1h', type: 'ephemeral' } },
      { location: 'messages', value: { ttl: '1h', type: 'ephemeral' } },
    ]);
    expect(resolveDefaultAnthropicPricingOptions(requestPayload, result)).toEqual({
      lookupParams: { ttl: '1h' },
    });
  });

  it('does not upgrade to 1h on a short chat carrying a large 2MB base64 image', async () => {
    const twoMbBase64 = 'A'.repeat(2_000_000);
    const requestPayload = {
      messages: [
        { content: 'You are a vision assistant.', role: 'system' as const },
        {
          content: [
            { text: 'What is shown on this image?', type: 'text' as const },
            {
              image_url: { url: `data:image/png;base64,${twoMbBase64}` },
              type: 'image_url' as const,
            },
          ],
          role: 'user' as const,
        },
      ],
      model: 'claude-sonnet-5-5',
      tools: sampleTools,
    };

    const result = await buildDefaultAnthropicPayload(requestPayload);
    const controls = collectAllCacheControls(result);

    expect(controls).toEqual([
      { location: 'system', value: { type: 'ephemeral' } },
      { location: 'tools', value: { type: 'ephemeral' } },
      { location: 'messages', value: { type: 'ephemeral' } },
    ]);
    expect(resolveDefaultAnthropicPricingOptions(requestPayload, result)).toEqual({
      lookupParams: { ttl: '5m' },
    });
  });

  it('respects explicit cacheTTL overrides without breaking configured TTL', async () => {
    const forcedFiveMin = await buildDefaultAnthropicPayload({
      cacheTTL: '5m',
      messages: [
        { content: 'System prompt', role: 'system' },
        { content: 'a'.repeat(160_000), role: 'user' },
      ],
      model: 'claude-sonnet-5-5',
      tools: sampleTools,
    });

    expect(collectAllCacheControls(forcedFiveMin)).toEqual([
      { location: 'system', value: { type: 'ephemeral' } },
      { location: 'tools', value: { type: 'ephemeral' } },
      { location: 'messages', value: { type: 'ephemeral' } },
    ]);

    const forcedOneHour = await buildDefaultAnthropicPayload({
      cacheTTL: '1h',
      messages: [
        { content: 'System prompt', role: 'system' },
        { content: 'Short message', role: 'user' },
      ],
      model: 'claude-sonnet-5-5',
      tools: sampleTools,
    });

    expect(collectAllCacheControls(forcedOneHour)).toEqual([
      { location: 'system', value: { ttl: '1h', type: 'ephemeral' } },
      { location: 'tools', value: { ttl: '1h', type: 'ephemeral' } },
      { location: 'messages', value: { ttl: '1h', type: 'ephemeral' } },
    ]);
  });

  it('emits zero cache_control blocks when enabledContextCaching is false, even at 180K tokens', async () => {
    const requestPayload = {
      cacheTTL: '1h' as const,
      enabledContextCaching: false,
      messages: [
        { content: 'Compress this conversation.', role: 'system' as const },
        { content: 'a'.repeat(720_000), role: 'user' as const },
      ],
      model: 'claude-haiku-5-5',
      tools: sampleTools,
    };

    const result = await buildDefaultAnthropicPayload(requestPayload);

    expect(collectAllCacheControls(result)).toEqual([]);
    expect(resolveDefaultAnthropicPricingOptions(requestPayload, result)).toBeUndefined();
  });

  it('keeps monotonic 1h TTL when Claude 5.x pops trailing assistant prefill or last block is thinking', async () => {
    const prefillPayload = {
      messages: [
        { content: 'System prompt', role: 'system' as const },
        { content: 'a'.repeat(120_000), role: 'user' as const },
        { content: 'Draft prefill:', role: 'assistant' as const },
      ],
      model: 'claude-fable-5-2',
      tools: sampleTools,
    };

    const prefillResult = await buildDefaultAnthropicPayload(prefillPayload);
    const prefillControls = collectAllCacheControls(prefillResult);
    expect(prefillControls).toEqual([
      { location: 'system', value: { ttl: '1h', type: 'ephemeral' } },
      { location: 'tools', value: { ttl: '1h', type: 'ephemeral' } },
    ]);
    expect(resolveDefaultAnthropicPricingOptions(prefillPayload, prefillResult)).toEqual({
      lookupParams: { ttl: '1h' },
    });

    const thinkingLastPayload = {
      messages: [
        { content: 'System prompt', role: 'system' as const },
        { content: 'a'.repeat(120_000), role: 'user' as const },
        {
          content: [
            { text: 'Answer text', type: 'text' as const },
            { signature: 'sig_1', thinking: 'Internal reasoning', type: 'thinking' as const },
          ],
          role: 'assistant' as const,
        },
      ],
      model: 'claude-3-7-sonnet-20250219',
      tools: sampleTools,
    };

    const thinkingResult = await buildDefaultAnthropicPayload(thinkingLastPayload);
    const thinkingControls = collectAllCacheControls(thinkingResult);
    expect(thinkingControls).toEqual([
      { location: 'system', value: { ttl: '1h', type: 'ephemeral' } },
      { location: 'tools', value: { ttl: '1h', type: 'ephemeral' } },
    ]);
    expect(resolveDefaultAnthropicPricingOptions(thinkingLastPayload, thinkingResult)).toEqual({
      lookupParams: { ttl: '1h' },
    });
  });
});
