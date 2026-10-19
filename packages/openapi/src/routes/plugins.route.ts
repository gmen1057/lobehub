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

/**
 * arckep (19.10.2026, этап 3, п. 3.В): тело `POST /api/v1/plugins/user-mcp`. `.strict()`: открытых ключей, ссылок
 * и прочего, чего здесь быть не должно, движок не принимает молча; `sealed` — только шифротекст `enc:v1:` в
 * base64url (годится как значение заголовка), `display` — короткие строки без секретов.
 */
export const UserMcpIdentifierSchema = z.object({
  identifier: z.string().regex(/^umcp-[a-z0-9]{12}$/),
});

export const UserMcpCreateSchema = z
  .object({
    description: z.string().max(300).default(''),
    display: z.record(z.string().max(200)).refine((value) => Object.keys(value).length <= 10, {
      message: 'display: не больше 10 полей',
    }),
    identifier: z.string().regex(/^umcp-[a-z0-9]{12}$/),
    kind: z.enum(['remote', 'catalog', 'github']),
    sealed: z.string().max(8000).regex(/^enc:v1:[\w-]+$/),
    title: z.string().trim().min(1).max(80),
  })
  .strict();

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

// POST /api/v1/plugins/user-mcp — своё подключение человека (только служебный вход студии)
PluginsRoutes.post(
  '/user-mcp',
  requireAuth,
  zValidator('json', UserMcpCreateSchema),
  async (c) => {
    const controller = new ArckepController();
    return await controller.createUserMcp(c);
  },
);

// POST /api/v1/plugins/user-mcp/:identifier/refresh — перечитать tools/list своего подключения
PluginsRoutes.post(
  '/user-mcp/:identifier/refresh',
  requireAuth,
  zValidator('param', UserMcpIdentifierSchema),
  async (c) => {
    const controller = new ArckepController();
    return await controller.refreshUserMcp(c);
  },
);

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
