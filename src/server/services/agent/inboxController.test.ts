// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ArckepController } from '../../../../packages/openapi/src/controllers/arckep.controller';
import { defaultInboxPlugins } from './inboxPlugins';

const mocks = vi.hoisted(() => ({
  state: { agent: undefined as undefined | { id: string; plugins: string[] } },
  create: vi.fn(),
  install: vi.fn(),
  update: vi.fn(),
  events: [] as string[],
}));
vi.mock('../../../../packages/openapi/src/common/base.controller', () => ({
  BaseController: class {
    getDatabase = async () => ({});
    getUserId = () => 'owner';
    success = (_c: unknown, data: unknown) => Response.json({ success: true, data });
    error = (_c: unknown, message: string, status: number) =>
      Response.json({ success: false, message }, { status });
    handleError = (_c: unknown, error: Error) =>
      Response.json({ success: false, message: error.message }, { status: 500 });
  },
}));
vi.mock('@/database/models/session', () => ({
  SessionModel: class {
    findByIdOrSlug = async () => mocks.state.agent;
  },
}));
vi.mock('@/database/models/agent', () => ({
  AgentModel: class {
    getBuiltinAgent = async () => mocks.state.agent;
    update = mocks.update;
  },
}));
vi.mock('@/server/services/agent', () => ({
  AgentService: class {
    createInbox = mocks.create;
  },
}));
vi.mock('../../../../packages/openapi/src/services/plugin.service', () => ({
  PluginService: class {
    installCatalog = mocks.install;
  },
}));
vi.mock('@/database/models/user', () => ({ UserModel: class {} }));
vi.mock('@/database/models/userMemory', () => ({
  UserMemoryActivityModel: class {},
  UserMemoryContextModel: class {},
  UserMemoryExperienceModel: class {},
  UserMemoryModel: class {},
  UserMemoryPreferenceModel: class {},
}));
vi.mock('@/database/repositories/aiInfra', () => ({ AiInfraRepos: class {} }));
vi.mock('@/database/schemas', () => ({ agents: {}, knowledgeBases: {} }));
vi.mock('@/server/globalConfig', () => ({ getServerGlobalConfig: vi.fn() }));
vi.mock('@/server/modules/AgentRuntime/arckepSearch', () => ({ modelHasBuiltinSearch: vi.fn() }));
vi.mock('@/server/modules/AgentRuntime/reasoningLevels', () => ({
  resolveReasoningAuto: vi.fn(),
  resolveReasoningProfile: vi.fn(),
}));
vi.mock('@/server/modules/AgentRuntime/serverModelParams', () => ({
  findModelExtendParams: vi.fn(),
  resolveServerModelParams: vi.fn(),
}));
vi.mock('@/server/services/memory/userMemory/arckepAutoExtract', () => ({
  runAutoExtract: vi.fn(),
  runDailyDigest: vi.fn(),
}));
vi.mock('@/server/services/toolExecution/serverRuntimes/arckepStudio', () => ({
  resolveArckepUserId: vi.fn(),
}));
vi.mock('@/server/services/userMcp/gateway', () => ({
  UserMcpGatewayError: class extends Error {},
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.state.agent = undefined;
  mocks.events.length = 0;
  mocks.install.mockImplementation(async () => {
    mocks.events.push('install');
  });
  mocks.create.mockImplementation(async () => {
    mocks.events.push('create');
    mocks.state.agent = { id: 'new-agent', plugins: defaultInboxPlugins() };
  });
});

describe('inbox first response', () => {
  it('installs manifests before creation and returns the newly persisted plugin config immediately', async () => {
    const response = await new ArckepController().getInboxAgent({} as never);
    expect(response.status).toBe(200);
    expect((await response.json()).data.plugins).toEqual(
      expect.arrayContaining([
        'mcp-arckep-studio-images',
        'mcp-arckep-studio-documents',
        'mcp-arckep-e2b-sandbox',
      ]),
    );
    expect(mocks.events).toEqual(['install', 'create']);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it.each([{ plugins: [] }, { plugins: ['custom-tool'] }])(
    'never modifies an existing selection %j',
    async ({ plugins }) => {
      mocks.state.agent = { id: 'existing', plugins };
      const response = await new ArckepController().getInboxAgent({} as never);
      expect((await response.json()).data.plugins).toEqual(plugins);
      expect(mocks.create).not.toHaveBeenCalled();
      expect(mocks.install).not.toHaveBeenCalled();
      expect(mocks.update).not.toHaveBeenCalled();
    },
  );

  it('does not persist a half-provisioned inbox when catalog installation fails and can retry', async () => {
    mocks.install.mockRejectedValueOnce(new Error('catalog unavailable'));
    expect((await new ArckepController().getInboxAgent({} as never)).status).toBe(500);
    expect(mocks.create).not.toHaveBeenCalled();
    const retry = await new ArckepController().getInboxAgent({} as never);
    expect(retry.status).toBe(200);
    expect((await retry.json()).data.plugins).toContain('mcp-arckep-studio-documents');
  });
});
