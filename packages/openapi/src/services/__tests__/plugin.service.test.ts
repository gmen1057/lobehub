import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PluginService,
  PUBLIC_SETTING_KEYS,
  SECRET_SETTING_KEYS,
  summarizeConnector,
} from '../plugin.service';

interface StoredPluginRow {
  customParams?: unknown;
  identifier: string;
  manifest?: unknown;
  settings?: unknown;
  source?: string | null;
  type?: string | null;
  userId?: string;
}

const {
  mockCreate,
  mockDelete,
  mockFindById,
  mockGetUserSettings,
  mockInsert,
  mockOnConflictDoNothing,
  mockQuery,
  mockSelectWhere,
  mockUpdate,
  mockUpdateSetting,
  mockValues,
  store,
} = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockDelete: vi.fn(),
  mockFindById: vi.fn(),
  mockGetUserSettings: vi.fn(),
  mockInsert: vi.fn(),
  mockOnConflictDoNothing: vi.fn(),
  mockQuery: vi.fn(),
  mockSelectWhere: vi.fn(),
  mockUpdate: vi.fn(),
  mockUpdateSetting: vi.fn(),
  mockValues: vi.fn(),
  store: {
    rows: new Map<string, StoredPluginRow>(),
    tool: undefined as Record<string, unknown> | undefined,
  },
}));

vi.mock('@/database/schemas', () => ({
  userInstalledPlugins: {
    customParams: 'custom_params',
    identifier: 'identifier',
    manifest: 'manifest',
    source: 'source',
    type: 'type',
    updatedAt: 'updated_at',
    userId: 'user_id',
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

vi.mock('@/database/models/user', () => ({
  UserModel: class {
    getUserSettings = mockGetUserSettings;
    updateSetting = mockUpdateSetting;
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

const customUserMcp: StoredPluginRow = {
  customParams: {
    arckepUserMcp: {
      display: { host: 'mcp.example.com' },
      kind: 'remote',
      sealed: 'enc:v1:user-mcp-sealed',
    },
  },
  identifier: 'umcp-abc123def456',
  manifest: { api: [{ name: 'ping' }], meta: { title: 'My MCP' } },
  settings: {},
  source: 'custom',
  type: 'customPlugin',
  userId: 'user-1',
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
    store.rows.clear();
    store.tool = undefined;

    mockGetUserSettings.mockImplementation(async () =>
      store.tool === undefined ? undefined : { tool: store.tool },
    );
    mockUpdateSetting.mockImplementation(async (patch: { tool?: Record<string, unknown> }) => {
      if (patch.tool !== undefined) {
        store.tool = patch.tool;
      }
    });

    mockSelectWhere.mockImplementation(async () =>
      [...store.rows.values()]
        .filter((r) => r.identifier.startsWith('mcp-arckep-'))
        .map((r) => ({ identifier: r.identifier })),
    );

    mockOnConflictDoNothing.mockImplementation(async () => undefined);
    mockValues.mockImplementation((items: StoredPluginRow[]) => {
      return {
        onConflictDoNothing: async (conflictOpts: unknown) => {
          await mockOnConflictDoNothing(conflictOpts);
          // Симуляция ON CONFLICT DO NOTHING: уже существующие строки и их settings не трогаем
          for (const item of items) {
            if (!store.rows.has(item.identifier)) {
              store.rows.set(item.identifier, { ...item });
            }
          }
        },
      };
    });
    mockInsert.mockImplementation(() => ({
      values: mockValues,
    }));

    const mockDb = {
      insert: mockInsert,
      select: () => ({
        from: () => ({
          where: mockSelectWhere,
        }),
      }),
    };

    service = new PluginService(mockDb as never, 'user-1');
    vi.spyOn(service, 'latestCatalogRows').mockResolvedValue([postgres, wordstat]);

    mockQuery.mockImplementation(async () => [...store.rows.values()]);
    mockFindById.mockImplementation(async (id: string) => store.rows.get(id));
    mockCreate.mockImplementation(async (params: StoredPluginRow) => {
      const next = { ...params, userId: 'user-1' };
      store.rows.set(params.identifier, next);
      return next;
    });
    mockDelete.mockImplementation(async (id: string) => {
      store.rows.delete(id);
    });
  });

  it('каталог отмечает установленные и подставляет settings текущего пользователя (не зануляет в null)', async () => {
    mockQuery.mockResolvedValueOnce([
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
        ...customUserMcp,
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
    store.rows.set('mcp-arckep-wordstat', {
      ...wordstat,
      settings: { 'X-MCP-Password': 'enc:v1:secret-token' },
    });
    await service.install('mcp-arckep-wordstat');
    expect(mockCreate.mock.calls[0][0].settings).toEqual({
      'X-MCP-Password': 'enc:v1:secret-token',
    });
  });

  it('неизвестный коннектор не ставится', async () => {
    expect(await service.install('mcp-arckep-nope')).toBeNull();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('настройки и удаление — только для установленных', async () => {
    expect(await service.updateSettings('mcp-arckep-postgres', { host: 'db' })).toBeNull();
    store.rows.set('mcp-arckep-postgres', { ...postgres, settings: {} });
    const updated = await service.updateSettings('mcp-arckep-postgres', { host: 'db' });
    expect(mockUpdate).toHaveBeenCalledWith('mcp-arckep-postgres', { settings: { host: 'db' } });
    expect(updated?.settingsFilled).toBe(true);

    expect(await service.uninstall('mcp-arckep-wordstat')).toBe(false);
    expect(await service.uninstall('mcp-arckep-postgres')).toBe(true);
    expect(mockDelete).toHaveBeenCalledWith('mcp-arckep-postgres');
  });

  it('новому пользователю ставится весь каталог через ON CONFLICT DO NOTHING (installCatalog -> ensureCatalogInstalled)', async () => {
    expect(await service.installCatalog()).toEqual(['mcp-arckep-postgres', 'mcp-arckep-wordstat']);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(mockValues).toHaveBeenCalledWith([
      {
        customParams: postgres.customParams,
        identifier: 'mcp-arckep-postgres',
        manifest: postgres.manifest,
        settings: {},
        source: 'custom',
        type: 'customPlugin',
        userId: 'user-1',
      },
      {
        customParams: wordstat.customParams,
        identifier: 'mcp-arckep-wordstat',
        manifest: wordstat.manifest,
        settings: {},
        source: 'custom',
        type: 'customPlugin',
        userId: 'user-1',
      },
    ]);
    expect(mockOnConflictDoNothing).toHaveBeenCalledWith({
      target: ['identifier', 'user_id'],
    });
  });

  it('ensureCatalogInstalled: fast-path (0 записей в БД), когда весь каталог уже установлен', async () => {
    store.rows.set('mcp-arckep-postgres', {
      ...postgres,
      settings: { 'X-MCP-Password': 'enc:v1:pg-secret' },
    });
    store.rows.set('mcp-arckep-wordstat', {
      ...wordstat,
      settings: { 'X-MCP-Password': 'plain-ws-secret' },
    });
    store.rows.set(customUserMcp.identifier, { ...customUserMcp });

    const added = await service.ensureCatalogInstalled();
    expect(added).toEqual([]);
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockUpdateSetting).not.toHaveBeenCalled();
    // Существующие enc:v1:, plaintext и кастомные umcp-* нетронуты
    expect(store.rows.get('mcp-arckep-postgres')?.settings).toEqual({
      'X-MCP-Password': 'enc:v1:pg-secret',
    });
    expect(store.rows.get('mcp-arckep-wordstat')?.settings).toEqual({
      'X-MCP-Password': 'plain-ws-secret',
    });
    expect(store.rows.get(customUserMcp.identifier)).toEqual(customUserMcp);
  });

  it('ensureCatalogInstalled: параллельная гонка (ON CONFLICT DO NOTHING) не затирает enc:v1:, plaintext и umcp-*', async () => {
    store.rows.set(customUserMcp.identifier, { ...customUserMcp });

    // Оба параллельных запроса видят пустой список установленных до вставки,
    // но в БД уже записались enc:v1: и plaintext настройки от конкурирующего запроса.
    mockSelectWhere.mockImplementationOnce(async () => []);
    mockSelectWhere.mockImplementationOnce(async () => []);
    store.rows.set('mcp-arckep-postgres', {
      ...postgres,
      settings: { 'X-MCP-Host': 'db.prod.ru', 'X-MCP-Password': 'enc:v1:winner-cipher' },
    });
    store.rows.set('mcp-arckep-wordstat', {
      ...wordstat,
      settings: { 'X-MCP-Password': 'winner-plaintext-password' },
    });

    const [resA, resB] = await Promise.all([
      service.ensureCatalogInstalled(),
      service.ensureCatalogInstalled(),
    ]);

    expect(resA).toEqual(['mcp-arckep-postgres', 'mcp-arckep-wordstat']);
    expect(resB).toEqual(['mcp-arckep-postgres', 'mcp-arckep-wordstat']);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockOnConflictDoNothing).toHaveBeenCalledTimes(2);
    expect(store.rows.get('mcp-arckep-postgres')?.settings).toEqual({
      'X-MCP-Host': 'db.prod.ru',
      'X-MCP-Password': 'enc:v1:winner-cipher',
    });
    expect(store.rows.get('mcp-arckep-wordstat')?.settings).toEqual({
      'X-MCP-Password': 'winner-plaintext-password',
    });
    expect(store.rows.get(customUserMcp.identifier)).toEqual(customUserMcp);
  });

  it('uninstall запоминает удалённый коннектор в userSettings.tool.uninstalledConnectors (не переустанавливается), а install возвращает его', async () => {
    store.tool = {
      humanIntervention: { approvalMode: 'auto' },
      inboxMcpProvisioned: true,
      uninstalledBuiltinTools: ['lobe-browsing'],
    };
    await service.ensureCatalogInstalled();
    expect([...store.rows.keys()].sort()).toEqual(['mcp-arckep-postgres', 'mcp-arckep-wordstat']);

    // Удаление готового коннектора мёржит uninstalledConnectors с существующим userSettings.tool
    expect(await service.uninstall('mcp-arckep-postgres')).toBe(true);
    expect(store.tool).toEqual({
      humanIntervention: { approvalMode: 'auto' },
      inboxMcpProvisioned: true,
      uninstalledBuiltinTools: ['lobe-browsing'],
      uninstalledConnectors: ['mcp-arckep-postgres'],
    });

    // Повторный ensureCatalogInstalled не возвращает удалённый коннектор (fast-path: 0 вставок)
    mockInsert.mockClear();
    expect(await service.ensureCatalogInstalled()).toEqual([]);
    expect(mockInsert).not.toHaveBeenCalled();
    expect(store.rows.has('mcp-arckep-postgres')).toBe(false);

    // Удаление кастомного umcp-* НЕ пишет в uninstalledConnectors
    store.rows.set(customUserMcp.identifier, { ...customUserMcp });
    mockUpdateSetting.mockClear();
    expect(await service.uninstall(customUserMcp.identifier)).toBe(true);
    expect(mockUpdateSetting).not.toHaveBeenCalled();
    expect(store.tool.uninstalledConnectors).toEqual(['mcp-arckep-postgres']);

    // Ручная установка install() убирает коннектор из uninstalledConnectors, сохраняя остальные поля tool
    await service.install('mcp-arckep-postgres');
    expect(store.tool).toEqual({
      humanIntervention: { approvalMode: 'auto' },
      inboxMcpProvisioned: true,
      uninstalledBuiltinTools: ['lobe-browsing'],
      uninstalledConnectors: [],
    });
  });

  it('getInternalSettings отдаёт сырые settings для mcp-arckep-* (или пустые при отсутствии) и отказывает для umcp-*', async () => {
    expect(await service.getInternalSettings('umcp-abc123def456')).toBeNull();
    expect(await service.getInternalSettings('umcp-short')).toBeNull();

    expect(await service.getInternalSettings('mcp-arckep-postgres')).toEqual({
      identifier: 'mcp-arckep-postgres',
      installed: false,
      settings: {},
    });

    store.rows.set('mcp-arckep-postgres', {
      ...postgres,
      settings: {
        'X-MCP-Host': 'db.example.ru',
        'X-MCP-Password': 'enc:v1:internal-cipher',
      },
    });
    expect(await service.getInternalSettings('mcp-arckep-postgres')).toEqual({
      identifier: 'mcp-arckep-postgres',
      installed: true,
      settings: {
        'X-MCP-Host': 'db.example.ru',
        'X-MCP-Password': 'enc:v1:internal-cipher',
      },
    });

    // Обычные listInstalled() и catalog() при этом никогда не светят X-MCP-Password / enc:v1:
    const listed = JSON.stringify(await service.listInstalled());
    const catalogJson = JSON.stringify(await service.catalog());
    expect(listed).not.toContain('X-MCP-Password');
    expect(listed).not.toContain('enc:v1:');
    expect(catalogJson).not.toContain('X-MCP-Password');
    expect(catalogJson).not.toContain('enc:v1:');
  });

  it('updateSettings: удаляет публичные ключи по null/пустой строке, схлопывает регистровые дубли и чистит single-secret коннекторы', async () => {
    store.rows.set('mcp-arckep-postgres', {
      ...postgres,
      settings: {
        'X-MCP-Database': 'corp_a_db',
        'x-mcp-host': 'old-lower.example.ru',
        'X-MCP-Password': 'enc:v1:old-secret',
        'X-MCP-Port': 15432,
        'X-MCP-User': 'corp_a_user',
      },
    });

    // Смена сервера с явной очисткой старых опциональных полей (null) и канонизацией регистра
    const updated = await service.updateSettings('mcp-arckep-postgres', {
      'X-MCP-Database': 'corp_b_db',
      'X-MCP-Host': 'new.example.ru',
      'X-MCP-Password': 'enc:v1:new-secret',
      'X-MCP-Port': null,
      'X-MCP-User': 'corp_b_user',
    });
    expect(mockUpdate).toHaveBeenLastCalledWith('mcp-arckep-postgres', {
      settings: {
        'X-MCP-Database': 'corp_b_db',
        'X-MCP-Host': 'new.example.ru',
        'X-MCP-Password': 'enc:v1:new-secret',
        'X-MCP-User': 'corp_b_user',
      },
    });
    expect(updated?.publicSettings).toEqual({
      'X-MCP-Database': 'corp_b_db',
      'X-MCP-Host': 'new.example.ru',
      'X-MCP-User': 'corp_b_user',
    });

    // Single-secret коннекторы (Figma / Google Sheets) вычищают любые старые посторонние публичные поля
    store.rows.set('mcp-arckep-figma', {
      identifier: 'mcp-arckep-figma',
      manifest: { api: [{ name: 'whoami' }], meta: { title: 'Figma' } },
      settings: {
        'X-MCP-Host': 'stale-host.example.com',
        'x-mcp-password': 'legacy-lower-secret',
      },
    });
    await service.updateSettings('mcp-arckep-figma', {
      'X-MCP-Password': 'enc:v1:figma-user-bound',
    });
    expect(mockUpdate).toHaveBeenLastCalledWith('mcp-arckep-figma', {
      settings: {
        'X-MCP-Password': 'enc:v1:figma-user-bound',
      },
    });
  });
});
