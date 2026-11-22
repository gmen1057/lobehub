import { describe, expect, it } from 'vitest';

import type { Message, PipelineContext } from '../../types';
import { PlaceholderMessageFilter } from '../PlaceholderMessageFilter';

const createContext = (messages: Message[]): PipelineContext => ({
  initialState: { messages: [] },
  isAborted: false,
  messages,
  metadata: {},
});

describe('PlaceholderMessageFilter', () => {
  const filter = new PlaceholderMessageFilter();

  it('should remove empty and "..." placeholder assistant messages and record filteredCount', async () => {
    const context = createContext([
      { content: 'Hello', id: 'u1', role: 'user' },
      {
        content: '...',
        error: { message: 'upstream timeout' },
        id: 'a-placeholder',
        role: 'assistant',
      },
      { content: '   \n\t  ', id: 'a-whitespace', role: 'assistant' },
      { content: '', id: 'a-empty', role: 'assistant' },
      { content: ' ... ', id: 'a-padded-dots', role: 'assistant' },
      { content: null as any, id: 'a-null', role: 'assistant' },
      { content: undefined as any, id: 'a-undef', role: 'assistant' },
      { content: [], id: 'a-empty-parts', role: 'assistant' },
      {
        content: '',
        id: 'a-empty-arrays',
        reasoning: { content: '   ' },
        role: 'assistant',
        tool_calls: [],
        tools: [],
      },
      { content: 'Actual answer', id: 'a-valid', role: 'assistant' },
    ]);

    const result = await filter.process(context);

    expect(result.messages.map((m) => m.id)).toEqual(['u1', 'a-valid']);
    expect(result.metadata.placeholderMessageFilter).toEqual({ filteredCount: 8 });
  });

  it('should never remove user, system, or tool messages even with empty or "..." content', async () => {
    const context = createContext([
      { content: '', id: 's1', role: 'system' },
      { content: '...', id: 'u1', role: 'user' },
      { content: '', id: 't1', role: 'tool', tool_call_id: 'call_1' },
      { content: '....', id: 'a-four-dots', role: 'assistant' },
    ]);

    const result = await filter.process(context);

    expect(result.messages.map((m) => m.id)).toEqual(['s1', 'u1', 't1', 'a-four-dots']);
    expect(result.metadata.placeholderMessageFilter).toEqual({ filteredCount: 0 });
  });

  it('should preserve assistant messages with DB tools or OpenAI tool_calls even when content is empty', async () => {
    const context = createContext([
      {
        content: '',
        id: 'a-db-tools',
        role: 'assistant',
        tools: [{ apiName: 'search', arguments: '{}', id: 'call_1', identifier: 'web' }],
      },
      {
        content: '...',
        id: 'a-openai-tool-calls',
        role: 'assistant',
        tool_calls: [
          {
            function: { arguments: '{}', name: 'web____search' },
            id: 'call_2',
            type: 'function',
          },
        ],
      },
    ]);

    const result = await filter.process(context);

    expect(result.messages.map((m) => m.id)).toEqual(['a-db-tools', 'a-openai-tool-calls']);
    expect(result.metadata.placeholderMessageFilter).toEqual({ filteredCount: 0 });
  });

  it('should preserve assistant messages with reasoning or reasoning_content when content is empty', async () => {
    const context = createContext([
      {
        content: '',
        id: 'a-str-reasoning',
        reasoning: 'Thinking step by step',
        role: 'assistant',
      },
      {
        content: '',
        id: 'a-obj-reasoning',
        reasoning: { content: 'Internal chain of thought' },
        role: 'assistant',
      },
      {
        content: '',
        id: 'a-multimodal-reasoning',
        reasoning: { content: '', isMultimodal: true },
        role: 'assistant',
      },
      {
        content: '',
        id: 'a-signed-reasoning',
        reasoning: { content: '', signature: 'sig_abc' },
        role: 'assistant',
      },
      {
        content: '',
        id: 'a-reasoning-content',
        reasoning_content: 'DeepSeek reasoning',
        role: 'assistant',
      },
    ]);

    const result = await filter.process(context);

    expect(result.messages.map((m) => m.id)).toEqual([
      'a-str-reasoning',
      'a-obj-reasoning',
      'a-multimodal-reasoning',
      'a-signed-reasoning',
      'a-reasoning-content',
    ]);
    expect(result.metadata.placeholderMessageFilter).toEqual({ filteredCount: 0 });
  });

  it('should preserve assistant messages with imageList, fileList, videoList, or multimodal content', async () => {
    const context = createContext([
      {
        content: '',
        id: 'a-gemini-image',
        imageList: [{ id: 'img-1', url: 'https://example.com/image.png' }],
        role: 'assistant',
      },
      {
        content: '',
        fileList: [{ id: 'file-1', name: 'report.pdf', url: 'https://example.com/report.pdf' }],
        id: 'a-file',
        role: 'assistant',
      },
      {
        content: '',
        id: 'a-video',
        role: 'assistant',
        videoList: [{ id: 'vid-1', url: 'https://example.com/video.mp4' }],
      },
      {
        content: [{ image_url: { url: 'https://example.com/image.png' }, type: 'image_url' }],
        id: 'a-parts-array',
        role: 'assistant',
      },
      {
        content: JSON.stringify([{ image: 'https://example.com/image.png', type: 'image' }]),
        id: 'a-serialized-multimodal',
        metadata: { isMultimodal: true },
        role: 'assistant',
      },
      {
        content: '',
        id: 'a-empty-text-multimodal',
        metadata: { isMultimodal: true },
        role: 'assistant',
      },
    ]);

    const result = await filter.process(context);

    expect(result.messages.map((m) => m.id)).toEqual([
      'a-gemini-image',
      'a-file',
      'a-video',
      'a-parts-array',
      'a-serialized-multimodal',
      'a-empty-text-multimodal',
    ]);
    expect(result.metadata.placeholderMessageFilter).toEqual({ filteredCount: 0 });
  });
});
