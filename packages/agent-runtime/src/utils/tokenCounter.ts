import { FILE_CONTEXT_CHARS, FILE_PREVIEW_CHARS } from '@lobechat/prompts';
import { estimateTokenCount } from 'tokenx';

/**
 * Language-specific character-per-token configs for tokenx.
 * Preserves tokenx@1.3.0 defaults (German, French/Spanish, Polish/Czech) and adds
 * Cyrillic so Russian prose is estimated at ~2.18 chars/token instead of tokenx's
 * 6 chars/token Latin fallback (~2.2x undercounting).
 */
export const TOKENX_LANGUAGE_CONFIGS = [
  { averageCharsPerToken: 3, pattern: /[äöüßẞ]/i },
  { averageCharsPerToken: 3, pattern: /[éèêëàâîïôûùüÿçœæáíóúñ]/i },
  { averageCharsPerToken: 3.5, pattern: /[ąćęłńóśźżěščřžýůúďťň]/i },
  { averageCharsPerToken: 2, pattern: /[\u0400-\u04FF]/ },
];

/**
 * Options for token counting and compression threshold calculation
 */
export interface TokenCountOptions {
  /** Model's max context window token count */
  maxWindowToken?: number;
  /** Threshold ratio for triggering compression, default 0.75 */
  thresholdRatio?: number;
}

/** Default max context window (128k tokens) */
export const DEFAULT_MAX_CONTEXT = 128_000;

/** Default threshold ratio (50% of max context) */
export const DEFAULT_THRESHOLD_RATIO = 0.5;

/**
 * Tool call entry embedded in an assistantGroup/supervisor child block
 */
export interface TokenCountToolWithResult {
  apiName?: string;
  arguments?: string;
  id?: string;
  identifier?: string;
  intervention?: unknown;
  result?: {
    content?: string | null;
    error?: unknown;
    id?: string;
    state?: unknown;
  } | null;
  thoughtSignature?: string;
  type?: string;
}

export interface TokenCountUsage {
  outputTextTokens?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
}

/**
 * Assistant content block inside an assistantGroup or supervisor virtual message
 */
export interface TokenCountAssistantBlock {
  content?: string | unknown;
  createdAt?: Date | number | string | null;
  fileList?: { content?: string | null; id?: string; name?: string }[];
  metadata?: {
    outputTextTokens?: number;
    totalInputTokens?: number;
    totalOutputTokens?: number;
    usage?: TokenCountUsage;
    [key: string]: unknown;
  } | null;
  reasoning?: unknown;
  reasoning_content?: string | null;
  tools?: TokenCountToolWithResult[];
  updatedAt?: Date | number | string | null;
  usage?: TokenCountUsage | null;
}

/**
 * Message interface for token counting
 */
export interface TokenCountMessage {
  activeColumnId?: string;
  children?: TokenCountAssistantBlock[];
  columns?: TokenCountMessage[][];
  compressedMessages?: unknown[];
  content?: string | unknown;
  createdAt?: Date | number | string | null;
  fileList?: { content?: string | null; id?: string; name?: string }[];
  id?: string;
  members?: TokenCountMessage[];
  metadata?: {
    outputTextTokens?: number;
    totalInputTokens?: number;
    totalOutputTokens?: number;
    usage?: TokenCountUsage;
    [key: string]: unknown;
  } | null;
  reasoning?: unknown;
  reasoning_content?: string | null;
  role: string;
  tasks?: TokenCountMessage[];
  tool_calls?: unknown;
  tools?: unknown;
  updatedAt?: Date | number | string | null;
  usage?: TokenCountUsage | null;
}

/**
 * Estimate token count for text content using tokenx
 * @param content - Text content or object to estimate tokens for
 * @returns Estimated token count
 */
export function estimateTokens(content: string | unknown): number {
  // Handle null/undefined early
  if (content === null || content === undefined) return 0;

  const text = typeof content === 'string' ? content : JSON.stringify(content);
  if (!text) return 0;
  return estimateTokenCount(text, { languageConfigs: TOKENX_LANGUAGE_CONFIGS });
}

interface AttachmentBudget {
  fileCharactersRemaining: number;
}

const countAttachments = (
  fileList: TokenCountMessage['fileList'],
  budget: AttachmentBudget,
): number => {
  let attachments = 0;
  for (const file of fileList || []) {
    const text = (file.content || '').slice(
      0,
      Math.min(FILE_PREVIEW_CHARS, budget.fileCharactersRemaining),
    );
    budget.fileCharactersRemaining -= text.length;
    attachments += estimateTokens(text) + estimateTokens(file.id) + estimateTokens(file.name) + 160;
  }
  return attachments;
};

type TokenCountUsageHolder = {
  metadata?: {
    outputTextTokens?: number;
    totalInputTokens?: number;
    totalOutputTokens?: number;
    usage?: TokenCountUsage;
  } | null;
  usage?: TokenCountUsage | null;
};

const firstPositiveFinite = (...values: unknown[]): number | undefined => {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return value;
    }
  }
  return undefined;
};

const extractInputTokens = (node: TokenCountUsageHolder): number | undefined =>
  firstPositiveFinite(
    node.usage?.totalInputTokens,
    node.metadata?.usage?.totalInputTokens,
    node.metadata?.totalInputTokens,
  );

const extractOutputTextTokens = (node: TokenCountUsageHolder): number | undefined =>
  firstPositiveFinite(
    node.usage?.outputTextTokens,
    node.metadata?.usage?.outputTextTokens,
    node.metadata?.outputTextTokens,
  );

const extractOutputTokens = (node: TokenCountUsageHolder): number | undefined =>
  firstPositiveFinite(
    node.usage?.totalOutputTokens,
    node.metadata?.usage?.totalOutputTokens,
    node.metadata?.totalOutputTokens,
  );

const toTimestampMs = (value: Date | number | string | null | undefined): number | undefined => {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : undefined;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
      const asNumber = Number(trimmed);
      return Number.isFinite(asNumber) ? asNumber : undefined;
    }
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
};

const stripToolCallsOnly = (tools?: TokenCountToolWithResult[]) => {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    apiName: tool.apiName,
    arguments: tool.arguments,
    id: tool.id,
    identifier: tool.identifier,
    ...(tool.thoughtSignature !== undefined && { thoughtSignature: tool.thoughtSignature }),
    type: tool.type,
  }));
};

const countAnchorOutgoingTokens = (
  anchor: TokenCountAssistantBlock | TokenCountMessage,
  budget: AttachmentBudget,
): number => {
  const contentTokens = estimateTokens(anchor.content);

  const anchorToolsArray = Array.isArray(anchor.tools)
    ? (anchor.tools as TokenCountToolWithResult[])
    : undefined;
  const anchorToolCalls = 'tool_calls' in anchor ? anchor.tool_calls : undefined;
  const toolCallsPayload = anchorToolsArray
    ? (stripToolCallsOnly(anchorToolsArray) ?? anchorToolCalls)
    : (anchor.tools ?? anchorToolCalls);
  const toolCallTokens = estimateTokens(toolCallsPayload);

  // Provider outputTextTokens (= totalOutputTokens - outputReasoningTokens on OpenAI/Google)
  // already includes tool-call JSON argument tokens, so compare against combined text + tool calls
  // rather than adding toolCallTokens on top of outputTextTokens.
  const serializedOutgoing = contentTokens + toolCallTokens;
  const outputText = extractOutputTextTokens(anchor);
  const outgoingTokens =
    outputText !== undefined && outputText > 0
      ? Math.max(outputText, serializedOutgoing)
      : serializedOutgoing;

  // Only include explicit inline reasoning_content strings kept in active mid-turn context;
  // never inflate with archived reasoning objects or discarded outputReasoningTokens.
  const inlineReasoningTokens =
    typeof anchor.reasoning_content === 'string' ? estimateTokens(anchor.reasoning_content) : 0;

  let toolResultTokens = 0;
  if (anchorToolsArray) {
    for (const tool of anchorToolsArray) {
      if (tool?.result?.content) {
        toolResultTokens += estimateTokens(tool.result.content);
      }
    }
  }

  const attachments = countAttachments(anchor.fileList, budget);

  return outgoingTokens + inlineReasoningTokens + toolResultTokens + attachments;
};

interface InputAnchorHit {
  anchor: TokenCountAssistantBlock | TokenCountMessage;
  childIdx?: number;
  inputTokens: number;
  msgIdx: number;
}

const findLatestInputAnchor = (messages: TokenCountMessage[]): InputAnchorHit | undefined => {
  let lastCompressedIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'compressedGroup') {
      lastCompressedIdx = i;
      break;
    }
  }

  let lastCompressedAt: number | undefined;
  if (lastCompressedIdx >= 0) {
    const group = messages[lastCompressedIdx];
    const groupUpdatedAt = toTimestampMs(group?.updatedAt);
    const groupCreatedAt = toTimestampMs(group?.createdAt);
    if (groupUpdatedAt !== undefined && groupCreatedAt !== undefined) {
      lastCompressedAt = Math.max(groupUpdatedAt, groupCreatedAt);
    } else {
      lastCompressedAt = groupUpdatedAt ?? groupCreatedAt;
    }
  }

  const isFreshAnchor = (
    node: { createdAt?: Date | number | string | null; updatedAt?: Date | number | string | null },
    parentMsg?: {
      createdAt?: Date | number | string | null;
      updatedAt?: Date | number | string | null;
    },
  ): boolean => {
    if (lastCompressedAt === undefined) return true;
    const anchorAt =
      toTimestampMs(node.updatedAt) ??
      toTimestampMs(node.createdAt) ??
      toTimestampMs(parentMsg?.updatedAt) ??
      toTimestampMs(parentMsg?.createdAt);
    return anchorAt !== undefined && anchorAt >= lastCompressedAt;
  };

  for (let i = messages.length - 1; i > lastCompressedIdx; i--) {
    const msg = messages[i];
    if (!msg) continue;

    if (
      (msg.role === 'assistantGroup' || msg.role === 'supervisor') &&
      Array.isArray(msg.children)
    ) {
      for (let childIdx = msg.children.length - 1; childIdx >= 0; childIdx--) {
        const child = msg.children[childIdx];
        if (!child || typeof child !== 'object') continue;
        const inputTokens = extractInputTokens(child);
        if (inputTokens !== undefined && isFreshAnchor(child, msg)) {
          return { anchor: child, childIdx, inputTokens, msgIdx: i };
        }
      }
      continue;
    }

    if (msg.role === 'assistant') {
      const inputTokens = extractInputTokens(msg);
      if (inputTokens !== undefined && isFreshAnchor(msg)) {
        return { anchor: msg, inputTokens, msgIdx: i };
      }
    }
  }

  return undefined;
};

const countAssistantGroupTokens = (
  children: TokenCountAssistantBlock[],
  budget: AttachmentBudget,
): number => {
  let groupTotal = 0;

  for (const child of [...children].reverse()) {
    if (!child || typeof child !== 'object') continue;

    const attachments = countAttachments(child.fileList, budget);
    const toolCallsOnly = stripToolCallsOnly(child.tools);
    const serialized =
      estimateTokens(child.content) +
      estimateTokens(toolCallsOnly) +
      estimateTokens(child.reasoning ?? child.reasoning_content);

    const outputTokens = extractOutputTokens(child);
    const assistantTokens =
      outputTokens && outputTokens > 0 ? Math.max(outputTokens, serialized) : serialized;

    // Tool results are input tokens sent as separate role='tool' messages after flattening;
    // count tool.result.content separately and never include internal tool.result.state.
    let toolResultTokens = 0;
    if (Array.isArray(child.tools)) {
      for (const tool of child.tools) {
        if (tool?.result?.content) {
          toolResultTokens += estimateTokens(tool.result.content);
        }
      }
    }

    groupTotal += assistantTokens + toolResultTokens + attachments;
  }

  return groupTotal;
};

const countMessagesWithBudget = (
  messages: TokenCountMessage[],
  budget: AttachmentBudget,
): number => {
  return [...messages].reverse().reduce((total, msg) => {
    if (!msg) return total;

    // Virtual assistantGroup / supervisor nodes flatten into child assistant + tool sequences.
    // Never count top-level msg.usage (sum of children) or raw child.tools (includes result.state).
    if (
      (msg.role === 'assistantGroup' || msg.role === 'supervisor') &&
      Array.isArray(msg.children)
    ) {
      return total + countAssistantGroupTokens(msg.children, budget);
    }

    // Compressed summaries only send top-level summary content, never archived compressedMessages.
    if (msg.role === 'compressedGroup') {
      return total + estimateTokens(msg.content);
    }

    if ((msg.role === 'tasks' || msg.role === 'groupTasks') && Array.isArray(msg.tasks)) {
      return total + countMessagesWithBudget(msg.tasks, budget);
    }

    if (msg.role === 'agentCouncil' && Array.isArray(msg.members)) {
      return total + countMessagesWithBudget(msg.members, budget);
    }

    if (msg.role === 'compare' && Array.isArray(msg.columns)) {
      const activeColumn =
        (msg.activeColumnId
          ? msg.columns.find((col) => col.some((item) => item?.id === msg.activeColumnId))
          : undefined) ?? msg.columns[0];
      return (
        total + (Array.isArray(activeColumn) ? countMessagesWithBudget(activeColumn, budget) : 0)
      );
    }

    const attachments = countAttachments(msg.fileList, budget);
    const serialized =
      estimateTokens(msg.content) +
      estimateTokens(msg.tools ?? msg.tool_calls) +
      estimateTokens(msg.reasoning ?? msg.reasoning_content);

    // For assistant messages, prefer the recorded token count from usage metadata
    if (msg.role === 'assistant') {
      const outputTokens = extractOutputTokens(msg);
      if (outputTokens && outputTokens > 0) {
        return total + Math.max(outputTokens, serialized) + attachments;
      }
    }

    // For user/system messages or assistant messages without usage data, estimate tokens
    return total + serialized + attachments;
  }, 0);
};

/**
 * Calculate total token count for a list of messages
 * - Prefers provider-reported `totalInputTokens` from the latest fresh post-compaction
 *   assistant step as an exact anchor, adding only the post-anchor delta
 * - Falls back to Cyrillic-aware heuristic estimation (`countMessagesWithBudget`) when
 *   no valid/fresh anchor exists
 *
 * @param messages - List of messages to count tokens for
 * @returns Total token count
 */
export function calculateMessageTokens(messages: TokenCountMessage[]): number {
  // Match the prompt's bounded attachment previews. Never estimate the entire stored file.
  const budget: AttachmentBudget = { fileCharactersRemaining: FILE_CONTEXT_CHARS };

  const anchorHit = findLatestInputAnchor(messages);
  if (anchorHit) {
    // Count newest-to-oldest so bounded attachment previews prioritize the most recent messages.
    const trailingMessagesTokens = countMessagesWithBudget(
      messages.slice(anchorHit.msgIdx + 1),
      budget,
    );
    const anchorMsg = messages[anchorHit.msgIdx];
    const trailingChildrenTokens =
      anchorHit.childIdx !== undefined && Array.isArray(anchorMsg.children)
        ? countAssistantGroupTokens(anchorMsg.children.slice(anchorHit.childIdx + 1), budget)
        : 0;
    const anchorOutgoingTokens = countAnchorOutgoingTokens(anchorHit.anchor, budget);

    return (
      anchorHit.inputTokens + anchorOutgoingTokens + trailingChildrenTokens + trailingMessagesTokens
    );
  }

  return countMessagesWithBudget(messages, budget);
}

/** Count the assembled text and tool schemas; binary image URLs are not text tokens. */
export function calculatePromptTokens(messages: TokenCountMessage[], tools?: unknown): number {
  const normalized = messages.map((message) => ({
    role: message.role,
    content: Array.isArray(message.content)
      ? message.content
          .map((part: unknown) => {
            if (!part || typeof part !== 'object') return '';
            if ('text' in part && typeof part.text === 'string') return part.text;
            if ('thinking' in part && typeof part.thinking === 'string') return part.thinking;
            return '';
          })
          .join('\n')
      : message.content,
    tool_calls: message.tool_calls,
  }));
  return calculateMessageTokens(normalized) + estimateTokens(tools) + messages.length * 4;
}

/**
 * Calculate the compression threshold based on max context window
 * @param options - Token count options
 * @returns Compression threshold in tokens
 */
export function getCompressionThreshold(options: TokenCountOptions = {}): number {
  const maxContext = options.maxWindowToken ?? DEFAULT_MAX_CONTEXT;
  const ratio = options.thresholdRatio ?? DEFAULT_THRESHOLD_RATIO;
  return Math.floor(maxContext * ratio);
}

/**
 * Result of compression check
 */
export interface CompressionCheckResult {
  /** Current total token count */
  currentTokenCount: number;
  /** Whether compression is needed */
  needsCompression: boolean;
  /** Compression threshold */
  threshold: number;
}

/**
 * Check if messages need compression based on token count
 * @param messages - List of messages to check
 * @param options - Token count options
 * @returns Compression check result
 */
export function shouldCompress(
  messages: TokenCountMessage[],
  options: TokenCountOptions = {},
): CompressionCheckResult {
  const currentTokenCount = calculateMessageTokens(messages);
  const threshold = getCompressionThreshold(options);

  return {
    currentTokenCount,
    needsCompression: currentTokenCount > threshold,
    threshold,
  };
}
