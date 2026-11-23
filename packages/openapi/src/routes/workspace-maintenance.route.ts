import type { Context } from 'hono';
import { Hono } from 'hono';
import { z } from 'zod';

import { getServerDB } from '@/database/core/db-adaptor';
import { purgeExpiredWorkspaceTrash } from '@/server/services/projectWorkspace/trash';

import { requireEngineServiceKey } from './arckep-engine-slot.route';

const PurgeExpiredTrashBodySchema = z.object({
  limit: z.number().int().min(1).max(5000).optional(),
  retentionDays: z.number().int().min(0).max(3650).optional(),
  stagingMaxAgeHours: z.number().int().min(0).max(8760).optional(),
});

export const handlePurgeExpiredTrash = async (c: Context): Promise<Response> => {
  const rawBody = await c.req.text();
  let options: z.infer<typeof PurgeExpiredTrashBodySchema> = {};

  if (rawBody.trim().length > 0) {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawBody);
    } catch {
      return c.json({ error: 'Invalid JSON body', success: false }, 400);
    }

    if (parsedJson === null || typeof parsedJson !== 'object' || Array.isArray(parsedJson)) {
      return c.json({ error: 'Request body must be a JSON object', success: false }, 400);
    }

    const validated = PurgeExpiredTrashBodySchema.safeParse(parsedJson);
    if (!validated.success) {
      return c.json(
        {
          error: validated.error.issues[0]?.message || 'Invalid purge-expired-trash options',
          success: false,
        },
        400,
      );
    }
    options = validated.data;
  }

  const db = await getServerDB();
  const res = await purgeExpiredWorkspaceTrash(db, options);

  return c.json({
    data: res,
    deletedS3Objects: res.deletedS3Objects,
    purgedStagingFiles: res.purgedStagingFiles,
    purgedTrashFiles: res.purgedTrashFiles,
    success: true,
  });
};

const WorkspaceMaintenanceRoutes = new Hono();

WorkspaceMaintenanceRoutes.use('*', requireEngineServiceKey);

WorkspaceMaintenanceRoutes.post('/purge-expired-trash', handlePurgeExpiredTrash);
WorkspaceMaintenanceRoutes.post('/purge-expired-trash/', handlePurgeExpiredTrash);

export default WorkspaceMaintenanceRoutes;
