/**
 * arckep (19.10.2026): поиск в интернете в чате студии — две ветки.
 *
 * 1. Встроенный поиск модели (`enabledSearch`): у всех моделей провайдеров из
 *    ARCKEP_NATIVE_SEARCH_PROVIDERS. Проверено живыми вызовами 19.10: OpenAI gpt-5.4-nano и gpt-5.6
 *    luna/terra/sol (web_search_call), xAI grok-4.3 / 4.20 / build (web_search_call), Google
 *    gemini-3.1-flash-lite и 3.7-flash (groundingMetadata), Qwen qwen3.7-flash / 3.5-flash (свежий
 *    факт из поиска); Claude — Models API Anthropic (web_search.supported у всех наших шести). Раньше
 *    список провайдеров брался из model-bank (DEFAULT_MODEL_PROVIDER_LIST), но индекс model-bank его не
 *    экспортирует: список был пуст, и поиск включался только у моделей с пометкой в карточке (21 из 48).
 * 2. «Поиск Arckep» (подключение студии mcp-arckep-studio-web → публичный API /tools/search и
 *    /tools/fetch, платный по вызову) — моделям без встроенного поиска: OpenRouter и DeepSeek напрямую.
 *    OpenRouter `:online` не подходит: он ищет в каждом сообщении (не по выбору модели), стоит ≈0,007 $
 *    вне цены ответа (проба 19.10: usage.cost 0,0072 $ при ответе на копейки). Раньше такие модели
 *    искали через песочницу с кодом — 11–55 с и 34–71 тыс. входных токенов.
 */
export const ARCKEP_NATIVE_SEARCH_PROVIDERS = new Set([
  'anthropic',
  'google',
  'openai',
  'qwen',
  'xai',
]);

/** Подключение студии с двумя инструментами web_search / web_fetch (mcp_service/chat_connectors.py). */
export const ARCKEP_WEB_SEARCH_CONNECTOR = 'mcp-arckep-studio-web';

type SearchChatConfig = { searchMode?: string; useModelBuiltinSearch?: boolean } | undefined;

/** Есть ли у модели встроенный поиск провайдера (без учёта выключателей помощника). */
export const modelHasBuiltinSearch = async (
  model: string | undefined,
  provider: string | undefined,
): Promise<boolean> => {
  if (!model || !provider) return false;
  if (ARCKEP_NATIVE_SEARCH_PROVIDERS.has(provider)) return true;
  // OpenRouter сознательно без встроенного поиска (см. выше, п. 2).
  if (provider === 'openrouter') return false;
  try {
    const bank: any = await import('model-bank');
    const modelCard = (bank.LOBE_DEFAULT_MODEL_LIST ?? []).find(
      (item: any) => item.id === model && item.providerId === provider,
    );
    return !!(modelCard?.abilities?.search || modelCard?.settings?.searchImpl);
  } catch {
    // Нет справочника моделей (например, подменён в тестах) — без поиска, как раньше.
    return false;
  }
};

/**
 * arckep (17.10.2026): встроенный поиск провайдера для серверных прогонов (REST-движок студии,
 * боты, cron): searchMode агента не 'off', useModelBuiltinSearch ?? true и у модели он есть.
 * Раньше серверный контур поиск не включал вовсе, и модель уходила в «skills/runCommand» (curl), который
 * ждёт подтверждения человеком.
 */
export const resolveServerEnabledSearch = async (
  agentConfig: { chatConfig?: SearchChatConfig } | undefined,
  model: string | undefined,
  provider: string | undefined,
): Promise<boolean> => {
  if (!model || !provider) return false;
  const chatConfig = agentConfig?.chatConfig;
  if ((chatConfig?.searchMode ?? 'auto') === 'off') return false;
  if (!(chatConfig?.useModelBuiltinSearch ?? true)) return false;
  return modelHasBuiltinSearch(model, provider);
};

/**
 * Какое подключение «Поиск Arckep» включить сразу (не по activateTools) на этот вызов: поиск не выключен, а
 * встроенного поиска у модели нет или человек от него отказался. Пусто — ничего добавлять не надо.
 * Если подключение у человека не установлено (удалил на странице «Подключения»), движок инструмента не найдёт и
 * просто пойдёт без него.
 */
export const resolveArckepSearchPluginIds = async (
  agentConfig: { chatConfig?: SearchChatConfig } | undefined,
  model: string | undefined,
  provider: string | undefined,
): Promise<string[]> => {
  if (!model || !provider) return [];
  if ((agentConfig?.chatConfig?.searchMode ?? 'auto') === 'off') return [];
  if (await resolveServerEnabledSearch(agentConfig, model, provider)) return [];
  return [ARCKEP_WEB_SEARCH_CONNECTOR];
};
