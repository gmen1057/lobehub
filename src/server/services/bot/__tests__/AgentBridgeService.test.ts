import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetUserSettings = vi.hoisted(() => vi.fn());
const mockExecAgent = vi.hoisted(() => vi.fn());
const mockFormatPrompt = vi.hoisted(() => vi.fn());
const mockGetPlatform = vi.hoisted(() => vi.fn());
const mockIsQueueAgentRuntimeEnabled = vi.hoisted(() => vi.fn());

vi.mock('@/database/models/topic', () => ({
  TopicModel: vi.fn().mockImplementation(() => ({
    findById: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('@/database/models/user', () => ({
  UserModel: vi.fn().mockImplementation(() => ({
    getUserSettings: mockGetUserSettings,
  })),
}));

vi.mock('@/envs/app', () => ({
  appEnv: {
    APP_URL: '',
    INTERNAL_APP_URL: '',
  },
}));

vi.mock('@/server/services/aiAgent', () => ({
  AiAgentService: vi.fn().mockImplementation(() => ({
    execAgent: mockExecAgent,
  })),
}));

vi.mock('@/server/services/queue/impls', () => ({
  isQueueAgentRuntimeEnabled: mockIsQueueAgentRuntimeEnabled,
}));

vi.mock('@/server/services/systemAgent', () => ({
  SystemAgentService: vi.fn(),
}));

vi.mock('@/server/services/bot/formatPrompt', () => ({
  formatPrompt: mockFormatPrompt,
}));

vi.mock('@/server/services/bot/platforms', () => ({
  platformRegistry: {
    getPlatform: mockGetPlatform,
  },
}));

const { AgentBridgeService } = await import('../AgentBridgeService');

const FAKE_DB = {} as any;
const USER_ID = 'user-123';
const THREAD_ID = 'discord:guild-1:channel-1:thread-1';
const MESSAGE_ID = 'msg-123';

function createThread(stateValue?: Record<string, unknown>) {
  const post = vi
    .fn()
    .mockResolvedValue({ edit: vi.fn().mockResolvedValue(undefined), id: 'progress-msg-1' });

  return {
    adapter: {
      addReaction: vi.fn().mockResolvedValue(undefined),
      decodeThreadId: vi.fn().mockReturnValue({}),
      fetchThread: vi.fn(),
      removeReaction: vi.fn().mockResolvedValue(undefined),
    },
    id: THREAD_ID,
    post,
    setState: vi.fn().mockResolvedValue(undefined),
    startTyping: vi.fn().mockResolvedValue(undefined),
    state: Promise.resolve(stateValue),
    subscribe: vi.fn().mockResolvedValue(undefined),
  } as any;
}

function createMessage() {
  return {
    attachments: [{}],
    author: { userName: 'tester' },
    id: MESSAGE_ID,
    text: 'hello world',
  } as any;
}

function createClient() {
  return {
    createAdapter: vi.fn(),
    extractChatId: vi.fn(),
    getMessenger: vi.fn(),
    id: 'discord',
    parseMessageId: vi.fn(),
    shouldSubscribe: vi.fn().mockReturnValue(true),
    start: vi.fn(),
    stop: vi.fn(),
  } as any;
}

describe('AgentBridgeService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecAgent.mockResolvedValue({
      assistantMessageId: 'assistant-msg-1',
      createdAt: new Date().toISOString(),
      operationId: 'op-1',
      topicId: 'topic-1',
    });
    mockFormatPrompt.mockReturnValue('formatted prompt');
    mockGetPlatform.mockReturnValue({ id: 'discord', supportsMessageEdit: true });
    mockGetUserSettings.mockResolvedValue({ general: { timezone: 'UTC' } });
    mockIsQueueAgentRuntimeEnabled.mockReturnValue(true);
  });

  it('calls execAgent with hooks in queue mode for mention', async () => {
    const service = new AgentBridgeService(FAKE_DB, USER_ID);
    const thread = createThread();
    const message = createMessage();
    const client = createClient();

    await service.handleMention(thread, message, {
      agentId: 'agent-1',
      botContext: { platformThreadId: THREAD_ID } as any,
      client,
    });

    // execAgent should be called with hooks (afterStep + onComplete)
    expect(mockExecAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        hooks: expect.arrayContaining([
          expect.objectContaining({ id: 'bot-step-progress', type: 'afterStep' }),
          expect.objectContaining({ id: 'bot-completion', type: 'onComplete' }),
        ]),
      }),
    );
  });

  it('calls execAgent with hooks in queue mode for subscribed message', async () => {
    const service = new AgentBridgeService(FAKE_DB, USER_ID);
    const thread = createThread({ topicId: 'topic-1' });
    const message = createMessage();
    const client = createClient();

    await service.handleSubscribedMessage(thread, message, {
      agentId: 'agent-1',
      botContext: { platformThreadId: THREAD_ID } as any,
      client,
    });

    // execAgent should be called with hooks containing webhook config
    expect(mockExecAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        hooks: expect.arrayContaining([
          expect.objectContaining({
            id: 'bot-step-progress',
            type: 'afterStep',
            webhook: expect.objectContaining({
              body: expect.objectContaining({ type: 'step', platformThreadId: THREAD_ID }),
            }),
          }),
          expect.objectContaining({
            id: 'bot-completion',
            type: 'onComplete',
            webhook: expect.objectContaining({
              body: expect.objectContaining({ type: 'completion', platformThreadId: THREAD_ID }),
            }),
          }),
        ]),
      }),
    );
  });

  it('#15: cleans up activeCount and activeThreads when thread.subscribe() or startTyping() throws, and reconciles queue-mode runs via AgentStateManager', async () => {
    const { getActiveBotSlotSnapshot, refreshActiveBotSlotRuns, resetBotSlotActivityForTests } =
      await import('../botSlotActivity');
    const { inMemoryAgentStateManager } =
      await import('@/server/modules/AgentRuntime/InMemoryAgentStateManager');

    resetBotSlotActivityForTests();
    inMemoryAgentStateManager.clear();

    const service = new AgentBridgeService(FAKE_DB, USER_ID);
    const client = createClient();

    // 1. thread.subscribe() throws in handleMention -> activeCount MUST return to 0!
    const badSubscribeThread = createThread();
    badSubscribeThread.subscribe.mockRejectedValueOnce(new Error('subscribe boom'));
    await service.handleMention(badSubscribeThread, createMessage(), {
      agentId: 'agent-1',
      botContext: { applicationId: 'app-1', platform: 'discord', platformThreadId: THREAD_ID },
      client,
    });
    expect(getActiveBotSlotSnapshot().activeCount).toBe(0);
    expect(
      AgentBridgeService.isThreadActive(THREAD_ID, { applicationId: 'app-1', platform: 'discord' }),
    ).toBe(false);

    // 2. thread.startTyping() throws in handleSubscribedMessage -> activeCount MUST return to 0!
    const badTypingThread = createThread({ topicId: 'topic-1' });
    badTypingThread.startTyping.mockRejectedValueOnce(new Error('typing boom'));
    await service.handleSubscribedMessage(badTypingThread, createMessage(), {
      agentId: 'agent-1',
      botContext: { applicationId: 'app-1', platform: 'discord', platformThreadId: THREAD_ID },
      client,
    });
    expect(getActiveBotSlotSnapshot().activeCount).toBe(0);

    // 3. Queue-mode run completes on another slot -> refreshActiveBotSlotRuns clears local entry via AgentStateManager!
    await inMemoryAgentStateManager.createOperationMetadata('op-queue-1', { userId: USER_ID });
    await inMemoryAgentStateManager.saveAgentState('op-queue-1', {
      status: 'running',
      stepCount: 1,
    } as any);
    mockExecAgent.mockResolvedValueOnce({
      assistantMessageId: 'assistant-msg-q1',
      createdAt: new Date().toISOString(),
      operationId: 'op-queue-1',
      success: true,
      topicId: 'topic-q1',
    });

    await service.handleMention(createThread(), createMessage(), {
      agentId: 'agent-1',
      botContext: { applicationId: 'app-1', platform: 'discord', platformThreadId: THREAD_ID },
      client,
    });
    expect(getActiveBotSlotSnapshot().activeCount).toBe(1);

    await refreshActiveBotSlotRuns();
    expect(getActiveBotSlotSnapshot().activeCount).toBe(1);

    // Mark terminal in AgentStateManager -> draining slot releases stale local queue tracker!
    await inMemoryAgentStateManager.saveAgentState('op-queue-1', {
      status: 'done',
      stepCount: 2,
    } as any);
    await refreshActiveBotSlotRuns();
    expect(getActiveBotSlotSnapshot().activeCount).toBe(0);

    inMemoryAgentStateManager.clear();
    resetBotSlotActivityForTests();
  });
});
