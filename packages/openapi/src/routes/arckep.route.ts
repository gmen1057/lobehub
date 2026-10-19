import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';

import { ArckepCronController } from '../controllers/arckep-cron.controller';
import { requireAuth } from '../middleware/auth';
import {
  CronJobCreateSchema,
  CronJobIdParamSchema,
  CronJobListQuerySchema,
  CronJobRunSchema,
  CronJobTopicsQuerySchema,
  CronJobUpdateSchema,
} from '../types/arckep-cron.type';

/**
 * arckep (19.10.2026, задачи помощника по расписанию): `/api/v1/arckep/*`.
 * Права — только свои записи (AgentCronJobModel ограничен userId), отдельных scope RBAC у задач нет — как у
 * подключений и памяти. Служебный вход студии (Bearer ARCKEP_ENGINE_SERVICE_KEY + X-Arckep-User-Id) работает
 * через общий userAuthMiddleware.
 */
const ArckepRoutes = new Hono();

// GET /api/v1/arckep/cron-jobs[?agentId=]
ArckepRoutes.get(
  '/cron-jobs',
  requireAuth,
  zValidator('query', CronJobListQuerySchema),
  async (c) => new ArckepCronController().list(c),
);

// POST /api/v1/arckep/cron-jobs
ArckepRoutes.post(
  '/cron-jobs',
  requireAuth,
  zValidator('json', CronJobCreateSchema),
  async (c) => new ArckepCronController().create(c),
);

// PATCH /api/v1/arckep/cron-jobs/:id
ArckepRoutes.patch(
  '/cron-jobs/:id',
  requireAuth,
  zValidator('param', CronJobIdParamSchema),
  zValidator('json', CronJobUpdateSchema),
  async (c) => new ArckepCronController().update(c),
);

// DELETE /api/v1/arckep/cron-jobs/:id
ArckepRoutes.delete(
  '/cron-jobs/:id',
  requireAuth,
  zValidator('param', CronJobIdParamSchema),
  async (c) => new ArckepCronController().remove(c),
);

// POST /api/v1/arckep/cron-jobs/:id/run { runId }
ArckepRoutes.post(
  '/cron-jobs/:id/run',
  requireAuth,
  zValidator('param', CronJobIdParamSchema),
  zValidator('json', CronJobRunSchema),
  async (c) => new ArckepCronController().run(c),
);

// GET /api/v1/arckep/cron-jobs/:id/topics[?limit=]
ArckepRoutes.get(
  '/cron-jobs/:id/topics',
  requireAuth,
  zValidator('param', CronJobIdParamSchema),
  zValidator('query', CronJobTopicsQuerySchema),
  async (c) => new ArckepCronController().topics(c),
);

export default ArckepRoutes;
