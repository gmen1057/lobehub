import { KnowledgeBaseIdentifier } from '@lobechat/builtin-tool-knowledge-base';
import { KnowledgeBaseExecutionRuntime } from '@lobechat/builtin-tool-knowledge-base/executionRuntime';
import { and, eq, inArray } from 'drizzle-orm';

import { AgentModel } from '@/database/models/agent';
import { messages, messagesFiles } from '@/database/schemas';
import { KnowledgeRetrievalService } from '@/server/services/knowledgeRetrieval';

import type { ServerRuntimeRegistration } from './types';

export const DATA_GUARD_SEARCH_BLOCKED_MESSAGE =
  '[Поиск по незащищённым базам знаний отключён в защищённом режиме]';
export const DATA_GUARD_FILE_MASKED_CONTENT =
  '[Содержимое незащищённого файла проекта скрыто в защищённом режиме]';

export const knowledgeBaseRuntime: ServerRuntimeRegistration = {
  factory: async (context) => {
    if (!context.userId || !context.serverDB)
      throw new Error('Authenticated database context is required');
    const service = new KnowledgeRetrievalService(context.serverDB, context.userId);

    if (context.dataGuardProtected === true) {
      const guardedRuntime = new KnowledgeBaseExecutionRuntime({
        getFileContents: async (requestedIds, signal) => {
          const uniqueIds = [...new Set(requestedIds.filter(Boolean))];
          const allowedSet = new Set<string>();

          if (context.topicId && uniqueIds.length > 0) {
            const allowedRows = await context
              .serverDB!.select({ fileId: messagesFiles.fileId })
              .from(messagesFiles)
              .innerJoin(messages, eq(messages.id, messagesFiles.messageId))
              .where(
                and(
                  eq(messages.topicId, context.topicId),
                  eq(messages.userId, context.userId!),
                  inArray(messagesFiles.fileId, uniqueIds),
                ),
              );

            for (const row of allowedRows) {
              if (row.fileId) allowedSet.add(row.fileId);
            }
          }

          const allowedIds = uniqueIds.filter((id) => allowedSet.has(id));
          const allowedMap = new Map<
            string,
            Awaited<ReturnType<typeof service.getFileContents>>[number]
          >();

          if (allowedIds.length > 0) {
            const loaded = await service.getFileContents(allowedIds, signal);
            for (const item of loaded) {
              allowedMap.set(item.fileId, item);
            }
          }

          return requestedIds.map((fileId) => {
            const permitted = allowedMap.get(fileId);
            if (permitted) return permitted;
            return {
              content: DATA_GUARD_FILE_MASKED_CONTENT,
              fileId,
              filename: fileId,
              preview: DATA_GUARD_FILE_MASKED_CONTENT,
              totalCharCount: 0,
              totalLineCount: 0,
            };
          });
        },
        semanticSearchForChat: async () => ({ chunks: [], fileResults: [] }),
      });

      return {
        readKnowledge: guardedRuntime.readKnowledge.bind(guardedRuntime),
        searchKnowledgeBase: async () => ({
          content: DATA_GUARD_SEARCH_BLOCKED_MESSAGE,
          state: { chunks: [], fileResults: [], totalResults: 0 },
          success: false,
        }),
      };
    }

    const agent = context.agentId
      ? await new AgentModel(context.serverDB, context.userId).getAgentConfig(context.agentId)
      : undefined;
    return new KnowledgeBaseExecutionRuntime({
      getFileContents: service.getFileContents,
      semanticSearchForChat: (params, signal) =>
        service.semanticSearchForChat(
          {
            ...params,
            knowledgeIds:
              params.knowledgeIds ??
              agent?.knowledgeBases
                ?.filter((kb) => kb.enabled)
                .map((kb) => kb.id)
                .filter((id): id is string => !!id),
          },
          signal,
        ),
    });
  },
  identifier: KnowledgeBaseIdentifier,
};
