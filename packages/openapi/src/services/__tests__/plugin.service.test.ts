import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PluginService,
  PUBLIC_SETTING_KEYS,
  SECRET_SETTING_KEYS,
  summarizeConnector,
} from '../plugin.service';

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
  it('берёт имя, описание и инструменты из manifest и не возвращает неизвестные/секретные ключи', () => {
    expect(summarizeConnector({ ...wordstat, settings: { token: 'x' } }, true)).toEqual({
      description: 'Спрос в Яндексе',
      identifier: 'mcp-arckep-wordstat',
      installed: true,
      publicSettings: {},
      secretFilled: false,
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
      publicSettings: {},
      secretFilled: false,
      settingsFilled: false,
      title: 'mcp-arckep-x',
      tools: [],
      type: 'customPlugin',
    });
  });

  it('отдаёт только PUBLIC_SETTING_KEYS, никогда не светит X-MCP-Password, enc:v1: и чужие ключи', () => {
    expect([...PUBLIC_SETTING_KEYS]).toEqual([
      'X-MCP-Host',
      'X-MCP-Port',
      'X-MCP-Database',
      'X-MCP-User',
    ]);
    expect([...SECRET_SETTING_KEYS]).toEqual(['X-MCP-Password']);

    const summary = summarizeConnector(
      {
        ...postgres,
        settings: {
          'X-MCP-Database': ' shop ',
          'X-MCP-Host': 'db.example.ru',
          'X-MCP-Password': 'enc:v1:super-secret-cipher',
          'X-MCP-Port': 5432,
          'X-MCP-User': 'reader',
          'apiKey': 'should-never-leak',
          'customFlag': true,
        },
      },
      true,
    );
    expect(summary.publicSettings).toEqual({
      'X-MCP-Database': 'shop',
      'X-MCP-Host': 'db.example.ru',
      'X-MCP-Port': 5432,
      'X-MCP-User': 'reader',
    });
    expect(summary.secretFilled).toBe(true);
    expect(summary.settingsFilled).toBe(true);
    expect(JSON.stringify(summary)).not.toContain('super-secret-cipher');
    expect(JSON.stringify(summary)).not.toContain('should-never-leak');
    expect(JSON.stringify(summary)).not.toContain('X-MCP-Password');

    // Даже если кто-то случайно положил шифротекст в публичный ключ — не отдаём наружу.
    const encryptedInPublic = summarizeConnector(
      { ...postgres, settings: { 'X-MCP-Host': 'enc:v1:leak', 'X-MCP-Password': '   ' } },
      true,
    );
    expect(encryptedInPublic.publicSettings).toEqual({});
    expect(encryptedInPublic.secretFilled).toBe(false);

    // Неустановленный коннектор никогда не отдаёт настройки.
    const notInstalled = summarizeConnector(
      { ...postgres, settings: { 'X-MCP-Host': 'db.example.ru', 'X-MCP-Password': 'secret' } },
      false,
    );
    expect(notInstalled.publicSettings).toEqual({});
    expect(notInstalled.secretFilled).toBe(false);
    expect(notInstalled.settingsFilled).toBe(false);

    // Своё подключение umcp-* без customParams.arckepUserMcp тоже никогда не отдаёт настройки.
    const bareUserMcp = summarizeConnector(
      {
        identifier: 'umcp-abc123def456',
        settings: { 'X-MCP-Host': 'db.example.ru', 'X-MCP-Password': 'secret' },
      },
      true,
    );
    expect(bareUserMcp.publicSettings).toEqual({});
    expect(bareUserMcp.secretFilled).toBe(false);
    expect(bareUserMcp.settingsFilled).toBe(false);
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

  it('каталог отмечает установленные и подставляет settings текущего пользователя (не зануляет в null)', async () => {
    mockQuery.mockResolvedValue([
      {
        ...postgres,
        settings: {
          'X-MCP-Database': 'orders',
          'X-MCP-Host': 'db.example.ru',
          'X-MCP-Password': 'enc:v1:hidden',
          'X-MCP-Port': 5432,
          'X-MCP-User': 'readonly',
          'extraSecret': 'nope',
        },
      },
      {
        customParams: {
          arckepUserMcp: {
            display: { host: 'mcp.example.com' },
            kind: 'remote',
            sealed: 'enc:v1:user-mcp-sealed',
          },
        },
        identifier: 'umcp-abc123def456',
        manifest: { api: [{ name: 'ping' }], meta: { title: 'My MCP' } },
        settings: { 'X-MCP-Host': 'ignored.example.com', 'X-MCP-Password': 'ignored' },
      },
    ]);
    const catalog = await service.catalog();
    expect(catalog.map((c) => [c.identifier, c.installed])).toEqual([
      ['mcp-arckep-postgres', true],
      ['mcp-arckep-wordstat', false],
      ['umcp-abc123def456', true],
    ]);

    const pg = catalog.find((c) => c.identifier === 'mcp-arckep-postgres')!;
    expect(pg.settingsFilled).toBe(true);
    expect(pg.secretFilled).toBe(true);
    expect(pg.publicSettings).toEqual({
      'X-MCP-Database': 'orders',
      'X-MCP-Host': 'db.example.ru',
      'X-MCP-Port': 5432,
      'X-MCP-User': 'readonly',
    });

    const ws = catalog.find((c) => c.identifier === 'mcp-arckep-wordstat')!;
    expect(ws.settingsFilled).toBe(false);
    expect(ws.secretFilled).toBe(false);
    expect(ws.publicSettings).toEqual({});

    const own = catalog.find((c) => c.identifier === 'umcp-abc123def456')!;
    expect(own.publicSettings).toEqual({});
    expect(own.secretFilled).toBe(false);
    expect(own.userMcp).toEqual({ display: { host: 'mcp.example.com' }, kind: 'remote' });

    const serialized = JSON.stringify(catalog);
    expect(serialized).not.toContain('enc:v1:');
    expect(serialized).not.toContain('X-MCP-Password');
    expect(serialized).not.toContain('extraSecret');
  });

  it('updateSettings мёржит настройки и сохраняет прежний пароль (plaintext и enc:v1:), если новый не передан или пуст', async () => {
    // 1. Частичное обновление без X-MCP-Password сохраняет plaintext секрет
    mockFindById.mockResolvedValueOnce({
      ...postgres,
      settings: {
        'X-MCP-Database': 'old_db',
        'X-MCP-Host': 'db1.example.ru',
        'X-MCP-Password': 'plain-password',
        'X-MCP-Port': 5432,
        'X-MCP-User': 'reader',
      },
    });
    const mergedPlain = await service.updateSettings('mcp-arckep-postgres', {
      'X-MCP-Database': 'new_db',
      'X-MCP-Host': 'db1.example.ru',
      'X-MCP-Port': 5433,
      'X-MCP-User': 'reader',
    });
    expect(mockUpdate).toHaveBeenLastCalledWith('mcp-arckep-postgres', {
      settings: {
        'X-MCP-Database': 'new_db',
        'X-MCP-Host': 'db1.example.ru',
        'X-MCP-Password': 'plain-password',
        'X-MCP-Port': 5433,
        'X-MCP-User': 'reader',
      },
    });
    expect(mergedPlain?.publicSettings).toEqual({
      'X-MCP-Database': 'new_db',
      'X-MCP-Host': 'db1.example.ru',
      'X-MCP-Port': 5433,
      'X-MCP-User': 'reader',
    });
    expect(mergedPlain?.secretFilled).toBe(true);
    expect(JSON.stringify(mergedPlain)).not.toContain('plain-password');

    // 2. Частичное обновление с пустым/пробельным X-MCP-Password сохраняет enc:v1:...
    mockFindById.mockResolvedValueOnce({
      ...postgres,
      settings: {
        'X-MCP-Host': 'db1.example.ru',
        'X-MCP-Password': 'enc:v1:sealed-secret-xyz',
        'X-MCP-Port': 5432,
      },
    });
    const mergedEnc = await service.updateSettings('mcp-arckep-postgres', {
      'X-MCP-Host': 'db2.example.ru',
      'X-MCP-Password': '   ',
    });
    expect(mockUpdate).toHaveBeenLastCalledWith('mcp-arckep-postgres', {
      settings: {
        'X-MCP-Host': 'db2.example.ru',
        'X-MCP-Password': 'enc:v1:sealed-secret-xyz',
        'X-MCP-Port': 5432,
      },
    });
    expect(mergedEnc?.secretFilled).toBe(true);
    expect(mergedEnc?.publicSettings).toEqual({
      'X-MCP-Host': 'db2.example.ru',
      'X-MCP-Port': 5432,
    });
    expect(JSON.stringify(mergedEnc)).not.toContain('sealed-secret-xyz');

    // 3. Передача нового непустого X-MCP-Password заменяет старый секрет
    mockFindById.mockResolvedValueOnce({
      ...postgres,
      settings: {
        'X-MCP-Host': 'db2.example.ru',
        'X-MCP-Password': 'enc:v1:sealed-secret-xyz',
      },
    });
    const rotated = await service.updateSettings('mcp-arckep-postgres', {
      'X-MCP-Host': 'db2.example.ru',
      'X-MCP-Password': 'brand-new-secret',
    });
    expect(mockUpdate).toHaveBeenLastCalledWith('mcp-arckep-postgres', {
      settings: {
        'X-MCP-Host': 'db2.example.ru',
        'X-MCP-Password': 'brand-new-secret',
      },
    });
    expect(rotated?.secretFilled).toBe(true);
    expect(JSON.stringify(rotated)).not.toContain('brand-new-secret');

    // 4. Первичное сохранение с пробельным паролем не записывает пустой секрет
    mockFindById.mockResolvedValueOnce({ ...postgres, settings: {} });
    const blankFirst = await service.updateSettings('mcp-arckep-postgres', {
      'X-MCP-Host': 'db3.example.ru',
      'X-MCP-Password': '   ',
    });
    expect(mockUpdate).toHaveBeenLastCalledWith('mcp-arckep-postgres', {
      settings: { 'X-MCP-Host': 'db3.example.ru' },
    });
    expect(blankFirst?.secretFilled).toBe(false);
    expect(blankFirst?.publicSettings).toEqual({ 'X-MCP-Host': 'db3.example.ru' });

    // 5. Нестроковый X-MCP-Password (false / 0) или регистровый дубль x-mcp-password не затирает сохранённый секрет
    mockFindById.mockResolvedValueOnce({
      ...postgres,
      settings: {
        'X-MCP-Host': 'db1.example.ru',
        'X-MCP-Password': 'enc:v1:kept-secret',
      },
    });
    const nonStringSecret = await service.updateSettings('mcp-arckep-postgres', {
      'X-MCP-Host': 'db4.example.ru',
      'X-MCP-Password': false,
    });
    expect(mockUpdate).toHaveBeenLastCalledWith('mcp-arckep-postgres', {
      settings: {
        'X-MCP-Host': 'db4.example.ru',
        'X-MCP-Password': 'enc:v1:kept-secret',
      },
    });
    expect(nonStringSecret?.secretFilled).toBe(true);

    mockFindById.mockResolvedValueOnce({
      ...postgres,
      settings: {
        'X-MCP-Host': 'db1.example.ru',
        'X-MCP-Password': 'enc:v1:kept-secret',
      },
    });
    const lowerBlank = await service.updateSettings('mcp-arckep-postgres', {
      'X-MCP-Host': 'db5.example.ru',
      'x-mcp-password': '   ',
    });
    expect(mockUpdate).toHaveBeenLastCalledWith('mcp-arckep-postgres', {
      settings: {
        'X-MCP-Host': 'db5.example.ru',
        'X-MCP-Password': 'enc:v1:kept-secret',
      },
    });
    expect(lowerBlank?.secretFilled).toBe(true);
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
