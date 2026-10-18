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

export const MemorySettingsSchema = z.object({ enabled: z.boolean() });

// arckep (F7): память для всего аккаунта — объявлено до '/:id', иначе «settings» прочтётся как номер записи.
// GET /api/v1/memories/settings
MemoriesRoutes.get('/settings', requireAuth, async (c) => {
  const controller = new ArckepController();
  return await controller.getMemorySettings(c);
});

// PATCH /api/v1/memories/settings  { enabled: boolean }
MemoriesRoutes.patch(
  '/settings',
  requireAuth,
  zValidator('json', MemorySettingsSchema),
  async (c) => {
    const controller = new ArckepController();
    return await controller.updateMemorySettings(c);
  },
);

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
