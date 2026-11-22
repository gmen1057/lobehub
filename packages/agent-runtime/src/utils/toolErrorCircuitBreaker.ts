import type { ChatToolPayload } from '@lobechat/types';

import type { ToolErrorCircuitBreakerState } from '../types';

/**
 * Maximum number of consecutive failed attempts on the same tool before tripping forceFinish
 * (1 initial attempt + up to 3 self-correction retries).
 */
export const TOOL_ERROR_CIRCUIT_BREAKER_LIMIT = 4;

/**
 * Synthetic tool identifier used internally for unresolved tool feedback
 * (already capped separately by UNRESOLVED_TOOL_FEEDBACK_LIMIT in RuntimeExecutors).
 */
const UNRESOLVED_TOOL_IDENTIFIER = '__arckep_unresolved_tool__';

/**
 * Fallback user-facing message when the model returns empty content during
 * the final tool-free turn after the tool-error circuit breaker trips.
 */
export const TOOL_ERROR_CIRCUIT_BREAKER_FALLBACK_MESSAGE =
  'Инструмент несколько раз подряд вернул ошибку. Попробуйте уточнить параметры запроса или повторить позже.';

export interface ToolResultLike {
  data?: unknown;
  isSuccess?: boolean;
  result?: unknown;
  synthetic?: boolean;
  toolCall?: Pick<ChatToolPayload, 'apiName' | 'identifier'> | null;
}

export const getToolErrorKey = (
  toolCall?: Pick<ChatToolPayload, 'apiName' | 'identifier'> | null,
): string | undefined => {
  if (!toolCall) return undefined;

  const identifier = toolCall.identifier?.trim();
  const apiName = toolCall.apiName?.trim();

  if (!identifier && !apiName) return undefined;
  if (!identifier) return apiName;
  if (!apiName) return identifier;

  return `${identifier}::${apiName}`;
};

/**
 * Determine whether a tool execution result represents an error.
 *
 * Covers both:
 * - Standard failure flags (`isSuccess === false`, `data.success === false`, `data.error`)
 * - MCP tool/protocol errors (`data.state.isError === true` or `data.isError === true`),
 *   where `ToolExecutionService.executeMCPTool` intentionally keeps `success: true` to
 *   prevent automatic transport-level retries in `executeToolWithRetry`.
 */
export const isToolResultFailure = (result: ToolResultLike | undefined | null): boolean => {
  if (!result) return false;
  if (result.isSuccess === false) return true;

  const payload = result.data ?? result.result;
  if (payload && typeof payload === 'object') {
    const record = payload as {
      error?: unknown;
      isError?: unknown;
      state?: { isError?: unknown } | null;
      success?: unknown;
    };

    if (record.success === false) return true;
    if (record.isError === true) return true;
    if (record.state && typeof record.state === 'object' && record.state.isError === true) {
      return true;
    }
    if (record.error) return true;
  }

  return false;
};

export const isToolErrorCircuitBreakerTripped = (
  breaker: ToolErrorCircuitBreakerState | undefined,
): boolean => breaker?.tripped === true;

/**
 * Update the consecutive tool-error circuit breaker after a single tool call or tool batch.
 *
 * - Synthetic unresolved tool feedback entries are ignored.
 * - Any successful real tool execution resets the counter to 0.
 * - If all real tool executions in the step fail on the same tool (`identifier::apiName`)
 *   and every entry has a valid tool key, the consecutive error counter increments by the
 *   number of failed calls in the batch (or starts at that count when switching tools).
 * - If all fail across multiple different tools or any entry lacks a tool key, the single-tool streak resets to 0.
 * - Once `consecutiveErrors >= limit`, `tripped: true` is set.
 */
export const updateToolErrorCircuitBreaker = (
  previousState: ToolErrorCircuitBreakerState | undefined,
  results: ToolResultLike[],
  limit: number = TOOL_ERROR_CIRCUIT_BREAKER_LIMIT,
): ToolErrorCircuitBreakerState | undefined => {
  const realResults = results.filter(
    (entry) =>
      entry &&
      entry.synthetic !== true &&
      entry.toolCall?.identifier !== UNRESOLVED_TOOL_IDENTIFIER,
  );

  if (realResults.length === 0) return previousState;

  if (realResults.some((entry) => !isToolResultFailure(entry))) {
    return { consecutiveErrors: 0 };
  }

  const toolKeys = realResults
    .map((entry) => getToolErrorKey(entry.toolCall))
    .filter((key): key is string => Boolean(key));
  const uniqueKeys = new Set(toolKeys);

  if (toolKeys.length !== realResults.length || uniqueKeys.size !== 1) {
    return { consecutiveErrors: 0 };
  }

  const [toolKey] = uniqueKeys;
  const consecutiveErrors =
    previousState?.toolKey === toolKey
      ? previousState.consecutiveErrors + realResults.length
      : realResults.length;
  const tripped = consecutiveErrors >= limit;

  return {
    consecutiveErrors,
    toolKey,
    ...(tripped ? { tripped: true } : {}),
  };
};

export const buildToolErrorCircuitBreakerPrompt = (
  breaker?: ToolErrorCircuitBreakerState,
): string => {
  const toolLabel = breaker?.toolKey ? ` "${breaker.toolKey}"` : '';
  const attempts = breaker?.consecutiveErrors ?? TOOL_ERROR_CIRCUIT_BREAKER_LIMIT;

  return `Tool${toolLabel} failed ${attempts} times in a row. Stop retrying this tool, explain the error clearly to the user based on the tool output above, and provide a final response. Do not attempt to call any tools.`;
};
