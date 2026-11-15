import { describe, expect, it, vi } from 'vitest';

import { KnowledgeBaseExecutionRuntime } from './index';

describe('automatic original-file retrieval', () => {
  const getFileContents = vi.fn(async (ids: string[]) =>
    ids.map((fileId) => ({
      fileId,
      filename: 'contacts.vcf',
      content: 'x'.repeat(50_000) + 'Иванов: +70000000000',
    })),
  );
  const semanticSearchForChat = vi.fn(async () => {
    throw new Error('Provider service error');
  });
  const runtime = new KnowledgeBaseExecutionRuntime({ getFileContents, semanticSearchForChat });

  it('recovers known original content after embedding failure', async () => {
    const failed = await runtime.searchKnowledgeBase({ query: 'Иванов', fileIds: ['file-1'] });
    expect(failed.content).toContain('readKnowledge');
    const answer = await runtime.readKnowledge({ fileIds: ['file-1'], query: 'Иванов' });
    expect(answer.success).toBe(true);
    expect(answer.content).toContain('+70000000000');
    expect(answer.content.length).toBeLessThan(22_000);
  });

  it('bounds pages and returns original positions rather than silently truncating', async () => {
    const result = await runtime.readKnowledge({ fileIds: ['file-1'], offset: 20_000 });
    expect(result.content).toContain('"startOffset":20000');
    expect(result.content).toContain('"nextOffset":40000');
  });

  it('rejects unbounded file batches before loading them', async () => {
    const calls = getFileContents.mock.calls.length;
    const result = await runtime.readKnowledge({
      fileIds: Array.from({ length: 9 }, () => 'file-1'),
    });
    expect(result.success).toBe(false);
    expect(getFileContents.mock.calls.length).toBe(calls);
  });

  it('preserves missing/unauthorized file errors rather than fabricating content', async () => {
    const denied = new KnowledgeBaseExecutionRuntime({
      getFileContents: async () => [
        { fileId: 'other-user-file', filename: 'Unknown', content: '', error: 'File not found' },
      ],
      semanticSearchForChat,
    });
    expect((await denied.readKnowledge({ fileIds: ['other-user-file'] })).content).toContain(
      'File not found',
    );
  });
});

describe('search query runtime validation', () => {
  it.each([
    undefined,
    null,
    {},
    { query: null },
    { query: 12 },
    { query: [] },
    { query: '' },
    { query: ' \t\n' },
  ])('rejects invalid args %j without accessing retrieval', async (args) => {
    const semanticSearchForChat = vi.fn();
    const getFileContents = vi.fn();
    const runtime = new KnowledgeBaseExecutionRuntime({ semanticSearchForChat, getFileContents });
    const result = await runtime.searchKnowledgeBase(args as never);
    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(result.content).toContain('Retry searchKnowledgeBase');
    expect(result.content).not.toContain('Search unavailable');
    expect(semanticSearchForChat).not.toHaveBeenCalled();
    expect(getFileContents).not.toHaveBeenCalled();
  });

  it('preserves valid queries and attachment IDs and returns the normal search result', async () => {
    const semanticSearchForChat = vi.fn().mockResolvedValue({ chunks: [], fileResults: [] });
    const runtime = new KnowledgeBaseExecutionRuntime({
      semanticSearchForChat,
      getFileContents: vi.fn(),
    });
    const result = await runtime.searchKnowledgeBase(
      { query: '  actual query  ', fileIds: ['file-1'], topK: 7 },
      { knowledgeBaseIds: ['kb-1'] },
    );
    expect(result.success).toBe(true);
    expect(semanticSearchForChat).toHaveBeenCalledWith(
      { fileIds: ['file-1'], knowledgeIds: ['kb-1'], query: '  actual query  ', topK: 7 },
      undefined,
    );
    expect(result.state).toMatchObject({ totalResults: 0 });
  });
});
