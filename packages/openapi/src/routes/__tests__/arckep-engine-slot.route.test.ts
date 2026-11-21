import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getServerDB } from '@/database/core/db-adaptor';
import {
  beginBotThreadExecution,
  resetBotSlotActivityForTests,
} from '@/server/services/bot/botSlotActivity';
import { TelegramClientFactory } from '@/server/services/bot/platforms/telegram/client';
import { GatewayManager } from '@/server/services/gateway/GatewayManager';

import { userAuthMiddleware } from '../../middleware/auth';
import {
  beginResponseExecution,
  engineSlotHttpActivityMiddleware,
  resetEngineSlotActivityForTests,
} from '../../services/engineSlotActivity';
import { responsesStreamHub } from '../../services/responsesStreamHub';
import ArckepRoutes from '../arckep.route';
import { resetEngineSlotStateForTests } from '../arckep-engine-slot.route';

const {
  mockEnsureGatewayRunning,
  mockEnsureSandboxRunning,
  mockGatewayStop,
  mockGetActiveCronSnapshot,
  mockGetSandboxJobWorker,
  mockRefreshActiveCronRuns,
  mockSelectWhere,
} = vi.hoisted(() => ({
  mockEnsureGatewayRunning: vi.fn(async () => undefined),
  mockEnsureSandboxRunning: vi.fn(async () => undefined),
  mockGatewayStop: vi.fn(async () => undefined),
  mockGetActiveCronSnapshot: vi.fn(() => ({ activeCount: 0, activeTopicIds: [] as string[] })),
  mockGetSandboxJobWorker: vi.fn(),
  mockRefreshActiveCronRuns: vi.fn(async () => undefined),
  mockSelectWhere: vi.fn(async () => [] as Array<{ topicId: string | null }>),
}));

vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: vi.fn(async () => ({
    select: () => ({
      from: () => ({
        where: mockSelectWhere,
      }),
    }),
  })),
}));

vi.mock('@/database/schemas', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, any>;
  return {
    ...actual,
    messages: { ...actual.messages, id: 'id', topicId: 'topicId' },
  };
});

vi.mock('@/server/services/arckepCron/run', () => ({
  getActiveCronSnapshot: mockGetActiveCronSnapshot,
  refreshActiveCronRuns: mockRefreshActiveCronRuns,
}));

vi.mock('@/server/services/sandboxJobs/worker', () => ({
  getSandboxJobWorker: mockGetSandboxJobWorker,
}));

vi.mock('@/server/services/gateway', () => ({
  GatewayService: class {
    ensureRunning = mockEnsureGatewayRunning;
    stop = mockGatewayStop;
  },
}));

vi.mock('@/server/services/sandboxJobs', () => ({
  ensureRunning: mockEnsureSandboxRunning,
}));

let slowPostRelease: (() => void) | null = null;

const honoApp = new Hono().basePath('/api/v1');
honoApp.use('*', engineSlotHttpActivityMiddleware);
honoApp.use('*', userAuthMiddleware);
honoApp.route('/arckep', ArckepRoutes);
honoApp.post('/slow-work', async (c) => {
  await new Promise<void>((resolve) => {
    slowPostRelease = resolve;
  });
  return c.json({ ok: true });
});

const SERVICE_KEY = 'test-arckep-engine-service-key-minimum-32-chars!!';

describe('arckep-engine-slot routes & Telegram webhook preservation', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    responsesStreamHub.clear();
    resetEngineSlotStateForTests();
    resetEngineSlotActivityForTests();
    resetBotSlotActivityForTests();
    slowPostRelease = null;
    process.env.ARCKEP_ENGINE_SERVICE_KEY = SERVICE_KEY;
    mockGetActiveCronSnapshot.mockReturnValue({ activeCount: 0, activeTopicIds: [] });
    mockRefreshActiveCronRuns.mockResolvedValue(undefined);
    mockGetSandboxJobWorker.mockReturnValue(undefined);
    mockSelectWhere.mockResolvedValue([]);
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    vi.unstubAllGlobals();
  });

  it('возвращает 503 при пустом или коротком (<32 симв.) ARCKEP_ENGINE_SERVICE_KEY и 401 без/с неверным ключом', async () => {
    delete process.env.ARCKEP_ENGINE_SERVICE_KEY;
    const unconfigured = await honoApp.request('/api/v1/arckep/engine-slot/status');
    expect(unconfigured.status).toBe(503);

    // P2 #19: короткий ключ (<32 символов) отклоняется кодом 503 так же строго, как в arckepServiceAuth
    process.env.ARCKEP_ENGINE_SERVICE_KEY = 'too-short-service-key-31-chars!';
    expect(process.env.ARCKEP_ENGINE_SERVICE_KEY.length).toBe(31);
    const shortConfigured = await honoApp.request('/api/v1/arckep/engine-slot/status', {
      headers: { Authorization: `Bearer ${process.env.ARCKEP_ENGINE_SERVICE_KEY}` },
    });
    expect(shortConfigured.status).toBe(503);

    process.env.ARCKEP_ENGINE_SERVICE_KEY = SERVICE_KEY;

    const missingAuth = await honoApp.request('/api/v1/arckep/engine-slot/status');
    expect(missingAuth.status).toBe(401);

    const wrongKey = await honoApp.request('/api/v1/arckep/engine-slot/status', {
      headers: { Authorization: 'Bearer wrong-service-key-value-that-does-not-match' },
    });
    expect(wrongKey.status).toBe(401);
  });

  it('агрегирует hub + in-flight HTTP/Responses + bot + cron + sandbox и поддерживает drain / undrain', async () => {
    responsesStreamHub.register({
      operationId: 'op_resp_live',
      params: { input: 'hi', model: 'agt_1' } as any,
      responseId: 'tpc_resp_live',
      topicId: 'tpc_resp_live',
      userId: 'u1',
    });
    responsesStreamHub.register({
      operationId: 'op_resp_done',
      params: { input: 'bye', model: 'agt_1' } as any,
      responseId: 'tpc_resp_done',
      topicId: 'tpc_resp_done',
      userId: 'u1',
    });
    responsesStreamHub.markDone('op_resp_done');

    // Sync/pre-hub response execution + deduplicated hub execution
    const syncTracker = beginResponseExecution({
      initialTopicId: 'tpc_sync_live',
      userId: 'u1',
    });
    const dedupTracker = beginResponseExecution({
      initialTopicId: 'tpc_resp_live',
      userId: 'u1',
    });
    dedupTracker.setOperation('op_resp_live', 'tpc_resp_live');

    // Active Telegram bot run
    const botTracker = await beginBotThreadExecution({
      agentId: 'agt_bot',
      initialTopicId: 'tpc_bot_live',
      threadId: 'telegram:123:456',
      userId: 'u1',
    });

    // In-flight mutating OpenAPI HTTP request
    const inFlightHttpPromise = honoApp.request('/api/v1/slow-work', { method: 'POST' });
    await vi.waitFor(() => expect(slowPostRelease).not.toBeNull());

    mockGetActiveCronSnapshot.mockReturnValue({
      activeCount: 1,
      activeTopicIds: ['tpc_cron_live', 'tpc_resp_live'],
    });

    let workerRunning = true;
    let workerDraining = false;
    const startDrainMock = vi.fn(async () => {
      workerDraining = true;
      workerRunning = false;
    });
    const resumeFromDrainMock = vi.fn(async () => {
      workerDraining = false;
      workerRunning = true;
    });

    mockGetSandboxJobWorker.mockImplementation(() => ({
      getActiveJobsCount: () => 2,
      isDraining: () => workerDraining,
      get isRunning() {
        return workerRunning;
      },
      resumeFromDrain: resumeFromDrainMock,
      startDrain: startDrainMock,
    }));

    const statusRes = await honoApp.request('/api/v1/arckep/engine-slot/status', {
      headers: { Authorization: `Bearer ${SERVICE_KEY}` },
    });
    expect(statusRes.status).toBe(200);
    expect(await statusRes.json()).toEqual({
      activeBotRuns: 1,
      activeCronRuns: 1,
      activeHttpRequests: 1,
      activeResponses: 2, // 1 in hub + 1 syncTracker (dedupTracker not double-counted!)
      activeSandboxJobs: 2,
      activeTopicIds: ['tpc_resp_live', 'tpc_sync_live', 'tpc_cron_live', 'tpc_bot_live'],
      activeTotal: 7,
      draining: false,
      retainedTopicIds: ['tpc_resp_live', 'tpc_resp_done'],
      sandboxWorkerRunning: true,
    });

    // POST /drain включает draining и вызывает startDrain()
    const drainRes = await honoApp.request('/api/v1/arckep/engine-slot/drain', {
      headers: { Authorization: `Bearer ${SERVICE_KEY}` },
      method: 'POST',
    });
    expect(drainRes.status).toBe(200);
    expect(await drainRes.json()).toMatchObject({
      activeTotal: 7,
      draining: true,
      sandboxWorkerRunning: false,
    });
    expect(startDrainMock).toHaveBeenCalledTimes(1);

    // P1 #3: POST /undrain сбрасывает draining и возобновляет SandboxJobWorker
    const undrainRes = await honoApp.request('/api/v1/arckep/engine-slot/undrain', {
      headers: { Authorization: `Bearer ${SERVICE_KEY}` },
      method: 'POST',
    });
    expect(undrainRes.status).toBe(200);
    expect(await undrainRes.json()).toMatchObject({
      draining: false,
      sandboxWorkerRunning: true,
    });
    expect(resumeFromDrainMock).toHaveBeenCalledTimes(1);

    // Если воркер не смог перезапуститься — /undrain обязан вернуть 503
    resumeFromDrainMock.mockImplementationOnce(async () => {
      workerRunning = false;
      workerDraining = true;
    });
    const failedUndrain = await honoApp.request('/api/v1/arckep/engine-slot/undrain', {
      headers: { Authorization: `Bearer ${SERVICE_KEY}` },
      method: 'POST',
    });
    expect(failedUndrain.status).toBe(503);

    // Finish tracked operations -> activeTotal drops cleanly
    syncTracker.finish();
    dedupTracker.finish();
    await botTracker.finish();
    slowPostRelease?.();
    await inFlightHttpPromise;
  });

  it('POST /owns-messages поддерживает пакеты >2000 ID чанками по 1000 и отклоняет >20000 ID', async () => {
    const idleRes = await honoApp.request('/api/v1/arckep/engine-slot/owns-messages', {
      body: JSON.stringify({ messageIds: ['msg_1', 'msg_2'] }),
      headers: {
        'Authorization': `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
      },
      method: 'POST',
    });
    expect(idleRes.status).toBe(200);
    expect(await idleRes.json()).toEqual({
      matchedTopicIds: [],
      ownsActiveTopic: false,
    });
    expect(getServerDB).not.toHaveBeenCalled();

    responsesStreamHub.register({
      operationId: 'op_busy',
      params: { input: 'work', model: 'agt_1' } as any,
      responseId: 'tpc_busy',
      topicId: 'tpc_busy',
      userId: 'u1',
    });

    // 2505 уникальных ID -> 3 чанка по 1000, 1000 и 505
    const largeBatch = Array.from({ length: 2505 }, (_, idx) => `msg_${idx}`);
    mockSelectWhere
      .mockResolvedValueOnce([{ topicId: 'tpc_other' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ topicId: 'tpc_busy' }]);

    const busyRes = await honoApp.request('/api/v1/arckep/engine-slot/owns-messages', {
      body: JSON.stringify({ messageIds: largeBatch }),
      headers: {
        'Authorization': `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
      },
      method: 'POST',
    });
    expect(busyRes.status).toBe(200);
    expect(await busyRes.json()).toEqual({
      matchedTopicIds: ['tpc_busy'],
      ownsActiveTopic: true,
    });
    expect(mockSelectWhere).toHaveBeenCalledTimes(3);

    const tooManyIds = Array.from({ length: 20_001 }, (_, idx) => `m_${idx}`);
    const overflowRes = await honoApp.request('/api/v1/arckep/engine-slot/owns-messages', {
      body: JSON.stringify({ messageIds: tooManyIds }),
      headers: {
        'Authorization': `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
      },
      method: 'POST',
    });
    expect(overflowRes.status).toBe(400);
  });

  it('сохраняет Telegram-вебхуки при drain слота (никогда не вызывает GatewayManager.stop / deleteWebhook) и уважает ARCKEP_SKIP_BACKGROUND_AUTOSTART=1', async () => {
    const fetchSpy = vi.fn(async (url: string | URL) => {
      const urlStr = String(url);
      if (urlStr.includes('/deleteWebhook')) {
        throw new Error('CRITICAL: deleteWebhook must NEVER be called during slot drain!');
      }
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchSpy);

    const factory = new TelegramClientFactory();
    const tgClient = factory.createClient(
      {
        applicationId: '123456',
        credentials: { botToken: '123456:TEST_TOKEN', secretToken: 'sec_1' },
        platform: 'telegram',
        settings: {},
      },
      { appUrl: 'https://helper.arckep.ru', redisClient: null as any },
    );
    const tgStopSpy = vi.spyOn(tgClient, 'stop');
    const managerStopSpy = vi.spyOn(GatewayManager.prototype, 'stop');

    const drainRes = await honoApp.request('/api/v1/arckep/engine-slot/drain', {
      headers: { Authorization: `Bearer ${SERVICE_KEY}` },
      method: 'POST',
    });
    expect(drainRes.status).toBe(200);
    expect(mockGatewayStop).not.toHaveBeenCalled();
    expect(managerStopSpy).not.toHaveBeenCalled();
    expect(tgStopSpy).not.toHaveBeenCalled();
    expect(fetchSpy.mock.calls.some((call) => String(call[0]).includes('deleteWebhook'))).toBe(
      false,
    );

    // Проверка ARCKEP_SKIP_BACKGROUND_AUTOSTART=1 в src/instrumentation.ts
    process.env.NEXT_RUNTIME = 'nodejs';
    delete process.env.VERCEL_ENV;
    process.env.DATABASE_URL = 'postgres://localhost:5432/lobechat';
    process.env.ARCKEP_SKIP_BACKGROUND_AUTOSTART = '1';

    const { register } = await import('@/instrumentation');
    await register();
    expect(mockEnsureGatewayRunning).not.toHaveBeenCalled();
    expect(mockEnsureSandboxRunning).not.toHaveBeenCalled();

    process.env.ARCKEP_SKIP_BACKGROUND_AUTOSTART = '0';
    await register();
    expect(mockEnsureGatewayRunning).toHaveBeenCalledTimes(1);
    expect(mockEnsureSandboxRunning).toHaveBeenCalledTimes(1);
  });
});
