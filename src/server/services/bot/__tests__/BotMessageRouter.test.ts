import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BotMessageRouter } from '../BotMessageRouter';

// ==================== Hoisted mocks ====================

const mockFindEnabledByPlatform = vi.hoisted(() => vi.fn());
const mockInitWithEnvKey = vi.hoisted(() => vi.fn());
const mockGetServerDB = vi.hoisted(() => vi.fn());

vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: mockGetServerDB,
}));

vi.mock('@/database/models/agentBotProvider', () => ({
  AgentBotProviderModel: {
    findEnabledByPlatform: mockFindEnabledByPlatform,
  },
}));

vi.mock('@/server/modules/KeyVaultsEncrypt', () => ({
  KeyVaultsGateKeeper: {
    initWithEnvKey: mockInitWithEnvKey,
  },
}));

vi.mock('@/server/modules/AgentRuntime/redis', () => ({
  getAgentRuntimeRedisClient: vi.fn().mockReturnValue(null),
}));

vi.mock('@chat-adapter/state-ioredis', () => ({
  createIoRedisState: vi.fn(),
}));

// Mock Chat SDK
const mockInitialize = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockOnNewMention = vi.hoisted(() => vi.fn());
const mockOnSubscribedMessage = vi.hoisted(() => vi.fn());
const mockOnNewMessage = vi.hoisted(() => vi.fn());
const mockOnSlashCommand = vi.hoisted(() => vi.fn());
const mockOnAction = vi.hoisted(() => vi.fn());

vi.mock('chat', () => ({
  BaseFormatConverter: class {},
  Chat: vi.fn().mockImplementation(() => ({
    initialize: mockInitialize,
    onAction: mockOnAction,
    onNewMention: mockOnNewMention,
    onNewMessage: mockOnNewMessage,
    onSlashCommand: mockOnSlashCommand,
    onSubscribedMessage: mockOnSubscribedMessage,
    webhooks: {},
  })),
  ConsoleLogger: vi.fn(),
}));

vi.mock('@/server/services/aiAgent', () => ({
  AiAgentService: vi.fn().mockImplementation(() => ({
    interruptTask: vi.fn().mockResolvedValue({ success: true }),
  })),
}));

vi.mock('../AgentBridgeService', () => ({
  AgentBridgeService: vi.fn().mockImplementation(() => ({
    handleMention: vi.fn().mockResolvedValue(undefined),
    handleSubscribedMessage: vi.fn().mockResolvedValue(undefined),
  })),
}));

// Mock platform entries
const mockCreateAdapter = vi.hoisted(() =>
  vi.fn().mockReturnValue({ testplatform: { type: 'mock-adapter' } }),
);
const mockMergeWithDefaults = vi.hoisted(() =>
  vi.fn((_: unknown, settings?: Record<string, unknown>) => settings ?? {}),
);

const mockGetPlatform = vi.hoisted(() =>
  vi.fn().mockImplementation((platform: string) => {
    if (platform === 'unknown') return undefined;
    return {
      clientFactory: {
        createClient: vi.fn().mockReturnValue({
          applicationId: 'mock-app',
          createAdapter: mockCreateAdapter,
          extractChatId: (id: string) => id.split(':')[1],
          getMessenger: () => ({
            createMessage: vi.fn(),
            editMessage: vi.fn(),
            removeReaction: vi.fn(),
            triggerTyping: vi.fn(),
          }),
          id: platform,
          parseMessageId: (id: string) => id,
          start: vi.fn(),
          stop: vi.fn(),
        }),
      },
      credentials: [],
      id: platform,
      name: platform,
    };
  }),
);

vi.mock('../platforms', () => ({
  buildRuntimeKey: (platform: string, appId: string) => `${platform}:${appId}`,
  mergeWithDefaults: mockMergeWithDefaults,
  platformRegistry: {
    getPlatform: mockGetPlatform,
  },
}));

// ==================== Helpers ====================

const FAKE_DB = {} as any;
const FAKE_GATEKEEPER = { decrypt: vi.fn() };

function makeProvider(overrides: Record<string, any> = {}) {
  return {
    agentId: 'agent-1',
    applicationId: 'app-123',
    credentials: { botToken: 'token' },
    userId: 'user-1',
    ...overrides,
  };
}

// ==================== Tests ====================

describe('BotMessageRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetServerDB.mockResolvedValue(FAKE_DB);
    mockInitWithEnvKey.mockResolvedValue(FAKE_GATEKEEPER);
    mockFindEnabledByPlatform.mockResolvedValue([]);
  });

  describe('getWebhookHandler', () => {
    it('should return 404 for unknown platform', async () => {
      const router = new BotMessageRouter();
      const handler = router.getWebhookHandler('unknown');

      const req = new Request('https://example.com/webhook', { method: 'POST' });
      const resp = await handler(req);

      expect(resp.status).toBe(404);
      expect(await resp.text()).toBe('No bot configured for this platform');
    });

    it('should return a handler function', () => {
      const router = new BotMessageRouter();
      const handler = router.getWebhookHandler('telegram', 'app-123');

      expect(typeof handler).toBe('function');
    });
  });

  describe('on-demand loading', () => {
    it('should load bot on first webhook request', async () => {
      mockFindEnabledByPlatform.mockResolvedValue([makeProvider({ applicationId: 'tg-bot-123' })]);

      const router = new BotMessageRouter();
      const handler = router.getWebhookHandler('telegram', 'tg-bot-123');

      const req = new Request('https://example.com/webhook', { body: '{}', method: 'POST' });
      await handler(req);

      // Should only query the specific platform, not all platforms
      expect(mockFindEnabledByPlatform).toHaveBeenCalledTimes(1);
      expect(mockFindEnabledByPlatform).toHaveBeenCalledWith(FAKE_DB, 'telegram', FAKE_GATEKEEPER);

      // Chat SDK should be initialized
      expect(mockInitialize).toHaveBeenCalled();
      expect(mockCreateAdapter).toHaveBeenCalled();
    });

    it('should return cached bot on subsequent requests', async () => {
      mockFindEnabledByPlatform.mockResolvedValue([makeProvider({ applicationId: 'tg-bot-123' })]);

      const router = new BotMessageRouter();
      const handler = router.getWebhookHandler('telegram', 'tg-bot-123');

      const req1 = new Request('https://example.com/webhook', { body: '{}', method: 'POST' });
      await handler(req1);

      const req2 = new Request('https://example.com/webhook', { body: '{}', method: 'POST' });
      await handler(req2);

      // DB should only be queried once — second call uses cache
      expect(mockFindEnabledByPlatform).toHaveBeenCalledTimes(1);
      expect(mockInitialize).toHaveBeenCalledTimes(1);
    });

    it('should return 404 when no provider found in DB', async () => {
      mockFindEnabledByPlatform.mockResolvedValue([]);

      const router = new BotMessageRouter();
      const handler = router.getWebhookHandler('telegram', 'non-existent');

      const req = new Request('https://example.com/webhook', { body: '{}', method: 'POST' });
      const resp = await handler(req);

      expect(resp.status).toBe(404);
    });

    it('should return 400 when appId is missing for generic platform', async () => {
      const router = new BotMessageRouter();
      const handler = router.getWebhookHandler('telegram');

      const req = new Request('https://example.com/webhook', { body: '{}', method: 'POST' });
      const resp = await handler(req);

      expect(resp.status).toBe(400);
    });

    it('should handle DB errors gracefully', async () => {
      mockFindEnabledByPlatform.mockRejectedValue(new Error('DB connection failed'));

      const router = new BotMessageRouter();
      const handler = router.getWebhookHandler('telegram', 'app-123');

      const req = new Request('https://example.com/webhook', { body: '{}', method: 'POST' });
      const resp = await handler(req);

      // Should return 404, not throw
      expect(resp.status).toBe(404);
    });
  });

  describe('handler registration', () => {
    it('should always register onNewMention and onSubscribedMessage', async () => {
      mockFindEnabledByPlatform.mockResolvedValue([makeProvider({ applicationId: 'tg-123' })]);

      const router = new BotMessageRouter();
      const handler = router.getWebhookHandler('telegram', 'tg-123');

      const req = new Request('https://example.com/webhook', { body: '{}', method: 'POST' });
      await handler(req);

      expect(mockOnNewMention).toHaveBeenCalled();
      expect(mockOnSubscribedMessage).toHaveBeenCalled();
    });

    it('should register onNewMessage when dm.enabled is true', async () => {
      mockFindEnabledByPlatform.mockResolvedValue([
        makeProvider({
          applicationId: 'tg-123',
          settings: { dm: { enabled: true } },
        }),
      ]);

      const router = new BotMessageRouter();
      const handler = router.getWebhookHandler('telegram', 'tg-123');

      const req = new Request('https://example.com/webhook', { body: '{}', method: 'POST' });
      await handler(req);

      // Called twice: once for text-based slash commands, once for DM catch-all
      expect(mockOnNewMessage).toHaveBeenCalledTimes(2);
    });

    it('should NOT register DM onNewMessage when dm is not enabled', async () => {
      mockFindEnabledByPlatform.mockResolvedValue([makeProvider({ applicationId: 'app-123' })]);

      const router = new BotMessageRouter();
      const handler = router.getWebhookHandler('telegram', 'app-123');

      const req = new Request('https://example.com/webhook', { body: '{}', method: 'POST' });
      await handler(req);

      // Called once for text-based slash commands only, no DM catch-all
      expect(mockOnNewMessage).toHaveBeenCalledTimes(1);
    });
  });

  describe('Blue-Green slot activity, waitUntil & scoped cross-slot /stop (#14, #16)', () => {
    it('#14: holds activeCount=1 via waitUntil after HTTP 200 returns until background SDK promise settles', async () => {
      const { Chat } = await import('chat');
      const { getActiveBotSlotSnapshot, resetBotSlotActivityForTests } =
        await import('../botSlotActivity');

      resetBotSlotActivityForTests();

      let resolveBackgroundWork!: () => void;
      const backgroundPromise = new Promise<void>((resolve) => {
        resolveBackgroundWork = resolve;
      });
      let receivedWaitUntil = false;

      vi.mocked(Chat).mockImplementationOnce(
        () =>
          ({
            initialize: mockInitialize,
            onAction: mockOnAction,
            onNewMention: mockOnNewMention,
            onNewMessage: mockOnNewMessage,
            onSlashCommand: mockOnSlashCommand,
            onSubscribedMessage: mockOnSubscribedMessage,
            webhooks: {
              telegram: vi.fn(
                async (_req: Request, opts?: { waitUntil?: (p: Promise<unknown>) => void }) => {
                  if (opts?.waitUntil) {
                    receivedWaitUntil = true;
                    opts.waitUntil(backgroundPromise);
                  }
                  return new Response('OK', { status: 200 });
                },
              ),
            },
          }) as any,
      );

      mockFindEnabledByPlatform.mockResolvedValue([makeProvider({ applicationId: 'tg-wait-bot' })]);
      const router = new BotMessageRouter();
      const handler = router.getWebhookHandler('telegram', 'tg-wait-bot');
      const resp = await handler(
        new Request('https://example.com/webhook', { body: '{}', method: 'POST' }),
      );

      expect(resp.status).toBe(200);
      expect(receivedWaitUntil).toBe(true);
      // Even AFTER HTTP 200 returned, activeCount MUST stay 1 while debounced/background task runs!
      expect(getActiveBotSlotSnapshot().activeCount).toBe(1);

      resolveBackgroundWork();
      await backgroundPromise;
      await new Promise((r) => setTimeout(r, 10));

      expect(getActiveBotSlotSnapshot().activeCount).toBe(0);
      resetBotSlotActivityForTests();
    });

    it('#16: scopes Redis keys by platform+applicationId and verifies userId before cross-slot /stop', async () => {
      const { beginBotThreadExecution, getActiveBotSlotSnapshot, resetBotSlotActivityForTests } =
        await import('../botSlotActivity');
      const { getAgentRuntimeRedisClient } = await import('@/server/modules/AgentRuntime/redis');
      const { AiAgentService } = await import('@/server/services/aiAgent');

      resetBotSlotActivityForTests();

      const redisMap = new Map<string, string>();
      vi.mocked(getAgentRuntimeRedisClient).mockReturnValue({
        del: vi.fn(async (k: string) => {
          redisMap.delete(k);
          return 1;
        }),
        get: vi.fn(async (k: string) => redisMap.get(k) ?? null),
        on: vi.fn(),
        set: vi.fn(async (k: string, v: string) => {
          redisMap.set(k, v);
          return 'OK';
        }),
      } as any);

      // Slot blue starts a Telegram bot turn on thread 'telegram:123:chat_99' for bot 'tg-stop-bot' (user-1)
      const tracker = await beginBotThreadExecution({
        agentId: 'agent-1',
        applicationId: 'tg-stop-bot',
        initialTopicId: 'tpc_tg_99',
        platform: 'telegram',
        threadId: 'telegram:123:chat_99',
        userId: 'user-1',
      });
      await tracker.setOperation('op_tg_blue_1', 'tpc_tg_99');

      expect(
        redisMap.has('arckep:bot:active_thread:telegram:tg-stop-bot:telegram:123:chat_99'),
      ).toBe(true);
      expect(getActiveBotSlotSnapshot()).toEqual({
        activeCount: 1,
        activeTopicIds: ['tpc_tg_99'],
      });

      // Simulate slot green (empty local memory, shared Redis)
      resetBotSlotActivityForTests();
      expect(getActiveBotSlotSnapshot().activeCount).toBe(0);

      const interruptTaskSpy = vi.fn().mockResolvedValue({ success: true });
      vi.mocked(AiAgentService).mockImplementation(
        () => ({ interruptTask: interruptTaskSpy }) as any,
      );

      // 1) A DIFFERENT bot ('tg-other-bot', owned by 'user-2') in the SAME Telegram group chat MUST NOT stop 'tg-stop-bot'!
      mockFindEnabledByPlatform.mockResolvedValueOnce([
        makeProvider({ agentId: 'agent-2', applicationId: 'tg-other-bot', userId: 'user-2' }),
      ]);
      const router = new BotMessageRouter();
      await router.getWebhookHandler(
        'telegram',
        'tg-other-bot',
      )(new Request('https://example.com/webhook', { body: '{}', method: 'POST' }));
      const otherBotStop = mockOnSlashCommand.mock.calls.find((c) => c[0] === '/stop');
      const otherReply = vi.fn().mockResolvedValue(undefined);
      await otherBotStop![1]({
        channel: {
          id: 'telegram:123:chat_99',
          post: otherReply,
          setState: vi.fn(),
          state: Promise.resolve({}),
        },
        text: '',
      });
      expect(interruptTaskSpy).not.toHaveBeenCalled();
      expect(otherReply).toHaveBeenCalledWith('No active execution to stop.');

      // 2) Even if a corrupted/mismatched Redis record under 'tg-mismatch-bot' has userId='victim-user',
      //    a caller bot owned by 'attacker-user' MUST refuse to interrupt 'victim-user's operation!
      redisMap.set(
        'arckep:bot:active_thread:telegram:tg-mismatch-bot:telegram:123:chat_99',
        JSON.stringify({
          agentId: 'agent-victim',
          applicationId: 'tg-mismatch-bot',
          operationId: 'op_victim_1',
          platform: 'telegram',
          startedAt: Date.now(),
          threadId: 'telegram:123:chat_99',
          token: 'tok_victim',
          topicId: 'tpc_victim',
          userId: 'victim-user',
        }),
      );
      mockOnSlashCommand.mockClear();
      mockFindEnabledByPlatform.mockResolvedValueOnce([
        makeProvider({
          agentId: 'agent-attacker',
          applicationId: 'tg-mismatch-bot',
          userId: 'attacker-user',
        }),
      ]);
      await router.getWebhookHandler(
        'telegram',
        'tg-mismatch-bot',
      )(new Request('https://example.com/webhook', { body: '{}', method: 'POST' }));
      const mismatchStop = mockOnSlashCommand.mock.calls.find((c) => c[0] === '/stop');
      const mismatchReply = vi.fn().mockResolvedValue(undefined);
      await mismatchStop![1]({
        channel: {
          id: 'telegram:123:chat_99',
          post: mismatchReply,
          setState: vi.fn(),
          state: Promise.resolve({}),
        },
        text: '',
      });
      expect(interruptTaskSpy).not.toHaveBeenCalled();
      expect(mismatchReply).toHaveBeenCalledWith('No active execution to stop.');

      // 3) Legitimate same-bot & same-owner ('tg-stop-bot', 'user-1') interrupts 'op_tg_blue_1' cleanly!
      mockOnSlashCommand.mockClear();
      mockFindEnabledByPlatform.mockResolvedValueOnce([
        makeProvider({ applicationId: 'tg-stop-bot', userId: 'user-1' }),
      ]);
      await router.getWebhookHandler(
        'telegram',
        'tg-stop-bot',
      )(new Request('https://example.com/webhook', { body: '{}', method: 'POST' }));
      const stopCall = mockOnSlashCommand.mock.calls.find((c) => c[0] === '/stop');
      expect(stopCall).toBeDefined();
      const postReply = vi.fn().mockResolvedValue(undefined);
      await stopCall![1]({
        channel: {
          id: 'telegram:123:chat_99',
          post: postReply,
          setState: vi.fn(),
          state: Promise.resolve({ topicId: 'tpc_tg_99' }),
        },
        text: '',
      });

      expect(interruptTaskSpy).toHaveBeenCalledTimes(1);
      expect(interruptTaskSpy).toHaveBeenCalledWith({ operationId: 'op_tg_blue_1' });
      expect(postReply).toHaveBeenCalledWith('Stop requested.');

      vi.mocked(getAgentRuntimeRedisClient).mockReturnValue(null);
      resetBotSlotActivityForTests();
    });
  });
});
