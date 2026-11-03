// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { messages, topics, users } from '@/database/schemas';

import { MessageService } from '../index';

// Resolve the repository from this checkout, even when node_modules is shared
// with another worktree. This is the real implementation, not a fake database.
vi.mock(
  '@lobechat/database',
  async () => import('../../../../../packages/database/src/repositories/compression'),
);
vi.mock('@/server/services/file', () => ({
  FileService: class {
    getFullFileUrl = async (path: string | null) => path;
  },
}));

const db = await getTestDB();
const owner = 'summary-owner';
const topicId = 'summary-topic';
const context = { topicId };

beforeEach(async () => {
  await db.delete(users);
  await db.insert(users).values({ id: owner });
  await db.insert(topics).values({ id: topicId, userId: owner });
  await db.insert(messages).values([
    { id: 'old', content: 'Original history', role: 'user', topicId, userId: owner },
    { id: 'new', content: 'Next instruction', role: 'user', topicId, userId: owner },
  ]);
});

describe('complete summary publication', () => {
  it('returns the saved summary and leaves messages outside its source snapshot visible', async () => {
    const service = new MessageService(db, owner);
    const result = await service.createCompressionGroup(
      topicId,
      ['old'],
      context,
      'Complete summary',
    );

    expect(result.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: 'Complete summary', role: 'compressedGroup' }),
        expect.objectContaining({ content: 'Next instruction', id: 'new', role: 'user' }),
      ]),
    );
    expect(result.messages?.some((message) => message.id === 'old')).toBe(false);
  });

  it('retains the existing summary when interactive finalization returns empty text', async () => {
    const service = new MessageService(db, owner);
    const result = await service.createCompressionGroup(
      topicId,
      ['old'],
      context,
      'Complete summary',
    );

    await expect(
      service.finalizeCompression(result.messageGroupId, ' \n ', {
        agentId: '',
        topicId,
      }),
    ).rejects.toThrow('must not be empty');
    const reread = await db.query.messageGroups.findFirst();
    expect(reread?.content).toBe('Complete summary');
  });

  it('keeps the existing interactive placeholder and finalization flow working', async () => {
    const service = new MessageService(db, owner);
    const result = await service.createCompressionGroup(topicId, ['old'], context);
    expect(result.messages?.find((message) => message.role === 'compressedGroup')?.content).toBe(
      '...',
    );

    const finalized = await service.finalizeCompression(result.messageGroupId, 'Final summary', {
      agentId: '',
      topicId,
    });
    expect(finalized.messages?.find((message) => message.role === 'compressedGroup')?.content).toBe(
      'Final summary',
    );
  });
});
