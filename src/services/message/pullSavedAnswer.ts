import { type UIChatMessage } from '@lobechat/types';

/** First look soon, then one more if the model was still finishing. */
const PULL_DELAYS_MS = [2_000, 45_000];

export const isPlaceholderAnswer = (content?: string | null): boolean => {
  if (typeof content !== 'string') return content == null;
  const trimmed = content.trim();
  return trimmed === '' || trimmed === '...';
};

/**
 * After a failed save, read the chat once the server may have stored the
 * answer. Stops when the screen already shows text, or after the last try.
 */
export function scheduleSavedAnswerPull(options: {
  apply: (message: UIChatMessage) => void;
  delaysMs?: number[];
  load: () => Promise<UIChatMessage[]>;
  localContent: () => string | null | undefined;
  messageId: string;
  sleep?: (ms: number) => Promise<void>;
}): void {
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const delays = options.delaysMs ?? PULL_DELAYS_MS;

  void (async () => {
    for (const delay of delays) {
      await sleep(delay);
      if (!isPlaceholderAnswer(options.localContent())) return;

      let messages: UIChatMessage[];
      try {
        messages = await options.load();
      } catch {
        continue;
      }

      const server = messages.find((message) => message.id === options.messageId);
      if (!server || isPlaceholderAnswer(server.content)) continue;
      if (!isPlaceholderAnswer(options.localContent())) return;

      options.apply(server);
      if (!isPlaceholderAnswer(options.localContent())) return;
    }
  })();
}
