// @vitest-environment node
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { messagePlugins, messages, topics, users } from '@/database/schemas';

import { getTopicContext } from './index';

vi.mock('@/database/models/topic', () => ({
  TopicModel: class {
    findById = async () => ({ title: 'Test topic' });
  },
}));
vi.mock('@/database/models/message', () => ({ MessageModel: class {} }));

// Use the real Drizzle query so incorrect correlated filters cannot pass via mocks.
const db = await getTestDB();
const snapshotAt = '2026-11-03T12:00:00.000Z';

beforeAll(async () => {
  await db.insert(users).values([{ id: 'owner' }, { id: 'other' }]);
  await db.insert(topics).values({ id: 'topic', userId: 'owner' });
  const source = { createdAt: new Date('2026-11-03T10:00:00Z'), topicId: 'topic', userId: 'owner' };
  await db.insert(messages).values([
    { ...source, id: 'original', role: 'user', content: 'Original document 731.25' },
    { ...source, id: 'document', role: 'tool', content: 'Useful tool document' },
    { ...source, id: 'other-tool', role: 'tool', content: 'Other getTopicContext tool' },
    { ...source, id: 'old-summary', role: 'tool', content: 'Derived topic summary' },
    { ...source, id: 'foreign', userId: 'other', role: 'user', content: 'Foreign secret' },
    {
      ...source,
      id: 'future',
      role: 'user',
      content: 'Future message',
      createdAt: new Date('2026-11-03T13:00:00Z'),
    },
  ]);
  await db.insert(messagePlugins).values([
    {
      id: 'document',
      userId: 'owner',
      identifier: 'lobe-agent-documents',
      apiName: 'readDocument',
    },
    { id: 'other-tool', userId: 'owner', identifier: 'another-plugin', apiName: 'getTopicContext' },
    {
      id: 'old-summary',
      userId: 'owner',
      identifier: 'lobe-topic-reference',
      apiName: 'getTopicContext',
    },
  ]);
});

describe('archive source selection', () => {
  it('retains original documents and useful tool results, while excluding its own previous exports', async () => {
    const read = () =>
      getTopicContext(db as any, 'owner', { mode: 'archive', snapshotAt, topicId: 'topic' });
    const original = await read();
    expect(original.content).toContain('Original document 731.25');
    expect(original.content).toContain('Useful tool document');
    expect(original.content).toContain('Other getTopicContext tool');
    expect(original.content).not.toContain('Derived topic summary');
    expect(original.content).not.toContain('Foreign secret');
    expect(original.content).not.toContain('Future message');

    // Each next invocation uses a fresh snapshot that includes previous exports.
    // Their content must not get escaped and copied back into the archive.
    for (let attempt = 0; attempt < 3; attempt++) {
      const id = `archive-${attempt}`;
      await db
        .insert(messages)
        .values({
          id,
          userId: 'owner',
          topicId: 'topic',
          role: 'tool',
          content: original.content,
          createdAt: new Date('2026-11-03T11:00:00Z'),
        });
      await db
        .insert(messagePlugins)
        .values({
          id,
          userId: 'owner',
          identifier: 'lobe-topic-reference',
          apiName: 'getTopicContext',
        });
      expect((await read()).content).toBe(original.content);
    }
  });
});
