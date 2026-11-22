import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';

import { ArckepController } from '../controllers/arckep.controller';
import { requireAuth } from '../middleware/auth';

/**
 * arckep: память пользователя в REST движка (план lobechat-engine-studio-chat, Phase 4, D5).
 * В tRPC эти операции есть (userMemories.queryMemories, userMemory.delete*), в REST не было.
 * Данные всегда только свои: модели памяти строятся по userId из контекста.
 */
const MemoriesRoutes = new Hono();

export const MemoriesListQuerySchema = z.object({
  layer: z.enum(['activity', 'context', 'experience', 'identity', 'preference']).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
  q: z.string().max(200).optional(),
});

export const MemoryDeleteQuerySchema = z.object({
  layer: z.enum(['activity', 'context', 'experience', 'identity', 'preference']),
});

// arckep (20.10.2026): + autoExtract — автосбор фактов из переписок; можно прислать одно поле из двух.
export const MemorySettingsSchema = z
  .object({ autoExtract: z.boolean().optional(), enabled: z.boolean().optional() })
  .refine((body) => body.enabled !== undefined || body.autoExtract !== undefined, {
    message: 'enabled or autoExtract is required',
  });

export const MemoryRuleBodySchema = z.object({
  text: z.string(),
});

// arckep (20.10.2026): mode=digest — суточный разбор (все новые переписки + вся память одним заходом); limit там —
// сколько переписок взять (до 100, дальше режет бюджет токенов), в почасовом режиме — до 10.
export const MemoryExtractBodySchema = z
  .object({
    billingOperationId: z
      .string()
      .regex(/^memauto-[0-9a-f]{24}$/)
      .optional(),
    excludeTopicIds: z.array(z.string().min(1).max(128)).max(5000).optional(),
    studioUserId: z.number().int().positive().optional(),
    days: z.number().int().min(1).max(90).optional(),
    idleMinutes: z.number().int().min(0).max(1440).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    mode: z.enum(['topics', 'digest']).optional(),
  })
  .refine(
    (body) =>
      (body.billingOperationId === undefined) === (body.studioUserId === undefined) &&
      (!body.billingOperationId || body.mode === 'digest'),
    { message: 'invalid digest billing context' },
  )
  .refine((body) => body.mode === 'digest' || (body.limit ?? 0) <= 10, {
    message: 'limit above 10 is only for mode=digest',
  });

// arckep (F7): память для всего аккаунта — объявлено до '/:id', иначе «settings» прочтётся как номер записи.
// GET /api/v1/memories/settings
MemoriesRoutes.get('/settings', requireAuth, async (c) => {
  const controller = new ArckepController();
  return await controller.getMemorySettings(c);
});

// POST /api/v1/memories/extract  { days?, idleMinutes?, limit?, excludeTopicIds? } — автосбор, только служебный вход студии
MemoriesRoutes.post(
  '/extract',
  requireAuth,
  zValidator('json', MemoryExtractBodySchema),
  async (c) => {
    const controller = new ArckepController();
    return await controller.extractMemories(c);
  },
);

// PATCH /api/v1/memories/settings  { enabled?: boolean, autoExtract?: boolean }
MemoriesRoutes.patch(
  '/settings',
  requireAuth,
  zValidator('json', MemorySettingsSchema),
  async (c) => {
    const controller = new ArckepController();
    return await controller.updateMemorySettings(c);
  },
);

// GET /api/v1/memories/rules — закреплённые правила («Мои правила»), объявлено до '/:id'
MemoriesRoutes.get('/rules', requireAuth, async (c) => {
  const controller = new ArckepController();
  return await controller.getMemoryRules(c);
});

// POST /api/v1/memories/rules  { text: string }
MemoriesRoutes.post('/rules', requireAuth, zValidator('json', MemoryRuleBodySchema), async (c) => {
  const controller = new ArckepController();
  return await controller.createMemoryRule(c);
});

// PATCH /api/v1/memories/rules/:id  { text: string }
MemoriesRoutes.patch(
  '/rules/:id',
  requireAuth,
  zValidator('json', MemoryRuleBodySchema),
  async (c) => {
    const controller = new ArckepController();
    return await controller.updateMemoryRule(c);
  },
);

// DELETE /api/v1/memories/rules/:id
MemoriesRoutes.delete('/rules/:id', requireAuth, async (c) => {
  const controller = new ArckepController();
  return await controller.deleteMemoryRule(c);
});

// GET /api/v1/memories?layer=&page=&pageSize=&q=
MemoriesRoutes.get('/', requireAuth, zValidator('query', MemoriesListQuerySchema), async (c) => {
  const controller = new ArckepController();
  return await controller.getMemories(c);
});

// DELETE /api/v1/memories/:id?layer=identity
MemoriesRoutes.delete(
  '/:id',
  requireAuth,
  zValidator('query', MemoryDeleteQuerySchema),
  async (c) => {
    const controller = new ArckepController();
    return await controller.deleteMemory(c);
  },
);

export default MemoriesRoutes;
