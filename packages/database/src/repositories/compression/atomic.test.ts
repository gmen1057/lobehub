// @vitest-environment node
import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { messageGroups, messages, topics, users } from '../../schemas';
import { CompressionRepository } from './index';

const db = await getTestDB();
const owner = 'compression-atomic-owner';
const topicId = 'compression-atomic-topic';
const repository = new CompressionRepository(db, owner);

beforeEach(async () => {
  await db.delete(users);
  await db.insert(users).values([{ id: owner }, { id: 'other-owner' }]);
  await db.insert(topics).values([
    { id: topicId, userId: owner },
    { id: 'other-topic', userId: owner },
    { id: 'foreign-topic', userId: 'other-owner' },
  ]);
  await db.insert(messages).values([
    { id: 'source', content: 'Original text', role: 'user', topicId, userId: owner },
    { id: 'new', content: 'Concurrent message', role: 'user', topicId, userId: owner },
    { id: 'other', role: 'user', topicId: 'other-topic', userId: owner },
    { id: 'foreign', role: 'user', topicId: 'foreign-topic', userId: 'other-owner' },
  ]);
});

describe('compression commit', () => {
  it('stores the complete summary and only hides the selected messages in this topic', async () => {
    const groupId = await repository.createCompressionGroup({
      content: 'Complete summary',
      messageIds: ['source', 'other', 'foreign'],
      metadata: {},
      topicId,
    });

    expect((await repository.getCompressionGroups(topicId))[0].content).toBe('Complete summary');
    expect((await repository.getCompressedMessages(groupId)).map((message) => message.id)).toEqual([
      'source',
    ]);
    expect(
      (await repository.getUncompressedMessages(topicId)).map((message) => message.id),
    ).toEqual(['new']);
    const untouched = await db.select().from(messages).where(eq(messages.id, 'other'));
    expect(untouched[0].messageGroupId).toBeNull();
    const foreign = await db.select().from(messages).where(eq(messages.id, 'foreign'));
    expect(foreign[0].messageGroupId).toBeNull();
  });

  it('rolls back the summary if linking its source messages fails', async () => {
    await db.execute(sql`
      CREATE FUNCTION reject_compression_link() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'link failed'; END;
      $$ LANGUAGE plpgsql
    `);
    await db.execute(sql`
      CREATE TRIGGER reject_compression_link BEFORE UPDATE OF message_group_id ON messages
      FOR EACH ROW EXECUTE FUNCTION reject_compression_link()
    `);
    try {
      await expect(
        repository.createCompressionGroup({
          content: 'Complete summary',
          messageIds: ['source'],
          metadata: {},
          topicId,
        }),
      ).rejects.toThrow();
      expect(await repository.getCompressionGroups(topicId)).toEqual([]);
      expect(
        (await repository.getUncompressedMessages(topicId)).map((message) => message.id).sort(),
      ).toEqual(['new', 'source']);
    } finally {
      await db.execute(sql`DROP TRIGGER reject_compression_link ON messages`);
      await db.execute(sql`DROP FUNCTION reject_compression_link()`);
    }
  });

  it.each(['', ' \n\t '])(
    'refuses an empty summary at creation and finalization (%j)',
    async (content) => {
      await expect(
        repository.createCompressionGroup({
          content,
          messageIds: ['source'],
          metadata: {},
          topicId,
        }),
      ).rejects.toThrow('must not be empty');
      expect(await repository.getCompressionGroups(topicId)).toEqual([]);
      expect(await repository.getUncompressedMessages(topicId)).toHaveLength(2);

      const groupId = await repository.createCompressionGroup({
        content: 'Existing summary',
        messageIds: ['source'],
        metadata: {},
        topicId,
      });
      await expect(repository.updateCompressionContent(groupId, content)).rejects.toThrow(
        'must not be empty',
      );
      const [group] = await db.select().from(messageGroups).where(eq(messageGroups.id, groupId));
      expect(group.content).toBe('Existing summary');
    },
  );
});
