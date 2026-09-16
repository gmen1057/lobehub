import { describe, expect, it, vi } from 'vitest';

import { getTopicContext } from './index';

const findTopic = vi.hoisted(() => vi.fn());
vi.mock('@/database/models/topic', () => ({
  TopicModel: class {
    findById = findTopic;
  },
}));
vi.mock('@/database/models/message', () => ({ MessageModel: class {} }));

describe('original conversation archive', () => {
  it('keeps subsequent pages on the original snapshot, excluding newly written tool results', async () => {
    findTopic.mockResolvedValue({});
    let filters: any;
    const lte = vi.fn();
    const findMany = vi.fn(async (options) => {
      filters = options;
      return [];
    });
    const snapshotAt = '2026-09-16T08:00:00.000Z';
    const result = await getTopicContext({ query: { messages: { findMany } } } as any, 'owner', {
      topicId: 'own',
      mode: 'archive',
      offset: 20000,
      snapshotAt,
    });
    filters.where({ createdAt: 'created_at' }, { and: vi.fn(), eq: vi.fn(), lte });
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
});
