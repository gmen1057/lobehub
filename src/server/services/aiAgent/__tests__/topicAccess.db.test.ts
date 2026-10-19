// @vitest-environment node
import type { LobeChatDatabase } from '@lobechat/database';
import { topics, users } from '@lobechat/database/schemas';
import { getTestDB } from '@lobechat/database/test-utils';
import { beforeEach, describe, expect, it } from 'vitest';

import { TopicModel } from '@/database/models/topic';

import { assertTopicAccess, TopicNotFoundError } from '../topicAccess';

// arckep (19.10.2026): проверка владельца темы на настоящей базе (запросы с ограничением по человеку и без).

describe('assertTopicAccess на базе', () => {
  let db: LobeChatDatabase;
  let me: string;
  let other: string;

  const check = (topicId: string, allowMissing = false) =>
    assertTopicAccess({
      allowMissing,
      topicId,
      topicModel: new TopicModel(db, me),
      userId: me,
    });

  beforeEach(async () => {
    db = await getTestDB();
    await db.delete(users);
    me = `me-${Date.now()}`;
    other = `other-${Date.now()}`;
    await db.insert(users).values([{ id: me }, { id: other }]);
    await db.insert(topics).values([
      { id: 'tpc_mine', title: 'моя', userId: me },
      { id: 'tpc_theirs', title: 'чужая', userId: other },
    ]);
  });

  it('своя тема проходит', async () => {
    await expect(check('tpc_mine')).resolves.toBeUndefined();
    await expect(check('tpc_mine', true)).resolves.toBeUndefined();
  });

  it('чужая и несуществующая — «Тема не найдена» (одинаковый ответ, чужой номер ничего не выдаёт)', async () => {
    for (const id of ['tpc_theirs', 'tpc_missing']) {
      const error = await check(id).catch((e) => e);
      expect(error).toBeInstanceOf(TopicNotFoundError);
      expect(error.message).toBe('Тема не найдена');
      expect(error.status).toBe(404);
    }
  });

  it('путь бота: несуществующая проходит (лечится по внешнему ключу), чужая — нет', async () => {
    await expect(check('tpc_missing', true)).resolves.toBeUndefined();
    await expect(check('tpc_theirs', true)).rejects.toBeInstanceOf(TopicNotFoundError);
  });
});
