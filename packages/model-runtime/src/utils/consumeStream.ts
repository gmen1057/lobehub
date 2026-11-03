/**
 * Consumes a Response stream completely to ensure all callbacks are executed
 * @param response - The Response object with a ReadableStream body
 * @returns Promise that resolves when the stream is fully consumed
 *
 * @example
 * ```ts
 * const response = await modelRuntime.chat(payload, {
 *   callback: {
 *     onText: async (text) => {
 *       await saveToDatabase(text);
 *     }
 *   }
 * });
 *
 * // Ensure all callbacks complete before proceeding
 * await consumeStreamUntilDone(response);
 * ```
 */
export async function consumeStreamUntilDone(
  response: Response,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  if (!response.body) {
    return;
  }

  const reader = response.body.getReader();
  const onAbort = () => {
    // read() may be waiting for the next chunk; cancellation wakes it immediately.
    void reader.cancel(signal?.reason).catch(() => {});
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    while (true) {
      const { done } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}
