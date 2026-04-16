import { type UIChatMessage } from '@lobechat/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { agentRuntimeService } from '../index';

const {
  availableToolsForDiscoveryMock,
  contextEngineeringMock,
  createOperationMutateMock,
  createAgentToolsEngineMock,
  getAgentStoreStateMock,
  getToolStoreStateMock,
} = vi.hoisted(() => ({
  availableToolsForDiscoveryMock: vi.fn(),
  contextEngineeringMock: vi.fn(),
  createAgentToolsEngineMock: vi.fn(),
  createOperationMutateMock: vi.fn(),
  getAgentStoreStateMock: vi.fn(),
  getToolStoreStateMock: vi.fn(),
}));

vi.mock('@/helpers/toolEngineering', () => ({
  createAgentToolsEngine: createAgentToolsEngineMock,
}));

vi.mock('@/libs/trpc/client', () => ({
  lambdaClient: {
    aiAgent: {
      createOperation: {
        mutate: createOperationMutateMock,
      },
      getOperationStatus: {
        query: vi.fn(),
      },
      processHumanIntervention: {
        mutate: vi.fn(),
      },
    },
  },
}));

vi.mock('@/services/chat/mecha', () => ({
  contextEngineering: contextEngineeringMock,
}));

vi.mock('@/store/agent', () => ({
  getAgentStoreState: getAgentStoreStateMock,
}));

vi.mock('@/store/tool', () => ({
  getToolStoreState: getToolStoreStateMock,
}));

vi.mock('@/store/tool/selectors', () => ({
  toolSelectors: {
    availableToolsForDiscovery: availableToolsForDiscoveryMock,
  },
}));

vi.mock('@/store/agent/selectors', () => ({
  agentChatConfigSelectors: {
    currentChatConfig: vi.fn(() => ({ inputTemplate: 'input-template' })),
    enableHistoryCount: vi.fn(() => true),
    historyCount: vi.fn(() => 3),
    isAgentEnableSearch: vi.fn(() => false),
  },
  agentSelectors: {
    currentAgentConfig: vi.fn(() => ({
      model: 'gpt-4o',
      plugins: ['plugin-1'],
      provider: 'openai',
      systemRole: 'system-role',
    })),
    getAgentDocumentsById: vi.fn(() => () => undefined),
  },
}));

describe('AgentRuntimeService', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    createAgentToolsEngineMock.mockReturnValue({
      generateToolsDetailed: vi
        .fn()
        .mockReturnValueOnce({
          enabledManifests: [{ identifier: 'plugin-1' }],
          enabledToolIds: ['plugin-1'],
          tools: [{ function: { name: 'plugin-1____api-1' }, type: 'function' }],
        })
        .mockReturnValueOnce({
          enabledManifests: [{ identifier: 'allowed-tool' }],
          enabledToolIds: ['allowed-tool'],
          tools: [{ function: { name: 'allowed-tool____api-1' }, type: 'function' }],
        }),
    });
    availableToolsForDiscoveryMock.mockReturnValue([
      { description: 'Allowed tool', identifier: 'allowed-tool', name: 'Allowed Tool' },
      { description: 'Blocked tool', identifier: 'lobe-cloud-sandbox', name: 'Cloud Sandbox' },
    ]);
    getToolStoreStateMock.mockReturnValue({});

    contextEngineeringMock.mockResolvedValue([{ content: 'compiled', role: 'system' }]);
    createOperationMutateMock.mockResolvedValue({ operationId: 'op-1' });
  });

  it('should keep agent documents optional when hydration returns undefined', async () => {
    const ensureAgentDocuments = vi.fn().mockResolvedValue(undefined);

    getAgentStoreStateMock.mockReturnValue({
      activeAgentId: 'agent-1',
      ensureAgentDocuments,
    });

    const messages = [{ content: 'Hello', role: 'user' }] as UIChatMessage[];

    await agentRuntimeService.createOperation({
      messages,
      userMessageId: 'msg-1',
    });

    expect(ensureAgentDocuments).toHaveBeenCalledWith('agent-1');
    expect(contextEngineeringMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentDocuments: undefined,
        availableToolsForDiscovery: [
          { description: 'Allowed tool', identifier: 'allowed-tool', name: 'Allowed Tool' },
        ],
        manifests: [{ identifier: 'plugin-1' }],
      }),
    );
    expect(createOperationMutateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [{ content: 'compiled', role: 'system' }],
        toolManifestMap: {
          'plugin-1': { identifier: 'plugin-1' },
        },
      }),
    );
  });
});
