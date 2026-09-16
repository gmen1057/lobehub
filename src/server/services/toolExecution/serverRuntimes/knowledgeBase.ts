import { KnowledgeBaseIdentifier } from '@lobechat/builtin-tool-knowledge-base';
import { KnowledgeBaseExecutionRuntime } from '@lobechat/builtin-tool-knowledge-base/executionRuntime';

import { AgentModel } from '@/database/models/agent';
import { KnowledgeRetrievalService } from '@/server/services/knowledgeRetrieval';

import type { ServerRuntimeRegistration } from './types';

export const knowledgeBaseRuntime: ServerRuntimeRegistration = {
  identifier: KnowledgeBaseIdentifier,
  factory: async (context) => {
    if (!context.userId || !context.serverDB)
      throw new Error('Authenticated database context is required');
    const service = new KnowledgeRetrievalService(context.serverDB, context.userId);
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
};
