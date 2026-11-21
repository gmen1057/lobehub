import { zValidator } from '@hono/zod-validator';
import { inArray } from 'drizzle-orm';
import type { Context, Next } from 'hono';
import { Hono } from 'hono';
import { z } from 'zod';

import { getServerDB } from '@/database/core/db-adaptor';
import { getActiveBotSlotSnapshot } from '@/server/services/bot/botSlotActivity';
import { getSandboxJobWorker } from '@/server/services/sandboxJobs/worker';
import { extractBearerToken } from '@/utils/server/auth';

import { isArckepServiceBearer, isArckepServiceKeyConfigured } from '../helpers/arckepServiceAuth';
import { getEngineSlotHttpAndResponseSnapshot } from '../services/engineSlotActivity';
import { responsesStreamHub } from '../services/responsesStreamHub';

export const OWNS_MESSAGES_MAX_IDS = 20_000;
const OWNS_MESSAGES_QUERY_CHUNK_SIZE = 1000;

export interface EngineSlotStatusResponse {
  activeBotRuns: number;
  activeCronRuns: number;
  activeHttpRequests: number;
  activeResponses: number;
  activeSandboxJobs: number;
  activeTopicIds: string[];
  activeTotal: number;
  draining: boolean;
  retainedTopicIds: string[];
  sandboxWorkerRunning: boolean;
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
 * Enforces the exact same >= 32 character key requirement and constant-time comparison
 * as `arckepServiceAuth.ts`, WITHOUT requiring `X-Arckep-User-Id`.
 */
export const requireEngineServiceKey = async (c: Context, next: Next) => {
  if (!isArckepServiceKeyConfigured()) {
    return c.json(
      { error: 'ARCKEP_ENGINE_SERVICE_KEY is not configured or shorter than 32 characters' },
      503,
    );
  }

  const bearer = extractBearerToken(c.req.header('Authorization'));
  if (!bearer) {
    return c.json({ error: 'Authentication required' }, 401);
  }

  if (!isArckepServiceBearer(bearer)) {
    return c.json({ error: 'Invalid service key' }, 401);
  }

  return next();
};

export const buildEngineSlotStatus = async (): Promise<EngineSlotStatusResponse> => {
  const cronModule = (await import('@/server/services/arckepCron/run')) as {
    getActiveCronSnapshot?: () => { activeCount: number; activeTopicIds: string[] };
    refreshActiveCronRuns?: () => Promise<void>;
  };
  if (typeof cronModule.refreshActiveCronRuns === 'function') {
    await cronModule.refreshActiveCronRuns();
  }

  const hubSnap = responsesStreamHub.getDrainSnapshot();
  const inFlightSnap = getEngineSlotHttpAndResponseSnapshot(
    responsesStreamHub.getActiveOperationIds(),
  );
  const cronSnap =
    typeof cronModule.getActiveCronSnapshot === 'function'
      ? cronModule.getActiveCronSnapshot()
      : { activeCount: 0, activeTopicIds: [] };
  const botSnap = getActiveBotSlotSnapshot();
  const worker = getSandboxJobWorker();
  const activeSandboxJobs = worker?.getActiveJobsCount?.() ?? 0;
  const sandboxWorkerRunning = Boolean(worker?.isRunning && !worker?.isDraining?.());

  const activeResponses = hubSnap.activeCount + inFlightSnap.extraActiveResponses;
  const activeHttpRequests = inFlightSnap.activeHttpRequests;
  const activeCronRuns = cronSnap.activeCount;
  const activeBotRuns = botSnap.activeCount;
  const activeTotal =
    activeResponses + activeHttpRequests + activeBotRuns + activeCronRuns + activeSandboxJobs;

  const activeTopicIds = [
    ...new Set([
      ...hubSnap.activeTopicIds,
      ...inFlightSnap.extraActiveTopicIds,
      ...cronSnap.activeTopicIds,
      ...botSnap.activeTopicIds,
    ]),
  ];

  return {
    activeBotRuns,
    activeCronRuns,
    activeHttpRequests,
    activeResponses,
    activeSandboxJobs,
    activeTopicIds,
    activeTotal,
    draining: getSlotState().draining,
    retainedTopicIds: hubSnap.retainedTopicIds,
    sandboxWorkerRunning,
  };
};

const OwnsMessagesSchema = z.object({
  messageIds: z.array(z.string()).max(OWNS_MESSAGES_MAX_IDS),
});

const ArckepEngineSlotRoutes = new Hono();

ArckepEngineSlotRoutes.use('*', requireEngineServiceKey);

// GET /api/v1/arckep/engine-slot/status
ArckepEngineSlotRoutes.get('/status', async (c) => {
  return c.json(await buildEngineSlotStatus());
});

// POST /api/v1/arckep/engine-slot/drain
// NOTE: Intentionally NEVER stops GatewayManager / TelegramWebhookClient (which would call deleteWebhook).
ArckepEngineSlotRoutes.post('/drain', async (c) => {
  getSlotState().draining = true;
  await getSandboxJobWorker()?.startDrain?.();
  return c.json(await buildEngineSlotStatus());
});

// POST /api/v1/arckep/engine-slot/undrain
// Re-activates a drained slot during fast `--rollback`, restarting SandboxJobWorker tickLoop
// and verifying readiness BEFORE the router switches traffic back to this slot.
ArckepEngineSlotRoutes.post('/undrain', async (c) => {
  getSlotState().draining = false;

  const existingWorker = getSandboxJobWorker();
  if (existingWorker) {
    await existingWorker.resumeFromDrain?.();
    if (!existingWorker.isRunning || existingWorker.isDraining?.()) {
      return c.json({ error: 'SandboxJobWorker failed to resume from drain' }, 503);
    }
  } else if (
    process.env.DATABASE_URL &&
    !process.env.VERCEL_ENV &&
    process.env.ARCKEP_SKIP_BACKGROUND_AUTOSTART !== '1'
  ) {
    const { ensureRunning } = await import('@/server/services/sandboxJobs');
    await ensureRunning();
    const startedWorker = getSandboxJobWorker();
    if (startedWorker && (!startedWorker.isRunning || startedWorker.isDraining?.())) {
      return c.json({ error: 'SandboxJobWorker failed to start during undrain' }, 503);
    }
  }

  return c.json(await buildEngineSlotStatus());
});

// POST /api/v1/arckep/engine-slot/owns-messages { messageIds: string[] }
ArckepEngineSlotRoutes.post('/owns-messages', zValidator('json', OwnsMessagesSchema), async (c) => {
  const { messageIds } = c.req.valid('json');
  const cleanIds = [...new Set(messageIds.filter((id) => id.length > 0))];
  const status = await buildEngineSlotStatus();

  if (status.activeTopicIds.length === 0 || cleanIds.length === 0) {
    return c.json({ matchedTopicIds: [] as string[], ownsActiveTopic: false });
  }

  const activeTopicSet = new Set(status.activeTopicIds);
  const [{ messages }, db] = await Promise.all([import('@/database/schemas'), getServerDB()]);
  const matchedSet = new Set<string>();

  for (let offset = 0; offset < cleanIds.length; offset += OWNS_MESSAGES_QUERY_CHUNK_SIZE) {
    const chunk = cleanIds.slice(offset, offset + OWNS_MESSAGES_QUERY_CHUNK_SIZE);
    const rows = await db
      .select({ topicId: messages.topicId })
      .from(messages)
      .where(inArray(messages.id, chunk));

    for (const row of rows) {
      if (row.topicId && activeTopicSet.has(row.topicId)) {
        matchedSet.add(row.topicId);
      }
    }
  }

  const matchedTopicIds = [...matchedSet];
  return c.json({
    matchedTopicIds,
    ownsActiveTopic: matchedTopicIds.length > 0,
  });
});

export default ArckepEngineSlotRoutes;
