import { AgentRuntimeErrorType } from '../../../types/error';
import { convertOpenAIUsage } from '../../usageConverters';
import type {
  ChatPayloadForTransformStream,
  StreamContext,
  StreamProtocolChunk,
} from '../protocol';

/** Native server calls are history, never executable client function calls. */
export const transformDeepSeekStream = (
  chunk: any,
  context: StreamContext,
  payload?: ChatPayloadForTransformStream,
  transformFunctionCalls?: (chunk: any) => StreamProtocolChunk | StreamProtocolChunk[],
): StreamProtocolChunk[] => {
  const id = chunk.id || context.id || 'deepseek';
  const out: StreamProtocolChunk[] = [];
  const emit = (type: StreamProtocolChunk['type'], data: any) => out.push({ data, id, type });
  if (chunk.error) {
    emit('error', {
      body: chunk.error,
      message: chunk.error.message || 'DeepSeek stream error',
      type: AgentRuntimeErrorType.ProviderBizError,
    });
    return out;
  }
  const choice = chunk.choices?.[0];
  const delta = choice?.delta ?? {};
  const previous = context.deepseek ?? {
    annotations: [],
    server_tool_calls: [],
    server_tool_events: [],
  };
  const metadata = { ...previous };
  let changed = false;
  if (typeof delta.reasoning_content === 'string')
    metadata.reasoning_content = (previous.reasoning_content ?? '') + delta.reasoning_content;
  if (choice?.server_tool_event) {
    if (choice.server_tool_event.type === 'step_reasoning_done') metadata.reasoning_content = '';
    metadata.server_tool_events = [...previous.server_tool_events, choice.server_tool_event];
    changed = true;
  }
  if (delta.server_tool_calls) {
    metadata.server_tool_calls = delta.server_tool_calls;
    changed = true;
  }
  if (delta.annotations) {
    metadata.annotations = delta.annotations;
    changed = true;
  }
  if (choice?.finish_reason) {
    metadata.finish_reason = choice.finish_reason;
    changed = true;
  }
  if (delta.refusal !== undefined) {
    metadata.refusal = delta.refusal;
    changed = true;
  }
  if (chunk.usage) {
    metadata.usage = chunk.usage;
    changed = true;
  }
  const refused = metadata.finish_reason === 'content_filter';
  if (refused) {
    metadata.annotations = [];
    metadata.reasoning_content = '';
    metadata.server_tool_events = [];
    metadata.server_tool_calls = metadata.server_tool_calls.map((step: any) => ({
      ...step,
      ...(step.reasoning_content !== undefined ? { reasoning_content: '' } : {}),
    }));
  }
  context.deepseek = metadata;
  if (changed)
    emit('grounding', {
      citations: metadata.annotations
        .filter((a: any) => a.type === 'url_citation')
        .map((a: any) => ({ ...a.url_citation })),
      deepseek: metadata,
    });
  if (!refused) {
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content)
      emit('reasoning', delta.reasoning_content);
    if (typeof delta.content === 'string' && delta.content) emit('text', delta.content);
    if (delta.tool_calls?.length && transformFunctionCalls) {
      const toolChunks = transformFunctionCalls(chunk);
      out.push(...(Array.isArray(toolChunks) ? toolChunks : [toolChunks]));
    }
  }
  if (choice?.finish_reason) emit('stop', choice.finish_reason);
  if (chunk.usage) emit('usage', convertOpenAIUsage(chunk.usage, payload));
  return out;
};
