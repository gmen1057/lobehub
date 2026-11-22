import type { AgentState } from '@lobechat/agent-runtime';

export const CONTINUATION_CONTEXT = '\n\nSaved source file context (data): ';

const privateFunction = (name: unknown) =>
  typeof name === 'string' && /^arckep-text-file(?:____|\/|__).*writePart/.test(name);

// Diagnostic copies only. Runtime messages, tool inputs and stored source are untouched.
export function redactTextFileDiagnostics<T>(value: T): T {
  function clean(item: unknown): unknown {
    if (typeof item === 'string') {
      const boundary = item.indexOf(CONTINUATION_CONTEXT);
      return boundary < 0 ? item : item.slice(0, boundary);
    }
    if (Array.isArray(item)) return item.map(clean);
    if (!item || typeof item !== 'object' || Object.getPrototypeOf(item) !== Object.prototype)
      return item;
    const obj = item as Record<string, unknown>;
    if (
      (obj.identifier === 'arckep-text-file' || privateFunction(obj.name)) &&
      ('arguments' in obj || 'args' in obj)
    )
      return Object.fromEntries(
        Object.entries(obj).filter(([key]) => key !== 'arguments' && key !== 'args'),
      );
    return Object.fromEntries(
      Object.entries(obj).map(([key, value]) => [
        key.startsWith('["arckep-text-file",') ? 'arckep-text-file/writePart' : key,
        clean(value),
      ]),
    );
  }
  return clean(value) as T;
}

export function logTextFileStop(operationId: string, state: AgentState) {
  const checkpoint = state.metadata?.studioTextFileCheckpoint;
  if (!checkpoint || checkpoint.status !== 'draft') return;
  const error = state.error;
  const reasons = [
    state.metadata?.studioTextFileFinish,
    state.interruption?.reason,
    error?.type,
    error?.code,
  ];
  const knownReasons = new Set([
    'user_cancelled',
    'user_aborted',
    'user_requested',
    'max_steps_exceeded',
    'max_steps_completed',
    'cost_limit_exceeded',
    'timeout',
    'queued_message_interrupt',
    'system_shutdown',
    'tool_call_repeat_limit',
    'tool_error_limit',
    'rate_limit_exceeded',
    'insufficient_balance',
    'context_length_exceeded',
    'error_recovery',
  ]);
  const reason =
    reasons.find((reason) => knownReasons.has(reason)) ??
    (state.status === 'done' ? 'model_finished_before_file' : state.status);
  console.info('[text-file]', {
    documentId: checkpoint.documentId,
    lastPart: checkpoint.part,
    operationId,
    reason,
    stage: 'stopped',
    topicId: state.metadata?.topicId,
    userId: state.metadata?.userId,
  });
}
