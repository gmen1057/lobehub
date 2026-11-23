import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';

import { compactTopic, TopicCompactHttpError } from '@/server/services/topic/compactTopic';

import { BaseController } from '../common/base.controller';
import { hasInFlightResponseTopic } from '../services/engineSlotActivity';
import { responsesStreamHub } from '../services/responsesStreamHub';
import { TopicService } from '../services/topic.service';
import type { TopicCreateRequest, TopicListQuery, TopicUpdateRequest } from '../types/topic.type';
import { TopicCompactRequestSchema } from '../types/topic.type';

export class TopicController extends BaseController {
  /**
   * Retrieves the topic list
   * GET /api/v1/topics?keyword=xxx
   * Query: { keyword?: string, agentId?: string, groupId?: string, isInbox?: boolean }
   */
  async handleGetTopics(c: Context) {
    try {
      const userId = this.getUserId(c)!;
      const request = this.getQuery<TopicListQuery>(c);

      const db = await this.getDatabase();
      const topicService = new TopicService(db, userId);

      const topics = await topicService.getTopics(request);

      return this.success(c, topics, '获取话题列表成功');
    } catch (error) {
      return this.handleError(c, error);
    }
  }

  /**
   * Retrieves a specific topic
   * GET /api/v1/topics/:id
   * Params: { id: string }
   */
  async handleGetTopicById(c: Context) {
    try {
      const userId = this.getUserId(c)!;
      const { id } = this.getParams<{ id: string }>(c);

      const db = await this.getDatabase();
      const topicService = new TopicService(db, userId);
      const topic = await topicService.getTopicById(id);

      return this.success(c, topic, '获取话题成功');
    } catch (error) {
      return this.handleError(c, error);
    }
  }

  async handleGetCodeFiles(c: Context) {
    try {
      const { id } = this.getParams<{ id: string }>(c);
      const { TextFileStore } = await import('@/server/services/textFiles/store');
      const store = new TextFileStore(await this.getDatabase(), this.getUserId(c)!, id);
      if (!(await store.ownsTopic())) return this.error(c, 'Topic not found', 404);
      c.header('Cache-Control', 'private, no-store');
      return c.json({ files: await store.list() });
    } catch (error) {
      return this.handleError(c, error);
    }
  }

  /**
   * Creates a new topic
   * POST /api/v1/topics
   * Body: { agentId?: string, groupId?: string, title: string, favorite?: boolean, clientId?: string }
   */
  async handleCreateTopic(c: Context) {
    try {
      const userId = this.getUserId(c)!;
      const payload = await this.getBody<TopicCreateRequest>(c);

      const db = await this.getDatabase();
      const topicService = new TopicService(db, userId);
      const newTopic = await topicService.createTopic(payload);

      return this.success(c, newTopic, '创建话题成功');
    } catch (error) {
      return this.handleError(c, error);
    }
  }

  /**
   * Updates a topic
   * PATCH /api/v1/topics/:id
   * Body: { title?: string, favorite?: boolean, historySummary?: string, metadata?: object }
   */
  async handleUpdateTopic(c: Context) {
    try {
      const userId = this.getUserId(c)!;
      const { id } = this.getParams<{ id: string }>(c);
      const payload = await this.getBody<TopicUpdateRequest>(c);

      const db = await this.getDatabase();
      const topicService = new TopicService(db, userId);
      const updatedTopic = await topicService.updateTopic(id, payload);

      return this.success(c, updatedTopic, '更新话题成功');
    } catch (error) {
      return this.handleError(c, error);
    }
  }

  /**
   * Manually compacts topic conversation history into a rolling compression group
   * POST /api/v1/topics/:id/compact
   * Params: { id: string }
   * Body (optional): { beforeMessageId?: string | null, dataGuardProtected?: boolean }
   */
  async handleCompactTopic(c: Context) {
    try {
      const userId = this.getUserId(c)!;
      const { id } = this.getParams<{ id: string }>(c);

      const rawBody = await c.req.text();
      let parsedJson: unknown = {};
      if (rawBody.trim().length > 0) {
        try {
          parsedJson = JSON.parse(rawBody);
        } catch {
          return this.error(c, 'Invalid JSON body', 400);
        }
      }

      const parsedBody = TopicCompactRequestSchema.safeParse(parsedJson);
      if (!parsedBody.success) {
        return this.error(c, parsedBody.error.issues[0]?.message || 'Invalid request body', 400);
      }

      const db = await this.getDatabase();
      const result = await compactTopic({
        beforeMessageId: parsedBody.data.beforeMessageId,
        dataGuardProtected: parsedBody.data.dataGuardProtected,
        db,
        isTopicBusy: () => {
          const op = responsesStreamHub.findByTopic(userId, id);
          if (op && !op.done && !op.cancelRequested) return true;
          return hasInFlightResponseTopic(userId, id);
        },
        topicId: id,
        userId,
      });

      return this.success(c, result, 'Topic compacted successfully');
    } catch (error) {
      if (error instanceof TopicCompactHttpError) {
        return this.handleError(c, new HTTPException(error.status, { message: error.message }));
      }
      return this.handleError(c, error);
    }
  }

  /**
   * Deletes a topic
   * DELETE /api/v1/topics/:id
   * Params: { id: string }
   */
  async handleDeleteTopic(c: Context) {
    try {
      const userId = this.getUserId(c)!;
      const { id: topicId } = this.getParams<{ id: string }>(c);

      const db = await this.getDatabase();
      const topicService = new TopicService(db, userId);
      await topicService.deleteTopic(topicId);

      return this.success(c, null, '删除话题成功');
    } catch (error) {
      return this.handleError(c, error);
    }
  }
}
