import { TopicModel } from '@/database/models/topic';
import { type LobeChatDatabase } from '@/database/type';

/**
 * arckep (19.10.2026): песочница E2B ключуется номером темы, а шлюз доверяет заголовку X-Arckep-Topic. Номер
 * темы приходит в операцию от клиента (previous_response_id, appContext.topicId), и движок не проверяет, чья
 * это тема. Поэтому перед тем как отдать номер темы шлюзу, убеждаемся, что тема принадлежит этому человеку
 * (TopicModel ограничен userId): чужой номер не должен вести в чужую песочницу. Ошибка базы = не принадлежит.
 */
export const userOwnsTopic = async (
  db: LobeChatDatabase,
  userId: string,
  topicId: string | undefined,
): Promise<boolean> => {
  if (!topicId) return false;
  try {
    return !!(await new TopicModel(db, userId).findById(topicId));
  } catch {
    return false;
  }
};
