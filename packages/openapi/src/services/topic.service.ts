import { INBOX_SESSION_ID } from '@lobechat/const';
import { and, count, desc, eq, ilike, isNull, notInArray, or } from 'drizzle-orm';

import { agents, agentsToSessions, messages, topics, users } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { idGenerator } from '@/database/utils/idGenerator';

import { BaseService } from '../common/base.service';
import { processPaginationConditions } from '../helpers/pagination';
import type {
  TopicCreateRequest,
  TopicListQuery,
  TopicListResponse,
  TopicResponse,
  TopicUpdateRequest,
} from '../types/topic.type';

export class TopicService extends BaseService {
  constructor(db: LobeChatDatabase, userId: string | null) {
    super(db, userId);
  }

  /**
   * Get topic list (supports filtering by agent/group)
   * @param request Query parameters
   * @returns Topic list
   */
  async getTopics(request: TopicListQuery): Promise<TopicListResponse> {
    try {
      // Permission check
      const permissionResult = await this.resolveOperationPermission('TOPIC_READ');

      if (!permissionResult.isPermitted) {
        throw this.createAuthorizationError(permissionResult.message || '没有权限访问话题列表');
      }

      // Build query conditions
      const conditions = [];

      // Add permission-related query conditions
      if (permissionResult?.condition?.userId) {
        conditions.push(eq(topics.userId, permissionResult.condition.userId));
      }

      // Filter by groupId first
      if (request.groupId) {
        conditions.push(eq(topics.groupId, request.groupId));
      } else if (request.agentId) {
        // arckep (chat-next-redesign, E1): темы из REST/execAgent несут agentId без sessionId
        // (помощник без сессии), темы из интерфейса — sessionId помощника. Ищем по обоим;
        // раньше темы нового экрана не попадали ни в один список.
        const [relation] = await this.db
          .select({ sessionId: agentsToSessions.sessionId })
          .from(agentsToSessions)
          .where(eq(agentsToSessions.agentId, request.agentId))
          .limit(1);

        conditions.push(
          relation?.sessionId
            ? or(eq(topics.agentId, request.agentId), eq(topics.sessionId, relation.sessionId))!
            : eq(topics.agentId, request.agentId),
        );
      } else if (request.isInbox) {
        // inbox: без сессии и группы; agentId пуст (интерфейс) или равен помощнику по умолчанию (REST)
        conditions.push(isNull(topics.sessionId));
        conditions.push(isNull(topics.groupId));
        const [inboxAgent] = await this.db
          .select({ id: agents.id })
          .from(agents)
          .where(and(eq(agents.userId, this.userId), eq(agents.slug, INBOX_SESSION_ID)))
          .limit(1);
        conditions.push(
          inboxAgent
            ? or(isNull(topics.agentId), eq(topics.agentId, inboxAgent.id))!
            : isNull(topics.agentId),
        );
      }

      // Exclude topics with specified trigger sources
      // arckep (19.10.2026): `NULL NOT IN (…)` в SQL даёт NULL — переписки без источника (trigger IS NULL,
      // то есть обычные чаты) пропадали из списка. Берём их явно, как делает модель TopicModel.query.
      if (request.excludeTriggers && request.excludeTriggers.length > 0) {
        conditions.push(
          or(isNull(topics.trigger), notInArray(topics.trigger, request.excludeTriggers))!,
        );
      }

      // If keyword is provided, add fuzzy search condition on title
      if (request.keyword) {
        conditions.push(ilike(topics.title, `%${request.keyword}%`));
      }

      // Unified query path with concurrent count/list
      const { limit, offset } = processPaginationConditions(request);
      const whereExpr = conditions.length ? and(...conditions) : undefined;

      // Build base list query
      const baseListQuery = this.db
        .select({
          messageCount: count(messages.id),
          topic: topics,
          user: users,
        })
        .from(topics)
        .leftJoin(messages, eq(topics.id, messages.topicId))
        .innerJoin(users, eq(topics.userId, users.id))
        .groupBy(topics.id, users.id)
        .orderBy(desc(topics.favorite), desc(topics.createdAt))
        .where(whereExpr);

      // Pagination parameters
      const listQuery = limit ? baseListQuery.limit(limit).offset(offset!) : baseListQuery;

      // Build count query
      const countQuery = this.db.select({ count: count() }).from(topics).where(whereExpr);

      const [result, [countResult]] = await Promise.all([listQuery, countQuery]);

      return {
        topics: result.map((item) => ({
          ...item.topic,
          messageCount: item.messageCount,
          user: item.user,
        })),
        total: countResult.count,
      };
    } catch (error) {
      this.handleServiceError(error, '获取话题列表');
    }
  }

  async getTopicById(topicId: string): Promise<TopicResponse> {
    try {
      // Permission check
      const permissionResult = await this.resolveOperationPermission('TOPIC_READ', {
        targetTopicId: topicId,
      });

      if (!permissionResult.isPermitted) {
        throw this.createAuthorizationError(permissionResult.message || '没有权限访问该话题');
      }

      // Build query conditions
      const whereConditions = [eq(topics.id, topicId)];

      // Apply permission conditions
      if (permissionResult.condition?.userId) {
        whereConditions.push(eq(topics.userId, permissionResult.condition.userId));
      }

      const [result] = await this.db
        .select({
          messageCount: count(messages.id),
          topic: topics,
          user: users,
        })
        .from(topics)
        .leftJoin(messages, eq(topics.id, messages.topicId))
        .innerJoin(users, eq(topics.userId, users.id))
        .where(and(...whereConditions))
        .groupBy(topics.id, users.id)
        .limit(1);

      if (!result) {
        throw this.createNotFoundError('话题不存在');
      }

      return {
        ...result.topic,
        messageCount: result.messageCount,
        user: result.user,
      };
    } catch (error) {
      return this.handleServiceError(error, '获取话题');
    }
  }

  /**
   * Create a new topic
   * @param payload Create parameters
   * @returns Created topic info
   */
  async createTopic(payload: TopicCreateRequest): Promise<TopicResponse> {
    try {
      const { agentId, groupId, title, favorite, clientId } = payload;

      // When agentId is provided, reverse-lookup sessionId
      let effectiveSessionId: string | null = null;

      if (!effectiveSessionId && agentId) {
        const [relation] = await this.db
          .select({ sessionId: agentsToSessions.sessionId })
          .from(agentsToSessions)
          .where(eq(agentsToSessions.agentId, agentId))
          .limit(1);

        effectiveSessionId = relation?.sessionId ?? null;
      }

      const permissionResult = await this.resolveOperationPermission(
        'TOPIC_CREATE',
        effectiveSessionId ? { targetSessionId: effectiveSessionId } : undefined,
      );

      if (!permissionResult.isPermitted) {
        throw this.createAuthorizationError(permissionResult.message || '无权创建话题');
      }

      const [newTopic] = await this.db
        .insert(topics)
        .values({
          agentId: agentId ?? null,
          clientId: clientId ?? null,
          favorite: favorite ?? false,
          groupId: groupId ?? null,
          id: idGenerator('topics'),
          sessionId: effectiveSessionId,
          title,
          userId: this.userId,
        })
        .returning();

      return this.getTopicById(newTopic.id);
    } catch (error) {
      this.handleServiceError(error, '创建话题');
    }
  }

  /**
   * Update topic
   * @param topicId Topic ID
   * @param title Topic title
   * @returns Updated topic info
   */
  async updateTopic(topicId: string, payload: TopicUpdateRequest): Promise<Partial<TopicResponse>> {
    try {
      // Permission check
      const permissionResult = await this.resolveOperationPermission('TOPIC_UPDATE', {
        targetTopicId: topicId,
      });

      if (!permissionResult.isPermitted) {
        throw this.createAuthorizationError(permissionResult.message || '没有权限更新该话题');
      }

      // Build query conditions to check if topic exists
      const whereConditions = [eq(topics.id, topicId)];

      // Apply permission conditions
      if (permissionResult.condition?.userId) {
        whereConditions.push(eq(topics.userId, permissionResult.condition.userId));
      }

      // arckep (chat-next-redesign, E1): перенос переписки в другого помощника. Списки тем ищут
      // по sessionId помощника (agentsToSessions), поэтому одного agentId в строке темы мало:
      // без sessionId тема пропадала бы из обоих списков. agentId: null — вернуть в «без проекта».
      const changes: Record<string, unknown> = { ...payload };
      if ('agentId' in payload) {
        if (payload.agentId) {
          const [agent] = await this.db
            .select({ id: agents.id })
            .from(agents)
            .where(and(eq(agents.id, payload.agentId), eq(agents.userId, this.userId)))
            .limit(1);
          if (!agent) {
            throw this.createNotFoundError('Agent not found');
          }
          // Помощники из интерфейса привязаны к сессии (agentsToSessions), помощники из REST — нет:
          // у их тем sessionId пуст, а привязка идёт по agentId.
          const [relation] = await this.db
            .select({ sessionId: agentsToSessions.sessionId })
            .from(agentsToSessions)
            .where(eq(agentsToSessions.agentId, payload.agentId))
            .limit(1);
          changes.sessionId = relation?.sessionId ?? null;
        } else {
          changes.agentId = null;
          changes.sessionId = null;
        }
      }

      const [updatedTopic] = await this.db
        .update(topics)
        .set(changes)
        .where(and(...whereConditions))
        .returning();

      if (!updatedTopic) {
        throw this.createNotFoundError('话题不存在');
      }

      return this.getTopicById(updatedTopic.id);
    } catch (error) {
      return this.handleServiceError(error, '更新话题');
    }
  }

  /**
   * Delete topic
   * @param topicId Topic ID
   */
  async deleteTopic(topicId: string): Promise<void> {
    try {
      // Permission check
      const permissionResult = await this.resolveOperationPermission('TOPIC_DELETE', {
        targetTopicId: topicId,
      });

      if (!permissionResult.isPermitted) {
        throw this.createAuthorizationError(permissionResult.message || '没有权限删除该话题');
      }

      // Build query conditions to check if topic exists
      const whereConditions = [eq(topics.id, topicId)];

      // Apply permission conditions
      if (permissionResult.condition?.userId) {
        whereConditions.push(eq(topics.userId, permissionResult.condition.userId));
      }

      const [existingTopic] = await this.db
        .delete(topics)
        .where(and(...whereConditions))
        .returning();

      if (!existingTopic) {
        throw this.createNotFoundError('话题不存在');
      }

      this.log('info', 'Topic deleted successfully', { topicId });
    } catch (error) {
      return this.handleServiceError(error, '删除话题');
    }
  }
}
