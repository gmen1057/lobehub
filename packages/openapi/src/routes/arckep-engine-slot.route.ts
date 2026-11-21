import { timingSafeEqual } from 'node:crypto';

import { zValidator } from '@hono/zod-validator';
import { inArray } from 'drizzle-orm';
import type { Context, Next } from 'hono';
import { Hono } from 'hono';
import { z } from 'zod';

import { getServerDB } from '@/database/core/db-adaptor';
import { messages } from '@/database/schemas';
import { getActiveCronSnapshot } from '@/server/services/arckepCron/run';
import { getSandboxJobWorker } from '@/server/services/sandboxJobs/worker';
import { extractBearerToken } from '@/utils/server/auth';

import { responsesStreamHub } from '../services/responsesStreamHub';

export interface EngineSlotStatusResponse {
  activeCronRuns: number;
  activeResponses: number;
  activeSandboxJobs: number;
  activeTopicIds: string[];
  activeTotal: number;
  draining: boolean;
  retainedTopicIds: string[];
}

interface EngineSlotGlobalState {
  __arckepEngineSlotState?: {
    draining: boolean;
  };
}

const globalForEngineSlot = globalThis as unknown as EngineSlotGlobalState;

const getSlotState = () => {
  if (!globalForEngineSlot.__arckepEngineSlotState) {
    globalForEngineSlot.__arckepEngineSlotState = { draining: false };
  }
  return globalForEngineSlot.__arckepEngineSlotState;
};

export const isEngineSlotDraining = (): boolean => getSlotState().draining;

export const resetEngineSlotStateForTests = (): void => {
  getSlotState().draining = false;
};

/**
 * Dedicated machine-to-machine auth for engine slot control endpoints.
 * Verifies `Authorization: Bearer <ARCKEP_ENGINE_SERVICE_KEY>` in constant time
 * WITHOUT requiring `X-Arckep-User-Id`.
 */
export const requireEngineServiceKey = async (c: Context, next: Next) => {
  const configuredKey = (process.env.ARCKEP_ENGINE_SERVICE_KEY || '').trim();
  if (!configuredKey) {
    return c.json({ error: 'ARCKEP_ENGINE_SERVICE_KEY is not configured' }, 503);
  }

  const bearer = extractBearerToken(c.req.header('Authorization'));
  if (!bearer) {
    return c.json({ error: 'Authentication required' }, 401);
  }

  const actualBuf = Buffer.from(bearer);
  const expectedBuf = Buffer.from(configuredKey);
  if (actualBuf.length !== expectedBuf.length || !timingSafeEqual(actualBuf, expectedBuf)) {
    return c.json({ error: 'Invalid service key' }, 401);
  }

  return next();
};

export const buildEngineSlotStatus = (): EngineSlotStatusResponse => {
  const hubSnap = responsesStreamHub.getDrainSnapshot();
  const cronSnap = getActiveCronSnapshot();
  const activeSandboxJobs = getSandboxJobWorker()?.getActiveJobsCount() ?? 0;

  const activeResponses = hubSnap.activeCount;
  const activeCronRuns = cronSnap.activeCount;
  const activeTotal = activeResponses + activeCronRuns + activeSandboxJobs;
  const activeTopicIds = [...new Set([...hubSnap.activeTopicIds, ...cronSnap.activeTopicIds])];

  return {
    activeCronRuns,
    activeResponses,
    activeSandboxJobs,
    activeTopicIds,
    activeTotal,
    draining: getSlotState().draining,
    retainedTopicIds: hubSnap.retainedTopicIds,
  };
};

const OwnsMessagesSchema = z.object({
  messageIds: z.array(z.string()).max(2000),
});

const ArckepEngineSlotRoutes = new Hono();

ArckepEngineSlotRoutes.use('*', requireEngineServiceKey);

// GET /api/v1/arckep/engine-slot/status
ArckepEngineSlotRoutes.get('/status', (c) => {
  return c.json(buildEngineSlotStatus());
});

// POST /api/v1/arckep/engine-slot/drain
// NOTE: Intentionally NEVER stops GatewayManager / TelegramWebhookClient (which would call deleteWebhook).
ArckepEngineSlotRoutes.post('/drain', async (c) => {
  getSlotState().draining = true;
  await getSandboxJobWorker()?.startDrain();
  return c.json(buildEngineSlotStatus());
});

// POST /api/v1/arckep/engine-slot/owns-messages { messageIds: string[] }
ArckepEngineSlotRoutes.post('/owns-messages', zValidator('json', OwnsMessagesSchema), async (c) => {
  const { messageIds } = c.req.valid('json');
  const cleanIds = messageIds.filter((id) => id.length > 0);
  const status = buildEngineSlotStatus();

  if (status.activeTopicIds.length === 0 || cleanIds.length === 0) {
    return c.json({ matchedTopicIds: [] as string[], ownsActiveTopic: false });
  }

  const activeTopicSet = new Set(status.activeTopicIds);
  const db = await getServerDB();
  const rows = await db
    .select({ topicId: messages.topicId })
    .from(messages)
    .where(inArray(messages.id, cleanIds));

  const matchedTopicIds = [
    ...new Set(
      rows
        .map((row) => row.topicId)
        .filter((topicId): topicId is string => Boolean(topicId) && activeTopicSet.has(topicId!)),
    ),
  ];

  return c.json({
    matchedTopicIds,
    ownsActiveTopic: matchedTopicIds.length > 0,
  });
});

export default ArckepEngineSlotRoutes;
