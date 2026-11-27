import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TopicItem, UserItem } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';

import TopicsRoutes from '../../routes/topics.route';
import { TopicService } from '../topic.service';

const state = vi.hoisted(() => ({
  authType: 'arckep-service',
  db: undefined as unknown,
  log: vi.fn(),
  permission: vi.fn(),
}));

vi.mock('@/database/schemas', async () => {
  const { boolean, integer, jsonb, pgTable, text, timestamp } = await import('drizzle-orm/pg-core');
  const entity = (name: string) =>
    pgTable(name, {
      agentId: text('agent_id'),
      id: text('id'),
      sessionId: text('session_id'),
      slug: text('slug'),
      topicId: text('topic_id'),
      type: text('type'),
      userId: text('user_id'),
    });
  return {
    agents: entity('agents'),
    agentsToSessions: entity('agents_to_sessions'),
    messages: entity('messages'),
    sessions: entity('sessions'),
    topics: pgTable('topics', {
      agentId: text('agent_id'),
      createdAt: timestamp('created_at'),
      favorite: boolean('favorite'),
      groupId: text('group_id'),
      id: text('id'),
      metadata: jsonb('metadata'),
      sessionId: text('session_id'),
      title: text('title'),
      userId: text('user_id'),
    }),
    users: pgTable('users', { id: text('id'), sequence: integer('sequence') }),
  };
});

vi.mock('@/database/utils/idGenerator', () => ({ idGenerator: () => 'topic-1' }));
vi.mock('@/database/core/db-adaptor', () => ({ getServerDB: async () => state.db }));
vi.mock('@/database/models/rbac', () => ({ RbacModel: class {} }));
vi.mock('@/server/services/topic/compactTopic', () => ({
  compactTopic: vi.fn(),
  TopicCompactHttpError: class extends Error {},
}));
vi.mock('../engineSlotActivity', () => ({ hasInFlightResponseTopic: vi.fn() }));
vi.mock('../responsesStreamHub', () => ({ responsesStreamHub: {} }));
vi.mock('../../controllers', async () => await import('../../controllers/topic.controller'));
vi.mock('../../middleware', () => ({
  requireAuth: async (
    c: { set: (key: string, value: string) => void },
    next: () => Promise<void>,
  ) => {
    c.set('userId', 'reader');
    c.set('authType', state.authType);
    await next();
  },
}));
vi.mock('../../middleware/permission-check', () => ({
  requireAnyPermission: () => async (_c: unknown, next: () => Promise<void>) => await next(),
}));
vi.mock('../../common/base.service', () => ({
  BaseService: class {
    constructor(
      public db: unknown,
      public userId: string | null,
    ) {}
    createAuthorizationError(message: string) {
      return Object.assign(new Error(message), { name: 'AuthorizationError' });
    }
    createNotFoundError(message: string) {
      return Object.assign(new Error(message), { name: 'NotFoundError' });
    }
    handleServiceError(error: unknown): never {
      throw error;
    }
    log = state.log;
    resolveOperationPermission = state.permission;
  },
}));

const dialect = new PgDialect();
const query = (rows: unknown[], error?: Error) => {
  const result = () => (error ? Promise.reject(error) : Promise.resolve(rows));
  return Object.assign(Promise.resolve(rows), {
    from: vi.fn().mockReturnThis(),
    groupBy: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    limit: vi.fn(result),
    orderBy: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
  });
};

const topic = (overrides: Partial<TopicItem> = {}): TopicItem => ({
  accessedAt: new Date('2026-11-26T10:00:00Z'),
  agentId: null,
  clientId: null,
  content: null,
  createdAt: new Date('2026-11-26T10:00:00Z'),
  description: null,
  editorData: null,
  favorite: false,
  groupId: null,
  historySummary: 'Saved summary',
  id: 'topic-1',
  metadata: { model: 'saved-model', provider: 'saved-provider' },
  mode: null,
  sessionId: null,
  title: 'Saved topic',
  trigger: null,
  updatedAt: new Date('2026-11-26T10:00:00Z'),
  userId: 'owner',
  ...overrides,
});

const setup = (row: TopicItem | null, links: { agentId: string }[] = [], error?: Error) => {
  const user = { id: 'owner' } as UserItem;
  const rows = row ? [{ messageCount: 7, topic: row, user }] : [];
  const detail = query(rows);
  const binding = query(links, error);
  const db = { select: vi.fn().mockReturnValueOnce(detail).mockReturnValue(binding) };
  state.db = db;
  return { binding, db, detail, expected: { ...row, messageCount: 7, user } };
};

const getTopic = () => new Hono().route('/topics', TopicsRoutes).request('/topics/topic-1');
const getData = async () => {
  const response = await getTopic();
  expect(response.status).toBe(200);
  return (await response.json()).data;
};

describe('Arckép GET /topics/:id assistantBinding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.authType = 'arckep-service';
    state.permission.mockResolvedValue({ condition: { userId: 'owner' }, isPermitted: true });
  });

  it('returns a direct agent without an extra query and preserves every existing field', async () => {
    const { db, expected } = setup(topic({ agentId: 'project', sessionId: 'old-session' }));
    expect(await getData()).toEqual({
      ...(await Response.json(expected).json()),
      assistantBinding: { agentId: 'project', source: 'agent', version: 1 },
    });
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it.each(['first-session', 'second-migrated-session'])(
    'resolves the exact %s of a project without rewriting the legacy fields',
    async (sessionId) => {
      const { binding } = setup(topic({ sessionId }), [{ agentId: 'project' }]);
      const data = await getData();
      expect(data).toMatchObject({
        agentId: null,
        assistantBinding: { agentId: 'project', source: 'session', version: 1 },
        sessionId,
      });
      const where = dialect.sqlToQuery(binding.where.mock.calls[0][0] as SQL);
      expect(where.sql).toBe(
        '("agents_to_sessions"."session_id" = $1 and "agents_to_sessions"."user_id" = $2)',
      );
      expect(where.params).toEqual([sessionId, 'owner']);
      const joins = binding.innerJoin.mock.calls.map(([, on]) => dialect.sqlToQuery(on as SQL));
      expect(joins).toMatchObject([
        {
          params: ['owner'],
          sql: '("agents"."id" = "agents_to_sessions"."agent_id" and "agents"."user_id" = $1)',
        },
        {
          params: ['owner', 'agent'],
          sql: '("sessions"."id" = "agents_to_sessions"."session_id" and "sessions"."user_id" = $1 and "sessions"."type" = $2)',
        },
      ]);
    },
  );

  it('identifies a real inbox only when agent, session and group are absent', async () => {
    const { db } = setup(topic());
    expect((await getData()).assistantBinding).toEqual({
      agentId: null,
      source: 'inbox',
      version: 1,
    });
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it.each([null, 'group-supervisor'])(
    'keeps group topics and metadata readable, including supervisor %s',
    async (agentId) => {
      const { db, expected } = setup(
        topic({ agentId, groupId: 'group', sessionId: 'group-session' }),
      );
      expect(await getData()).toEqual({
        ...(await Response.json(expected).json()),
        assistantBinding: null,
      });
      expect(db.select).toHaveBeenCalledTimes(1);
    },
  );

  it('returns null for an unconfirmed, foreign-owner or non-agent session instead of inbox', async () => {
    setup(topic({ sessionId: 'unconfirmed-session' }), []);
    expect((await getData()).assistantBinding).toBeNull();
  });

  it('does not pick an arbitrary agent when the owner/session binding is ambiguous', async () => {
    const { binding } = setup(topic({ sessionId: 'shared-session' }), [
      { agentId: 'project-1' },
      { agentId: 'project-2' },
    ]);
    expect((await getData()).assistantBinding).toBeNull();
    expect(binding.limit).toHaveBeenCalledWith(2);
  });

  it('preserves readable metadata when the optional binding lookup fails', async () => {
    const error = new Error('session lookup unavailable');
    const { expected } = setup(topic({ sessionId: 'legacy-session' }), [], error);
    expect(await getData()).toEqual({
      ...(await Response.json(expected).json()),
      assistantBinding: null,
    });
    expect(state.log).toHaveBeenCalledWith('error', expect.any(String), { error });
  });

  it.each(['api-key', 'session', 'debug', ''])(
    'does not enrich other clients (%s)',
    async (authType) => {
      state.authType = authType;
      const { db } = setup(topic({ sessionId: 'legacy-session' }));
      expect(await getData()).not.toHaveProperty('assistantBinding');
      expect(db.select).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps the original service contract for create/update and other internal callers', async () => {
    const { db, expected } = setup(topic({ sessionId: 'legacy-session' }));
    const result = await new TopicService(db as unknown as LobeChatDatabase, 'reader').getTopicById(
      'topic-1',
    );
    expect(result).toEqual(expected);
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it('does not enrich the list response', async () => {
    const { db, expected } = setup(topic({ sessionId: 'legacy-session' }));
    db.select.mockReturnValueOnce(query([{ count: 1 }]));
    const response = await new Hono().route('/topics', TopicsRoutes).request('/topics');
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({
      topics: [await Response.json(expected).json()],
      total: 1,
    });
    expect(db.select).toHaveBeenCalledTimes(2);
  });

  it('preserves 403 for a forbidden topic without reading it or its binding', async () => {
    state.permission.mockResolvedValue({ isPermitted: false, message: 'Forbidden' });
    const { db } = setup(topic({ userId: 'another-owner' }));
    expect((await getTopic()).status).toBe(403);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('preserves 404 for a missing authorized topic and does not look up a binding', async () => {
    const { db } = setup(null);
    expect((await getTopic()).status).toBe(404);
    expect(db.select).toHaveBeenCalledTimes(1);
  });
});
