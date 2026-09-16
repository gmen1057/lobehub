import type { LobeChatDatabase } from '@lobechat/database';
import { readFilePage } from '@lobechat/prompts';

import { MessageModel } from '@/database/models/message';
import { TopicModel } from '@/database/models/topic';

export interface TopicContextParams {
  mode?: 'summary' | 'archive';
  offset?: number;
  query?: string;
  snapshotAt?: string;
  topicId: string;
}

/** Same owner-scoped source access for browser tools and background agents. */
export async function getTopicContext(
  db: LobeChatDatabase,
  userId: string,
  params: TopicContextParams,
) {
  const topic = await new TopicModel(db, userId).findById(params.topicId);
  if (!topic) return { content: 'Topic not found', success: false };

  if (params.mode === 'archive') {
    const snapshot = params.snapshotAt ? new Date(params.snapshotAt) : new Date();
    if (!Number.isFinite(snapshot.getTime()))
      return {
        content: 'Invalid archive snapshotAt; use the value returned by the previous page.',
        success: false,
      };
    const snapshotAt = snapshot.toISOString();
    const originals = await db.query.messages.findMany({
      columns: { id: true, role: true, content: true },
      where: (fields, { and, eq, lte }) =>
        and(
          eq(fields.userId, userId),
          eq(fields.topicId, params.topicId),
          lte(fields.createdAt, snapshot),
        ),
      orderBy: (fields, { asc }) => [asc(fields.createdAt), asc(fields.id)],
    });
    const page = readFilePage(
      originals.map((message) => JSON.stringify(message)).join('\n'),
      params,
    );
    return {
      content:
        `Original conversation archive. ${JSON.stringify({ ...page, content: undefined, snapshotAt })}\n` +
        'Continue with getTopicContext(mode="archive", offset=nextOffset, snapshotAt=snapshotAt from this page). Keep this snapshot for all pages so new tool results do not enter the archive. Search hits are not exhaustive.\n' +
        page.content,
      success: true,
    };
  }

  const source =
    topic.historySummary ||
    (
      await new MessageModel(db, userId).query({
        agentId: topic.agentId ?? undefined,
        groupId: topic.groupId ?? undefined,
        topicId: params.topicId,
      })
    )
      .slice(-30)
      .map((message) => `${message.role}: ${message.content || ''}`)
      .join('\n\n');
  const page = readFilePage(source);
  return {
    content:
      `# Topic: ${topic.title || 'Untitled'}\n${page.content}\n` +
      `For exact earlier details use getTopicContext(topicId="${params.topicId}", mode="archive", query=literal text or offset=0).`,
    success: true,
  };
}
