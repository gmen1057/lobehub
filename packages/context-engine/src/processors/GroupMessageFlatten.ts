import debug from 'debug';

import { BaseProcessor } from '../base/BaseProcessor';
import type { PipelineContext, ProcessorOptions } from '../types';

declare module '../types' {
  interface PipelineContextMetadataOverrides {
    assistantMessagesCreated?: number;
    groupMessagesFlattened?: number;
    groupMessagesFlattenProcessed?: number;
    toolMessagesCreated?: number;
  }
}

const log = debug('context-engine:processor:GroupMessageFlattenProcessor');

const toTimestampMs = (val: unknown): number => {
  if (typeof val === 'number') return Number.isFinite(val) ? val : 0;
  if (val instanceof Date) {
    const ms = val.getTime();
    return Number.isFinite(ms) ? ms : 0;
  }
  if (typeof val === 'string' && val.trim().length > 0) {
    const asNum = Number(val);
    if (Number.isFinite(asNum)) return asNum;
    const ms = new Date(val).getTime();
    return Number.isFinite(ms) ? ms : 0;
  }
  return 0;
};

/**
 * Hydrates virtual group nodes (`assistantGroup`, `supervisor`) returned by
 * `@lobechat/conversation-flow`'s `parse(latestMessages)` with per-message timestamps
 * and metadata from the flat source rows so `GroupMessageFlattenProcessor` produces
 * byte-identical messages to flat DB rows on Step 0.
 */
export const hydrateGroupMessages = <T extends Record<string, any>>(
  flatList: T[],
  sourceMessages: any[],
): T[] => {
  if (!Array.isArray(flatList) || flatList.length === 0 || !Array.isArray(sourceMessages)) {
    return flatList;
  }

  const byId = new Map<string, any>();
  for (const src of sourceMessages) {
    if (src && typeof src.id === 'string' && src.id) {
      byId.set(src.id, src);
    }
  }
  if (byId.size === 0) return flatList;

  return flatList.map((msg) => {
    if (
      !msg ||
      (msg.role !== 'assistantGroup' && msg.role !== 'supervisor') ||
      !Array.isArray(msg.children)
    ) {
      return msg;
    }

    let maxUpdatedAt = msg.updatedAt ?? msg.createdAt;
    let maxUpdatedMs = toTimestampMs(maxUpdatedAt);

    const considerTimestamp = (candidate: unknown) => {
      const ms = toTimestampMs(candidate);
      if (ms > maxUpdatedMs) {
        maxUpdatedMs = ms;
        maxUpdatedAt = candidate;
      }
    };

    const hydratedChildren = msg.children.map((child: any) => {
      if (!child || typeof child !== 'object') return child;
      const srcChild = typeof child.id === 'string' ? byId.get(child.id) : undefined;

      let nextChild = child;
      if (srcChild) {
        considerTimestamp(srcChild.updatedAt ?? srcChild.createdAt);
        nextChild = {
          ...nextChild,
          ...(srcChild.annotations !== undefined && { annotations: srcChild.annotations }),
          ...(srcChild.createdAt !== undefined && { createdAt: srcChild.createdAt }),
          ...(srcChild.metadata !== undefined && { metadata: srcChild.metadata }),
          ...(srcChild.reasoning_content !== undefined && {
            reasoning_content: srcChild.reasoning_content,
          }),
          ...(srcChild.search !== undefined && { search: srcChild.search }),
          ...(srcChild.server_tool_calls !== undefined && {
            server_tool_calls: srcChild.server_tool_calls,
          }),
          ...(srcChild.updatedAt !== undefined && { updatedAt: srcChild.updatedAt }),
        };
      }

      if (Array.isArray(nextChild.tools) && nextChild.tools.length > 0) {
        const srcToolsById = new Map<string, any>();
        if (Array.isArray(srcChild?.tools)) {
          for (const st of srcChild.tools) {
            if (st && typeof st.id === 'string') srcToolsById.set(st.id, st);
          }
        }

        const nextTools = nextChild.tools.map((tool: any) => {
          if (!tool || typeof tool !== 'object') return tool;
          const srcTool = typeof tool.id === 'string' ? srcToolsById.get(tool.id) : undefined;
          let updatedTool =
            tool.thoughtSignature === undefined && srcTool?.thoughtSignature !== undefined
              ? { ...tool, thoughtSignature: srcTool.thoughtSignature }
              : tool;

          if (updatedTool.result && typeof updatedTool.result.id === 'string') {
            const srcToolMsg = byId.get(updatedTool.result.id);
            if (srcToolMsg) {
              considerTimestamp(srcToolMsg.updatedAt ?? srcToolMsg.createdAt);
              updatedTool = {
                ...updatedTool,
                result: {
                  ...updatedTool.result,
                  ...(srcToolMsg.createdAt !== undefined && { createdAt: srcToolMsg.createdAt }),
                  ...(srcToolMsg.updatedAt !== undefined && { updatedAt: srcToolMsg.updatedAt }),
                },
              };
            }
          }

          return updatedTool;
        });

        nextChild = { ...nextChild, tools: nextTools };
      }

      return nextChild;
    });

    return {
      ...msg,
      children: hydratedChildren,
      ...(maxUpdatedAt !== undefined && { updatedAt: maxUpdatedAt }),
    };
  });
};

/**
 * Group Message Flatten Processor
 * Responsible for flattening role=assistantGroup and role=supervisor messages into standard assistant + tool message sequences
 *
 * AssistantGroup/Supervisor messages are created when assistant messages with tools are merged with their tool results.
 * This processor converts them back to a flat structure that AI models can understand.
 */
export class GroupMessageFlattenProcessor extends BaseProcessor {
  readonly name = 'GroupMessageFlattenProcessor';

  constructor(options: ProcessorOptions = {}) {
    super(options);
  }

  protected async doProcess(context: PipelineContext): Promise<PipelineContext> {
    const clonedContext = this.cloneContext(context);

    let processedCount = 0;
    let groupMessagesFlattened = 0;
    let assistantMessagesCreated = 0;
    let toolMessagesCreated = 0;

    const newMessages: any[] = [];

    // Process each message
    for (const message of clonedContext.messages) {
      // Check if this is an assistantGroup or supervisor message with children field
      if (
        (message.role === 'assistantGroup' || message.role === 'supervisor') &&
        message.children
      ) {
        // If children array is empty, skip this message entirely (no content to flatten)
        if (message.children.length === 0) {
          continue;
        }

        processedCount++;
        groupMessagesFlattened++;

        log(
          `Flattening ${message.role} message ${message.id} with ${message.children.length} children`,
        );

        // Flatten each child
        for (const child of message.children) {
          // 1. Create assistant message from child
          const assistantMsg: any = {
            content: child.content || '',
            createdAt: child.createdAt ?? message.createdAt,
            id: child.id,
            meta: message.meta,
            role: 'assistant',
            updatedAt: child.updatedAt ?? message.updatedAt,
          };

          // Add tools if present (excluding result, which will be separate tool messages)
          if (child.tools && child.tools.length > 0) {
            assistantMsg.tools = child.tools.map((tool: any) => ({
              apiName: tool.apiName,
              arguments: tool.arguments,
              id: tool.id,
              identifier: tool.identifier,
              ...(tool.thoughtSignature !== undefined && {
                thoughtSignature: tool.thoughtSignature,
              }),
              type: tool.type,
            }));
          }

          // Add reasoning if present (for models that support reasoning)
          if (child.reasoning) {
            assistantMsg.reasoning = child.reasoning;
          }

          // Add error if present
          if (child.error) {
            assistantMsg.error = child.error;
          }

          // Add imageList if present
          if (child.imageList && child.imageList.length > 0) {
            assistantMsg.imageList = child.imageList;
          }

          // Add fileList if present
          if (child.fileList && child.fileList.length > 0) {
            assistantMsg.fileList = child.fileList;
          }

          // Preserve hydrated child metadata / search / deepseek fields so Step 1b matches Step 0 flat rows
          if (child.metadata !== undefined) assistantMsg.metadata = child.metadata;
          if (child.search !== undefined) assistantMsg.search = child.search;
          if (child.reasoning_content !== undefined) {
            assistantMsg.reasoning_content = child.reasoning_content;
          }
          if (child.server_tool_calls !== undefined) {
            assistantMsg.server_tool_calls = child.server_tool_calls;
          }
          if (child.annotations !== undefined) {
            assistantMsg.annotations = child.annotations;
          }

          // Preserve other fields that might be needed
          if (message.parentId) assistantMsg.parentId = message.parentId;
          if (message.threadId) assistantMsg.threadId = message.threadId;
          if (message.groupId) assistantMsg.groupId = message.groupId;
          if (message.agentId) assistantMsg.agentId = message.agentId;
          if (message.targetId) assistantMsg.targetId = message.targetId;
          if (message.topicId) assistantMsg.topicId = message.topicId;

          newMessages.push(assistantMsg);
          assistantMessagesCreated++;

          log(`Created assistant message ${assistantMsg.id} from child`);

          // 2. Create tool messages for each tool that has a result
          if (child.tools) {
            for (const tool of child.tools) {
              if (tool.result) {
                const toolMsg: any = {
                  content: tool.result.content,
                  createdAt: tool.result.createdAt ?? message.createdAt,
                  id: tool.result.id,
                  meta: message.meta,
                  plugin: {
                    apiName: tool.apiName,
                    arguments: tool.arguments,
                    id: tool.id,
                    identifier: tool.identifier,
                    type: tool.type,
                  },
                  pluginError: tool.result.error || undefined,
                  pluginState: tool.result.state || undefined,
                  role: 'tool',
                  tool_call_id: tool.id,
                  updatedAt: tool.result.updatedAt ?? message.updatedAt,
                };

                // Preserve parent message references
                if (message.parentId) toolMsg.parentId = message.parentId;
                if (message.threadId) toolMsg.threadId = message.threadId;
                if (message.groupId) toolMsg.groupId = message.groupId;
                if (message.topicId) toolMsg.topicId = message.topicId;

                newMessages.push(toolMsg);
                toolMessagesCreated++;

                log(`Created tool message ${toolMsg.id} for tool call ${tool.id}`);
              }
            }
          }
        }
      } else {
        // Non-group message, keep as-is
        newMessages.push(message);
      }
    }

    clonedContext.messages = newMessages;

    // Update metadata
    clonedContext.metadata.groupMessagesFlattenProcessed = processedCount;
    clonedContext.metadata.groupMessagesFlattened = groupMessagesFlattened;
    clonedContext.metadata.assistantMessagesCreated = assistantMessagesCreated;
    clonedContext.metadata.toolMessagesCreated = toolMessagesCreated;

    log(
      `AssistantGroup/Supervisor message flatten processing completed: ${groupMessagesFlattened} groups flattened, ${assistantMessagesCreated} assistant messages created, ${toolMessagesCreated} tool messages created`,
    );

    return this.markAsExecuted(clonedContext);
  }
}
