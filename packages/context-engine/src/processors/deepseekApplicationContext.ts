/** Apply only to the direct Flash route; opaque handles remain owner-checked by the proxy. */
export const deepseekApplicationContext = (message: any, model?: string, provider?: string) => {
  if (model !== 'deepseek-flash' || provider !== 'deepseek') return {};
  if (message.role === 'assistant') {
    const metadata = message.search?.deepseek;
    return {
      ...(typeof metadata?.reasoning_content === 'string'
        ? { reasoning_content: metadata.reasoning_content }
        : {}),
      ...((metadata?.server_tool_calls ?? message.server_tool_calls) && {
        server_tool_calls: metadata?.server_tool_calls ?? message.server_tool_calls,
      }),
      ...((metadata?.annotations ?? message.annotations) && {
        annotations: metadata?.annotations ?? message.annotations,
      }),
    };
  }
  const handles = message.metadata?.deepseek_document_ids;
  if (message.role !== 'user' || !Array.isArray(handles) || !handles.length) return {};
  if (
    handles.length > 20 ||
    handles.some((id: unknown) => typeof id !== 'string' || !id.startsWith('arkdoc_'))
  )
    throw new Error('Invalid DeepSeek document handles');
  const parts =
    typeof message.content === 'string'
      ? [{ type: 'text', text: message.content }]
      : [...(message.content ?? [])];
  return { content: [...parts, ...handles.map((id: string) => ({ type: 'file', file_id: id }))] };
};
