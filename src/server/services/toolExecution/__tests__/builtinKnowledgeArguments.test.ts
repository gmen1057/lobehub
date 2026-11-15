// @vitest-environment node
import { GeneralChatAgent } from '@lobechat/agent-runtime';
import { ActivatorExecutionRuntime } from '@lobechat/builtin-tool-activator/executionRuntime';
import { KnowledgeBaseExecutionRuntime } from '@lobechat/builtin-tool-knowledge-base/executionRuntime';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BuiltinToolsExecutor } from '../builtin';
import { ToolExecutionService } from '../index';

const mocks = vi.hoisted(() => ({ getRuntime: vi.fn(), market: vi.fn(), klavis: vi.fn() }));
vi.mock('../serverRuntimes', () => ({
  getServerRuntime: mocks.getRuntime,
  hasServerRuntime: () => true,
}));
vi.mock('@/server/services/market', () => ({
  MarketService: class {
    executeLobehubSkill = mocks.market;
  },
}));
vi.mock('@/server/services/klavis', () => ({
  KlavisService: class {
    executeKlavisTool = mocks.klavis;
  },
}));
vi.mock('@/server/services/file', () => ({ FileService: class {} }));
vi.mock('@/server/services/discover', () => ({ DiscoverService: class {} }));
vi.mock('@/database/models/plugin', () => ({ PluginModel: class {} }));

const context = { toolManifestMap: {}, userId: 'owner', agentId: 'agent' };
const payload = (args: string) =>
  ({
    identifier: 'lobe-knowledge-base',
    apiName: 'searchKnowledgeBase',
    arguments: args,
    type: 'builtin',
    id: 'tool-1',
  }) as any;

const service = () =>
  new ToolExecutionService({
    builtinToolsExecutor: new BuiltinToolsExecutor({} as any, 'owner'),
    mcpService: {} as any,
  });

beforeEach(() => vi.resetAllMocks());

describe('persisted knowledge search arguments', () => {
  it.each([
    '',
    '{"query":',
    'null',
    '[]',
    '{}',
    '{"query":null}',
    '{"query":42}',
    '{"query":[]}',
    '{"query":""}',
    '{"query":"  \\t"}',
  ])('rejects %j before the runtime factory or DB, and permits replanning', async (args) => {
    const result = await service().executeTool(payload(args), context);
    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({ code: 'INVALID_ARGUMENT', kind: 'replan' });
    expect(result.content).toContain('Retry searchKnowledgeBase');
    expect(result.content).not.toContain('Search unavailable');
    expect(mocks.getRuntime).not.toHaveBeenCalled();
    expect(mocks.market).not.toHaveBeenCalled();
    expect(mocks.klavis).not.toHaveBeenCalled();
  });

  it('routes a valid search to the real KB runtime with the original query', async () => {
    const search = vi.fn().mockResolvedValue({ chunks: [], fileResults: [] });
    mocks.getRuntime.mockResolvedValue(
      new KnowledgeBaseExecutionRuntime({
        semanticSearchForChat: search,
        getFileContents: vi.fn(),
      }),
    );
    const result = await service().executeTool(
      payload('{"query":"source question","fileIds":["file-1"]}'),
      context,
    );
    expect(result.success).toBe(true);
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'source question', fileIds: ['file-1'] }),
      undefined,
    );
  });
});

describe('missing activation remains available to the model', () => {
  it('preserves enable guidance through the common executor and continues to an LLM response', async () => {
    const markActivated = vi.fn();
    mocks.getRuntime.mockResolvedValue(
      new ActivatorExecutionRuntime({
        service: {
          getActivatedToolIds: () => [],
          getToolManifests: async () => [],
          markActivated,
        },
      }),
    );
    const result = await service().executeTool(
      {
        ...payload('{"identifiers":["mcp-arckep-studio-images"]}'),
        identifier: 'lobe-tools-activator',
        apiName: 'activateTools',
      },
      context,
    );
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.state).toMatchObject({
      activatedTools: [],
      notFound: ['mcp-arckep-studio-images'],
    });
    expect(result.content).toContain('enable it through "+" in the chat');
    expect(markActivated).not.toHaveBeenCalled();
    expect(mocks.getRuntime).toHaveBeenCalledTimes(1);
    const agent = new GeneralChatAgent({
      agentConfig: { maxSteps: 100 },
      operationId: 'op',
      modelRuntimeConfig: { model: 'test', provider: 'test' },
    });
    const messages = [{ role: 'tool', content: result.content, tool_call_id: 'tool-1' }];
    const next = await agent.runner(
      {
        phase: 'tool_result',
        payload: { data: result },
        session: { sessionId: 'op', status: 'running', messageCount: 1, stepCount: 1 },
      } as any,
      { messages, stepCount: 1, status: 'running' } as any,
    );
    expect(next).toMatchObject({ type: 'call_llm', payload: { messages } });
  });
});
