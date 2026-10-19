import { and, eq } from 'drizzle-orm';
import type { Context } from 'hono';

import { AgentCronJobModel } from '@/database/models/agentCronJob';
import { TopicModel } from '@/database/models/topic';
import type { AgentCronJob, UpdateAgentCronJobData } from '@/database/schemas';
import { agents } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { runCronJob } from '@/server/services/arckepCron/run';
import {
  CronScheduleError,
  normalizeCronPattern,
  normalizeTimezone,
  validateSchedule,
} from '@/server/services/arckepCron/schedule';

import { BaseController } from '../common/base.controller';
import type {
  CronJobCreateRequest,
  CronJobResponse,
  CronJobRunRequest,
  CronJobTopicResponse,
  CronJobUpdateRequest,
} from '../types/arckep-cron.type';

/**
 * arckep (19.10.2026, задачи помощника по расписанию): REST `/api/v1/arckep/cron-jobs`.
 *
 * Студия создаёт и меняет задачи и просит движок выполнить запуск (`POST /:id/run`); сам цикл «пора ли»
 * живёт в студии. Все запросы строго в пределах пользователя: модели строятся по userId из контекста,
 * чужая или несуществующая задача — 404, чужой помощник при создании — 400.
 */

const iso = (value: Date | string | null | undefined): string | null =>
  value ? new Date(value).toISOString() : null;

export const toCronJob = (job: AgentCronJob): CronJobResponse => ({
  agentId: job.agentId,
  content: job.content,
  createdAt: iso(job.createdAt)!,
  cronPattern: job.cronPattern,
  description: job.description ?? null,
  enabled: Boolean(job.enabled),
  executionConditions: job.executionConditions ?? null,
  id: job.id,
  lastExecutedAt: iso(job.lastExecutedAt),
  maxExecutions: job.maxExecutions ?? null,
  name: job.name ?? null,
  remainingExecutions: job.remainingExecutions ?? null,
  timezone: job.timezone ?? 'UTC',
  totalExecutions: job.totalExecutions ?? 0,
  updatedAt: iso(job.updatedAt)!,
});

const ownsAgent = async (db: LobeChatDatabase, userId: string, agentId: string) => {
  const [agent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.userId, userId)))
    .limit(1);
  return Boolean(agent);
};

export class ArckepCronController extends BaseController {
  /** GET /api/v1/arckep/cron-jobs[?agentId=] — задачи пользователя, новые первыми. */
  async list(c: Context): Promise<Response> {
    try {
      const db = await this.getDatabase();
      const userId = this.getUserId(c)!;
      const { agentId } = this.getQuery<{ agentId?: string }>(c);

      const model = new AgentCronJobModel(db, userId);
      const jobs = agentId ? await model.findByAgentId(agentId) : await model.findByUserId();
      const sorted = [...jobs].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );

      return this.success(c, sorted.map(toCronJob), 'cron jobs');
    } catch (error) {
      return this.handleError(c, error);
    }
  }

  /** POST /api/v1/arckep/cron-jobs */
  async create(c: Context): Promise<Response> {
    try {
      const db = await this.getDatabase();
      const userId = this.getUserId(c)!;
      const body = await this.getBody<CronJobCreateRequest>(c);

      let schedule;
      try {
        schedule = validateSchedule({ cronPattern: body.cronPattern, timezone: body.timezone });
      } catch (error) {
        if (error instanceof CronScheduleError) return this.error(c, error.message, 400);
        throw error;
      }

      if (!(await ownsAgent(db, userId, body.agentId))) {
        return this.error(c, 'Agent not found', 400);
      }

      const job = await new AgentCronJobModel(db, userId).create({
        agentId: body.agentId,
        content: body.content,
        cronPattern: schedule.cronPattern,
        description: body.description ?? null,
        enabled: body.enabled ?? true,
        maxExecutions: body.maxExecutions ?? null,
        name: body.name,
        timezone: schedule.timezone,
      });

      return this.success(c, toCronJob(job), 'cron job created');
    } catch (error) {
      return this.handleError(c, error);
    }
  }

  /** PATCH /api/v1/arckep/cron-jobs/:id */
  async update(c: Context): Promise<Response> {
    try {
      const db = await this.getDatabase();
      const userId = this.getUserId(c)!;
      const { id } = this.getParams<{ id: string }>(c);
      const body = await this.getBody<CronJobUpdateRequest>(c);

      const model = new AgentCronJobModel(db, userId);
      const existing = await model.findById(id);
      if (!existing) return this.error(c, 'Cron job not found', 404);

      const patch: UpdateAgentCronJobData = {};
      try {
        if (body.cronPattern !== undefined) patch.cronPattern = normalizeCronPattern(body.cronPattern);
        if (body.timezone !== undefined) patch.timezone = normalizeTimezone(body.timezone);
      } catch (error) {
        if (error instanceof CronScheduleError) return this.error(c, error.message, 400);
        throw error;
      }

      if (body.agentId !== undefined && body.agentId !== existing.agentId) {
        if (!(await ownsAgent(db, userId, body.agentId))) {
          return this.error(c, 'Agent not found', 400);
        }
        patch.agentId = body.agentId;
      }
      if (body.name !== undefined) patch.name = body.name;
      if (body.content !== undefined) patch.content = body.content;
      if (body.description !== undefined) patch.description = body.description;
      if (body.enabled !== undefined) patch.enabled = body.enabled;
      if (body.maxExecutions !== undefined) patch.maxExecutions = body.maxExecutions;

      const job = await model.update(id, patch);
      if (!job) return this.error(c, 'Cron job not found', 404);

      return this.success(c, toCronJob(job), 'cron job updated');
    } catch (error) {
      return this.handleError(c, error);
    }
  }

  /** DELETE /api/v1/arckep/cron-jobs/:id */
  async remove(c: Context): Promise<Response> {
    try {
      const db = await this.getDatabase();
      const userId = this.getUserId(c)!;
      const { id } = this.getParams<{ id: string }>(c);

      const deleted = await new AgentCronJobModel(db, userId).delete(id);
      if (!deleted) return this.error(c, 'Cron job not found', 404);

      return this.success(c, undefined, 'cron job deleted');
    } catch (error) {
      return this.handleError(c, error);
    }
  }

  /**
   * POST /api/v1/arckep/cron-jobs/:id/run { runId, model?, provider? } — выполнить задачу сейчас (расписание или ручной запуск
   * решает студия, у выключенной задачи запуск тоже разрешён). Ответ 200 всегда, если задача найдена:
   * не стартовало — `success: false` и `error` внутри `data`.
   */
  async run(c: Context): Promise<Response> {
    try {
      const db = await this.getDatabase();
      const userId = this.getUserId(c)!;
      const { id } = this.getParams<{ id: string }>(c);
      const { model, provider, runId } = await this.getBody<CronJobRunRequest>(c);

      const job = await new AgentCronJobModel(db, userId).findById(id);
      if (!job) return this.error(c, 'Cron job not found', 404);

      // Модель задачи хранит студия и передаёт при запуске; без неё — модель помощника.
      const result = await runCronJob(
        db,
        userId,
        job,
        runId,
        model && provider ? { model, provider } : undefined,
      );
      return this.success(c, result, result.success ? 'cron job started' : 'cron job not started');
    } catch (error) {
      return this.handleError(c, error);
    }
  }

  /** GET /api/v1/arckep/cron-jobs/:id/topics[?limit=] — переписки запусков, свежие первыми. */
  async topics(c: Context): Promise<Response> {
    try {
      const db = await this.getDatabase();
      const userId = this.getUserId(c)!;
      const { id } = this.getParams<{ id: string }>(c);
      const { limit } = this.getQuery<{ limit?: number }>(c);

      const job = await new AgentCronJobModel(db, userId).findById(id);
      if (!job) return this.error(c, 'Cron job not found', 404);

      const rows = await new TopicModel(db, userId).getCronTopicsByCronJobId(id, limit ?? 50);
      const data: CronJobTopicResponse[] = rows.map((row) => ({
        createdAt: iso(row.createdAt)!,
        id: row.id,
        title: row.title ?? null,
        updatedAt: iso(row.updatedAt)!,
      }));

      return this.success(c, data, 'cron job topics');
    } catch (error) {
      return this.handleError(c, error);
    }
  }
}
