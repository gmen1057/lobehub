import type { GetTopicContextParams } from '@lobechat/builtin-tool-topic-reference/executor';
import { rewriteStoredMessageContentForLLM } from '@lobechat/context-engine';
import type { LobeChatDatabase } from '@lobechat/database';
import { readFilePage } from '@lobechat/prompts';

import { MessageModel } from '@/database/models/message';
import { TopicModel } from '@/database/models/topic';
import { messagePlugins } from '@/database/schemas';

import { readCodeArtifacts } from './codeArtifacts';

export type TopicContextParams = GetTopicContextParams;

const SANITIZED_HISTORY_ROLES = new Set(['assistant', 'compressedGroup', 'supervisor']);

const sanitizeHistoryContent = (role: string, content: string | null | undefined): string => {
  if (!content) return '';
  if (!SANITIZED_HISTORY_ROLES.has(role)) return content;
  return String(rewriteStoredMessageContentForLLM(content) ?? '');
};

/** Same owner-scoped source access for browser tools and background agents. */
export async function getTopicContext(
  db: LobeChatDatabase,
  userId: string,
  params: TopicContextParams,
  includeTextFiles = true,
) {
  const topic = await new TopicModel(db, userId).findById(params.topicId);
  if (!topic) return { content: 'Topic not found', success: false };

  if (params.mode === 'code_artifacts')
    return readCodeArtifacts(db, userId, params, includeTextFiles);

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
      where: (fields, { and, eq, lte, notExists }) =>
        and(
          eq(fields.userId, userId),
          eq(fields.topicId, params.topicId),
          lte(fields.createdAt, snapshot),
          // Archive pages and summaries are derived from this history. Reading
          // them back recursively multiplies escaped copies of earlier pages.
          notExists(
            db
              .select({ id: messagePlugins.id })
              .from(messagePlugins)
              .where(
                and(
                  eq(messagePlugins.id, fields.id),
                  eq(messagePlugins.userId, userId),
                  eq(fields.role, 'tool'),
                  eq(messagePlugins.identifier, 'lobe-topic-reference'),
                  eq(messagePlugins.apiName, 'getTopicContext'),
                ),
              ),
          ),
        ),
      orderBy: (fields, { asc }) => [asc(fields.createdAt), asc(fields.id)],
    });
    const page = readFilePage(
      originals
        .map((message) =>
          JSON.stringify(
            SANITIZED_HISTORY_ROLES.has(message.role) && typeof message.content === 'string'
              ? { ...message, content: sanitizeHistoryContent(message.role, message.content) }
              : message,
          ),
        )
        .join('\n'),
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
    (topic.historySummary
      ? String(rewriteStoredMessageContentForLLM(topic.historySummary) ?? '')
      : '') ||
    (
      await new MessageModel(db, userId).query({
        agentId: topic.agentId ?? undefined,
        groupId: topic.groupId ?? undefined,
        topicId: params.topicId,
      })
    )
      .slice(-30)
      .map((message) => `${message.role}: ${sanitizeHistoryContent(message.role, message.content)}`)
      .join('\n\n');
  const page = readFilePage(source);
  return {
    content:
      `# Topic: ${topic.title || 'Untitled'}\n${page.content}\n` +
      `For exact earlier details use getTopicContext(topicId="${params.topicId}", mode="archive", query=literal text or offset=0).`,
    success: true,
  };
}
