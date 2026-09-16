/** Keep the latest two user turns, including complete tool-call/result groups. */
export function getCompressionBoundary(messages: { role: string }[]): number {
  const userIndexes = messages.flatMap((message, index) =>
    message.role === 'user' ? [index] : [],
  );
  return userIndexes.at(-2) ?? userIndexes.at(-1) ?? 0;
}
