import type { persistInterruptedLLM } from './persistInterruptedLLM';
import type { RuntimeExecutorContext } from './RuntimeExecutors';

/** Keep received output before the caller persists the safe terminal error. */
export const persistFailedLLM = async (
  ctx: RuntimeExecutorContext,
  result: Parameters<typeof persistInterruptedLLM>[2],
) => {
  await ctx.messageModel.update(result.assistantMessageId, {
    content: result.content,
    imageList: result.imageList.length ? result.imageList : undefined,
    metadata: {
      ...result.usage,
      finishReason: 'error',
      ...(result.isMultimodal && { isMultimodal: true }),
      usageReported: result.usage !== undefined,
    },
    reasoning: result.reasoning,
    search: result.grounding,
  });
};
