import { type AgentState, UsageCounter } from '@lobechat/agent-runtime';

import type { RuntimeExecutorContext } from './RuntimeExecutors';

/** Keep already received output and usage without treating Stop as a failed attempt. */
export const persistInterruptedLLM = async (
  ctx: RuntimeExecutorContext,
  state: AgentState,
  result: {
    assistantMessageId: string;
    content: string;
    grounding?: any;
    imageList: any[];
    isMultimodal: boolean;
    model: string;
    provider: string;
    reasoning?: { content: string; isMultimodal?: boolean };
    usage?: any;
  },
) => {
  const newState = structuredClone(state);
  newState.status = 'interrupted';
  newState.interruption = {
    canResume: false,
    interruptedAt: new Date().toISOString(),
    reason: 'user_cancelled',
  };
  newState.messages.push({ content: result.content, role: 'assistant' });
  if (result.usage) {
    const { usage, cost } = UsageCounter.accumulateLLM({
      cost: newState.cost,
      model: result.model,
      modelUsage: result.usage,
      provider: result.provider,
      usage: newState.usage,
    });
    newState.usage = usage;
    if (cost) newState.cost = cost;
  }
  await ctx.messageModel.update(result.assistantMessageId, {
    content: result.content,
    imageList: result.imageList.length ? result.imageList : undefined,
    metadata: {
      ...result.usage,
      finishReason: 'interrupted',
      ...(result.isMultimodal && { isMultimodal: true }),
      usageReported: result.usage !== undefined,
    },
    reasoning: result.reasoning,
    search: result.grounding,
  });
  return { events: [], newState };
};
