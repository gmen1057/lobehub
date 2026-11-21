import { calculatePromptTokens } from '@lobechat/agent-runtime';
import type { ChatStreamPayload } from '@lobechat/model-runtime';

import type { RejectedInputSize } from './llmErrorRecovery';

interface SourceMessage {
  id?: string;
  role: string;
}

type WireMessage = ChatStreamPayload['messages'][number];

const tokens = (message: WireMessage) => calculatePromptTokens([message]);

/** Reduce only the outbound copy. The measured limit belongs to this request's route and options. */
export function fitRejectedPrompt(
  payload: Pick<ChatStreamPayload, 'messages' | 'tools'>,
  source: SourceMessage[],
  wireSourceIds: (string | undefined)[],
  size: RejectedInputSize,
): WireMessage[] | undefined {
  const { messages } = payload;
  const estimated = calculatePromptTokens(messages, payload.tools);
  // Calibrate our estimator against the provider's count for this exact assembled prompt.
  const limit = Math.floor((estimated * size.maxTokens) / size.inputTokens);
  const target = Math.floor(limit * 0.92);
  const kept = new Map(messages.entries());
  let remaining = estimated;

  // Synthetic user-role entries carry tool discovery, memory or images. Only real source
  // turns delimit removable history. Keep all system instructions, even inside an old turn.
  const byId = new Map(source.filter((item) => item.id).map((item) => [item.id, item]));
  const origins = messages === source ? source : wireSourceIds.map((id) => byId.get(id));
  // Older in-flight operations may have lost the last user's DB id. Archived summaries
  // still have durable IDs and can safely be shortened without guessing which user to drop.
  const taskIndex = source.findLastIndex((item) => item.role === 'user');
  const archives = new Set(
    source.slice(0, Math.max(0, taskIndex)).filter((item) => item.role === 'compressedGroup'),
  );
  for (const [index, origin] of origins.entries()) {
    if (remaining <= target) break;
    if (!origin || !archives.has(origin)) continue;
    const message = messages[index];
    if (
      message?.role !== 'user' ||
      typeof message.content !== 'string' ||
      !message.content.startsWith('<compressed_history_summary>')
    )
      continue;
    const closing = '</compressed_history_summary>';
    const end = message.content.lastIndexOf(closing);
    if (end === -1) continue;
    // Keep archive locators and references to attachments beyond the summary text.
    const shortened = {
      ...message,
      content: '[Earlier summary omitted.]' + message.content.slice(end + closing.length),
    };
    remaining -= tokens(message) - tokens(shortened);
    kept.set(index, shortened);
  }

  const latestUser =
    source.findLast((item) => item.role === 'user' && item.id) ??
    (messages === source ? source.findLast((item) => item.role === 'user') : undefined);
  const latestIndex = latestUser ? origins.lastIndexOf(latestUser) : -1;
  const starts = origins.flatMap((item, index) =>
    index <= latestIndex &&
    messages[index]?.role === 'user' &&
    (item?.role === 'user' || item?.role === 'compressedGroup')
      ? [index]
      : [],
  );
  for (let turn = 0; remaining > target && turn + 1 < starts.length; turn++) {
    for (let index = starts[turn]; index < starts[turn + 1]; index++) {
      const message = messages[index];
      if (message.role === 'user' && index !== starts[turn]) continue;
      if (!['user', 'assistant', 'tool', 'function'].includes(message.role)) continue;
      if (origins[index]?.role === 'compressedGroup') continue;
      kept.delete(index);
      remaining -= tokens(message);
    }
  }

  // A single current turn may contain more tool output than the entire window.
  // Keep the calls, IDs and every result; shorten text from the oldest results first.
  for (const [index, message] of kept) {
    if (remaining <= target) break;
    if (
      message.role !== 'tool' ||
      typeof message.content !== 'string' ||
      message.content.length <= 1024
    )
      continue;
    const length = message.content.length;
    const keepChars = Math.max(
      640,
      Math.floor(length * (1 - (remaining - target) / tokens(message))) - 128,
    );
    const shortened = {
      ...message,
      content:
        message.content.slice(0, Math.ceil(keepChars * 0.7)) +
        '\n[Completed tool result shortened for context. Consult the original for omitted details.]\n' +
        message.content.slice(-Math.floor(keepChars * 0.3)),
    };
    remaining -= tokens(message) - tokens(shortened);
    kept.set(index, shortened);
  }

  return remaining <= limit && remaining < estimated ? [...kept.values()] : undefined;
}
