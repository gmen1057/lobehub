// @vitest-environment node
import { DEFAULT_AGENT_CONFIG } from '@lobechat/const';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ArckepController } from '../../../../packages/openapi/src/controllers/arckep.controller';
import PluginsRoutes from '../../../../packages/openapi/src/routes/plugins.route';
import { defaultInboxPlugins } from './inboxPlugins';

const mocks = vi.hoisted(() => ({
  catalog: vi.fn(),
  create: vi.fn(),
  ensureCatalogInstalled: vi.fn(),
  events: [] as string[],
  getInternalSettings: vi.fn(),
  listInstalled: vi.fn(),
  state: {
    agent: undefined as undefined | { id: string; plugins: string[] | null | undefined },
    sessionExists: false,
    tool: undefined as Record<string, unknown> | undefined,
  },
  update: vi.fn(),
  updateSetting: vi.fn(),
}));

vi.mock('../../../../packages/openapi/src/common/base.controller', () => ({
  BaseController: class {
    error = (_c: unknown, message: string, status: number) =>
      Response.json({ error: message, message, success: false }, { status });
    getAuthType = (c: { get?: (key: string) => unknown } | undefined) =>
      typeof c?.get === 'function'
        ? ((c.get('authType') as string | null) ?? null)
        : 'arckep-service';
    getDatabase = async () => ({});
    getParams = <T>(c: { req?: { valid?: (target: string) => T } } | undefined): T =>
      (typeof c?.req?.valid === 'function' ? c.req.valid('param') : {}) as T;
    getUserId = (c: { get?: (key: string) => unknown } | undefined) =>
      typeof c?.get === 'function' ? ((c.get('userId') as string) ?? 'owner') : 'owner';
    handleError = (_c: unknown, error: Error) =>
      Response.json(
        { error: error.message, message: error.message, success: false },
        { status: 500 },
      );
    success = (_c: unknown, data: unknown, message?: string) =>
      Response.json({ data, message, success: true });
  },
}));

vi.mock('../../../../packages/openapi/src/middleware', () => ({
  requireAuth: async (
    c: {
      req: { header: (name: string) => string | undefined };
      set: (k: string, v: unknown) => void;
    },
    next: () => Promise<void>,
  ) => {
    const authHeader = c.req.header('x-test-auth');
    c.set('userId', c.req.header('x-test-user') ?? 'owner');
    c.set('authType', authHeader && authHeader.length > 0 ? authHeader : null);
    await next();
  },
}));

vi.mock('@/database/models/session', () => ({
  SessionModel: class {
    findByIdOrSlug = async () => (mocks.state.sessionExists ? { id: 'inbox-session' } : undefined);
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
    catalog = mocks.catalog;
    ensureCatalogInstalled = mocks.ensureCatalogInstalled;
    getInternalSettings = mocks.getInternalSettings;
    listInstalled = mocks.listInstalled;
  },
}));

vi.mock('@/database/models/user', () => ({
  UserModel: class {
    getUserSettings = async () =>
      mocks.state.tool === undefined ? undefined : { tool: mocks.state.tool };
    updateSetting = mocks.updateSetting;
  },
}));

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

const callPluginsRoute = (path: string, authType: string | null = 'arckep-service') =>
  PluginsRoutes.request(path, {
    headers: authType ? { 'x-test-auth': authType } : {},
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.state.agent = undefined;
  mocks.state.sessionExists = false;
  mocks.state.tool = undefined;
  mocks.events.length = 0;

  mocks.ensureCatalogInstalled.mockImplementation(async () => {
    mocks.events.push('ensureCatalogInstalled');
    return [];
  });
  mocks.create.mockImplementation(async () => {
    mocks.events.push('create');
    mocks.state.sessionExists = true;
    mocks.state.agent = { id: 'new-agent', plugins: defaultInboxPlugins() };
  });
  mocks.update.mockImplementation(async (_id: string, patch: { plugins?: string[] }) => {
    mocks.events.push('updateAgent');
    if (mocks.state.agent && patch.plugins !== undefined) {
      mocks.state.agent = { ...mocks.state.agent, plugins: patch.plugins };
    }
  });
  mocks.updateSetting.mockImplementation(async (patch: { tool?: Record<string, unknown> }) => {
    mocks.events.push('updateSetting');
    if (patch.tool !== undefined) {
      mocks.state.tool = patch.tool;
    }
  });
  mocks.listInstalled.mockImplementation(async () => {
    mocks.events.push('listInstalled');
    return [];
  });
  mocks.catalog.mockImplementation(async () => {
    mocks.events.push('catalog');
    return [];
  });
});

describe('inbox first response & MCP auto-provisioning', () => {
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
    expect(mocks.events).toEqual(['ensureCatalogInstalled', 'create']);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it.each([
    { plugins: [] },
    { plugins: ['custom-tool'] },
    { plugins: ['lobe-user-memory', 'lobe-artifacts'] },
    { plugins: ['lobe-user-memory', 'lobe-artifacts', 'arckep-sites', 'mcp-arckep-wordstat'] },
  ])(
    'never modifies an existing custom or empty selection %j (still ensures catalog)',
    async ({ plugins }) => {
      mocks.state.sessionExists = true;
      mocks.state.agent = { id: 'existing', plugins };
      const response = await new ArckepController().getInboxAgent({} as never);
      expect((await response.json()).data.plugins).toEqual(plugins);
      expect(mocks.ensureCatalogInstalled).toHaveBeenCalledTimes(1);
      expect(mocks.create).not.toHaveBeenCalled();
      expect(mocks.update).not.toHaveBeenCalled();
      expect(mocks.updateSetting).not.toHaveBeenCalled();
    },
  );

  it('provisions defaultInboxPlugins once when agent.plugins is null (excluding uninstalledConnectors)', async () => {
    mocks.state.sessionExists = true;
    mocks.state.agent = { id: 'null-inbox', plugins: null };
    mocks.state.tool = {
      uninstalledBuiltinTools: ['lobe-browsing'],
      uninstalledConnectors: ['mcp-arckep-wordstat'],
    };

    const first = await new ArckepController().getInboxAgent({} as never);
    expect(first.status).toBe(200);
    const firstPlugins: string[] = (await first.json()).data.plugins;
    expect(firstPlugins).toContain('mcp-arckep-studio-images');
    expect(firstPlugins).not.toContain('mcp-arckep-wordstat');
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.state.tool).toEqual({
      inboxMcpProvisioned: true,
      uninstalledBuiltinTools: ['lobe-browsing'],
      uninstalledConnectors: ['mcp-arckep-wordstat'],
    });

    // Повторный вызов уже не перезаписывает agent.plugins
    mocks.update.mockClear();
    mocks.updateSetting.mockClear();
    const second = await new ArckepController().getInboxAgent({} as never);
    expect(second.status).toBe(200);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.updateSetting).not.toHaveBeenCalled();
  });

  it('provisions pre-E2 3-plugin default once (preserving order & uninstalledConnectors) and respects manual disable afterwards', async () => {
    mocks.state.sessionExists = true;
    const preE2Reversed = [...(DEFAULT_AGENT_CONFIG.plugins ?? [])].reverse();
    mocks.state.agent = { id: 'legacy-inbox', plugins: preE2Reversed };
    mocks.state.tool = { uninstalledConnectors: ['mcp-arckep-e2b-sandbox'] };

    const first = await new ArckepController().getInboxAgent({} as never);
    expect(first.status).toBe(200);
    const provisioned: string[] = (await first.json()).data.plugins;
    expect(provisioned.slice(0, preE2Reversed.length)).toEqual(preE2Reversed);
    expect(provisioned).toContain('mcp-arckep-studio-images');
    expect(provisioned).not.toContain('mcp-arckep-e2b-sandbox');
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.state.tool?.inboxMcpProvisioned).toBe(true);

    // Пользователь вручную отключил все mcp-arckep-* обратно к 3 встроенным — повторной доустановки нет!
    mocks.state.agent = { id: 'legacy-inbox', plugins: [...(DEFAULT_AGENT_CONFIG.plugins ?? [])] };
    mocks.update.mockClear();
    mocks.updateSetting.mockClear();

    const afterManualDisable = await new ArckepController().getInboxAgent({} as never);
    expect((await afterManualDisable.json()).data.plugins).toEqual(DEFAULT_AGENT_CONFIG.plugins);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.updateSetting).not.toHaveBeenCalled();
  });

  it('does not persist a half-provisioned inbox when catalog installation fails and can retry', async () => {
    mocks.ensureCatalogInstalled.mockRejectedValueOnce(new Error('catalog unavailable'));
    expect((await new ArckepController().getInboxAgent({} as never)).status).toBe(500);
    expect(mocks.create).not.toHaveBeenCalled();
    const retry = await new ArckepController().getInboxAgent({} as never);
    expect(retry.status).toBe(200);
    expect((await retry.json()).data.plugins).toContain('mcp-arckep-studio-documents');
  });
});

describe('PluginsRoutes: catalog auto-ensure & internal-settings guard', () => {
  it('calls ensureCatalogInstalled before listPlugins and pluginCatalog', async () => {
    const listRes = await callPluginsRoute('/');
    expect(listRes.status).toBe(200);

    const catalogRes = await callPluginsRoute('/catalog');
    expect(catalogRes.status).toBe(200);

    expect(mocks.events).toEqual([
      'ensureCatalogInstalled',
      'listInstalled',
      'ensureCatalogInstalled',
      'catalog',
    ]);
  });

  it('GET /:identifier/internal-settings enforces arckep-service (403), rejects umcp-* (400), and returns settings (200)', async () => {
    for (const authType of ['apikey', 'oidc', null]) {
      const forbidden = await callPluginsRoute('/mcp-arckep-postgres/internal-settings', authType);
      expect(forbidden.status).toBe(403);
      expect(mocks.getInternalSettings).not.toHaveBeenCalled();
    }

    const umcpBad = await callPluginsRoute(
      '/umcp-abc123def456/internal-settings',
      'arckep-service',
    );
    expect(umcpBad.status).toBe(400);
    expect(mocks.getInternalSettings).not.toHaveBeenCalled();

    mocks.getInternalSettings.mockResolvedValueOnce({
      identifier: 'mcp-arckep-postgres',
      installed: true,
      settings: {
        'X-MCP-Host': 'db.example.ru',
        'X-MCP-Password': 'enc:v1:sealed-password',
      },
    });
    const okRes = await callPluginsRoute(
      '/mcp-arckep-postgres/internal-settings',
      'arckep-service',
    );
    expect(okRes.status).toBe(200);
    expect(await okRes.json()).toEqual({
      data: {
        identifier: 'mcp-arckep-postgres',
        installed: true,
        settings: {
          'X-MCP-Host': 'db.example.ru',
          'X-MCP-Password': 'enc:v1:sealed-password',
        },
      },
      message: 'plugin internal settings',
      success: true,
    });
  });
});
