// @vitest-environment node
import type { LobeChatDatabase } from '@lobechat/database';
import { messagePlugins, messages, topics, users } from '@lobechat/database/schemas';
import { getTestDB } from '@lobechat/database/test-utils';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  canonicalJson,
  CONFIRMATION_TTL_MS,
  confirmationIdFor,
  decideConfirmation,
  gatePaidToolCall,
  hashToolArguments,
  isTopicUntrusted,
  markTopicIfUserMcp,
  markTopicUntrusted,
  readConfirmation,
  summarizeToolCall,
  swapConfirmation,
  type TopicConfirmation,
} from '../topicTrust';

/**
 * arckep (19.10.2026, этап 3, п. 3.Д): метка темы и подтверждение платных запусков на настоящей базе
 * (PGlite): SQL `jsonb_set` в одном UPDATE, сравнение с прежним значением, срок 15 минут, один вызов.
 */

const IMAGE = { apiName: 'create_image', identifier: 'mcp-arckep-studio-images' };
const args = (value: Record<string, unknown>) => JSON.stringify(value);
const marker = (content: string) =>
  JSON.parse(content.split('\n').find((line) => line.startsWith('ARCKEP_CONFIRM '))!.slice(15));

describe('метка темы и подтверждения (topics.metadata)', () => {
  let db: LobeChatDatabase;
  let me: string;
  let other: string;
  let topicId: string;

  const metadataOf = async (id = topicId) =>
    (await db.select({ metadata: topics.metadata }).from(topics).where(eq(topics.id, id)))[0]
      ?.metadata as Record<string, any> | null;

  const gate = (rawArguments: string, call = IMAGE, id = topicId, userId = me) =>
    gatePaidToolCall(db, userId, id, { ...call, arguments: rawArguments });

  beforeEach(async () => {
    db = await getTestDB();
    await db.delete(users);
    me = `me-${Date.now()}`;
    other = `other-${Date.now()}`;
    topicId = `tpc_${Date.now()}`;
    await db.insert(users).values([{ id: me }, { id: other }]);
    await db.insert(topics).values([
      { id: topicId, metadata: { model: 'm1' } as any, title: 'моя', userId: me },
      { id: 'tpc_second', title: 'вторая', userId: me },
      { id: 'tpc_theirs', title: 'чужая', userId: other },
    ]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('метка «чужой инструмент»', () => {
    it('ставится одним UPDATE, остальные ключи metadata целы, первая метка остаётся', async () => {
      expect(await markTopicUntrusted(db, me, topicId, 'umcp-aaaaaaaaaaaa')).toBe(true);
      const first = await metadataOf();
      expect(first?.model).toBe('m1');
      expect(first?.arckepUntrusted).toMatchObject({ identifier: 'umcp-aaaaaaaaaaaa' });
      expect(Date.parse(first?.arckepUntrusted.since)).not.toBeNaN();

      expect(await markTopicUntrusted(db, me, topicId, 'umcp-bbbbbbbbbbbb')).toBe(true);
      expect((await metadataOf())?.arckepUntrusted).toEqual(first?.arckepUntrusted);
    });

    it('тема без metadata (NULL) и с JSON null тоже помечается', async () => {
      expect(await markTopicUntrusted(db, me, 'tpc_second', 'umcp-aaaaaaaaaaaa')).toBe(true);
      expect((await metadataOf('tpc_second'))?.arckepUntrusted).toBeTruthy();
    });

    it('metadata = JSON null (не SQL NULL) тоже читается как пустая', async () => {
      await db.update(topics).set({ metadata: sql`'null'::jsonb` as any }).where(eq(topics.id, 'tpc_second'));
      expect(await markTopicUntrusted(db, me, 'tpc_second', 'umcp-aaaaaaaaaaaa')).toBe(true);
      expect((await metadataOf('tpc_second'))?.arckepUntrusted).toBeTruthy();
    });

    it('markTopicIfUserMcp: помечает по первому umcp-*; прочие инструменты и пустые данные не трогает; сбой — отказ (закрыто)', async () => {
      await markTopicIfUserMcp(db, me, topicId, ['mcp-arckep-wordstat', 'lobe-user-memory']);
      expect((await metadataOf())?.arckepUntrusted).toBeUndefined();
      await markTopicIfUserMcp(db, me, undefined, ['umcp-aaaaaaaaaaaa']);
      await markTopicIfUserMcp(undefined, me, topicId, ['umcp-aaaaaaaaaaaa']);
      expect((await metadataOf())?.arckepUntrusted).toBeUndefined();

      await markTopicIfUserMcp(db, me, topicId, ['lobe-activator', 'umcp-aaaaaaaaaaaa', 'umcp-bbbbbbbbbbbb']);
      expect((await metadataOf())?.arckepUntrusted?.identifier).toBe('umcp-aaaaaaaaaaaa');

      const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      // сбой базы и чужая/пропавшая тема — исключение, а не тихий пропуск
      const broken = {
        update: () => {
          throw new Error('db down');
        },
      } as any;
      await expect(markTopicIfUserMcp(broken, me, topicId, ['umcp-aaaaaaaaaaaa'])).rejects.toThrow(
        'Не удалось подготовить чат',
      );
      await expect(markTopicIfUserMcp(db, me, 'tpc_theirs', ['umcp-aaaaaaaaaaaa'])).rejects.toThrow(
        'Не удалось подготовить чат',
      );
      spy.mockRestore();
    });

    it('подключение инструмента (шаг activateTools) в истории темы — тоже «чужой инструмент», даже без метки', async () => {
      await db.insert(messages).values({ id: 'msg_act', role: 'tool', topicId, userId: me });
      await db.insert(messagePlugins).values({
        id: 'msg_act',
        identifier: 'lobe-activator',
        state: { activatedTools: [{ identifier: 'mcp-arckep-wordstat', name: 'W' }] } as any,
        type: 'builtin',
        userId: me,
      });
      // подключили только своё «обычное» — тема чистая
      expect(await isTopicUntrusted(db, me, topicId)).toBe(false);

      await db.insert(messages).values({ id: 'msg_act2', role: 'tool', topicId, userId: me });
      await db.insert(messagePlugins).values({
        id: 'msg_act2',
        identifier: 'lobe-activator',
        state: { activatedTools: [{ identifier: 'umcp-aaaaaaaaaaaa', name: 'N' }] } as any,
        type: 'builtin',
        userId: me,
      });
      expect(await isTopicUntrusted(db, me, topicId)).toBe(true);
      // другая тема, другой человек
      expect(await isTopicUntrusted(db, me, 'tpc_second')).toBe(false);
      expect(await isTopicUntrusted(db, other, topicId)).toBe(false);
      // платный запуск в такой теме ждёт человека, хотя метки в metadata нет
      expect(await gate(args({ prompt: 'z' }))).toMatchObject({ code: 'ARCKEP_CONFIRMATION_REQUIRED' });
    });

    it('чужая и несуществующая тема не помечается', async () => {
      expect(await markTopicUntrusted(db, me, 'tpc_theirs', 'umcp-aaaaaaaaaaaa')).toBe(false);
      expect(await markTopicUntrusted(db, me, 'tpc_missing', 'umcp-aaaaaaaaaaaa')).toBe(false);
      expect(await metadataOf('tpc_theirs')).toBeNull();
    });

    it('isTopicUntrusted: чистая — нет; по метке — да; по истории вызовов umcp-* — да, даже без метки', async () => {
      expect(await isTopicUntrusted(db, me, topicId)).toBe(false);

      await db.insert(messages).values({ id: 'msg_1', role: 'tool', topicId, userId: me });
      await db
        .insert(messagePlugins)
        .values({ id: 'msg_1', identifier: 'mcp-arckep-wordstat', type: 'mcp', userId: me });
      expect(await isTopicUntrusted(db, me, topicId)).toBe(false);

      await db.insert(messages).values({ id: 'msg_2', role: 'tool', topicId, userId: me });
      await db
        .insert(messagePlugins)
        .values({ id: 'msg_2', identifier: 'umcp-aaaaaaaaaaaa', type: 'mcp', userId: me });
      // метки нет (её могла затереть запись metadata целиком), но вызов был
      expect(await isTopicUntrusted(db, me, topicId)).toBe(true);
      // в другой теме этого человека и у другого человека — нет
      expect(await isTopicUntrusted(db, me, 'tpc_second')).toBe(false);
      expect(await isTopicUntrusted(db, other, topicId)).toBe(false);
    });
  });

  describe('swapConfirmation — сравнение с прежним значением', () => {
    const entry = (patch: Partial<TopicConfirmation> = {}): TopicConfirmation => ({
      argsHash: 'h',
      createdAt: new Date().toISOString(),
      id: 'cfm_a',
      identifier: 'x',
      status: 'pending',
      tool: 'create_image',
      ...patch,
    });

    it('создаёт, меняет по совпавшему прежнему, отказывает по устаревшему; metadata целы', async () => {
      const first = entry();
      expect(await swapConfirmation(db, me, topicId, 'cfm_a', null, first)).toBe(true);
      // создать «с нуля» второй раз нельзя — запись уже есть
      expect(await swapConfirmation(db, me, topicId, 'cfm_a', null, entry({ tool: 'x' }))).toBe(false);

      const approved = { ...first, decidedAt: new Date().toISOString(), status: 'approved' as const };
      expect(await swapConfirmation(db, me, topicId, 'cfm_a', first, approved)).toBe(true);
      // тот же прежний ещё раз — уже не совпадает: проиграл
      expect(await swapConfirmation(db, me, topicId, 'cfm_a', first, approved)).toBe(false);

      const metadata = await metadataOf();
      expect(metadata?.model).toBe('m1');
      expect(metadata?.arckepConfirmations.cfm_a.status).toBe('approved');
    });

    it('записи старше суток убираются при следующей записи', async () => {
      const old = entry({ createdAt: new Date(Date.now() - 2 * 24 * 3600_000).toISOString(), id: 'cfm_old' });
      await swapConfirmation(db, me, topicId, 'cfm_old', null, old);
      await swapConfirmation(db, me, topicId, 'cfm_new', null, entry({ id: 'cfm_new' }));
      const stored = (await metadataOf())?.arckepConfirmations;
      expect(Object.keys(stored)).toEqual(['cfm_new']);
    });

    it('чужая тема: ничего не пишется', async () => {
      expect(await swapConfirmation(db, me, 'tpc_theirs', 'cfm_a', null, entry())).toBe(false);
      expect(await metadataOf('tpc_theirs')).toBeNull();
    });
  });

  describe('gatePaidToolCall', () => {
    it('тема без метки и вызов без метки — выполнять, записей не создаётся', async () => {
      expect(await gate(args({ prompt: 'кот' }))).toEqual({ action: 'proceed' });
      expect((await metadataOf())?.arckepConfirmations).toBeUndefined();
    });

    it('в помеченной теме: просьба о подтверждении с маркером; повтор до решения — тот же запрос', async () => {
      await markTopicUntrusted(db, me, topicId, 'umcp-aaaaaaaaaaaa');
      const first = await gate(args({ model: 'flux', prompt: 'кот в шляпе' }));
      expect(first).toMatchObject({ action: 'blocked', code: 'ARCKEP_CONFIRMATION_REQUIRED' });
      if (first.action !== 'blocked') throw new Error('unreachable');
      expect(first.content).toContain('НЕ выполнен');

      const card = marker(first.content);
      expect(card.tool).toBe('create_image');
      expect(card.summary).toContain('кот в шляпе');
      expect(card.summary).toContain('модель flux');
      expect(card.summary.length).toBeLessThanOrEqual(300);

      const stored = (await metadataOf())?.arckepConfirmations;
      expect(Object.keys(stored)).toEqual([card.id]);
      expect(stored[card.id]).toMatchObject({ status: 'pending', tool: 'create_image' });
      expect(stored[card.id].argsHash).toBe(hashToolArguments(args({ model: 'flux', prompt: 'кот в шляпе' })));

      // порядок ключей в аргументах не важен: тот же вызов — тот же запрос, дубля нет
      const again = await gate(args({ prompt: 'кот в шляпе', model: 'flux' }));
      if (again.action !== 'blocked') throw new Error('unreachable');
      expect(marker(again.content).id).toBe(card.id);
      expect(Object.keys((await metadataOf())?.arckepConfirmations)).toHaveLength(1);
    });

    it('одобрено → следующий вызов выполняется, ровно один раз; потом снова нужен запрос', async () => {
      await markTopicUntrusted(db, me, topicId, 'umcp-aaaaaaaaaaaa');
      const raw = args({ prompt: 'закат' });
      const asked = await gate(raw);
      if (asked.action !== 'blocked') throw new Error('unreachable');
      const { id } = marker(asked.content);

      expect(await decideConfirmation(db, me, topicId, id, 'approve')).toEqual({
        ok: true,
        status: 'approved',
      });
      // повторное то же решение (двойной щелчок) — не ошибка
      expect(await decideConfirmation(db, me, topicId, id, 'approve')).toEqual({
        ok: true,
        status: 'approved',
      });

      expect(await gate(raw)).toEqual({ action: 'proceed' });
      expect((await readConfirmation(db, me, topicId, id))?.status).toBe('consumed');

      // на один вызов: ещё раз тот же — снова просьба (новая запись под тем же номером)
      const third = await gate(raw);
      expect(third).toMatchObject({ action: 'blocked', code: 'ARCKEP_CONFIRMATION_REQUIRED' });
      expect((await readConfirmation(db, me, topicId, id))?.status).toBe('pending');
      expect(await decideConfirmation(db, me, topicId, id, 'approve')).toMatchObject({ ok: true });
    });

    it('отклонено → повтор получает отказ, не выполняется; решение уже принято — смена даёт 409', async () => {
      await markTopicUntrusted(db, me, topicId, 'umcp-aaaaaaaaaaaa');
      const raw = args({ prompt: 'дорогое видео' });
      const asked = await gate(raw);
      if (asked.action !== 'blocked') throw new Error('unreachable');
      const { id } = marker(asked.content);

      expect(await decideConfirmation(db, me, topicId, id, 'reject')).toEqual({
        ok: true,
        status: 'rejected',
      });
      const retry = await gate(raw);
      expect(retry).toMatchObject({ action: 'blocked', code: 'ARCKEP_CONFIRMATION_REJECTED' });
      if (retry.action !== 'blocked') throw new Error('unreachable');
      expect(retry.content).toContain('отказался');
      expect(retry.content).not.toContain('ARCKEP_CONFIRM');

      expect(await decideConfirmation(db, me, topicId, id, 'approve')).toMatchObject({
        ok: false,
        status: 409,
      });
    });

    it('другие аргументы и другой инструмент — отдельный запрос; одобрение не переносится', async () => {
      await markTopicUntrusted(db, me, topicId, 'umcp-aaaaaaaaaaaa');
      const a = await gate(args({ prompt: 'A' }));
      if (a.action !== 'blocked') throw new Error('unreachable');
      const idA = marker(a.content).id;
      await decideConfirmation(db, me, topicId, idA, 'approve');

      const b = await gate(args({ prompt: 'B' }));
      expect(b).toMatchObject({ action: 'blocked', code: 'ARCKEP_CONFIRMATION_REQUIRED' });
      if (b.action !== 'blocked') throw new Error('unreachable');
      expect(marker(b.content).id).not.toBe(idA);

      const video = await gate(args({ prompt: 'A' }), {
        apiName: 'create_video',
        identifier: 'mcp-arckep-studio-video',
      });
      expect(video).toMatchObject({ action: 'blocked', code: 'ARCKEP_CONFIRMATION_REQUIRED' });

      // одобренное для A по-прежнему ждёт своего вызова
      expect(await gate(args({ prompt: 'A' }))).toEqual({ action: 'proceed' });
    });

    it('просрочено: одобрение живёт 15 минут от решения, запрос — 15 минут от создания', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-19T12:00:00Z'));
      await markTopicUntrusted(db, me, topicId, 'umcp-aaaaaaaaaaaa');

      // одобрено, но не использовано
      const raw = args({ prompt: 'старое' });
      const asked = await gate(raw);
      if (asked.action !== 'blocked') throw new Error('unreachable');
      const { id } = marker(asked.content);
      vi.setSystemTime(new Date('2026-10-19T12:10:00Z'));
      await decideConfirmation(db, me, topicId, id, 'approve');

      vi.setSystemTime(new Date(Date.parse('2026-10-19T12:10:00Z') + CONFIRMATION_TTL_MS + 1000));
      const late = await gate(raw);
      expect(late).toMatchObject({ action: 'blocked', code: 'ARCKEP_CONFIRMATION_REQUIRED' });
      // просроченное одобрение заменено новым ожидающим запросом
      expect((await readConfirmation(db, me, topicId, id))?.status).toBe('pending');

      // ожидающий запрос, на который не нажали: через 15 минут решать уже поздно
      vi.setSystemTime(new Date(Date.now() + CONFIRMATION_TTL_MS + 1000));
      expect(await decideConfirmation(db, me, topicId, id, 'approve')).toMatchObject({
        ok: false,
        status: 410,
      });
    });

    it('отказ тоже живёт 15 минут, потом вызов снова может быть запрошен', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-19T12:00:00Z'));
      await markTopicUntrusted(db, me, topicId, 'umcp-aaaaaaaaaaaa');
      const raw = args({ prompt: 'x' });
      const asked = await gate(raw);
      if (asked.action !== 'blocked') throw new Error('unreachable');
      const { id } = marker(asked.content);
      await decideConfirmation(db, me, topicId, id, 'reject');

      vi.setSystemTime(new Date('2026-10-19T12:14:00Z'));
      expect(await gate(raw)).toMatchObject({ code: 'ARCKEP_CONFIRMATION_REJECTED' });
      vi.setSystemTime(new Date('2026-10-19T12:16:00Z'));
      expect(await gate(raw)).toMatchObject({ code: 'ARCKEP_CONFIRMATION_REQUIRED' });
    });

    it('другая тема того же человека одобрением не пользуется', async () => {
      await markTopicUntrusted(db, me, topicId, 'umcp-aaaaaaaaaaaa');
      await markTopicUntrusted(db, me, 'tpc_second', 'umcp-aaaaaaaaaaaa');
      const raw = args({ prompt: 'общий' });
      const asked = await gate(raw);
      if (asked.action !== 'blocked') throw new Error('unreachable');
      await decideConfirmation(db, me, topicId, marker(asked.content).id, 'approve');

      const elsewhere = await gate(raw, IMAGE, 'tpc_second');
      expect(elsewhere).toMatchObject({ action: 'blocked', code: 'ARCKEP_CONFIRMATION_REQUIRED' });
      expect(await gate(raw)).toEqual({ action: 'proceed' });
    });

    it('чужая тема: подтвердить нельзя, запрос не виден', async () => {
      await markTopicUntrusted(db, me, topicId, 'umcp-aaaaaaaaaaaa');
      const asked = await gate(args({ prompt: 'мой' }));
      if (asked.action !== 'blocked') throw new Error('unreachable');
      const { id } = marker(asked.content);

      // другой человек той же темой и тем же номером запроса — 404, статус не меняется
      expect(await decideConfirmation(db, other, topicId, id, 'approve')).toMatchObject({
        ok: false,
        status: 404,
      });
      // и своя тема другого человека: такого запроса там нет
      expect(await decideConfirmation(db, other, 'tpc_theirs', id, 'approve')).toMatchObject({
        ok: false,
        status: 404,
      });
      expect((await readConfirmation(db, me, topicId, id))?.status).toBe('pending');
    });

    it('два параллельных повтора одобренного вызова: выполнится только один', async () => {
      await markTopicUntrusted(db, me, topicId, 'umcp-aaaaaaaaaaaa');
      const raw = args({ prompt: 'гонка' });
      const asked = await gate(raw);
      if (asked.action !== 'blocked') throw new Error('unreachable');
      await decideConfirmation(db, me, topicId, marker(asked.content).id, 'approve');

      const results = await Promise.all([gate(raw), gate(raw), gate(raw)]);
      expect(results.filter((result) => result.action === 'proceed')).toHaveLength(1);
      expect(results.filter((result) => result.action === 'blocked')).toHaveLength(2);
    });

    it('два параллельных первых вызова: один запрос, а не два', async () => {
      await markTopicUntrusted(db, me, topicId, 'umcp-aaaaaaaaaaaa');
      const raw = args({ prompt: 'пара' });
      const results = await Promise.all([gate(raw), gate(raw)]);
      expect(results.every((result) => result.action === 'blocked')).toBe(true);
      expect(Object.keys((await metadataOf())?.arckepConfirmations)).toHaveLength(1);
    });

    it('запись metadata целиком (как разбор памяти) метку не теряет: тему выдаёт история вызовов', async () => {
      await markTopicUntrusted(db, me, topicId, 'umcp-aaaaaaaaaaaa');
      await db.insert(messages).values({ id: 'msg_x', role: 'tool', topicId, userId: me });
      await db
        .insert(messagePlugins)
        .values({ id: 'msg_x', identifier: 'umcp-aaaaaaaaaaaa', type: 'mcp', userId: me });
      await db.update(topics).set({ metadata: { model: 'm1' } as any }).where(eq(topics.id, topicId));

      expect(await gate(args({ prompt: 'z' }))).toMatchObject({
        action: 'blocked',
        code: 'ARCKEP_CONFIRMATION_REQUIRED',
      });
    });
  });

  describe('вспомогательные', () => {
    it('канонический JSON: ключи по алфавиту на всех уровнях, массивы как есть', () => {
      expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 1 } })).toBe(
        '{"a":{"c":1,"d":[3,{"y":2,"z":1}]},"b":1}',
      );
      expect(hashToolArguments('{"b":1,"a":2}')).toBe(hashToolArguments('{"a":2,"b":1}'));
      expect(hashToolArguments('{"a":[1,2]}')).not.toBe(hashToolArguments('{"a":[2,1]}'));
      expect(hashToolArguments('')).toBe(hashToolArguments('{}'));
      // не JSON хешируется как есть и не падает
      expect(hashToolArguments('не json')).toMatch(/^[\da-f]{64}$/);
    });

    it('номер запроса: от подключения, инструмента и аргументов; сжатие описания до 300 знаков', () => {
      const hash = hashToolArguments('{"a":1}');
      expect(confirmationIdFor('x', 'create_image', hash)).toMatch(/^cfm_[\da-f]{20}$/);
      expect(confirmationIdFor('x', 'create_image', hash)).not.toBe(
        confirmationIdFor('x', 'create_video', hash),
      );

      const summary = summarizeToolCall(
        'create_video',
        JSON.stringify({
          duration: 8,
          model: 'veo-3',
          prompt: `закат\nнад морем ${'очень '.repeat(100)}`,
          resolution: '1080p',
        }),
      );
      expect(summary.startsWith('create_video, «закат над морем')).toBe(true);
      expect(summary).toContain('модель veo-3');
      expect(summary).toContain('8 с');
      expect(summary).not.toContain('\n');
      expect(summary.length).toBeLessThanOrEqual(300);
      expect(summarizeToolCall('create_image', 'не json')).toBe('create_image');
    });
  });
});
