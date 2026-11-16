// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { LobeOpenAICompatibleRuntime } from '../../core/BaseAI';
import type { ChatStreamPayload } from '../../types';
import { LobeQwenAI } from './index';

let instance: LobeOpenAICompatibleRuntime;
const payload = { messages: [{ content: 'Hello', role: 'user' }], model: 'qwen4-max' } as const;

beforeEach(() => {
  instance = new LobeQwenAI({ apiKey: 'test' });
  vi.spyOn(instance['client'].chat.completions, 'create').mockResolvedValue(
    new ReadableStream() as any,
  );
});

const send = async (extra: Partial<ChatStreamPayload> & Record<string, unknown> = {}) => {
  await instance.chat({ ...payload, ...extra } as ChatStreamPayload);
  return vi.mocked(instance['client'].chat.completions.create).mock.calls[0][0] as any;
};

describe('Qwen4 native request', () => {
  it('keeps provider default effort and thought preservation without a legacy budget', async () => {
    const body = await send();
    expect(body).toMatchObject({ enable_thinking: true, preserve_thinking: true });
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.thinking_budget).toBeUndefined();
    expect(body.thinking).toBeUndefined();
  });

  it.each(['low', 'high', 'xhigh'] as const)(
    'sends actual %s effort with thinking enabled',
    async (effort) => {
      const body = await send({ reasoning_effort: effort });
      expect(body).toMatchObject({ enable_thinking: true, reasoning_effort: effort });
    },
  );

  it.each([
    ['minimal', 'low'],
    ['medium', 'high'],
    ['max', 'xhigh'],
  ] as const)('maps provider alias %s to %s', async (input, expected) => {
    expect((await send({ reasoning_effort: input })).reasoning_effort).toBe(expected);
  });

  it.each([
    { reasoning_effort: 'none' },
    { thinking: { type: 'disabled', budget_tokens: 0 } },
    { enable_thinking: false, reasoning_effort: 'xhigh' },
  ])('turns off thinking without conflicting effort/budget: %j', async (extra) => {
    const body = await send({ ...extra, thinking_budget: 131_072, max_tokens: 262_144 });
    expect(body.enable_thinking).toBe(false);
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.thinking_budget).toBeUndefined();
    expect(body.max_tokens).toBe(131_072);
  });

  it('keeps combined output limit and native explicit preservation/budget settings', async () => {
    const body = await send({
      max_tokens: 300_000,
      max_completion_tokens: 300_000,
      preserve_thinking: false,
      thinking_budget: 131_072,
    });
    expect(body).toMatchObject({
      max_tokens: 262_144,
      max_completion_tokens: 262_144,
      preserve_thinking: false,
      thinking_budget: 131_072,
    });
  });

  it('replays stored thoughts and function calls across tool and later user turns', async () => {
    const call = { id: 'call-1', type: 'function', function: { name: 'search', arguments: '{}' } };
    const body = await send({
      messages: [
        { role: 'user', content: 'Find it' },
        {
          role: 'assistant',
          content: '',
          reasoning: { content: 'Need a search' },
          tool_calls: [call],
        },
        { role: 'tool', content: 'Found', tool_call_id: 'call-1' },
        {
          role: 'assistant',
          content: 'Result',
          reasoning_content: 'Stored native thought',
          reasoning: { content: 'Fallback' },
        },
        { role: 'user', content: 'Continue' },
      ] as any,
    });
    expect(body.messages[1]).toMatchObject({
      reasoning_content: 'Need a search',
      tool_calls: [call],
    });
    expect(body.messages[2]).toEqual({ role: 'tool', content: 'Found', tool_call_id: 'call-1' });
    expect(body.messages[3]).toMatchObject({
      content: 'Result',
      reasoning_content: 'Stored native thought',
    });
    expect(body.messages[1].reasoning).toBeUndefined();
    expect(body.messages[3].reasoning).toBeUndefined();
    expect(body.messages[4]).toEqual({ role: 'user', content: 'Continue' });
  });

  it('keeps Qwen3 budget mapping unchanged', async () => {
    const body = await send({
      model: 'qwen3.8-max',
      thinking: { type: 'enabled', budget_tokens: 4096 },
    });
    expect(body).toMatchObject({ enable_thinking: true, thinking_budget: 4096 });
    expect(body.preserve_thinking).toBeUndefined();
  });
});
