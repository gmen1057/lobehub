// @vitest-environment node
import type { LobeChatDatabase } from '@lobechat/database';
import { topics, users } from '@lobechat/database/schemas';
import { getTestDB } from '@lobechat/database/test-utils';
import { LobeChatTopicResultRecorder } from '@lobechat/memory-user-memory';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  gatePaidToolCall,
  markTopicUntrusted,
  readConfirmation,
} from '@/server/services/toolExecution/topicTrust';

/**
 * arckep (19.10.2026, этап 3): запись результата разбора памяти не стирает чужие ключи metadata темы. Раньше она
 * перезаписывала объект целиком по снимку, снятому до начала разбора, — метку «чужой инструмент»
 * (`arckepUntrusted`) и запросы подтверждения (`arckepConfirmations`), поставленные за это время, это затирало.
 */

describe('разбор памяти и metadata темы', () => {
  let db: LobeChatDatabase;
  let userId: string;
  const topicId = 'tpc_mem';

  const metadataOf = async () =>
    (await db.select({ metadata: topics.metadata }).from(topics).where(eq(topics.id, topicId)))[0]
      ?.metadata as Record<string, any>;

  const job = () => ({ userId }) as any;

  beforeEach(async () => {
    db = await getTestDB();
    await db.delete(users);
    userId = `u-${Date.now()}`;
    await db.insert(users).values({ id: userId });
    await db.insert(topics).values({
      id: topicId,
      metadata: { model: 'm1', userMemoryExtractStatus: 'pending' } as any,
      title: 'чат',
      userId,
    });
  });

  // снимок metadata снят ДО разбора (так делает extract.ts), а метка и запрос появились уже во время него
  const snapshot = { model: 'm1', userMemoryExtractStatus: 'pending' } as const;

  const markAndAsk = async () => {
    await markTopicUntrusted(db, userId, topicId, 'umcp-aaaaaaaaaaaa');
    const held = await gatePaidToolCall(db, userId, topicId, {
      apiName: 'create_image',
      arguments: '{"prompt":"кот"}',
      identifier: 'mcp-arckep-studio-images',
    });
    if (held.action !== 'blocked') throw new Error('unreachable');
    return JSON.parse(held.content.split('\n').find((l) => l.startsWith('ARCKEP_CONFIRM '))!.slice(15))
      .id as string;
  };

  it('успешный разбор: статус памяти записан, метка и запрос подтверждения на месте', async () => {
    const id = await markAndAsk();

    await new LobeChatTopicResultRecorder({
      currentMetadata: snapshot as any,
      database: db,
      lastMessageAt: '2026-10-19T12:00:00.000Z',
      messageCount: 4,
      topicId,
    }).recordComplete(job(), { processedMemoryCount: 2 } as any);

    const metadata = await metadataOf();
    expect(metadata.userMemoryExtractStatus).toBe('completed');
    expect(metadata.userMemoryExtractRunState).toMatchObject({ messageCount: 4, processedMemoryCount: 2 });
    expect(metadata.model).toBe('m1');
    expect(metadata.arckepUntrusted).toMatchObject({ identifier: 'umcp-aaaaaaaaaaaa' });
    expect((await readConfirmation(db, userId, topicId, id))?.status).toBe('pending');
  });

  it('неудачный разбор: статус «failed» записан, метка и запрос на месте', async () => {
    const id = await markAndAsk();

    await new LobeChatTopicResultRecorder({
      currentMetadata: snapshot as any,
      database: db,
      topicId,
    }).recordFail(job(), new Error('модель недоступна'));

    const metadata = await metadataOf();
    expect(metadata.userMemoryExtractStatus).toBe('failed');
    expect(metadata.userMemoryExtractRunState.error).toBe('модель недоступна');
    expect(metadata.arckepUntrusted).toBeTruthy();
    expect((await readConfirmation(db, userId, topicId, id))?.status).toBe('pending');
  });

  it('чужая тема не меняется; updated_at темы не двигается', async () => {
    const [before] = await db.select({ updatedAt: topics.updatedAt }).from(topics).where(eq(topics.id, topicId));
    await db.insert(users).values({ id: `${userId}-other` });
    await new LobeChatTopicResultRecorder({ database: db, topicId }).recordComplete(
      { userId: `${userId}-other` } as any,
      { processedMemoryCount: 1 } as any,
    );
    expect((await metadataOf()).userMemoryExtractStatus).toBe('pending');

    await new LobeChatTopicResultRecorder({ database: db, topicId }).recordComplete(job(), {
      processedMemoryCount: 1,
    } as any);
    const [after] = await db.select({ updatedAt: topics.updatedAt }).from(topics).where(eq(topics.id, topicId));
    expect(after.updatedAt).toEqual(before.updatedAt);
  });

  it('тема без metadata (NULL) тоже получает статус', async () => {
    await db.update(topics).set({ metadata: null as any }).where(eq(topics.id, topicId));
    await new LobeChatTopicResultRecorder({ database: db, topicId }).recordComplete(job(), {
      processedMemoryCount: 0,
    } as any);
    expect((await metadataOf()).userMemoryExtractStatus).toBe('completed');
  });
});
