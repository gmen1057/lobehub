import { calculatePromptTokens, isEmptyAssistantPlaceholder } from '@lobechat/agent-runtime';
import { rewriteSavedCodeArtifactTagsForLLM } from '@lobechat/context-engine';
import { type ChatStreamPayload, consumeStreamUntilDone } from '@lobechat/model-runtime';
import {
  chainCompressContext,
  chatHistoryPrompts,
  compressContextSystemPrompt,
  compressContextUserPrompt,
  fileReferences,
} from '@lobechat/prompts';
import { type UIChatMessage } from '@lobechat/types';
import { and, eq, isNull } from 'drizzle-orm';

import { MessageModel } from '@/database/models/message';
import { agents, messages, topics } from '@/database/schemas';
import { type LobeChatDatabase } from '@/database/type';
import {
  type AgentConfigLike,
  type CompressionModelConfig,
  DEFAULT_AUTO_COMPRESS_WINDOW,
  isDeepSeekDataGuardProtected,
  resolveCompressionModelConfig,
  resolveCompressionThresholds,
} from '@/server/modules/AgentRuntime/compressionThresholds';
import { classifyLLMError } from '@/server/modules/AgentRuntime/llmErrorClassification';
import { readLLMRecoverySignal } from '@/server/modules/AgentRuntime/llmErrorRecovery';
import {
  estimateDeepSeekUserTurnTokens,
  prepareMessageForSummarizer,
  splitTextToTokenBudget,
} from '@/server/modules/AgentRuntime/RuntimeExecutors';
import { initModelRuntimeFromDB } from '@/server/modules/ModelRuntime';
import { MessageService } from '@/server/services/message';
import {
  computeWorkspaceDataGuardState,
  maskUnmaskedWorkspaceHistoryForSummarizer,
} from '@/server/services/projectWorkspace';

import { getActiveTopicCompactions } from './compactionRegistry';

export {
  hasInFlightTopicCompaction,
  hasInFlightTopicCompactionsForUser,
  resetInFlightTopicCompactionsForTests,
} from './compactionRegistry';

const DEEPSEEK_SUMMARIZER_USER_TURN_BUDGET_TOKENS = 20_000;
const DEEPSEEK_CHUNK_ACK = 'Фрагмент истории принят.';
const SUMMARIZER_SAFE_BUDGET_RATIO = 0.72;
const MIN_SUMMARIZER_SAFE_BUDGET = 24_000;
const QUERY_PAGE_SIZE = 10_000;

const PROMPT_OVERHEAD_TOKENS =
  estimateDeepSeekUserTurnTokens(compressContextSystemPrompt) +
  estimateDeepSeekUserTurnTokens(compressContextUserPrompt) +
  512;

interface CompactTopicGlobal {
  __arckepEngineSlotActivity?: {
    responseExecutions?: Map<number, { topicId?: string; userId: string }>;
  };
  __arckepResponsesStreamHub?: {
    findByTopic?: (userId: string, topicId: string) => { done: boolean } | undefined;
  };
}

const globalForCompact = globalThis as unknown as CompactTopicGlobal;

const isTopicBusyFromGlobals = (userId: string, topicId: string): boolean => {
  const op = globalForCompact.__arckepResponsesStreamHub?.findByTopic?.(userId, topicId);
  if (op && !op.done) return true;

  const executions = globalForCompact.__arckepEngineSlotActivity?.responseExecutions;
  if (executions) {
    for (const entry of executions.values()) {
      if (entry.userId === userId && entry.topicId === topicId) {
        return true;
      }
    }
  }
  return false;
};

const createNotFoundError = (message: string): Error => {
  const error = new Error(message);
  error.name = 'NotFoundError';
  return error;
};

const createConflictError = (message: string): Error => {
  const error = new Error(message);
  error.name = 'ConflictError';
  return error;
};

const getMessageToolCallIds = (message: UIChatMessage): string[] => {
  const ids: string[] = [];
  if (Array.isArray(message.tools)) {
    for (const tool of message.tools) {
      if (typeof tool?.id === 'string' && tool.id) ids.push(tool.id);
    }
  }
  const rawToolCalls = (message as { tool_calls?: Array<{ id?: unknown }> }).tool_calls;
  if (Array.isArray(rawToolCalls)) {
    for (const toolCall of rawToolCalls) {
      if (typeof toolCall?.id === 'string' && toolCall.id) ids.push(toolCall.id);
    }
  }
  return ids;
};

/**
 * Walks backward from `cutoffIndex` so compaction never splits a `tool_calls`/`tool` pair or an
 * `assistantGroup` chain (`assistant -> tool -> assistant -> ...`). Stops before any prior
 * `compressedGroup` boundary.
 */
export const resolveSafeCutoffIndex = (
  queriedMessages: readonly UIChatMessage[],
  cutoffIndex: number,
): number => {
  if (cutoffIndex <= 0) return 0;

  const indexById = new Map<string, number>();
  const toolCallerIndexByCallId = new Map<string, number>();

  for (let i = 0; i < queriedMessages.length; i++) {
    const msg = queriedMessages[i];
    if (msg.id) indexById.set(msg.id, i);
    for (const tcId of getMessageToolCallIds(msg)) {
      if (!toolCallerIndexByCallId.has(tcId)) {
        toolCallerIndexByCallId.set(tcId, i);
      }
    }
  }

  let minBoundary = 0;
  for (let i = cutoffIndex - 1; i >= 0; i--) {
    if (queriedMessages[i]?.role === 'compressedGroup') {
      minBoundary = i + 1;
      break;
    }
  }

  let safeCutoff = cutoffIndex;

  while (safeCutoff > minBoundary) {
    let nextCutoff = safeCutoff;

    // Preserved tail must never start with a `tool` message.
    if (queriedMessages[safeCutoff]?.role === 'tool') {
      nextCutoff = Math.min(nextCutoff, safeCutoff - 1);
    }

    // If preserved tail starts with an assistant message without parentId directly after a tool row,
    // keep it attached to that tool group.
    if (
      queriedMessages[safeCutoff]?.role === 'assistant' &&
      !queriedMessages[safeCutoff]?.parentId &&
      queriedMessages[safeCutoff - 1]?.role === 'tool'
    ) {
      nextCutoff = Math.min(nextCutoff, safeCutoff - 1);
    }

    // Keep every tool result and assistantGroup descendant connected to its caller/parent.
    for (let i = safeCutoff; i < queriedMessages.length; i++) {
      const msg = queriedMessages[i];
      if (!msg) continue;

      if (msg.role === 'tool' && typeof msg.tool_call_id === 'string' && msg.tool_call_id) {
        const callerIdx = toolCallerIndexByCallId.get(msg.tool_call_id);
        if (callerIdx !== undefined && callerIdx < safeCutoff && callerIdx >= minBoundary) {
          nextCutoff = Math.min(nextCutoff, callerIdx);
        }
      }

      if (
        (msg.role === 'assistant' || msg.role === 'tool' || msg.role === 'task') &&
        typeof msg.parentId === 'string' &&
        msg.parentId
      ) {
        const parentIdx = indexById.get(msg.parentId);
        if (parentIdx !== undefined && parentIdx < safeCutoff && parentIdx >= minBoundary) {
          const parentRole = queriedMessages[parentIdx]?.role;
          if (parentRole !== 'user' && parentRole !== 'compressedGroup') {
            nextCutoff = Math.min(nextCutoff, parentIdx);
          }
        }
      }
    }

    const clampedNext = Math.max(minBoundary, nextCutoff);
    if (clampedNext === safeCutoff) break;
    safeCutoff = clampedNext;
  }

  return safeCutoff;
};

const extractTextForDeepSeekTurn = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part: unknown) => {
        if (!part || typeof part !== 'object') return '';
        if ('text' in part && typeof (part as { text?: unknown }).text === 'string') {
          return (part as { text: string }).text;
        }
        if ('thinking' in part && typeof (part as { thinking?: unknown }).thinking === 'string') {
          return (part as { thinking: string }).thinking;
        }
        return '';
      })
      .join('\n');
  }
  return content ? JSON.stringify(content) : '';
};

const estimateDeepSeekPromptUserTurnTokens = (message: {
  content?: unknown;
  role?: string;
}): number => {
  const text = extractTextForDeepSeekTurn(message.content);
  return Math.max(
    calculatePromptTokens([message as any]),
    estimateDeepSeekUserTurnTokens(text) + 4,
  );
};

const hasOversizedDeepSeekUserTurn = (
  promptMessages: ChatStreamPayload['messages'],
  budgetTokens: number,
): boolean => {
  let consecutiveUserCount = 0;
  let consecutiveUserRunTokens = 0;

  for (const msg of promptMessages) {
    if (msg.role === 'user') {
      consecutiveUserCount += 1;
      consecutiveUserRunTokens += estimateDeepSeekPromptUserTurnTokens(msg);
      if (consecutiveUserCount > 1 || consecutiveUserRunTokens > budgetTokens) {
        return true;
      }
    } else {
      consecutiveUserCount = 0;
      consecutiveUserRunTokens = 0;
    }
  }

  return false;
};

const buildCompressionPromptMessages = (params: {
  existingSummary?: string;
  fileRefsText: string;
  messages: UIChatMessage[];
}): ChatStreamPayload['messages'] => {
  const existingSummary = params.existingSummary?.trim();
  const existingSummaryBlock = existingSummary
    ? `<existing_summary>\n${existingSummary}\n</existing_summary>\n\n`
    : '';
  const historyBlock = chatHistoryPrompts(
    params.messages.map((message) => ({
      ...message,
      content:
        `[source_message_id: ${message.id}]\n${message.content || ''}` +
        (message.tools?.length ? `\nTool calls: ${JSON.stringify(message.tools)}` : ''),
    })),
  );
  const fileRefsBlock = params.fileRefsText ? `\n\n${params.fileRefsText}` : '';

  return [
    {
      content: compressContextSystemPrompt,
      role: 'system',
    },
    {
      content: `${existingSummaryBlock}${historyBlock}${fileRefsBlock}\n\n${compressContextUserPrompt}`,
      role: 'user',
    },
  ];
};

const buildDeepSeekAlternatingCompressionMessages = (params: {
  existingSummary?: string;
  fileRefsText: string;
  messages: UIChatMessage[];
}): ChatStreamPayload['messages'] => {
  const { existingSummary, fileRefsText, messages: inputMessages } = params;
  const result: ChatStreamPayload['messages'] = [
    { content: compressContextSystemPrompt, role: 'system' },
  ];

  const pushAlternatingUserSegment = (content: string) => {
    result.push({ content, role: 'user' }, { content: DEEPSEEK_CHUNK_ACK, role: 'assistant' });
  };

  const trimmedSummary = existingSummary?.trim();
  if (trimmedSummary) {
    const summarySlices = splitTextToTokenBudget(
      trimmedSummary,
      DEEPSEEK_SUMMARIZER_USER_TURN_BUDGET_TOKENS - 256,
    );
    for (let i = 0; i < summarySlices.length; i++) {
      const tag =
        summarySlices.length === 1
          ? '<existing_summary>'
          : `<existing_summary part="${i + 1}/${summarySlices.length}">`;
      pushAlternatingUserSegment(`${tag}\n${summarySlices[i]}\n</existing_summary>`);
    }
  }

  const maxSingleMessageTokens = DEEPSEEK_SUMMARIZER_USER_TURN_BUDGET_TOKENS - 512;
  const expandedMessages: UIChatMessage[] = [];
  for (const msg of inputMessages) {
    const rawBody =
      `${typeof msg.content === 'string' ? msg.content : ''}` +
      (msg.tools?.length ? `\nTool calls: ${JSON.stringify(msg.tools)}` : '');
    const headerPrefix = `[source_message_id: ${msg.id}]\n`;
    if (estimateDeepSeekUserTurnTokens(headerPrefix + rawBody) <= maxSingleMessageTokens) {
      expandedMessages.push({ ...msg, content: headerPrefix + rawBody, tools: undefined });
    } else {
      const parts = splitTextToTokenBudget(rawBody, maxSingleMessageTokens - 64);
      for (let partIdx = 0; partIdx < parts.length; partIdx++) {
        expandedMessages.push({
          ...msg,
          content: `[source_message_id: ${msg.id} part ${partIdx + 1}/${parts.length}]\n${parts[partIdx]}`,
          tools: undefined,
        });
      }
    }
  }

  let chunk: UIChatMessage[] = [];
  let chunkApproxTokens = 0;
  const flushChunk = () => {
    if (chunk.length === 0) return;
    pushAlternatingUserSegment(chatHistoryPrompts(chunk));
    chunk = [];
    chunkApproxTokens = 0;
  };

  for (const msg of expandedMessages) {
    const msgTokens = estimateDeepSeekUserTurnTokens(msg.content) + 32;
    if (
      chunk.length > 0 &&
      chunkApproxTokens + msgTokens > DEEPSEEK_SUMMARIZER_USER_TURN_BUDGET_TOKENS - 256
    ) {
      flushChunk();
    }
    chunk.push(msg);
    chunkApproxTokens += msgTokens;
    if (
      chunk.length > 1 &&
      estimateDeepSeekPromptUserTurnTokens({ content: chatHistoryPrompts(chunk), role: 'user' }) >
        DEEPSEEK_SUMMARIZER_USER_TURN_BUDGET_TOKENS
    ) {
      const overflow = chunk.pop()!;
      flushChunk();
      chunk.push(overflow);
      chunkApproxTokens = msgTokens;
    }
  }
  flushChunk();

  const trimmedFileRefs = fileRefsText.trim();
  const finalInstructionContent = trimmedFileRefs
    ? `${trimmedFileRefs}\n\n${compressContextUserPrompt}`
    : compressContextUserPrompt;

  if (
    estimateDeepSeekPromptUserTurnTokens({ content: finalInstructionContent, role: 'user' }) <=
    DEEPSEEK_SUMMARIZER_USER_TURN_BUDGET_TOKENS
  ) {
    result.push({ content: finalInstructionContent, role: 'user' });
  } else {
    const refSlices = splitTextToTokenBudget(
      trimmedFileRefs,
      DEEPSEEK_SUMMARIZER_USER_TURN_BUDGET_TOKENS - 256,
    );
    for (const slice of refSlices) {
      pushAlternatingUserSegment(slice);
    }
    result.push({ content: compressContextUserPrompt, role: 'user' });
  }

  return result;
};

const adjustEndForSurrogate = (text: string, end: number): number => {
  if (end <= 0 || end >= text.length) return end;
  const code = text.charCodeAt(end - 1);
  return code >= 0xd8_00 && code <= 0xdb_ff ? end - 1 : end;
};

const adjustStartForSurrogate = (text: string, start: number): number => {
  if (start <= 0 || start >= text.length) return start;
  const code = text.charCodeAt(start);
  return code >= 0xdc_00 && code <= 0xdf_ff ? start + 1 : start;
};

const findLongestPrefixWithinTokens = (text: string, maxTokens: number): number => {
  const budget = Math.max(1, Math.floor(maxTokens));
  if (estimateDeepSeekUserTurnTokens(text) <= budget) return text.length;

  let low = 0;
  let high = Math.min(text.length, budget * 3);
  let best = 0;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (estimateDeepSeekUserTurnTokens(text.slice(0, mid)) <= budget) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return adjustEndForSurrogate(text, best);
};

const findLongestSuffixStartWithinTokens = (text: string, maxTokens: number): number => {
  const budget = Math.max(1, Math.floor(maxTokens));
  if (estimateDeepSeekUserTurnTokens(text) <= budget) return 0;

  let low = Math.max(0, text.length - budget * 3);
  let high = text.length;
  let best = text.length;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (estimateDeepSeekUserTurnTokens(text.slice(mid)) <= budget) {
      best = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }
  return adjustStartForSurrogate(text, best);
};

const truncateMiddleToTokenBudget = (text: string, maxTokens: number, label: string): string => {
  const budget = Math.max(256, Math.floor(maxTokens));
  if (estimateDeepSeekUserTurnTokens(text) <= budget) return text;

  const markerReserve = 96;
  const available = Math.max(128, budget - markerReserve);
  const headBudget = Math.floor(available * 0.65);
  const tailBudget = Math.max(64, available - headBudget);

  const headEnd = findLongestPrefixWithinTokens(text, headBudget);
  const tailStart = Math.max(headEnd, findLongestSuffixStartWithinTokens(text, tailBudget));
  const omittedChars = tailStart - headEnd;
  if (omittedChars <= 0) return text;

  return (
    text.slice(0, headEnd) +
    `\n\n[... ${omittedChars} chars of ${label} omitted during summarization; full original is preserved in getTopicContext(mode="archive") ...]\n\n` +
    text.slice(tailStart)
  );
};

const formatPreparedMessageBody = (msg: UIChatMessage): string => {
  const content = typeof msg.content === 'string' ? msg.content : '';
  const toolsSuffix = msg.tools?.length ? `\nTool calls: ${JSON.stringify(msg.tools)}` : '';
  return `${content}${toolsSuffix}`;
};

const estimatePreparedMessageTokens = (msg: UIChatMessage): number => {
  const header = `[source_message_id: ${msg.id}]\n`;
  const body = formatPreparedMessageBody(msg);
  return estimateDeepSeekUserTurnTokens(`<${msg.role}>${header}${body}</${msg.role}>`) + 16;
};

const estimateSummaryBlockTokens = (summary?: string): number => {
  const trimmed = summary?.trim();
  if (!trimmed) return 0;
  return estimateDeepSeekUserTurnTokens(`<existing_summary>\n${trimmed}\n</existing_summary>`) + 32;
};

const fitMessageToBatchBudget = (msg: UIChatMessage, batchBudgetTokens: number): UIChatMessage => {
  if (estimatePreparedMessageTokens(msg) <= batchBudgetTokens) return msg;

  const headerAndTagReserve = 128;
  const targetBodyTokens = Math.max(512, batchBudgetTokens - headerAndTagReserve);
  const fullBody = formatPreparedMessageBody(msg);
  const truncatedBody = truncateMiddleToTokenBudget(
    fullBody,
    targetBodyTokens,
    `${msg.role} message`,
  );

  return {
    ...msg,
    content: truncatedBody,
    tools: undefined,
  };
};

const partitionMessagesIntoBatches = (
  preparedMessages: UIChatMessage[],
  batchBudgetTokens: number,
): UIChatMessage[][] => {
  const batches: UIChatMessage[][] = [];
  let currentBatch: UIChatMessage[] = [];
  let currentTokens = 0;

  for (const msg of preparedMessages) {
    const fitted = fitMessageToBatchBudget(msg, batchBudgetTokens);
    const msgTokens = estimatePreparedMessageTokens(fitted);

    if (currentBatch.length > 0 && currentTokens + msgTokens > batchBudgetTokens) {
      batches.push(currentBatch);
      currentBatch = [];
      currentTokens = 0;
    }

    currentBatch.push(fitted);
    currentTokens += msgTokens;
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
};

const extractReadableErrorMessage = (error: unknown): string | undefined => {
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (!error || typeof error !== 'object') return undefined;
  const raw = error as Record<string, unknown>;
  for (const candidate of [
    raw.message,
    (raw.error as Record<string, unknown> | undefined)?.message,
    (raw.body as Record<string, unknown> | undefined)?.message,
    (
      (raw.body as Record<string, unknown> | undefined)?.error as
        Record<string, unknown> | undefined
    )?.message,
  ]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return undefined;
};

const hasInsufficientBalanceMarker = (
  value: unknown,
  depth = 6,
  seen = new Set<object>(),
): boolean => {
  if (depth <= 0 || value === null || value === undefined) return false;
  if (typeof value === 'string') {
    const lower = value.toLowerCase();
    return (
      lower.includes('studio_insufficient_balance') ||
      lower.includes('insufficient_balance') ||
      lower.includes('недостаточно средств на балансе')
    );
  }
  if (typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((item) => hasInsufficientBalanceMarker(item, depth - 1, seen));
  }
  const record = value as Record<string, unknown>;
  if (
    record.code === 'studio_insufficient_balance' ||
    record.code === 'insufficient_balance' ||
    record.type === 'insufficient_balance' ||
    record.errorType === 'insufficient_balance' ||
    (record.code === 'billing_error' && record.type === 'insufficient_balance')
  ) {
    return true;
  }
  return ['error', 'body', 'details', 'cause', 'message'].some((key) =>
    hasInsufficientBalanceMarker(record[key], depth - 1, seen),
  );
};

export type TopicCompactHttpStatus = 402 | 413 | 429 | 503;

export class TopicCompactHttpError extends Error {
  readonly status: TopicCompactHttpStatus;

  constructor(status: TopicCompactHttpStatus, message: string) {
    super(message);
    this.name = 'TopicCompactHttpError';
    this.status = status;
  }
}

const mapSummarizerError = (error: unknown): Error => {
  if (error instanceof TopicCompactHttpError) return error;

  const recovery = readLLMRecoverySignal(error);
  const classified = classifyLLMError(error);

  const isProviderCreditsExhausted = recovery.providerCode === 'provider_credits_exhausted';
  if (isProviderCreditsExhausted) {
    return new TopicCompactHttpError(
      503,
      extractReadableErrorMessage(error) || 'Provider credits exhausted',
    );
  }

  if (recovery.customerBalance || hasInsufficientBalanceMarker(error)) {
    return new TopicCompactHttpError(402, 'Insufficient balance');
  }

  if (recovery.studioChatHourlyLimit) {
    return new TopicCompactHttpError(429, recovery.studioChatHourlyLimit.message);
  }

  const resolvedStatus = recovery.status ?? classified.status;
  if (resolvedStatus === 429) {
    return new TopicCompactHttpError(
      429,
      extractReadableErrorMessage(error) || 'Rate limit exceeded',
    );
  }

  if (resolvedStatus === 413) {
    return new TopicCompactHttpError(
      413,
      extractReadableErrorMessage(error) || 'Payload too large for compaction',
    );
  }

  if (error instanceof Error) return error;
  return new Error(extractReadableErrorMessage(error) || JSON.stringify(error));
};

export interface CompactTopicParams {
  beforeMessageId?: string | null;
  dataGuardProtected?: boolean;
  db: LobeChatDatabase;
  explicitCompressionModel?: CompressionModelConfig;
  isTopicBusy?: () => boolean;
  signal?: AbortSignal;
  topicId: string;
  userId: string;
}

export interface CompactTopicResult {
  compacted: boolean;
  compressedCount: number;
  messageGroupId: string | null;
}

/**
 * Manually compacts a topic's conversation history into a single rolling `compressedGroup`
 * without deleting visible message rows.
 */
export const compactTopic = async (params: CompactTopicParams): Promise<CompactTopicResult> => {
  const {
    beforeMessageId,
    dataGuardProtected,
    db,
    explicitCompressionModel,
    isTopicBusy,
    signal,
    topicId,
    userId,
  } = params;

  const activeCompactions = getActiveTopicCompactions();
  const lockKey = `${userId}:${topicId}`;
  if (activeCompactions.has(lockKey)) {
    throw createConflictError('Compaction is already in progress for this topic');
  }
  activeCompactions.add(lockKey);

  try {
    // 1. Verify topic ownership in DB
    const [topic] = await db
      .select({
        agentId: topics.agentId,
        groupId: topics.groupId,
        id: topics.id,
        sessionId: topics.sessionId,
      })
      .from(topics)
      .where(and(eq(topics.id, topicId), eq(topics.userId, userId)))
      .limit(1);

    if (!topic) {
      throw createNotFoundError('Topic not found');
    }

    // 2. Guard against active response in progress on this topic
    const busy = isTopicBusy ? isTopicBusy() : isTopicBusyFromGlobals(userId, topicId);
    if (busy) {
      throw createConflictError('Response is already in progress for this topic');
    }

    // 3. Load agent chatConfig (if bound) to honor Data Guard protection
    let agentConfig: AgentConfigLike | null = null;
    if (topic.agentId) {
      const [agent] = await db
        .select({ chatConfig: agents.chatConfig })
        .from(agents)
        .where(and(eq(agents.id, topic.agentId), eq(agents.userId, userId)))
        .limit(1);
      if (agent) {
        agentConfig = { chatConfig: agent.chatConfig };
      }
    }

    // 4. Load all uncompressed main-timeline messages + existing compressedGroups for this topic
    const messageModel = new MessageModel(db, userId);
    const queriedMessages = await messageModel.queryWithWhere({
      pageSize: QUERY_PAGE_SIZE,
      topicId,
      where: and(eq(messages.topicId, topicId), isNull(messages.threadId)),
    });

    // 5. Resolve cutoff boundary when `beforeMessageId` is specified
    let safeCutoff = queriedMessages.length;

    if (beforeMessageId) {
      const cutoffIndex = queriedMessages.findIndex((msg) => msg.id === beforeMessageId);
      if (cutoffIndex === -1) {
        const [existingRow] = await db
          .select({
            id: messages.id,
            messageGroupId: messages.messageGroupId,
          })
          .from(messages)
          .where(
            and(
              eq(messages.id, beforeMessageId),
              eq(messages.topicId, topicId),
              eq(messages.userId, userId),
            ),
          )
          .limit(1);

        if (existingRow && existingRow.messageGroupId != null) {
          return {
            compacted: false,
            compressedCount: 0,
            messageGroupId: null,
          };
        }

        throw createNotFoundError('Message not found in topic');
      }

      safeCutoff = resolveSafeCutoffIndex(queriedMessages, cutoffIndex);
    }

    // 6. Guard against overwriting any later compressedGroup after `safeCutoff`
    if (queriedMessages.slice(safeCutoff).some((msg) => msg.role === 'compressedGroup')) {
      return {
        compacted: false,
        compressedCount: 0,
        messageGroupId: null,
      };
    }

    // Select candidates strictly before `safeCutoff`
    const candidateRows = queriedMessages.slice(0, safeCutoff);
    const priorCompressedGroups = candidateRows.filter((msg) => msg.role === 'compressedGroup');
    const meaningfulMessages = candidateRows.filter(
      (msg) =>
        msg.role !== 'compressedGroup' &&
        msg.role !== 'compareGroup' &&
        msg.role !== 'system' &&
        Boolean(msg.id) &&
        !isEmptyAssistantPlaceholder(msg),
    );

    if (
      (priorCompressedGroups.length === 0 && meaningfulMessages.length < 2) ||
      (priorCompressedGroups.length === 1 && meaningfulMessages.length === 0)
    ) {
      return {
        compacted: false,
        compressedCount: 0,
        messageGroupId: priorCompressedGroups[0]?.id ?? null,
      };
    }

    // 7. Resolve compression model (Data Guard unconditionally locks to deepseek/deepseek-flash)
    const effectiveDataGuardProtected = Boolean(
      dataGuardProtected || isDeepSeekDataGuardProtected(agentConfig),
    );
    let workspaceDataGuardReady = false;
    if (effectiveDataGuardProtected) {
      try {
        const dgState = await computeWorkspaceDataGuardState({
          agentChatConfig:
            (agentConfig?.chatConfig as Record<string, unknown> | null | undefined) ?? {},
          agentId: topic.agentId,
          db,
          requestDataGuardProtected: effectiveDataGuardProtected,
          userId,
        });
        workspaceDataGuardReady = dgState.workspaceDataGuardReady;
      } catch {
        workspaceDataGuardReady = false;
      }
    }
    const compressionModel = resolveCompressionModelConfig({
      agentConfig: {
        chatConfig: {
          ...(agentConfig?.chatConfig as Record<string, unknown> | null | undefined),
          ...(effectiveDataGuardProtected ? { deepseekDataGuardProtected: true } : {}),
        },
      },
      ...(explicitCompressionModel ? { explicitCompressionModel } : {}),
    });

    // 8. Prepare messages & rewrite saved code artifact tags (mask unmasked workspace history when Data Guard is active without scrubbed project readiness)
    const sourceMessagesForSummarizer =
      effectiveDataGuardProtected && !workspaceDataGuardReady
        ? maskUnmaskedWorkspaceHistoryForSummarizer(meaningfulMessages)
        : meaningfulMessages;
    const preparedMessages = sourceMessagesForSummarizer.map(prepareMessageForSummarizer);
    const rawExistingSummary = priorCompressedGroups
      .map((group) => (typeof group.content === 'string' ? group.content.trim() : ''))
      .filter(Boolean)
      .join('\n\n');
    const sanitizedExistingSummary = rawExistingSummary
      ? rewriteSavedCodeArtifactTagsForLLM(rawExistingSummary)
      : undefined;
    const sanitizedPriorCompressedGroups = priorCompressedGroups.map((group) => {
      if (typeof group.content !== 'string') return group;
      const rewritten = rewriteSavedCodeArtifactTagsForLLM(group.content);
      return rewritten !== group.content ? { ...group, content: rewritten } : group;
    });

    // 9. Initialize compression runtime WITHOUT assistantMessageId (billing_proxy bubble invariant)
    const compressionRuntime = await initModelRuntimeFromDB(db, userId, compressionModel.provider, {
      sessionId: topic.sessionId ?? undefined,
      studioWebChat: true,
      topicId,
    });

    const runSummarizerPass = async (pass: {
      existingSummary?: string;
      maxFileRefsTokens?: number;
      messages: UIChatMessage[];
      priorGroups: UIChatMessage[];
    }): Promise<string> => {
      const passFileReferenceSources =
        pass.priorGroups.length > 0 ? [...pass.priorGroups, ...pass.messages] : pass.messages;
      const rawFileRefsText = fileReferences(passFileReferenceSources).trim();
      const rawFileRefsTokens = rawFileRefsText
        ? estimateDeepSeekUserTurnTokens(rawFileRefsText) + 32
        : 0;
      const shouldTruncateFileRefs =
        pass.maxFileRefsTokens !== undefined &&
        Boolean(rawFileRefsText) &&
        rawFileRefsTokens > pass.maxFileRefsTokens;
      const boundedFileRefsText = shouldTruncateFileRefs
        ? truncateMiddleToTokenBudget(
            rawFileRefsText,
            Math.max(256, pass.maxFileRefsTokens! - 32),
            'file references',
          )
        : rawFileRefsText;

      let rawPromptMessages: ChatStreamPayload['messages'];
      if (shouldTruncateFileRefs) {
        rawPromptMessages = buildCompressionPromptMessages({
          existingSummary: pass.existingSummary,
          fileRefsText: boundedFileRefsText,
          messages: pass.messages,
        });
      } else {
        const compressOptions =
          pass.existingSummary || pass.priorGroups.length > 0
            ? {
                ...(pass.existingSummary ? { existingSummary: pass.existingSummary } : {}),
                ...(pass.priorGroups.length > 0 ? { priorMessages: pass.priorGroups } : {}),
              }
            : undefined;
        const compressionPayload = compressOptions
          ? chainCompressContext(pass.messages, compressOptions)
          : chainCompressContext(pass.messages);
        rawPromptMessages = compressionPayload.messages ?? [];
      }

      const needsDeepSeekTurnChunking =
        compressionModel.provider === 'deepseek' &&
        hasOversizedDeepSeekUserTurn(
          rawPromptMessages,
          DEEPSEEK_SUMMARIZER_USER_TURN_BUDGET_TOKENS,
        );
      const compressionMessages = needsDeepSeekTurnChunking
        ? buildDeepSeekAlternatingCompressionMessages({
            existingSummary: pass.existingSummary,
            fileRefsText: boundedFileRefsText,
            messages: pass.messages,
          })
        : rawPromptMessages;

      let summaryText = '';
      let summaryError: unknown;

      signal?.throwIfAborted();
      try {
        const compressionResponse = await compressionRuntime.chat(
          {
            enabledContextCaching: false,
            messages: compressionMessages,
            model: compressionModel.model,
            stream: true,
            ...(compressionModel.effort ? { effort: compressionModel.effort } : {}),
          },
          {
            callback: {
              onContentPart: async (part) => {
                if (part.partType === 'text') summaryText += part.content;
              },
              onError: async (errorData) => {
                summaryError = errorData;
              },
              onText: async (text) => {
                summaryText += text;
              },
            },
            ...(signal ? { signal } : {}),
            user: userId,
          },
        );
        await consumeStreamUntilDone(compressionResponse, signal);
      } catch (error) {
        throw mapSummarizerError(error);
      }

      signal?.throwIfAborted();

      if (summaryError) {
        throw mapSummarizerError(summaryError);
      }

      const trimmed = summaryText.trim();
      if (!trimmed) {
        throw new Error('Compression returned an empty summary');
      }

      return trimmed;
    };

    // 10. Compute safe summarizer window budget and execute single-pass or multi-pass rolling fold
    const thresholds = resolveCompressionThresholds(
      compressionModel.model,
      compressionModel.provider,
    );
    const physicalWindow =
      thresholds.physicalWindowToken ?? thresholds.maxWindowToken ?? DEFAULT_AUTO_COMPRESS_WINDOW;
    const safeBudget = Math.max(
      MIN_SUMMARIZER_SAFE_BUDGET,
      Math.floor(physicalWindow * SUMMARIZER_SAFE_BUDGET_RATIO),
    );

    const fileReferenceSources =
      sanitizedPriorCompressedGroups.length > 0
        ? [...sanitizedPriorCompressedGroups, ...preparedMessages]
        : preparedMessages;
    const allFileRefsText = fileReferences(fileReferenceSources).trim();
    const singlePassTokens =
      PROMPT_OVERHEAD_TOKENS +
      estimateSummaryBlockTokens(sanitizedExistingSummary) +
      (allFileRefsText ? estimateDeepSeekUserTurnTokens(allFileRefsText) + 32 : 0) +
      preparedMessages.reduce((sum, msg) => sum + estimatePreparedMessageTokens(msg), 0);

    let summaryContent: string;

    if (singlePassTokens <= safeBudget) {
      summaryContent = await runSummarizerPass({
        existingSummary: sanitizedExistingSummary,
        messages: preparedMessages,
        priorGroups: sanitizedPriorCompressedGroups,
      });
    } else {
      const maxSummaryTokens = Math.max(4_000, Math.floor(safeBudget * 0.25));
      const maxSummaryBodyTokens = Math.max(256, maxSummaryTokens - 64);
      const fileRefsReserve = Math.min(4_000, Math.floor(safeBudget * 0.12));
      let rollingSummary =
        sanitizedExistingSummary &&
        estimateSummaryBlockTokens(sanitizedExistingSummary) > maxSummaryTokens
          ? truncateMiddleToTokenBudget(
              sanitizedExistingSummary,
              maxSummaryBodyTokens,
              'existing summary',
            )
          : sanitizedExistingSummary;

      const summaryReserve = PROMPT_OVERHEAD_TOKENS + maxSummaryTokens + fileRefsReserve + 1_024;
      const batchMessageBudget = Math.max(4_000, safeBudget - summaryReserve);
      const batches = partitionMessagesIntoBatches(preparedMessages, batchMessageBudget);

      if (batches.length === 0) {
        summaryContent = await runSummarizerPass({
          existingSummary: rollingSummary,
          maxFileRefsTokens: fileRefsReserve,
          messages: [],
          priorGroups: sanitizedPriorCompressedGroups,
        });
      } else {
        for (let i = 0; i < batches.length; i++) {
          const priorGroupsForPass = i === 0 ? sanitizedPriorCompressedGroups : [];
          const nextSummary = await runSummarizerPass({
            existingSummary: rollingSummary,
            maxFileRefsTokens: fileRefsReserve,
            messages: batches[i],
            priorGroups: priorGroupsForPass,
          });
          rollingSummary =
            i < batches.length - 1 && estimateSummaryBlockTokens(nextSummary) > maxSummaryTokens
              ? truncateMiddleToTokenBudget(nextSummary, maxSummaryBodyTokens, 'rolling summary')
              : nextSummary;
        }
        summaryContent = rollingSummary!;
      }
    }

    // 11. Re-check topic idleness right before persisting to close any race window during LLM call
    const busyBeforeWrite = isTopicBusy ? isTopicBusy() : isTopicBusyFromGlobals(userId, topicId);
    if (busyBeforeWrite) {
      throw createConflictError('Response is already in progress for this topic');
    }

    // Persist rolling compression group atomically without deleting visible message rows
    const messageIds = meaningfulMessages.map((msg) => msg.id);
    const messageService = new MessageService(db, userId);
    const compressionResult = await messageService.upsertRollingCompressionGroup(
      topicId,
      messageIds,
      {
        agentId: topic.agentId ?? undefined,
        topicId,
      },
      summaryContent,
    );

    return {
      compacted: true,
      compressedCount: messageIds.length,
      messageGroupId: compressionResult.messageGroupId,
    };
  } finally {
    activeCompactions.delete(lockKey);
  }
};
