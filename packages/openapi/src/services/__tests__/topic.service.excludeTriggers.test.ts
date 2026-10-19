import { zValidator } from '@hono/zod-validator';
import { PgDialect } from 'drizzle-orm/pg-core';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TopicListQuerySchema } from '../../types/topic.type';
import { TopicService } from '../topic.service';

// arckep (19.10.2026, задачи помощника по расписанию): `GET /api/v1/topics?excludeTriggers=cron` не теряет
// переписки без источника (trigger IS NULL) и принимает одно значение, список через запятую и повтор ключа.

vi.mock('@/database/schemas', async () => {
  const { boolean, pgTable: table, text: col, timestamp } = await import('drizzle-orm/pg-core');
  const topics = table('topics', {
    agentId: col('agent_id'),
    createdAt: timestamp('created_at'),
    favorite: boolean('favorite'),
    groupId: col('group_id'),
    id: col('id'),
    sessionId: col('session_id'),
    title: col('title'),
    trigger: col('trigger'),
    userId: col('user_id'),
  });
  const mk = (name: string) =>
    table(name, {
      agentId: col('agent_id'),
      id: col('id'),
      sessionId: col('session_id'),
      slug: col('slug'),
      topicId: col('topic_id'),
      userId: col('user_id'),
    });
  return {
    agents: mk('agents'),
    agentsToSessions: mk('agents_to_sessions'),
    messages: mk('messages'),
    topics,
    users: mk('users'),
  };
});

vi.mock('@/database/utils/idGenerator', () => ({ idGenerator: () => 'id' }));

vi.mock('../../common/base.service', () => ({
  BaseService: class {
    db: unknown;
    userId: string;
    constructor(db: unknown, userId: string | null) {
      this.db = db;
      this.userId = userId || '';
    }
    createAuthorizationError(message: string) {
      return new Error(message);
    }
    handleServiceError(error: unknown): never {
      throw error;
    }
    async resolveOperationPermission() {
      return { condition: { userId: 'user-1' }, isPermitted: true };
    }
  },
}));

const dialect = new PgDialect();

/** Запись условия where у запросов списка и счётчика. */
const fakeDb = () => {
  const wheres: unknown[] = [];
  const builder = (rows: unknown[]) => {
    const proxy: any = new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (prop === 'then') {
            return (resolve: (value: unknown[]) => unknown) => resolve(rows);
          }
          if (prop === 'where') {
            return (expr: unknown) => {
              wheres.push(expr);
              return proxy;
            };
          }
          return () => proxy;
        },
      },
    );
    return proxy;
  };
  const db = {
    select: (fields?: Record<string, unknown>) =>
      builder(fields && 'count' in fields && !('topic' in fields) ? [{ count: 0 }] : []),
  };
  return { db, wheres };
};

const renderWhere = async (query: Record<string, unknown>) => {
  const { db, wheres } = fakeDb();
  await new TopicService(db as any, 'user-1').getTopics(query as any);
  return dialect.sqlToQuery(wheres[0] as any);
};

describe('TopicService.getTopics — excludeTriggers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('условие оставляет переписки с trigger IS NULL и убирает перечисленные источники', async () => {
    const { params, sql } = await renderWhere({ excludeTriggers: ['cron'] });

    expect(sql).toContain('"topics"."trigger" is null');
    expect(sql).toContain('"topics"."trigger" not in (');
    expect(sql).toMatch(/\("topics"\."trigger" is null or "topics"."trigger" not in \(\$\d+\)\)/);
    expect(params).toContain('cron');
  });

  it('несколько источников', async () => {
    const { params, sql } = await renderWhere({ excludeTriggers: ['cron', 'eval'] });

    expect(sql).toMatch(/"topics"."trigger" is null or "topics"."trigger" not in \(\$\d+, \$\d+\)/);
    expect(params).toEqual(expect.arrayContaining(['cron', 'eval']));
  });

  it('без excludeTriggers условия по источнику нет', async () => {
    const { sql } = await renderWhere({});
    expect(sql).not.toContain('trigger');

    const empty = await renderWhere({ excludeTriggers: [] });
    expect(empty.sql).not.toContain('trigger');
  });

  it('условие по источнику не отменяет остальные', async () => {
    const { sql } = await renderWhere({ excludeTriggers: ['cron'], keyword: 'отчёт' });

    expect(sql).toContain('"topics"."user_id" = $1');
    expect(sql).toContain('"topics"."trigger" is null');
    expect(sql).toContain('ilike');
  });
});

describe('TopicListQuerySchema.excludeTriggers (query-строка)', () => {
  const parse = (query: string) => {
    const app = new Hono();
    let seen: any;
    app.get('/', zValidator('query', TopicListQuerySchema), (c) => {
      seen = (c.req as any).valid('query');
      return c.json({ ok: true });
    });
    return app.request(`/${query}`).then((res) => ({ seen, status: res.status }));
  };

  it('одно значение — массив из одного источника', async () => {
    const { seen, status } = await parse('?excludeTriggers=cron');
    expect(status).toBe(200);
    expect(seen.excludeTriggers).toEqual(['cron']);
  });

  it('через запятую и повтор ключа', async () => {
    expect((await parse('?excludeTriggers=cron,eval')).seen.excludeTriggers).toEqual(['cron', 'eval']);
    expect((await parse('?excludeTriggers=cron&excludeTriggers=eval')).seen.excludeTriggers).toEqual([
      'cron',
      'eval',
    ]);
    expect((await parse('?excludeTriggers=%20cron%20,,eval')).seen.excludeTriggers).toEqual([
      'cron',
      'eval',
    ]);
  });

  it('пустое значение — без фильтра; параметра нет — undefined', async () => {
    expect((await parse('?excludeTriggers=')).seen.excludeTriggers).toEqual([]);
    expect((await parse('')).seen.excludeTriggers).toBeUndefined();
  });

  it('старые запросы и неизвестные параметры не ломаются', async () => {
    const { seen, status } = await parse('?agentId=agt_1&isInbox=true&pageSize=20&page=2&future=1');
    expect(status).toBe(200);
    expect(seen.agentId).toBe('agt_1');
    expect(seen.isInbox).toBe(true);
    expect(seen).not.toHaveProperty('future');
  });
});
