import { type BuiltinToolManifest } from '@lobechat/types';

import { TopicReferenceApiName, TopicReferenceIdentifier } from './types';

export const TopicReferenceManifest: BuiltinToolManifest = {
  api: [
    {
      description:
        'Retrieve a topic summary, original archived messages, or saved code. When editing previous code, use mode="code_artifacts" to find a version and then read its exact source using its fileId.',
      name: TopicReferenceApiName.getTopicContext,
      parameters: {
        additionalProperties: false,
        properties: {
          topicId: {
            description: 'The ID of the topic to retrieve context from',
            type: 'string',
          },
          mode: {
            type: 'string',
            enum: ['summary', 'archive', 'code_artifacts'],
            description:
              'Use archive for original messages, including compressed history. Use code_artifacts to list saved code versions or read the version selected by fileId.',
          },
          fileId: {
            description:
              'In code_artifacts mode, omit to list versions; provide the exact fileId to read source.',
            type: 'string',
          },
          offset: {
            type: 'integer',
            minimum: 0,
            description:
              'For archive and code artifact pages, start at 0 and then follow nextOffset.',
          },
          snapshotAt: {
            type: 'string',
            description:
              'For archive continuation, copy snapshotAt from the previous page unchanged to exclude newly generated messages.',
          },
          query: {
            type: 'string',
            maxLength: 500,
            description:
              'Optional literal search within the original archive. Omit to read sequentially.',
          },
        },
        required: ['topicId'],
        type: 'object',
      },
    },
  ],
  identifier: TopicReferenceIdentifier,
  meta: {
    avatar: '📋',
    description: 'Извлечение контекста из связанных чатов',
    title: 'Контекст темы',
  },
  systemRole: '',
  type: 'builtin',
};
