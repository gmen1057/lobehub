import { KnowledgeBaseIdentifier } from '@lobechat/builtin-tool-knowledge-base';
import { KnowledgeBaseExecutionRuntime } from '@lobechat/builtin-tool-knowledge-base/executionRuntime';
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';

import { AgentModel } from '@/database/models/agent';
import {
  knowledgeBaseFiles,
  knowledgeBases,
  messages,
  messagesFiles,
  projectWorkspaceFiles,
} from '@/database/schemas';
import { KnowledgeRetrievalService } from '@/server/services/knowledgeRetrieval';

import type { ServerRuntimeRegistration } from './types';

export const DATA_GUARD_SEARCH_BLOCKED_MESSAGE =
  '[Поиск по незащищённым базам знаний отключён в защищённом режиме]';
export const DATA_GUARD_EMPTY_PROTECTED_KB_MESSAGE =
  'В защищённом проекте пока нет проиндексированных документов.';
export const DATA_GUARD_FILE_MASKED_CONTENT =
  '[Содержимое незащищённого файла проекта скрыто в защищённом режиме]';

export const knowledgeBaseRuntime: ServerRuntimeRegistration = {
  factory: async (context) => {
    if (!context.userId || !context.serverDB)
      throw new Error('Authenticated database context is required');
    const service = new KnowledgeRetrievalService(context.serverDB, context.userId);

    if (context.dataGuardProtected === true) {
      const workspaceGuardReady =
        context.workspaceDataGuardReady === true && Boolean(context.agentId);

      const resolveAllowedFileSet = async (uniqueIds: string[]): Promise<Set<string>> => {
        const allowedSet = new Set<string>();
        if (uniqueIds.length === 0) return allowedSet;

        if (context.topicId) {
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

        if (workspaceGuardReady && context.agentId) {
          const scrubbedWorkspaceRows = await context
            .serverDB!.select({ fileId: projectWorkspaceFiles.currentFileId })
            .from(projectWorkspaceFiles)
            .where(
              and(
                eq(projectWorkspaceFiles.userId, context.userId!),
                eq(projectWorkspaceFiles.agentId, context.agentId),
                isNull(projectWorkspaceFiles.deletedAt),
                ne(projectWorkspaceFiles.loadMode, 'disabled'),
                eq(projectWorkspaceFiles.dataGuardStatus, 'scrubbed'),
                inArray(projectWorkspaceFiles.currentFileId, uniqueIds),
              ),
            );

          for (const row of scrubbedWorkspaceRows) {
            if (row.fileId) allowedSet.add(row.fileId);
          }
        }

        return allowedSet;
      };

      const buildGuardedFileReader = async (requestedIds: string[], signal?: AbortSignal) => {
        const uniqueIds = [...new Set(requestedIds.filter(Boolean))];
        const allowedSet = await resolveAllowedFileSet(uniqueIds);
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
      };

      if (workspaceGuardReady && context.agentId) {
        const queryScrubbedRagFileIds = async (): Promise<string[]> => {
          const rows = await context
            .serverDB!.select({ fileId: knowledgeBaseFiles.fileId })
            .from(knowledgeBaseFiles)
            .innerJoin(knowledgeBases, eq(knowledgeBases.id, knowledgeBaseFiles.knowledgeBaseId))
            .innerJoin(
              projectWorkspaceFiles,
              eq(projectWorkspaceFiles.currentFileId, knowledgeBaseFiles.fileId),
            )
            .where(
              and(
                eq(knowledgeBaseFiles.userId, context.userId!),
                eq(knowledgeBases.userId, context.userId!),
                eq(knowledgeBases.type, 'project_workspace'),
                sql`${knowledgeBases.settings}->>'managedByAgentId' = ${context.agentId!}`,
                eq(projectWorkspaceFiles.userId, context.userId!),
                eq(projectWorkspaceFiles.agentId, context.agentId!),
                isNull(projectWorkspaceFiles.deletedAt),
                ne(projectWorkspaceFiles.loadMode, 'disabled'),
                eq(projectWorkspaceFiles.ragEnabled, true),
                eq(projectWorkspaceFiles.dataGuardStatus, 'scrubbed'),
              ),
            );

          return [
            ...new Set(rows.map((row) => row.fileId).filter((id): id is string => Boolean(id))),
          ];
        };

        const guardedReadyRuntime = new KnowledgeBaseExecutionRuntime({
          getFileContents: buildGuardedFileReader,
          semanticSearchForChat: async (params, signal) => {
            if (!Array.isArray(params.fileIds) || params.fileIds.length === 0) {
              return { chunks: [], fileResults: [] };
            }
            return service.semanticSearchForChat(
              {
                ...params,
                fileIds: params.fileIds,
                knowledgeIds: undefined,
              },
              signal,
            );
          },
        });

        return {
          readKnowledge: guardedReadyRuntime.readKnowledge.bind(guardedReadyRuntime),
          searchKnowledgeBase: async (args: any, options?: any) => {
            const scrubbedRagFileIds = await queryScrubbedRagFileIds();
            const requestedFileIds: unknown[] | undefined = Array.isArray(args?.fileIds)
              ? args.fileIds
              : undefined;
            let effectiveFileIds: string[];

            if (requestedFileIds && requestedFileIds.length > 0) {
              const scrubbedSet = new Set<string>(scrubbedRagFileIds);
              const filteredIds: string[] = requestedFileIds.filter(
                (id: unknown): id is string => typeof id === 'string' && scrubbedSet.has(id),
              );
              effectiveFileIds = [...new Set<string>(filteredIds)];
            } else {
              effectiveFileIds = scrubbedRagFileIds;
            }

            if (effectiveFileIds.length === 0) {
              return {
                content: DATA_GUARD_EMPTY_PROTECTED_KB_MESSAGE,
                state: { chunks: [], fileResults: [], totalResults: 0 },
                success: true,
              };
            }

            return guardedReadyRuntime.searchKnowledgeBase(
              { ...args, fileIds: effectiveFileIds },
              { ...options, knowledgeBaseIds: undefined },
            );
          },
        };
      }

      const guardedRuntime = new KnowledgeBaseExecutionRuntime({
        getFileContents: buildGuardedFileReader,
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
