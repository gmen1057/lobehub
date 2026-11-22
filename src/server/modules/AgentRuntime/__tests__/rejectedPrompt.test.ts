import { calculatePromptTokens } from '@lobechat/agent-runtime';
import { LOADING_FLAT } from '@lobechat/const';
import type { ChatStreamPayload } from '@lobechat/model-runtime';
import type { UIChatMessage } from '@lobechat/types';
import { describe, expect, it } from 'vitest';

import { serverMessagesEngine } from '@/server/modules/Mecha/ContextEngineering';

import { classifyLLMError } from '../llmErrorClassification';
import { fitRejectedPrompt } from '../rejectedPrompt';

describe('measured input refusal', () => {
  const refused = {
    hasOutput: false,
    hasUsage: false,
    reason: 'upstream_error',
    retryOwner: 'engine',
    retrySafe: false,
  };
  const error = {
    details: [refused],
    message: 'user input too long, 34968 tokens exceeds max 32768 tokens',
    status: 413,
  };
  it.each([
    ['prompt is too long: 205000 tokens > 200000 maximum', 205000, 200000],
    ['prompt is too long: 205000 > 200000 maximum', 205000, 200000],
    [
      'The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).',
      1200000,
      1048576,
    ],
  ])('reads %s through a provider wrapper', (message, inputTokens, maxTokens) => {
    expect(classifyLLMError({ body: { error: { ...error, message } } }).rejectedInput).toEqual({
      inputTokens,
      maxTokens,
    });
  });
  it.each([
    { ...error, status: 429 },
    { ...error, details: [] },
    { ...error, details: [{ ...refused, hasUsage: true }] },
    { ...error, details: [refused, { hasOutput: true }] },
    { ...error, message: 'Payload too large' },
    { ...error, message: 'max_tokens exceeds max 512' },
    { ...error, details: [{ ...refused, retryOwner: 'proxy' }] },
  ])('requires a measured input refusal before the proxy observed any work', (value) => {
    expect(classifyLLMError(value).rejectedInput).toBeUndefined();
  });
});

describe('reduce the rejected wire prompt', () => {
  const task = { role: 'user' as const, content: 'Check the most recent changes.' };
  const system = { role: 'system' as const, content: 'Respect workspace scope.' };
  const tool = {
    type: 'function' as const,
    function: { name: 'readFilePage', parameters: { type: 'object', properties: {} } },
  };
  const calls = Array.from({ length: 9 }, (_, i) => ({
    id: 'read-' + i,
    type: 'function' as const,
    function: { name: 'readFilePage', arguments: JSON.stringify({ page: i }) },
  }));
  const results = calls.map((call) => ({
    role: 'tool' as const,
    tool_call_id: call.id,
    content: 'source record; '.repeat(1300),
  }));
  it('fits a large current batch even when there is no previous turn to remove', () => {
    const assistant = { role: 'assistant' as const, content: '', tool_calls: calls };
    const messages = [system, task, assistant, ...results];
    const inputTokens = calculatePromptTokens(messages, [tool]);
    const maxTokens = Math.floor(inputTokens * 0.45);
    const reduced = fitRejectedPrompt({ messages, tools: [tool] }, messages, [], {
      inputTokens,
      maxTokens,
    })!;
    expect(reduced.slice(0, 3)).toEqual([system, task, assistant]);
    expect(reduced.filter((m) => m.role === 'tool').map((m) => m.tool_call_id)).toEqual(
      calls.map((call) => call.id),
    );
    expect(calculatePromptTokens(reduced, [tool])).toBeLessThanOrEqual(maxTokens);
    expect(JSON.stringify(reduced)).toContain('Completed tool result shortened');
    expect(results.every((m) => m.content.length === 19_500)).toBe(true);
  });
  it('preserves injected instructions and the current user with a synthetic follow-up image', () => {
    const userContext = { role: 'user' as const, content: 'Injected instructions' };
    const image = {
      role: 'user' as const,
      content: [
        { type: 'image_url' as const, image_url: { url: 'https://example.test/result.png' } },
      ],
    };
    const old = { role: 'user' as const, content: 'old request '.repeat(2500) };
    const assistant = { role: 'assistant' as const, content: '', tool_calls: [calls[0]] };
    const oldResult = { ...results[0], content: 'previous result' };
    const current = { ...results[1], content: 'current result' };
    const currentCall = { ...assistant, tool_calls: [calls[1]] };
    const messages: ChatStreamPayload['messages'] = [
      system,
      old,
      userContext,
      assistant,
      oldResult,
      task,
      currentCall,
      current,
      image,
    ];
    const source = [
      { ...old, id: 'old' },
      { ...assistant, id: 'a' },
      { ...oldResult, id: 'r' },
      { ...task, id: 'task' },
      { ...currentCall, id: 'b' },
      { ...current, id: 's' },
    ];
    const reduced = fitRejectedPrompt(
      { messages, tools: [tool] },
      source,
      [undefined, 'old', 'injection', 'a', 'r', 'task', 'b', 's', undefined],
      { inputTokens: 10000, maxTokens: 5000 },
    );
    expect(reduced).toEqual([system, userContext, task, currentCall, current, image]);
  });
  it('can trim archived summaries of an older operation whose current question has no stored ID', () => {
    const source = [{ id: 'archive', role: 'compressedGroup' }, task];
    const archive = {
      role: 'user' as const,
      content:
        '<compressed_history_summary>' +
        'Previous details. '.repeat(1000) +
        '</compressed_history_summary><original_history>topic</original_history>',
    };
    const messages = [system, archive, task];
    const reduced = fitRejectedPrompt({ messages }, source, [undefined, 'archive', undefined], {
      inputTokens: 34968,
      maxTokens: 32768,
    });
    expect(reduced).toEqual([
      system,
      {
        role: 'user',
        content: '[Earlier summary omitted.]<original_history>topic</original_history>',
      },
      task,
    ]);
  });

  it('keeps the original error for an oversized mandatory task', () => {
    const messages = [system, task];
    expect(
      fitRejectedPrompt({ messages, tools: [tool] }, messages, [], {
        inputTokens: 10000,
        maxTokens: 5000,
      }),
    ).toBeUndefined();
  });

  it('aligns wireSourceIds after PlaceholderMessageFilter strips failed/empty assistant placeholders before MessageCleanupProcessor', async () => {
    const now = Date.now();
    const source: UIChatMessage[] = [
      {
        content: 'old heavy question '.repeat(1800),
        createdAt: now - 5000,
        id: 'old-user',
        role: 'user',
        updatedAt: now - 5000,
      } as UIChatMessage,
      {
        content: 'old heavy answer '.repeat(1800),
        createdAt: now - 4000,
        id: 'old-assistant',
        role: 'assistant',
        updatedAt: now - 4000,
      } as UIChatMessage,
      {
        content: LOADING_FLAT,
        createdAt: now - 3000,
        error: { message: 'upstream failed', type: 'ProviderBizError' as any },
        id: 'broken-1',
        role: 'assistant',
        updatedAt: now - 3000,
      } as UIChatMessage,
      {
        content: '',
        createdAt: now - 2000,
        id: 'broken-2',
        role: 'assistant',
        updatedAt: now - 2000,
      } as UIChatMessage,
      {
        content: 'Current concise question that must stay intact.',
        createdAt: now - 1000,
        id: 'latest-user',
        role: 'user',
        updatedAt: now - 1000,
      } as UIChatMessage,
    ];

    let wireSourceIds: (string | undefined)[] = [];
    const processedMessages = await serverMessagesEngine({
      messages: source,
      model: 'gpt-4',
      onSourceIds: (ids) => {
        wireSourceIds = ids;
      },
      provider: 'openai',
      systemRole: 'Respect workspace scope.',
    });

    // PlaceholderMessageFilter must drop broken-1 and broken-2 BEFORE MessageCleanupProcessor
    expect(processedMessages.length).toBe(wireSourceIds.length);
    expect(wireSourceIds).not.toContain('broken-1');
    expect(wireSourceIds).not.toContain('broken-2');
    expect(wireSourceIds).toEqual([
      expect.stringMatching(/^system-/),
      'old-user',
      'old-assistant',
      'latest-user',
    ]);

    const inputTokens = calculatePromptTokens(processedMessages as ChatStreamPayload['messages']);
    const maxTokens = Math.floor(inputTokens * 0.35);
    const reduced = fitRejectedPrompt(
      { messages: processedMessages as ChatStreamPayload['messages'] },
      source,
      wireSourceIds,
      { inputTokens, maxTokens },
    );

    expect(reduced).toBeDefined();
    expect(reduced).toHaveLength(2);
    expect(reduced![0]).toMatchObject({ role: 'system' });
    expect(reduced![1]).toEqual({
      content: 'Current concise question that must stay intact.',
      role: 'user',
    });
  });
});
