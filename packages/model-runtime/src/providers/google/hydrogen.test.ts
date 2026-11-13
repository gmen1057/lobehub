// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LobeGoogleAI } from './index';
import { resolveGoogleThinkingConfig } from './thinkingResolver';

afterEach(() => vi.restoreAllMocks());

describe('Gemini 4 Hydrogen native Google contract', () => {
  it.each(['low', 'medium', 'high', 'xhigh'] as const)(
    'preserves %s without a numeric budget',
    (thinkingLevel) => {
      expect(
        resolveGoogleThinkingConfig('gemini-4-hydrogen', { thinkingLevel, thinkingBudget: 0 }),
      ).toEqual({
        includeThoughts: true,
        thinkingBudget: undefined,
        thinkingLevel,
      });
    },
  );

  it('defaults to high and never disables thinking via a stale budget', () => {
    expect(resolveGoogleThinkingConfig('gemini-4-hydrogen')).toEqual({
      includeThoughts: true,
      thinkingBudget: undefined,
      thinkingLevel: 'high',
    });
    expect(
      resolveGoogleThinkingConfig('gemini-4-hydrogen', { thinkingBudget: 0 }).thinkingLevel,
    ).toBe('high');
    expect(() =>
      resolveGoogleThinkingConfig('gemini-4-hydrogen', { thinkingLevel: 'minimal' }),
    ).toThrow(/thinkingLevel/);
  });

  it('serializes xhigh through the real SDK with search, functions, signatures and media', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(
          'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"OK"}]},"finishReason":"STOP"}]}\n\n',
          { headers: { 'Content-Type': 'text/event-stream' } },
        ),
      );
    const runtime = new LobeGoogleAI({
      apiKey: 'test-only',
      baseURL: 'https://google-test.invalid',
    });
    const response = await runtime.chat({
      model: 'gemini-4-hydrogen',
      max_tokens: 65_536,
      thinkingLevel: 'xhigh',
      enabledSearch: true,
      urlContext: true,
      messages: [
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,YQ==' } }],
        },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              thoughtSignature: 'provider-signature',
              function: { name: 'inspect', arguments: '{}' },
            },
          ],
        },
        { role: 'tool', content: 'done', tool_call_id: 'call-1' },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'inspect',
            description: 'Inspect input',
            parameters: { type: 'object', properties: {} },
          },
        },
      ],
    });
    await response.text();
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [input, init] = fetchSpy.mock.calls[0];
    const request = new Request(input, init);
    expect(request.url).toContain('gemini-4-hydrogen:streamGenerateContent');
    const body = await request.json();
    expect(body.generationConfig.thinkingConfig).toMatchObject({
      includeThoughts: true,
      thinkingLevel: 'xhigh',
    });
    expect(body.generationConfig.thinkingConfig.thinkingBudget).toBeUndefined();
    expect(body.generationConfig.maxOutputTokens).toBe(65_536);
    expect(body.generationConfig.responseModalities).toBeUndefined();
    expect(body.toolConfig).toEqual({ includeServerSideToolInvocations: true });
    expect(body.tools).toEqual(
      expect.arrayContaining([
        { googleSearch: {} },
        { urlContext: {} },
        expect.objectContaining({
          functionDeclarations: expect.arrayContaining([
            expect.objectContaining({ name: 'inspect' }),
          ]),
        }),
      ]),
    );
    expect(body.contents[0].parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ inlineData: { data: 'YQ==', mimeType: 'image/png' } }),
      ]),
    );
    expect(body.contents[1].parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          thoughtSignature: 'provider-signature',
          functionCall: { name: 'inspect', args: {} },
        }),
      ]),
    );
  });
});
