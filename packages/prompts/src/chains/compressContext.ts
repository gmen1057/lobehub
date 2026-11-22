import type { ChatStreamPayload, UIChatMessage } from '@lobechat/types';

import {
  chatHistoryPrompts,
  compressContextSystemPrompt,
  compressContextUserPrompt,
  fileReferences,
} from '../prompts';

export interface CompressContextOptions {
  existingSummary?: string;
  /** Prior compressedGroup nodes so fileReferences() preserves earlier fileIds */
  priorMessages?: UIChatMessage[];
}

/**
 * Chain for compressing conversation context into a summary
 * Used when conversation history exceeds token threshold
 */
export const chainCompressContext = (
  messages: UIChatMessage[],
  options?: string | CompressContextOptions,
): Partial<ChatStreamPayload> => {
  const normalizedOptions: CompressContextOptions =
    typeof options === 'string' ? { existingSummary: options } : (options ?? {});
  const existingSummary = normalizedOptions.existingSummary?.trim();
  const priorMessages = normalizedOptions.priorMessages ?? [];

  const existingSummaryBlock = existingSummary
    ? `<existing_summary>\n${existingSummary}\n</existing_summary>\n\n`
    : '';
  const fileReferenceSources =
    priorMessages.length > 0 ? [...priorMessages, ...messages] : messages;

  return {
    messages: [
      {
        content: compressContextSystemPrompt,
        role: 'system',
      },
      {
        content: `${existingSummaryBlock}${chatHistoryPrompts(
          messages.map((message) => ({
            ...message,
            content:
              `[source_message_id: ${message.id}]\n${message.content || ''}` +
              (message.tools?.length ? `\nTool calls: ${JSON.stringify(message.tools)}` : ''),
          })),
        )}
${fileReferences(fileReferenceSources)}

${compressContextUserPrompt}`,
        role: 'user',
      },
    ],
  };
};
