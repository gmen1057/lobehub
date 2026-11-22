import { describe, expect, it, vi } from 'vitest';

import { parseReferTopicTags, resolveTopicReferences } from '../resolveTopicReferences';

// ============ parseReferTopicTags ============

describe('parseReferTopicTags', () => {
  it('should parse refer_topic tags with name before id', () => {
    const result = parseReferTopicTags([
      { content: '<refer_topic name="My Topic" id="topic-1" />' },
    ]);
    expect(result).toEqual([{ topicId: 'topic-1', topicTitle: 'My Topic' }]);
  });

  it('should parse refer_topic tags with id before name', () => {
    const result = parseReferTopicTags([
      { content: '<refer_topic id="topic-2" name="Other Topic" />' },
    ]);
    expect(result).toEqual([{ topicId: 'topic-2', topicTitle: 'Other Topic' }]);
  });

  it('should deduplicate topic IDs across messages', () => {
    const result = parseReferTopicTags([
      { content: '<refer_topic name="A" id="topic-1" />' },
      { content: '<refer_topic name="A" id="topic-1" />' },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].topicId).toBe('topic-1');
  });

  it('should parse multiple different topics', () => {
    const result = parseReferTopicTags([
      { content: '<refer_topic name="A" id="t1" />\n<refer_topic name="B" id="t2" />' },
    ]);
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.topicId)).toEqual(['t1', 't2']);
  });

  it('should return empty array when no tags found', () => {
    const result = parseReferTopicTags([{ content: 'Hello world' }]);
    expect(result).toEqual([]);
  });

  it('should skip non-string content', () => {
    const result = parseReferTopicTags([{ content: ['array', 'content'] }]);
    expect(result).toEqual([]);
  });

  it('should parse markdown-escaped refer_topic tags', () => {
    const result = parseReferTopicTags([
      { content: 'hi \\<refer\\_topic name="新对话开始" id="tpc\\_867aVIS5Av2G" />' },
    ]);
    expect(result).toEqual([{ topicId: 'tpc_867aVIS5Av2G', topicTitle: '新对话开始' }]);
  });

  it('should parse markdown-escaped tags at start of content', () => {
    const result = parseReferTopicTags([
      { content: '\\<refer\\_topic name="Greeting Message" id="tpc\\_EH0s0KrwpJN2" />讲了啥' },
    ]);
    expect(result).toEqual([{ topicId: 'tpc_EH0s0KrwpJN2', topicTitle: 'Greeting Message' }]);
  });

  it('should parse mixed escaped and non-escaped tags', () => {
    const result = parseReferTopicTags([
      { content: '\\<refer\\_topic name="A" id="tpc\\_1" />' },
      { content: '<refer_topic name="B" id="tpc_2" />' },
    ]);
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.topicId)).toEqual(['tpc_1', 'tpc_2']);
  });
});

// ============ resolveTopicReferences ============

describe('resolveTopicReferences', () => {
  it('should return undefined when no refer_topic tags found', async () => {
    const lookup = vi.fn();
    const result = await resolveTopicReferences([{ content: 'Hello' }], lookup);
    expect(result).toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
  });

  it('should resolve topics with summaries', async () => {
    const lookup = vi.fn().mockResolvedValue({
      historySummary: 'Topic summary content',
      title: 'DB Title',
    });

    const result = await resolveTopicReferences(
      [{ content: '<refer_topic name="UI Title" id="topic-1" />' }],
      lookup,
    );

    expect(result).toEqual([
      { summary: 'Topic summary content', topicId: 'topic-1', topicTitle: 'DB Title' },
    ]);
    expect(lookup).toHaveBeenCalledWith('topic-1');
  });

  it('should resolve topics without summaries', async () => {
    const lookup = vi.fn().mockResolvedValue({ historySummary: null, title: 'Some Topic' });

    const result = await resolveTopicReferences(
      [{ content: '<refer_topic name="Fallback" id="topic-2" />' }],
      lookup,
    );

    expect(result).toEqual([{ summary: undefined, topicId: 'topic-2', topicTitle: 'Some Topic' }]);
  });

  it('should fallback to parsed title when lookup returns null', async () => {
    const lookup = vi.fn().mockResolvedValue(null);

    const result = await resolveTopicReferences(
      [{ content: '<refer_topic name="Parsed Title" id="topic-3" />' }],
      lookup,
    );

    expect(result).toEqual([
      { summary: undefined, topicId: 'topic-3', topicTitle: 'Parsed Title' },
    ]);
  });

  it('should handle lookup errors gracefully', async () => {
    const lookup = vi.fn().mockRejectedValue(new Error('DB error'));

    const result = await resolveTopicReferences(
      [{ content: '<refer_topic name="Error Topic" id="topic-err" />' }],
      lookup,
    );

    expect(result).toEqual([{ topicId: 'topic-err', topicTitle: 'Error Topic' }]);
  });

  it('should handle mixed results', async () => {
    const lookup = vi.fn().mockImplementation(async (id: string) => {
      if (id === 't1') return { historySummary: 'Has summary', title: 'Topic 1' };
      return null;
    });

    const result = await resolveTopicReferences(
      [{ content: '<refer_topic name="A" id="t1" />\n<refer_topic name="B" id="t2" />' }],
      lookup,
    );

    expect(result).toHaveLength(2);
    expect(result![0]).toEqual({ summary: 'Has summary', topicId: 't1', topicTitle: 'Topic 1' });
    expect(result![1]).toEqual({ summary: undefined, topicId: 't2', topicTitle: 'B' });
  });

  it('should fetch recent messages as fallback when no summary and lookupMessages provided', async () => {
    const lookup = vi.fn().mockResolvedValue({ historySummary: null, title: 'No Summary Topic' });
    const lookupMessages = vi.fn().mockResolvedValue([
      { content: 'Hello', role: 'user' },
      { content: 'Hi there!', role: 'assistant' },
      { content: '', role: 'tool' },
      { content: 'Follow up', role: 'user' },
    ]);

    const result = await resolveTopicReferences(
      [{ content: '<refer_topic name="T" id="t1" />' }],
      lookup,
      lookupMessages,
    );

    expect(lookupMessages).toHaveBeenCalledWith('t1');
    expect(result).toHaveLength(1);
    expect(result![0].recentMessages).toHaveLength(3);
    expect(result![0].recentMessages).toEqual([
      { content: 'Hello', role: 'user' },
      { content: 'Hi there!', role: 'assistant' },
      { content: 'Follow up', role: 'user' },
    ]);
    expect(result![0].summary).toBeUndefined();
  });

  it('should truncate long message content to 300 chars', async () => {
    const longContent = 'x'.repeat(500);
    const lookup = vi.fn().mockResolvedValue({ historySummary: null, title: 'T' });
    const lookupMessages = vi.fn().mockResolvedValue([{ content: longContent, role: 'user' }]);

    const result = await resolveTopicReferences(
      [{ content: '<refer_topic name="T" id="t1" />' }],
      lookup,
      lookupMessages,
    );

    expect(result![0].recentMessages![0].content).toHaveLength(303); // 300 + '...'
  });

  it('should take only last 5 messages', async () => {
    const lookup = vi.fn().mockResolvedValue({ historySummary: null, title: 'T' });
    const messages = Array.from({ length: 10 }, (_, i) => ({
      content: `msg ${i}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
    }));
    const lookupMessages = vi.fn().mockResolvedValue(messages);

    const result = await resolveTopicReferences(
      [{ content: '<refer_topic name="T" id="t1" />' }],
      lookup,
      lookupMessages,
    );

    expect(result![0].recentMessages).toHaveLength(5);
    expect(result![0].recentMessages![0].content).toBe('msg 5');
  });

  it('should skip lookupMessages when topic has summary', async () => {
    const lookup = vi.fn().mockResolvedValue({ historySummary: 'Has summary', title: 'T' });
    const lookupMessages = vi.fn();

    const result = await resolveTopicReferences(
      [{ content: '<refer_topic name="T" id="t1" />' }],
      lookup,
      lookupMessages,
    );

    expect(lookupMessages).not.toHaveBeenCalled();
    expect(result![0].summary).toBe('Has summary');
  });

  it('should fall through to no-context when lookupMessages returns empty', async () => {
    const lookup = vi.fn().mockResolvedValue({ historySummary: null, title: 'T' });
    const lookupMessages = vi.fn().mockResolvedValue([]);

    const result = await resolveTopicReferences(
      [{ content: '<refer_topic name="T" id="t1" />' }],
      lookup,
      lookupMessages,
    );

    expect(result![0].summary).toBeUndefined();
    expect(result![0].recentMessages).toBeUndefined();
  });

  it('should sanitize saved /chat/code-artifact/ tags in historySummary and fallback assistant messages', async () => {
    const fileId = '849f7fc2-dd0e-4b18-9aa8-aab327c49b30';
    const rawTag = `<lobeArtifact type="application/lobe.artifacts.code" identifier="code-vb-1" title="Mod1.bas" language="vb" src="/chat/code-artifact/${fileId}/"></lobeArtifact>`;

    const summaryResult = await resolveTopicReferences(
      [{ content: '<refer_topic name="T1" id="t1" />' }],
      vi.fn().mockResolvedValue({ historySummary: `Summary with ${rawTag}`, title: 'T1' }),
    );
    expect(summaryResult![0].summary).toContain(`fileId=${fileId}`);
    expect(summaryResult![0].summary).not.toContain('/chat/code-artifact/');
    expect(summaryResult![0].summary).not.toContain('<lobeArtifact');

    const serializedMultimodal = JSON.stringify([
      { text: `Delivered:\n${rawTag}`, type: 'text' },
      { image: 'https://example.com/a.png', type: 'image' },
    ]);
    const recentResult = await resolveTopicReferences(
      [{ content: '<refer_topic name="T2" id="t2" />' }],
      vi.fn().mockResolvedValue({ historySummary: null, title: 'T2' }),
      vi.fn().mockResolvedValue([
        { content: 'Write Mod1.bas', role: 'user' },
        { content: serializedMultimodal, role: 'assistant' },
      ]),
    );
    expect(recentResult![0].recentMessages![1].content).toContain(`fileId=${fileId}`);
    expect(recentResult![0].recentMessages![1].content).not.toContain('/chat/code-artifact/');
    expect(recentResult![0].recentMessages![1].content).not.toContain('<lobeArtifact');
  });
});
