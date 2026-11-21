// @vitest-environment node
import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';

import type { ChatStreamPayload } from '../../types';
import {
  estimateAnthropicInputTokens,
  IMAGE_TOKEN_ESTIMATE,
  LONG_CONTEXT_CACHE_TTL_THRESHOLD_TOKENS,
  MEDIA_TOKEN_ESTIMATE,
  resolveCacheTTL,
  selectAnthropicCacheTTL,
} from './resolveCacheTTL';

describe('estimateAnthropicInputTokens', () => {
  it('estimates English/ASCII text at ~4 chars per token', () => {
    const tokens = estimateAnthropicInputTokens({
      messages: [{ content: 'a'.repeat(40_000), role: 'user' }],
    });

    // 40_000 / 4 = 10_000 + 4 message overhead
    expect(tokens).toBe(10_004);
  });

  it('estimates Cyrillic text at ~2 chars per token', () => {
    const tokens = estimateAnthropicInputTokens({
      messages: [{ content: 'б'.repeat(60_000), role: 'user' }],
    });

    // 60_000 * 2 / 4 = 30_000 + 4 message overhead
    expect(tokens).toBe(30_004);
  });

  it('estimates CJK text at ~1 char per token', () => {
    const tokens = estimateAnthropicInputTokens({
      messages: [{ content: '汉'.repeat(30_000), role: 'user' }],
    });

    expect(tokens).toBe(30_004);
  });

  it('counts system prompt, messages, tool_calls, and tools schemas together', () => {
    const tokens = estimateAnthropicInputTokens({
      messages: [
        { content: 's'.repeat(40_000), role: 'system' },
        { content: 'u'.repeat(40_000), role: 'user' },
        {
          content: '',
          role: 'assistant',
          tool_calls: [
            {
              function: { arguments: 'x'.repeat(20_000), name: 'readKnowledge' },
              id: 'call_1',
              type: 'function',
            },
          ],
        },
      ],
      tools: [
        {
          function: {
            description: 'd'.repeat(24_000),
            name: 'readKnowledge',
            parameters: {
              properties: { query: { description: 'q'.repeat(4_000), type: 'string' } },
              type: 'object',
            },
          },
          type: 'function',
        },
      ],
    });

    // 10K (system) + 10K (user) + 5K (tool_call args) + ~7K (tool schema) > 30K
    expect(tokens).toBeGreaterThanOrEqual(LONG_CONTEXT_CACHE_TTL_THRESHOLD_TOKENS);
  });

  it('does not count raw base64 bytes for image_url parts', () => {
    const twoMbBase64 = 'A'.repeat(2_000_000);
    const tokens = estimateAnthropicInputTokens({
      messages: [
        {
          content: [
            { text: 'Describe this screenshot', type: 'text' },
            {
              image_url: { url: `data:image/png;base64,${twoMbBase64}` },
              type: 'image_url',
            },
          ],
          role: 'user',
        },
      ],
    });

    expect(tokens).toBeLessThan(2_000);
    expect(tokens).toBeGreaterThanOrEqual(IMAGE_TOKEN_ESTIMATE);
  });

  it('does not count raw base64 bytes for Anthropic image, PDF document, or tool_result media blocks', () => {
    const twoMbBase64 = 'B'.repeat(2_000_000);
    const tokens = estimateAnthropicInputTokens({
      messages: [
        {
          content: [
            {
              source: { data: twoMbBase64, media_type: 'image/jpeg', type: 'base64' },
              type: 'image',
            } as any,
            {
              source: { data: twoMbBase64, media_type: 'application/pdf', type: 'base64' },
              type: 'document',
            } as any,
            {
              content: [
                { text: 'Screenshot attached', type: 'text' },
                {
                  image_url: { url: `data:image/webp;base64,${twoMbBase64}` },
                  type: 'image_url',
                },
              ],
              tool_use_id: 'toolu_1',
              type: 'tool_result',
            } as any,
          ],
          role: 'user',
        },
      ],
    });

    // 2 images + 1 PDF document ≈ 4_800 tokens, nowhere near 30K
    expect(tokens).toBeLessThan(6_000);
    expect(tokens).toBeGreaterThanOrEqual(IMAGE_TOKEN_ESTIMATE * 2 + MEDIA_TOKEN_ESTIMATE);
  });

  it('counts plain-text Anthropic document sources as real text', () => {
    const tokens = estimateAnthropicInputTokens({
      messages: [
        {
          content: [
            {
              source: { data: 'w'.repeat(120_000), media_type: 'text/plain', type: 'text' },
              type: 'document',
            } as any,
          ],
          role: 'user',
        },
      ],
    });

    expect(tokens).toBeGreaterThanOrEqual(LONG_CONTEXT_CACHE_TTL_THRESHOLD_TOKENS);
  });

  it('neutralizes inline base64 data URIs inside plain text strings and skips thinking signatures', () => {
    const twoMbBase64 = 'C'.repeat(2_000_000);
    const tokens = estimateAnthropicInputTokens({
      messages: [
        {
          content: `{"img":"data:image/png;base64,${twoMbBase64}"}`,
          role: 'tool',
          tool_call_id: 'call_img',
        },
        {
          content: [
            { signature: 'S'.repeat(200_000), thinking: 'Short reasoning', type: 'thinking' },
            { data: 'R'.repeat(200_000), type: 'redacted_thinking' } as any,
          ],
          role: 'assistant',
        },
      ],
    });

    expect(tokens).toBeLessThan(2_500);
  });

  it('handles 8MB inline base64 data URIs and MIME parameters (;charset=utf-8;base64,) without stack overflow', () => {
    const eightMbBase64 = 'A'.repeat(8_000_000);
    const svgWithParamsBase64 = 'D'.repeat(2_000_000);

    const largePayload = {
      messages: [
        {
          content: `{"img":"data:image/png;base64,${eightMbBase64}"}`,
          role: 'tool' as const,
          tool_call_id: 'call_large_img',
        },
        {
          content: `Inline SVG: data:image/svg+xml;charset=utf-8;base64,${svgWithParamsBase64} done.`,
          role: 'user' as const,
        },
      ],
    };

    const tokens = estimateAnthropicInputTokens(largePayload);
    expect(tokens).toBeLessThan(4_000);
    expect(tokens).toBeGreaterThanOrEqual(IMAGE_TOKEN_ESTIMATE * 2);
    expect(selectAnthropicCacheTTL(largePayload)).toBe('5m');
  });

  it('handles cyclic objects in tool schemas safely without throwing', () => {
    const cyclicSchema: Record<string, unknown> = { type: 'object' };
    cyclicSchema.self = cyclicSchema;

    const tokens = estimateAnthropicInputTokens({
      messages: [{ content: 'Hello', role: 'user' }],
      tools: [
        {
          function: {
            description: 'Cyclic tool',
            name: 'cyclic',
            parameters: cyclicSchema,
          },
          type: 'function',
        },
      ],
    });

    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(100);
  });
});

describe('selectAnthropicCacheTTL', () => {
  it('returns "5m" below the 30K threshold and "1h" at or above 30K', () => {
    // 4 tokens overhead + 119_980 / 4 = 29_999 tokens -> '5m'
    expect(
      selectAnthropicCacheTTL({
        messages: [{ content: 'a'.repeat(119_980), role: 'user' }],
      }),
    ).toBe('5m');

    // 4 tokens overhead + 119_984 / 4 = 30_000 tokens -> '1h'
    expect(
      selectAnthropicCacheTTL({
        messages: [{ content: 'a'.repeat(119_984), role: 'user' }],
      }),
    ).toBe('1h');
  });

  it('stays on "5m" for a short chat with a large base64 image', () => {
    const twoMbBase64 = 'A'.repeat(2_000_000);
    expect(
      selectAnthropicCacheTTL({
        messages: [
          {
            content: [
              { text: 'What is in this photo?', type: 'text' },
              { image_url: { url: `data:image/png;base64,${twoMbBase64}` }, type: 'image_url' },
            ],
            role: 'user',
          },
        ],
      }),
    ).toBe('5m');
  });

  it('returns undefined when enabledContextCaching is false, even at >= 30K or with explicit cacheTTL', () => {
    expect(
      selectAnthropicCacheTTL({
        cacheTTL: '1h',
        enabledContextCaching: false,
        messages: [{ content: 'a'.repeat(400_000), role: 'user' }],
      }),
    ).toBeUndefined();
  });

  it('preserves explicit cacheTTL overrides in both directions', () => {
    expect(
      selectAnthropicCacheTTL({
        cacheTTL: '1h',
        messages: [{ content: 'Hi', role: 'user' }],
      }),
    ).toBe('1h');

    expect(
      selectAnthropicCacheTTL({
        cacheTTL: '5m',
        messages: [{ content: 'a'.repeat(200_000), role: 'user' }],
      }),
    ).toBe('5m');
  });
});

describe('resolveCacheTTL', () => {
  const baseRequest: ChatStreamPayload = {
    messages: [{ content: 'Hello', role: 'user' }],
    model: 'claude-sonnet-5-5',
  };

  it('resolves "1h" from system, tools, or messages breakpoints', () => {
    expect(
      resolveCacheTTL(baseRequest, {
        messages: [{ content: 'Hello', role: 'user' }],
        system: [{ cache_control: { ttl: '1h', type: 'ephemeral' }, text: 'Sys', type: 'text' }],
      }),
    ).toBe('1h');

    expect(
      resolveCacheTTL(baseRequest, {
        messages: [{ content: 'Hello', role: 'user' }],
        system: undefined,
        tools: [
          {
            cache_control: { ttl: '1h', type: 'ephemeral' },
            input_schema: { type: 'object' },
            name: 'search',
          } satisfies Anthropic.Tool,
        ],
      }),
    ).toBe('1h');

    expect(
      resolveCacheTTL(baseRequest, {
        messages: [
          {
            content: [
              { cache_control: { ttl: '1h', type: 'ephemeral' }, text: 'Hi', type: 'text' },
            ],
            role: 'user',
          },
        ],
        system: undefined,
      }),
    ).toBe('1h');
  });

  it('resolves default "5m" when ephemeral cache_control has no explicit ttl', () => {
    expect(
      resolveCacheTTL(baseRequest, {
        messages: [
          {
            content: [{ cache_control: { type: 'ephemeral' }, text: 'Hi', type: 'text' }],
            role: 'user',
          },
        ],
        system: undefined,
      }),
    ).toBe('5m');
  });

  it('returns undefined when caching is disabled and no breakpoints exist', () => {
    expect(
      resolveCacheTTL(
        { ...baseRequest, enabledContextCaching: false },
        {
          messages: [{ content: 'Hello', role: 'user' }],
          system: [{ text: 'Sys', type: 'text' }],
        },
      ),
    ).toBeUndefined();
  });
});
