import { type TopicModel } from '@/database/models/topic';

/**
 * Тема не найдена или не принадлежит человеку. Имя `NotFoundError` — как в BaseController openapi: он отдаёт
 * такой ошибке HTTP 404. Текст один и для чужой, и для несуществующей темы: чужой номер ничего не выдаёт.
 */
export class TopicNotFoundError extends Error {
  readonly status = 404;

  constructor() {
    super('Тема не найдена');
    this.name = 'NotFoundError';
  }
}

/**
 * arckep (19.10.2026): номер темы приходит в операцию от клиента (previous_response_id, appContext.topicId),
 * а execAgent раньше «переиспользовал существующую тему» без проверки владельца: сообщения записывались в
 * чужую тему, а её номер становился ключом песочницы и других данных операции. Теперь тема должна быть
 * этого человека (TopicModel ограничен userId).
 *
 * `allowMissing` — для ботов (Telegram, Discord…): они берут номер из состояния ветки и сами лечат
 * «тема удалена» по нарушению внешнего ключа topic_id (AgentBridgeService.handleSubscribedMessage). Их
 * несуществующая тема проходит дальше как раньше; чужая (тема есть, владелец другой) отклоняется и у них.
 */
export const assertTopicAccess = async (options: {
  allowMissing?: boolean;
  topicId: string;
  topicModel: Pick<TopicModel, 'findById' | 'findOwnerId'>;
  userId: string;
}): Promise<void> => {
  const { allowMissing, topicId, topicModel, userId } = options;

  if (await topicModel.findById(topicId)) return;

  if (!allowMissing) throw new TopicNotFoundError();

  // Не найдена среди тем человека: либо не существует (бот лечит сам), либо чужая.
  const ownerId = await topicModel.findOwnerId(topicId);
  if (ownerId && ownerId !== userId) throw new TopicNotFoundError();
};
