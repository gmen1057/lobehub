const RECEIPT = 'ARCKEP_TEXT_FILE_V1\n';
const MAX_TAIL = 4096;

// Only compact a call for which the engine has already returned a successful durable receipt.
// Keep the most recent pair for each file. Preserve all unrelated tool calls, their results and
// intervening assistant prose, including a mixed batch containing both kinds of call.
export function compactWriterContext(messages: any[], requestId?: string): any[] {
  const boundary = requestId
    ? messages.findIndex((m) => m.role === 'user' && m.id === requestId)
    : -1;
  const current = boundary >= 0 ? messages.slice(boundary) : messages;
  const latest = new Map<string, string>();
  const completed = new Map<string, string>();
  const writerCalls = new Set<string>();
  const pageCalls = new Set<string>();
  const oldPages = new Map<string, string>();
  let lastPageId: string | undefined;
  for (const message of current) {
    for (const call of message.tool_calls ?? []) {
      if (call.function?.name?.startsWith('arckep-text-file____writePart'))
        writerCalls.add(call.id);
      if (
        /^(?:lobe-topic-reference____getTopicContext|lobe-knowledge-base____readKnowledge|lobe-agent-documents____readDocument(?:ByFilename)?)(?:____|$)/.test(
          call.function?.name || '',
        )
      )
        pageCalls.add(call.id);
    }
    if (
      message.role === 'tool' &&
      pageCalls.has(message.tool_call_id) &&
      typeof message.content === 'string' &&
      message.content.length > MAX_TAIL
    ) {
      // The preceding call already contains the exact document/file IDs and requested offset.
      // Keep cursor and snapshot from the result, never copy arbitrary source into the pointer.
      const firstLine = message.content.slice(0, 2500).split('\n')[0];
      const cursor: Record<string, unknown> = {};
      const jsonStart = firstLine.indexOf('{');
      if (jsonStart >= 0) {
        try {
          const meta = JSON.parse(firstLine.slice(jsonStart));
          for (const key of [
            'startOffset',
            'endOffset',
            'nextOffset',
            'totalCharCount',
            'snapshot',
            'snapshotAt',
          ])
            if (
              typeof meta[key] === 'number' ||
              meta[key] === null ||
              (typeof meta[key] === 'string' && meta[key].length < 120)
            )
              cursor[key] = meta[key];
        } catch {
          /* Some readers return a formatted page rather than a JSON header. */
        }
      }
      oldPages.set(
        message.tool_call_id,
        'Original source page retained. Repeat the preceding read call to retrieve the exact page. ' +
          JSON.stringify(cursor),
      );
      lastPageId = message.tool_call_id;
    }
    if (
      message.role !== 'tool' ||
      !writerCalls.has(message.tool_call_id) ||
      typeof message.content !== 'string' ||
      !message.content.startsWith(RECEIPT)
    )
      continue;
    try {
      const receipt = JSON.parse(message.content.slice(RECEIPT.length));
      if (typeof receipt.documentId !== 'string' || !Number.isSafeInteger(receipt.part)) continue;
      latest.set(receipt.documentId, message.tool_call_id);
      completed.set(message.tool_call_id, receipt.documentId);
    } catch {
      /* Incomplete tool output cannot stand in for a confirmed snapshot. */
    }
  }
  const retained = new Set(latest.values());
  return current.flatMap((message) => {
    if (
      message.role === 'tool' &&
      message.tool_call_id !== lastPageId &&
      oldPages.has(message.tool_call_id)
    )
      return [{ ...message, content: oldPages.get(message.tool_call_id) }];
    if (
      message.role === 'tool' &&
      completed.has(message.tool_call_id) &&
      !retained.has(message.tool_call_id)
    )
      return [];
    if (message.role !== 'assistant' || !message.tool_calls?.some((c: any) => completed.has(c.id)))
      return [message];
    const calls = message.tool_calls.flatMap((call: any) => {
      if (!completed.has(call.id)) return [call];
      if (!retained.has(call.id)) return [];
      try {
        const args = JSON.parse(call.function.arguments);
        if (typeof args.text === 'string' && args.text.length > MAX_TAIL)
          return [
            {
              ...call,
              function: {
                ...call.function,
                arguments: JSON.stringify({ ...args, text: args.text.slice(-MAX_TAIL) }),
              },
            },
          ];
      } catch {
        /* The receipt is still authoritative when historical arguments are unavailable. */
      }
      return [call];
    });
    if (!calls.length && !message.content) return [];
    return [{ ...message, tool_calls: calls.length ? calls : undefined }];
  });
}
