import debug from 'debug';

import { BaseProcessor } from '../base/BaseProcessor';
import type { Message, PipelineContext, ProcessorOptions } from '../types';

declare module '../types' {
  interface PipelineContextMetadataOverrides {
    placeholderMessageFilter?: {
      filteredCount: number;
    };
  }
}

const log = debug('context-engine:processor:PlaceholderMessageFilter');

const PLACEHOLDER_LOADING_FLAT = '...';

const hasNonEmptyReasoning = (message: Message): boolean => {
  const { reasoning, reasoning_content } = message;

  if (typeof reasoning_content === 'string' && reasoning_content.trim().length > 0) {
    return true;
  }

  if (typeof reasoning === 'string') {
    return reasoning.trim().length > 0;
  }

  if (typeof reasoning === 'object' && reasoning !== null) {
    if (Boolean(reasoning.isMultimodal)) {
      return true;
    }

    if (typeof reasoning.signature === 'string' && reasoning.signature.trim().length > 0) {
      return true;
    }

    if (typeof reasoning.content === 'string' && reasoning.content.trim().length > 0) {
      return true;
    }

    if (Array.isArray(reasoning.content) && reasoning.content.length > 0) {
      return true;
    }
  }

  return false;
};

const hasEmptyOrPlaceholderContent = (message: Message): boolean => {
  if (message.content === undefined || message.content === null) {
    return true;
  }

  if (typeof message.content !== 'string') {
    return Array.isArray(message.content) && message.content.length === 0;
  }

  const text = message.content.trim();
  return text === '' || text === PLACEHOLDER_LOADING_FLAT;
};

/**
 * Checks whether an assistant message has no meaningful content, tool calls, reasoning, or media.
 */
export const isEmptyOrPlaceholderAssistantMessage = (message: Message): boolean => {
  if (message.role !== 'assistant') {
    return false;
  }

  if (Boolean(message.metadata?.isMultimodal)) {
    return false;
  }

  if (!hasEmptyOrPlaceholderContent(message)) {
    return false;
  }

  const hasTools =
    (Array.isArray(message.tools) && message.tools.length > 0) ||
    (Array.isArray(message.tool_calls) && message.tool_calls.length > 0);
  if (hasTools) {
    return false;
  }

  if (hasNonEmptyReasoning(message)) {
    return false;
  }

  const hasMedia =
    (Array.isArray(message.imageList) && message.imageList.length > 0) ||
    (Array.isArray(message.fileList) && message.fileList.length > 0) ||
    (Array.isArray(message.videoList) && message.videoList.length > 0);
  if (hasMedia) {
    return false;
  }

  return true;
};

/**
 * Removes empty or placeholder (`"..."`) assistant stubs from historical messages
 * before orchestration, content encoding, and wire cleanup so `messageSourceIds`
 * stay 1:1 aligned with processed wire messages.
 */
export class PlaceholderMessageFilter extends BaseProcessor {
  readonly name = 'PlaceholderMessageFilter';

  constructor(options: ProcessorOptions = {}) {
    super(options);
  }

  protected async doProcess(context: PipelineContext): Promise<PipelineContext> {
    const clonedContext = this.cloneContext(context);
    let filteredCount = 0;

    clonedContext.messages = clonedContext.messages.filter((message) => {
      if (isEmptyOrPlaceholderAssistantMessage(message)) {
        filteredCount++;
        return false;
      }

      return true;
    });

    clonedContext.metadata.placeholderMessageFilter = {
      filteredCount,
    };

    if (filteredCount > 0) {
      log('Filtered %d placeholder assistant messages', filteredCount);
    }

    return this.markAsExecuted(clonedContext);
  }
}
