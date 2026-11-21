import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getServerDB } from '@/database/core/db-adaptor';
import { TelegramClientFactory } from '@/server/services/bot/platforms/telegram/client';
import { GatewayManager } from '@/server/services/gateway/GatewayManager';

import { userAuthMiddleware } from '../../middleware/auth';
import { responsesStreamHub } from '../../services/responsesStreamHub';
import ArckepRoutes from '../arckep.route';
import { resetEngineSlotStateForTests } from '../arckep-engine-slot.route';

const {
  mockEnsureGatewayRunning,
  mockEnsureSandboxRunning,
  mockGatewayStop,
  mockGetActiveCronSnapshot,
  mockGetSandboxJobWorker,
  mockSelectWhere,
} = vi.hoisted(() => ({
  mockEnsureGatewayRunning: vi.fn(async () => undefined),
  mockEnsureSandboxRunning: vi.fn(async () => undefined),
  mockGatewayStop: vi.fn(async () => undefined),
  mockGetActiveCronSnapshot: vi.fn(() => ({ activeCount: 0, activeTopicIds: [] as string[] })),
  mockGetSandboxJobWorker: vi.fn(),
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

const honoApp = new Hono().basePath('/api/v1');
honoApp.use('*', userAuthMiddleware);
honoApp.route('/arckep', ArckepRoutes);

const SERVICE_KEY = 'test-arckep-engine-service-key-minimum-32-chars!!';

describe('arckep-engine-slot routes & Telegram webhook preservation', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    responsesStreamHub.clear();
    resetEngineSlotStateForTests();
    process.env.ARCKEP_ENGINE_SERVICE_KEY = SERVICE_KEY;
    mockGetActiveCronSnapshot.mockReturnValue({ activeCount: 0, activeTopicIds: [] });
    mockGetSandboxJobWorker.mockReturnValue(undefined);
    mockSelectWhere.mockResolvedValue([]);
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    vi.unstubAllGlobals();
  });

  it('возвращает 503 при пустом ARCKEP_ENGINE_SERVICE_KEY и 401 без/с неверным ключом', async () => {
    delete process.env.ARCKEP_ENGINE_SERVICE_KEY;
    const unconfigured = await honoApp.request('/api/v1/arckep/engine-slot/status');
    expect(unconfigured.status).toBe(503);

    process.env.ARCKEP_ENGINE_SERVICE_KEY = SERVICE_KEY;

    const missingAuth = await honoApp.request('/api/v1/arckep/engine-slot/status');
    expect(missingAuth.status).toBe(401);

    const wrongKey = await honoApp.request('/api/v1/arckep/engine-slot/status', {
      headers: { Authorization: 'Bearer wrong-service-key-value-that-does-not-match' },
    });
    expect(wrongKey.status).toBe(401);
  });

  it('работает по Bearer ARCKEP_ENGINE_SERVICE_KEY БЕЗ X-Arckep-User-Id и агрегирует responses + cron + sandbox', async () => {
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

    mockGetActiveCronSnapshot.mockReturnValue({
      activeCount: 1,
      activeTopicIds: ['tpc_cron_live', 'tpc_resp_live'],
    });

    const startDrainMock = vi.fn(async () => undefined);
    mockGetSandboxJobWorker.mockReturnValue({
      getActiveJobsCount: () => 2,
      startDrain: startDrainMock,
    });

    const statusRes = await honoApp.request('/api/v1/arckep/engine-slot/status', {
      headers: { Authorization: `Bearer ${SERVICE_KEY}` },
    });
    expect(statusRes.status).toBe(200);
    expect(await statusRes.json()).toEqual({
      activeCronRuns: 1,
      activeResponses: 1,
      activeSandboxJobs: 2,
      activeTopicIds: ['tpc_resp_live', 'tpc_cron_live'],
      activeTotal: 4,
      draining: false,
      retainedTopicIds: ['tpc_resp_live', 'tpc_resp_done'],
    });

    // POST /drain идемпотентно включает draining и переводит SandboxJobWorker в startDrain()
    const drainRes1 = await honoApp.request('/api/v1/arckep/engine-slot/drain', {
      headers: { Authorization: `Bearer ${SERVICE_KEY}` },
      method: 'POST',
    });
    expect(drainRes1.status).toBe(200);
    expect(await drainRes1.json()).toMatchObject({
      activeTotal: 4,
      draining: true,
    });
    expect(startDrainMock).toHaveBeenCalledTimes(1);

    const drainRes2 = await honoApp.request('/api/v1/arckep/engine-slot/drain', {
      headers: { Authorization: `Bearer ${SERVICE_KEY}` },
      method: 'POST',
    });
    expect(drainRes2.status).toBe(200);
    expect(await drainRes2.json()).toMatchObject({ draining: true });
    expect(startDrainMock).toHaveBeenCalledTimes(2);
  });

  it('POST /owns-messages мгновенно отвечает false без запроса в БД при пустом activeTopicIds и находит пересечение при активных темах', async () => {
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

    mockSelectWhere.mockResolvedValueOnce([{ topicId: 'tpc_other' }, { topicId: 'tpc_busy' }]);

    const busyRes = await honoApp.request('/api/v1/arckep/engine-slot/owns-messages', {
      body: JSON.stringify({ messageIds: ['msg_other', 'msg_busy'] }),
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
    expect(getServerDB).toHaveBeenCalledTimes(1);
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
