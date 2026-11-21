import { LOADING_FLAT } from '@lobechat/const';
import type * as ModelBankModule from 'model-bank';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AiAgentService } from '../index';

const { mockCreateOperation, mockFindById, mockMessageCreate, mockMessageQuery } = vi.hoisted(
  () => ({
    mockCreateOperation: vi.fn(),
    mockFindById: vi.fn(),
    mockMessageCreate: vi.fn(),
    mockMessageQuery: vi.fn(),
  }),
);

vi.mock('@/libs/trusted-client', () => ({
  generateTrustedClientToken: vi.fn().mockReturnValue(undefined),
  getTrustedClientTokenForSession: vi.fn().mockResolvedValue(undefined),
  isTrustedClientEnabled: vi.fn().mockReturnValue(false),
}));

vi.mock('@/database/models/message', () => ({
  MessageModel: vi.fn().mockImplementation(() => ({
    create: mockMessageCreate,
    findById: mockFindById,
    query: mockMessageQuery,
    update: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock('@/database/models/agent', () => ({
  AgentModel: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('@/server/services/agent', () => ({
  AgentService: vi.fn().mockImplementation(() => ({
    getAgentConfig: vi.fn().mockResolvedValue({
      chatConfig: {},
      files: [],
      id: 'agent-1',
      knowledgeBases: [],
      model: 'gpt-4',
      plugins: [],
      provider: 'openai',
      systemRole: 'You are a helpful assistant',
    }),
  })),
}));

vi.mock('@/database/models/plugin', () => ({
  PluginModel: vi.fn().mockImplementation(() => ({
    query: vi.fn().mockResolvedValue([]),
  })),
}));

vi.mock('@/database/models/topic', () => ({
  TopicModel: vi.fn().mockImplementation(() => ({
    create: vi.fn().mockResolvedValue({ id: 'topic-new' }),
    findById: vi.fn().mockImplementation(async (id: string) => ({ id })),
    updateMetadata: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('@/database/models/thread', () => ({
  ThreadModel: vi.fn().mockImplementation(() => ({
    create: vi.fn(),
    findById: vi.fn(),
    update: vi.fn(),
  })),
}));

vi.mock('@/database/models/user', () => ({
  UserModel: vi.fn().mockImplementation(() => ({
    getUserSettings: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('@/database/models/userMemory/persona', () => ({
  UserPersonaModel: vi.fn().mockImplementation(() => ({
    getLatestPersonaDocument: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('@/server/services/agentRuntime', () => ({
  AgentRuntimeService: vi.fn().mockImplementation(() => ({
    createOperation: mockCreateOperation,
  })),
}));

vi.mock('@/server/services/market', () => ({
  MarketService: vi.fn().mockImplementation(() => ({
    getLobehubSkillManifests: vi.fn().mockResolvedValue([]),
  })),
}));

vi.mock('@/server/services/klavis', () => ({
  KlavisService: vi.fn().mockImplementation(() => ({
    getKlavisManifests: vi.fn().mockResolvedValue([]),
  })),
}));

vi.mock('@/server/modules/Mecha', () => ({
  createServerAgentToolsEngine: vi.fn().mockReturnValue({
    generateToolsDetailed: vi.fn().mockReturnValue({ enabledToolIds: [], tools: [] }),
    getEnabledPluginManifests: vi.fn().mockReturnValue(new Map()),
  }),
  serverMessagesEngine: vi.fn().mockResolvedValue([{ content: 'test', role: 'user' }]),
}));

vi.mock('@/server/services/file', () => ({
  FileService: vi.fn().mockImplementation(() => ({
    uploadFromUrl: vi.fn(),
  })),
}));

vi.mock('@/server/services/toolExecution/deviceProxy', () => ({
  deviceProxy: {
    isConfigured: false,
    queryDeviceList: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('model-bank', async (importOriginal) => {
  const actual = await importOriginal<typeof ModelBankModule>();
  return {
    ...actual,
    LOBE_DEFAULT_MODEL_LIST: [
      {
        abilities: { functionCall: true, video: false, vision: true },
        id: 'gpt-4',
        providerId: 'openai',
      },
    ],
  };
});

describe('AiAgentService.execAgent - toolResultTrim & topicCacheWarm', () => {
  let service: AiAgentService;

  beforeEach(() => {
    vi.clearAllMocks();

    mockCreateOperation.mockResolvedValue({
      autoStarted: true,
      messageId: 'queue-msg-1',
      operationId: 'op-123',
      success: true,
    });

    service = new AiAgentService({} as any, 'user-1');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes full untrimmed historyMessages plus userMessage.createdAt to createOperation', async () => {
    const bigToolOutput = 'KB_PAGE_' + 'x'.repeat(20_000) + '_END';
    const bigCodeArg = 'print("row")\n'.repeat(500);
    const htmlV1 = '<div>' + '<p>Version 1</p>'.repeat(80) + '</div>';
    const htmlV2 = '<div>' + '<p>Version 2</p>'.repeat(80) + '</div>';

    const historyMessages = [
      { content: 'Turn 1', createdAt: 1_700_000_000_000, id: 'u1', role: 'user' },
      {
        content: `<lobeArtifact identifier="doc-1" type="text/html">${htmlV1}</lobeArtifact>`,
        createdAt: 1_700_000_001_000,
        id: 'a1',
        role: 'assistant',
        tools: [
          {
            apiName: 'execute_code',
            arguments: JSON.stringify({ code: bigCodeArg }),
            id: 'tc-1',
            identifier: 'mcp-arckep-e2b-sandbox',
          },
        ],
      },
      { content: bigToolOutput, createdAt: 1_700_000_002_000, id: 't1', role: 'tool' },
      { content: 'Turn 2', createdAt: 1_700_000_010_000, id: 'u2', role: 'user' },
      {
        content: `<lobeArtifact identifier="doc-1" type="text/html">${htmlV2}</lobeArtifact>`,
        createdAt: 1_700_000_011_000,
        id: 'a2',
        role: 'assistant',
      },
      { content: 'Turn 3', createdAt: 1_700_000_020_000, id: 'u3', role: 'user' },
      { content: 'Reply 3', createdAt: 1_700_000_021_000, id: 'a3', role: 'assistant' },
      { content: 'Turn 4', createdAt: 1_700_000_030_000, id: 'u4', role: 'user' },
      { content: 'Reply 4', createdAt: 1_700_000_031_000, id: 'a4', role: 'assistant' },
    ];

    const createdUserTs = new Date('2026-11-21T17:05:00.000Z');
    mockMessageQuery.mockResolvedValue(historyMessages);
    mockMessageCreate
      .mockResolvedValueOnce({ createdAt: createdUserTs, id: 'u5-new' })
      .mockResolvedValueOnce({ id: 'a5-placeholder' });

    await service.execAgent({
      agentId: 'agent-1',
      appContext: { topicId: 'topic-existing' },
      prompt: 'Turn 5 follow-up',
    });

    expect(mockCreateOperation).toHaveBeenCalledOnce();
    const [{ initialMessages }] = mockCreateOperation.mock.calls[0];

    expect(initialMessages).toHaveLength(historyMessages.length + 1);
    // Old tool output, tool arguments, and superseded artifact remain intact for MessagesEngine
    expect(initialMessages[2].content).toBe(bigToolOutput);
    expect(initialMessages[1].tools[0].arguments).toBe(JSON.stringify({ code: bigCodeArg }));
    expect(initialMessages[1].content).toContain(htmlV1);
    // New userMessage carries createdAt from DB record so Step 0 matches Step 1 latestMessages
    expect(initialMessages.at(-1)).toMatchObject({
      content: 'Turn 5 follow-up',
      createdAt: createdUserTs,
      id: 'u5-new',
      role: 'user',
    });
  });

  it('sets topicCacheWarm: true when prior topic activity is within 5 minutes', async () => {
    vi.useFakeTimers();
    const now = new Date('2026-11-21T17:10:00.000Z');
    vi.setSystemTime(now);

    mockMessageQuery.mockResolvedValue([
      {
        content: 'Recent question',
        createdAt: new Date('2026-11-21T17:07:30.000Z'),
        id: 'u-prev',
        role: 'user',
      },
      {
        content: 'Recent answer',
        createdAt: new Date('2026-11-21T17:07:45.000Z'),
        id: 'a-prev',
        role: 'assistant',
        updatedAt: new Date('2026-11-21T17:08:00.000Z'),
      },
    ]);
    mockMessageCreate
      .mockResolvedValueOnce({ createdAt: now, id: 'u-curr' })
      .mockResolvedValueOnce({ id: 'a-curr' });

    await service.execAgent({
      agentId: 'agent-1',
      appContext: { topicId: 'topic-warm' },
      prompt: 'Quick follow-up',
    });

    const [{ appContext }] = mockCreateOperation.mock.calls[0];
    expect(appContext.topicCacheTtlMs).toBe(5 * 60 * 1000);
    expect(appContext.topicCacheWarm).toBe(true);
  });

  it('sets topicCacheWarm: false when prior history is >= 5 minutes old or topic is new', async () => {
    vi.useFakeTimers();
    const now = new Date('2026-11-21T17:10:00.000Z');
    vi.setSystemTime(now);

    // 1. Exactly 5 minutes old (boundary is strictly < 5 min)
    mockMessageQuery.mockResolvedValueOnce([
      {
        content: 'Cold answer',
        createdAt: new Date('2026-11-21T17:05:00.000Z'),
        id: 'a-cold',
        role: 'assistant',
        updatedAt: new Date('2026-11-21T17:05:00.000Z'),
      },
    ]);
    mockMessageCreate
      .mockResolvedValueOnce({ createdAt: now, id: 'u-1' })
      .mockResolvedValueOnce({ id: 'a-1' });

    await service.execAgent({
      agentId: 'agent-1',
      appContext: { topicId: 'topic-cold' },
      prompt: 'After 5 min break',
    });

    expect(mockCreateOperation.mock.calls[0][0].appContext).toMatchObject({
      topicCacheTtlMs: 5 * 60 * 1000,
      topicCacheWarm: false,
    });

    // 2. Brand new topic (no history)
    mockMessageCreate
      .mockResolvedValueOnce({ createdAt: now, id: 'u-2' })
      .mockResolvedValueOnce({ id: 'a-2' });

    await service.execAgent({
      agentId: 'agent-1',
      prompt: 'First message in new topic',
    });

    expect(mockCreateOperation.mock.calls[1][0].appContext).toMatchObject({
      topicCacheTtlMs: 5 * 60 * 1000,
      topicCacheWarm: false,
    });
  });

  it('ignores LOADING_FLAT placeholders and current resumed message when computing topicCacheWarm', async () => {
    vi.useFakeTimers();
    const now = new Date('2026-11-21T17:10:00.000Z');
    vi.setSystemTime(now);

    // Dangling LOADING_FLAT from 20s ago must not warm a topic whose real activity was 10m ago
    mockMessageQuery.mockResolvedValueOnce([
      {
        content: 'Real answer 10m ago',
        createdAt: new Date('2026-11-21T17:00:00.000Z'),
        id: 'a-old',
        role: 'assistant',
      },
      {
        content: LOADING_FLAT,
        createdAt: new Date('2026-11-21T17:09:40.000Z'),
        id: 'a-dangling',
        role: 'assistant',
        updatedAt: new Date('2026-11-21T17:09:40.000Z'),
      },
    ]);
    mockMessageCreate
      .mockResolvedValueOnce({ createdAt: now, id: 'u-next' })
      .mockResolvedValueOnce({ id: 'a-next' });

    await service.execAgent({
      agentId: 'agent-1',
      appContext: { topicId: 'topic-dangling' },
      prompt: 'Retry after dangling placeholder',
    });

    expect(mockCreateOperation.mock.calls[0][0].appContext.topicCacheWarm).toBe(false);

    // Resume mode slices off the last message in historyMessages before checking lastActivityMs
    mockFindById.mockResolvedValueOnce({
      id: 'u-resumed',
      sessionId: 'session-1',
      threadId: 'thread-1',
      topicId: 'topic-resume',
    });
    mockMessageQuery.mockResolvedValueOnce([
      {
        content: 'Old answer 10m ago',
        createdAt: new Date('2026-11-21T17:00:00.000Z'),
        id: 'a-old',
        role: 'assistant',
      },
      {
        content: 'Resumed user message created 5s ago',
        createdAt: new Date('2026-11-21T17:09:55.000Z'),
        id: 'u-resumed',
        role: 'user',
      },
    ]);
    mockMessageCreate.mockResolvedValueOnce({ id: 'a-resumed' });

    await service.execAgent({
      agentId: 'agent-1',
      appContext: { sessionId: 'session-1', threadId: 'thread-1', topicId: 'topic-resume' },
      parentMessageId: 'u-resumed',
      prompt: '',
      resume: true,
    });

    expect(mockCreateOperation.mock.calls[1][0].appContext.topicCacheWarm).toBe(false);
  });

  it('uses userMessageRecord.createdAt rather than post-insert Date.now() when evaluating 5m cache boundary', async () => {
    vi.useFakeTimers();
    const priorUpdatedAt = new Date('2026-11-21T17:00:00.000Z');
    const userCreatedAt = new Date('2026-11-21T17:04:59.500Z'); // 299.5s after prior -> warm!
    // Simulate clock advancing past 5m during DB roundtrips before operationId is generated
    vi.setSystemTime(new Date('2026-11-21T17:05:01.000Z'));

    mockMessageQuery.mockResolvedValueOnce([
      {
        content: 'Prior reply',
        createdAt: priorUpdatedAt,
        id: 'a-prior',
        role: 'assistant',
        updatedAt: priorUpdatedAt,
      },
    ]);
    mockMessageCreate
      .mockResolvedValueOnce({ createdAt: userCreatedAt, id: 'u-boundary' })
      .mockResolvedValueOnce({ id: 'a-boundary' });

    await service.execAgent({
      agentId: 'agent-1',
      appContext: { topicId: 'topic-boundary' },
      prompt: 'Just inside 5m TTL',
    });

    expect(mockCreateOperation.mock.calls[0][0].appContext.topicCacheWarm).toBe(true);
  });
});
