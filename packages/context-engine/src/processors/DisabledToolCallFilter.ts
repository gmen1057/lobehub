import debug from 'debug';
import { Md5 } from 'ts-md5';

import { BaseProcessor } from '../base/BaseProcessor';
import type { Message, PipelineContext, ProcessorOptions } from '../types';
import { isEmptyOrPlaceholderAssistantMessage } from './PlaceholderMessageFilter';

declare module '../types' {
  interface PipelineContextMetadataOverrides {
    disabledToolCallFilter?: {
      filteredAssistantMessages: number;
      filteredToolCalls: number;
    };
  }
}

const log = debug('context-engine:processor:DisabledToolCallFilter');

export interface DisabledToolCallFilterConfig {
  disabledToolIdentifiers?: string[];
}

const TOOL_NAME_SEPARATOR = '____';
const PLUGIN_SCHEMA_API_MD5_PREFIX = 'MD5HASH_';

const genIdentifierHash = (identifier: string): string =>
  `${PLUGIN_SCHEMA_API_MD5_PREFIX}${Md5.hashStr(identifier).toString().slice(0, 12)}`;

const buildDisabledNameTokens = (disabledToolIdentifiers: Set<string>): Set<string> => {
  const tokens = new Set<string>();
  for (const identifier of disabledToolIdentifiers) {
    if (!identifier) continue;
    tokens.add(identifier);
    tokens.add(genIdentifierHash(identifier));
  }
  return tokens;
};

const isDisabledToolName = (name: string | undefined, disabledNameTokens: Set<string>): boolean => {
  if (!name) return false;

  for (const token of disabledNameTokens) {
    if (name === token || name.startsWith(`${token}${TOOL_NAME_SEPARATOR}`)) {
      return true;
    }
  }

  return false;
};

/**
 * Removes historical tool calls for tools that are not valid in the current runtime scope.
 *
 * Some models infer tool names from prior assistant/tool messages even when the current
 * request's `tools` schema no longer contains that tool. Filtering the historical call
 * removes that imitation path; ToolMessageReorder will then drop the orphaned tool result.
 * If removing disabled tool calls leaves an assistant message completely empty (no remaining
 * tools/tool_calls, text, reasoning, or media), the emptied assistant message is dropped too.
 */
export class DisabledToolCallFilter extends BaseProcessor {
  readonly name = 'DisabledToolCallFilter';

  constructor(
    private config: DisabledToolCallFilterConfig,
    options: ProcessorOptions = {},
  ) {
    super(options);
  }

  protected async doProcess(context: PipelineContext): Promise<PipelineContext> {
    const disabledToolIdentifiers = new Set(
      (this.config.disabledToolIdentifiers ?? []).filter(Boolean),
    );

    if (disabledToolIdentifiers.size === 0) {
      return this.markAsExecuted(context);
    }

    const disabledNameTokens = buildDisabledNameTokens(disabledToolIdentifiers);
    const clonedContext = this.cloneContext(context);
    let filteredAssistantMessages = 0;
    let filteredToolCalls = 0;

    const nextMessages: Message[] = [];

    for (const message of clonedContext.messages) {
      if (message.role !== 'assistant') {
        nextMessages.push(message);
        continue;
      }

      const { nextMessage, removedCount } = this.filterAssistantMessage(
        message,
        disabledToolIdentifiers,
        disabledNameTokens,
      );

      if (nextMessage === message) {
        nextMessages.push(message);
        continue;
      }

      filteredAssistantMessages++;
      filteredToolCalls += removedCount;

      if (isEmptyOrPlaceholderAssistantMessage(nextMessage)) {
        continue;
      }

      nextMessages.push(nextMessage);
    }

    clonedContext.messages = nextMessages;
    clonedContext.metadata.disabledToolCallFilter = {
      filteredAssistantMessages,
      filteredToolCalls,
    };

    if (filteredToolCalls > 0) {
      log(
        'Filtered %d disabled tool calls from %d assistant messages',
        filteredToolCalls,
        filteredAssistantMessages,
      );
    }

    return this.markAsExecuted(clonedContext);
  }

  private filterAssistantMessage(
    message: Message,
    disabledToolIdentifiers: Set<string>,
    disabledNameTokens: Set<string>,
  ): { nextMessage: Message; removedCount: number } {
    let nextMessage = message;
    let removedToolsCount = 0;
    let removedToolCallsCount = 0;
    const removedToolCallIds = new Set<string>();

    if (Array.isArray(message.tools)) {
      const tools = message.tools.filter((tool) => {
        const isDisabled = disabledToolIdentifiers.has(String(tool?.identifier ?? ''));
        if (isDisabled && typeof tool?.id === 'string' && tool.id) {
          removedToolCallIds.add(tool.id);
        }
        return !isDisabled;
      });

      if (tools.length !== message.tools.length) {
        removedToolsCount = message.tools.length - tools.length;
        const messageWithoutTools = { ...nextMessage };
        delete messageWithoutTools.tools;
        nextMessage = tools.length > 0 ? { ...nextMessage, tools } : messageWithoutTools;
      }
    }

    if (Array.isArray(message.tool_calls)) {
      const toolCalls = message.tool_calls.filter((toolCall) => {
        if (typeof toolCall?.id === 'string' && removedToolCallIds.has(toolCall.id)) {
          return false;
        }
        return !isDisabledToolName(toolCall?.function?.name, disabledNameTokens);
      });

      if (toolCalls.length !== message.tool_calls.length) {
        removedToolCallsCount = message.tool_calls.length - toolCalls.length;
        const messageWithoutToolCalls = { ...nextMessage };
        delete messageWithoutToolCalls.tool_calls;
        nextMessage =
          toolCalls.length > 0
            ? { ...nextMessage, tool_calls: toolCalls }
            : messageWithoutToolCalls;
      }
    }

    return {
      nextMessage,
      removedCount: Math.max(removedToolCallsCount, removedToolsCount),
    };
  }
}
