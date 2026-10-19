import type { Context } from 'hono';

import { TopicModel } from '@/database/models/topic';
import { decideConfirmation } from '@/server/services/toolExecution/topicTrust';

import { BaseController } from '../common/base.controller';
import type { ConfirmationDecisionRequest } from '../types/arckep-confirmations.type';

/**
 * arckep (19.10.2026, этап 3, п. 3.Д): человек подтверждает или отклоняет платный запуск студии в теме с чужим
 * инструментом. Только служебный вход студии (кнопка на экране идёт через бэкенд, он проверил человека);
 * тема должна быть этого человека — чужая или несуществующая даёт 404 «Тема не найдена», как у остальных
 * маршрутов движка. Ответ — `{status}`; устаревший запрос — 410, уже решённый иначе или погашенный — 409.
 */
export class ArckepConfirmationController extends BaseController {
  /** POST /api/v1/arckep/topics/:topicId/confirmations/:id { action: 'approve' | 'reject' } */
  async decide(c: Context): Promise<Response> {
    try {
      if (this.getAuthType(c) !== 'arckep-service') {
        return this.error(c, 'Только служебный вход студии', 403);
      }
      const db = await this.getDatabase();
      const userId = this.getUserId(c)!;
      const { id, topicId } = this.getParams<{ id: string; topicId: string }>(c);
      const { action } = await this.getBody<ConfirmationDecisionRequest>(c);

      if (!(await new TopicModel(db, userId).findById(topicId))) {
        return this.error(c, 'Тема не найдена', 404);
      }

      const decision = await decideConfirmation(db, userId, topicId, id, action);
      if (!decision.ok) return this.error(c, decision.message, decision.status);
      return this.success(c, { status: decision.status }, 'confirmation decided');
    } catch (error) {
      return this.handleError(c, error);
    }
  }
}
