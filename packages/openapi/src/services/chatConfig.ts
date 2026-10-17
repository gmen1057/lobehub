/**
 * arckep (план chat-next-redesign, E1): нормализация `chatConfig` помощника из REST.
 *
 * REST принимал `searchMode: 'disabled' | 'enabled'`, а движок понимает `'off' | 'on' | 'auto'`
 * и проверяет `searchMode !== 'off'` — поэтому «выключенный» через REST поиск оставался включённым
 * (тумблер «Поиск в интернете» в студии ничего не делал). Старые слова переводим в слова движка.
 */
export type ChatConfigRecord = Record<string, unknown>;

export const normalizeChatConfig = <T extends ChatConfigRecord | null | undefined>(
  chatConfig: T,
): T => {
  if (!chatConfig) return chatConfig;
  const mode = chatConfig.searchMode;
  if (mode === 'disabled') return { ...chatConfig, searchMode: 'off' } as T;
  if (mode === 'enabled') return { ...chatConfig, searchMode: 'on' } as T;
  return chatConfig;
};

/** PATCH `chatConfig` — частичная правка поверх сохранённого, а не замена целиком. */
export const mergeChatConfig = (
  current: ChatConfigRecord | null | undefined,
  patch: ChatConfigRecord | null | undefined,
): ChatConfigRecord | null => {
  if (patch === null) return null;
  return { ...current, ...normalizeChatConfig(patch) };
};
