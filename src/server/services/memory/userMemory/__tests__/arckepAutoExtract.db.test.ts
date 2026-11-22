// @vitest-environment node
import type { LobeChatDatabase } from '@lobechat/database';
import { agents, messages, topics, users } from '@lobechat/database/schemas';
import { getTestDB } from '@lobechat/database/test-utils';
import { beforeEach, describe, expect, it } from 'vitest';

import { listAutoExtractTopics, listDigestTopics } from '../arckepAutoExtract';

const userId = 'auto-extract-filter-user';
const db: LobeChatDatabase = await getTestDB();

beforeEach(async () => {
  await db.delete(users);
  await db.insert(users).values({ id: userId });
});

const seedTopicWithMessages = async (params: {
  agentId?: string | null;
  id: string;
  metadata?: Record<string, unknown>;
  trigger?: string | null;
}) => {
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await db.insert(topics).values({
    agentId: params.agentId ?? null,
    createdAt: twoHoursAgo,
    id: params.id,
    metadata: params.metadata as any,
    title: params.id,
    trigger: params.trigger ?? null,
    updatedAt: twoHoursAgo,
    userId,
  });
  await db.insert(messages).values([
    {
      content: 'Hello',
      createdAt: twoHoursAgo,
      id: `${params.id}_u`,
      role: 'user',
      topicId: params.id,
      updatedAt: twoHoursAgo,
      userId,
    },
    {
      content: 'Hi',
      createdAt: twoHoursAgo,
      id: `${params.id}_a`,
      role: 'assistant',
      topicId: params.id,
      updatedAt: twoHoursAgo,
      userId,
    },
  ]);
};

describe('arckepAutoExtract SQL topic filtering (Data Guard, project memory=false, untrusted, cron, excludeTopicIds)', () => {
  it('excludes disabled-memory projects, dataGuardProtected, arckepUntrusted (object & boolean), cron topics, and excludeTopicIds', async () => {
    const [enabledAgent] = await db
      .insert(agents)
      .values({
        chatConfig: { memory: { enabled: true } } as any,
        title: 'Enabled project',
        userId,
      })
      .returning();
    const [disabledAgent] = await db
      .insert(agents)
      .values({
        chatConfig: { memory: { enabled: false } } as any,
        title: 'Disabled memory project',
        userId,
      })
      .returning();

    await seedTopicWithMessages({ agentId: enabledAgent.id, id: 'tpc_allowed_agent' });
    await seedTopicWithMessages({ id: 'tpc_allowed_inbox' });
    await seedTopicWithMessages({ agentId: disabledAgent.id, id: 'tpc_disabled_agent' });
    await seedTopicWithMessages({
      id: 'tpc_data_guard_meta',
      metadata: { dataGuardProtected: true },
    });
    await seedTopicWithMessages({
      id: 'tpc_untrusted_obj',
      metadata: { arckepUntrusted: { identifier: 'umcp-ext', since: '2026-11-22T00:00:00Z' } },
    });
    await seedTopicWithMessages({
      id: 'tpc_untrusted_bool',
      metadata: { arckepUntrusted: true },
    });
    await seedTopicWithMessages({ id: 'tpc_cron', trigger: 'cron' });
    await seedTopicWithMessages({ id: 'tpc_vault_excluded' });

    const digestSelected = await listDigestTopics(db, userId, {
      days: 30,
      excludeTopicIds: ['tpc_vault_excluded'],
      idleMinutes: 60,
      maxTopics: 50,
    });
    expect(digestSelected.map((t) => t.topicId).sort()).toEqual([
      'tpc_allowed_agent',
      'tpc_allowed_inbox',
    ]);

    const autoSelected = await listAutoExtractTopics(db, userId, {
      days: 30,
      excludeTopicIds: ['tpc_vault_excluded'],
      idleMinutes: 30,
      limit: 50,
    });
    expect(autoSelected.sort()).toEqual(['tpc_allowed_agent', 'tpc_allowed_inbox']);
  });
});
