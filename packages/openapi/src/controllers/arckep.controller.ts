import { INBOX_SESSION_ID } from '@lobechat/const';
import type { Context } from 'hono';

import { AgentModel } from '@/database/models/agent';
import { SessionModel } from '@/database/models/session';
import { AiInfraRepos } from '@/database/repositories/aiInfra';
import { getServerGlobalConfig } from '@/server/globalConfig';
import { AgentService as ServerAgentService } from '@/server/services/agent';
import type { ProviderConfig } from '@/types/user/settings';

import { BaseController } from '../common/base.controller';

/**
 * arckep: маршруты REST, которых не хватает студийному экрану
 * (план lobechat-engine-studio-chat, Phase 2, D5 — только добавления).
 */
export class ArckepController extends BaseController {
  /**
   * GET /api/v1/agents/inbox
   * Помощник по умолчанию («Arckep Помощник»). Список /agents его не отдаёт (virtual),
   * а для нового пользователя его ещё нет — создаём так же, как это делает веб-интерфейс.
   */
  async getInboxAgent(c: Context): Promise<Response> {
    try {
      const db = await this.getDatabase();
      const userId = this.getUserId(c)!;

      const sessionModel = new SessionModel(db, userId);
      const existing = await sessionModel.findByIdOrSlug(INBOX_SESSION_ID);
      if (!existing) {
        await new ServerAgentService(db, userId).createInbox();
      }

      const agent = await new AgentModel(db, userId).getBuiltinAgent(INBOX_SESSION_ID);
      if (!agent) return this.error(c, 'Inbox agent not found', 404);

      return this.success(c, agent, 'inbox agent');
    } catch (error) {
      return this.handleError(c, error);
    }
  }

  /**
   * GET /api/v1/models/runtime
   * Включённые чат-модели движка: встроенный банк моделей + списки из окружения
   * (*_MODEL_LIST) + правки пользователя. Таблица ai_models сама по себе пуста,
   * поэтому обычный /models для студии бесполезен.
   */
  async getRuntimeModels(c: Context): Promise<Response> {
    try {
      const db = await this.getDatabase();
      const userId = this.getUserId(c)!;

      const { aiProvider } = await getServerGlobalConfig();
      const repos = new AiInfraRepos(db, userId, aiProvider as Record<string, ProviderConfig>);
      const models = await repos.getEnabledModels(true);

      const chatModels = models
        .filter((item) => item.type === 'chat')
        .map((item) => ({
          abilities: item.abilities || {},
          contextWindowTokens: item.contextWindowTokens ?? null,
          displayName: item.displayName || item.id,
          id: item.id,
          providerId: item.providerId,
        }));

      return this.success(c, { models: chatModels, total: chatModels.length }, 'runtime models');
    } catch (error) {
      return this.handleError(c, error);
    }
  }
}
