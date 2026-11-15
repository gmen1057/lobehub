import { DEFAULT_AGENT_CONFIG } from '@lobechat/const';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { agents, agentsToSessions, sessions, users } from '../../schemas';
import { SessionModel } from '../session';

// This regression is strictly offline. Never opt it into the network/server test database.
if (process.env.TEST_SERVER_DB === '1') throw new Error('Inbox regression requires local PGlite');
const db = await getTestDB();
const userId = 'offline-inbox-defaults';
const model = new SessionModel(db, userId);
const plugins = [
  ...(DEFAULT_AGENT_CONFIG.plugins ?? []),
  'mcp-arckep-studio-images',
  'mcp-arckep-studio-documents',
  'mcp-arckep-e2b-sandbox',
];
const storedAgents = () => db.select().from(agents).where(eq(agents.userId, userId));

beforeEach(async () => {
  await db.insert(users).values({ id: userId });
});
afterEach(async () => {
  await db.delete(users).where(eq(users.id, userId));
});

describe('inbox selection persisted on first insert', () => {
  it('persists all defaults alongside the actual nonempty builtin seed', async () => {
    await model.createInbox({ plugins });
    expect((await storedAgents())[0].plugins).toEqual(plugins);
    expect(
      await db.select().from(agentsToSessions).where(eq(agentsToSessions.userId, userId)),
    ).toHaveLength(1);
  });

  it('replaces builtin defaults with an explicit [] in the stored agent', async () => {
    await model.createInbox({ plugins: [] });
    expect((await storedAgents())[0].plugins).toEqual([]);
  });

  it('keeps existing disabled/custom inbox choices and ordinary custom agents untouched', async () => {
    await model.create({ config: { plugins: ['custom-agent-tool'] }, type: 'agent' });
    await model.createInbox({ plugins: [] });
    await model.createInbox({ plugins });
    expect((await storedAgents()).map((agent) => agent.plugins)).toEqual([
      ['custom-agent-tool'],
      [],
    ]);
  });

  it('is idempotent under concurrent first creation and leaves exactly one linked agent', async () => {
    await Promise.all([model.createInbox({ plugins }), model.createInbox({ plugins })]);
    expect(await storedAgents()).toHaveLength(1);
    expect((await storedAgents())[0].plugins).toEqual(plugins);
    expect(await db.select().from(sessions).where(eq(sessions.userId, userId))).toHaveLength(1);
    expect(
      await db.select().from(agentsToSessions).where(eq(agentsToSessions.userId, userId)),
    ).toHaveLength(1);
  });
});
