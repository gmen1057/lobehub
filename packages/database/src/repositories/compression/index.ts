import type { CompressionGroupMetadata } from '@lobechat/types';
import { MessageGroupType } from '@lobechat/types';
import { and, asc, eq, inArray, isNull, notExists, sql } from 'drizzle-orm';

import type { MessageGroupItem } from '../../schemas';
import { messageGroups, messages } from '../../schemas';
import type { LobeChatDatabase } from '../../type';

export interface CreateCompressionGroupParams {
  content: string;
  editorData?: any;
  messageIds: string[];
  metadata: CompressionGroupMetadata;
  topicId: string;
}

export interface CompressionGroupResult {
  content: string | null;
  createdAt: Date;
  description: string | null;
  editorData: unknown;
  id: string;
  metadata: CompressionGroupMetadata | null;
  topicId: string | null;
  type: string | null;
}

/**
 * Compression Repository - handles message compression operations
 */
export class CompressionRepository {
  private userId: string;
  private db: LobeChatDatabase;

  constructor(db: LobeChatDatabase, userId: string) {
    this.userId = userId;
    this.db = db;
  }

  /**
   * Create a compression group and mark messages as compressed
   */
  async createCompressionGroup(params: CreateCompressionGroupParams): Promise<string> {
    const { topicId, content, editorData, messageIds, metadata } = params;
    if (!content.trim()) throw new Error('Compression summary must not be empty');

    // Store metadata in the description field as JSON string
    const description = JSON.stringify(metadata);

    return this.db.transaction(async (tx) => {
      const result = (await tx
        .insert(messageGroups)
        .values({
          content,
          description,
          editorData,
          topicId,
          type: MessageGroupType.Compression,
          userId: this.userId,
        })
        .returning()) as MessageGroupItem[];

      const group = result[0];

      // Readers must never observe hidden messages without the stored summary.
      if (messageIds.length > 0) {
        await tx
          .update(messages)
          .set({ messageGroupId: group.id })
          .where(
            and(
              eq(messages.userId, this.userId),
              eq(messages.topicId, topicId),
              inArray(messages.id, messageIds),
            ),
          );
      }

      return group.id;
    });
  }

  /**
   * Upsert a single rolling compression group for a topic in one transaction.
   * Keeps the oldest existing compression group in-place (inserting only if none exist),
   * reassigns messages from superseded groups and new messageIds BEFORE deleting empty
   * superseded groups (ON DELETE CASCADE safety), and anchors createdAt to min(createdAt)
   * of all messages in the group.
   */
  async upsertRollingCompressionGroup(params: CreateCompressionGroupParams): Promise<string> {
    const { topicId, content, editorData, messageIds, metadata = {} } = params;
    if (!content.trim()) throw new Error('Compression summary must not be empty');

    return this.db.transaction(async (tx) => {
      const existingGroups = await tx
        .select({
          description: messageGroups.description,
          id: messageGroups.id,
        })
        .from(messageGroups)
        .where(
          and(
            eq(messageGroups.userId, this.userId),
            eq(messageGroups.topicId, topicId),
            eq(messageGroups.type, MessageGroupType.Compression),
          ),
        )
        .orderBy(asc(messageGroups.createdAt), asc(messageGroups.id));

      let targetGroupId: string;
      let existingDescription: string | null = null;
      let supersededIds: string[] = [];

      if (existingGroups.length > 0) {
        targetGroupId = existingGroups[0].id;
        existingDescription = existingGroups[0].description;
        supersededIds = existingGroups.slice(1).map((group) => group.id);
      } else {
        const initialDescription = JSON.stringify({
          ...metadata,
          compressionStrategy: metadata.compressionStrategy ?? 'summarize',
        });
        const result = (await tx
          .insert(messageGroups)
          .values({
            content,
            description: initialDescription,
            editorData,
            topicId,
            type: MessageGroupType.Compression,
            userId: this.userId,
          })
          .returning()) as MessageGroupItem[];

        targetGroupId = result[0].id;
      }

      // CRITICAL ON DELETE CASCADE SAFETY: Reassign ALL messages BEFORE any DELETE.
      if (supersededIds.length > 0) {
        await tx
          .update(messages)
          .set({ messageGroupId: targetGroupId })
          .where(
            and(eq(messages.userId, this.userId), inArray(messages.messageGroupId, supersededIds)),
          );
      }

      if (messageIds.length > 0) {
        await tx
          .update(messages)
          .set({ messageGroupId: targetGroupId })
          .where(
            and(
              eq(messages.userId, this.userId),
              eq(messages.topicId, topicId),
              inArray(messages.id, messageIds),
            ),
          );
      }

      const groupMessages = await tx
        .select({
          createdAt: messages.createdAt,
          id: messages.id,
        })
        .from(messages)
        .where(and(eq(messages.userId, this.userId), eq(messages.messageGroupId, targetGroupId)))
        .orderBy(asc(messages.createdAt), asc(messages.id));

      const minCreatedAt = groupMessages[0]?.createdAt;
      const totalCount = groupMessages.length;
      const startMessageId = groupMessages[0]?.id;
      const endMessageId = groupMessages.at(-1)?.id;

      let existingMetadata: CompressionGroupMetadata = {};
      if (existingDescription) {
        try {
          existingMetadata = JSON.parse(existingDescription) as CompressionGroupMetadata;
        } catch {
          existingMetadata = {};
        }
      }

      const mergedMetadata: CompressionGroupMetadata = {
        ...existingMetadata,
        ...metadata,
        compressionStrategy:
          metadata.compressionStrategy ?? existingMetadata.compressionStrategy ?? 'summarize',
        endMessageId: endMessageId ?? metadata.endMessageId,
        originalMessageCount: totalCount,
        startMessageId: startMessageId ?? metadata.startMessageId,
      };

      const updateValues: {
        content: string;
        createdAt?: Date;
        description: string;
        editorData?: unknown;
        updatedAt: Date;
      } = {
        content,
        description: JSON.stringify(mergedMetadata),
        updatedAt: new Date(),
      };

      if (minCreatedAt) {
        updateValues.createdAt = minCreatedAt;
      }

      if (editorData !== undefined) {
        updateValues.editorData = editorData;
      }

      await tx
        .update(messageGroups)
        .set(updateValues)
        .where(and(eq(messageGroups.id, targetGroupId), eq(messageGroups.userId, this.userId)));

      if (supersededIds.length > 0) {
        await tx.delete(messageGroups).where(
          and(
            eq(messageGroups.userId, this.userId),
            eq(messageGroups.topicId, topicId),
            eq(messageGroups.type, MessageGroupType.Compression),
            inArray(messageGroups.id, supersededIds),
            notExists(
              tx
                .select({ one: sql`1` })
                .from(messages)
                .where(eq(messages.messageGroupId, messageGroups.id)),
            ),
          ),
        );
      }

      return targetGroupId;
    });
  }

  /**
   * Get all compression groups for a topic
   */
  async getCompressionGroups(topicId: string): Promise<CompressionGroupResult[]> {
    const groups = await this.db
      .select()
      .from(messageGroups)
      .where(
        and(
          eq(messageGroups.userId, this.userId),
          eq(messageGroups.topicId, topicId),
          eq(messageGroups.type, MessageGroupType.Compression),
        ),
      )
      .orderBy(messageGroups.createdAt);

    // Parse description field as metadata
    return groups.map((group) => ({
      ...group,
      metadata: group.description ? JSON.parse(group.description) : null,
    })) as unknown as CompressionGroupResult[];
  }

  /**
   * Get the latest compression group for a topic
   */
  async getLatestCompressionGroup(topicId: string): Promise<CompressionGroupResult | null> {
    const groups = await this.getCompressionGroups(topicId);
    return groups.length > 0 ? groups.at(-1)! : null;
  }

  /**
   * Update compression group content
   */
  async updateCompressionContent(
    groupId: string,
    content: string,
    metadata?: Partial<CompressionGroupMetadata>,
  ): Promise<void> {
    if (!content.trim()) throw new Error('Compression summary must not be empty');
    const updateData: Record<string, unknown> = {
      content,
      updatedAt: new Date(),
    };

    if (metadata) {
      // Need to merge with existing metadata
      const existing = await this.db
        .select({ description: messageGroups.description })
        .from(messageGroups)
        .where(and(eq(messageGroups.id, groupId), eq(messageGroups.userId, this.userId)));

      const existingMetadata = existing[0]?.description ? JSON.parse(existing[0].description) : {};
      updateData.description = JSON.stringify({ ...existingMetadata, ...metadata });
    }

    await this.db
      .update(messageGroups)
      .set(updateData)
      .where(and(eq(messageGroups.id, groupId), eq(messageGroups.userId, this.userId)));
  }

  /**
   * Update compression group metadata (UI state like expanded)
   */
  async updateMetadata(
    groupId: string,
    metadata: Partial<CompressionGroupMetadata>,
  ): Promise<void> {
    // Get existing metadata and merge
    const existing = await this.db
      .select({ metadata: messageGroups.metadata })
      .from(messageGroups)
      .where(and(eq(messageGroups.id, groupId), eq(messageGroups.userId, this.userId)));

    const existingData = (existing[0]?.metadata as Record<string, unknown>) || {};
    const newMetadata = { ...existingData, ...metadata };

    await this.db
      .update(messageGroups)
      .set({ metadata: newMetadata, updatedAt: new Date() })
      .where(and(eq(messageGroups.id, groupId), eq(messageGroups.userId, this.userId)));
  }

  /**
   * Mark messages as compressed by associating them with a compression group
   */
  async markMessagesAsCompressed(messageIds: string[], groupId: string): Promise<void> {
    if (messageIds.length === 0) return;

    await this.db
      .update(messages)
      .set({ messageGroupId: groupId })
      .where(and(eq(messages.userId, this.userId), inArray(messages.id, messageIds)));
  }

  /**
   * Unmark messages from compression (remove from compression group)
   */
  async unmarkMessagesFromCompression(messageIds: string[]): Promise<void> {
    if (messageIds.length === 0) return;

    await this.db
      .update(messages)
      .set({ messageGroupId: null })
      .where(and(eq(messages.userId, this.userId), inArray(messages.id, messageIds)));
  }

  /**
   * Toggle pin status for a message
   */
  async toggleMessagePin(messageId: string, pinned: boolean): Promise<void> {
    // Get current metadata
    const [message] = await this.db
      .select({ metadata: messages.metadata })
      .from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.userId, this.userId)));

    if (!message) return;

    const currentMetadata = (message.metadata as Record<string, unknown>) || {};
    const newMetadata = { ...currentMetadata, pinned };

    await this.db
      .update(messages)
      .set({ metadata: newMetadata })
      .where(and(eq(messages.id, messageId), eq(messages.userId, this.userId)));
  }

  /**
   * Get messages that are not compressed (for sending to LLM)
   */
  async getUncompressedMessages(topicId: string) {
    return this.db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.userId, this.userId),
          eq(messages.topicId, topicId),
          isNull(messages.messageGroupId),
        ),
      )
      .orderBy(messages.createdAt);
  }

  /**
   * Get compressed messages for a specific compression group
   */
  async getCompressedMessages(groupId: string) {
    return this.db
      .select()
      .from(messages)
      .where(and(eq(messages.userId, this.userId), eq(messages.messageGroupId, groupId)))
      .orderBy(messages.createdAt);
  }

  /**
   * Delete a compression group and unmark all associated messages
   */
  async deleteCompressionGroup(groupId: string): Promise<void> {
    // 1. Unmark all messages
    await this.db
      .update(messages)
      .set({ messageGroupId: null })
      .where(and(eq(messages.userId, this.userId), eq(messages.messageGroupId, groupId)));

    // 2. Delete the group
    await this.db
      .delete(messageGroups)
      .where(and(eq(messageGroups.id, groupId), eq(messageGroups.userId, this.userId)));
  }
}
