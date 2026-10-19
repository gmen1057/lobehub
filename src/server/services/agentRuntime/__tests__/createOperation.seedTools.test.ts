// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { AgentRuntimeService } from '../AgentRuntimeService';

// arckep (19.10.2026): createOperation кладёт в начальное состояние операции инструменты, которые
// активатор уже подключил в этой теме (браузерный чат делает то же из истории сообщений).

vi.mock('@/envs/app', () => ({ appEnv: { APP_URL: 'http://localhost:3010' } }));
vi.mock('@/database/models/message', () => ({
  MessageModel: vi.fn().mockImplementation(() => ({})),
}));
vi.mock('@/server/modules/AgentRuntime', () => ({
  AgentRuntimeCoordinator: vi.fn().mockImplementation(() => ({
    createAgentOperation: vi.fn().mockResolvedValue(undefined),
    loadAgentState: vi.fn(),
    saveAgentState: vi.fn().mockResolvedValue(undefined),
  })),
  createStreamEventManager: vi.fn(() => ({})),
}));
vi.mock('@/server/modules/AgentRuntime/RuntimeExecutors', () => ({
  createRuntimeExecutors: vi.fn(() => ({})),
}));
vi.mock('@/server/services/mcp', () => ({ mcpService: {} }));
vi.mock('@/server/services/queue', () => ({
  QueueService: vi.fn().mockImplementation(() => ({ getImpl: vi.fn(() => ({})) })),
}));
vi.mock('@/server/services/queue/impls', () => ({ LocalQueueServiceImpl: class {} }));
vi.mock('@/server/services/toolExecution', () => ({
  ToolExecutionService: vi.fn().mockImplementation(() => ({})),
}));
vi.mock('@/server/services/toolExecution/builtin', () => ({
  BuiltinToolsExecutor: vi.fn().mockImplementation(() => ({})),
}));
vi.mock('@lobechat/builtin-tools/dynamicInterventionAudits', () => ({
  dynamicInterventionAudits: [],
}));

const manifest = (identifier: string) =>
  ({
    api: [{ description: 'run', name: 'run', parameters: { properties: {}, type: 'object' } }],
    identifier,
    meta: { title: identifier },
    type: 'default',
  }) as any;

const toolSet = {
  enabledToolIds: ['lobe-activator'],
  manifestMap: {
    'arckep-sites': manifest('arckep-sites'),
    'lobe-activator': manifest('lobe-activator'),
    'mcp-arckep-studio-images': manifest('mcp-arckep-studio-images'),
  },
  sourceMap: {},
  tools: [],
};

const history = [
  { content: 'Нарисуй кота', role: 'user' },
  {
    plugin: { apiName: 'activateTools', identifier: 'lobe-activator' },
    pluginState: {
      activatedTools: [
        { identifier: 'mcp-arckep-studio-images' },
        { identifier: 'lobe-user-memory' },
      ],
    },
    role: 'tool',
  },
  { content: 'Готово', role: 'assistant' },
  { content: 'Теперь собаку', role: 'user' },
];

const createService = () => {
  const service = new AgentRuntimeService({} as any, 'user-1', { queueService: null });
  const coordinator = (service as any).coordinator;
  return { coordinator, service };
};

const create = (service: AgentRuntimeService, initialMessages: any[]) =>
  service.createOperation({
    agentConfig: { model: 'gpt-4', provider: 'openai' },
    appContext: { agentId: 'agent-1', topicId: 'topic-1' },
    autoStart: false,
    initialContext: {} as any,
    initialMessages,
    modelRuntimeConfig: { model: 'gpt-4', provider: 'openai' },
    operationId: 'op-1',
    toolSet,
    userId: 'user-1',
  } as any);

describe('AgentRuntimeService.createOperation — подключённое остаётся подключённым', () => {
  it('восстанавливает activatedStepTools из истории: только то, что есть в наборе операции', async () => {
    const { coordinator, service } = createService();

    await create(service, history);

    const savedState = coordinator.saveAgentState.mock.calls[0][1];
    expect(savedState.activatedStepTools).toEqual([
      {
        activatedAtStep: 0,
        id: 'mcp-arckep-studio-images',
        manifest: toolSet.manifestMap['mcp-arckep-studio-images'],
        source: 'discovery',
      },
    ]);
    // набор операции не тронут: подключённое лежит рядом, а не вместо
    expect(savedState.operationToolSet.enabledToolIds).toEqual(['lobe-activator']);
    expect(savedState.operationToolSet.manifestMap).toBe(toolSet.manifestMap);
  });

  it('без подключений в истории поле activatedStepTools не появляется', async () => {
    const { coordinator, service } = createService();

    await create(service, [{ content: 'Привет', role: 'user' }]);

    const savedState = coordinator.saveAgentState.mock.calls[0][1];
    expect('activatedStepTools' in savedState).toBe(false);
  });
});
