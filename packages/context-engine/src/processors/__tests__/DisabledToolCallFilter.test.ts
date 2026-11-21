import { describe, expect, it } from 'vitest';

import { ToolNameResolver } from '../../engine/tools/ToolNameResolver';
import type { Message, PipelineContext } from '../../types';
import { DisabledToolCallFilter } from '../DisabledToolCallFilter';

const createContext = (messages: Message[]): PipelineContext => ({
  initialState: { messages: [] },
  isAborted: false,
  messages,
  metadata: {},
});

describe('DisabledToolCallFilter', () => {
  const resolver = new ToolNameResolver();

  it('should return context untouched when disabledToolIdentifiers is empty or undefined', async () => {
    const context = createContext([
      {
        content: '',
        id: 'a1',
        role: 'assistant',
        tool_calls: [
          {
            function: { arguments: '{}', name: 'arckep-studio____createImage____builtin' },
            id: 'call_1',
            type: 'function',
          },
        ],
      },
    ]);

    const filterEmpty = new DisabledToolCallFilter({ disabledToolIdentifiers: [] });
    const res1 = await filterEmpty.process(context);
    expect(res1.messages).toHaveLength(1);
    expect(res1.metadata.disabledToolCallFilter).toBeUndefined();

    const filterUndefined = new DisabledToolCallFilter({});
    const res2 = await filterUndefined.process(context);
    expect(res2.messages).toHaveLength(1);
  });

  it('should strip disabled tool_calls and tools while keeping enabled ones on the same message', async () => {
    const filter = new DisabledToolCallFilter({
      disabledToolIdentifiers: ['arckep-studio', 'lobe-cron'],
    });

    const context = createContext([
      {
        content: '',
        id: 'a-mixed',
        role: 'assistant',
        tool_calls: [
          {
            function: { arguments: '{}', name: 'arckep-studio____createImage____builtin' },
            id: 'call_disabled',
            type: 'function',
          },
          {
            function: { arguments: '{}', name: 'lobe-web-browsing____search____builtin' },
            id: 'call_enabled',
            type: 'function',
          },
        ],
        tools: [
          {
            apiName: 'createImage',
            arguments: '{}',
            id: 'call_disabled',
            identifier: 'arckep-studio',
          },
          {
            apiName: 'search',
            arguments: '{}',
            id: 'call_enabled',
            identifier: 'lobe-web-browsing',
          },
        ],
      },
    ]);

    const result = await filter.process(context);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].tool_calls).toEqual([
      {
        function: { arguments: '{}', name: 'lobe-web-browsing____search____builtin' },
        id: 'call_enabled',
        type: 'function',
      },
    ]);
    expect(result.messages[0].tools).toEqual([
      {
        apiName: 'search',
        arguments: '{}',
        id: 'call_enabled',
        identifier: 'lobe-web-browsing',
      },
    ]);
    expect(result.metadata.disabledToolCallFilter).toEqual({
      filteredAssistantMessages: 1,
      filteredToolCalls: 1,
    });
  });

  it('should drop the entire assistant message when removing disabled tool calls leaves it completely empty', async () => {
    const filter = new DisabledToolCallFilter({
      disabledToolIdentifiers: ['arckep-studio'],
    });

    const context = createContext([
      { content: 'Draw a cat', id: 'u1', role: 'user' },
      {
        content: '',
        id: 'a-emptied',
        role: 'assistant',
        tool_calls: [
          {
            function: { arguments: '{}', name: 'arckep-studio____createImage____builtin' },
            id: 'call_1',
            type: 'function',
          },
        ],
        tools: [
          {
            apiName: 'createImage',
            arguments: '{}',
            id: 'call_1',
            identifier: 'arckep-studio',
          },
        ],
      },
      { content: 'Next user prompt', id: 'u2', role: 'user' },
    ]);

    const result = await filter.process(context);

    expect(result.messages.map((m) => m.id)).toEqual(['u1', 'u2']);
    expect(result.metadata.disabledToolCallFilter).toEqual({
      filteredAssistantMessages: 1,
      filteredToolCalls: 1,
    });
  });

  it('should preserve the assistant message (without tool_calls/tools) if it still has text, reasoning, or media', async () => {
    const filter = new DisabledToolCallFilter({
      disabledToolIdentifiers: ['arckep-studio'],
    });

    const context = createContext([
      {
        content: 'Let me generate that image for you:',
        id: 'a-with-text',
        role: 'assistant',
        tool_calls: [
          {
            function: { arguments: '{}', name: 'arckep-studio____createImage____builtin' },
            id: 'call_1',
            type: 'function',
          },
        ],
        tools: [
          { apiName: 'createImage', arguments: '{}', id: 'call_1', identifier: 'arckep-studio' },
        ],
      },
      {
        content: '',
        id: 'a-with-reasoning',
        reasoning: { content: 'Planning image generation' },
        role: 'assistant',
        tool_calls: [
          {
            function: { arguments: '{}', name: 'arckep-studio____createImage____builtin' },
            id: 'call_2',
            type: 'function',
          },
        ],
      },
      {
        content: '',
        id: 'a-with-image',
        imageList: [{ id: 'img-1', url: 'https://example.com/preview.png' }],
        role: 'assistant',
        tool_calls: [
          {
            function: { arguments: '{}', name: 'arckep-studio____createImage____builtin' },
            id: 'call_3',
            type: 'function',
          },
        ],
      },
    ]);

    const result = await filter.process(context);

    expect(result.messages.map((m) => m.id)).toEqual([
      'a-with-text',
      'a-with-reasoning',
      'a-with-image',
    ]);
    for (const msg of result.messages) {
      expect(msg.tool_calls).toBeUndefined();
      expect(msg.tools).toBeUndefined();
    }
    expect(result.metadata.disabledToolCallFilter).toEqual({
      filteredAssistantMessages: 3,
      filteredToolCalls: 3,
    });
  });

  it('should filter MD5-hashed long disabled identifiers and toolCall.id linked to disabled tools', async () => {
    const longDisabledId = 'very-long-disabled-mcp-plugin-identifier-that-overflows-limit';
    const hashedWireName = resolver.generate(longDisabledId, 'executeLongAction', 'mcp');
    expect(hashedWireName.startsWith('MD5HASH_')).toBe(true);

    const filter = new DisabledToolCallFilter({
      disabledToolIdentifiers: [longDisabledId, 'hidden-tool'],
    });

    const context = createContext([
      {
        content: 'Hashed call text',
        id: 'a-hashed',
        role: 'assistant',
        tool_calls: [
          {
            function: { arguments: '{}', name: hashedWireName },
            id: 'call_hashed',
            type: 'function',
          },
        ],
      },
      {
        content: 'Linked by id text',
        id: 'a-linked-id',
        role: 'assistant',
        tool_calls: [
          {
            function: { arguments: '{}', name: 'custom_alias_without_prefix' },
            id: 'call_linked',
            type: 'function',
          },
        ],
        tools: [
          {
            apiName: 'run',
            arguments: '{}',
            id: 'call_linked',
            identifier: 'hidden-tool',
          },
        ],
      },
    ]);

    const result = await filter.process(context);

    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].tool_calls).toBeUndefined();
    expect(result.messages[1].tool_calls).toBeUndefined();
    expect(result.messages[1].tools).toBeUndefined();
    expect(result.metadata.disabledToolCallFilter).toEqual({
      filteredAssistantMessages: 2,
      filteredToolCalls: 2,
    });
  });
});
