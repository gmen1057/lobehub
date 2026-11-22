// Mirrors LOADING_FLAT from @lobechat/const (not a dependency of @lobechat/agent-runtime).
const LOADING_FLAT = '...';

export interface ActiveTurnMessage {
  content?: unknown;
  id?: string;
  imageList?: unknown;
  reasoning?: unknown;
  reasoning_content?: unknown;
  role?: string;
  tool_calls?: unknown;
  tools?: unknown;
}

/**
 * Matches empty or loading (`'...'`) assistant placeholders that carry no text, tools,
 * reasoning, or images. Kept in sync with `RuntimeExecutors.compress_context` so
 * `hasCompressibleHistory` never schedules a skipped compression step for historical DB stubs.
 */
export const isEmptyAssistantPlaceholder = (
  message: ActiveTurnMessage | null | undefined,
): boolean => {
  if (message?.role !== 'assistant') return false;
  if (
    message.content !== undefined &&
    message.content !== null &&
    typeof message.content !== 'string'
  ) {
    return false;
  }
  const text = typeof message.content === 'string' ? message.content.trim() : '';
  if (text !== '' && text !== LOADING_FLAT) return false;
  const hasTools =
    (Array.isArray(message.tools) && message.tools.length > 0) ||
    (Array.isArray(message.tool_calls) && message.tool_calls.length > 0);
  const hasReasoning = Boolean(
    (typeof message.reasoning === 'string'
      ? message.reasoning.trim()
      : (message.reasoning as { content?: string } | null | undefined)?.content?.trim?.()) ||
    (typeof message.reasoning_content === 'string' ? message.reasoning_content.trim() : ''),
  );
  const hasImages = Array.isArray(message.imageList) && message.imageList.length > 0;
  return !hasTools && !hasReasoning && !hasImages;
};

const isSyntheticContinuationUserPrompt = (message: ActiveTurnMessage): boolean => {
  if (message.role !== 'user' || message.id) return false;
  if (typeof message.content !== 'string') return false;
  return (
    message.content.startsWith('All tasks above have been completed.') ||
    message.content.includes('Исправь синтаксическую ошибку') ||
    message.content.includes(
      'В твоём предыдущем ответе вместо реального кода оказался пустой служебный тег',
    )
  );
};

/**
 * Locate the start index of the active user turn in a message list.
 *
 * When any persisted `role === 'user'` message (with an `id`) exists, synthetic
 * trailing user prompts without an `id` (such as HTML syntax repair prompts or
 * `tasks_batch_result` continuation prompts) are ignored so the active turn boundary
 * stays anchored at the real user prompt.
 *
 * When no user message carries an `id` (e.g. unit test fixtures), falls back to the
 * last non-synthetic `role === 'user'` message, or the last `role === 'user'` message
 * if only synthetic ones exist.
 */
export function findActiveTurnStartIndex(messages: readonly ActiveTurnMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role === 'user' && Boolean(msg.id)) return i;
  }

  let fallbackLastUser = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== 'user') continue;
    if (fallbackLastUser === -1) fallbackLastUser = i;
    if (!isSyntheticContinuationUserPrompt(msg)) return i;
  }

  return fallbackLastUser;
}

/**
 * Check whether there is prior history before the active turn that can be compressed
 * (or legacy stacked `compressedGroup` nodes >= 2 that should be consolidated into one
 * rolling summary).
 *
 * Returns `false` for single-turn conversations so Turn 1 never triggers an infinite
 * `compress_context` loop. When no `role === 'user'` message is present, falls back to
 * checking whether any non-`compressedGroup` message or >= 2 `compressedGroup`s exist.
 */
export function hasCompressibleHistory(messages: readonly ActiveTurnMessage[]): boolean {
  const activeTurnStart = findActiveTurnStartIndex(messages);
  const candidateHistory = activeTurnStart >= 0 ? messages.slice(0, activeTurnStart) : messages;

  let compressedGroupCount = 0;
  for (const msg of candidateHistory) {
    if (!msg?.role) continue;
    if (msg.role === 'compressedGroup') {
      compressedGroupCount += 1;
      if (compressedGroupCount >= 2) return true;
      continue;
    }
    if (isEmptyAssistantPlaceholder(msg)) continue;
    return true;
  }

  return false;
}
