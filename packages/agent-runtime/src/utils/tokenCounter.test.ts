import { estimateTokenCount } from 'tokenx';
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

    it('should estimate Cyrillic prose ~2x higher than tokenx default Latin fallback', () => {
      const russianProse =
        'Привет! Пожалуйста, проанализируй архитектуру нашей системы управления контекстом и предложи оптимальные пороги автосжатия для длинных диалогов на русском языке. '.repeat(
          20,
        );
      const defaultTokens = estimateTokenCount(russianProse);
      const cyrillicAwareTokens = estimateTokens(russianProse);

      expect(cyrillicAwareTokens).toBeGreaterThan(defaultTokens * 1.9);
      const charsPerToken = russianProse.length / cyrillicAwareTokens;
      expect(charsPerToken).toBeGreaterThan(1.8);
      expect(charsPerToken).toBeLessThan(2.6);
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

    it('should anchor on latest top-level assistant totalInputTokens and add only post-anchor delta', () => {
      const replyText = 'Short answer';
      const followUpUser = 'А теперь разбери следующий шаг подробнее.';
      const toolOutput = 'Tool payload line '.repeat(40);
      const toolCalls = [{ function: { arguments: '{"path":"a.ts"}', name: 'read' }, id: 'tc1' }];

      const tokens = calculateMessageTokens([
        // Huge earlier history is superseded by provider-reported totalInputTokens on the anchor
        { content: 'Old user turn '.repeat(5_000), role: 'user' },
        {
          content: 'Old assistant turn '.repeat(5_000),
          metadata: { totalOutputTokens: 20_000 },
          role: 'assistant',
        },
        {
          content: replyText,
          // Archived reasoning object & totalOutputTokens (including thinking) must NOT inflate the delta
          metadata: {
            usage: {
              outputTextTokens: 120,
              totalInputTokens: 150_000,
              totalOutputTokens: 25_000,
            },
          },
          reasoning: { content: 'Archived reasoning '.repeat(5_000), duration: 12_000 },
          role: 'assistant',
          tool_calls: toolCalls,
        },
        { content: toolOutput, role: 'tool' },
        { content: followUpUser, role: 'user' },
      ]);

      const expected =
        150_000 +
        Math.max(120, estimateTokens(replyText) + estimateTokens(toolCalls)) +
        estimateTokens(toolOutput) +
        estimateTokens(followUpUser);

      expect(tokens).toBe(expected);
    });

    it('should not double-count large tool_calls payload when outputTextTokens already includes tool-call tokens', () => {
      const largeArtifactArgs = JSON.stringify({
        content: 'const row = { value: "artifact payload line" };\n'.repeat(1_500),
        identifier: 'dashboard',
        title: 'Dashboard',
      });
      const largeToolCalls = [
        {
          function: { arguments: largeArtifactArgs, name: 'writeArtifact' },
          id: 'tc-large-1',
          type: 'function',
        },
      ];
      const estimatedToolTokens = estimateTokens(largeToolCalls);
      // Simulate OpenAI/Google usage where outputTextTokens (= totalOutputTokens - outputReasoningTokens)
      // already accounts for the tool-call JSON arguments (~slightly above heuristic estimate).
      const providerOutputTextTokens = estimatedToolTokens + 250;

      const tokens = calculateMessageTokens([
        { content: 'Build a full interactive dashboard', role: 'user' },
        {
          content: 'Writing artifact...',
          role: 'assistant',
          tool_calls: largeToolCalls,
          usage: {
            outputTextTokens: providerOutputTextTokens,
            totalInputTokens: 200_000,
            totalOutputTokens: providerOutputTextTokens + 8_000,
          },
        },
        { content: 'Artifact saved.', role: 'tool' },
      ]);

      const expected =
        200_000 +
        Math.max(
          providerOutputTextTokens,
          estimateTokens('Writing artifact...') + estimatedToolTokens,
        ) +
        estimateTokens('Artifact saved.');
      expect(tokens).toBe(expected);
      // Confirm no double-counting: must stay far below 200_000 + 2 * estimatedToolTokens
      expect(tokens).toBeLessThan(200_000 + providerOutputTextTokens + 500);
    });

    it('should include explicit inline reasoning_content on active anchored assistant message', () => {
      const inlineThought = 'Step-by-step reasoning kept in DeepSeek mid-turn context. '.repeat(20);
      const tokens = calculateMessageTokens([
        { content: 'Question', role: 'user' },
        {
          content: 'Answer',
          reasoning_content: inlineThought,
          role: 'assistant',
          usage: { totalInputTokens: 40_000 },
        },
      ]);

      expect(tokens).toBe(40_000 + estimateTokens('Answer') + estimateTokens(inlineThought));
    });

    it('should anchor on latest assistantGroup/supervisor child totalInputTokens, include child tool results and trailing children, and ignore aggregated top-level usage', () => {
      const child0ToolCall = {
        apiName: 'search',
        arguments: '{"q":"context"}',
        id: 'tc-1',
        identifier: 'web',
        type: 'builtin',
      };
      const child0ToolResult = 'Search result body '.repeat(60);
      const child1Content = 'Final synthesis after tool call.';
      const trailingUser = 'Follow-up user question';

      const tokens = calculateMessageTokens([
        { content: 'Initial huge prompt '.repeat(3_000), role: 'user' },
        {
          children: [
            {
              content: 'Running search...',
              metadata: { totalInputTokens: 90_000 },
              tools: [
                {
                  ...child0ToolCall,
                  result: {
                    content: child0ToolResult,
                    id: 'tm-1',
                    // Internal UI/plugin state must never be counted
                    state: { blob: 'x'.repeat(200_000) },
                  },
                },
              ],
            },
            {
              content: child1Content,
              usage: { totalOutputTokens: 45 },
            },
          ],
          content: '',
          role: 'assistantGroup',
          // Aggregated top-level usage across all children must NOT be used as anchor
          usage: { totalInputTokens: 999_999, totalOutputTokens: 999_999 },
        },
        { content: trailingUser, role: 'user' },
      ]);

      const expectedChild0ToolCallTokens = estimateTokens([child0ToolCall]);
      const expected =
        90_000 +
        estimateTokens('Running search...') +
        expectedChild0ToolCallTokens +
        estimateTokens(child0ToolResult) +
        Math.max(45, estimateTokens(child1Content)) +
        estimateTokens(trailingUser);

      expect(tokens).toBe(expected);
    });

    it('should reject stale pre-/compact totalInputTokens via compressedGroup timestamp and accept fresh post-compaction anchors', () => {
      const compactedAt = Date.parse('2026-11-24T12:00:00.000Z');
      const beforeCompaction = Date.parse('2026-11-24T11:55:00.000Z');
      const afterCompaction = Date.parse('2026-11-24T12:05:00.000Z');

      // Manual /compact kept a recent pre-compaction exchange whose usage.totalInputTokens reflects pre-compact 320K context
      const staleMessages = [
        {
          content: 'Concise compacted summary.',
          createdAt: compactedAt,
          role: 'compressedGroup',
          updatedAt: compactedAt,
        },
        { content: 'Recent user prompt', createdAt: beforeCompaction, role: 'user' },
        {
          content: 'Recent assistant reply',
          createdAt: beforeCompaction,
          role: 'assistant',
          usage: { totalInputTokens: 320_000, totalOutputTokens: 30 },
        },
        { content: 'New follow-up after compact', createdAt: afterCompaction, role: 'user' },
      ];

      const staleCount = calculateMessageTokens(staleMessages);
      expect(staleCount).toBeLessThan(1_000);

      // Unstamped assistant message after a timestamped compressedGroup must also be rejected as stale
      const unstampedAfterCompressed = calculateMessageTokens([
        {
          content: 'Concise compacted summary.',
          createdAt: compactedAt,
          role: 'compressedGroup',
          updatedAt: compactedAt,
        },
        {
          content: 'Ambiguous assistant reply',
          role: 'assistant',
          usage: { totalInputTokens: 320_000, totalOutputTokens: 30 },
        },
      ]);
      expect(unstampedAfterCompressed).toBeLessThan(1_000);

      // Once a post-compaction LLM call completes (createdAt >= lastCompressedAt), anchor on its exact totalInputTokens
      const freshMessages = [
        ...staleMessages,
        {
          content: 'Post-compaction reply',
          createdAt: afterCompaction + 1_000,
          role: 'assistant',
          usage: { totalInputTokens: 14_500 },
        },
      ];
      expect(calculateMessageTokens(freshMessages)).toBe(
        14_500 + estimateTokens('Post-compaction reply'),
      );
    });

    it('should never use totalInputTokens from messages before the last compressedGroup', () => {
      const tokens = calculateMessageTokens([
        {
          content: 'Ancient reply',
          role: 'assistant',
          usage: { totalInputTokens: 500_000 },
        },
        { content: 'Summary only.', role: 'compressedGroup' },
        { content: 'Fresh short turn', role: 'user' },
      ]);
      expect(tokens).toBe(
        estimateTokens('Ancient reply') +
          estimateTokens('Summary only.') +
          estimateTokens('Fresh short turn'),
      );
    });

    it('should keep calculatePromptTokens on heuristic counting without anchor interference', () => {
      const russianText = 'Проверка расчёта токенов собранного промпта на русском языке.';
      const promptTokens = calculatePromptTokens([
        {
          content: russianText,
          metadata: { totalInputTokens: 500_000 },
          role: 'assistant',
          usage: { totalInputTokens: 500_000 },
        },
      ]);
      expect(promptTokens).toBe(estimateTokens(russianText) + 4);
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
