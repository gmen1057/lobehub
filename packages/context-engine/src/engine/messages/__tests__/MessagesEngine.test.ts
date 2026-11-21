import { describe, expect, it, vi } from 'vitest';

import type { UIChatMessage } from '@/types/index';

import { MessagesEngine } from '../MessagesEngine';
import type { MessagesEngineParams } from '../types';

describe('MessagesEngine', () => {
  const createBasicMessages = (): UIChatMessage[] => [
    {
      content: 'Hello',
      createdAt: Date.now(),
      id: 'msg-1',
      role: 'user',
      updatedAt: Date.now(),
    } as UIChatMessage,
    {
      content: 'Hi there!',
      createdAt: Date.now(),
      id: 'msg-2',
      role: 'assistant',
      updatedAt: Date.now(),
    } as UIChatMessage,
  ];

  const createBasicParams = (overrides?: Partial<MessagesEngineParams>): MessagesEngineParams => ({
    enableSystemDate: false,
    messages: createBasicMessages(),
    model: 'gpt-4',
    provider: 'openai',
    ...overrides,
  });

  describe('constructor', () => {
    it('should initialize with required parameters', () => {
      const params = createBasicParams();
      const engine = new MessagesEngine(params);
      expect(engine).toBeInstanceOf(MessagesEngine);
    });

    it('should initialize with all optional parameters', () => {
      const params = createBasicParams({
        agentBuilderContext: { config: { model: 'gpt-4' } },
        capabilities: {
          isCanUseFC: () => true,
          isCanUseVideo: () => false,
          isCanUseVision: () => true,
        },
        enableHistoryCount: true,
        fileContext: { enabled: true, includeFileUrl: false },
        formatHistorySummary: (s) => `<summary>${s}</summary>`,
        historyCount: 10,
        historySummary: 'Previous conversation summary',
        inputTemplate: '{{text}}',
        knowledge: {
          fileContents: [{ content: 'test', fileId: 'f1', filename: 'test.txt' }],
          knowledgeBases: [{ id: 'kb1', name: 'Knowledge Base 1' }],
        },
        systemRole: 'You are a helpful assistant',
        toolsConfig: {
          manifests: [],
          tools: ['tool1'],
        },
        variableGenerators: {
          date: () => '2024-01-01',
        },
      });

      const engine = new MessagesEngine(params);
      expect(engine).toBeInstanceOf(MessagesEngine);
    });
  });

  describe('process', () => {
    it('should process messages and return result with stats', async () => {
      const params = createBasicParams();
      const engine = new MessagesEngine(params);

      const result = await engine.process();

      expect(result.messages).toBeDefined();
      expect(Array.isArray(result.messages)).toBe(true);
      expect(result.metadata).toBeDefined();
      expect(result.stats).toBeDefined();
      expect(result.stats.processedCount).toBeGreaterThan(0);
      expect(result.stats.totalDuration).toBeGreaterThanOrEqual(0);
    });

    it('should clean up messages to OpenAI format', async () => {
      const params = createBasicParams();
      const engine = new MessagesEngine(params);

      const result = await engine.process();

      // Messages should be cleaned up
      result.messages.forEach((msg) => {
        expect(msg).toHaveProperty('role');
        expect(msg).toHaveProperty('content');
        // Should not have extra fields like createdAt, updatedAt after cleanup
        expect(msg).not.toHaveProperty('createdAt');
        expect(msg).not.toHaveProperty('updatedAt');
      });
    });

    it('should inject system role when provided', async () => {
      const systemRole = 'You are a helpful assistant';
      const params = createBasicParams({ systemRole });
      const engine = new MessagesEngine(params);

      const result = await engine.process();

      // First message should be system role
      expect(result.messages[0].role).toBe('system');
      expect(result.messages[0].content).toBe(systemRole);
    });

    it('should inject history summary when provided', async () => {
      const historySummary = 'We discussed AI and machine learning';
      const params = createBasicParams({ historySummary });
      const engine = new MessagesEngine(params);

      const result = await engine.process();

      // Should contain history summary in system message
      const systemMessages = result.messages.filter((m) => m.role === 'system');
      const hasHistorySummary = systemMessages.some(
        (m) => typeof m.content === 'string' && m.content.includes(historySummary),
      );
      expect(hasHistorySummary).toBe(true);
    });

    it('should use custom formatHistorySummary when provided', async () => {
      const historySummary = 'test summary';
      const formatHistorySummary = vi.fn((s: string) => `<custom>${s}</custom>`);

      const params = createBasicParams({
        formatHistorySummary,
        historySummary,
      });
      const engine = new MessagesEngine(params);

      await engine.process();

      expect(formatHistorySummary).toHaveBeenCalledWith(historySummary);
    });

    it('should handle empty messages', async () => {
      const params = createBasicParams({ messages: [] });
      const engine = new MessagesEngine(params);

      const result = await engine.process();

      expect(result.messages).toEqual([]);
    });
  });

  describe('processMessages', () => {
    it('should return only messages array', async () => {
      const params = createBasicParams();
      const engine = new MessagesEngine(params);

      const messages = await engine.processMessages();

      expect(Array.isArray(messages)).toBe(true);
      messages.forEach((msg) => {
        expect(msg).toHaveProperty('role');
        expect(msg).toHaveProperty('content');
      });
    });
  });

  describe('capabilities injection', () => {
    it('should use provided isCanUseFC', async () => {
      const isCanUseFC = vi.fn().mockReturnValue(true);
      const params = createBasicParams({
        capabilities: { isCanUseFC },
        toolsConfig: { tools: ['tool1'] },
      });
      const engine = new MessagesEngine(params);

      await engine.process();

      // isCanUseFC should be called during tool processing
      expect(isCanUseFC).toHaveBeenCalled();
    });

    it('should use provided isCanUseVision', async () => {
      const isCanUseVision = vi.fn().mockReturnValue(true);
      const messages: UIChatMessage[] = [
        {
          content: 'Check this image',
          createdAt: Date.now(),
          id: 'msg-1',
          imageList: [{ id: 'img-1', url: 'https://example.com/image.png' }],
          role: 'user',
          updatedAt: Date.now(),
        } as unknown as UIChatMessage,
      ];

      const params = createBasicParams({
        capabilities: { isCanUseVision },
        messages,
      });
      const engine = new MessagesEngine(params);

      await engine.process();

      expect(isCanUseVision).toHaveBeenCalled();
    });

    it('should default to true for isCanUseFC when not provided', async () => {
      const params = createBasicParams({
        toolsConfig: { tools: ['tool1'] },
      });
      const engine = new MessagesEngine(params);

      // Should not throw
      const result = await engine.process();
      expect(result).toBeDefined();
    });
  });

  describe('variable generators', () => {
    it('should replace placeholders with generated values', async () => {
      const messages: UIChatMessage[] = [
        {
          content: 'Today is {{date}}',
          createdAt: Date.now(),
          id: 'msg-1',
          role: 'user',
          updatedAt: Date.now(),
        } as UIChatMessage,
      ];

      const params = createBasicParams({
        messages,
        variableGenerators: {
          date: () => '2024-01-01',
        },
      });
      const engine = new MessagesEngine(params);

      const result = await engine.process();

      const userMessage = result.messages.find((m) => m.role === 'user');
      expect(userMessage?.content).toBe('Today is 2024-01-01');
    });
  });

  describe('knowledge injection', () => {
    it('should inject file contents', async () => {
      const params = createBasicParams({
        knowledge: {
          fileContents: [
            {
              content: 'File content here',
              fileId: 'file-1',
              filename: 'test.txt',
            },
          ],
        },
      });
      const engine = new MessagesEngine(params);

      const result = await engine.process();

      // Should have knowledge injected
      expect(result.metadata.knowledgeInjected).toBe(true);
    });

    it('should inject knowledge bases', async () => {
      const params = createBasicParams({
        knowledge: {
          knowledgeBases: [
            {
              description: 'Test knowledge base',
              id: 'kb-1',
              name: 'Test KB',
            },
          ],
        },
      });
      const engine = new MessagesEngine(params);

      const result = await engine.process();

      expect(result.metadata.knowledgeInjected).toBe(true);
    });
  });

  describe('Agent Builder context', () => {
    it('should inject Agent Builder context when provided', async () => {
      const params = createBasicParams({
        agentBuilderContext: {
          config: { model: 'gpt-4', systemRole: 'Test role' },
          meta: { description: 'Test agent', title: 'Test' },
        },
      });
      const engine = new MessagesEngine(params);

      const result = await engine.process();

      expect(result.metadata.agentBuilderContextInjected).toBe(true);
    });

    it('should not inject Agent Builder context when not provided', async () => {
      const params = createBasicParams();
      const engine = new MessagesEngine(params);

      const result = await engine.process();

      expect(result.metadata.agentBuilderContextInjected).toBeUndefined();
    });
  });

  describe('file context', () => {
    it('should use provided file context config', async () => {
      const params = createBasicParams({
        fileContext: {
          enabled: true,
          includeFileUrl: false,
        },
      });
      const engine = new MessagesEngine(params);

      // Should not throw
      const result = await engine.process();
      expect(result).toBeDefined();
    });

    it('should default to enabled with includeFileUrl true', async () => {
      const params = createBasicParams();
      const engine = new MessagesEngine(params);

      // Should not throw
      const result = await engine.process();
      expect(result).toBeDefined();
    });
  });

  describe('tools config', () => {
    it('should handle tools configuration with manifests', async () => {
      const mockManifests = [
        {
          identifier: 'tool1',
          api: [{ name: 'action', description: 'Tool 1 action', parameters: {} }],
          meta: { title: 'Tool 1' },
          type: 'default' as const,
        },
        {
          identifier: 'tool2',
          api: [{ name: 'action', description: 'Tool 2 action', parameters: {} }],
          meta: { title: 'Tool 2' },
          type: 'default' as const,
        },
      ];

      const params = createBasicParams({
        capabilities: { isCanUseFC: () => true },
        toolsConfig: {
          manifests: mockManifests,
          tools: ['tool1', 'tool2'],
        },
      });
      const engine = new MessagesEngine(params);

      const result = await engine.process();

      // Should inject tool system role when manifests are provided
      const systemMessage = result.messages.find((msg) => msg.role === 'system');
      expect(systemMessage).toBeDefined();
      expect(systemMessage!.content).toContain('Tool 1');
    });

    it('should skip tool system role provider when no tools', async () => {
      const params = createBasicParams({
        toolsConfig: { tools: [] },
      });
      const engine = new MessagesEngine(params);

      // Should not throw
      const result = await engine.process();
      expect(result).toBeDefined();
    });
  });

  describe('input template', () => {
    it('should apply input template to user messages', async () => {
      const messages: UIChatMessage[] = [
        {
          content: 'user input',
          createdAt: Date.now(),
          id: 'msg-1',
          role: 'user',
          updatedAt: Date.now(),
        } as UIChatMessage,
      ];

      const params = createBasicParams({
        inputTemplate: 'Please respond to: {{text}}',
        messages,
      });
      const engine = new MessagesEngine(params);

      const result = await engine.process();

      const userMessage = result.messages.find((m) => m.role === 'user');
      expect(userMessage?.content).toBe('Please respond to: user input');
    });
  });

  describe('Page Editor context', () => {
    it('should inject page content to the last user message when pageContentContext is provided', async () => {
      const messages: UIChatMessage[] = [
        {
          content: 'First question',
          createdAt: Date.now(),
          id: 'msg-1',
          role: 'user',
          updatedAt: Date.now(),
        } as UIChatMessage,
        {
          content: 'Answer',
          createdAt: Date.now(),
          id: 'msg-2',
          role: 'assistant',
          updatedAt: Date.now(),
        } as UIChatMessage,
        {
          content: 'Second question about the page',
          createdAt: Date.now(),
          id: 'msg-3',
          role: 'user',
          updatedAt: Date.now(),
        } as UIChatMessage,
      ];

      const params = createBasicParams({
        messages,
        pageContentContext: {
          markdown: '# Document Title\n\nDocument content here.',
          metadata: {
            charCount: 40,
            lineCount: 3,
            title: 'Test Document',
          },
        },
      });
      const engine = new MessagesEngine(params);

      const result = await engine.process();

      expect(result.messages).toEqual([
        { content: 'First question', role: 'user' },
        { content: 'Answer', role: 'assistant' },
        {
          content: `Second question about the page

<!-- SYSTEM CONTEXT (NOT PART OF USER QUERY) -->
<context.instruction>following part contains context information injected by the system. Please follow these instructions:

1. Always prioritize handling user-visible content.
2. the context is only required when user's queries rely on it.
</context.instruction>
<current_page_context>
<current_page title="Test Document">
<markdown chars="40" lines="3">
# Document Title

Document content here.
</markdown>
</current_page>
</current_page_context>
<!-- END SYSTEM CONTEXT -->`,
          role: 'user',
        },
      ]);

      expect(result.metadata.pageEditorContextInjected).toBe(true);
    });

    it('should not inject page content when not enabled', async () => {
      const messages: UIChatMessage[] = [
        {
          content: 'Question',
          createdAt: Date.now(),
          id: 'msg-1',
          role: 'user',
          updatedAt: Date.now(),
        } as UIChatMessage,
      ];

      const params = createBasicParams({ messages });
      const engine = new MessagesEngine(params);

      const result = await engine.process();

      expect(result.messages).toEqual([{ content: 'Question', role: 'user' }]);
      expect(result.metadata.pageEditorContextInjected).toBeUndefined();
    });
  });

  describe('Page Selections', () => {
    it('should inject page selections to each user message that has them', async () => {
      const messages: UIChatMessage[] = [
        {
          content: 'First question with selection',
          createdAt: Date.now(),
          id: 'msg-1',
          metadata: {
            pageSelections: [
              {
                content: 'Selected paragraph 1',
                id: 'sel-1',
                pageId: 'page-1',
                xml: '<p>Selected paragraph 1</p>',
              },
            ],
          },
          role: 'user',
          updatedAt: Date.now(),
        } as UIChatMessage,
        {
          content: 'Answer to first',
          createdAt: Date.now(),
          id: 'msg-2',
          role: 'assistant',
          updatedAt: Date.now(),
        } as UIChatMessage,
        {
          content: 'Second question with different selection',
          createdAt: Date.now(),
          id: 'msg-3',
          metadata: {
            pageSelections: [
              {
                content: 'Selected paragraph 2',
                id: 'sel-2',
                pageId: 'page-1',
                xml: '<p>Selected paragraph 2</p>',
              },
            ],
          },
          role: 'user',
          updatedAt: Date.now(),
        } as UIChatMessage,
      ];

      const params = createBasicParams({
        messages,
        pageContentContext: {
          markdown: '# Doc',
          metadata: { title: 'Doc' },
        },
      });
      const engine = new MessagesEngine(params);

      const result = await engine.process();

      expect(result.messages).toEqual([
        {
          content: `First question with selection

<!-- SYSTEM CONTEXT (NOT PART OF USER QUERY) -->
<context.instruction>following part contains context information injected by the system. Please follow these instructions:

1. Always prioritize handling user-visible content.
2. the context is only required when user's queries rely on it.
</context.instruction>
<user_page_selections>
<user_selections count="1">
<selection >
<p>Selected paragraph 1</p>
</selection>
</user_selections>
</user_page_selections>
<!-- END SYSTEM CONTEXT -->`,
          role: 'user',
        },
        { content: 'Answer to first', role: 'assistant' },
        {
          content: `Second question with different selection

<!-- SYSTEM CONTEXT (NOT PART OF USER QUERY) -->
<context.instruction>following part contains context information injected by the system. Please follow these instructions:

1. Always prioritize handling user-visible content.
2. the context is only required when user's queries rely on it.
</context.instruction>
<user_page_selections>
<user_selections count="1">
<selection >
<p>Selected paragraph 2</p>
</selection>
</user_selections>
</user_page_selections>
<current_page_context>
<current_page title="Doc">
<markdown chars="5" lines="1">
# Doc
</markdown>
</current_page>
</current_page_context>
<!-- END SYSTEM CONTEXT -->`,
          role: 'user',
        },
      ]);
    });

    it('should skip user messages without pageSelections', async () => {
      const messages: UIChatMessage[] = [
        {
          content: 'No selection here',
          createdAt: Date.now(),
          id: 'msg-1',
          role: 'user',
          updatedAt: Date.now(),
        } as UIChatMessage,
        {
          content: 'Answer',
          createdAt: Date.now(),
          id: 'msg-2',
          role: 'assistant',
          updatedAt: Date.now(),
        } as UIChatMessage,
        {
          content: 'With selection',
          createdAt: Date.now(),
          id: 'msg-3',
          metadata: {
            pageSelections: [
              {
                content: 'Selected text',
                id: 'sel-1',
                pageId: 'page-1',
                xml: '<span>Selected text</span>',
              },
            ],
          },
          role: 'user',
          updatedAt: Date.now(),
        } as UIChatMessage,
      ];

      const params = createBasicParams({
        messages,
        pageContentContext: {
          markdown: '# Doc',
          metadata: { title: 'Doc' },
        },
      });
      const engine = new MessagesEngine(params);

      const result = await engine.process();

      expect(result.messages).toEqual([
        { content: 'No selection here', role: 'user' },
        { content: 'Answer', role: 'assistant' },
        {
          content: `With selection

<!-- SYSTEM CONTEXT (NOT PART OF USER QUERY) -->
<context.instruction>following part contains context information injected by the system. Please follow these instructions:

1. Always prioritize handling user-visible content.
2. the context is only required when user's queries rely on it.
</context.instruction>
<user_page_selections>
<user_selections count="1">
<selection >
<span>Selected text</span>
</selection>
</user_selections>
</user_page_selections>
<current_page_context>
<current_page title="Doc">
<markdown chars="5" lines="1">
# Doc
</markdown>
</current_page>
</current_page_context>
<!-- END SYSTEM CONTEXT -->`,
          role: 'user',
        },
      ]);
    });

    it('should have only one SYSTEM CONTEXT wrapper when both selections and page content are injected', async () => {
      const messages: UIChatMessage[] = [
        {
          content: 'Question about selection',
          createdAt: Date.now(),
          id: 'msg-1',
          metadata: {
            pageSelections: [
              {
                content: 'Selected text',
                id: 'sel-1',
                pageId: 'page-1',
                xml: '<p>Selected text</p>',
              },
            ],
          },
          role: 'user',
          updatedAt: Date.now(),
        } as UIChatMessage,
      ];

      const params = createBasicParams({
        messages,
        pageContentContext: {
          markdown: '# Full Document',
          metadata: { title: 'Full Doc' },
        },
      });
      const engine = new MessagesEngine(params);

      const result = await engine.process();

      expect(result.messages).toEqual([
        {
          content: `Question about selection

<!-- SYSTEM CONTEXT (NOT PART OF USER QUERY) -->
<context.instruction>following part contains context information injected by the system. Please follow these instructions:

1. Always prioritize handling user-visible content.
2. the context is only required when user's queries rely on it.
</context.instruction>
<user_page_selections>
<user_selections count="1">
<selection >
<p>Selected text</p>
</selection>
</user_selections>
</user_page_selections>
<current_page_context>
<current_page title="Full Doc">
<markdown chars="15" lines="1">
# Full Document
</markdown>
</current_page>
</current_page_context>
<!-- END SYSTEM CONTEXT -->`,
          role: 'user',
        },
      ]);
    });

    it('should not inject selections when page editor is not enabled', async () => {
      const messages: UIChatMessage[] = [
        {
          content: 'Question',
          createdAt: Date.now(),
          id: 'msg-1',
          metadata: {
            pageSelections: [
              { content: 'Selected', id: 'sel-1', pageId: 'page-1', xml: '<p>Selected</p>' },
            ],
          },
          role: 'user',
          updatedAt: Date.now(),
        } as UIChatMessage,
      ];

      // No pageContentContext or initialContext.pageEditor means not enabled
      const params = createBasicParams({ messages });
      const engine = new MessagesEngine(params);

      const result = await engine.process();

      expect(result.messages).toEqual([{ content: 'Question', role: 'user' }]);
    });
  });

  describe('context guards (PlaceholderMessageFilter & DisabledToolCallFilter)', () => {
    it('should drop empty and "..." assistant stubs before MessageCleanupProcessor keeping messageSourceIds 1:1 aligned', async () => {
      const messages: UIChatMessage[] = [
        {
          content: 'Turn 1 question',
          createdAt: 1,
          id: 'u-1',
          role: 'user',
          updatedAt: 1,
        } as UIChatMessage,
        {
          content: '...',
          createdAt: 2,
          error: { message: 'upstream failed', type: 'ProviderBizError' } as any,
          id: 'broken-1',
          role: 'assistant',
          updatedAt: 2,
        } as UIChatMessage,
        {
          content: '',
          createdAt: 3,
          id: 'broken-2',
          role: 'assistant',
          updatedAt: 3,
        } as UIChatMessage,
        {
          content: 'Turn 1 valid reply',
          createdAt: 4,
          id: 'a-1',
          role: 'assistant',
          updatedAt: 4,
        } as UIChatMessage,
        {
          content: 'Turn 2 question',
          createdAt: 5,
          id: 'u-2',
          role: 'user',
          updatedAt: 5,
        } as UIChatMessage,
      ];

      const engine = new MessagesEngine(
        createBasicParams({
          messages,
          systemRole: 'System prompt',
        }),
      );

      const result = await engine.process();

      expect(result.metadata.placeholderMessageFilter).toEqual({ filteredCount: 2 });
      expect(result.messages).toEqual([
        { content: 'System prompt', role: 'system' },
        { content: 'Turn 1 question', role: 'user' },
        { content: 'Turn 1 valid reply', role: 'assistant' },
        { content: 'Turn 2 question', role: 'user' },
      ]);
      expect(result.metadata.messageSourceIds).toHaveLength(result.messages.length);
      expect(result.metadata.messageSourceIds?.[0]).toMatch(/^system-/);
      expect(result.metadata.messageSourceIds?.slice(1)).toEqual(['u-1', 'a-1', 'u-2']);
    });

    it('should preserve assistant messages with empty content when imageList, reasoning, or DB tools are present', async () => {
      const messages: UIChatMessage[] = [
        {
          content: 'Generate image, think, and search',
          createdAt: 1,
          id: 'u-1',
          role: 'user',
          updatedAt: 1,
        } as UIChatMessage,
        {
          content: '',
          createdAt: 2,
          id: 'a-gemini-img',
          imageList: [{ alt: 'gen', id: 'img-1', url: 'https://example.com/cat.png' }],
          role: 'assistant',
          updatedAt: 2,
        } as UIChatMessage,
        {
          content: '',
          createdAt: 3,
          id: 'a-reasoning',
          reasoning: { content: 'Deliberating...' },
          role: 'assistant',
          updatedAt: 3,
        } as UIChatMessage,
        {
          content: '',
          createdAt: 4,
          id: 'a-tool-call',
          role: 'assistant',
          tools: [
            {
              apiName: 'search',
              arguments: '{"q":"cats"}',
              id: 'call_search_1',
              identifier: 'lobe-web-browsing',
              type: 'builtin',
            },
          ],
          updatedAt: 4,
        } as UIChatMessage,
        {
          content: '{"results":[]}',
          createdAt: 5,
          id: 't-search-1',
          plugin: {
            apiName: 'search',
            arguments: '{"q":"cats"}',
            identifier: 'lobe-web-browsing',
            type: 'builtin',
          },
          role: 'tool',
          tool_call_id: 'call_search_1',
          updatedAt: 5,
        } as UIChatMessage,
      ];

      const engine = new MessagesEngine(
        createBasicParams({
          capabilities: {
            isCanUseFC: () => true,
            isCanUseVision: () => true,
          },
          messages,
        }),
      );

      const result = await engine.process();

      expect(result.metadata.placeholderMessageFilter).toEqual({ filteredCount: 0 });
      expect(result.metadata.messageSourceIds).toEqual([
        'u-1',
        'a-gemini-img',
        'a-reasoning',
        'a-tool-call',
        't-search-1',
      ]);
      expect(result.messages[1]).toEqual({
        content: [
          {
            image_url: { detail: 'auto', url: 'https://example.com/cat.png' },
            type: 'image_url',
          },
        ],
        role: 'assistant',
      });
      expect(result.messages[2]).toMatchObject({
        content: '',
        reasoning: { content: 'Deliberating...' },
        role: 'assistant',
      });
      expect(result.messages[3]).toMatchObject({
        content: '',
        role: 'assistant',
        tool_calls: [
          {
            function: {
              arguments: '{"q":"cats"}',
              name: 'lobe-web-browsing____search____builtin',
            },
            id: 'call_search_1',
            type: 'function',
          },
        ],
      });
      expect(result.messages[4]).toMatchObject({
        content: '{"results":[]}',
        role: 'tool',
        tool_call_id: 'call_search_1',
      });
    });

    it('should filter disabled tool calls, drop emptied assistant turns, and let ToolMessageReorder prune orphaned tool results', async () => {
      const messages: UIChatMessage[] = [
        {
          content: 'Old studio turn',
          createdAt: 1,
          id: 'u-1',
          role: 'user',
          updatedAt: 1,
        } as UIChatMessage,
        {
          content: '',
          createdAt: 2,
          id: 'a-disabled-only',
          role: 'assistant',
          tools: [
            {
              apiName: 'createImage',
              arguments: '{"prompt":"sunset"}',
              id: 'call_disabled_1',
              identifier: 'arckep-studio',
              type: 'builtin',
            },
          ],
          updatedAt: 2,
        } as UIChatMessage,
        {
          content: '{"imageUrl":"https://example.com/old.png"}',
          createdAt: 3,
          id: 't-disabled-1',
          plugin: {
            apiName: 'createImage',
            arguments: '{"prompt":"sunset"}',
            identifier: 'arckep-studio',
            type: 'builtin',
          },
          role: 'tool',
          tool_call_id: 'call_disabled_1',
          updatedAt: 3,
        } as UIChatMessage,
        {
          content: 'Mixed turn with text and disabled tool',
          createdAt: 4,
          id: 'a-mixed',
          role: 'assistant',
          tools: [
            {
              apiName: 'createImage',
              arguments: '{"prompt":"sunrise"}',
              id: 'call_disabled_2',
              identifier: 'arckep-studio',
              type: 'builtin',
            },
            {
              apiName: 'search',
              arguments: '{"q":"sunrise"}',
              id: 'call_enabled_2',
              identifier: 'lobe-web-browsing',
              type: 'builtin',
            },
          ],
          updatedAt: 4,
        } as UIChatMessage,
        {
          content: '{"imageUrl":"https://example.com/old2.png"}',
          createdAt: 5,
          id: 't-disabled-2',
          role: 'tool',
          tool_call_id: 'call_disabled_2',
          updatedAt: 5,
        } as UIChatMessage,
        {
          content: '{"results":["ok"]}',
          createdAt: 6,
          id: 't-enabled-2',
          role: 'tool',
          tool_call_id: 'call_enabled_2',
          updatedAt: 6,
        } as UIChatMessage,
        {
          content: 'Follow-up question',
          createdAt: 7,
          id: 'u-2',
          role: 'user',
          updatedAt: 7,
        } as UIChatMessage,
      ];

      const engine = new MessagesEngine(
        createBasicParams({
          capabilities: {
            isCanUseFC: () => true,
            isCanUseVision: () => true,
          },
          messages,
          toolsConfig: {
            disabledToolIdentifiers: ['arckep-studio'],
            tools: ['lobe-web-browsing'],
          },
        }),
      );

      const result = await engine.process();

      expect(result.metadata.disabledToolCallFilter).toEqual({
        filteredAssistantMessages: 2,
        filteredToolCalls: 2,
      });
      expect(result.metadata.toolMessageReorder?.removedInvalidTools).toBe(2);
      expect(result.metadata.messageSourceIds).toEqual(['u-1', 'a-mixed', 't-enabled-2', 'u-2']);
      expect(result.messages).toEqual([
        { content: 'Old studio turn', role: 'user' },
        {
          content: 'Mixed turn with text and disabled tool',
          role: 'assistant',
          tool_calls: [
            {
              function: {
                arguments: '{"q":"sunrise"}',
                name: 'lobe-web-browsing____search____builtin',
              },
              id: 'call_enabled_2',
              type: 'function',
            },
          ],
        },
        {
          content: '{"results":["ok"]}',
          role: 'tool',
          tool_call_id: 'call_enabled_2',
        },
        { content: 'Follow-up question', role: 'user' },
      ]);
    });
  });
});
