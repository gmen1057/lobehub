/**
 * arckep (19.10.2026): узнаваемая ссылка в сообщении человека → подключение, которым её читают.
 *
 * Живой случай 19.10: на «<ссылка figma.com/design/…> — посмотри что тут» Gemini ответил «не могу открыть
 * Figma по ссылке» и вызвал инструменты, только когда его попросили «проверь ещё раз доступ». Подключение
 * `mcp-arckep-figma` у человека было, но лежало отложенным (`ARCKEP_MCP_CONNECTOR_PREFIX`: в первом шаге одна
 * строка в `<available_tools>`), и модель по ссылке не догадалась вызвать activateTools. Поэтому правило живёт
 * в серверном сборе набора инструментов (`execAgent`), а не в подсказке: если в ПОСЛЕДНЕМ сообщении человека
 * есть узнаваемая ссылка, а подключение установлено и настроено, оно включается сразу — схемы инструментов
 * видны модели без отдельного activateTools.
 *
 * Если ссылка есть, а подключения нет или токен не вставлен, модели на этот ход добавляется одна строка
 * «подключите…», чтобы она не отвечала «не могу открыть». В остальные ходы подсказка в контекст не попадает.
 *
 * Следующие ходы темы («а теперь сверстай» — без ссылки). Подключённое активатором помнится в теме
 * (`seedActivatedStepToolsFromHistory`), но только по шагам `activateTools` и только для подключений с манифестом
 * в наборе операции. Включённое этим правилом сразу шага `activateTools` не оставляет, а подключения может не быть
 * и в наборе помощника, поэтому на втором ходе оно пропало бы. Правило смотрит историю темы: ссылка в одном из
 * последних RECENT_HUMAN_MESSAGES сообщений человека ИЛИ в истории уже были вызовы этого подключения — оно
 * включается снова (те же условия: установлено, токен есть, не выключено в запросе). Подсказка «подключите…»
 * остаётся только на ссылку в самом последнем сообщении.
 *
 * Чтобы добавить сервис, достаточно строки в ARCKEP_LINK_CONNECTORS.
 */

export interface ArckepLinkConnector {
  /** Подключение движка (`user_installed_plugins.identifier`), которым читается такая ссылка. */
  connectorId: string;
  /** Узнаваемая ссылка (без флага g — `test` без состояния). */
  pattern: RegExp;
  /** Подключение работает только с личными настройками (токен) — пустые настройки считаются «не подключено». */
  requiresSettings: boolean;
  /** Строка для модели, если ссылка есть, а подключения нет или настройки пусты. */
  setupHint: string;
}

// Перед `figma.com` не должно стоять буквы, точки, «@», «/», «=» и т. п.: так `notfigma.com`, `evil.com/?u=figma.com/…`
// и `figma.com.evil.ru` не считаются ссылкой на Figma. Ссылки сообщества (`figma.com/community/file/…`) токен
// человека прочитать не может — в список разделов их нет.
const FIGMA_LINK =
  /(?<![\w.@/=?&#%-])(?:https?:\/\/)?(?:www\.)?figma\.com\/(?:design|file|proto|board|slides|make)\/[^\s/?#]/i;

export const ARCKEP_LINK_CONNECTORS: readonly ArckepLinkConnector[] = [
  {
    connectorId: 'mcp-arckep-figma',
    pattern: FIGMA_LINK,
    requiresSettings: true,
    setupHint:
      "The user's message contains a Figma link, but Figma is not connected for this user (no connection or no personal token). " +
      'Do not say you cannot open Figma links and do not guess the design from the URL. Tell the user briefly, in their language: ' +
      '"Подключите Figma: Подключения → Figma → вставьте личный токен" — after that you can look at the design.',
  },
];

interface InstalledPluginLike {
  identifier: string;
  settings?: unknown;
}

/** Сколько последних сообщений человека в теме просматривается в поисках ссылки. */
export const RECENT_HUMAN_MESSAGES = 10;

/** Сообщение истории темы в той части, что нужна правилу (строки `MessageModel.query`). */
export interface LinkHistoryMessageLike {
  content?: unknown;
  /** У сообщения роли `tool` — какой инструмент вызван. */
  plugin?: { identifier?: string | null } | null;
  role?: string;
  /** У сообщения помощника — вызванные им инструменты. */
  tools?: ReadonlyArray<{ identifier?: string | null }> | null;
}

export interface ArckepLinkConnectorsInput {
  /** Инструменты, выключенные человеком на этот запрос (`disabled_tools`). */
  excludePluginIds?: readonly string[];
  /** История темы до этого сообщения (по порядку, старые первыми); у новой темы её нет. */
  history?: ReadonlyArray<LinkHistoryMessageLike>;
  /** Установленные подключения человека (`PluginModel.query()`). */
  installedPlugins?: readonly InstalledPluginLike[];
  /** Текст последнего сообщения человека. */
  prompt?: string;
  /** Таблица ссылок (в тестах подменяется). */
  table?: readonly ArckepLinkConnector[];
}

export interface ArckepLinkConnectorsResult {
  /** Подключения, которые нужны на этот ход сразу (схемы инструментов без activateTools). */
  activate: string[];
  /** Строки для системной подсказки этого хода: ссылка есть, подключения нет. */
  setupHints: string[];
}

/**
 * Настройки заполнены, если в них есть хоть одно непустое значение. Движок для карточки подключения считает
 * проще — `Object.keys(settings).length > 0` (`summarizeConnector`); пустая строка вместо токена тут не в счёт.
 */
export const hasFilledConnectorSettings = (settings: unknown): boolean => {
  if (!settings || typeof settings !== 'object') return false;
  return Object.values(settings as Record<string, unknown>).some((value) =>
    typeof value === 'string' ? value.trim() !== '' : value !== null && value !== undefined,
  );
};

const isConnectorReady = (
  entry: ArckepLinkConnector,
  installedPlugins: readonly InstalledPluginLike[],
): boolean => {
  const installed = installedPlugins.find((plugin) => plugin.identifier === entry.connectorId);
  return !!installed && (!entry.requiresSettings || hasFilledConnectorSettings(installed.settings));
};

/** Есть ли у человека хоть одно установленное и настроенное подключение из таблицы (иначе историю темы читать незачем). */
export const hasReadyLinkConnector = (
  installedPlugins: readonly InstalledPluginLike[],
  table: readonly ArckepLinkConnector[] = ARCKEP_LINK_CONNECTORS,
): boolean => table.some((entry) => isConnectorReady(entry, installedPlugins));

/** Идентификаторы инструментов, вызванных в истории: сообщения `tool` и список `tools` у сообщений помощника. */
const collectCalledToolIds = (history: ReadonlyArray<LinkHistoryMessageLike>): Set<string> => {
  const ids = new Set<string>();
  for (const message of history) {
    if (message?.role === 'tool' && message.plugin?.identifier) ids.add(message.plugin.identifier);
    if (message?.role === 'assistant' && Array.isArray(message.tools)) {
      for (const tool of message.tools) if (tool?.identifier) ids.add(tool.identifier);
    }
  }
  return ids;
};

/** Тексты последних RECENT_HUMAN_MESSAGES сообщений человека (ответы помощника и результаты инструментов не в счёт). */
const collectRecentHumanTexts = (history: ReadonlyArray<LinkHistoryMessageLike>): string[] =>
  history
    .filter((message) => message?.role === 'user' && typeof message.content === 'string')
    .slice(-RECENT_HUMAN_MESSAGES)
    .map((message) => message.content as string);

export const resolveArckepLinkConnectors = ({
  excludePluginIds = [],
  history = [],
  installedPlugins = [],
  prompt = '',
  table = ARCKEP_LINK_CONNECTORS,
}: ArckepLinkConnectorsInput): ArckepLinkConnectorsResult => {
  const result: ArckepLinkConnectorsResult = { activate: [], setupHints: [] };

  const recentHumanTexts = collectRecentHumanTexts(history);
  const calledToolIds = collectCalledToolIds(history);

  for (const entry of table) {
    const linkInPrompt = entry.pattern.test(prompt);
    const linkInRecent = recentHumanTexts.some((text) => entry.pattern.test(text));
    const usedBefore = calledToolIds.has(entry.connectorId);
    if (!linkInPrompt && !linkInRecent && !usedBefore) continue;
    // Человек выключил подключение на этот запрос — не включаем и не уговариваем подключить.
    if (excludePluginIds.includes(entry.connectorId)) continue;

    if (isConnectorReady(entry, installedPlugins)) {
      if (!result.activate.includes(entry.connectorId)) result.activate.push(entry.connectorId);
    } else if (linkInPrompt && !result.setupHints.includes(entry.setupHint)) {
      // «Подключите…» — только на ссылку в самом последнем сообщении: на старую ссылку и на прежние вызовы
      // подключения, которого теперь нет, подсказка в каждый ход темы была бы навязчивой.
      result.setupHints.push(entry.setupHint);
    }
  }

  return result;
};
