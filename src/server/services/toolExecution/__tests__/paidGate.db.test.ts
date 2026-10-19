// @vitest-environment node
import type { LobeChatDatabase } from '@lobechat/database';
import { topics, userInstalledPlugins, users } from '@lobechat/database/schemas';
import { getTestDB } from '@lobechat/database/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ToolExecutionService } from '../index';
import { decideConfirmation } from '../topicTrust';

/**
 * arckep (19.10.2026, этап 3, п. 3.Д): сквозная проверка на настоящей базе — после вызова чужого инструмента
 * (`umcp-*`) платные запуски студии (встроенная «Студия» и подключения `mcp-arckep-studio-*`) не выполняются без
 * подтверждения, бесплатные идут как раньше, повтор после «Подтвердить» выполняется один раз.
 */

const mockResolveArckepUserId = vi.hoisted(() => vi.fn());
vi.mock('../serverRuntimes/arckepStudio', () => ({
  resolveArckepUserId: mockResolveArckepUserId,
}));

const UMCP = 'umcp-abcdefghijkl';
const SEALED = 'enc:v1:AAAA_bbbb-CCCC';

describe('executeTool: ворота платных запусков в теме с чужим инструментом', () => {
  let db: LobeChatDatabase;
  let service: ToolExecutionService;
  let builtinExecute: ReturnType<typeof vi.fn>;
  let callTool: ReturnType<typeof vi.fn>;
  let me: string;
  let topicId: string;

  const ctx = (extra: Record<string, unknown> = {}) =>
    ({ serverDB: db, toolManifestMap: manifests(), topicId, userId: me, ...extra }) as any;

  const manifests = () => ({
    [UMCP]: {
      api: [{ description: '', name: 'search', parameters: { type: 'object' } }],
      identifier: UMCP,
      mcpParams: { type: 'http', url: 'https://ignored.example' },
      meta: { title: 'Мой сервер' },
      type: 'mcp',
    },
    'mcp-arckep-studio-video': {
      api: [
        { description: '', name: 'create_video', parameters: { type: 'object' } },
        { description: '', name: 'estimate_video', parameters: { type: 'object' } },
      ],
      identifier: 'mcp-arckep-studio-video',
      mcpParams: { type: 'http', url: 'http://127.0.0.1:8422/mcp' },
      meta: { title: 'Видео' },
      type: 'mcp',
    },
  });

  const callUmcp = () =>
    service.executeTool(
      { apiName: 'search', arguments: '{}', id: 'c0', identifier: UMCP, type: 'mcp' } as any,
      ctx(),
    );
  const createImage = (prompt = 'кот') =>
    service.executeTool(
      {
        apiName: 'createImage',
        arguments: JSON.stringify({ prompt }),
        id: 'c1',
        identifier: 'arckep-studio',
        type: 'builtin',
      } as any,
      ctx(),
    );
  const mcpVideo = (apiName = 'create_video', args: Record<string, unknown> = { prompt: 'закат' }) =>
    service.executeTool(
      {
        apiName,
        arguments: JSON.stringify(args),
        id: 'c2',
        identifier: 'mcp-arckep-studio-video',
        type: 'mcp',
      } as any,
      ctx(),
    );
  const cardId = (content: string) =>
    JSON.parse(content.split('\n').find((l) => l.startsWith('ARCKEP_CONFIRM '))!.slice(15)).id as string;

  beforeEach(async () => {
    process.env.ARCKEP_INTERNAL_TOKEN = 'internal-secret';
    db = await getTestDB();
    await db.delete(users);
    me = `me-${Date.now()}`;
    topicId = `tpc_${Date.now()}`;
    await db.insert(users).values({ id: me });
    await db.insert(topics).values({ id: topicId, title: 'чат', userId: me });
    await db.insert(userInstalledPlugins).values({
      customParams: { arckepUserMcp: { display: {}, kind: 'remote', sealed: SEALED }, mcp: { type: 'http', url: 'x' } } as any,
      identifier: UMCP,
      manifest: manifests()[UMCP] as any,
      settings: {},
      type: 'customPlugin',
      userId: me,
    });
    mockResolveArckepUserId.mockResolvedValue(15);
    builtinExecute = vi.fn().mockResolvedValue({ content: 'готово', success: true });
    callTool = vi.fn().mockResolvedValue({ content: 'ok', state: { content: [] }, success: true });
    service = new ToolExecutionService({
      builtinToolsExecutor: { execute: builtinExecute } as any,
      mcpService: { callTool } as any,
    });
  });

  it('до чужого инструмента платные запуски идут как обычно, без запросов подтверждения', async () => {
    expect((await createImage()).success).toBe(true);
    expect((await mcpVideo()).success).toBe(true);
    expect(builtinExecute).toHaveBeenCalledTimes(1);
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it('после вызова umcp-*: createImage и create_video ждут человека, бесплатные идут', async () => {
    expect((await callUmcp()).success).toBe(true);
    // вызов ушёл на шлюз с заголовками п. 3.Б
    expect(callTool.mock.calls[0][0].clientParams).toMatchObject({
      headers: { 'X-Arckep-Topic': topicId, 'X-Arckep-User': '15', 'X-Arckep-User-Mcp-Id': UMCP },
      url: 'http://127.0.0.1:8410/mcp/user-mcp',
    });
    callTool.mockClear();

    const held = await createImage('кот в шляпе');
    expect(held.success).toBe(false);
    expect(held.content).toContain('Нужно подтверждение человека');
    expect(held.content).toContain('ARCKEP_CONFIRM ');
    expect(held.error).toMatchObject({ code: 'ARCKEP_CONFIRMATION_REQUIRED' });
    // ошибка не попадает под автоповтор инструмента
    expect(held.error.kind).toBe('stop');
    expect(builtinExecute).not.toHaveBeenCalled();

    const heldVideo = await mcpVideo();
    expect(heldVideo.success).toBe(false);
    expect(callTool).not.toHaveBeenCalled();

    // оценка и чтение результата денег не тратят
    expect((await mcpVideo('estimate_video')).success).toBe(true);
    expect(
      (
        await service.executeTool(
          { apiName: 'getBalance', arguments: '{}', id: 'c3', identifier: 'arckep-studio', type: 'builtin' } as any,
          ctx(),
        )
      ).success,
    ).toBe(true);
  });

  it('«Подтвердить» → повтор тех же параметров выполняется один раз; другие параметры — новый запрос', async () => {
    await callUmcp();
    const held = await createImage('кот');
    await decideConfirmation(db, me, topicId, cardId(held.content), 'approve');

    // другие параметры — не то, что одобрено
    expect((await createImage('собака')).success).toBe(false);
    expect(builtinExecute).not.toHaveBeenCalled();

    const done = await createImage('кот');
    expect(done).toMatchObject({ content: 'готово', success: true });
    expect(builtinExecute).toHaveBeenCalledTimes(1);

    // на один вызов
    expect((await createImage('кот')).success).toBe(false);
    expect(builtinExecute).toHaveBeenCalledTimes(1);
  });

  it('«Отказаться» → повтор получает отказ и не выполняется', async () => {
    await callUmcp();
    const held = await mcpVideo('create_video', { prompt: 'дорого', duration: 10 });
    await decideConfirmation(db, me, topicId, cardId(held.content), 'reject');

    const retry = await mcpVideo('create_video', { duration: 10, prompt: 'дорого' });
    expect(retry.success).toBe(false);
    expect(retry.content).toContain('отказался');
    expect(retry.error).toMatchObject({ code: 'ARCKEP_CONFIRMATION_REJECTED' });
    expect(callTool).toHaveBeenCalledTimes(1); // только вызов umcp
  });

  it('вызов umcp-* без своей темы не выполняется, метки нет — платное идёт', async () => {
    const result = await service.executeTool(
      { apiName: 'search', arguments: '{}', id: 'c0', identifier: UMCP, type: 'mcp' } as any,
      ctx({ topicId: undefined }),
    );
    expect(result.success).toBe(false);
    expect(callTool).not.toHaveBeenCalled();
    expect((await createImage()).success).toBe(true);
  });

  it('платный вызов в другой теме этого человека не задет', async () => {
    await callUmcp();
    await db.insert(topics).values({ id: 'tpc_other', title: 'другой чат', userId: me });
    const result = await service.executeTool(
      {
        apiName: 'createImage',
        arguments: JSON.stringify({ prompt: 'кот' }),
        id: 'c1',
        identifier: 'arckep-studio',
        type: 'builtin',
      } as any,
      ctx({ topicId: 'tpc_other' }),
    );
    expect(result.success).toBe(true);
  });
});
