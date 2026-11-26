import { AgentRuntime, GeneralChatAgent } from '@lobechat/agent-runtime';
import type * as ModelBankModule from 'model-bank';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createServerAgentToolsEngine } from '@/server/modules/Mecha';

import { AiAgentService, DEFAULT_CHAT_MAX_STEPS } from '../index';

const {
  mockCreateOperation,
  mockFindCronJob,
  mockFindPlugin,
  mockGetAgentConfig,
  mockMessageCreate,
} = vi.hoisted(() => ({
  mockCreateOperation: vi.fn(),
  mockFindCronJob: vi.fn(),
  mockFindPlugin: vi.fn(),
  mockGetAgentConfig: vi.fn(),
  mockMessageCreate: vi.fn(),
}));

vi.mock('@/libs/trusted-client', () => ({
  generateTrustedClientToken: vi.fn().mockReturnValue(undefined),
  getTrustedClientTokenForSession: vi.fn().mockResolvedValue(undefined),
  isTrustedClientEnabled: vi.fn().mockReturnValue(false),
}));

vi.mock('@/database/models/message', () => ({
  MessageModel: vi.fn().mockImplementation(() => ({
    create: mockMessageCreate,
    query: vi.fn().mockResolvedValue([]),
    update: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock('@/database/models/agent', () => ({
  AgentModel: vi.fn().mockImplementation(() => ({
    getAgentConfig: vi.fn(),
  })),
}));

vi.mock('@/database/models/agentCronJob', () => ({
  AgentCronJobModel: vi.fn().mockImplementation(() => ({
    findById: mockFindCronJob,
  })),
}));

vi.mock('@/server/services/agent', () => ({
  AgentService: vi.fn().mockImplementation(() => ({
    getAgentConfig: mockGetAgentConfig,
  })),
}));

vi.mock('@/database/models/plugin', () => ({
  PluginModel: vi.fn().mockImplementation(() => ({
    findById: mockFindPlugin,
    query: vi.fn().mockResolvedValue([]),
  })),
}));

vi.mock('@/database/models/topic', () => ({
  TopicModel: vi.fn().mockImplementation(() => ({
    create: vi.fn().mockResolvedValue({ id: 'topic-1' }),
  })),
}));

vi.mock('@/database/models/thread', () => ({
  ThreadModel: vi.fn().mockImplementation(() => ({
    create: vi.fn(),
    findById: vi.fn(),
    update: vi.fn(),
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

vi.mock('@/server/services/file', () => ({
  FileService: vi.fn().mockImplementation(() => ({
    getFullFileUrl: vi.fn().mockResolvedValue('https://s3/file'),
  })),
}));

vi.mock('@/server/services/document', () => ({
  DocumentService: vi.fn().mockImplementation(() => ({
    parseFile: vi.fn(),
  })),
}));

vi.mock('@/server/modules/Mecha', () => ({
  createServerAgentToolsEngine: vi.fn(),
  serverMessagesEngine: vi.fn().mockResolvedValue([{ content: 'test', role: 'user' }]),
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

describe('AiAgentService.execAgent — default maxSteps', () => {
  let service: AiAgentService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockMessageCreate.mockResolvedValue({ id: 'msg-1' });
    mockCreateOperation.mockResolvedValue({
      autoStarted: true,
      messageId: 'queue-msg-1',
      operationId: 'op-123',
      success: true,
    });
    mockFindCronJob.mockResolvedValue({ cronPattern: '0 9 * * *', id: 'cron_1', name: 'Cron' });
    mockFindPlugin.mockResolvedValue(undefined);
    mockGetAgentConfig.mockResolvedValue({
      chatConfig: { historyCount: 8 },
      id: 'agent-1',
      knowledgeBases: [],
      model: 'gpt-4',
      params: {},
      plugins: [],
      provider: 'openai',
      slug: 'my-agent',
      systemRole: 'You are a helpful assistant.',
    });
    vi.mocked(createServerAgentToolsEngine).mockImplementation(
      () =>
        ({
          generateToolsDetailed: vi.fn().mockReturnValue({
            enabledManifests: [],
            enabledToolIds: [],
            tools: [],
          }),
          getEnabledPluginManifests: vi.fn().mockReturnValue(new Map()),
          getPluginManifest: vi.fn(),
        }) as any,
    );
    service = new AiAgentService({} as any, 'test-user-id');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('exports DEFAULT_CHAT_MAX_STEPS = 24 and applies it when maxSteps is omitted', async () => {
    expect(DEFAULT_CHAT_MAX_STEPS).toBe(24);

    await service.execAgent({ agentId: 'agent-1', prompt: 'Run multi-step task' });

    expect(mockCreateOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        maxSteps: 24,
      }),
    );
  });

  it('preserves an explicitly provided maxSteps value (both lower and higher than default)', async () => {
    await service.execAgent({ agentId: 'agent-1', maxSteps: 15, prompt: 'Run short task' });

    expect(mockCreateOperation).toHaveBeenLastCalledWith(
      expect.objectContaining({
        maxSteps: 15,
      }),
    );

    await service.execAgent({ agentId: 'agent-1', maxSteps: 40, prompt: 'Run long task' });

    expect(mockCreateOperation).toHaveBeenLastCalledWith(
      expect.objectContaining({
        maxSteps: 40,
      }),
    );
  });

  it('applies DEFAULT_CHAT_MAX_STEPS for cron and bot invocations when maxSteps is not passed', async () => {
    await service.execAgent({
      agentId: 'agent-1',
      cronJobId: 'cron_1',
      prompt: 'Scheduled task',
      trigger: 'cron',
    });
    expect(mockCreateOperation).toHaveBeenLastCalledWith(
      expect.objectContaining({
        maxSteps: DEFAULT_CHAT_MAX_STEPS,
      }),
    );

    await service.execAgent({
      agentId: 'agent-1',
      botContext: { botProviderId: 'bot-1', endUserRef: 'tg:1', platform: 'telegram' } as any,
      prompt: 'Bot message',
    });
    expect(mockCreateOperation).toHaveBeenLastCalledWith(
      expect.objectContaining({
        maxSteps: DEFAULT_CHAT_MAX_STEPS,
      }),
    );
  });

  it('enters forceFinish after DEFAULT_CHAT_MAX_STEPS (24 = 12 LLM+tool rounds), strips tools, and finishes with max_steps_completed', async () => {
    const agent = new GeneralChatAgent({
      agentConfig: { maxSteps: DEFAULT_CHAT_MAX_STEPS },
      modelRuntimeConfig: { model: 'gpt-4', provider: 'openai' },
      operationId: 'op-default-max-steps',
    });

    const observedLlmPayloads: Array<{ forceFinish?: boolean; tools: unknown[] }> = [];
    const dummyTool = {
      function: {
        description: 'Read file',
        name: 'arckep-workspace____readProjectFile____builtin',
      },
      type: 'function' as const,
    };

    const runtime = new AgentRuntime(agent, {
      executors: {
        call_llm: async (instruction: any, state) => {
          observedLlmPayloads.push({
            forceFinish: state.forceFinish,
            tools: instruction.payload.tools ?? [],
          });
          const forceFinishing = Boolean(state.forceFinish);
          const toolsCalling = forceFinishing
            ? []
            : [
                {
                  apiName: 'readProjectFile',
                  arguments: '{"path":"a.ts"}',
                  id: `tc-${state.stepCount}`,
                  identifier: 'arckep-workspace',
                  type: 'builtin' as const,
                },
              ];
          return {
            events: [],
            newState: state,
            nextContext: {
              payload: {
                hasToolsCalling: toolsCalling.length > 0,
                parentMessageId: `asst-${state.stepCount}`,
                result: {
                  content: forceFinishing ? 'Итог после 12 раундов.' : '',
                  tool_calls: toolsCalling,
                },
                toolsCalling,
              },
              phase: 'llm_result',
              session: {
                messageCount: state.messages.length,
                sessionId: state.operationId,
                status: 'running',
                stepCount: state.stepCount,
              },
            },
          };
        },
        call_tool: async (instruction: any, state) => ({
          events: [],
          newState: state,
          nextContext: {
            payload: {
              data: { content: 'ok', success: true },
              executionTime: 1,
              isSuccess: true,
              parentMessageId: instruction.payload.parentMessageId,
              toolCall: instruction.payload.toolCalling,
              toolCallId: instruction.payload.toolCalling.id,
            },
            phase: 'tool_result',
            session: {
              messageCount: state.messages.length,
              sessionId: state.operationId,
              status: 'running',
              stepCount: state.stepCount,
            },
          },
        }),
      },
    });

    let state = AgentRuntime.createInitialState({
      maxSteps: DEFAULT_CHAT_MAX_STEPS,
      messages: [{ content: 'Run multi-step task', role: 'user' }],
      operationId: 'op-default-max-steps',
      status: 'running',
      toolManifestMap: {
        'arckep-workspace': {
          api: [{ name: 'readProjectFile' }],
          identifier: 'arckep-workspace',
        } as any,
      },
      tools: [dummyTool as any],
      userInterventionConfig: { approvalMode: 'auto-run' },
    });
    let context: any = {
      operationId: 'op-default-max-steps',
      payload: { messages: state.messages, tools: [dummyTool] },
      phase: 'user_input',
      session: {
        messageCount: state.messages.length,
        sessionId: 'op-default-max-steps',
        status: 'idle',
        stepCount: 0,
      },
    };

    // 12 full LLM + tool rounds = 24 steps
    for (let i = 0; i < DEFAULT_CHAT_MAX_STEPS; i++) {
      const res = await runtime.step(state, context);
      state = res.newState;
      context = res.nextContext;
      expect(state.forceFinish).toBeUndefined();
      expect(state.status).toBe('running');
    }

    expect(state.stepCount).toBe(24);
    expect(observedLlmPayloads).toHaveLength(12);
    expect(observedLlmPayloads.every((p) => p.tools.length === 1 && !p.forceFinish)).toBe(true);

    // Step 25 exceeds DEFAULT_CHAT_MAX_STEPS (24): runtime sets forceFinish=true and strips tools
    const forceFinishLlmStep = await runtime.step(state, context);
    expect(forceFinishLlmStep.newState.stepCount).toBe(25);
    expect(forceFinishLlmStep.newState.forceFinish).toBe(true);
    expect(forceFinishLlmStep.newState.status).toBe('running');
    expect(observedLlmPayloads).toHaveLength(13);
    expect(observedLlmPayloads[12]).toEqual({ forceFinish: true, tools: [] });

    // Final step completes with reason='max_steps_completed'
    const finishStep = await runtime.step(
      forceFinishLlmStep.newState,
      forceFinishLlmStep.nextContext,
    );
    expect(finishStep.newState.status).toBe('done');
    expect(finishStep.events).toContainEqual(
      expect.objectContaining({
        reason: 'max_steps_completed',
        type: 'done',
      }),
    );
  });
});
