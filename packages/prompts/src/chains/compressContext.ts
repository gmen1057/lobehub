import type { ChatStreamPayload, UIChatMessage } from '@lobechat/types';

import {
  chatHistoryPrompts,
  compressContextSystemPrompt,
  compressContextUserPrompt,
  fileReferences,
} from '../prompts';

/**
 * Chain for compressing conversation context into a summary
 * Used when conversation history exceeds token threshold
 */
export const chainCompressContext = (messages: UIChatMessage[]): Partial<ChatStreamPayload> => ({
  messages: [
    {
      content: compressContextSystemPrompt,
      role: 'system',
    },
    {
      content: `${chatHistoryPrompts(
        messages.map((message) => ({
          ...message,
          content:
            `[source_message_id: ${message.id}]\n${message.content || ''}` +
            (message.tools?.length ? `\nTool calls: ${JSON.stringify(message.tools)}` : ''),
        })),
      )}
${fileReferences(messages)}

${compressContextUserPrompt}`,
      role: 'user',
    },
  ],
});
