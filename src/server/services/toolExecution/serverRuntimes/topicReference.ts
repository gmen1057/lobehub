import { TopicReferenceIdentifier } from '@lobechat/builtin-tool-topic-reference';

import type { TopicContextParams } from '@/server/services/topicContext';
import { getTopicContext } from '@/server/services/topicContext';

import type { ServerRuntimeRegistration } from './types';

export const topicReferenceRuntime: ServerRuntimeRegistration = {
  factory: (context) => {
    const { serverDB, userId } = context;
    if (!serverDB || !userId) throw new Error('Authenticated database context is required');
    return {
      getTopicContext: (params: TopicContextParams) => getTopicContext(serverDB, userId, params),
    };
  },
  identifier: TopicReferenceIdentifier,
};
