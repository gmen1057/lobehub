import { describe, expect, it } from 'vitest';

import {
  calculateMessageTokens,
  calculatePromptTokens,
  DEFAULT_MAX_CONTEXT,
  DEFAULT_THRESHOLD_RATIO,
  estimateTokens,
  getCompressionThreshold,
  shouldCompress,
} from './tokenCounter';

it('counts bounded attachments and serialized tool calls before compression', () => {
  const small = calculateMessageTokens([{ role: 'user', content: 'Read this' }]);
  const large = calculateMessageTokens([
    {
      role: 'user',
      content: 'Read this',
      fileList: [{ content: 'contact '.repeat(200_000), id: 'vcf' }],
    },
  ]);
  expect(large).toBeGreaterThan(small + 500);
  expect(large).toBeLessThan(10_000);
  expect(
    calculateMessageTokens([
      { role: 'assistant', content: '', tools: [{ arguments: 'data '.repeat(500) }] },
    ]),
  ).toBeGreaterThan(100);
});

it('counts injected text and tool schemas without treating base64 images as text', () => {
  const tokens = calculatePromptTokens(
    [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'full injected content '.repeat(1000) },
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,' + 'x'.repeat(1_000_000) },
          },
        ],
      },
    ],
    [{ function: { name: 'read', description: 'schema '.repeat(1000) } }],
  );
  expect(tokens).toBeGreaterThan(1000);
  expect(tokens).toBeLessThan(20000);
});

describe('tokenCounter', () => {
  describe('estimateTokens', () => {
    it('should estimate tokens for string content', () => {
      const tokens = estimateTokens('Hello, world!');
      expect(tokens).toBeGreaterThan(0);
    });

    it('should return 0 for empty string', () => {
      expect(estimateTokens('')).toBe(0);
    });

    it('should handle null/undefined content', () => {
      expect(estimateTokens(null)).toBe(0);
      expect(estimateTokens(undefined)).toBe(0);
    });

    it('should handle object content by JSON stringifying', () => {
      const tokens = estimateTokens({ key: 'value', nested: { a: 1 } });
      expect(tokens).toBeGreaterThan(0);
    });

    it('should handle array content', () => {
      const tokens = estimateTokens(['item1', 'item2', 'item3']);
      expect(tokens).toBeGreaterThan(0);
    });
  });

  describe('calculateMessageTokens', () => {
    it('should use totalOutputTokens for assistant messages when available', () => {
      const messages = [
        {
          content: 'This content should be ignored',
          metadata: { usage: { totalOutputTokens: 100 } },
          role: 'assistant',
        },
      ];
      expect(calculateMessageTokens(messages)).toBe(100);
    });

    it('should estimate tokens for assistant messages without usage data', () => {
      const messages = [{ content: 'Hello from assistant', role: 'assistant' }];
      const tokens = calculateMessageTokens(messages);
      expect(tokens).toBeGreaterThan(0);
      // Should be estimated, not 0
      expect(tokens).not.toBe(100);
    });

    it('should estimate tokens for user messages', () => {
      const messages = [{ content: 'Hello from user', role: 'user' }];
      const tokens = calculateMessageTokens(messages);
      expect(tokens).toBeGreaterThan(0);
    });

    it('should estimate tokens for system messages', () => {
      const messages = [{ content: 'System prompt', role: 'system' }];
      const tokens = calculateMessageTokens(messages);
      expect(tokens).toBeGreaterThan(0);
    });

    it('should sum tokens from multiple messages', () => {
      const messages = [
        { content: 'Hello', role: 'user' },
        { content: 'Hi there!', metadata: { usage: { totalOutputTokens: 50 } }, role: 'assistant' },
        { content: 'How are you?', role: 'user' },
      ];
      const tokens = calculateMessageTokens(messages);
      // Should be 50 (assistant) + estimated tokens for user messages
      expect(tokens).toBeGreaterThan(50);
    });

    it('should handle empty messages array', () => {
      expect(calculateMessageTokens([])).toBe(0);
    });

    it('should handle messages with empty content', () => {
      const messages = [
        { content: '', role: 'user' },
        { content: undefined, role: 'assistant' },
      ];
      expect(calculateMessageTokens(messages)).toBe(0);
    });

    it('should skip assistant usage with 0 tokens and estimate instead', () => {
      const messages = [
        {
          content: 'Some content',
          metadata: { usage: { totalOutputTokens: 0 } },
          role: 'assistant',
        },
      ];
      const tokens = calculateMessageTokens(messages);
      // Should estimate since totalOutputTokens is 0
      expect(tokens).toBeGreaterThan(0);
    });

    it('should support flat DB metadata.totalOutputTokens, usage.totalOutputTokens, and reasoning_content', () => {
      const flatMetaTokens = calculateMessageTokens([
        {
          content: 'short',
          metadata: { totalOutputTokens: 250 },
          role: 'assistant',
        },
      ]);
      expect(flatMetaTokens).toBe(250);

      const directUsageTokens = calculateMessageTokens([
        {
          content: 'short',
          role: 'assistant',
          usage: { totalOutputTokens: 320 },
        },
      ]);
      expect(directUsageTokens).toBe(320);

      const withReasoningContent = calculateMessageTokens([
        {
          content: 'Answer',
          reasoning_content: 'Detailed step-by-step chain of thought '.repeat(100),
          role: 'assistant',
        },
      ]);
      const withoutReasoningContent = calculateMessageTokens([
        {
          content: 'Answer',
          role: 'assistant',
        },
      ]);
      expect(withReasoningContent).toBeGreaterThan(withoutReasoningContent + 200);
    });

    it('should count assistantGroup and supervisor children matching flattened messages without double-counting usage or result.state', () => {
      const toolOutput = 'Tool result body line '.repeat(400);
      const toolCall = {
        apiName: 'readFile',
        arguments: JSON.stringify({ path: 'src/index.ts' }),
        id: 'tc-1',
        identifier: 'local',
        type: 'builtin',
      };

      const flatTokens = calculateMessageTokens([
        { content: 'Analyze the codebase', role: 'user' },
        {
          content: 'Checking file now.',
          metadata: { totalOutputTokens: 120 },
          reasoning_content: 'Need to inspect src/index.ts first.',
          role: 'assistant',
          tools: [toolCall],
        },
        {
          content: toolOutput,
          role: 'tool',
        },
      ]);

      const groupTokens = calculateMessageTokens([
        { content: 'Analyze the codebase', role: 'user' },
        {
          children: [
            {
              content: 'Checking file now.',
              metadata: { totalOutputTokens: 120 },
              reasoning_content: 'Need to inspect src/index.ts first.',
              tools: [
                {
                  ...toolCall,
                  intervention: { status: 'approved' },
                  result: {
                    content: toolOutput,
                    id: 'tool-msg-1',
                    // Huge internal UI/plugin state that GroupMessageFlattenProcessor never sends to the LLM
                    state: { rawInternalBlob: 'x'.repeat(200_000) },
                  },
                },
              ],
              usage: { totalOutputTokens: 120 },
            },
          ],
          content: '',
          role: 'assistantGroup',
          // Aggregated top-level usage must NOT be counted again on top of child.usage
          usage: { totalOutputTokens: 120 },
        },
      ]);

      expect(groupTokens).toBe(flatTokens);

      // Supervisor nodes follow the exact same children[] flattening rules
      const supervisorTokens = calculateMessageTokens([
        { content: 'Analyze the codebase', role: 'user' },
        {
          children: [
            {
              content: 'Checking file now.',
              metadata: { usage: { totalOutputTokens: 120 } },
              reasoning_content: 'Need to inspect src/index.ts first.',
              tools: [
                {
                  ...toolCall,
                  result: {
                    content: toolOutput,
                    id: 'tool-msg-1',
                  },
                },
              ],
            },
          ],
          content: '',
          role: 'supervisor',
          usage: { totalOutputTokens: 999_999 },
        },
      ]);
      expect(supervisorTokens).toBe(flatTokens);
    });

    it('should share bounded attachment preview budget across assistantGroup child fileLists', () => {
      const tokens = calculateMessageTokens([
        {
          children: [
            {
              content: 'First child',
              fileList: [{ content: 'alpha '.repeat(200_000), id: 'f1', name: 'a.txt' }],
            },
            {
              content: 'Second child',
              fileList: [{ content: 'beta '.repeat(200_000), id: 'f2', name: 'b.txt' }],
            },
          ],
          content: '',
          role: 'assistantGroup',
        },
      ]);
      expect(tokens).toBeGreaterThan(500);
      expect(tokens).toBeLessThan(15_000);
    });

    it('should count compressedGroup top-level content only and ignore archived compressedMessages', () => {
      const summaryOnly = calculateMessageTokens([
        { content: 'Concise rolling summary.', role: 'compressedGroup' },
      ]);
      const withArchivedMessages = calculateMessageTokens([
        {
          compressedMessages: [
            { content: 'Archived huge history '.repeat(50_000), role: 'user' },
            { content: 'Archived huge answer '.repeat(50_000), role: 'assistant' },
          ],
          content: 'Concise rolling summary.',
          role: 'compressedGroup',
        },
      ]);
      expect(withArchivedMessages).toBe(summaryOnly);
    });

    it('should count virtual tasks, groupTasks, agentCouncil, and active compare column', () => {
      const taskBody = 'Sub-agent completed full audit '.repeat(100);
      const tasksTokens = calculateMessageTokens([
        {
          content: '',
          role: 'tasks',
          tasks: [{ content: taskBody, role: 'task' }],
        },
      ]);
      const groupTasksTokens = calculateMessageTokens([
        {
          content: '',
          role: 'groupTasks',
          tasks: [{ content: taskBody, role: 'task' }],
        },
      ]);
      expect(tasksTokens).toBe(estimateTokens(taskBody));
      expect(groupTasksTokens).toBe(estimateTokens(taskBody));

      const councilTokens = calculateMessageTokens([
        {
          content: '',
          members: [
            { content: 'Member A reply', role: 'assistant' },
            { content: 'Member B reply', role: 'assistant' },
          ],
          role: 'agentCouncil',
        },
      ]);
      expect(councilTokens).toBe(
        estimateTokens('Member A reply') + estimateTokens('Member B reply'),
      );

      const compareTokens = calculateMessageTokens([
        {
          activeColumnId: 'col-2',
          columns: [
            [{ content: 'Inactive column '.repeat(500), id: 'col-1', role: 'assistant' }],
            [{ content: 'Selected concise answer', id: 'col-2', role: 'assistant' }],
          ],
          content: '',
          role: 'compare',
        },
      ]);
      expect(compareTokens).toBe(estimateTokens('Selected concise answer'));
    });
  });

  describe('getCompressionThreshold', () => {
    it('should use default values', () => {
      const threshold = getCompressionThreshold();
      expect(threshold).toBe(Math.floor(DEFAULT_MAX_CONTEXT * DEFAULT_THRESHOLD_RATIO));
      expect(threshold).toBe(64_000); // 128k * 0.5
    });

    it('should use custom maxWindowToken', () => {
      const threshold = getCompressionThreshold({ maxWindowToken: 200_000 });
      expect(threshold).toBe(100_000); // 200k * 0.5
    });

    it('should use custom thresholdRatio', () => {
      const threshold = getCompressionThreshold({ thresholdRatio: 0.5 });
      expect(threshold).toBe(64_000); // 128k * 0.5
    });

    it('should use both custom values', () => {
      const threshold = getCompressionThreshold({
        maxWindowToken: 100_000,
        thresholdRatio: 0.8,
      });
      expect(threshold).toBe(80_000); // 100k * 0.8
    });

    it('should floor the result', () => {
      const threshold = getCompressionThreshold({
        maxWindowToken: 100,
        thresholdRatio: 0.33,
      });
      expect(threshold).toBe(33); // floor(100 * 0.33) = 33
    });
  });

  describe('shouldCompress', () => {
    it('should return needsCompression=false when under threshold', () => {
      const messages = [{ content: 'Hi', role: 'user' }];
      const result = shouldCompress(messages);

      expect(result.needsCompression).toBe(false);
      expect(result.currentTokenCount).toBeGreaterThan(0);
      expect(result.threshold).toBe(64_000); // 128k * 0.5
    });

    it('should return needsCompression=true when over threshold', () => {
      // Create a message with usage that exceeds threshold
      const messages = [
        {
          content: '',
          metadata: { usage: { totalOutputTokens: 70_000 } },
          role: 'assistant',
        },
      ];
      const result = shouldCompress(messages);

      expect(result.needsCompression).toBe(true);
      expect(result.currentTokenCount).toBe(70_000);
      expect(result.threshold).toBe(64_000); // 128k * 0.5
    });

    it('should return needsCompression=false when exactly at threshold', () => {
      const messages = [
        {
          content: '',
          metadata: { usage: { totalOutputTokens: 64_000 } },
          role: 'assistant',
        },
      ];
      const result = shouldCompress(messages);

      // Exactly at threshold should not trigger compression
      expect(result.needsCompression).toBe(false);
      expect(result.currentTokenCount).toBe(64_000);
    });

    it('should use custom options', () => {
      const messages = [
        {
          content: '',
          metadata: { usage: { totalOutputTokens: 50_000 } },
          role: 'assistant',
        },
      ];
      const result = shouldCompress(messages, {
        maxWindowToken: 60_000,
        thresholdRatio: 0.75,
      });

      // threshold = 60k * 0.75 = 45k, current = 50k > 45k
      expect(result.needsCompression).toBe(true);
      expect(result.threshold).toBe(45_000);
    });

    it('should handle empty messages', () => {
      const result = shouldCompress([]);

      expect(result.needsCompression).toBe(false);
      expect(result.currentTokenCount).toBe(0);
    });
  });
});
