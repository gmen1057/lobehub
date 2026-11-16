import type { ChatStreamPayload } from '../../types';

interface Qwen4Parameters {
  enable_thinking?: boolean;
  max_completion_tokens?: number;
  preserve_thinking?: boolean;
  thinking_budget?: number;
}

/** Qwen4 uses effort as well as an independent thinking switch; Qwen3 keeps its budget mapping. */
export const qwen4Payload = (payload: ChatStreamPayload) => {
  const native = payload as ChatStreamPayload & Qwen4Parameters;
  const enabled =
    native.enable_thinking !== false &&
    payload.reasoning_effort !== 'none' &&
    payload.thinking?.type !== 'disabled';
  const effort = payload.reasoning_effort;
  const aliases = { max: 'xhigh', medium: 'high', minimal: 'low' } as const;
  const outputLimit = enabled ? 262_144 : 131_072;

  return {
    enable_thinking: enabled,
    ...(native.max_completion_tokens !== undefined && {
      max_completion_tokens: Math.min(native.max_completion_tokens, outputLimit),
    }),
    ...(payload.max_tokens !== undefined && {
      max_tokens: Math.min(payload.max_tokens, outputLimit),
    }),
    messages: payload.messages.map((message) => {
      const { reasoning, ...rest } = message;
      if (message.role !== 'assistant') return rest;
      const existing = (message as unknown as { reasoning_content?: string }).reasoning_content;
      const content = typeof existing === 'string' ? existing : reasoning?.content;
      return content === undefined ? rest : { ...rest, reasoning_content: content };
    }),
    preserve_thinking: native.preserve_thinking ?? true,
    reasoning_effort:
      enabled && effort && effort !== 'none'
        ? (aliases[effort as keyof typeof aliases] ?? effort)
        : undefined,
    thinking_budget: enabled
      ? (native.thinking_budget ?? payload.thinking?.budget_tokens)
      : undefined,
  };
};
