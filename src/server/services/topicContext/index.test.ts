import { describe, expect, it, vi } from 'vitest';

import { getTopicContext } from './index';

const { findTopic, queryMessages } = vi.hoisted(() => ({
  findTopic: vi.fn(),
  queryMessages: vi.fn(),
}));
vi.mock('@/database/models/topic', () => ({
  TopicModel: class {
    findById = findTopic;
  },
}));
vi.mock('@/database/models/message', () => ({
  MessageModel: class {
    query = queryMessages;
  },
}));

describe('original conversation archive', () => {
  it('keeps the requested snapshot timestamp on subsequent pages', async () => {
    findTopic.mockResolvedValue({});
    let filters: any;
    const lte = vi.fn();
    const findMany = vi.fn(async (options) => {
      filters = options;
      return [];
    });
    const snapshotAt = '2026-09-16T08:00:00.000Z';
    const select = vi.fn(() => ({ from: () => ({ where: () => ({}) }) }));
    const result = await getTopicContext(
      { query: { messages: { findMany } }, select } as any,
      'owner',
      {
        topicId: 'own',
        mode: 'archive',
        offset: 20000,
        snapshotAt,
      },
    );
    filters.where(
      { createdAt: 'created_at' },
      { and: vi.fn(), eq: vi.fn(), lte, notExists: vi.fn() },
    );
    expect(lte).toHaveBeenCalledWith('created_at', new Date(snapshotAt));
    expect(result.content).toContain(snapshotAt);
  });

  it('refuses a missing or foreign topic before accessing its messages', async () => {
    findTopic.mockResolvedValue(undefined);
    const findMany = vi.fn();
    const result = await getTopicContext({ query: { messages: { findMany } } } as any, 'owner', {
      topicId: 'foreign',
      mode: 'archive',
    });
    expect(result.success).toBe(false);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('retrieves exact details from old messages rather than returning the summary again', async () => {
    findTopic.mockResolvedValue({ historySummary: 'A summary without the exact amount' });
    const findMany = vi.fn(async () => [
      { id: 'old', role: 'user', content: 'x'.repeat(50_000) + 'Amount 731.25' },
    ]);
    const result = await getTopicContext({ query: { messages: { findMany } } } as any, 'owner', {
      topicId: 'own',
      mode: 'archive',
      query: '731.25',
    });
    expect(result.success).toBe(true);
    expect(result.content).toContain('Amount 731.25');
    expect(result.content.length).toBeLessThan(22_000);
    expect(result.content).toContain('"complete":false');
  });

  it('rewrites saved code-artifact tags in assistant archive messages without leaking raw tags', async () => {
    const fileId = '849f7fc2-dd0e-4b18-9aa8-aab327c49b30';
    const rawTag = `<lobeArtifact type="application/lobe.artifacts.code" identifier="code-vb-1" title="Module1.bas" language="vb" src="/chat/code-artifact/${fileId}/"></lobeArtifact>`;
    findTopic.mockResolvedValue({ title: 'VBA Topic' });
    const originals = [
      { id: 'u1', role: 'user', content: 'Write Module1.bas' },
      { id: 'a1', role: 'assistant', content: `Done:\n${rawTag}` },
    ];
    const findMany = vi.fn(async () => originals);
    const select = vi.fn(() => ({ from: () => ({ where: () => ({}) }) }));

    const result = await getTopicContext(
      { query: { messages: { findMany } }, select } as any,
      'owner',
      { mode: 'archive', topicId: 'own' },
    );

    expect(result.success).toBe(true);
    expect(result.content).not.toContain('/chat/code-artifact/');
    expect(result.content).not.toContain('<lobeArtifact');
    expect(result.content).toContain(`fileId=${fileId}`);
    expect(result.content).toContain('mode=\\"code_artifacts\\"');
    // Underlying row stays intact
    expect(originals[1].content).toContain(rawTag);
  });

  it('rewrites saved code-artifact tags in default summary mode', async () => {
    const fileId = '849f7fc2-dd0e-4b18-9aa8-aab327c49b30';
    const rawTag = `<lobeArtifact type="application/lobe.artifacts.code" title="Part1.bas" language="vb" src="/chat/code-artifact/${fileId}/"></lobeArtifact>`;
    findTopic.mockResolvedValue({
      historySummary: `Summary referencing ${rawTag}`,
      title: 'VBA Topic',
    });

    const result = await getTopicContext({} as any, 'owner', { topicId: 'own' });

    expect(result.success).toBe(true);
    expect(result.content).not.toContain('/chat/code-artifact/');
    expect(result.content).not.toContain('<lobeArtifact');
    expect(result.content).toContain(`fileId=${fileId}`);
  });

  it('rewrites serialized multimodal DB rows in archive and compressedGroup/supervisor in fallback summary', async () => {
    const fileId = '849f7fc2-dd0e-4b18-9aa8-aab327c49b30';
    const rawTag = `<lobeArtifact type="application/lobe.artifacts.code" title="Mod.bas" language="vb" src="/chat/code-artifact/${fileId}/"></lobeArtifact>`;
    const multimodalJson = JSON.stringify([
      { text: `Chart + code:\n${rawTag}`, type: 'text' },
      { image: 'https://example.com/chart.png', type: 'image' },
    ]);
    findTopic.mockResolvedValue({ title: 'Multimodal Topic' });
    const findMany = vi.fn(async () => [
      { id: 'a1', role: 'assistant', content: multimodalJson },
      { id: 'g1', role: 'compressedGroup', content: `Summary: ${rawTag}` },
      { id: 's1', role: 'supervisor', content: `Supervisor: ${rawTag}` },
    ]);
    const select = vi.fn(() => ({ from: () => ({ where: () => ({}) }) }));

    const archiveRes = await getTopicContext(
      { query: { messages: { findMany } }, select } as any,
      'owner',
      { mode: 'archive', topicId: 'own' },
    );
    expect(archiveRes.success).toBe(true);
    expect(archiveRes.content).not.toContain('/chat/code-artifact/');
    expect(archiveRes.content).not.toContain('<lobeArtifact');
    expect(archiveRes.content).toContain(`fileId=${fileId}`);

    queryMessages.mockResolvedValue([
      { id: 'a1', role: 'assistant', content: multimodalJson },
      { id: 'g1', role: 'compressedGroup', content: `Summary: ${rawTag}` },
      { id: 's1', role: 'supervisor', content: `Supervisor: ${rawTag}` },
    ]);
    const fallbackSummaryRes = await getTopicContext({} as any, 'owner', { topicId: 'own' });
    expect(fallbackSummaryRes.success).toBe(true);
    expect(fallbackSummaryRes.content).not.toContain('/chat/code-artifact/');
    expect(fallbackSummaryRes.content).not.toContain('<lobeArtifact');
    expect(fallbackSummaryRes.content).toContain(`fileId=${fileId}`);
  });
});
