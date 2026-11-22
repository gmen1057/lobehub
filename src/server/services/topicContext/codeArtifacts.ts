import type { LobeChatDatabase } from '@lobechat/database';
import { decodeSourceText, TextEncodingError } from '@lobechat/file-loaders';
import { readFilePage } from '@lobechat/prompts';
import { and, desc, eq, exists, or, sql } from 'drizzle-orm';

import { files, messages } from '@/database/schemas';
import { FileService } from '@/server/services/file';

import type { TopicContextParams } from './index';

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const VERSION_PAGE_SIZE = 12;

function ownedCodeArtifacts(
  db: LobeChatDatabase,
  userId: string,
  topicId: string,
  includeTextFiles = true,
) {
  return and(
    eq(files.userId, userId),
    sql`starts_with(${files.url}, ${`files/${userId}/code-artifacts/${topicId}/`})`,
    or(
      includeTextFiles
        ? and(
            sql`starts_with(${files.clientId}, 'arckep-text-file/v1/')`,
            sql`${files.metadata}->'textFile'->>'topicId' = ${topicId}`,
          )
        : undefined,
      and(
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
      ),
    ),
  );
}

/** Only server-issued private snapshots from this owner and conversation may become cards. */
export async function isTrustedPrivateCodeFile(
  db: LobeChatDatabase,
  userId: string,
  topicId: string,
  fileId: string,
) {
  const [row] = await db
    .select({ id: files.id })
    .from(files)
    .where(and(eq(files.id, fileId), ownedCodeArtifacts(db, userId, topicId)))
    .limit(1);
  return Boolean(row);
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
  { fileId, maxLines, offset, query, startLine, topicId }: TopicContextParams,
  includeTextFiles = true,
) {
  const scope = ownedCodeArtifacts(db, userId, topicId, includeTextFiles);
  if (!fileId) {
    const start = Number.isSafeInteger(offset) && offset! >= 0 ? offset! : 0;
    const rows = await db
      .select({
        createdAt: files.createdAt,
        fileId: files.id,
        identifier: sql<string>`coalesce(${files.metadata}->'codeArtifact'->>'identifier', ${files.metadata}->'textFile'->>'documentId')`,
        language: sql<string>`${files.metadata}->'codeArtifact'->>'language'`,
        title: sql<string>`coalesce(${files.metadata}->'codeArtifact'->>'title', ${files.metadata}->'textFile'->>'fileName')`,
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
  let source: string;
  try {
    source = decodeSourceText(bytes).text;
  } catch (e) {
    if (e instanceof TextEncodingError) {
      return {
        content: 'Code artifact source is not valid UTF-8 or Windows-1251 text.',
        success: false,
      };
    }
    throw e;
  }
  const { content, ...page } = readFilePage(source, { maxLines, offset, query, startLine });
  return {
    content: `${JSON.stringify({ fileId, ...page })}\n${content}`,
    success: true,
  };
}
