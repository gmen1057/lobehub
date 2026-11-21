import type { LobeChatDatabase } from '@lobechat/database';
import { readFilePage } from '@lobechat/prompts';
import { and, desc, eq, exists, sql } from 'drizzle-orm';

import { files, messages } from '@/database/schemas';
import { FileService } from '@/server/services/file';

import type { TopicContextParams } from './index';

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const VERSION_PAGE_SIZE = 12;

function ownedCodeArtifacts(db: LobeChatDatabase, userId: string, topicId: string) {
  return and(
    eq(files.userId, userId),
    sql`starts_with(${files.url}, ${`files/${userId}/code-artifacts/${topicId}/`})`,
    sql`${files.metadata}->'codeArtifact'->>'topicId' = ${topicId}`,
    // Keep versions whose assistant answer was saved, including messages in a compressed group.
    exists(
      db
        .select({ id: messages.id })
        .from(messages)
        .where(
          and(
            eq(messages.userId, userId),
            eq(messages.topicId, topicId),
            eq(messages.role, 'assistant'),
            sql`${messages.id} = ${files.metadata}->'codeArtifact'->>'messageId'`,
            sql`strpos(${messages.content}, '/chat/code-artifact/' || ${files.id} || '/') > 0`,
          ),
        ),
    ),
  );
}

export async function topicHasCodeArtifacts(db: LobeChatDatabase, userId: string, topicId: string) {
  const [row] = await db
    .select({ id: files.id })
    .from(files)
    .where(ownedCodeArtifacts(db, userId, topicId))
    .limit(1);
  return Boolean(row);
}

export async function readCodeArtifacts(
  db: LobeChatDatabase,
  userId: string,
  { fileId, offset, query, topicId }: TopicContextParams,
) {
  const scope = ownedCodeArtifacts(db, userId, topicId);
  if (!fileId) {
    const start = Number.isSafeInteger(offset) && offset! >= 0 ? offset! : 0;
    const rows = await db
      .select({
        createdAt: files.createdAt,
        fileId: files.id,
        identifier: sql<string>`${files.metadata}->'codeArtifact'->>'identifier'`,
        language: sql<string>`${files.metadata}->'codeArtifact'->>'language'`,
        title: sql<string>`${files.metadata}->'codeArtifact'->>'title'`,
      })
      .from(files)
      .where(scope)
      .orderBy(desc(files.createdAt), desc(files.id))
      .offset(start)
      .limit(VERSION_PAGE_SIZE + 1);
    return {
      content: JSON.stringify({
        nextOffset: rows.length > VERSION_PAGE_SIZE ? start + VERSION_PAGE_SIZE : null,
        versions: rows.slice(0, VERSION_PAGE_SIZE),
      }),
      success: true,
    };
  }

  const [file] = await db
    .select({ key: files.url, size: files.size })
    .from(files)
    .where(and(scope, eq(files.id, fileId)))
    .limit(1);
  if (!file || file.size > MAX_SOURCE_BYTES) {
    return { content: 'Code artifact version not found in this topic.', success: false };
  }

  const bytes = await new FileService(db, userId).getFileByteArray(file.key);
  if (bytes.byteLength > MAX_SOURCE_BYTES) {
    return { content: 'Code artifact source exceeds the file limit.', success: false };
  }
  const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const { content, ...page } = readFilePage(source, { offset, query });
  return {
    content: `${JSON.stringify({ fileId, ...page })}\n${content}`,
    success: true,
  };
}
