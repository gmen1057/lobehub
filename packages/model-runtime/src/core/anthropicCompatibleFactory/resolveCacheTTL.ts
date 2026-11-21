import type Anthropic from '@anthropic-ai/sdk';

import type { ChatStreamPayload } from '../../types';
import type { AnthropicCacheTTL } from '../contextBuilders/anthropic';

export type CacheTTL = AnthropicCacheTTL;

export type AnthropicCachePayload = ChatStreamPayload & {
  cacheTTL?: CacheTTL;
};

const DEFAULT_CACHE_TTL: CacheTTL = '5m';
const LONG_CONTEXT_CACHE_TTL: CacheTTL = '1h';

export const LONG_CONTEXT_CACHE_TTL_THRESHOLD_TOKENS = 30_000;
export const IMAGE_TOKEN_ESTIMATE = 1_600;
export const MEDIA_TOKEN_ESTIMATE = 1_600;

const MESSAGE_OVERHEAD_TOKENS = 4;
const MAX_ESTIMATE_DEPTH = 32;
const BASE64_MARKER = ';base64,';
const BASE64_MARKER_UPPER = ';BASE64,';
const MIN_BASE64_PAYLOAD_CHARS = 64;
const MAX_DATA_URI_HEADER_CHARS = 256;

// Validated only on the short (<=256 char) slice between `data:` and `;base64,`,
// allowing optional MIME parameters such as `;charset=utf-8` or `;name=...`.
const DATA_URI_HEADER_RE = /^(?:([a-z0-9.+-]+\/[a-z0-9.+-]+)(?:;[^\s"'<>()[\]{}]+)?)?$/i;

const isValidCacheTTL = (value: unknown): value is CacheTTL => value === '5m' || value === '1h';

const isBase64PayloadChar = (code: number): boolean =>
  (code >= 65 && code <= 90) || // A-Z
  (code >= 97 && code <= 122) || // a-z
  (code >= 48 && code <= 57) || // 0-9
  code === 43 || // +
  code === 47 || // /
  code === 61 || // =
  code === 45 || // -
  code === 95; // _

const findNextBase64Marker = (text: string, from: number): number => {
  const lower = text.indexOf(BASE64_MARKER, from);
  const upper = text.indexOf(BASE64_MARKER_UPPER, from);
  if (lower === -1) return upper;
  if (upper === -1) return lower;
  return Math.min(lower, upper);
};

const estimatePlainTextRangeTokens = (text: string, start: number, end: number): number => {
  if (end <= start) return 0;

  // Quarter-token weight units (4 units = 1 token):
  // - ASCII / Latin (<= 0x007F): ~4 chars/token (English, code, JSON)
  // - Non-Latin BMP scripts (0x0080..0x2E7F, incl. Cyrillic): ~2 chars/token
  // - CJK / full-width / emoji (>= 0x2E80): ~1 char/token
  let quarterTokens = 0;
  for (let i = start; i < end; i++) {
    const code = text.charCodeAt(i);
    if (code <= 0x00_7f) {
      quarterTokens += 1;
    } else if (code < 0x2e_80) {
      quarterTokens += 2;
    } else {
      quarterTokens += 4;
    }
  }

  return Math.ceil(quarterTokens / 4);
};

const estimatePlainTextTokens = (text: string): number =>
  estimatePlainTextRangeTokens(text, 0, text.length);

const estimateTextTokens = (text: string | null | undefined): number => {
  if (!text) return 0;

  let markerIdx = findNextBase64Marker(text, 0);
  if (markerIdx === -1) {
    return estimatePlainTextRangeTokens(text, 0, text.length);
  }

  // Linear O(n)-time, O(1)-stack scanner so multi-megabyte inline data URIs
  // cannot trigger V8 regex stack overflow.
  let tokens = 0;
  let cursor = 0;

  while (markerIdx !== -1) {
    const payloadStart = markerIdx + BASE64_MARKER.length;
    let payloadEnd = payloadStart;
    while (payloadEnd < text.length && isBase64PayloadChar(text.charCodeAt(payloadEnd))) {
      payloadEnd += 1;
    }

    const windowStart = Math.max(cursor, markerIdx - MAX_DATA_URI_HEADER_CHARS);
    const headerWindow = text.slice(windowStart, markerIdx);
    const relativeDataIdx = headerWindow.toLowerCase().lastIndexOf('data:');

    if (relativeDataIdx !== -1 && payloadEnd - payloadStart >= MIN_BASE64_PAYLOAD_CHARS) {
      const dataStart = windowStart + relativeDataIdx;
      const header = text.slice(dataStart + 5, markerIdx);
      const headerMatch = DATA_URI_HEADER_RE.exec(header);

      if (headerMatch) {
        tokens += estimatePlainTextRangeTokens(text, cursor, dataStart);
        const mimeType = headerMatch[1]?.toLowerCase() ?? '';
        tokens += mimeType.startsWith('image/') ? IMAGE_TOKEN_ESTIMATE : MEDIA_TOKEN_ESTIMATE;
        cursor = payloadEnd;
        markerIdx = findNextBase64Marker(text, payloadEnd);
        continue;
      }
    }

    markerIdx = findNextBase64Marker(text, payloadEnd);
  }

  tokens += estimatePlainTextRangeTokens(text, cursor, text.length);
  return tokens;
};

const estimateStructuredValueTokens = (
  value: unknown,
  depth = 0,
  visited = new Set<object>(),
): number => {
  if (value === null || value === undefined || depth > MAX_ESTIMATE_DEPTH) return 0;

  if (typeof value === 'string') return estimateTextTokens(value);
  if (typeof value === 'number' || typeof value === 'boolean') {
    return estimatePlainTextTokens(String(value));
  }
  if (typeof value !== 'object') return 0;

  if (visited.has(value)) return 0;
  visited.add(value);

  try {
    if (Array.isArray(value)) {
      let total = 0;
      for (const item of value) {
        total += estimateStructuredValueTokens(item, depth + 1, visited);
      }
      return total;
    }

    const record = value as Record<string, unknown>;
    const rawType = typeof record.type === 'string' ? record.type.toLowerCase() : '';

    // Never count raw base64/URL payload bytes for binary image/media/document parts.
    if (rawType === 'image_url' || rawType === 'image' || rawType === 'input_image') {
      return IMAGE_TOKEN_ESTIMATE;
    }

    if (rawType === 'video_url' || rawType === 'audio_url' || rawType === 'input_audio') {
      return MEDIA_TOKEN_ESTIMATE;
    }

    if (rawType === 'document' || rawType === 'file' || rawType === 'input_file') {
      const source =
        record.source && typeof record.source === 'object'
          ? (record.source as Record<string, unknown>)
          : undefined;
      if (source?.type === 'text' && typeof source.data === 'string') {
        return estimateTextTokens(source.data);
      }
      if (typeof record.text === 'string') {
        return estimateTextTokens(record.text);
      }
      return MEDIA_TOKEN_ESTIMATE;
    }

    if (rawType === 'text' && typeof record.text === 'string') {
      return estimateTextTokens(record.text);
    }

    if (rawType === 'thinking') {
      return typeof record.thinking === 'string' ? estimateTextTokens(record.thinking) : 0;
    }

    if (rawType === 'redacted_thinking') {
      return 0;
    }

    if (rawType === 'tool_result') {
      return estimateStructuredValueTokens(record.content, depth + 1, visited);
    }

    if (rawType === 'tool_use') {
      return (
        estimateTextTokens(typeof record.name === 'string' ? record.name : undefined) +
        estimateStructuredValueTokens(record.input, depth + 1, visited)
      );
    }

    // Fallback guard for bare Anthropic base64 source objects inside unexpected wrappers.
    if (record.type === 'base64' && typeof record.data === 'string') {
      const mediaType =
        typeof record.media_type === 'string' ? record.media_type.toLowerCase() : '';
      return mediaType.startsWith('image/') ? IMAGE_TOKEN_ESTIMATE : MEDIA_TOKEN_ESTIMATE;
    }

    let total = 0;
    for (const [key, val] of Object.entries(record)) {
      if (key === 'signature' || key === 'thoughtSignature' || key === 'thought_signature') {
        continue;
      }
      total += estimatePlainTextTokens(key);
      total += estimateStructuredValueTokens(val, depth + 1, visited);
    }
    return total;
  } finally {
    visited.delete(value);
  }
};

/**
 * Estimate total input tokens (system + messages + tools) for Anthropic cache TTL selection.
 * Binary base64 images/documents use a fixed token estimate instead of raw byte length.
 */
export const estimateAnthropicInputTokens = (
  payload: Pick<ChatStreamPayload, 'messages' | 'tools'>,
): number => {
  let total = 0;

  const messages = payload.messages ?? [];
  const systemMessage = messages.find((message) => message.role === 'system');
  if (typeof systemMessage?.content === 'string' && systemMessage.content.trim()) {
    total += estimateTextTokens(systemMessage.content) + MESSAGE_OVERHEAD_TOKENS;
  }

  for (const message of messages) {
    if (message.role === 'system') continue;

    total += MESSAGE_OVERHEAD_TOKENS;

    if (typeof message.content === 'string') {
      total += estimateTextTokens(message.content);
    } else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        total += estimateStructuredValueTokens(part);
      }
    }

    if (message.tool_calls?.length) {
      for (const call of message.tool_calls) {
        total += MESSAGE_OVERHEAD_TOKENS;
        total += estimateTextTokens(call.function?.name);
        total += estimateTextTokens(call.function?.arguments);
      }
    }
  }

  if (payload.tools?.length) {
    for (const tool of payload.tools) {
      total += estimateStructuredValueTokens(tool);
    }
  }

  return total;
};

/**
 * Select a single uniform cache TTL for all Anthropic cache breakpoints in a request
 * (tools, system, messages) so TTL ordering never violates Anthropic's monotonic rule.
 *
 * - Returns `undefined` when `enabledContextCaching === false`.
 * - Preserves explicit `payload.cacheTTL` (`'5m' | '1h'`) when provided.
 * - Automatically selects `'1h'` when estimated input tokens >= 30K, otherwise `'5m'`.
 */
export const selectAnthropicCacheTTL = (
  payload: Pick<AnthropicCachePayload, 'cacheTTL' | 'enabledContextCaching' | 'messages' | 'tools'>,
): CacheTTL | undefined => {
  if (payload.enabledContextCaching === false) {
    return undefined;
  }

  if (isValidCacheTTL(payload.cacheTTL)) {
    return payload.cacheTTL;
  }

  return estimateAnthropicInputTokens(payload) >= LONG_CONTEXT_CACHE_TTL_THRESHOLD_TOKENS
    ? LONG_CONTEXT_CACHE_TTL
    : DEFAULT_CACHE_TTL;
};

/**
 * Resolves cache TTL from Anthropic payload or request settings.
 * Returns the first explicit TTL found in system, tools, or message blocks.
 */
export const resolveCacheTTL = (
  requestPayload: AnthropicCachePayload,
  anthropicPayload: {
    messages: Anthropic.MessageCreateParams['messages'];
    system: Anthropic.MessageCreateParams['system'];
    tools?: Anthropic.MessageCreateParams['tools'];
  },
): CacheTTL | undefined => {
  let hasEphemeralCacheControl = false;

  // Check system messages for cache TTL
  if (Array.isArray(anthropicPayload.system)) {
    for (const block of anthropicPayload.system) {
      const ttl = block.cache_control?.ttl;
      if (ttl) return ttl;
      if (block.cache_control?.type === 'ephemeral') hasEphemeralCacheControl = true;
    }
  }

  // Check tool definitions for cache TTL
  if (Array.isArray(anthropicPayload.tools)) {
    for (const tool of anthropicPayload.tools) {
      const cacheControl = 'cache_control' in tool ? tool.cache_control : undefined;
      if (cacheControl?.ttl) return cacheControl.ttl;
      if (cacheControl?.type === 'ephemeral') hasEphemeralCacheControl = true;
    }
  }

  // Check message content blocks for cache TTL
  for (const message of anthropicPayload.messages ?? []) {
    if (!Array.isArray(message.content)) continue;

    for (const block of message.content) {
      // Message content blocks might have cache_control property
      const cacheControl = ('cache_control' in block ? block.cache_control : undefined) as
        Anthropic.Messages.CacheControlEphemeral | null | undefined;
      if (cacheControl?.ttl) return cacheControl.ttl;
      if (cacheControl?.type === 'ephemeral') hasEphemeralCacheControl = true;
    }
  }

  if (requestPayload.enabledContextCaching === false) {
    return undefined;
  }

  if (hasEphemeralCacheControl) {
    return DEFAULT_CACHE_TTL;
  }

  // Use explicit or default TTL if context caching is enabled
  if (requestPayload.enabledContextCaching) {
    return isValidCacheTTL(requestPayload.cacheTTL) ? requestPayload.cacheTTL : DEFAULT_CACHE_TTL;
  }

  return undefined;
};
