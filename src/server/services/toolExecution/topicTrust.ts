import { createHash } from 'node:crypto';

import { ARCKEP_CONFIRM_MARKER, isArckepUserMcpId } from '@lobechat/builtin-tools';
import { and, eq, sql } from 'drizzle-orm';

import { messagePlugins, messages, topics } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';

/**
 * arckep (19.10.2026, этап 3 «свои инструменты», п. 3.Д): метка темы «в ней работает чужой инструмент» и
 * подтверждение человеком платных запусков студии в такой теме. Всё хранится в `topics.metadata`:
 *
 *   arckepUntrusted:     { since, identifier }
 *   arckepConfirmations: { [id]: { id, tool, identifier, argsHash, status, createdAt, decidedAt? } }
 *
 * Обновления — один UPDATE на `jsonb_set` по строке темы (а не «прочитал, слил, записал», как
 * `TopicModel.updateMetadata`): два параллельных вызова не теряют записи друг друга. Переходы состояния
 * запроса идут сравнением с прежним значением (`swapConfirmation`): выигрывает один.
 *
 * Идентификатор запроса детерминирован — `cfm_` + хеш (подключение, инструмент, sha256 аргументов): на один
 * вызов не бывает двух живых запросов, повторный вызов находит тот же. Живёт запрос 15 минут: ожидающий — от
 * создания, решённый — от решения.
 */

export const CONFIRMATION_TTL_MS = 15 * 60 * 1000;
/** Старше этого (от создания или решения) записи убираются при следующем запросе */
const CONFIRMATION_KEEP_MS = 24 * 60 * 60 * 1000;
const SUMMARY_LIMIT = 300;

export type ConfirmationStatus = 'approved' | 'consumed' | 'pending' | 'rejected';

export interface TopicConfirmation {
  argsHash: string;
  createdAt: string;
  decidedAt?: string;
  id: string;
  identifier: string;
  status: ConfirmationStatus;
  tool: string;
}

interface TopicMetadataShape {
  arckepConfirmations?: Record<string, TopicConfirmation>;
  arckepUntrusted?: { identifier?: string; since?: string };
}

/** metadata как объект: пустая или не-объект (JSON null) читается как `{}`. */
// Функция, а не константа: схема читается при вызове, а не при импорте модуля (тесты маршрутов подменяют её).
const baseMetadata = () =>
  sql`(CASE WHEN jsonb_typeof(${topics.metadata}) = 'object' THEN ${topics.metadata} ELSE '{}'::jsonb END)`;

const topicWhere = (userId: string, topicId: string) =>
  and(eq(topics.id, topicId), eq(topics.userId, userId));

const readMetadata = async (
  db: LobeChatDatabase,
  userId: string,
  topicId: string,
): Promise<TopicMetadataShape | undefined> => {
  const [row] = await db
    .select({ metadata: topics.metadata })
    .from(topics)
    .where(topicWhere(userId, topicId))
    .limit(1);
  if (!row) return undefined;
  const metadata = row.metadata as unknown;
  return metadata && typeof metadata === 'object' ? (metadata as TopicMetadataShape) : {};
};

/**
 * Пометить тему: в ней работает чужой инструмент. Первая метка остаётся (`since`, `identifier` не
 * перезаписываются). Возвращает false, если темы нет или она не этого человека. `updated_at` не трогаем —
 * тема не должна всплывать в списке.
 */
export const markTopicUntrusted = async (
  db: LobeChatDatabase,
  userId: string,
  topicId: string,
  identifier: string,
): Promise<boolean> => {
  const fresh = JSON.stringify({ identifier, since: new Date().toISOString() });
  const rows = await db
    .update(topics)
    .set({
      metadata: sql`jsonb_set(${baseMetadata()}, '{arckepUntrusted}', COALESCE(${baseMetadata()}->'arckepUntrusted', ${fresh}::jsonb), true)`,
    })
    .where(topicWhere(userId, topicId))
    .returning({ id: topics.id });
  return rows.length > 0;
};

/**
 * Описания и схемы инструментов чужого сервера попадают к модели уже при подключении инструмента (шаг
 * `activateTools` или включение на сообщение), а не только при вызове, — и могут содержать чужие указания.
 * Поэтому тема помечается, как только среди подключённых инструментов есть свой `umcp-*`. Отказ закрывающий:
 * не удалось пометить — исключение, и инструмент не подключается (activateTools вернёт ошибку модели, execAgent
 * не начнёт ответ): без метки платный запуск по чужому указанию прошёл бы без подтверждения. Нет базы, человека
 * или темы — помечать нечего (и платных запусков в такой операции нет), это не отказ.
 */
export const markTopicIfUserMcp = async (
  db: LobeChatDatabase | undefined,
  userId: string | undefined,
  topicId: string | undefined,
  identifiers: readonly string[],
): Promise<void> => {
  const identifier = identifiers.find((id) => isArckepUserMcpId(id));
  if (!identifier || !db || !userId || !topicId) return;
  try {
    if (!(await markTopicUntrusted(db, userId, topicId, identifier))) {
      throw new Error('topic not found');
    }
  } catch (error) {
    console.error('[arckep] marking topic for user MCP failed:', error);
    throw new Error('Не удалось подготовить чат к чужому инструменту, повторите.', { cause: error });
  }
};

/**
 * В теме работает чужой инструмент? Два источника: метка в metadata темы и история темы — вызов `umcp-*` или шаг
 * `activateTools`, подключивший такой инструмент (`pluginState.activatedTools`). История страхует от потери
 * метки: другие записи metadata (разбор памяти) перезаписывают объект целиком по снимку, и метка могла пропасть.
 * Платные вызовы редкие, лишний запрос по теме им не мешает.
 */
export const isTopicUntrusted = async (
  db: LobeChatDatabase,
  userId: string,
  topicId: string,
): Promise<boolean> => {
  const metadata = await readMetadata(db, userId, topicId);
  if (metadata?.arckepUntrusted) return true;

  const [used] = await db
    .select({ id: messagePlugins.id })
    .from(messagePlugins)
    .innerJoin(messages, eq(messages.id, messagePlugins.id))
    .where(
      and(
        eq(messages.topicId, topicId),
        eq(messages.userId, userId),
        sql`(${messagePlugins.identifier} LIKE 'umcp-%' OR (${messagePlugins.identifier} IN ('lobe-activator', 'lobe-tools') AND jsonb_path_exists(${messagePlugins.state}, '$.activatedTools[*] ? (@.identifier like_regex "^umcp-")')))`,
      ),
    )
    .limit(1);
  return Boolean(used);
};

// ---------------------------------------------------------------- запросы подтверждения

/** Канонический JSON: ключи по алфавиту на всех уровнях, массивы как есть. */
export const canonicalJson = (value: unknown): string => {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map((entry) => normalize(entry));
    if (item && typeof item === 'object') {
      return Object.fromEntries(
        Object.keys(item as Record<string, unknown>)
          .sort()
          .map((key) => [key, normalize((item as Record<string, unknown>)[key])]),
      );
    }
    return item;
  };
  return JSON.stringify(normalize(value ?? {}));
};

/** sha256 канонического JSON аргументов; нечитаемые аргументы (не JSON) хешируются как есть. */
export const hashToolArguments = (rawArguments: unknown): string => {
  let parsed: unknown = rawArguments;
  if (typeof rawArguments === 'string') {
    try {
      parsed = rawArguments.trim() ? JSON.parse(rawArguments) : {};
    } catch {
      return createHash('sha256').update(`raw:${rawArguments}`).digest('hex');
    }
  }
  return createHash('sha256').update(canonicalJson(parsed)).digest('hex');
};

export const confirmationIdFor = (identifier: string, tool: string, argsHash: string): string =>
  `cfm_${createHash('sha256').update(`${identifier}\n${tool}\n${argsHash}`).digest('hex').slice(0, 20)}`;

const isoMs = (value?: string): number => {
  const ms = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ms) ? ms : 0;
};

/** Запрос ещё действует: не использован, не старше 15 минут (от создания или от решения). */
export const isConfirmationLive = (entry: TopicConfirmation, now = Date.now()): boolean =>
  entry.status !== 'consumed' &&
  now - isoMs(entry.decidedAt ?? entry.createdAt) < CONFIRMATION_TTL_MS;

export const readConfirmation = async (
  db: LobeChatDatabase,
  userId: string,
  topicId: string,
  id: string,
): Promise<TopicConfirmation | null> => {
  const metadata = await readMetadata(db, userId, topicId);
  const entry = metadata?.arckepConfirmations?.[id];
  return entry && typeof entry === 'object' ? entry : null;
};

/**
 * Заменить запрос `id` с `prev` на `next`, если он за это время не менялся (`prev === null` — записи ещё нет).
 * Один UPDATE: сравнение и запись под одной блокировкой строки, проигравший получает false и перечитывает.
 * Заодно убираются записи старше суток.
 */
export const swapConfirmation = async (
  db: LobeChatDatabase,
  userId: string,
  topicId: string,
  id: string,
  prev: TopicConfirmation | null,
  next: TopicConfirmation,
): Promise<boolean> => {
  const cutoff = new Date(Date.now() - CONFIRMATION_KEEP_MS).toISOString();
  const prevJson = prev ? JSON.stringify(prev) : null;
  const nextJson = JSON.stringify(next);
  const pruned = sql`COALESCE((SELECT jsonb_object_agg(e.key, e.value) FROM jsonb_each(COALESCE(${baseMetadata()}->'arckepConfirmations', '{}'::jsonb)) AS e WHERE COALESCE(e.value->>'decidedAt', e.value->>'createdAt') > ${cutoff}), '{}'::jsonb)`;
  const rows = await db
    .update(topics)
    .set({
      metadata: sql`jsonb_set(jsonb_set(${baseMetadata()}, '{arckepConfirmations}', ${pruned}, true), ARRAY['arckepConfirmations', ${id}::text], ${nextJson}::jsonb, true)`,
    })
    .where(
      and(
        topicWhere(userId, topicId),
        sql`(${baseMetadata()}->'arckepConfirmations'->${id}::text) IS NOT DISTINCT FROM ${prevJson}::jsonb`,
      ),
    )
    .returning({ id: topics.id });
  return rows.length > 0;
};

export type ConfirmationDecision =
  | { ok: true; status: 'approved' | 'rejected' }
  | { message: string; ok: false; status: 404 | 409 | 410 };

/**
 * Решение человека по запросу (REST `POST /api/v1/arckep/topics/:topicId/confirmations/:id`). Проверку
 * владельца темы делает вызывающий; здесь все запросы всё равно ограничены `user_id` темы. Повторное то же
 * решение — не ошибка (двойной щелчок), другое решение по уже решённому — 409.
 */
export const decideConfirmation = async (
  db: LobeChatDatabase,
  userId: string,
  topicId: string,
  id: string,
  action: 'approve' | 'reject',
): Promise<ConfirmationDecision> => {
  const wanted = action === 'approve' ? 'approved' : 'rejected';

  for (let attempt = 0; attempt < 3; attempt++) {
    const entry = await readConfirmation(db, userId, topicId, id);
    if (!entry) return { message: 'Запрос подтверждения не найден', ok: false, status: 404 };
    if (entry.status === 'consumed') {
      return { message: 'Этот запуск уже выполнен', ok: false, status: 409 };
    }
    if (!isConfirmationLive(entry)) {
      return {
        message: 'Запрос устарел (больше 15 минут). Повторите действие в чате',
        ok: false,
        status: 410,
      };
    }
    if (entry.status !== 'pending') {
      if (entry.status === wanted) return { ok: true, status: wanted };
      return { message: 'По этому запросу уже принято решение', ok: false, status: 409 };
    }
    const next: TopicConfirmation = {
      ...entry,
      decidedAt: new Date().toISOString(),
      status: wanted,
    };
    if (await swapConfirmation(db, userId, topicId, id, entry, next)) {
      return { ok: true, status: wanted };
    }
    // кто-то изменил запрос между чтением и записью — читаем заново
  }
  return { message: 'Запрос изменился, повторите', ok: false, status: 409 };
};

// ---------------------------------------------------------------- ворота платных запусков

export interface GateToolCall {
  apiName: string;
  /** Аргументы вызова как пришли от модели (JSON-строка) */
  arguments: unknown;
  identifier: string;
}

export type GateResult =
  /** выполнять: тема своя без чужих инструментов либо одобрение найдено и погашено */
  | { action: 'proceed' }
  /** не выполнять: текст уходит модели */
  | { action: 'blocked'; code: string; content: string };

const oneLine = (value: string, limit: number) => value.replaceAll(/\s+/g, ' ').trim().slice(0, limit);

const scalar = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim()
    ? oneLine(value, 140)
    : typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : undefined;

const firstOf = (args: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    const found = scalar(args[key]);
    if (found) return { key, value: found };
  }
  return undefined;
};

/**
 * Человеческое описание вызова для карточки подтверждения: инструмент и главное из аргументов (промпт,
 * модель, длительность), до 300 знаков. Аргументы пишет модель — текст идёт на экран человеку как есть, без
 * переводов строк; разметка не нужна, это строка.
 */
export const summarizeToolCall = (tool: string, rawArguments: unknown): string => {
  let args: Record<string, unknown> = {};
  if (typeof rawArguments === 'string') {
    try {
      const parsed = JSON.parse(rawArguments);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed;
    } catch {
      // нечитаемые аргументы — описание без них
    }
  } else if (rawArguments && typeof rawArguments === 'object' && !Array.isArray(rawArguments)) {
    args = rawArguments as Record<string, unknown>;
  }

  const used = new Set<string>();
  const parts: string[] = [tool];
  const take = (keys: string[], format: (value: string) => string) => {
    const found = firstOf(args, keys);
    if (!found) return;
    used.add(found.key);
    parts.push(format(found.value));
  };
  take(['prompt', 'text', 'input', 'query', 'message', 'description'], (value) => `«${value}»`);
  take(['model', 'model_id'], (value) => `модель ${value}`);
  take(['duration', 'duration_seconds', 'seconds'], (value) => `${value} с`);
  take(['resolution', 'aspect_ratio'], (value) => value);
  take(['num_images', 'count', 'n'], (value) => `${value} шт.`);
  for (const key of Object.keys(args)) {
    if (parts.length >= 8) break;
    if (used.has(key)) continue;
    const value = scalar(args[key]);
    if (value) parts.push(`${key}: ${value.slice(0, 40)}`);
  }
  return oneLine(parts.join(', '), SUMMARY_LIMIT);
};

const needConfirmationText = (entry: TopicConfirmation, summary: string) =>
  [
    `Нужно подтверждение человека: «${entry.tool}» — платный запуск, а в этой теме работает чужой инструмент. Вызов НЕ выполнен.`,
    'Скажи человеку одной фразой, что нужно нажать «Подтвердить», дождись его ответа и повтори вызов с теми же параметрами.',
    `${ARCKEP_CONFIRM_MARKER} ${JSON.stringify({ id: entry.id, summary, tool: entry.tool })}`,
  ].join('\n');

const rejectedText = (entry: TopicConfirmation) =>
  `Человек отказался от запуска «${entry.tool}». Вызов НЕ выполнен. Не повторяй его с теми же параметрами, спроси человека, что делать дальше.`;

/**
 * Ворота платных запусков студии в теме с чужим инструментом (п. 3.Д). Не платный инструмент или тема без
 * метки — сразу `proceed`. Иначе:
 *  1. одобренный живой запрос на тот же инструмент и те же аргументы гасится (один вызов) → `proceed`;
 *  2. ожидающий — модель снова получает просьбу подождать человека;
 *  3. отклонённый (в пределах 15 минут) — отказ;
 *  4. иначе создаётся новый ожидающий запрос.
 * Сбой базы — отказ, а не «выполнить»: без проверки платный запуск не пропускаем.
 */
export const gatePaidToolCall = async (
  db: LobeChatDatabase,
  userId: string,
  topicId: string,
  call: GateToolCall,
): Promise<GateResult> => {
  const tool = call.apiName;
  const argsHash = hashToolArguments(call.arguments);
  const id = confirmationIdFor(call.identifier, tool, argsHash);

  try {
    if (!(await isTopicUntrusted(db, userId, topicId))) return { action: 'proceed' };

    for (let attempt = 0; attempt < 3; attempt++) {
      const entry = await readConfirmation(db, userId, topicId, id);

      if (entry && isConfirmationLive(entry)) {
        if (entry.status === 'approved') {
          const consumed: TopicConfirmation = { ...entry, status: 'consumed' };
          if (await swapConfirmation(db, userId, topicId, id, entry, consumed)) {
            return { action: 'proceed' };
          }
          continue; // другой вызов погасил раньше — перечитаем
        }
        if (entry.status === 'rejected') {
          return { action: 'blocked', code: 'ARCKEP_CONFIRMATION_REJECTED', content: rejectedText(entry) };
        }
        return {
          action: 'blocked',
          code: 'ARCKEP_CONFIRMATION_REQUIRED',
          content: needConfirmationText(entry, summarizeToolCall(tool, call.arguments)),
        };
      }

      const fresh: TopicConfirmation = {
        argsHash,
        createdAt: new Date().toISOString(),
        id,
        identifier: call.identifier,
        status: 'pending',
        tool,
      };
      if (await swapConfirmation(db, userId, topicId, id, entry, fresh)) {
        return {
          action: 'blocked',
          code: 'ARCKEP_CONFIRMATION_REQUIRED',
          content: needConfirmationText(fresh, summarizeToolCall(tool, call.arguments)),
        };
      }
    }
  } catch (error) {
    console.error('[arckep] confirmation gate failed:', error);
  }
  return {
    action: 'blocked',
    code: 'ARCKEP_CONFIRMATION_UNAVAILABLE',
    content:
      'Не удалось проверить подтверждение платного запуска. Вызов НЕ выполнен. Скажи человеку, что запуск не удался, и предложи повторить позже.',
  };
};
