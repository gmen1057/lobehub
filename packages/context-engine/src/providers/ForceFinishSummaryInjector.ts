import debug from 'debug';

import { BaseProvider } from '../base/BaseProvider';
import type { PipelineContext, ProcessorOptions } from '../types';

declare module '../types' {
  interface PipelineContextMetadataOverrides {
    forceFinishInjected?: boolean;
  }
}

const log = debug('context-engine:provider:ForceFinishSummaryInjector');

export const DEFAULT_FORCE_FINISH_PROMPT =
  'You have reached the maximum step limit for this turn. Respond in the language of the current conversation: clearly summarize what has already been completed, preserve all obtained results, and briefly state what remains so the user can continue in the next message. Do not frame this pause as an error. Do not attempt to use any tools.';

export interface ForceFinishSummaryInjectorConfig {
  enabled: boolean;
  /** Optional custom force-finish system prompt (defaults to max-steps summary prompt) */
  prompt?: string;
}

/**
 * Force Finish Summary Injector
 *
 * When the agent reaches the maximum step limit (forceFinish mode),
 * this processor appends a system message instructing the LLM to
 * summarize progress and produce a final text response without using tools.
 *
 * Should run near the end of the pipeline (before MessageCleanup).
 */
export class ForceFinishSummaryInjector extends BaseProvider {
  readonly name = 'ForceFinishSummaryInjector';

  constructor(
    private config: ForceFinishSummaryInjectorConfig,
    options: ProcessorOptions = {},
  ) {
    super(options);
  }

  protected async doProcess(context: PipelineContext): Promise<PipelineContext> {
    if (!this.config.enabled) {
      return this.markAsExecuted(context);
    }

    log('Injecting force-finish summary prompt');

    const clonedContext = this.cloneContext(context);
    const prompt = this.config.prompt || DEFAULT_FORCE_FINISH_PROMPT;
    const systemMsgIndex = clonedContext.messages.findIndex((m) => m.role === 'system');

    if (systemMsgIndex >= 0) {
      const existing = clonedContext.messages[systemMsgIndex];
      const existingContent = typeof existing.content === 'string' ? existing.content : '';
      clonedContext.messages[systemMsgIndex] = {
        ...existing,
        content: [existingContent, prompt].filter(Boolean).join('\n\n'),
      };
    } else {
      clonedContext.messages.push({
        content: prompt,
        role: 'system' as const,
      });
    }

    clonedContext.metadata.forceFinishInjected = true;

    return this.markAsExecuted(clonedContext);
  }
}
