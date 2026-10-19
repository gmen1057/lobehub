// @vitest-environment node
import type { LobeChatDatabase } from '@lobechat/database';
import { topics, userInstalledPlugins, users } from '@lobechat/database/schemas';
import { getTestDB } from '@lobechat/database/test-utils';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ArckepRoutes from '../../../../../packages/openapi/src/routes/arckep.route';
import PluginsRoutes from '../../../../../packages/openapi/src/routes/plugins.route';
import { gatePaidToolCall, markTopicUntrusted } from '../../toolExecution/topicTrust';
import { UserMcpGatewayError } from '../gateway';

/**
 * arckep (19.10.2026, этап 3, п. 3.В и 3.Д): REST своих подключений (`/api/v1/plugins/user-mcp`) и решений по
 * подтверждениям (`/api/v1/arckep/topics/:id/confirmations/:id`) на настоящей базе: проверки полей, служебный
 * вход, ошибка шлюза без записи строки, шифротекст `sealed` наружу не уходит ни в одном ответе.
 */

const state = vi.hoisted(() => ({ db: undefined as any }));
const mockList = vi.hoisted(() => vi.fn());

vi.mock('@/database/core/db-adaptor', () => ({ getServerDB: async () => state.db }));
vi.mock('../../toolExecution/serverRuntimes/arckepStudio', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveArckepUserId: async () => 15,
}));
vi.mock('../gateway', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listUserMcpTools: mockList,
}));
// вход: тестовая «служебная» или «ключ API» учётка по заголовку
vi.mock('../../../../../packages/openapi/src/middleware/auth', () => ({
  requireAuth: async (c: any, next: any) => {
    const who = c.req.header('x-test-auth');
    if (!who) return c.json({ error: 'auth' }, 401);
    c.set('userId', c.req.header('x-test-user') ?? 'u1');
    c.set('authType', who);
    await next();
  },
}));

const SEALED = 'enc:v1:AAAA_bbbb-CCCC';
const SEALED_B = 'enc:v1:ZZZZ_yyyy-XXXX';
const ID = 'umcp-abcdefghijkl';
const body = (patch: Record<string, unknown> = {}) => ({
  description: 'Мои заметки',
  display: { host: 'notion.example' },
  identifier: ID,
  kind: 'remote',
  sealed: SEALED,
  title: 'Мой Notion',
  ...patch,
});

// маршруты — экземпляры Hono: запрос идёт через их `.request`, префиксы /plugins и /arckep снимаются
const dispatch = (path: string, init: RequestInit) =>
  path.startsWith('/arckep/')
    ? ArckepRoutes.request(path.slice('/arckep'.length), init)
    : PluginsRoutes.request(path.slice('/plugins'.length) || '/', init);
const call = (
  method: string,
  path: string,
  options: { auth?: string; body?: unknown; user?: string } = {},
) =>
  dispatch(path, {
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    headers: {
      'Content-Type': 'application/json',
      ...(options.auth === undefined ? { 'x-test-auth': 'arckep-service' } : options.auth ? { 'x-test-auth': options.auth } : {}),
      ...(options.user ? { 'x-test-user': options.user } : {}),
    },
    method,
  });

describe('REST своих подключений', () => {
  let db: LobeChatDatabase;
  const tools = [
    { description: 'Поиск', name: 'search', parameters: { type: 'object' } },
    { description: 'Чтение', name: 'read_page', parameters: { type: 'object' } },
  ];
  const rows = (user = 'u1') =>
    db.select().from(userInstalledPlugins).where(eq(userInstalledPlugins.userId, user));

  beforeEach(async () => {
    vi.clearAllMocks();
    db = await getTestDB();
    state.db = db;
    await db.delete(users);
    await db.insert(users).values([{ id: 'u1' }, { id: 'u2' }]);
    mockList.mockResolvedValue(tools);
  });

  describe('POST /plugins/user-mcp', () => {
    it('создаёт строку: manifest из tools/list, customParams с sealed; ответ без шифротекста', async () => {
      const response = await call('POST', '/plugins/user-mcp', { body: body() });
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).not.toContain('enc:v1');
      expect(text).not.toContain(SEALED);
      const { data } = JSON.parse(text);
      expect(data).toMatchObject({
        description: 'Мои заметки',
        identifier: ID,
        installed: true,
        title: 'Мой Notion',
        tools: ['search', 'read_page'],
        type: 'customPlugin',
        userMcp: { display: { host: 'notion.example' }, kind: 'remote' },
      });

      // шлюзу — заголовки п. 3.Б без темы
      expect(mockList).toHaveBeenCalledWith({
        headers: {
          'X-Arckep-User': '15',
          'X-Arckep-User-Mcp-Config': SEALED,
          'X-Arckep-User-Mcp-Id': ID,
        },
      });

      const [row] = await rows();
      expect(row.identifier).toBe(ID);
      expect(row.type).toBe('customPlugin');
      expect(row.customParams).toMatchObject({
        arckepUserMcp: { display: { host: 'notion.example' }, kind: 'remote', sealed: SEALED },
        mcp: { type: 'http', url: 'http://127.0.0.1:8410/mcp/user-mcp' },
      });
      expect(row.manifest).toMatchObject({
        identifier: ID,
        mcpParams: { name: ID, type: 'http', url: 'http://127.0.0.1:8410/mcp/user-mcp' },
        meta: { description: 'Мои заметки', title: 'Мой Notion' },
        type: 'mcp',
      });
      expect((row.manifest as any).api.map((api: any) => api.name)).toEqual(['search', 'read_page']);
      expect(row.settings).toEqual({});
    });

    it('только служебный вход студии: ключ API и вход без прав не создают, шлюз не зовётся', async () => {
      expect((await call('POST', '/plugins/user-mcp', { auth: 'apikey', body: body() })).status).toBe(403);
      expect((await call('POST', '/plugins/user-mcp', { auth: '', body: body() })).status).toBe(401);
      expect(mockList).not.toHaveBeenCalled();
      expect(await rows()).toHaveLength(0);
    });

    it.each([
      ['префикс mcp-arckep- запрещён', { identifier: 'mcp-arckep-abcdefghij' }],
      ['идентификатор не по формату (заглавные)', { identifier: 'umcp-ABCDEFGHIJKL' }],
      ['идентификатор короче 12', { identifier: 'umcp-abcdefghijk' }],
      ['идентификатор длиннее 12', { identifier: 'umcp-abcdefghijklm' }],
      ['неизвестный вид', { kind: 'stdio' }],
      ['sealed — открытый текст', { sealed: 'my-secret-token' }],
      ['sealed без base64url', { sealed: 'enc:v1:abc def' }],
      ['sealed с переводом строки', { sealed: 'enc:v1:abc\nX-Evil: 1' }],
      ['sealed длиннее 8000', { sealed: `enc:v1:${'A'.repeat(8000)}` }],
      ['пустое название', { title: '   ' }],
      ['название длиннее 80', { title: 'x'.repeat(81) }],
      ['описание длиннее 300', { description: 'x'.repeat(301) }],
      ['display — не строки', { display: { host: 5 } }],
      ['значение display длиннее 200', { display: { host: 'x'.repeat(201) } }],
      ['display больше 10 полей', { display: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, 'v'])) }],
      ['лишнее поле token', { token: 'plain-secret' }],
      ['лишнее поле url', { url: 'https://example.com/mcp' }],
    ])('поля: %s → 400, ничего не записано', async (_name, patch) => {
      const response = await call('POST', '/plugins/user-mcp', { body: body(patch) });
      expect(response.status).toBe(400);
      expect(mockList).not.toHaveBeenCalled();
      expect(await rows()).toHaveLength(0);
    });

    it('description можно не передавать: описание по умолчанию называет сервер и число инструментов', async () => {
      const { description: _omit, ...rest } = body();
      const response = await call('POST', '/plugins/user-mcp', { body: rest });
      expect(response.status).toBe(200);
      expect((await response.json()).data.description).toContain('инструментов — 2');
    });

    it('ошибка шлюза — его русский текст и статус, строка не пишется', async () => {
      for (const [message, status] of [
        ['Недостаточно средств на балансе', 402],
        ['Сервер не ответил за 2 минуты', 504],
        ['Адрес внутренней сети запрещён', 400],
      ] as const) {
        mockList.mockRejectedValueOnce(new UserMcpGatewayError(message, status));
        const response = await call('POST', '/plugins/user-mcp', { body: body() });
        expect(response.status).toBe(status);
        const json = await response.json();
        expect(json.error).toBe(message);
        expect(json.success).toBe(false);
      }
      expect(await rows()).toHaveLength(0);
    });

    it('шлюз ответил без единого инструмента — 422, строки нет', async () => {
      mockList.mockResolvedValueOnce([]);
      const response = await call('POST', '/plugins/user-mcp', { body: body() });
      expect(response.status).toBe(422);
      expect(await rows()).toHaveLength(0);
    });

    it('повтор с тем же идентификатором обновляет строку этого человека, чужую не трогает', async () => {
      await call('POST', '/plugins/user-mcp', { body: body() });
      await call('POST', '/plugins/user-mcp', { body: body({ sealed: SEALED_B, title: 'Новый' }) });
      const mine = await rows();
      expect(mine).toHaveLength(1);
      expect((mine[0].customParams as any).arckepUserMcp.sealed).toBe(SEALED_B);
      expect(await rows('u2')).toHaveLength(0);

      await call('POST', '/plugins/user-mcp', { body: body(), user: 'u2' });
      expect((await rows('u2'))[0].identifier).toBe(ID);
      expect((await rows())[0].customParams).toMatchObject({ arckepUserMcp: { sealed: SEALED_B } });
    });
  });

  describe('список, настройки, удаление, обновление', () => {
    beforeEach(async () => {
      await call('POST', '/plugins/user-mcp', { body: body() });
    });

    it('GET /plugins отдаёт своё подключение с userMcp и без шифротекста', async () => {
      const response = await call('GET', '/plugins');
      const text = await response.text();
      expect(text).not.toContain('enc:v1');
      const mine = JSON.parse(text).data.plugins.find((p: any) => p.identifier === ID);
      expect(mine.userMcp).toEqual({ display: { host: 'notion.example' }, kind: 'remote' });
      expect(Object.keys(mine).sort()).toEqual(
        ['description', 'identifier', 'installed', 'settingsFilled', 'title', 'tools', 'type', 'userMcp'].sort(),
      );
    });

    it('каталог: свои umcp-* этого человека (installed: true, с userMcp), чужих нет; установить из каталога нельзя', async () => {
      // у человека B (u2) своё подключение с другим идентификатором
      const other = 'umcp-zzzzzzzzzzzz';
      await call('POST', '/plugins/user-mcp', {
        body: body({ display: { host: 'other.example' }, identifier: other, title: 'Чужой сервер' }),
        user: 'u2',
      });

      const catalogOf = async (user?: string) => {
        const response = await call('GET', '/plugins/catalog', { user });
        const text = await response.text();
        expect(text).not.toContain('enc:v1');
        return JSON.parse(text).data.plugins as any[];
      };

      const mine = (await catalogOf()).filter((p) => p.identifier.startsWith('umcp-'));
      expect(mine.map((p) => p.identifier)).toEqual([ID]);
      expect(mine[0]).toMatchObject({
        description: 'Мои заметки',
        installed: true,
        title: 'Мой Notion',
        tools: ['search', 'read_page'],
        userMcp: { display: { host: 'notion.example' }, kind: 'remote' },
      });

      const theirs = (await catalogOf('u2')).filter((p) => p.identifier.startsWith('umcp-'));
      expect(theirs.map((p) => p.identifier)).toEqual([other]);
      expect(theirs[0].userMcp).toEqual({ display: { host: 'other.example' }, kind: 'remote' });

      // у человека без своих подключений их в каталоге нет
      await db.insert(users).values({ id: 'u3' });
      expect((await catalogOf('u3')).some((p) => p.identifier.startsWith('umcp-'))).toBe(false);

      // установить из каталога нельзя ни своё, ни чужое
      expect((await call('POST', `/plugins/${ID}/install`, { user: 'u2' })).status).toBe(404);
      expect((await call('POST', `/plugins/${ID}/install`)).status).toBe(404);
    });

    it('PATCH настроек для umcp-* отклоняется: ключи зашифрованы целиком', async () => {
      const response = await call('PATCH', `/plugins/${ID}`, { body: { settings: { 'X-MCP-Host': 'x' } } });
      expect(response.status).toBe(400);
      expect((await response.json()).error).toContain('нет настроек');
      expect((await rows())[0].settings).toEqual({});
    });

    it('DELETE удаляет только строку этого человека', async () => {
      await call('POST', '/plugins/user-mcp', { body: body(), user: 'u2' });
      expect((await call('DELETE', `/plugins/${ID}`)).status).toBe(200);
      expect(await rows()).toHaveLength(0);
      expect(await rows('u2')).toHaveLength(1);
    });

    it('refresh: перечитывает инструменты, название и описание остаются; ответ без шифротекста', async () => {
      mockList.mockResolvedValueOnce([{ description: 'Новый', name: 'create_page', parameters: { type: 'object' } }]);
      const response = await call('POST', `/plugins/user-mcp/${ID}/refresh`);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).not.toContain('enc:v1');
      expect(JSON.parse(text).data).toMatchObject({
        description: 'Мои заметки',
        title: 'Мой Notion',
        tools: ['create_page'],
      });
      expect(mockList).toHaveBeenLastCalledWith({
        headers: expect.objectContaining({
          'X-Arckep-User-Mcp-Config': SEALED,
          'X-Arckep-User-Mcp-Id': ID,
          // шлюз держит список в кэше 10 минут: при обновлении просим читать заново
          'X-Arckep-User-Mcp-Refresh': '1',
        }),
      });
      expect(((await rows())[0].manifest as any).api.map((api: any) => api.name)).toEqual(['create_page']);
      expect((await rows())[0].customParams).toMatchObject({ arckepUserMcp: { sealed: SEALED } });
    });

    it('refresh: чужое и несуществующее подключение — 404, обычный ключ API — 403, ошибка шлюза — её текст', async () => {
      expect((await call('POST', `/plugins/user-mcp/${ID}/refresh`, { user: 'u2' })).status).toBe(404);
      expect((await call('POST', '/plugins/user-mcp/umcp-zzzzzzzzzzzz/refresh')).status).toBe(404);
      expect((await call('POST', `/plugins/user-mcp/${ID}/refresh`, { auth: 'apikey' })).status).toBe(403);
      // не по формату — 400 до базы
      expect((await call('POST', '/plugins/user-mcp/mcp-arckep-figma/refresh')).status).toBe(400);

      mockList.mockRejectedValueOnce(new UserMcpGatewayError('Сервер не ответил за 2 минуты', 504));
      const failed = await call('POST', `/plugins/user-mcp/${ID}/refresh`);
      expect(failed.status).toBe(504);
      expect((await failed.json()).error).toBe('Сервер не ответил за 2 минуты');
      // прежний manifest цел
      expect(((await rows())[0].manifest as any).api).toHaveLength(2);
    });

    it('refresh: у строки нет sealed — 409 «добавьте заново»', async () => {
      await db
        .update(userInstalledPlugins)
        .set({ customParams: { mcp: { type: 'http', url: 'x' } } as any })
        .where(and(eq(userInstalledPlugins.userId, 'u1'), eq(userInstalledPlugins.identifier, ID)));
      const response = await call('POST', `/plugins/user-mcp/${ID}/refresh`);
      expect(response.status).toBe(409);
    });
  });
});

describe('REST подтверждений платных запусков', () => {
  let db: LobeChatDatabase;
  const topicId = 'tpc_rest';
  const toolCall = { apiName: 'create_image', arguments: '{"prompt":"кот"}', identifier: 'mcp-arckep-studio-images' };

  const ask = async () => {
    const held = await gatePaidToolCall(db, 'u1', topicId, toolCall);
    if (held.action !== 'blocked') throw new Error('unreachable');
    return JSON.parse(held.content.split('\n').find((l) => l.startsWith('ARCKEP_CONFIRM '))!.slice(15)).id as string;
  };
  const decide = (id: string, action: unknown, options: { auth?: string; topic?: string; user?: string } = {}) =>
    call('POST', `/arckep/topics/${options.topic ?? topicId}/confirmations/${id}`, {
      auth: options.auth,
      body: { action },
      user: options.user,
    });

  beforeEach(async () => {
    db = await getTestDB();
    state.db = db;
    await db.delete(users);
    await db.insert(users).values([{ id: 'u1' }, { id: 'u2' }]);
    await db.insert(topics).values([
      { id: topicId, title: 'моя', userId: 'u1' },
      { id: 'tpc_u2', title: 'чужая', userId: 'u2' },
    ]);
    await markTopicUntrusted(db, 'u1', topicId, ID);
  });

  it('одобрить → {status: approved}; повтор вызова выполняется один раз', async () => {
    const id = await ask();
    const response = await decide(id, 'approve');
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ status: 'approved' });
    // двойной щелчок
    expect((await (await decide(id, 'approve')).json()).data).toEqual({ status: 'approved' });
    expect(await gatePaidToolCall(db, 'u1', topicId, toolCall)).toEqual({ action: 'proceed' });
    // уже выполнено → 409
    expect((await decide(id, 'approve')).status).toBe(409);
  });

  it('отклонить → {status: rejected}; потом одобрить уже нельзя (409)', async () => {
    const id = await ask();
    expect((await (await decide(id, 'reject')).json()).data).toEqual({ status: 'rejected' });
    expect((await decide(id, 'approve')).status).toBe(409);
    expect(await gatePaidToolCall(db, 'u1', topicId, toolCall)).toMatchObject({ code: 'ARCKEP_CONFIRMATION_REJECTED' });
  });

  it('просроченный запрос — 410', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-19T12:00:00Z'));
      const id = await ask();
      vi.setSystemTime(new Date('2026-10-19T12:16:00Z'));
      const response = await decide(id, 'approve');
      expect(response.status).toBe(410);
      expect((await response.json()).error).toContain('устарел');
    } finally {
      vi.useRealTimers();
    }
  });

  it('чужая тема и чужой запрос — 404, статус не меняется; несуществующий номер — 404', async () => {
    const id = await ask();
    expect((await decide(id, 'approve', { user: 'u2' })).status).toBe(404);
    expect((await decide(id, 'approve', { topic: 'tpc_u2' })).status).toBe(404);
    expect((await decide('cfm_00000000000000000000', 'approve')).status).toBe(404);
    expect(await gatePaidToolCall(db, 'u1', topicId, toolCall)).toMatchObject({ code: 'ARCKEP_CONFIRMATION_REQUIRED' });
  });

  it('только служебный вход студии; поля проверяются', async () => {
    const id = await ask();
    expect((await decide(id, 'approve', { auth: 'apikey' })).status).toBe(403);
    expect((await decide(id, 'maybe')).status).toBe(400);
    expect((await decide('cfm_short', 'approve')).status).toBe(400);
    expect((await decide(id, 'approve', { auth: '' })).status).toBe(401);
    const extra = await call('POST', `/arckep/topics/${topicId}/confirmations/${id}`, {
      body: { action: 'approve', userId: 'u2' },
    });
    expect(extra.status).toBe(400);
  });
});
