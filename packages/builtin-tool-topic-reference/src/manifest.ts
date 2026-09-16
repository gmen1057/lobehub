import { type BuiltinToolManifest } from '@lobechat/types';

import { TopicReferenceApiName, TopicReferenceIdentifier } from './types';

export const TopicReferenceManifest: BuiltinToolManifest = {
  api: [
    {
      description:
        'Retrieve context from a referenced topic conversation. Returns the topic summary if available, otherwise returns the most recent messages. Use this when you see a topic reference tag in the user message and need to understand what was discussed in that topic.',
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
            enum: ['summary', 'archive'],
            description:
              'Use archive to retrieve original messages, including compressed history, without relying on summaries.',
          },
          offset: {
            type: 'integer',
            minimum: 0,
            description: 'For archive pages: start at 0, then follow nextOffset automatically.',
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
