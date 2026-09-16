import { FILE_CONTEXT_CHARS, FILE_PREVIEW_CHARS } from '@lobechat/prompts';
import { estimateTokenCount } from 'tokenx';

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
 * Message interface for token counting
 */
export interface TokenCountMessage {
  content?: string | unknown;
  fileList?: { content?: string | null; id?: string; name?: string }[];
  metadata?: {
    usage?: {
      totalOutputTokens?: number;
    };
  } | null;
  reasoning?: unknown;
  role: string;
  tool_calls?: unknown;
  tools?: unknown;
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
  return estimateTokenCount(text);
}

/**
 * Calculate total token count for a list of messages
 * - Assistant messages: Use metadata.usage.totalOutputTokens if available (exact value)
 * - User/System messages: Use tokenx estimation
 *
 * @param messages - List of messages to count tokens for
 * @returns Total token count
 */
export function calculateMessageTokens(messages: TokenCountMessage[]): number {
  // Match the prompt's bounded attachment previews. Never estimate the entire stored file.
  let fileCharactersRemaining = FILE_CONTEXT_CHARS;
  return [...messages].reverse().reduce((total, msg) => {
    let attachments = 0;
    for (const file of msg.fileList || []) {
      const text = (file.content || '').slice(
        0,
        Math.min(FILE_PREVIEW_CHARS, fileCharactersRemaining),
      );
      fileCharactersRemaining -= text.length;
      attachments +=
        estimateTokens(text) + estimateTokens(file.id) + estimateTokens(file.name) + 160;
    }
    const serialized =
      estimateTokens(msg.content) +
      estimateTokens(msg.tools ?? msg.tool_calls) +
      estimateTokens(msg.reasoning);
    // For assistant messages, prefer the recorded token count from usage metadata
    if (msg.role === 'assistant') {
      const outputTokens = msg.metadata?.usage?.totalOutputTokens;
      if (outputTokens && outputTokens > 0) {
        return total + Math.max(outputTokens, serialized) + attachments;
      }
    }

    // For user/system messages or assistant messages without usage data, estimate tokens
    return total + serialized + attachments;
  }, 0);
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
