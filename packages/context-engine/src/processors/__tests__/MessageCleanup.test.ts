import { describe, expect, it } from 'vitest';

import type { PipelineContext } from '../../types';
import { MessageCleanupProcessor } from '../MessageCleanup';

describe('MessageCleanupProcessor', () => {
  const createContext = (messages: any[]): PipelineContext => ({
    initialState: {
      messages: [],
      model: 'test-model',
      provider: 'test-provider',
    },
    isAborted: false,
    messages,
    metadata: {
      maxTokens: 4000,
      model: 'test-model',
    },
  });

  describe('constructor', () => {
    it('should initialize with default options', () => {
      const processor = new MessageCleanupProcessor();
      expect(processor.name).toBe('MessageCleanupProcessor');
    });

    it('should initialize with custom options', () => {
      const processor = new MessageCleanupProcessor({ debug: true });
      expect(processor.name).toBe('MessageCleanupProcessor');
    });
  });

  describe('process', () => {
    it('should clean system messages', async () => {
      const processor = new MessageCleanupProcessor();
      const context = createContext([
        {
          content: 'You are a helpful assistant',
          extraField: 'should be removed',
          id: 'msg1',
          role: 'system',
          timestamp: Date.now(),
        },
      ]);

      const result = await processor.process(context);

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]).toEqual({
        content: 'You are a helpful assistant',
        role: 'system',
      });
      expect(result.messages[0]).not.toHaveProperty('extraField');
      expect(result.messages[0]).not.toHaveProperty('id');
      expect(result.messages[0]).not.toHaveProperty('timestamp');
    });

    it('should clean user messages', async () => {
      const processor = new MessageCleanupProcessor();
      const context = createContext([
        {
          content: 'Hello, world!',
          extraField: 'remove me',
          id: 'msg2',
          role: 'user',
          timestamp: Date.now(),
        },
      ]);

      const result = await processor.process(context);

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]).toEqual({
        content: 'Hello, world!',
        role: 'user',
      });
    });

    it('should clean assistant messages without tool_calls', async () => {
      const processor = new MessageCleanupProcessor();
      const context = createContext([
        {
          content: 'I can help you with that',
          extraField: 'unnecessary',
          id: 'msg3',
          role: 'assistant',
          timestamp: Date.now(),
        },
      ]);

      const result = await processor.process(context);

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]).toEqual({
        content: 'I can help you with that',
        role: 'assistant',
      });
    });

    it('should preserve tool_calls in assistant messages', async () => {
      const processor = new MessageCleanupProcessor();
      const toolCalls = [
        {
          function: {
            arguments: '{"query":"test"}',
            name: 'search',
          },
          id: 'call_1',
          type: 'function',
        },
      ];

      const context = createContext([
        {
          content: '',
          extraField: 'remove',
          id: 'msg4',
          role: 'assistant',
          timestamp: Date.now(),
          tool_calls: toolCalls,
        },
      ]);

      const result = await processor.process(context);

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]).toEqual({
        content: '',
        role: 'assistant',
        tool_calls: toolCalls,
      });
    });

    it('should preserve reasoning in assistant messages', async () => {
      const processor = new MessageCleanupProcessor();
      const reasoning = {
        content: 'Let me think about this...',
        signature: 'sha256:abc123',
      };

      const context = createContext([
        {
          content: 'Here is the answer',
          extraField: 'remove',
          id: 'msg5',
          reasoning,
          role: 'assistant',
          timestamp: Date.now(),
        },
      ]);

      const result = await processor.process(context);

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]).toEqual({
        content: 'Here is the answer',
        reasoning,
        role: 'assistant',
      });
    });

    it('should clean tool messages with name', async () => {
      const processor = new MessageCleanupProcessor();
      const context = createContext([
        {
          content: 'Search result: ...',
          extraField: 'extra',
          id: 'msg5',
          name: 'search',
          role: 'tool',
          timestamp: Date.now(),
          tool_call_id: 'call_1',
        },
      ]);

      const result = await processor.process(context);

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]).toEqual({
        content: 'Search result: ...',
        name: 'search',
        role: 'tool',
        tool_call_id: 'call_1',
      });
    });

    it('should clean tool messages without name', async () => {
      const processor = new MessageCleanupProcessor();
      const context = createContext([
        {
          content: 'Tool result',
          extraField: 'extra',
          id: 'msg6',
          role: 'tool',
          timestamp: Date.now(),
          tool_call_id: 'call_2',
        },
      ]);

      const result = await processor.process(context);

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]).toEqual({
        content: 'Tool result',
        role: 'tool',
        tool_call_id: 'call_2',
      });
    });

    it('should keep unknown role messages unchanged', async () => {
      const processor = new MessageCleanupProcessor();
      const unknownMessage = {
        content: 'Unknown message',
        customField: 'keep this',
        id: 'msg7',
        role: 'custom_role',
      };

      const context = createContext([unknownMessage]);

      const result = await processor.process(context);

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]).toEqual(unknownMessage);
    });

    it('should clean multiple messages', async () => {
      const processor = new MessageCleanupProcessor();
      const context = createContext([
        {
          content: 'System prompt',
          extra: 'remove',
          id: 'msg1',
          role: 'system',
        },
        {
          content: 'User question',
          extra: 'remove',
          id: 'msg2',
          role: 'user',
        },
        {
          content: 'Assistant response',
          extra: 'remove',
          id: 'msg3',
          role: 'assistant',
        },
      ]);

      const result = await processor.process(context);

      expect(result.messages).toHaveLength(3);
      expect(result.messages[0].role).toBe('system');
      expect(result.messages[1].role).toBe('user');
      expect(result.messages[2].role).toBe('assistant');
      expect(result.messages.every((msg) => !('extra' in msg))).toBe(true);
      expect(result.messages.every((msg) => !('id' in msg))).toBe(true);
    });

    it('should update metadata with cleanup stats', async () => {
      const processor = new MessageCleanupProcessor();
      const context = createContext([
        {
          content: 'Test',
          extraField: 'remove',
          id: 'msg1',
          role: 'user',
        },
        {
          content: 'Response',
          extraField: 'remove',
          id: 'msg2',
          role: 'assistant',
        },
      ]);

      const result = await processor.process(context);

      expect(result.metadata.messageCleanup).toEqual({
        cleanedCount: 2,
        totalMessages: 2,
      });
    });

    it('should track messages that were not modified', async () => {
      const processor = new MessageCleanupProcessor();
      const cleanMessage = {
        content: 'Already clean',
        role: 'user',
      };

      const context = createContext([
        cleanMessage,
        {
          content: 'Needs cleaning',
          extra: 'field',
          role: 'user',
        },
      ]);

      const result = await processor.process(context);

      // Both messages are "cleaned" because comparison is done by reference
      expect(result.metadata.messageCleanup!.cleanedCount).toBe(2);
      expect(result.metadata.messageCleanup!.totalMessages).toBe(2);
    });

    it('should handle empty messages array', async () => {
      const processor = new MessageCleanupProcessor();
      const context = createContext([]);

      const result = await processor.process(context);

      expect(result.messages).toHaveLength(0);
      expect(result.metadata.messageCleanup).toEqual({
        cleanedCount: 0,
        totalMessages: 0,
      });
    });

    it('should not mutate original context', async () => {
      const processor = new MessageCleanupProcessor();
      const originalMessage = {
        content: 'Test',
        extra: 'field',
        id: 'msg1',
        role: 'user',
      };
      const context = createContext([originalMessage]);

      await processor.process(context);

      // Original message should be unchanged
      expect(originalMessage).toHaveProperty('extra');
      expect(originalMessage).toHaveProperty('id');
    });

    it('should handle messages with array content', async () => {
      const processor = new MessageCleanupProcessor();
      const context = createContext([
        {
          content: [
            { text: 'Hello', type: 'text' },
            { image_url: { url: 'http://example.com/image.jpg' }, type: 'image_url' },
          ],
          extra: 'remove',
          role: 'user',
        },
      ]);

      const result = await processor.process(context);

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]).toEqual({
        content: [
          { text: 'Hello', type: 'text' },
          { image_url: { url: 'http://example.com/image.jpg' }, type: 'image_url' },
        ],
        role: 'user',
      });
    });

    it('should return valid context after processing', async () => {
      const processor = new MessageCleanupProcessor();
      const context = createContext([{ content: 'test', role: 'user' }]);

      const result = await processor.process(context);

      expect(result).toBeDefined();
      expect(result.messages).toBeDefined();
      expect(result.metadata).toBeDefined();
    });

    it('should rewrite saved code-artifact tags in assistant string and multimodal content without mutating input', async () => {
      const processor = new MessageCleanupProcessor();
      const fileId = '849f7fc2-dd0e-4b18-9aa8-aab327c49b30';
      const rawTag = `<lobeArtifact type="application/lobe.artifacts.code" identifier="code-vb-1" title="Module1.bas" language="vb" src="/chat/code-artifact/${fileId}/"></lobeArtifact>`;
      const htmlTag =
        '<lobeArtifact identifier="page" type="text/html" title="Page" src="/chat/f/file_9/"></lobeArtifact>';
      const originalAssistant = {
        content: `Done:\n${rawTag}\n${htmlTag}`,
        id: 'asst-1',
        role: 'assistant',
      };
      const originalMultimodal = {
        content: [
          { text: `Part 2:\n${rawTag}`, type: 'text' },
          { image_url: { url: 'https://example.com/img.png' }, type: 'image_url' },
        ],
        id: 'asst-2',
        role: 'assistant',
      };

      const result = await processor.process(
        createContext([originalAssistant, originalMultimodal]),
      );

      expect(result.messages[0].content).toContain(
        `[Saved "Module1.bas" (vb), fileId=${fileId} — previous code block stored by server. Use getTopicContext(mode="code_artifacts", fileId="${fileId}") if you need to inspect it.]`,
      );
      expect(result.messages[0].content).toContain(htmlTag);
      expect(result.messages[0].content).not.toContain('/chat/code-artifact/');

      expect(result.messages[1].content[0].text).not.toContain('/chat/code-artifact/');
      expect(result.messages[1].content[0].text).toContain(`fileId=${fileId}`);
      expect(result.messages[1].content[1]).toEqual({
        image_url: { url: 'https://example.com/img.png' },
        type: 'image_url',
      });

      // Original DB-backed message objects must remain untouched
      expect(originalAssistant.content).toContain(rawTag);
      expect((originalMultimodal.content[0] as any).text).toContain(rawTag);
    });
  });
});
