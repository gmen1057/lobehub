// @vitest-environment node
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { files, messageGroups, messages, messagesFiles, topics, users } from '@/database/schemas';

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

describe('upsertRollingCompressionGroup', () => {
  it('rejects missing or whitespace-only summary content', async () => {
    const service = new MessageService(db, owner);

    await expect(service.upsertRollingCompressionGroup(topicId, ['old'], context)).rejects.toThrow(
      'Compression summary must not be empty',
    );
    await expect(
      service.upsertRollingCompressionGroup(topicId, ['old'], context, ' \n\t '),
    ).rejects.toThrow('Compression summary must not be empty');

    const groups = await db.select().from(messageGroups).where(eq(messageGroups.topicId, topicId));
    expect(groups).toHaveLength(0);
  });

  it('orders the rolling compressedGroup before the active user message and reuses the same groupId', async () => {
    await db.delete(messages);
    await db.insert(messages).values([
      {
        content: 'Turn 1 user',
        createdAt: new Date('2025-01-01T10:00:00Z'),
        id: 't1-u',
        role: 'user',
        topicId,
        userId: owner,
      },
      {
        content: 'Turn 1 assistant',
        createdAt: new Date('2025-01-01T10:01:00Z'),
        id: 't1-a',
        role: 'assistant',
        topicId,
        userId: owner,
      },
      {
        content: 'Turn 2 user',
        createdAt: new Date('2025-01-01T10:02:00Z'),
        id: 't2-u',
        role: 'user',
        topicId,
        userId: owner,
      },
      {
        content: 'Turn 2 assistant',
        createdAt: new Date('2025-01-01T10:03:00Z'),
        id: 't2-a',
        role: 'assistant',
        topicId,
        userId: owner,
      },
      {
        content: 'Active turn user',
        createdAt: new Date('2025-01-01T10:05:00Z'),
        id: 't3-active',
        role: 'user',
        topicId,
        userId: owner,
      },
    ]);

    const service = new MessageService(db, owner);
    const first = await service.upsertRollingCompressionGroup(
      topicId,
      ['t1-u', 't1-a'],
      context,
      'Rolling summary v1',
    );

    expect(first.messages.map((m) => ({ id: m.id, role: m.role }))).toEqual([
      { id: first.messageGroupId, role: 'compressedGroup' },
      { id: 't2-u', role: 'user' },
      { id: 't2-a', role: 'assistant' },
      { id: 't3-active', role: 'user' },
    ]);
    expect(first.messages[0].content).toBe('Rolling summary v1');

    const second = await service.upsertRollingCompressionGroup(
      topicId,
      ['t2-u', 't2-a'],
      context,
      'Rolling summary v2',
    );

    expect(second.messageGroupId).toBe(first.messageGroupId);
    expect(second.messages.map((m) => ({ id: m.id, role: m.role }))).toEqual([
      { id: first.messageGroupId, role: 'compressedGroup' },
      { id: 't3-active', role: 'user' },
    ]);
    expect(second.messages[0].content).toBe('Rolling summary v2');

    // All original message rows remain intact in PostgreSQL
    const dbMessages = await db.select().from(messages).where(eq(messages.topicId, topicId));
    expect(dbMessages).toHaveLength(5);
  });

  it('consolidates legacy multiple compression groups without deleting messages and preserves pinnedMessages and fileList', async () => {
    await db.delete(messages);
    await db.insert(messages).values([
      {
        content: 'Turn 1 user',
        createdAt: new Date('2025-01-01T10:00:00Z'),
        favorite: false,
        id: 'svc-1',
        role: 'user',
        topicId,
        userId: owner,
      },
      {
        content: 'Turn 1 pinned',
        createdAt: new Date('2025-01-01T10:01:00Z'),
        favorite: true,
        id: 'svc-2',
        role: 'assistant',
        topicId,
        userId: owner,
      },
      {
        content: 'Turn 2 user',
        createdAt: new Date('2025-01-01T10:02:00Z'),
        favorite: false,
        id: 'svc-3',
        role: 'user',
        topicId,
        userId: owner,
      },
      {
        content: 'Turn 2 assistant',
        createdAt: new Date('2025-01-01T10:03:00Z'),
        favorite: false,
        id: 'svc-4',
        role: 'assistant',
        topicId,
        userId: owner,
      },
      {
        content: 'Active user turn',
        createdAt: new Date('2025-01-01T10:06:00Z'),
        favorite: false,
        id: 'svc-5',
        role: 'user',
        topicId,
        userId: owner,
      },
    ]);

    await db.insert(files).values({
      fileType: 'application/pdf',
      id: 'svc-file-1',
      name: 'spec.pdf',
      size: 512,
      url: '/files/spec.pdf',
      userId: owner,
    });
    await db.insert(messagesFiles).values({
      fileId: 'svc-file-1',
      messageId: 'svc-1',
      userId: owner,
    });

    const service = new MessageService(db, owner);
    const legacy1 = await service.createCompressionGroup(
      topicId,
      ['svc-1', 'svc-2'],
      context,
      'Legacy 1',
    );
    await service.createCompressionGroup(topicId, ['svc-3'], context, 'Legacy 2');

    const rolled = await service.upsertRollingCompressionGroup(
      topicId,
      ['svc-4'],
      undefined,
      'Unified summary',
    );

    expect(rolled.messageGroupId).toBe(legacy1.messageGroupId);
    expect(rolled.messages.map((m) => ({ id: m.id, role: m.role }))).toEqual([
      { id: legacy1.messageGroupId, role: 'compressedGroup' },
      { id: 'svc-5', role: 'user' },
    ]);
    expect((rolled.messages[0] as any).pinnedMessages?.map((m: any) => m.id)).toEqual(['svc-2']);
    const attachedFileIds = ((rolled.messages[0] as any).compressedMessages ?? []).flatMap(
      (m: any) => (m.fileList ?? []).map((f: any) => f.id),
    );
    expect(attachedFileIds).toEqual(['svc-file-1']);

    const groups = await db.select().from(messageGroups).where(eq(messageGroups.topicId, topicId));
    expect(groups).toHaveLength(1);

    const dbMessages = await db.select().from(messages).where(eq(messages.topicId, topicId));
    expect(dbMessages).toHaveLength(5);
  });
});
