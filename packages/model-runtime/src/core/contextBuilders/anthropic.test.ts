import { imageUrlToBase64 } from '@lobechat/utils';
import type { OpenAI } from 'openai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { OpenAIChatMessage, UserMessageContentPart } from '../../types/chat';
import { parseDataUri } from '../../utils/uriParser';
import {
  ANTHROPIC_MAX_IMAGE_BASE64_CHARS,
  buildAnthropicBlock,
  buildAnthropicMessage,
  buildAnthropicMessages,
  buildAnthropicTools,
  clearAnthropicImageCacheForTest,
  MAX_CONCURRENT_IMAGE_LOADS,
} from './anthropic';

// Mock the parseDataUri function since it's an implementation detail
vi.mock('../../utils/uriParser');
vi.mock('@lobechat/utils', () => ({
  imageUrlToBase64: vi.fn(),
}));

describe('anthropicHelpers', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Set default mock implementation for parseDataUri
    vi.mocked(parseDataUri).mockReturnValue({
      mimeType: 'image/jpeg',
      base64: 'base64EncodedString',
      type: 'base64',
    });
  });

  describe('buildAnthropicBlock', () => {
    it('should return the content as is for text type', async () => {
      const content: UserMessageContentPart = { type: 'text', text: 'Hello!' };
      const result = await buildAnthropicBlock(content);
      expect(result).toEqual(content);
    });

    it('should transform an image URL into an Anthropic.ImageBlockParam', async () => {
      const content: UserMessageContentPart = {
        type: 'image_url',
        image_url: { url: 'data:image/jpeg;base64,base64EncodedString' },
      };
      const result = await buildAnthropicBlock(content);
      expect(parseDataUri).toHaveBeenCalledWith(content.image_url.url);
      expect(result).toEqual({
        source: {
          data: 'base64EncodedString',
          media_type: 'image/jpeg',
          type: 'base64',
        },
        type: 'image',
      });
    });

    it('should transform a regular image URL into an Anthropic.ImageBlockParam', async () => {
      vi.mocked(parseDataUri).mockReturnValueOnce({
        mimeType: 'image/png',
        base64: null,
        type: 'url',
      });
      vi.mocked(imageUrlToBase64).mockResolvedValueOnce({
        base64: 'convertedBase64String',
        mimeType: 'image/jpg',
      });

      const content = {
        type: 'image_url',
        image_url: { url: 'https://example.com/image.png' },
      } as const;

      const result = await buildAnthropicBlock(content);

      expect(parseDataUri).toHaveBeenCalledWith(content.image_url.url);
      expect(imageUrlToBase64).toHaveBeenCalledWith(content.image_url.url);
      expect(result).toEqual({
        source: {
          data: 'convertedBase64String',
          media_type: 'image/jpeg',
          type: 'base64',
        },
        type: 'image',
      });
    });

    it('should use default media_type for URL images when mimeType is not provided', async () => {
      vi.mocked(parseDataUri).mockReturnValueOnce({
        mimeType: null,
        base64: null,
        type: 'url',
      });
      vi.mocked(imageUrlToBase64).mockResolvedValueOnce({
        base64: 'convertedBase64String',
        mimeType: 'image/png',
      });

      const content = {
        type: 'image_url',
        image_url: { url: 'https://example.com/image' },
      } as const;

      const result = await buildAnthropicBlock(content);

      expect(result).toEqual({
        source: {
          data: 'convertedBase64String',
          media_type: 'image/png',
          type: 'base64',
        },
        type: 'image',
      });
    });

    it('should throw an error for invalid image URLs', async () => {
      vi.mocked(parseDataUri).mockReturnValueOnce({
        mimeType: null,
        base64: null,
        // @ts-ignore
        type: 'invalid',
      });

      const content = {
        type: 'image_url',
        image_url: { url: 'invalid-url' },
      } as const;

      await expect(buildAnthropicBlock(content)).rejects.toThrow('Invalid image URL: invalid-url');
    });

    it('should return undefined for unsupported SVG image (base64)', async () => {
      vi.mocked(parseDataUri).mockReturnValueOnce({
        mimeType: 'image/svg+xml',
        base64: 'PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjwvc3ZnPg==',
        type: 'base64',
      });

      const content = {
        type: 'image_url',
        image_url: {
          url: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjwvc3ZnPg==',
        },
      } as const;

      const result = await buildAnthropicBlock(content);
      expect(result).toBeUndefined();
    });

    it('should return undefined for unsupported SVG image (URL)', async () => {
      vi.mocked(parseDataUri).mockReturnValueOnce({
        mimeType: null,
        base64: null,
        type: 'url',
      });
      vi.mocked(imageUrlToBase64).mockResolvedValueOnce({
        base64: 'PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjwvc3ZnPg==',
        mimeType: 'image/svg+xml',
      });

      const content = {
        type: 'image_url',
        image_url: { url: 'https://example.com/image.svg' },
      } as const;

      const result = await buildAnthropicBlock(content);
      expect(result).toBeUndefined();
    });
  });

  describe('buildAnthropicMessage', () => {
    it('should correctly convert system message to assistant message', async () => {
      const message: OpenAIChatMessage = {
        content: [{ type: 'text', text: 'Hello!' }],
        role: 'system',
      };
      const result = await buildAnthropicMessage(message);
      expect(result).toEqual({ content: [{ type: 'text', text: 'Hello!' }], role: 'user' });
    });

    it('should correctly convert user message with string content', async () => {
      const message: OpenAIChatMessage = {
        content: 'Hello!',
        role: 'user',
      };
      const result = await buildAnthropicMessage(message);
      expect(result).toEqual({ content: 'Hello!', role: 'user' });
    });

    it('should return undefined for user message with empty string content', async () => {
      const message: OpenAIChatMessage = {
        content: '',
        role: 'user',
      };
      const result = await buildAnthropicMessage(message);
      expect(result).toBeUndefined();
    });

    it('should return undefined for user message with whitespace-only string content', async () => {
      const message: OpenAIChatMessage = {
        content: '   \n\t  ',
        role: 'user',
      };
      const result = await buildAnthropicMessage(message);
      expect(result).toBeUndefined();
    });

    it('should correctly convert user message with content parts', async () => {
      const message: OpenAIChatMessage = {
        content: [
          { type: 'text', text: 'Check out this image:' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,abc123' } },
        ],
        role: 'user',
      };
      const result = await buildAnthropicMessage(message);
      expect(result!.role).toBe('user');
      expect(result!.content).toHaveLength(2);
      expect((result!.content[1] as any).type).toBe('image');
    });

    it('should return undefined for user message when content parts are all filtered out', async () => {
      const message: OpenAIChatMessage = {
        content: [{ type: 'text', text: '' }],
        role: 'user',
      };
      const result = await buildAnthropicMessage(message);
      expect(result).toBeUndefined();
    });

    it('should correctly convert tool message', async () => {
      const message: OpenAIChatMessage = {
        content: 'Tool result content',
        role: 'tool',
        tool_call_id: 'tool123',
      };
      const result = await buildAnthropicMessage(message);
      expect(result!.role).toBe('user');
      expect(result!.content).toEqual([
        {
          content: 'Tool result content',
          tool_use_id: 'tool123',
          type: 'tool_result',
        },
      ]);
    });

    it('should correctly convert assistant message with tool calls', async () => {
      const message: OpenAIChatMessage = {
        content: 'Here is the result:',
        role: 'assistant',
        tool_calls: [
          {
            id: 'call1',
            type: 'function',
            function: {
              name: 'search',
              arguments: '{"query":"anthropic"}',
            },
          },
        ],
      };
      const result = await buildAnthropicMessage(message);
      expect(result!.role).toBe('assistant');
      expect(result!.content).toEqual([
        { text: 'Here is the result:', type: 'text' },
        {
          id: 'call1',
          input: { query: 'anthropic' },
          name: 'search',
          type: 'tool_use',
        },
      ]);
    });

    it('should correctly convert function message', async () => {
      const message: OpenAIChatMessage = {
        content: 'def hello(name):\n  return f"Hello {name}"',
        role: 'function',
      };
      const result = await buildAnthropicMessage(message);
      expect(result).toEqual({
        content: 'def hello(name):\n  return f"Hello {name}"',
        role: 'assistant',
      });
    });

    it('should correctly convert assistant message with array content but no tool_calls', async () => {
      const message: OpenAIChatMessage = {
        content: [
          { thinking: 'Let me think about this...', type: 'thinking', signature: 'sig123' },
          { type: 'text', text: 'Here is my response.' },
        ],
        role: 'assistant',
      };
      const result = await buildAnthropicMessage(message);
      expect(result).toEqual({
        content: [
          { thinking: 'Let me think about this...', type: 'thinking', signature: 'sig123' },
          { type: 'text', text: 'Here is my response.' },
        ],
        role: 'assistant',
      });
    });

    it('should return undefined for assistant message with empty array content', async () => {
      const message: OpenAIChatMessage = {
        content: [],
        role: 'assistant',
      };
      const result = await buildAnthropicMessage(message);
      expect(result).toBeUndefined();
    });

    it('should handle assistant message with tool_calls but null content', async () => {
      const message: OpenAIChatMessage = {
        content: null as any,
        role: 'assistant',
        tool_calls: [
          {
            id: 'call1',
            type: 'function',
            function: {
              name: 'search_people',
              arguments: '{"location":"Singapore"}',
            },
          },
        ],
      };
      const result = await buildAnthropicMessage(message);
      expect(result!.role).toBe('assistant');
      // null content should be filtered out, only tool_use remains
      expect(result!.content).toEqual([
        {
          id: 'call1',
          input: { location: 'Singapore' },
          name: 'search_people',
          type: 'tool_use',
        },
      ]);
    });

    it('should handle assistant message with tool_calls but empty string content', async () => {
      const message: OpenAIChatMessage = {
        content: '',
        role: 'assistant',
        tool_calls: [
          {
            id: 'call1',
            type: 'function',
            function: {
              name: 'search_people',
              arguments: '{"location":"Singapore"}',
            },
          },
        ],
      };
      const result = await buildAnthropicMessage(message);
      expect(result!.role).toBe('assistant');
      // empty string content should be filtered out, only tool_use remains
      expect(result!.content).toEqual([
        {
          id: 'call1',
          input: { location: 'Singapore' },
          name: 'search_people',
          type: 'tool_use',
        },
      ]);
    });
  });

  describe('buildAnthropicMessages', () => {
    it('should correctly convert OpenAI Messages to Anthropic Messages', async () => {
      const messages: OpenAIChatMessage[] = [
        { content: 'Hello', role: 'user' },
        { content: 'Hi', role: 'assistant' },
      ];

      const result = await buildAnthropicMessages(messages);
      expect(result).toHaveLength(2);
      expect(result).toEqual([
        { content: 'Hello', role: 'user' },
        { content: 'Hi', role: 'assistant' },
      ]);
    });

    it('messages should dont need end with user and should merge adjacent user messages', async () => {
      const messages: OpenAIChatMessage[] = [
        { content: 'Hello', role: 'user' },
        { content: 'Hello', role: 'user' },
        { content: 'Hi', role: 'assistant' },
      ];

      const contents = await buildAnthropicMessages(messages);

      expect(contents).toHaveLength(2);
      expect(contents).toEqual([
        {
          content: [
            { text: 'Hello', type: 'text' },
            { text: 'Hello', type: 'text' },
          ],
          role: 'user',
        },
        { content: 'Hi', role: 'assistant' },
      ]);
    });

    describe('Tool messages', () => {
      it('should handle empty tools', async () => {
        const messages: OpenAIChatMessage[] = [
          {
            content: '## Tools\n\nYou can use these tools',
            role: 'user',
          },
          {
            content: '',
            role: 'assistant',
            tool_calls: [],
          },
        ];

        const contents = await buildAnthropicMessages(messages);

        // Empty assistant messages should be filtered out
        expect(contents).toEqual([
          {
            content: '## Tools\n\nYou can use these tools',
            role: 'user',
          },
        ]);
      });

      it('should filter out assistant message with whitespace-only content', async () => {
        const messages: OpenAIChatMessage[] = [
          {
            content: 'Hello',
            role: 'user',
          },
          {
            content: '   \n\t  ',
            role: 'assistant',
          },
        ];

        const contents = await buildAnthropicMessages(messages);

        // Whitespace-only assistant messages should be filtered out
        expect(contents).toEqual([
          {
            content: 'Hello',
            role: 'user',
          },
        ]);
      });
      it('should correctly convert OpenAI tool message to Anthropic format', async () => {
        const messages: OpenAIChatMessage[] = [
          {
            content: '告诉我杭州和北京的天气，先回答我好的',
            role: 'user',
          },
          {
            content:
              '好的,我会为您查询杭州和北京的天气信息。我现在就开始查询这两个城市的当前天气情况。',
            role: 'assistant',
            tool_calls: [
              {
                function: {
                  arguments: '{"city": "\\u676d\\u5dde"}',
                  name: 'realtime-weather____fetchCurrentWeather',
                },
                id: 'toolu_018PNQkH8ChbjoJz4QBiFVod',
                type: 'function',
              },
              {
                function: {
                  arguments: '{"city": "\\u5317\\u4eac"}',
                  name: 'realtime-weather____fetchCurrentWeather',
                },
                id: 'toolu_018VQTQ6fwAEC3eppuEfMxPp',
                type: 'function',
              },
            ],
          },
          {
            content:
              '[{"city":"杭州市","adcode":"330100","province":"浙江","reporttime":"2024-06-24 17:02:14","casts":[{"date":"2024-06-24","week":"1","dayweather":"小雨","nightweather":"中雨","daytemp":"26","nighttemp":"20","daywind":"西","nightwind":"西","daypower":"1-3","nightpower":"1-3","daytemp_float":"26.0","nighttemp_float":"20.0"},{"date":"2024-06-25","week":"2","dayweather":"大雨","nightweather":"中雨","daytemp":"23","nighttemp":"19","daywind":"东","nightwind":"东","daypower":"1-3","nightpower":"1-3","daytemp_float":"23.0","nighttemp_float":"19.0"},{"date":"2024-06-26","week":"3","dayweather":"中雨","nightweather":"中雨","daytemp":"24","nighttemp":"21","daywind":"东南","nightwind":"东南","daypower":"1-3","nightpower":"1-3","daytemp_float":"24.0","nighttemp_float":"21.0"},{"date":"2024-06-27","week":"4","dayweather":"中雨-大雨","nightweather":"中雨","daytemp":"24","nighttemp":"22","daywind":"南","nightwind":"南","daypower":"1-3","nightpower":"1-3","daytemp_float":"24.0","nighttemp_float":"22.0"}]}]',
            name: 'realtime-weather____fetchCurrentWeather',
            role: 'tool',
            tool_call_id: 'toolu_018PNQkH8ChbjoJz4QBiFVod',
          },
          {
            content:
              '[{"city":"北京市","adcode":"110000","province":"北京","reporttime":"2024-06-24 17:03:11","casts":[{"date":"2024-06-24","week":"1","dayweather":"晴","nightweather":"晴","daytemp":"33","nighttemp":"20","daywind":"北","nightwind":"北","daypower":"1-3","nightpower":"1-3","daytemp_float":"33.0","nighttemp_float":"20.0"},{"date":"2024-06-25","week":"2","dayweather":"晴","nightweather":"晴","daytemp":"35","nighttemp":"21","daywind":"东南","nightwind":"东南","daypower":"1-3","nightpower":"1-3","daytemp_float":"35.0","nighttemp_float":"21.0"},{"date":"2024-06-26","week":"3","dayweather":"晴","nightweather":"晴","daytemp":"35","nighttemp":"23","daywind":"西南","nightwind":"西南","daypower":"1-3","nightpower":"1-3","daytemp_float":"35.0","nighttemp_float":"23.0"},{"date":"2024-06-27","week":"4","dayweather":"多云","nightweather":"多云","daytemp":"35","nighttemp":"23","daywind":"西南","nightwind":"西南","daypower":"1-3","nightpower":"1-3","daytemp_float":"35.0","nighttemp_float":"23.0"}]}]',
            name: 'realtime-weather____fetchCurrentWeather',
            role: 'tool',
            tool_call_id: 'toolu_018VQTQ6fwAEC3eppuEfMxPp',
          },
          {
            content: '继续',
            role: 'user',
          },
        ];

        const contents = await buildAnthropicMessages(messages);

        expect(contents).toEqual([
          { content: '告诉我杭州和北京的天气，先回答我好的', role: 'user' },
          {
            content: [
              {
                text: '好的,我会为您查询杭州和北京的天气信息。我现在就开始查询这两个城市的当前天气情况。',
                type: 'text',
              },
              {
                id: 'toolu_018PNQkH8ChbjoJz4QBiFVod',
                input: { city: '杭州' },
                name: 'realtime-weather____fetchCurrentWeather',
                type: 'tool_use',
              },
              {
                id: 'toolu_018VQTQ6fwAEC3eppuEfMxPp',
                input: { city: '北京' },
                name: 'realtime-weather____fetchCurrentWeather',
                type: 'tool_use',
              },
            ],
            role: 'assistant',
          },
          {
            content: [
              {
                content: [
                  {
                    text: '[{"city":"杭州市","adcode":"330100","province":"浙江","reporttime":"2024-06-24 17:02:14","casts":[{"date":"2024-06-24","week":"1","dayweather":"小雨","nightweather":"中雨","daytemp":"26","nighttemp":"20","daywind":"西","nightwind":"西","daypower":"1-3","nightpower":"1-3","daytemp_float":"26.0","nighttemp_float":"20.0"},{"date":"2024-06-25","week":"2","dayweather":"大雨","nightweather":"中雨","daytemp":"23","nighttemp":"19","daywind":"东","nightwind":"东","daypower":"1-3","nightpower":"1-3","daytemp_float":"23.0","nighttemp_float":"19.0"},{"date":"2024-06-26","week":"3","dayweather":"中雨","nightweather":"中雨","daytemp":"24","nighttemp":"21","daywind":"东南","nightwind":"东南","daypower":"1-3","nightpower":"1-3","daytemp_float":"24.0","nighttemp_float":"21.0"},{"date":"2024-06-27","week":"4","dayweather":"中雨-大雨","nightweather":"中雨","daytemp":"24","nighttemp":"22","daywind":"南","nightwind":"南","daypower":"1-3","nightpower":"1-3","daytemp_float":"24.0","nighttemp_float":"22.0"}]}]',
                    type: 'text',
                  },
                ],
                tool_use_id: 'toolu_018PNQkH8ChbjoJz4QBiFVod',
                type: 'tool_result',
              },
              {
                content: [
                  {
                    text: '[{"city":"北京市","adcode":"110000","province":"北京","reporttime":"2024-06-24 17:03:11","casts":[{"date":"2024-06-24","week":"1","dayweather":"晴","nightweather":"晴","daytemp":"33","nighttemp":"20","daywind":"北","nightwind":"北","daypower":"1-3","nightpower":"1-3","daytemp_float":"33.0","nighttemp_float":"20.0"},{"date":"2024-06-25","week":"2","dayweather":"晴","nightweather":"晴","daytemp":"35","nighttemp":"21","daywind":"东南","nightwind":"东南","daypower":"1-3","nightpower":"1-3","daytemp_float":"35.0","nighttemp_float":"21.0"},{"date":"2024-06-26","week":"3","dayweather":"晴","nightweather":"晴","daytemp":"35","nighttemp":"23","daywind":"西南","nightwind":"西南","daypower":"1-3","nightpower":"1-3","daytemp_float":"35.0","nighttemp_float":"23.0"},{"date":"2024-06-27","week":"4","dayweather":"多云","nightweather":"多云","daytemp":"35","nighttemp":"23","daywind":"西南","nightwind":"西南","daypower":"1-3","nightpower":"1-3","daytemp_float":"35.0","nighttemp_float":"23.0"}]}]',
                    type: 'text',
                  },
                ],
                tool_use_id: 'toolu_018VQTQ6fwAEC3eppuEfMxPp',
                type: 'tool_result',
              },
              {
                text: '继续',
                type: 'text',
              },
            ],
            role: 'user',
          },
        ]);
      });
      it('should handle user messages with tool correctly', async () => {
        const messages: OpenAIChatMessage[] = [
          {
            content: '搜索下 482的所有质因数？\n\n',
            role: 'user',
          },
          {
            content: '',
            role: 'assistant',
            tool_calls: [
              {
                function: {
                  arguments: '{"query": "482的质因数分解"}',
                  name: 'searchWithSearXNG',
                },
                id: 'toolu_01AgNoyb9FKuY8TGePPjEfrE',
                type: 'function',
              },
            ],
          },
          {
            content:
              '[{"content":"因式分解, 2 * 241 ; 因数, 1, 2, 241, 482 ; 因数个数, 4 ; 因数和, 726 ; 前一个整数, 481.","title":"该数性质482","url":"https://zh.numberempire.com/482"}]',
            name: 'searchWithSearXNG',
            role: 'tool',
            tool_call_id: 'toolu_01AgNoyb9FKuY8TGePPjEfrE',
          },
        ];

        const contents = await buildAnthropicMessages(messages);

        expect(contents).toEqual([
          { content: '搜索下 482的所有质因数？\n\n', role: 'user' },
          {
            content: [
              {
                id: 'toolu_01AgNoyb9FKuY8TGePPjEfrE',
                input: { query: '482的质因数分解' },
                name: 'searchWithSearXNG',
                type: 'tool_use',
              },
            ],
            role: 'assistant',
          },
          {
            content: [
              {
                content: [
                  {
                    text: '[{"content":"因式分解, 2 * 241 ; 因数, 1, 2, 241, 482 ; 因数个数, 4 ; 因数和, 726 ; 前一个整数, 481.","title":"该数性质482","url":"https://zh.numberempire.com/482"}]',
                    type: 'text',
                  },
                ],
                tool_use_id: 'toolu_01AgNoyb9FKuY8TGePPjEfrE',
                type: 'tool_result',
              },
            ],
            role: 'user',
          },
        ]);
      });

      it('should handle tool message with null content', async () => {
        const messages: OpenAIChatMessage[] = [
          {
            content: '搜索人员',
            role: 'user',
          },
          {
            content: '正在搜索...',
            role: 'assistant',
            tool_calls: [
              {
                function: {
                  arguments: '{"location": "Singapore"}',
                  name: 'search_people',
                },
                id: 'toolu_01CnXPcBEqsGGbvRriem3Rth',
                type: 'function',
              },
            ],
          },
          {
            content: null as any,
            name: 'search_people',
            role: 'tool',
            tool_call_id: 'toolu_01CnXPcBEqsGGbvRriem3Rth',
          },
        ];

        const contents = await buildAnthropicMessages(messages);

        expect(contents).toEqual([
          { content: '搜索人员', role: 'user' },
          {
            content: [
              { text: '正在搜索...', type: 'text' },
              {
                id: 'toolu_01CnXPcBEqsGGbvRriem3Rth',
                input: { location: 'Singapore' },
                name: 'search_people',
                type: 'tool_use',
              },
            ],
            role: 'assistant',
          },
          {
            content: [
              {
                content: [{ text: '<empty_content>', type: 'text' }],
                tool_use_id: 'toolu_01CnXPcBEqsGGbvRriem3Rth',
                type: 'tool_result',
              },
            ],
            role: 'user',
          },
        ]);
      });

      it('should handle tool message with empty string content', async () => {
        const messages: OpenAIChatMessage[] = [
          {
            content: '搜索人员',
            role: 'user',
          },
          {
            content: '正在搜索...',
            role: 'assistant',
            tool_calls: [
              {
                function: {
                  arguments: '{"location": "Singapore"}',
                  name: 'search_people',
                },
                id: 'toolu_01CnXPcBEqsGGbvRriem3Rth',
                type: 'function',
              },
            ],
          },
          {
            content: '',
            name: 'search_people',
            role: 'tool',
            tool_call_id: 'toolu_01CnXPcBEqsGGbvRriem3Rth',
          },
        ];

        const contents = await buildAnthropicMessages(messages);

        expect(contents).toEqual([
          { content: '搜索人员', role: 'user' },
          {
            content: [
              { text: '正在搜索...', type: 'text' },
              {
                id: 'toolu_01CnXPcBEqsGGbvRriem3Rth',
                input: { location: 'Singapore' },
                name: 'search_people',
                type: 'tool_use',
              },
            ],
            role: 'assistant',
          },
          {
            content: [
              {
                content: [{ text: '<empty_content>', type: 'text' }],
                tool_use_id: 'toolu_01CnXPcBEqsGGbvRriem3Rth',
                type: 'tool_result',
              },
            ],
            role: 'user',
          },
        ]);
      });

      it('should handle tool message with array content', async () => {
        const messages: OpenAIChatMessage[] = [
          {
            content: '搜索人员',
            role: 'user',
          },
          {
            content: '正在搜索...',
            role: 'assistant',
            tool_calls: [
              {
                function: {
                  arguments: '{"location": "Singapore"}',
                  name: 'search_people',
                },
                id: 'toolu_01CnXPcBEqsGGbvRriem3Rth',
                type: 'function',
              },
            ],
          },
          {
            content: [
              { type: 'text', text: 'Found 5 candidates' },
              { type: 'text', text: 'Result details here' },
            ] as any,
            name: 'search_people',
            role: 'tool',
            tool_call_id: 'toolu_01CnXPcBEqsGGbvRriem3Rth',
          },
        ];

        const contents = await buildAnthropicMessages(messages);

        expect(contents).toEqual([
          { content: '搜索人员', role: 'user' },
          {
            content: [
              { text: '正在搜索...', type: 'text' },
              {
                id: 'toolu_01CnXPcBEqsGGbvRriem3Rth',
                input: { location: 'Singapore' },
                name: 'search_people',
                type: 'tool_use',
              },
            ],
            role: 'assistant',
          },
          {
            content: [
              {
                content: [
                  { type: 'text', text: 'Found 5 candidates' },
                  { type: 'text', text: 'Result details here' },
                ],
                tool_use_id: 'toolu_01CnXPcBEqsGGbvRriem3Rth',
                type: 'tool_result',
              },
            ],
            role: 'user',
          },
        ]);
      });

      it('should handle tool message with array content containing image', async () => {
        vi.mocked(parseDataUri).mockReturnValueOnce({
          mimeType: 'image/png',
          base64: 'screenshotBase64Data',
          type: 'base64',
        });

        const messages: OpenAIChatMessage[] = [
          {
            content: '截图分析',
            role: 'user',
          },
          {
            content: '正在截图...',
            role: 'assistant',
            tool_calls: [
              {
                function: {
                  arguments: '{"url": "https://example.com"}',
                  name: 'screenshot',
                },
                id: 'toolu_screenshot_123',
                type: 'function',
              },
            ],
          },
          {
            content: [
              { type: 'text', text: 'Screenshot captured' },
              {
                type: 'image_url',
                image_url: { url: 'data:image/png;base64,screenshotBase64Data' },
              },
            ] as any,
            name: 'screenshot',
            role: 'tool',
            tool_call_id: 'toolu_screenshot_123',
          },
        ];

        const contents = await buildAnthropicMessages(messages);

        expect(contents).toEqual([
          { content: '截图分析', role: 'user' },
          {
            content: [
              { text: '正在截图...', type: 'text' },
              {
                id: 'toolu_screenshot_123',
                input: { url: 'https://example.com' },
                name: 'screenshot',
                type: 'tool_use',
              },
            ],
            role: 'assistant',
          },
          {
            content: [
              {
                content: [
                  { type: 'text', text: 'Screenshot captured' },
                  {
                    type: 'image',
                    source: {
                      type: 'base64',
                      media_type: 'image/png',
                      data: 'screenshotBase64Data',
                    },
                  },
                ],
                tool_use_id: 'toolu_screenshot_123',
                type: 'tool_result',
              },
            ],
            role: 'user',
          },
        ]);
      });

      it('should handle orphan tool message with null content', async () => {
        // Tool message without corresponding assistant tool_call
        const messages: OpenAIChatMessage[] = [
          {
            content: null as any,
            name: 'some_tool',
            role: 'tool',
            tool_call_id: 'orphan_tool_call_id',
          },
          {
            content: 'Continue',
            role: 'user',
          },
        ];

        const contents = await buildAnthropicMessages(messages);

        expect(contents).toEqual([
          {
            content: [
              { text: '<empty_content>', type: 'text' },
              { text: 'Continue', type: 'text' },
            ],
            role: 'user',
          },
        ]);
      });

      it('should handle orphan tool message with empty string content', async () => {
        // Tool message without corresponding assistant tool_call
        const messages: OpenAIChatMessage[] = [
          {
            content: '',
            name: 'some_tool',
            role: 'tool',
            tool_call_id: 'orphan_tool_call_id',
          },
          {
            content: 'Continue',
            role: 'user',
          },
        ];

        const contents = await buildAnthropicMessages(messages);

        expect(contents).toEqual([
          {
            content: [
              { text: '<empty_content>', type: 'text' },
              { text: 'Continue', type: 'text' },
            ],
            role: 'user',
          },
        ]);
      });

      it('should work well starting with tool message', async () => {
        const messages: OpenAIChatMessage[] = [
          {
            content:
              '[{"content":"因式分解, 2 * 241 ; 因数, 1, 2, 241, 482 ; 因数个数, 4 ; 因数和, 726 ; 前一个整数, 481.","title":"该数性质482","url":"https://zh.numberempire.com/482"}]',
            name: 'searchWithSearXNG',
            role: 'tool',
            tool_call_id: 'toolu_01AgNoyb9FKuY8TGePPjEfrE',
          },
          {
            content: '',
            role: 'assistant',
            tool_calls: [
              {
                function: {
                  arguments: '{"query": "杭州有啥好吃的"}',
                  name: 'searchWithSearXNG',
                },
                id: 'toolu_02AgNoyb9FKuY8TGePPjEfrE',
                type: 'function',
              },
            ],
          },
          {
            content: '[{"content":"没啥好吃的","title":"该数性质482","url":"e.com/482"}]',
            name: 'searchWithSearXNG',
            role: 'tool',
            tool_call_id: 'toolu_02AgNoyb9FKuY8TGePPjEfrE',
          },
        ];

        const contents = await buildAnthropicMessages(messages);

        expect(contents).toEqual([
          {
            content:
              '[{"content":"因式分解, 2 * 241 ; 因数, 1, 2, 241, 482 ; 因数个数, 4 ; 因数和, 726 ; 前一个整数, 481.","title":"该数性质482","url":"https://zh.numberempire.com/482"}]',
            role: 'user',
          },
          {
            content: [
              {
                id: 'toolu_02AgNoyb9FKuY8TGePPjEfrE',
                input: {
                  query: '杭州有啥好吃的',
                },
                name: 'searchWithSearXNG',
                type: 'tool_use',
              },
            ],
            role: 'assistant',
          },
          {
            content: [
              {
                content: [
                  {
                    text: '[{"content":"没啥好吃的","title":"该数性质482","url":"e.com/482"}]',
                    type: 'text',
                  },
                ],
                tool_use_id: 'toolu_02AgNoyb9FKuY8TGePPjEfrE',
                type: 'tool_result',
              },
            ],
            role: 'user',
          },
        ]);
      });
    });

    it('should correctly handle thinking content part', async () => {
      const messages: OpenAIChatMessage[] = [
        {
          content: '告诉我杭州和北京的天气，先回答我好的',
          role: 'user',
        },
        {
          content: [
            { thinking: '经过一番思考', type: 'thinking', signature: '123' },
            {
              type: 'text',
              text: '好的,我会为您查询杭州和北京的天气信息。我现在就开始查询这两个城市的当前天气情况。',
            },
          ],
          role: 'assistant',
          tool_calls: [
            {
              function: {
                arguments: '{"city": "\\u676d\\u5dde"}',
                name: 'realtime-weather____fetchCurrentWeather',
              },
              id: 'toolu_018PNQkH8ChbjoJz4QBiFVod',
              type: 'function',
            },
            {
              function: {
                arguments: '{"city": "\\u5317\\u4eac"}',
                name: 'realtime-weather____fetchCurrentWeather',
              },
              id: 'toolu_018VQTQ6fwAEC3eppuEfMxPp',
              type: 'function',
            },
          ],
        },
        {
          content:
            '[{"city":"杭州市","adcode":"330100","province":"浙江","reporttime":"2024-06-24 17:02:14","casts":[{"date":"2024-06-24","week":"1","dayweather":"小雨","nightweather":"中雨","daytemp":"26","nighttemp":"20","daywind":"西","nightwind":"西","daypower":"1-3","nightpower":"1-3","daytemp_float":"26.0","nighttemp_float":"20.0"},{"date":"2024-06-25","week":"2","dayweather":"大雨","nightweather":"中雨","daytemp":"23","nighttemp":"19","daywind":"东","nightwind":"东","daypower":"1-3","nightpower":"1-3","daytemp_float":"23.0","nighttemp_float":"19.0"},{"date":"2024-06-26","week":"3","dayweather":"中雨","nightweather":"中雨","daytemp":"24","nighttemp":"21","daywind":"东南","nightwind":"东南","daypower":"1-3","nightpower":"1-3","daytemp_float":"24.0","nighttemp_float":"21.0"},{"date":"2024-06-27","week":"4","dayweather":"中雨-大雨","nightweather":"中雨","daytemp":"24","nighttemp":"22","daywind":"南","nightwind":"南","daypower":"1-3","nightpower":"1-3","daytemp_float":"24.0","nighttemp_float":"22.0"}]}]',
          name: 'realtime-weather____fetchCurrentWeather',
          role: 'tool',
          tool_call_id: 'toolu_018PNQkH8ChbjoJz4QBiFVod',
        },
        {
          content:
            '[{"city":"北京市","adcode":"110000","province":"北京","reporttime":"2024-06-24 17:03:11","casts":[{"date":"2024-06-24","week":"1","dayweather":"晴","nightweather":"晴","daytemp":"33","nighttemp":"20","daywind":"北","nightwind":"北","daypower":"1-3","nightpower":"1-3","daytemp_float":"33.0","nighttemp_float":"20.0"},{"date":"2024-06-25","week":"2","dayweather":"晴","nightweather":"晴","daytemp":"35","nighttemp":"21","daywind":"东南","nightwind":"东南","daypower":"1-3","nightpower":"1-3","daytemp_float":"35.0","nighttemp_float":"21.0"},{"date":"2024-06-26","week":"3","dayweather":"晴","nightweather":"晴","daytemp":"35","nighttemp":"23","daywind":"西南","nightwind":"西南","daypower":"1-3","nightpower":"1-3","daytemp_float":"35.0","nighttemp_float":"23.0"},{"date":"2024-06-27","week":"4","dayweather":"多云","nightweather":"多云","daytemp":"35","nighttemp":"23","daywind":"西南","nightwind":"西南","daypower":"1-3","nightpower":"1-3","daytemp_float":"35.0","nighttemp_float":"23.0"}]}]',
          name: 'realtime-weather____fetchCurrentWeather',
          role: 'tool',
          tool_call_id: 'toolu_018VQTQ6fwAEC3eppuEfMxPp',
        },
        {
          content: '继续',
          role: 'user',
        },
      ];

      const contents = await buildAnthropicMessages(messages);

      expect(contents).toEqual([
        { content: '告诉我杭州和北京的天气，先回答我好的', role: 'user' },
        {
          content: [
            {
              signature: '123',
              thinking: '经过一番思考',
              type: 'thinking',
            },
            {
              text: '好的,我会为您查询杭州和北京的天气信息。我现在就开始查询这两个城市的当前天气情况。',
              type: 'text',
            },
            {
              id: 'toolu_018PNQkH8ChbjoJz4QBiFVod',
              input: { city: '杭州' },
              name: 'realtime-weather____fetchCurrentWeather',
              type: 'tool_use',
            },
            {
              id: 'toolu_018VQTQ6fwAEC3eppuEfMxPp',
              input: { city: '北京' },
              name: 'realtime-weather____fetchCurrentWeather',
              type: 'tool_use',
            },
          ],
          role: 'assistant',
        },
        {
          content: [
            {
              content: [
                {
                  text: '[{"city":"杭州市","adcode":"330100","province":"浙江","reporttime":"2024-06-24 17:02:14","casts":[{"date":"2024-06-24","week":"1","dayweather":"小雨","nightweather":"中雨","daytemp":"26","nighttemp":"20","daywind":"西","nightwind":"西","daypower":"1-3","nightpower":"1-3","daytemp_float":"26.0","nighttemp_float":"20.0"},{"date":"2024-06-25","week":"2","dayweather":"大雨","nightweather":"中雨","daytemp":"23","nighttemp":"19","daywind":"东","nightwind":"东","daypower":"1-3","nightpower":"1-3","daytemp_float":"23.0","nighttemp_float":"19.0"},{"date":"2024-06-26","week":"3","dayweather":"中雨","nightweather":"中雨","daytemp":"24","nighttemp":"21","daywind":"东南","nightwind":"东南","daypower":"1-3","nightpower":"1-3","daytemp_float":"24.0","nighttemp_float":"21.0"},{"date":"2024-06-27","week":"4","dayweather":"中雨-大雨","nightweather":"中雨","daytemp":"24","nighttemp":"22","daywind":"南","nightwind":"南","daypower":"1-3","nightpower":"1-3","daytemp_float":"24.0","nighttemp_float":"22.0"}]}]',
                  type: 'text',
                },
              ],
              tool_use_id: 'toolu_018PNQkH8ChbjoJz4QBiFVod',
              type: 'tool_result',
            },
            {
              content: [
                {
                  text: '[{"city":"北京市","adcode":"110000","province":"北京","reporttime":"2024-06-24 17:03:11","casts":[{"date":"2024-06-24","week":"1","dayweather":"晴","nightweather":"晴","daytemp":"33","nighttemp":"20","daywind":"北","nightwind":"北","daypower":"1-3","nightpower":"1-3","daytemp_float":"33.0","nighttemp_float":"20.0"},{"date":"2024-06-25","week":"2","dayweather":"晴","nightweather":"晴","daytemp":"35","nighttemp":"21","daywind":"东南","nightwind":"东南","daypower":"1-3","nightpower":"1-3","daytemp_float":"35.0","nighttemp_float":"21.0"},{"date":"2024-06-26","week":"3","dayweather":"晴","nightweather":"晴","daytemp":"35","nighttemp":"23","daywind":"西南","nightwind":"西南","daypower":"1-3","nightpower":"1-3","daytemp_float":"35.0","nighttemp_float":"23.0"},{"date":"2024-06-27","week":"4","dayweather":"多云","nightweather":"多云","daytemp":"35","nighttemp":"23","daywind":"西南","nightwind":"西南","daypower":"1-3","nightpower":"1-3","daytemp_float":"35.0","nighttemp_float":"23.0"}]}]',
                  type: 'text',
                },
              ],
              tool_use_id: 'toolu_018VQTQ6fwAEC3eppuEfMxPp',
              type: 'tool_result',
            },
            {
              text: '继续',
              type: 'text',
            },
          ],
          role: 'user',
        },
      ]);
    });

    it('should enable cache control', async () => {
      const messages: OpenAIChatMessage[] = [
        { content: 'Hello', role: 'user' },
        { content: 'Hello', role: 'user' },
        { content: 'Hi', role: 'assistant' },
      ];

      const contents = await buildAnthropicMessages(messages, { enabledContextCaching: true });

      expect(contents).toHaveLength(2);
      expect(contents).toEqual([
        {
          content: [
            { text: 'Hello', type: 'text' },
            { text: 'Hello', type: 'text' },
          ],
          role: 'user',
        },
        {
          content: [{ cache_control: { type: 'ephemeral' }, text: 'Hi', type: 'text' }],
          role: 'assistant',
        },
      ]);
    });

    it('should filter empty user messages before applying cache control', async () => {
      const messages: OpenAIChatMessage[] = [
        { content: '   \n\t  ', role: 'user' },
        { content: 'Hello', role: 'user' },
      ];

      const contents = await buildAnthropicMessages(messages, { enabledContextCaching: true });

      expect(contents).toEqual([
        {
          content: [{ cache_control: { type: 'ephemeral' }, text: 'Hello', type: 'text' }],
          role: 'user',
        },
      ]);
    });

    it('should apply cacheTTL: "1h" to string and array last messages when context caching is enabled', async () => {
      const stringMessages: OpenAIChatMessage[] = [{ content: 'Hello', role: 'user' }];
      const stringResult = await buildAnthropicMessages(stringMessages, {
        cacheTTL: '1h',
        enabledContextCaching: true,
      });

      expect(stringResult).toEqual([
        {
          content: [
            { cache_control: { ttl: '1h', type: 'ephemeral' }, text: 'Hello', type: 'text' },
          ],
          role: 'user',
        },
      ]);

      const arrayMessages: OpenAIChatMessage[] = [
        {
          content: [
            { text: 'First block', type: 'text' },
            { text: 'Second block', type: 'text' },
          ],
          role: 'user',
        },
      ];
      const arrayResult = await buildAnthropicMessages(arrayMessages, {
        cacheTTL: '1h',
        enabledContextCaching: true,
      });

      expect(arrayResult).toEqual([
        {
          content: [
            { text: 'First block', type: 'text' },
            {
              cache_control: { ttl: '1h', type: 'ephemeral' },
              text: 'Second block',
              type: 'text',
            },
          ],
          role: 'user',
        },
      ]);
    });

    it('should omit ttl for cacheTTL: "5m" and emit no cache_control when enabledContextCaching is false', async () => {
      const messages: OpenAIChatMessage[] = [{ content: 'Hello', role: 'user' }];

      const fiveMin = await buildAnthropicMessages(messages, {
        cacheTTL: '5m',
        enabledContextCaching: true,
      });
      expect(fiveMin).toEqual([
        {
          content: [{ cache_control: { type: 'ephemeral' }, text: 'Hello', type: 'text' }],
          role: 'user',
        },
      ]);

      const disabled = await buildAnthropicMessages(messages, {
        cacheTTL: '1h',
        enabledContextCaching: false,
      });
      expect(disabled).toEqual([{ content: 'Hello', role: 'user' }]);
    });
  });

  describe('buildAnthropicTools', () => {
    it('should correctly convert OpenAI tools to Anthropic format', () => {
      const tools: OpenAI.ChatCompletionTool[] = [
        {
          type: 'function',
          function: {
            name: 'search',
            description: 'Searches the web',
            parameters: {
              type: 'object',
              properties: {
                query: { type: 'string' },
              },
              required: ['query'],
            },
          },
        },
      ];

      const result = buildAnthropicTools(tools);

      expect(result).toEqual([
        {
          name: 'search',
          description: 'Searches the web',
          input_schema: {
            type: 'object',
            properties: {
              query: { type: 'string' },
            },
            required: ['query'],
          },
        },
      ]);
    });
    it('should enable cache control', () => {
      const tools: OpenAI.ChatCompletionTool[] = [
        {
          type: 'function',
          function: {
            name: 'search',
            description: 'Searches the web',
            parameters: {
              type: 'object',
              properties: {
                query: { type: 'string' },
              },
              required: ['query'],
            },
          },
        },
      ];

      const result = buildAnthropicTools(tools, { enabledContextCaching: true });

      expect(result).toEqual([
        {
          name: 'search',
          description: 'Searches the web',
          input_schema: {
            type: 'object',
            properties: {
              query: { type: 'string' },
            },
            required: ['query'],
          },
          cache_control: { type: 'ephemeral' },
        },
      ]);
    });

    it('should apply cacheTTL: "1h" only on the last tool and omit cache_control when disabled', () => {
      const tools: OpenAI.ChatCompletionTool[] = [
        {
          function: {
            description: 'First tool',
            name: 'first',
            parameters: { properties: {}, type: 'object' },
          },
          type: 'function',
        },
        {
          function: {
            description: 'Last tool',
            name: 'last',
            parameters: { properties: {}, type: 'object' },
          },
          type: 'function',
        },
      ];

      const oneHour = buildAnthropicTools(tools, {
        cacheTTL: '1h',
        enabledContextCaching: true,
      });
      expect(oneHour?.[0].cache_control).toBeUndefined();
      expect(oneHour?.[1].cache_control).toEqual({ ttl: '1h', type: 'ephemeral' });

      const disabled = buildAnthropicTools(tools, {
        cacheTTL: '1h',
        enabledContextCaching: false,
      });
      expect(disabled?.[0].cache_control).toBeUndefined();
      expect(disabled?.[1].cache_control).toBeUndefined();
    });
  });

  describe('Image resilience: MIME magic bytes, server sharp compression, immutability, concurrency, and tool_result ordering', () => {
    const REAL_PNG_BASE64 = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
      0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00,
    ]).toString('base64');
    const REAL_JPEG_BASE64 = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
    ]).toString('base64');

    it('detects magic bytes for data:;base64, application/octet-stream, and mismatched image/* headers, and drops unknown empty media_type', async () => {
      // 1. data:;base64,<PNG> -> mimeType: null -> magic bytes resolve to image/png
      vi.mocked(parseDataUri).mockReturnValueOnce({
        base64: REAL_PNG_BASE64,
        mimeType: null,
        type: 'base64',
      });
      expect(
        await buildAnthropicBlock({
          image_url: { url: `data:;base64,${REAL_PNG_BASE64}` },
          type: 'image_url',
        }),
      ).toEqual({
        source: { data: REAL_PNG_BASE64, media_type: 'image/png', type: 'base64' },
        type: 'image',
      });

      // 2. data:application/octet-stream;base64,<PNG> -> image/png
      vi.mocked(parseDataUri).mockReturnValueOnce({
        base64: REAL_PNG_BASE64,
        mimeType: 'application/octet-stream',
        type: 'base64',
      });
      expect(
        await buildAnthropicBlock({
          image_url: { url: `data:application/octet-stream;base64,${REAL_PNG_BASE64}` },
          type: 'image_url',
        }),
      ).toEqual({
        source: { data: REAL_PNG_BASE64, media_type: 'image/png', type: 'base64' },
        type: 'image',
      });

      // 3. Mismatched header (image/png on real JPEG bytes) -> magic bytes win -> image/jpeg
      vi.mocked(parseDataUri).mockReturnValueOnce({
        base64: REAL_JPEG_BASE64,
        mimeType: 'image/png; charset=binary',
        type: 'base64',
      });
      expect(
        await buildAnthropicBlock({
          image_url: { url: `data:image/png;base64,${REAL_JPEG_BASE64}` },
          type: 'image_url',
        }),
      ).toEqual({
        source: { data: REAL_JPEG_BASE64, media_type: 'image/jpeg', type: 'base64' },
        type: 'image',
      });

      // 4. Null/generic MIME with no magic bytes -> undefined (never passes invalid media_type to Anthropic)
      vi.mocked(parseDataUri).mockReturnValueOnce({
        base64: Buffer.from('not-an-image').toString('base64'),
        mimeType: null,
        type: 'base64',
      });
      expect(
        await buildAnthropicBlock({
          image_url: { url: 'data:;base64,bm90LWFuLWltYWdl' },
          type: 'image_url',
        }),
      ).toBeUndefined();
    });

    it('auto-compresses >5MB base64 images and converts image/avif & image/bmp via sharp on server', async () => {
      clearAnthropicImageCacheForTest();
      const savedWindow = (globalThis as any).window;
      delete (globalThis as any).window;

      try {
        const { createRequire } = await import('node:module');
        const sharp = createRequire(`${process.cwd()}/package.json`)('sharp');
        const { randomBytes } = await import('node:crypto');

        // 1. Noisy 1600x1600 PNG whose base64 exceeds 5 MiB (5_242_880 chars)
        const rawNoise = randomBytes(1600 * 1600 * 3);
        const hugePngBuf: Buffer = await sharp(rawNoise, {
          raw: { channels: 3, height: 1600, width: 1600 },
        })
          .png({ compressionLevel: 0 })
          .toBuffer();
        const hugePngBase64 = hugePngBuf.toString('base64');
        expect(hugePngBase64.length).toBeGreaterThan(ANTHROPIC_MAX_IMAGE_BASE64_CHARS);

        vi.mocked(parseDataUri).mockReturnValueOnce({
          base64: hugePngBase64,
          mimeType: 'image/png',
          type: 'base64',
        });

        const compressedBlock = (await buildAnthropicBlock({
          image_url: { url: 'data:image/png;base64,huge' },
          type: 'image_url',
        })) as any;

        expect(compressedBlock).toBeDefined();
        expect(compressedBlock.type).toBe('image');
        expect(['image/jpeg', 'image/webp']).toContain(compressedBlock.source.media_type);
        expect(compressedBlock.source.data.length).toBeLessThanOrEqual(
          ANTHROPIC_MAX_IMAGE_BASE64_CHARS,
        );

        // Second call hits server LRU cache and returns byte-identical base64 (preserving 1h prompt cache)
        vi.mocked(parseDataUri).mockReturnValueOnce({
          base64: hugePngBase64,
          mimeType: 'image/png',
          type: 'base64',
        });
        const cachedBlock = (await buildAnthropicBlock({
          image_url: { url: 'data:image/png;base64,huge' },
          type: 'image_url',
        })) as any;
        expect(cachedBlock.source.data).toBe(compressedBlock.source.data);

        // 2. AVIF -> PNG conversion on server
        const avifBuf: Buffer = await sharp({
          create: { background: { b: 200, g: 100, r: 50 }, channels: 3, height: 16, width: 16 },
        })
          .avif()
          .toBuffer();
        const avifBase64 = avifBuf.toString('base64');

        vi.mocked(parseDataUri).mockReturnValueOnce({
          base64: avifBase64,
          mimeType: 'image/avif',
          type: 'base64',
        });
        const convertedAvif = (await buildAnthropicBlock({
          image_url: { url: `data:image/avif;base64,${avifBase64}` },
          type: 'image_url',
        })) as any;
        expect(convertedAvif?.source.media_type).toBe('image/png');

        // 3. Minimal uncompressed 2x2 24-bit BMP -> PNG conversion on server
        const bmpBuf = Buffer.alloc(70);
        bmpBuf.write('BM', 0, 'ascii');
        bmpBuf.writeUInt32LE(70, 2); // file size
        bmpBuf.writeUInt32LE(54, 10); // pixel data offset
        bmpBuf.writeUInt32LE(40, 14); // BITMAPINFOHEADER size
        bmpBuf.writeInt32LE(2, 18); // width
        bmpBuf.writeInt32LE(2, 22); // height
        bmpBuf.writeUInt16LE(1, 26); // planes
        bmpBuf.writeUInt16LE(24, 28); // bpp
        const bmpBase64 = bmpBuf.toString('base64');

        vi.mocked(parseDataUri).mockReturnValueOnce({
          base64: bmpBase64,
          mimeType: 'image/bmp',
          type: 'base64',
        });
        const convertedBmp = (await buildAnthropicBlock({
          image_url: { url: `data:image/bmp;base64,${bmpBase64}` },
          type: 'image_url',
        })) as any;
        expect(convertedBmp?.source.media_type).toBe('image/png');
      } finally {
        (globalThis as any).window = savedWindow;
      }
    });

    it('does not mutate caller oaiMessages objects when enabledContextCaching is true', async () => {
      const textBlock: UserMessageContentPart = { text: 'Immutable user text', type: 'text' };
      const thinkingBlock: UserMessageContentPart = {
        signature: 'sig',
        thinking: 'Immutable thought',
        type: 'thinking',
      };
      const inputMessages: OpenAIChatMessage[] = [
        { content: [thinkingBlock, { text: 'Assistant reply', type: 'text' }], role: 'assistant' },
        { content: [textBlock], role: 'user' },
      ];

      await buildAnthropicMessages(inputMessages, {
        cacheTTL: '1h',
        enabledContextCaching: true,
      });

      expect('cache_control' in (textBlock as any)).toBe(false);
      expect('cache_control' in (thinkingBlock as any)).toBe(false);
    });

    it('bounds concurrent imageUrlToBase64 calls to 6, deduplicates duplicate URLs, and forwards signal only when set', async () => {
      vi.mocked(parseDataUri).mockReturnValue({
        base64: null,
        mimeType: null,
        type: 'url',
      });

      let inFlight = 0;
      let maxInFlight = 0;
      vi.mocked(imageUrlToBase64).mockImplementation(async (_url: string) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 15));
        inFlight -= 1;
        return { base64: REAL_PNG_BASE64, mimeType: `image/png` };
      });

      const urls = Array.from({ length: 15 }, (_, idx) => `https://cdn.example.com/img-${idx}.png`);
      // Include duplicate URLs across messages to verify request-local deduplication
      const messages: OpenAIChatMessage[] = [
        {
          content: urls.slice(0, 8).map((url) => ({ image_url: { url }, type: 'image_url' })),
          role: 'user',
        },
        { content: 'Ack', role: 'assistant' },
        {
          content: [
            ...urls.slice(8).map((url) => ({ image_url: { url }, type: 'image_url' as const })),
            { image_url: { url: urls[0] }, type: 'image_url' as const },
          ],
          role: 'user',
        },
      ];

      const controller = new AbortController();
      const built = await buildAnthropicMessages(messages, { signal: controller.signal });

      expect(built).toHaveLength(3);
      expect(maxInFlight).toBeLessThanOrEqual(MAX_CONCURRENT_IMAGE_LOADS);
      expect(maxInFlight).toBeGreaterThan(1);
      // 15 unique URLs (duplicate urls[0] was deduplicated)
      expect(imageUrlToBase64).toHaveBeenCalledTimes(15);
      expect(imageUrlToBase64).toHaveBeenCalledWith(urls[0], { signal: controller.signal });
    });

    it('merges tool_result + subsequent user image message keeping tool_result first and converts orphan tool images without JSON base64 leak', async () => {
      vi.mocked(parseDataUri).mockReturnValue({
        base64: REAL_PNG_BASE64,
        mimeType: 'image/png',
        type: 'base64',
      });

      const messages: OpenAIChatMessage[] = [
        {
          content: [
            { text: 'Orphan screenshot', type: 'text' },
            { image_url: { url: `data:image/png;base64,${REAL_PNG_BASE64}` }, type: 'image_url' },
          ] as any,
          role: 'tool',
          tool_call_id: 'orphan_call_id',
        },
        {
          content: '',
          role: 'assistant',
          tool_calls: [
            {
              function: { arguments: '{}', name: 'take_screenshot' },
              id: 'paired_call_1',
              type: 'function',
            },
          ],
        },
        {
          content: 'Screenshot saved',
          role: 'tool',
          tool_call_id: 'paired_call_1',
        },
        {
          content: [
            { text: 'Images returned by tool:', type: 'text' },
            { image_url: { url: `data:image/png;base64,${REAL_PNG_BASE64}` }, type: 'image_url' },
          ],
          role: 'user',
        },
      ];

      const result = await buildAnthropicMessages(messages);

      // Strictly alternates: user (orphan converted blocks) -> assistant (tool_use) -> user (tool_result FIRST, then text + image)
      expect(result.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);

      // Orphan tool message converted to structured text + image blocks (NOT JSON.stringify!)
      expect(result[0].content).toEqual([
        { text: 'Orphan screenshot', type: 'text' },
        {
          source: { data: REAL_PNG_BASE64, media_type: 'image/png', type: 'base64' },
          type: 'image',
        },
      ]);

      // Merged post-tool user message has tool_result strictly at index 0
      const postToolBlocks = result[2].content as any[];
      expect(postToolBlocks[0]).toMatchObject({
        tool_use_id: 'paired_call_1',
        type: 'tool_result',
      });
      expect(postToolBlocks[1]).toEqual({ text: 'Images returned by tool:', type: 'text' });
      expect(postToolBlocks[2]).toMatchObject({ type: 'image' });
    });

    it('parses magic bytes and raster dimensions in pure browser mode without global Buffer, preserves image cache_control, and caps cache_control blocks to 4', async () => {
      const savedWindow = (globalThis as any).window;
      const savedBuffer = (globalThis as any).Buffer;
      (globalThis as any).window = {};
      (globalThis as any).Buffer = undefined;

      try {
        vi.mocked(parseDataUri).mockReturnValue({
          base64: REAL_PNG_BASE64,
          mimeType: null,
          type: 'base64',
        });

        // Browser mode without global Buffer still detects PNG magic bytes + dimensions and preserves cache_control
        const messages: OpenAIChatMessage[] = [
          {
            content: [
              {
                cache_control: { type: 'ephemeral' },
                text: 'Block 1',
                type: 'text',
              } as any,
            ],
            role: 'user',
          },
          {
            content: [
              {
                cache_control: { type: 'ephemeral' },
                text: 'Block 2',
                type: 'text',
              } as any,
            ],
            role: 'user',
          },
          {
            content: [
              {
                cache_control: { type: 'ephemeral' },
                text: 'Block 3',
                type: 'text',
              } as any,
              {
                cache_control: { type: 'ephemeral' },
                image_url: { url: `data:;base64,${REAL_PNG_BASE64}` },
                type: 'image_url',
              } as any,
              {
                text: 'Final block',
                type: 'text',
              },
            ],
            role: 'user',
          },
        ];

        const merged = await buildAnthropicMessages(messages, { enabledContextCaching: true });
        expect(merged).toHaveLength(1);
        const blocks = merged[0].content as any[];
        expect(blocks).toHaveLength(5);
        expect(blocks[3]).toEqual({
          cache_control: { type: 'ephemeral' },
          source: { data: REAL_PNG_BASE64, media_type: 'image/png', type: 'base64' },
          type: 'image',
        });
        expect(blocks[4]).toEqual({
          cache_control: { type: 'ephemeral' },
          text: 'Final block',
          type: 'text',
        });

        // Total cache_control markers across the merged message never exceed Anthropic's 4-block limit
        const markedCount = blocks.filter((b) => Boolean(b.cache_control)).length;
        expect(markedCount).toBe(4);
        // Earliest excess marker on Block 1 was trimmed so the latest 4 breakpoints win
        expect(blocks[0].cache_control).toBeUndefined();
      } finally {
        (globalThis as any).window = savedWindow;
        (globalThis as any).Buffer = savedBuffer;
      }
    });
  });
});
