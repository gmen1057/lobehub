import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PluginService, summarizeConnector } from '../plugin.service';

const { mockCreate, mockDelete, mockFindById, mockQuery, mockUpdate } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockDelete: vi.fn(),
  mockFindById: vi.fn(),
  mockQuery: vi.fn(),
  mockUpdate: vi.fn(),
}));

vi.mock('@/database/schemas', () => ({
  userInstalledPlugins: {
    customParams: 'custom_params',
    identifier: 'identifier',
    manifest: 'manifest',
    source: 'source',
    type: 'type',
    updatedAt: 'updated_at',
  },
}));

vi.mock('@/database/models/plugin', () => ({
  PluginModel: class {
    create = mockCreate;
    delete = mockDelete;
    findById = mockFindById;
    query = mockQuery;
    update = mockUpdate;
  },
}));

const wordstat = {
  customParams: { mcp: { type: 'http', url: 'http://127.0.0.1:8410/mcp/wordstat' } },
  identifier: 'mcp-arckep-wordstat',
  manifest: {
    api: [{ name: 'get_wordstat' }, { name: 'get_dynamics' }, { description: 'без имени' }],
    meta: { description: 'Спрос в Яндексе', title: 'Яндекс Wordstat' },
  },
  source: 'custom',
  type: 'customPlugin',
};

const postgres = {
  customParams: { mcp: { type: 'http', url: 'https://arckep.ru/mcp/mcp/postgres' } },
  identifier: 'mcp-arckep-postgres',
  manifest: { api: [{ name: 'query' }], meta: { title: 'PostgreSQL' } },
  source: 'custom',
  type: 'customPlugin',
};

describe('summarizeConnector (arckep: карточка подключения)', () => {
  it('берёт имя, описание и инструменты из manifest', () => {
    expect(summarizeConnector({ ...wordstat, settings: { token: 'x' } }, true)).toEqual({
      description: 'Спрос в Яндексе',
      identifier: 'mcp-arckep-wordstat',
      installed: true,
      settingsFilled: true,
      title: 'Яндекс Wordstat',
      tools: ['get_wordstat', 'get_dynamics'],
      type: 'customPlugin',
    });
  });

  it('без manifest — имя по идентификатору, настроек нет', () => {
    expect(summarizeConnector({ identifier: 'mcp-arckep-x', settings: null }, false)).toEqual({
      description: '',
      identifier: 'mcp-arckep-x',
      installed: false,
      settingsFilled: false,
      title: 'mcp-arckep-x',
      tools: [],
      type: 'customPlugin',
    });
  });
});

describe('PluginService (arckep: подключения по REST)', () => {
  let service: PluginService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new PluginService({} as any, 'user-1');
    vi.spyOn(service, 'latestCatalogRows').mockResolvedValue([postgres, wordstat]);
    mockQuery.mockResolvedValue([{ ...wordstat, settings: {} }]);
    mockCreate.mockImplementation(async (params) => ({ ...params }));
  });

  it('каталог отмечает установленные', async () => {
    const catalog = await service.catalog();
    expect(catalog.map((c) => [c.identifier, c.installed])).toEqual([
      ['mcp-arckep-postgres', false],
      ['mcp-arckep-wordstat', true],
    ]);
  });

  it('установка копирует manifest и customParams из каталога, настройки пустые', async () => {
    mockFindById.mockResolvedValue(undefined);
    const installed = await service.install('mcp-arckep-postgres');
    expect(mockCreate).toHaveBeenCalledWith({
      customParams: postgres.customParams,
      identifier: 'mcp-arckep-postgres',
      manifest: postgres.manifest,
      settings: {},
      source: 'custom',
      type: 'customPlugin',
    });
    expect(installed).toMatchObject({
      identifier: 'mcp-arckep-postgres',
      installed: true,
      title: 'PostgreSQL',
    });
  });

  it('повторная установка не теряет сохранённые настройки', async () => {
    mockFindById.mockResolvedValue({ ...wordstat, settings: { token: 'secret' } });
    await service.install('mcp-arckep-wordstat');
    expect(mockCreate.mock.calls[0][0].settings).toEqual({ token: 'secret' });
  });

  it('неизвестный коннектор не ставится', async () => {
    expect(await service.install('mcp-arckep-nope')).toBeNull();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('настройки и удаление — только для установленных', async () => {
    mockFindById.mockResolvedValueOnce(undefined);
    expect(await service.updateSettings('mcp-arckep-postgres', { host: 'db' })).toBeNull();
    mockFindById.mockResolvedValueOnce({ ...postgres, settings: {} });
    const updated = await service.updateSettings('mcp-arckep-postgres', { host: 'db' });
    expect(mockUpdate).toHaveBeenCalledWith('mcp-arckep-postgres', { settings: { host: 'db' } });
    expect(updated?.settingsFilled).toBe(true);

    mockFindById.mockResolvedValueOnce(undefined);
    expect(await service.uninstall('mcp-arckep-postgres')).toBe(false);
    mockFindById.mockResolvedValueOnce(postgres);
    expect(await service.uninstall('mcp-arckep-postgres')).toBe(true);
    expect(mockDelete).toHaveBeenCalledWith('mcp-arckep-postgres');
  });

  it('новому пользователю ставится весь каталог', async () => {
    expect(await service.installCatalog()).toEqual(['mcp-arckep-postgres', 'mcp-arckep-wordstat']);
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(
      mockCreate.mock.calls.every(
        (call) => call[0].settings && Object.keys(call[0].settings).length === 0,
      ),
    ).toBe(true);
  });
});
