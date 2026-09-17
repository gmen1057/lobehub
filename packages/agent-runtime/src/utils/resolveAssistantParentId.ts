/**
 * After a tool round the next assistant must hang off the last tool message.
 * Callers sometimes pass the first tool-calling assistant instead; the chat UI
 * then drops the follow-up (and the next user question) from the main line.
 * Incident 2026-09-17, agent inbox after knowledge-base reads.
 */
export function resolveAssistantParentId(
  messages: Array<{ createdAt?: Date | number | string; id: string; role?: string }>,
  fallbackParentId?: string,
): string | undefined {
  if (!messages.length) return fallbackParentId;

  const sorted = [...messages].sort((a, b) => {
    const ta = new Date(a.createdAt as Date).getTime() || 0;
    const tb = new Date(b.createdAt as Date).getTime() || 0;
    return ta - tb;
  });
  const last = sorted.at(-1);
  if (last?.role === 'tool') return last.id;
  return fallbackParentId;
}
