import { INBOX_SESSION_ID } from '@lobechat/const';
import { LayersEnum } from '@lobechat/types';
import { and, eq } from 'drizzle-orm';
import type { Context } from 'hono';

import { AgentModel } from '@/database/models/agent';
import { SessionModel } from '@/database/models/session';
import { UserModel } from '@/database/models/user';
import {
  UserMemoryActivityModel,
  UserMemoryContextModel,
  UserMemoryExperienceModel,
  UserMemoryModel,
  UserMemoryPreferenceModel,
} from '@/database/models/userMemory';
import { AiInfraRepos } from '@/database/repositories/aiInfra';
import { agents, knowledgeBases } from '@/database/schemas';
import { getServerGlobalConfig } from '@/server/globalConfig';
import { resolveReasoningProfile } from '@/server/modules/AgentRuntime/reasoningLevels';
import { findModelExtendParams } from '@/server/modules/AgentRuntime/serverModelParams';
import { AgentService as ServerAgentService } from '@/server/services/agent';
import type { ProviderConfig } from '@/types/user/settings';

import { BaseController } from '../common/base.controller';
import { PluginService } from '../services/plugin.service';

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

      const agentModel = new AgentModel(db, userId);
      const agent = await agentModel.getBuiltinAgent(INBOX_SESSION_ID);
      if (!agent) return this.error(c, 'Inbox agent not found', 404);
      if (!existing) {
        // arckep (chat-next-redesign, E2): новый пользователь получает подключения каталога
        // и набор инструментов помощника по умолчанию — раньше это делали только SQL-скрипты
        // разом для всех, и новые пользователи оставались ни с чем.
        try {
          await new PluginService(db, userId).installCatalog();
          if (!Array.isArray(agent.plugins) || agent.plugins.length === 0) {
            await agentModel.update(agent.id, { plugins: ArckepController.defaultInboxPlugins() });
          }
        } catch (error) {
          console.error('[arckep] default plugins for new user failed:', error);
        }
      }

      return this.success(c, agent, 'inbox agent');
    } catch (error) {
      return this.handleError(c, error);
    }
  }

  // ---------------------------------------------------------------- подключения (E2)

  /** Подключения по умолчанию для нового помощника «Arckep Помощник» (ARCKEP_DEFAULT_INBOX_PLUGINS). */
  static defaultInboxPlugins(): string[] {
    const raw = process.env.ARCKEP_DEFAULT_INBOX_PLUGINS;
    // Подключения студии mcp-arckep-studio-* (F6) — вместо встроенного arckep-studio; грузятся по требованию.
    const list = (
      raw ??
      [
        'lobe-user-memory',
        'lobe-artifacts',
        'mcp-arckep-wordstat',
        'mcp-arckep-studio-images',
        'mcp-arckep-studio-video',
        'mcp-arckep-studio-higgsfield',
        'mcp-arckep-studio-3d',
        'mcp-arckep-studio-speech',
        'mcp-arckep-studio-presentations',
        'mcp-arckep-studio-models',
        'mcp-arckep-studio-account',
      ].join(',')
    )
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    return [...new Set(list)];
  }

  /** GET /api/v1/plugins — установленные подключения пользователя. */
  async listPlugins(c: Context): Promise<Response> {
    try {
      const db = await this.getDatabase();
      const userId = this.getUserId(c)!;
      const plugins = await new PluginService(db, userId).listInstalled();
      return this.success(c, { plugins, total: plugins.length }, 'installed plugins');
    } catch (error) {
      return this.handleError(c, error);
    }
  }

  /** GET /api/v1/plugins/catalog — доступные коннекторы с отметкой, установлен ли. */
  async pluginCatalog(c: Context): Promise<Response> {
    try {
      const db = await this.getDatabase();
      const userId = this.getUserId(c)!;
      const plugins = await new PluginService(db, userId).catalog();
      return this.success(c, { plugins, total: plugins.length }, 'plugin catalog');
    } catch (error) {
      return this.handleError(c, error);
    }
  }

  /** POST /api/v1/plugins/:identifier/install */
  async installPlugin(c: Context): Promise<Response> {
    try {
      const db = await this.getDatabase();
      const userId = this.getUserId(c)!;
      const { identifier } = this.getParams<{ identifier: string }>(c);
      const plugin = await new PluginService(db, userId).install(identifier);
      if (!plugin) return this.error(c, 'Plugin not found in catalog', 404);
      return this.success(c, plugin, 'plugin installed');
    } catch (error) {
      return this.handleError(c, error);
    }
  }

  /** PATCH /api/v1/plugins/:identifier — настройки подключения. */
  async updatePluginSettings(c: Context): Promise<Response> {
    try {
      const db = await this.getDatabase();
      const userId = this.getUserId(c)!;
      const { identifier } = this.getParams<{ identifier: string }>(c);
      const { settings } = await this.getBody<{ settings: Record<string, unknown> }>(c);
      const plugin = await new PluginService(db, userId).updateSettings(identifier, settings);
      if (!plugin) return this.error(c, 'Plugin not installed', 404);
      return this.success(c, plugin, 'plugin settings updated');
    } catch (error) {
      return this.handleError(c, error);
    }
  }

  /** DELETE /api/v1/plugins/:identifier */
  async uninstallPlugin(c: Context): Promise<Response> {
    try {
      const db = await this.getDatabase();
      const userId = this.getUserId(c)!;
      const { identifier } = this.getParams<{ identifier: string }>(c);
      const removed = await new PluginService(db, userId).uninstall(identifier);
      if (!removed) return this.error(c, 'Plugin not installed', 404);
      return this.success(c, { identifier }, 'plugin removed');
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

      const chatModels = await Promise.all(
        models
          .filter((item) => item.type === 'chat')
          .map(async (item) => ({
            abilities: item.abilities || {},
            contextWindowTokens: item.contextWindowTokens ?? null,
            displayName: item.displayName || item.id,
            id: item.id,
            providerId: item.providerId,
            // Ступени рассуждений для поля ввода студии: тот же расчёт, что у серверного вызова.
            reasoningLevels: item.abilities?.reasoning
              ? (resolveReasoningProfile(
                  item.id,
                  item.providerId,
                  await findModelExtendParams(item.id, item.providerId),
                )?.levels ?? [])
              : [],
          })),
      );

      return this.success(c, { models: chatModels, total: chatModels.length }, 'runtime models');
    } catch (error) {
      return this.handleError(c, error);
    }
  }

  /**
   * GET /api/v1/memories — память пользователя (все слои или один), постранично.
   */
  async getMemories(c: Context): Promise<Response> {
    try {
      const db = await this.getDatabase();
      const userId = this.getUserId(c)!;
      const query = this.getQuery<{
        layer?: LayersEnum;
        page?: number;
        pageSize?: number;
        q?: string;
      }>(c);

      const memoryModel = new UserMemoryModel(db, userId);
      const result = await memoryModel.queryMemories({
        layer: query.layer,
        order: 'desc',
        page: query.page ?? 1,
        pageSize: query.pageSize ?? 50,
        q: query.q,
      });

      return this.success(c, result, 'memories');
    } catch (error) {
      return this.handleError(c, error);
    }
  }

  /**
   * GET /api/v1/memories/settings — память между чатами для всего аккаунта (F7, 19.10).
   * Это `userSettings.memory.enabled` движка: его читает execAgent, когда у помощника нет своего правила;
   * не задано — включена.
   */
  async getMemorySettings(c: Context): Promise<Response> {
    try {
      const db = await this.getDatabase();
      const settings = await new UserModel(db, this.getUserId(c)!).getUserSettings();
      const memory = settings?.memory as { enabled?: boolean } | null | undefined;
      return this.success(c, { enabled: memory?.enabled !== false }, 'memory settings');
    } catch (error) {
      return this.handleError(c, error);
    }
  }

  /**
   * PATCH /api/v1/memories/settings — включить или выключить память для аккаунта; остальные поля
   * `memory` (effort) не трогаются.
   */
  async updateMemorySettings(c: Context): Promise<Response> {
    try {
      const db = await this.getDatabase();
      const { enabled } = await this.getBody<{ enabled: boolean }>(c);
      const userModel = new UserModel(db, this.getUserId(c)!);
      const settings = await userModel.getUserSettings();
      const current = (settings?.memory as Record<string, unknown> | null | undefined) ?? {};
      await userModel.updateSetting({ memory: { ...current, enabled } });
      return this.success(c, { enabled }, 'memory settings updated');
    } catch (error) {
      return this.handleError(c, error);
    }
  }

  /**
   * DELETE /api/v1/memories/:id?layer= — удалить одну запись памяти своего пользователя.
   * Слой обязателен: записи разных слоёв лежат в разных таблицах (как в tRPC userMemory.delete*).
   */
  async deleteMemory(c: Context): Promise<Response> {
    try {
      const db = await this.getDatabase();
      const userId = this.getUserId(c)!;
      const id = c.req.param('id');
      const { layer } = this.getQuery<{ layer: LayersEnum }>(c);

      switch (layer) {
        case LayersEnum.Activity: {
          await new UserMemoryActivityModel(db, userId).delete(id);
          break;
        }
        case LayersEnum.Context: {
          await new UserMemoryContextModel(db, userId).delete(id);
          break;
        }
        case LayersEnum.Experience: {
          await new UserMemoryExperienceModel(db, userId).delete(id);
          break;
        }
        case LayersEnum.Identity: {
          await new UserMemoryModel(db, userId).removeIdentityEntry(id);
          break;
        }
        case LayersEnum.Preference: {
          await new UserMemoryPreferenceModel(db, userId).delete(id);
          break;
        }
        default: {
          return this.error(c, 'Unknown memory layer', 400);
        }
      }

      return this.success(c, { id, layer }, 'memory deleted');
    } catch (error) {
      return this.handleError(c, error);
    }
  }

  /**
   * GET /api/v1/agents/:id/knowledge-bases — базы знаний, привязанные к помощнику.
   */
  async getAgentKnowledgeBases(c: Context): Promise<Response> {
    try {
      const db = await this.getDatabase();
      const userId = this.getUserId(c)!;
      const agentId = c.req.param('id');
      const knowledge = await new AgentModel(db, userId).getAgentAssignedKnowledge(agentId);
      return this.success(c, knowledge, 'agent knowledge');
    } catch (error) {
      return this.handleError(c, error);
    }
  }

  /**
   * POST /api/v1/agents/:id/knowledge-bases { knowledgeBaseId, enabled? } — привязать базу знаний.
   * Помощник и база должны принадлежать пользователю (проверяется по userId в запросах модели).
   */
  async linkAgentKnowledgeBase(c: Context): Promise<Response> {
    try {
      const db = await this.getDatabase();
      const userId = this.getUserId(c)!;
      const agentId = c.req.param('id');
      const body = await c.req.json<{ enabled?: boolean; knowledgeBaseId?: string }>();
      const knowledgeBaseId = body?.knowledgeBaseId;
      if (!knowledgeBaseId) return this.error(c, 'knowledgeBaseId is required', 400);

      const agentModel = new AgentModel(db, userId);
      const [agent] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.userId, userId)))
        .limit(1);
      if (!agent) return this.error(c, 'Agent not found', 404);
      const [kb] = await db
        .select({ id: knowledgeBases.id })
        .from(knowledgeBases)
        .where(and(eq(knowledgeBases.id, knowledgeBaseId), eq(knowledgeBases.userId, userId)))
        .limit(1);
      if (!kb) return this.error(c, 'Knowledge base not found', 404);

      await agentModel.deleteAgentKnowledgeBase(agentId, knowledgeBaseId);
      await agentModel.createAgentKnowledgeBase(agentId, knowledgeBaseId, body?.enabled ?? true);
      return this.success(
        c,
        { agentId, enabled: body?.enabled ?? true, knowledgeBaseId },
        'linked',
      );
    } catch (error) {
      return this.handleError(c, error);
    }
  }

  /**
   * DELETE /api/v1/agents/:id/knowledge-bases/:kbId — отвязать базу знаний.
   */
  async unlinkAgentKnowledgeBase(c: Context): Promise<Response> {
    try {
      const db = await this.getDatabase();
      const userId = this.getUserId(c)!;
      const agentId = c.req.param('id');
      const knowledgeBaseId = c.req.param('kbId');
      await new AgentModel(db, userId).deleteAgentKnowledgeBase(agentId, knowledgeBaseId);
      return this.success(c, { agentId, knowledgeBaseId }, 'unlinked');
    } catch (error) {
      return this.handleError(c, error);
    }
  }
}
