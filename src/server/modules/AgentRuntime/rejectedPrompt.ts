import { calculatePromptTokens } from '@lobechat/agent-runtime';
import type { ChatStreamPayload } from '@lobechat/model-runtime';

import type { RejectedInputSize } from './llmErrorRecovery';

interface SourceMessage {
  id?: string;
  role: string;
}

export interface RejectedPromptSize extends RejectedInputSize {
  message?: string;
  perUserTurn?: boolean;
}

type WireMessage = ChatStreamPayload['messages'][number];

const USER_INPUT_TOO_LONG_RE = /\buser input too long\b/i;

const tokens = (message: WireMessage) => calculatePromptTokens([message]);

const hasUserInputTooLongSignal = (
  value: unknown,
  depth = 0,
  seen = new Set<object>(),
): boolean => {
  if (depth > 6 || value === null || value === undefined) return false;
  if (typeof value === 'string') return USER_INPUT_TOO_LONG_RE.test(value);
  if (typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((item) => hasUserInputTooLongSignal(item, depth + 1, seen));
  }
  const record = value as Record<string, unknown>;
  for (const key of ['message', 'error', 'body', 'details', 'cause']) {
    if (hasUserInputTooLongSignal(record[key], depth + 1, seen)) return true;
  }
  return false;
};

const isPerUserTurnRefusal = (size: RejectedPromptSize, error?: unknown): boolean => {
  if (size.perUserTurn !== undefined) return size.perUserTurn;
  if (size.message && USER_INPUT_TOO_LONG_RE.test(size.message)) return true;
  return hasUserInputTooLongSignal(error);
};

const getLongestConsecutiveUserRun = (
  kept: Map<number, WireMessage>,
): { indices: number[]; tokens: number } => {
  let best = { indices: [] as number[], tokens: 0 };
  let currentIndices: number[] = [];
  let currentTokens = 0;

  for (const [index, message] of kept) {
    if (message.role === 'user') {
      currentIndices.push(index);
      currentTokens += tokens(message);
      if (currentTokens > best.tokens) {
        best = { indices: [...currentIndices], tokens: currentTokens };
      }
    } else {
      currentIndices = [];
      currentTokens = 0;
    }
  }

  return best;
};

const shortenStringContent = (
  text: string,
  excessTokens: number,
  messageTokens: number,
  marker: string,
): string | undefined => {
  if (text.length <= 1024 || messageTokens <= 0) return undefined;
  const keepChars = Math.max(
    640,
    Math.min(text.length - 256, Math.floor(text.length * (1 - excessTokens / messageTokens)) - 128),
  );
  if (keepChars >= text.length - marker.length) return undefined;
  return (
    text.slice(0, Math.ceil(keepChars * 0.7)) + marker + text.slice(-Math.floor(keepChars * 0.3))
  );
};

const shortenUserMessage = (
  message: WireMessage,
  excessTokens: number,
): WireMessage | undefined => {
  const marker = '\n[User input shortened for provider per-turn context limit.]\n';
  const msgTokens = tokens(message);

  if (typeof message.content === 'string') {
    const shortenedText = shortenStringContent(message.content, excessTokens, msgTokens, marker);
    if (!shortenedText) return undefined;
    return { ...message, content: shortenedText };
  }

  if (Array.isArray(message.content)) {
    let largestTextIndex = -1;
    let largestTextLen = 1024;
    for (let i = 0; i < message.content.length; i++) {
      const part: any = message.content[i];
      if (
        part?.type === 'text' &&
        typeof part.text === 'string' &&
        part.text.length > largestTextLen
      ) {
        largestTextLen = part.text.length;
        largestTextIndex = i;
      }
    }
    if (largestTextIndex === -1) return undefined;
    const part: any = message.content[largestTextIndex];
    const partTokens = calculatePromptTokens([{ content: part.text, role: 'user' }]);
    const shortenedText = shortenStringContent(part.text, excessTokens, partTokens, marker);
    if (!shortenedText) return undefined;
    const nextParts = [...message.content];
    nextParts[largestTextIndex] = { ...part, text: shortenedText };
    return { ...message, content: nextParts };
  }

  return undefined;
};

/** Reduce only the outbound copy. The measured limit belongs to this request's route and options. */
export function fitRejectedPrompt(
  payload: Pick<ChatStreamPayload, 'messages' | 'tools'>,
  source: SourceMessage[],
  wireSourceIds: (string | undefined)[],
  size: RejectedPromptSize,
  error?: unknown,
): WireMessage[] | undefined {
  const { messages } = payload;
  const kept = new Map(messages.entries());
  const perUserTurn = isPerUserTurnRefusal(size, error);
  const initialLongestUserRun = perUserTurn ? getLongestConsecutiveUserRun(kept) : undefined;
  const usePerUserCalibration =
    perUserTurn && initialLongestUserRun !== undefined && initialLongestUserRun.tokens > 0;

  const estimated = usePerUserCalibration
    ? initialLongestUserRun.tokens
    : calculatePromptTokens(messages, payload.tools);
  // Calibrate our estimator against the provider's count for this exact assembled prompt
  // (or longest consecutive user-turn run for DeepSeek per-user-turn refusals).
  const limit = Math.floor((estimated * size.maxTokens) / size.inputTokens);
  const target = Math.floor(limit * 0.92);
  let remaining = estimated;

  const currentMetric = () =>
    usePerUserCalibration ? getLongestConsecutiveUserRun(kept).tokens : remaining;

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
    if (currentMetric() <= target) break;
    if (!origin || !archives.has(origin)) continue;
    const message = kept.get(index);
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

  if (usePerUserCalibration) {
    // For DeepSeek single-user-turn refusals, only reduce messages inside the longest
    // consecutive user run (deleting unrelated assistant/tool turns would not help and
    // could even merge two separate user turns into a larger run).
    // 1) Drop earlier real user turns sitting directly inside the oversized user run.
    while (currentMetric() > target) {
      const longestRun = getLongestConsecutiveUserRun(kept);
      const removableIndex = longestRun.indices.find(
        (idx) => idx < latestIndex && origins[idx]?.role === 'user',
      );
      if (removableIndex === undefined) break;
      kept.delete(removableIndex);
    }

    // 2) Only destructively shorten remaining user entries if the run is still above limit
    // after omitting archived summaries and earlier user turns.
    for (let pass = 0; pass < 3 && currentMetric() > limit; pass++) {
      const longestRun = getLongestConsecutiveUserRun(kept);
      if (longestRun.tokens <= limit) break;
      let changed = false;

      // Trim earlier user entries in the run before touching the final user prompt.
      const orderedIndices = [
        ...longestRun.indices.filter((idx) => idx !== latestIndex),
        ...longestRun.indices.filter((idx) => idx === latestIndex),
      ];

      for (const index of orderedIndices) {
        const currentRunTokens = getLongestConsecutiveUserRun(kept).tokens;
        if (currentRunTokens <= limit) break;
        const message = kept.get(index);
        if (!message) continue;
        const shortened = shortenUserMessage(message, currentRunTokens - target);
        if (!shortened) continue;
        if (tokens(shortened) < tokens(message)) {
          kept.set(index, shortened);
          changed = true;
        }
      }

      if (!changed) break;
    }

    const finalRunTokens = getLongestConsecutiveUserRun(kept).tokens;
    return finalRunTokens <= limit && finalRunTokens < estimated ? [...kept.values()] : undefined;
  }

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
