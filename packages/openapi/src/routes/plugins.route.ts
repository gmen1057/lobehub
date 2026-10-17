import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';

import { ArckepController } from '../controllers/arckep.controller';
import { requireAuth } from '../middleware';

/**
 * arckep (план chat-next-redesign, E2): подключения пользователя (MCP-коннекторы) по REST.
 * Права — только свои записи (PluginModel ограничен userId), отдельных scope RBAC у плагинов нет.
 */
const PluginsRoutes = new Hono();

export const PluginIdentifierSchema = z.object({
  identifier: z.string().regex(/^[\w.:-]{1,100}$/),
});

export const PluginSettingsSchema = z.object({
  settings: z.record(z.unknown()),
});

// GET /api/v1/plugins — установленные подключения
PluginsRoutes.get('/', requireAuth, async (c) => {
  const controller = new ArckepController();
  return await controller.listPlugins(c);
});

// GET /api/v1/plugins/catalog — доступные коннекторы (с отметкой installed)
PluginsRoutes.get('/catalog', requireAuth, async (c) => {
  const controller = new ArckepController();
  return await controller.pluginCatalog(c);
});

// POST /api/v1/plugins/:identifier/install
PluginsRoutes.post(
  '/:identifier/install',
  requireAuth,
  zValidator('param', PluginIdentifierSchema),
  async (c) => {
    const controller = new ArckepController();
    return await controller.installPlugin(c);
  },
);

// PATCH /api/v1/plugins/:identifier — настройки подключения (ключи, адреса)
PluginsRoutes.patch(
  '/:identifier',
  requireAuth,
  zValidator('param', PluginIdentifierSchema),
  zValidator('json', PluginSettingsSchema),
  async (c) => {
    const controller = new ArckepController();
    return await controller.updatePluginSettings(c);
  },
);

// DELETE /api/v1/plugins/:identifier
PluginsRoutes.delete(
  '/:identifier',
  requireAuth,
  zValidator('param', PluginIdentifierSchema),
  async (c) => {
    const controller = new ArckepController();
    return await controller.uninstallPlugin(c);
  },
);

export default PluginsRoutes;
