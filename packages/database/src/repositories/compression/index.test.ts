// @vitest-environment node
import { MessageGroupType } from '@lobechat/types';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { MessageModel } from '../../models/message';
import { files } from '../../schemas/file';
import { messageGroups, messages, messagesFiles } from '../../schemas/message';
import { topics } from '../../schemas/topic';
import { users } from '../../schemas/user';
import type { LobeChatDatabase } from '../../type';
import { CompressionRepository } from './index';

const userId = 'compression-test-user';
const topicId = 'test-topic-1';

let compressionRepo: CompressionRepository;

const serverDB: LobeChatDatabase = await getTestDB();

beforeEach(async () => {
  // Clean up
  await serverDB.delete(messageGroups);
  await serverDB.delete(messages);
  await serverDB.delete(topics);
  await serverDB.delete(users);

  // Create test user
  await serverDB.insert(users).values({ id: userId });

  // Create test topic
  await serverDB.insert(topics).values({ id: topicId, userId });

  // Initialize repo
  compressionRepo = new CompressionRepository(serverDB, userId);
});

describe('CompressionRepository', () => {
  describe('createCompressionGroup', () => {
    it('should create a compression group', async () => {
      const metadata = {
        compressedAt: new Date().toISOString(),
        compressionStrategy: 'summarize' as const,
        originalMessageCount: 10,
        originalTokenCount: 5000,
      };
      const groupId = await compressionRepo.createCompressionGroup({
        content: 'This is a summary of the conversation.',
        messageIds: [],
        metadata,
        topicId,
      });

      expect(groupId).toBeDefined();

      // Verify the group was created
      const groups = await compressionRepo.getCompressionGroups(topicId);
      expect(groups).toHaveLength(1);
      expect(groups[0].content).toBe('This is a summary of the conversation.');
      expect(groups[0].type).toBe(MessageGroupType.Compression);
      expect(groups[0].metadata).toEqual(metadata);
    });

    it('should create compression group and mark messages as compressed', async () => {
      // Create test messages
      await serverDB.insert(messages).values([
        { id: 'msg-1', content: 'Hello', role: 'user', topicId, userId },
        { id: 'msg-2', content: 'Hi there!', role: 'assistant', topicId, userId },
        { id: 'msg-3', content: 'How are you?', role: 'user', topicId, userId },
      ]);

      const groupId = await compressionRepo.createCompressionGroup({
        content: 'User greeted and asked how assistant is doing.',
        messageIds: ['msg-1', 'msg-2', 'msg-3'],
        metadata: {
          endMessageId: 'msg-3',
          originalMessageCount: 3,
          startMessageId: 'msg-1',
        },
        topicId,
      });

      // Verify messages are marked as compressed
      const compressedMessages = await compressionRepo.getCompressedMessages(groupId);
      expect(compressedMessages).toHaveLength(3);
    });
  });

  describe('getCompressionGroups', () => {
    it('should return all compression groups for a topic ordered by createdAt', async () => {
      // Create multiple compression groups
      await compressionRepo.createCompressionGroup({
        content: 'First summary',
        messageIds: [],
        metadata: { originalMessageCount: 5 },
        topicId,
      });

      await compressionRepo.createCompressionGroup({
        content: 'Second summary',
        messageIds: [],
        metadata: { originalMessageCount: 10 },
        topicId,
      });

      const groups = await compressionRepo.getCompressionGroups(topicId);
      expect(groups).toHaveLength(2);
      expect(groups[0].content).toBe('First summary');
      expect(groups[1].content).toBe('Second summary');
    });

    it('should not return groups from other topics', async () => {
      const otherTopicId = 'other-topic';
      await serverDB.insert(topics).values({ id: otherTopicId, userId });

      await compressionRepo.createCompressionGroup({
        content: 'Summary for topic 1',
        messageIds: [],
        metadata: {},
        topicId,
      });

      await compressionRepo.createCompressionGroup({
        content: 'Summary for other topic',
        messageIds: [],
        metadata: {},
        topicId: otherTopicId,
      });

      const groups = await compressionRepo.getCompressionGroups(topicId);
      expect(groups).toHaveLength(1);
      expect(groups[0].content).toBe('Summary for topic 1');
    });
  });

  describe('getLatestCompressionGroup', () => {
    it('should return the latest compression group', async () => {
      await compressionRepo.createCompressionGroup({
        content: 'Old summary',
        messageIds: [],
        metadata: {},
        topicId,
      });

      await compressionRepo.createCompressionGroup({
        content: 'Latest summary',
        messageIds: [],
        metadata: {},
        topicId,
      });

      const latest = await compressionRepo.getLatestCompressionGroup(topicId);
      expect(latest).not.toBeNull();
      expect(latest!.content).toBe('Latest summary');
    });

    it('should return null if no compression groups exist', async () => {
      const latest = await compressionRepo.getLatestCompressionGroup(topicId);
      expect(latest).toBeNull();
    });
  });

  describe('updateCompressionContent', () => {
    it('should update compression group content', async () => {
      const groupId = await compressionRepo.createCompressionGroup({
        content: 'Original summary',
        messageIds: [],
        metadata: { originalTokenCount: 1000 },
        topicId,
      });

      await compressionRepo.updateCompressionContent(groupId, 'Updated summary', {
        compressedTokenCount: 100,
      });

      const groups = await compressionRepo.getCompressionGroups(topicId);
      expect(groups[0].content).toBe('Updated summary');
    });
  });

  describe('updateMetadata', () => {
    it('should update metadata jsonb column on a compression group', async () => {
      const groupId = await compressionRepo.createCompressionGroup({
        content: 'Summary',
        messageIds: [],
        metadata: {},
        topicId,
      });

      await compressionRepo.updateMetadata(groupId, { expanded: true } as any);

      // Query metadata column directly since getCompressionGroups returns description-based metadata
      const { eq, and } = await import('drizzle-orm');
      const [group] = await serverDB
        .select({ metadata: messageGroups.metadata })
        .from(messageGroups)
        .where(and(eq(messageGroups.id, groupId), eq(messageGroups.userId, userId)));
      expect((group.metadata as any)?.expanded).toBe(true);
    });

    it('should merge with existing metadata', async () => {
      const groupId = await compressionRepo.createCompressionGroup({
        content: 'Summary',
        messageIds: [],
        metadata: {},
        topicId,
      });

      await compressionRepo.updateMetadata(groupId, { expanded: true } as any);
      await compressionRepo.updateMetadata(groupId, { collapsed: false } as any);

      const { eq, and } = await import('drizzle-orm');
      const [group] = await serverDB
        .select({ metadata: messageGroups.metadata })
        .from(messageGroups)
        .where(and(eq(messageGroups.id, groupId), eq(messageGroups.userId, userId)));
      const meta = group.metadata as any;
      expect(meta?.expanded).toBe(true);
      expect(meta?.collapsed).toBe(false);
    });

    it('should handle updating metadata on non-existent group gracefully', async () => {
      // Should not throw
      await compressionRepo.updateMetadata('non-existent-group-id', { expanded: true } as any);
    });
  });

  describe('updateCompressionContent with metadata merge', () => {
    it('should merge description metadata when updating content', async () => {
      const groupId = await compressionRepo.createCompressionGroup({
        content: 'Original summary',
        messageIds: [],
        metadata: { originalTokenCount: 1000 },
        topicId,
      });

      await compressionRepo.updateCompressionContent(groupId, 'Updated summary', {
        compressedTokenCount: 100,
      });

      const groups = await compressionRepo.getCompressionGroups(topicId);
      expect(groups[0].content).toBe('Updated summary');
      // Verify the description-based metadata was merged
      expect((groups[0].metadata as any)?.originalTokenCount).toBe(1000);
      expect((groups[0].metadata as any)?.compressedTokenCount).toBe(100);
    });

    it('should update content without metadata', async () => {
      const groupId = await compressionRepo.createCompressionGroup({
        content: 'Original',
        messageIds: [],
        metadata: {},
        topicId,
      });

      await compressionRepo.updateCompressionContent(groupId, 'New content');

      const groups = await compressionRepo.getCompressionGroups(topicId);
      expect(groups[0].content).toBe('New content');
    });
  });

  describe('toggleMessagePin', () => {
    it('should pin a message', async () => {
      await serverDB.insert(messages).values({
        content: 'Important message',
        id: 'msg-pin-test',
        role: 'user',
        topicId,
        userId,
      });

      await compressionRepo.toggleMessagePin('msg-pin-test', true);

      const [message] = await serverDB
        .select()
        .from(messages)
        .where(
          (() => {
            const { eq, and } = require('drizzle-orm');
            return and(eq(messages.id, 'msg-pin-test'), eq(messages.userId, userId));
          })(),
        );

      expect((message.metadata as any)?.pinned).toBe(true);
    });

    it('should unpin a message', async () => {
      await serverDB.insert(messages).values({
        content: 'Pinned message',
        id: 'msg-unpin-test',
        metadata: { pinned: true },
        role: 'user',
        topicId,
        userId,
      });

      await compressionRepo.toggleMessagePin('msg-unpin-test', false);

      const [message] = await serverDB
        .select()
        .from(messages)
        .where(
          (() => {
            const { eq, and } = require('drizzle-orm');
            return and(eq(messages.id, 'msg-unpin-test'), eq(messages.userId, userId));
          })(),
        );

      expect((message.metadata as any)?.pinned).toBe(false);
    });
  });

  describe('getUncompressedMessages', () => {
    it('should return only uncompressed messages', async () => {
      // Create messages
      await serverDB.insert(messages).values([
        { id: 'msg-uncomp-1', content: 'Uncompressed 1', role: 'user', topicId, userId },
        { id: 'msg-uncomp-2', content: 'Uncompressed 2', role: 'assistant', topicId, userId },
        { id: 'msg-comp-1', content: 'To be compressed', role: 'user', topicId, userId },
      ]);

      // Compress one message
      await compressionRepo.createCompressionGroup({
        content: 'Summary',
        messageIds: ['msg-comp-1'],
        metadata: {},
        topicId,
      });

      const uncompressed = await compressionRepo.getUncompressedMessages(topicId);
      expect(uncompressed).toHaveLength(2);
      expect(uncompressed.map((m) => m.id)).toEqual(
        expect.arrayContaining(['msg-uncomp-1', 'msg-uncomp-2']),
      );
    });
  });

  describe('deleteCompressionGroup', () => {
    it('should delete compression group and unmark messages', async () => {
      await serverDB.insert(messages).values([
        { id: 'msg-delete-1', content: 'Message 1', role: 'user', topicId, userId },
        { id: 'msg-delete-2', content: 'Message 2', role: 'assistant', topicId, userId },
      ]);

      const groupId = await compressionRepo.createCompressionGroup({
        content: 'To be deleted',
        messageIds: ['msg-delete-1', 'msg-delete-2'],
        metadata: {},
        topicId,
      });

      // Verify messages are compressed
      const compressedMessages = await compressionRepo.getCompressedMessages(groupId);
      expect(compressedMessages).toHaveLength(2);

      // Delete the group
      await compressionRepo.deleteCompressionGroup(groupId);

      // Verify group is deleted
      const groups = await compressionRepo.getCompressionGroups(topicId);
      expect(groups).toHaveLength(0);

      // Verify messages are uncompressed
      const uncompressed = await compressionRepo.getUncompressedMessages(topicId);
      expect(uncompressed).toHaveLength(2);
    });
  });

  describe('unmarkMessagesFromCompression', () => {
    it('should remove messages from compression group', async () => {
      await serverDB.insert(messages).values([
        { id: 'msg-unmark-1', content: 'Message 1', role: 'user', topicId, userId },
        { id: 'msg-unmark-2', content: 'Message 2', role: 'assistant', topicId, userId },
      ]);

      const groupId = await compressionRepo.createCompressionGroup({
        content: 'Summary',
        messageIds: ['msg-unmark-1', 'msg-unmark-2'],
        metadata: {},
        topicId,
      });

      // Unmark one message
      await compressionRepo.unmarkMessagesFromCompression(['msg-unmark-1']);

      const compressedMessages = await compressionRepo.getCompressedMessages(groupId);
      expect(compressedMessages).toHaveLength(1);
      expect(compressedMessages[0].id).toBe('msg-unmark-2');
    });
  });

  /**
   * Tests for LOBE-2066: MessageGroup aggregation in queryMessage
   *
   * These tests verify the expected behavior for querying messages with compression groups,
   * specifically focusing on:
   * 1. Compressed messages should NOT appear in normal trajectory
   * 2. Compression groups should appear as aggregated nodes
   * 3. Pinned (favorite) messages within compression groups should be extracted
   */
  describe('MessageGroup aggregation query scenarios', () => {
    describe('compressed messages filtering', () => {
      it('should exclude compressed messages from uncompressed query', async () => {
        // Setup: Create 5 messages, compress 3 of them
        await serverDB.insert(messages).values([
          {
            id: 'msg-1',
            content: 'Hello',
            role: 'user',
            topicId,
            userId,
            createdAt: new Date('2024-01-01T10:00:00Z'),
          },
          {
            id: 'msg-2',
            content: 'Hi there!',
            role: 'assistant',
            topicId,
            userId,
            createdAt: new Date('2024-01-01T10:01:00Z'),
          },
          {
            id: 'msg-3',
            content: 'How are you?',
            role: 'user',
            topicId,
            userId,
            createdAt: new Date('2024-01-01T10:02:00Z'),
          },
          {
            id: 'msg-4',
            content: 'I am fine',
            role: 'assistant',
            topicId,
            userId,
            createdAt: new Date('2024-01-01T10:03:00Z'),
          },
          {
            id: 'msg-5',
            content: 'Latest question',
            role: 'user',
            topicId,
            userId,
            createdAt: new Date('2024-01-01T10:04:00Z'),
          },
        ]);

        // Compress the first 3 messages
        await compressionRepo.createCompressionGroup({
          content: 'User greeted assistant and asked how they are.',
          messageIds: ['msg-1', 'msg-2', 'msg-3'],
          metadata: {
            originalMessageCount: 3,
            startMessageId: 'msg-1',
            endMessageId: 'msg-3',
          },
          topicId,
        });

        // Query uncompressed messages
        const uncompressedMessages = await compressionRepo.getUncompressedMessages(topicId);

        // Should only return msg-4 and msg-5
        expect(uncompressedMessages).toHaveLength(2);
        expect(uncompressedMessages.map((m) => m.id)).toEqual(['msg-4', 'msg-5']);
      });

      it('should return all messages as uncompressed when no compression groups exist', async () => {
        await serverDB.insert(messages).values([
          { id: 'msg-no-comp-1', content: 'Message 1', role: 'user', topicId, userId },
          { id: 'msg-no-comp-2', content: 'Message 2', role: 'assistant', topicId, userId },
          { id: 'msg-no-comp-3', content: 'Message 3', role: 'user', topicId, userId },
        ]);

        const uncompressedMessages = await compressionRepo.getUncompressedMessages(topicId);

        expect(uncompressedMessages).toHaveLength(3);
      });
    });

    describe('pinned messages in compression groups', () => {
      it('should identify favorite messages within compression groups', async () => {
        // Setup: Create messages with some marked as favorite
        await serverDB.insert(messages).values([
          {
            id: 'msg-fav-1',
            content: 'Normal message',
            role: 'user',
            topicId,
            userId,
            favorite: false,
          },
          {
            id: 'msg-fav-2',
            content: 'Important code example',
            role: 'assistant',
            topicId,
            userId,
            favorite: true,
          },
          {
            id: 'msg-fav-3',
            content: 'Follow up question',
            role: 'user',
            topicId,
            userId,
            favorite: false,
          },
          {
            id: 'msg-fav-4',
            content: 'Critical answer - pinned',
            role: 'assistant',
            topicId,
            userId,
            favorite: true,
          },
          {
            id: 'msg-fav-5',
            content: 'Latest message',
            role: 'user',
            topicId,
            userId,
            favorite: false,
          },
        ]);

        // Compress messages 1-4
        const groupId = await compressionRepo.createCompressionGroup({
          content: 'Discussion about code with important examples.',
          messageIds: ['msg-fav-1', 'msg-fav-2', 'msg-fav-3', 'msg-fav-4'],
          metadata: {
            originalMessageCount: 4,
            startMessageId: 'msg-fav-1',
            endMessageId: 'msg-fav-4',
          },
          topicId,
        });

        // Query compressed messages to verify
        const compressedMessages = await compressionRepo.getCompressedMessages(groupId);
        expect(compressedMessages).toHaveLength(4);

        // Verify favorite messages within the compression group
        const favoriteMessages = compressedMessages.filter((m) => m.favorite === true);
        expect(favoriteMessages).toHaveLength(2);
        expect(favoriteMessages.map((m) => m.id)).toEqual(
          expect.arrayContaining(['msg-fav-2', 'msg-fav-4']),
        );
      });

      it('should return empty array when compression group has no favorite messages', async () => {
        await serverDB.insert(messages).values([
          {
            id: 'msg-no-fav-1',
            content: 'Message 1',
            role: 'user',
            topicId,
            userId,
            favorite: false,
          },
          {
            id: 'msg-no-fav-2',
            content: 'Message 2',
            role: 'assistant',
            topicId,
            userId,
            favorite: false,
          },
        ]);

        const groupId = await compressionRepo.createCompressionGroup({
          content: 'Summary without any pinned messages.',
          messageIds: ['msg-no-fav-1', 'msg-no-fav-2'],
          metadata: { originalMessageCount: 2 },
          topicId,
        });

        const compressedMessages = await compressionRepo.getCompressedMessages(groupId);
        const favoriteMessages = compressedMessages.filter((m) => m.favorite === true);

        expect(favoriteMessages).toHaveLength(0);
      });

      it('should handle multiple compression groups with pinned messages', async () => {
        // Create messages for two separate compression scenarios
        await serverDB.insert(messages).values([
          // First compression group
          {
            id: 'msg-multi-1',
            content: 'Group 1 msg 1',
            role: 'user',
            topicId,
            userId,
            favorite: false,
          },
          {
            id: 'msg-multi-2',
            content: 'Group 1 pinned',
            role: 'assistant',
            topicId,
            userId,
            favorite: true,
          },
          // Second compression group
          {
            id: 'msg-multi-3',
            content: 'Group 2 msg 1',
            role: 'user',
            topicId,
            userId,
            favorite: true,
          },
          {
            id: 'msg-multi-4',
            content: 'Group 2 msg 2',
            role: 'assistant',
            topicId,
            userId,
            favorite: false,
          },
          {
            id: 'msg-multi-5',
            content: 'Group 2 pinned',
            role: 'user',
            topicId,
            userId,
            favorite: true,
          },
          // Uncompressed message
          {
            id: 'msg-multi-6',
            content: 'Latest uncompressed',
            role: 'assistant',
            topicId,
            userId,
            favorite: false,
          },
        ]);

        // Create first compression group
        const groupId1 = await compressionRepo.createCompressionGroup({
          content: 'First conversation summary',
          messageIds: ['msg-multi-1', 'msg-multi-2'],
          metadata: { originalMessageCount: 2 },
          topicId,
        });

        // Create second compression group
        const groupId2 = await compressionRepo.createCompressionGroup({
          content: 'Second conversation summary',
          messageIds: ['msg-multi-3', 'msg-multi-4', 'msg-multi-5'],
          metadata: { originalMessageCount: 3 },
          topicId,
        });

        // Verify first group has 1 favorite message
        const group1Messages = await compressionRepo.getCompressedMessages(groupId1);
        const group1Favorites = group1Messages.filter((m) => m.favorite === true);
        expect(group1Favorites).toHaveLength(1);
        expect(group1Favorites[0].id).toBe('msg-multi-2');

        // Verify second group has 2 favorite messages
        const group2Messages = await compressionRepo.getCompressedMessages(groupId2);
        const group2Favorites = group2Messages.filter((m) => m.favorite === true);
        expect(group2Favorites).toHaveLength(2);
        expect(group2Favorites.map((m) => m.id)).toEqual(
          expect.arrayContaining(['msg-multi-3', 'msg-multi-5']),
        );

        // Verify uncompressed messages
        const uncompressedMessages = await compressionRepo.getUncompressedMessages(topicId);
        expect(uncompressedMessages).toHaveLength(1);
        expect(uncompressedMessages[0].id).toBe('msg-multi-6');
      });
    });

    describe('compression group as trajectory node', () => {
      it('should return compression groups with content and metadata', async () => {
        await serverDB.insert(messages).values([
          { id: 'msg-traj-1', content: 'Hello', role: 'user', topicId, userId },
          { id: 'msg-traj-2', content: 'Hi!', role: 'assistant', topicId, userId },
        ]);

        const metadata = {
          originalMessageCount: 2,
          originalTokenCount: 150,
          startMessageId: 'msg-traj-1',
          endMessageId: 'msg-traj-2',
          compressedAt: new Date().toISOString(),
          compressionStrategy: 'summarize' as const,
        };

        await compressionRepo.createCompressionGroup({
          content: 'User and assistant exchanged greetings.',
          messageIds: ['msg-traj-1', 'msg-traj-2'],
          metadata,
          topicId,
        });

        const groups = await compressionRepo.getCompressionGroups(topicId);

        expect(groups).toHaveLength(1);
        expect(groups[0]).toMatchObject({
          content: 'User and assistant exchanged greetings.',
          type: MessageGroupType.Compression,
          topicId,
        });
        expect(groups[0].metadata).toMatchObject({
          originalMessageCount: 2,
          originalTokenCount: 150,
          startMessageId: 'msg-traj-1',
          endMessageId: 'msg-traj-2',
        });
      });

      it('should order compression groups by createdAt for trajectory', async () => {
        // Create messages and compression groups with specific timing
        await serverDB.insert(messages).values([
          { id: 'msg-order-1', content: 'Early message', role: 'user', topicId, userId },
          { id: 'msg-order-2', content: 'Middle message', role: 'assistant', topicId, userId },
          { id: 'msg-order-3', content: 'Late message', role: 'user', topicId, userId },
        ]);

        // Create first compression group
        await compressionRepo.createCompressionGroup({
          content: 'First summary',
          messageIds: ['msg-order-1'],
          metadata: { originalMessageCount: 1 },
          topicId,
        });

        // Small delay to ensure different createdAt
        await new Promise((resolve) => setTimeout(resolve, 10));

        // Create second compression group
        await compressionRepo.createCompressionGroup({
          content: 'Second summary',
          messageIds: ['msg-order-2', 'msg-order-3'],
          metadata: { originalMessageCount: 2 },
          topicId,
        });

        const groups = await compressionRepo.getCompressionGroups(topicId);

        expect(groups).toHaveLength(2);
        expect(groups[0].content).toBe('First summary');
        expect(groups[1].content).toBe('Second summary');
        // Verify ordering by createdAt
        expect(new Date(groups[0].createdAt).getTime()).toBeLessThan(
          new Date(groups[1].createdAt).getTime(),
        );
      });
    });

    describe('trajectory assembly scenario', () => {
      it('should support building trajectory with compression groups and uncompressed messages', async () => {
        // This test simulates the full trajectory assembly scenario
        // Setup: Mixed compressed and uncompressed messages

        await serverDB.insert(messages).values([
          // Early messages to be compressed (with one pinned)
          {
            id: 'traj-1',
            content: 'Hello',
            role: 'user',
            topicId,
            userId,
            favorite: false,
            createdAt: new Date('2024-01-01T10:00:00Z'),
          },
          {
            id: 'traj-2',
            content: 'Hi there!',
            role: 'assistant',
            topicId,
            userId,
            favorite: true,
            createdAt: new Date('2024-01-01T10:01:00Z'),
          },
          {
            id: 'traj-3',
            content: 'Important question',
            role: 'user',
            topicId,
            userId,
            favorite: true,
            createdAt: new Date('2024-01-01T10:02:00Z'),
          },
          {
            id: 'traj-4',
            content: 'Detailed answer',
            role: 'assistant',
            topicId,
            userId,
            favorite: false,
            createdAt: new Date('2024-01-01T10:03:00Z'),
          },
          // Recent uncompressed messages
          {
            id: 'traj-5',
            content: 'New question',
            role: 'user',
            topicId,
            userId,
            favorite: false,
            createdAt: new Date('2024-01-01T10:04:00Z'),
          },
          {
            id: 'traj-6',
            content: 'New answer',
            role: 'assistant',
            topicId,
            userId,
            favorite: false,
            createdAt: new Date('2024-01-01T10:05:00Z'),
          },
        ]);

        // Compress early messages
        const groupId = await compressionRepo.createCompressionGroup({
          content: 'Initial conversation with important question and answer.',
          messageIds: ['traj-1', 'traj-2', 'traj-3', 'traj-4'],
          metadata: {
            originalMessageCount: 4,
            startMessageId: 'traj-1',
            endMessageId: 'traj-4',
          },
          topicId,
        });

        // Fetch components for trajectory assembly
        const compressionGroups = await compressionRepo.getCompressionGroups(topicId);
        const uncompressedMessages = await compressionRepo.getUncompressedMessages(topicId);
        const compressedMessages = await compressionRepo.getCompressedMessages(groupId);
        const pinnedMessagesInGroup = compressedMessages.filter((m) => m.favorite === true);

        // Verify trajectory components
        // 1. Compression groups
        expect(compressionGroups).toHaveLength(1);
        expect(compressionGroups[0].content).toBe(
          'Initial conversation with important question and answer.',
        );

        // 2. Uncompressed messages (recent ones)
        expect(uncompressedMessages).toHaveLength(2);
        expect(uncompressedMessages.map((m) => m.id)).toEqual(['traj-5', 'traj-6']);

        // 3. Pinned messages within compression group (for pinnedMessages field)
        expect(pinnedMessagesInGroup).toHaveLength(2);
        expect(pinnedMessagesInGroup.map((m) => m.id)).toEqual(
          expect.arrayContaining(['traj-2', 'traj-3']),
        );

        // Expected trajectory structure (pseudo):
        // [
        //   {
        //     role: 'compressedGroup',
        //     id: groupId,
        //     content: 'Initial conversation with important question and answer.',
        //     pinnedMessages: [traj-2, traj-3],
        //   },
        //   { role: 'user', id: 'traj-5', content: 'New question' },
        //   { role: 'assistant', id: 'traj-6', content: 'New answer' },
        // ]
      });
    });

    describe('upsertRollingCompressionGroup', () => {
      it('rejects empty or whitespace-only summary content without mutating DB', async () => {
        await serverDB.insert(messages).values([
          {
            content: 'Earlier turn',
            createdAt: new Date('2025-01-01T10:00:00Z'),
            id: 'empty-1',
            role: 'user',
            topicId,
            userId,
          },
        ]);

        await expect(
          compressionRepo.upsertRollingCompressionGroup({
            content: '   \n\t  ',
            messageIds: ['empty-1'],
            metadata: {},
            topicId,
          }),
        ).rejects.toThrow('Compression summary must not be empty');

        expect(await compressionRepo.getCompressionGroups(topicId)).toHaveLength(0);
        expect(await compressionRepo.getUncompressedMessages(topicId)).toHaveLength(1);
      });

      it('anchors first insert createdAt to min(createdAt) so compressedGroup sorts before active turn', async () => {
        const t1 = new Date('2025-01-01T10:00:00Z');
        const t2 = new Date('2025-01-01T10:01:00Z');
        const tActive = new Date('2025-01-01T10:05:00Z');

        await serverDB.insert(messages).values([
          { content: 'Turn 1 user', createdAt: t1, id: 'roll-1', role: 'user', topicId, userId },
          {
            content: 'Turn 1 assistant',
            createdAt: t2,
            id: 'roll-2',
            role: 'assistant',
            topicId,
            userId,
          },
          // Inserted BEFORE compression runs (active turn)
          {
            content: 'Active turn user',
            createdAt: tActive,
            id: 'roll-active',
            role: 'user',
            topicId,
            userId,
          },
        ]);

        const groupId = await compressionRepo.upsertRollingCompressionGroup({
          content: 'Rolling summary v1',
          messageIds: ['roll-1', 'roll-2'],
          metadata: {},
          topicId,
        });

        const groups = await compressionRepo.getCompressionGroups(topicId);
        expect(groups).toHaveLength(1);
        expect(groups[0].id).toBe(groupId);
        expect(groups[0].createdAt.getTime()).toBe(t1.getTime());
        expect(groups[0].createdAt.getTime()).toBeLessThan(tActive.getTime());
        expect(groups[0].metadata).toEqual({
          compressionStrategy: 'summarize',
          endMessageId: 'roll-2',
          originalMessageCount: 2,
          startMessageId: 'roll-1',
        });

        const messageModel = new MessageModel(serverDB, userId);
        const queried = await messageModel.query({ topicId });
        expect(queried.map((m) => ({ id: m.id, role: m.role }))).toEqual([
          { id: groupId, role: 'compressedGroup' },
          { id: 'roll-active', role: 'user' },
        ]);
      });

      it('reuses the same groupId on rolling recompression with zero DELETE calls and preserves UI metadata', async () => {
        const t1 = new Date('2025-01-01T10:00:00Z');
        const t2 = new Date('2025-01-01T10:01:00Z');
        const t3 = new Date('2025-01-01T10:02:00Z');
        const t4 = new Date('2025-01-01T10:03:00Z');
        const t5 = new Date('2025-01-01T10:05:00Z');

        await serverDB.insert(messages).values([
          { content: 'M1', createdAt: t1, id: 'rc-1', role: 'user', topicId, userId },
          { content: 'M2', createdAt: t2, id: 'rc-2', role: 'assistant', topicId, userId },
          { content: 'M3', createdAt: t3, id: 'rc-3', role: 'user', topicId, userId },
          { content: 'M4', createdAt: t4, id: 'rc-4', role: 'assistant', topicId, userId },
          { content: 'M5 active', createdAt: t5, id: 'rc-5', role: 'user', topicId, userId },
        ]);

        const firstGroupId = await compressionRepo.upsertRollingCompressionGroup({
          content: 'Summary pass 1',
          messageIds: ['rc-1', 'rc-2'],
          metadata: {},
          topicId,
        });

        // Simulate user expanding the group in UI (stored in JSONB metadata column)
        await compressionRepo.updateMetadata(firstGroupId, { expanded: true });

        let deleteCalls = 0;
        const origTransaction = serverDB.transaction.bind(serverDB);
        const txSpy = vi.spyOn(serverDB, 'transaction').mockImplementation((async (
          callback: any,
          config: any,
        ) =>
          origTransaction(async (tx: any) => {
            const origDelete = tx.delete.bind(tx);
            tx.delete = (...args: any[]) => {
              deleteCalls += 1;
              return origDelete(...args);
            };
            return callback(tx);
          }, config)) as any);

        let secondGroupId: string;
        try {
          secondGroupId = await compressionRepo.upsertRollingCompressionGroup({
            content: 'Summary pass 2 (consolidated)',
            messageIds: ['rc-3', 'rc-4'],
            metadata: {},
            topicId,
          });
        } finally {
          txSpy.mockRestore();
        }

        expect(secondGroupId).toBe(firstGroupId);
        expect(deleteCalls).toBe(0);

        const groups = await compressionRepo.getCompressionGroups(topicId);
        expect(groups).toHaveLength(1);
        expect(groups[0].id).toBe(firstGroupId);
        expect(groups[0].content).toBe('Summary pass 2 (consolidated)');
        expect(groups[0].createdAt.getTime()).toBe(t1.getTime());
        expect(groups[0].metadata).toEqual({
          compressionStrategy: 'summarize',
          endMessageId: 'rc-4',
          originalMessageCount: 4,
          startMessageId: 'rc-1',
        });

        // Verify JSONB UI metadata column was preserved
        const [rawGroup] = await serverDB
          .select({ metadata: messageGroups.metadata })
          .from(messageGroups)
          .where(eq(messageGroups.id, firstGroupId));
        expect(rawGroup?.metadata).toEqual({ expanded: true });

        // All 5 messages remain in DB; 4 compressed under firstGroupId, 1 active
        const allTopicMessages = await serverDB
          .select()
          .from(messages)
          .where(eq(messages.topicId, topicId));
        expect(allTopicMessages).toHaveLength(5);
        expect(await compressionRepo.getCompressedMessages(firstGroupId)).toHaveLength(4);
        expect((await compressionRepo.getUncompressedMessages(topicId)).map((m) => m.id)).toEqual([
          'rc-5',
        ]);
      });

      it('consolidates a legacy 3-group topic into 1 group with zero ON DELETE CASCADE losses, preserving favorite/pinnedMessages and fileList', async () => {
        const times = Array.from({ length: 9 }, (_, i) => new Date(`2025-01-01T10:0${i}:00Z`));

        await serverDB.insert(messages).values([
          {
            content: 'Legacy 1 user',
            createdAt: times[0],
            favorite: false,
            id: 'leg-1',
            role: 'user',
            topicId,
            userId,
          },
          {
            content: 'Legacy 1 pinned assistant',
            createdAt: times[1],
            favorite: true,
            id: 'leg-2',
            role: 'assistant',
            topicId,
            userId,
          },
          {
            content: 'Legacy 2 user',
            createdAt: times[2],
            favorite: false,
            id: 'leg-3',
            role: 'user',
            topicId,
            userId,
          },
          {
            content: 'Legacy 2 assistant',
            createdAt: times[3],
            favorite: false,
            id: 'leg-4',
            role: 'assistant',
            topicId,
            userId,
          },
          {
            content: 'Legacy 3 user',
            createdAt: times[4],
            favorite: false,
            id: 'leg-5',
            role: 'user',
            topicId,
            userId,
          },
          {
            content: 'Legacy 3 pinned assistant',
            createdAt: times[5],
            favorite: true,
            id: 'leg-6',
            role: 'assistant',
            topicId,
            userId,
          },
          {
            content: 'New turn user',
            createdAt: times[6],
            favorite: false,
            id: 'leg-7',
            role: 'user',
            topicId,
            userId,
          },
          {
            content: 'New turn assistant',
            createdAt: times[7],
            favorite: false,
            id: 'leg-8',
            role: 'assistant',
            topicId,
            userId,
          },
          {
            content: 'Active user message',
            createdAt: times[8],
            favorite: false,
            id: 'leg-9',
            role: 'user',
            topicId,
            userId,
          },
        ]);

        // Attach files across legacy groups and the newly compressed turn
        await serverDB.insert(files).values([
          {
            fileType: 'application/pdf',
            id: 'file-leg-1',
            name: 'contract-v1.pdf',
            size: 1024,
            url: '/files/contract-v1.pdf',
            userId,
          },
          {
            fileType: 'text/csv',
            id: 'file-leg-2',
            name: 'budget.csv',
            size: 2048,
            url: '/files/budget.csv',
            userId,
          },
          {
            fileType: 'text/markdown',
            id: 'file-leg-3',
            name: 'addendum.md',
            size: 512,
            url: '/files/addendum.md',
            userId,
          },
        ]);

        await serverDB.insert(messagesFiles).values([
          { fileId: 'file-leg-1', messageId: 'leg-1', userId },
          { fileId: 'file-leg-2', messageId: 'leg-3', userId },
          { fileId: 'file-leg-3', messageId: 'leg-7', userId },
        ]);

        // Create 3 stacked legacy compression groups (all with defaultNow() > times[8])
        const g1 = await compressionRepo.createCompressionGroup({
          content: 'Legacy summary 1',
          messageIds: ['leg-1', 'leg-2'],
          metadata: { endMessageId: 'leg-2', originalMessageCount: 2, startMessageId: 'leg-1' },
          topicId,
        });
        const g2 = await compressionRepo.createCompressionGroup({
          content: 'Legacy summary 2',
          messageIds: ['leg-3', 'leg-4'],
          metadata: { endMessageId: 'leg-4', originalMessageCount: 2, startMessageId: 'leg-3' },
          topicId,
        });
        const g3 = await compressionRepo.createCompressionGroup({
          content: 'Legacy summary 3',
          messageIds: ['leg-5', 'leg-6'],
          metadata: { endMessageId: 'leg-6', originalMessageCount: 2, startMessageId: 'leg-5' },
          topicId,
        });

        expect(await compressionRepo.getCompressionGroups(topicId)).toHaveLength(3);
        expect(g2).not.toBe(g1);
        expect(g3).not.toBe(g1);

        // Consolidate all 3 legacy groups + leg-7, leg-8 into 1 rolling group
        const consolidatedId = await compressionRepo.upsertRollingCompressionGroup({
          content: 'Unified rolling summary of turns 1-4',
          messageIds: ['leg-7', 'leg-8'],
          metadata: {},
          topicId,
        });

        expect(consolidatedId).toBe(g1);

        // Only 1 compression group remains
        const groupsAfter = await compressionRepo.getCompressionGroups(topicId);
        expect(groupsAfter).toHaveLength(1);
        expect(groupsAfter[0].id).toBe(g1);
        expect(groupsAfter[0].content).toBe('Unified rolling summary of turns 1-4');
        // createdAt self-healed to min(createdAt) < active user message
        expect(groupsAfter[0].createdAt.getTime()).toBe(times[0].getTime());
        expect(groupsAfter[0].createdAt.getTime()).toBeLessThan(times[8].getTime());
        expect(groupsAfter[0].metadata).toEqual({
          compressionStrategy: 'summarize',
          endMessageId: 'leg-8',
          originalMessageCount: 8,
          startMessageId: 'leg-1',
        });

        // ZERO messages deleted via ON DELETE CASCADE
        const allDbMessages = await serverDB
          .select()
          .from(messages)
          .where(eq(messages.topicId, topicId));
        expect(allDbMessages).toHaveLength(9);

        const byId = new Map(allDbMessages.map((m) => [m.id, m]));
        for (const id of ['leg-1', 'leg-2', 'leg-3', 'leg-4', 'leg-5', 'leg-6', 'leg-7', 'leg-8']) {
          expect(byId.get(id)?.messageGroupId).toBe(g1);
        }
        expect(byId.get('leg-9')?.messageGroupId).toBeNull();
        expect(byId.get('leg-2')?.favorite).toBe(true);
        expect(byId.get('leg-6')?.favorite).toBe(true);

        // File links survived intact
        const remainingFileLinks = await serverDB
          .select()
          .from(messagesFiles)
          .where(eq(messagesFiles.userId, userId));
        expect(remainingFileLinks.map((f) => f.fileId).sort()).toEqual([
          'file-leg-1',
          'file-leg-2',
          'file-leg-3',
        ]);

        // MessageModel.query returns [compressedGroup, leg-9] with pinnedMessages and fileList intact
        const messageModel = new MessageModel(serverDB, userId);
        const queried = await messageModel.query({ topicId });
        expect(queried).toHaveLength(2);
        expect(queried[0].role).toBe('compressedGroup');
        expect(queried[0].id).toBe(g1);
        expect((queried[0] as any).lastMessageId).toBe('leg-8');
        expect((queried[0] as any).pinnedMessages?.map((m: any) => m.id)).toEqual([
          'leg-2',
          'leg-6',
        ]);

        const compressedFileIds = ((queried[0] as any).compressedMessages ?? [])
          .flatMap((m: any) => (m.fileList ?? []).map((f: any) => f.id))
          .sort();
        expect(compressedFileIds).toEqual(['file-leg-1', 'file-leg-2', 'file-leg-3']);
        expect(queried[1].id).toBe('leg-9');
      });

      it('consolidates legacy stacked groups even when messageIds is empty and isolates parallel/other-topic groups', async () => {
        const otherTopicId = 'other-rolling-topic';
        await serverDB.insert(topics).values({ id: otherTopicId, userId });

        const t1 = new Date('2025-01-01T10:00:00Z');
        const t2 = new Date('2025-01-01T10:01:00Z');
        await serverDB.insert(messages).values([
          { content: 'A', createdAt: t1, id: 'iso-1', role: 'user', topicId, userId },
          { content: 'B', createdAt: t2, id: 'iso-2', role: 'assistant', topicId, userId },
        ]);

        const g1 = await compressionRepo.createCompressionGroup({
          content: 'Old 1',
          messageIds: ['iso-1'],
          metadata: {},
          topicId,
        });
        await compressionRepo.createCompressionGroup({
          content: 'Old 2',
          messageIds: ['iso-2'],
          metadata: {},
          topicId,
        });

        // Parallel group in same topic + compression group in other topic
        await serverDB.insert(messageGroups).values({
          id: 'parallel-group-1',
          topicId,
          type: MessageGroupType.Parallel,
          userId,
        });
        const otherGroupId = await compressionRepo.createCompressionGroup({
          content: 'Other topic summary',
          messageIds: [],
          metadata: {},
          topicId: otherTopicId,
        });

        const resultId = await compressionRepo.upsertRollingCompressionGroup({
          content: 'Consolidated legacy only',
          messageIds: [],
          metadata: {},
          topicId,
        });

        expect(resultId).toBe(g1);
        const groups = await compressionRepo.getCompressionGroups(topicId);
        expect(groups).toHaveLength(1);
        expect(groups[0].metadata).toEqual({
          compressionStrategy: 'summarize',
          endMessageId: 'iso-2',
          originalMessageCount: 2,
          startMessageId: 'iso-1',
        });

        // Parallel group and other topic group remain untouched
        const parallelRows = await serverDB
          .select()
          .from(messageGroups)
          .where(eq(messageGroups.id, 'parallel-group-1'));
        expect(parallelRows).toHaveLength(1);

        const otherTopicGroups = await compressionRepo.getCompressionGroups(otherTopicId);
        expect(otherTopicGroups).toHaveLength(1);
        expect(otherTopicGroups[0].id).toBe(otherGroupId);
      });

      it('protects against ON DELETE CASCADE via NOT EXISTS guard if another user still references a superseded group', async () => {
        const otherUserId = 'other-user-cascade-guard';
        await serverDB.insert(users).values({ id: otherUserId });

        await serverDB.insert(messages).values([
          {
            content: 'Owner msg 1',
            createdAt: new Date('2025-01-01T10:00:00Z'),
            id: 'guard-1',
            role: 'user',
            topicId,
            userId,
          },
          {
            content: 'Owner msg 2',
            createdAt: new Date('2025-01-01T10:01:00Z'),
            id: 'guard-2',
            role: 'assistant',
            topicId,
            userId,
          },
        ]);

        const g1 = await compressionRepo.createCompressionGroup({
          content: 'Group 1',
          messageIds: ['guard-1'],
          metadata: {},
          topicId,
        });
        const g2 = await compressionRepo.createCompressionGroup({
          content: 'Group 2',
          messageIds: ['guard-2'],
          metadata: {},
          topicId,
        });

        // Simulate a foreign-user message pointing to g2 (not reassigned by userId-scoped UPDATE)
        await serverDB.insert(messages).values({
          content: 'Foreign user message on g2',
          createdAt: new Date('2025-01-01T10:02:00Z'),
          id: 'foreign-guard-msg',
          messageGroupId: g2,
          role: 'user',
          topicId,
          userId: otherUserId,
        });

        const keptId = await compressionRepo.upsertRollingCompressionGroup({
          content: 'Consolidated safely',
          messageIds: [],
          metadata: {},
          topicId,
        });

        expect(keptId).toBe(g1);
        // Owner's guard-2 moved to g1
        const ownerCompressed = await compressionRepo.getCompressedMessages(g1);
        expect(ownerCompressed.map((m) => m.id)).toEqual(['guard-1', 'guard-2']);

        // NOT EXISTS prevented deleting g2, so foreign-guard-msg was NOT cascade-deleted!
        const [foreignMsg] = await serverDB
          .select()
          .from(messages)
          .where(eq(messages.id, 'foreign-guard-msg'));
        expect(foreignMsg).toBeDefined();
        expect(foreignMsg?.messageGroupId).toBe(g2);
      });
    });
  });
});
