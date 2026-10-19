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

export interface ArckepLinkConnectorsInput {
  /** Инструменты, выключенные человеком на этот запрос (`disabled_tools`). */
  excludePluginIds?: readonly string[];
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

export const resolveArckepLinkConnectors = ({
  excludePluginIds = [],
  installedPlugins = [],
  prompt,
  table = ARCKEP_LINK_CONNECTORS,
}: ArckepLinkConnectorsInput): ArckepLinkConnectorsResult => {
  const result: ArckepLinkConnectorsResult = { activate: [], setupHints: [] };
  if (!prompt) return result;

  for (const entry of table) {
    if (!entry.pattern.test(prompt)) continue;
    // Человек выключил подключение на этот запрос — не включаем и не уговариваем подключить.
    if (excludePluginIds.includes(entry.connectorId)) continue;

    const installed = installedPlugins.find((plugin) => plugin.identifier === entry.connectorId);
    const ready =
      !!installed && (!entry.requiresSettings || hasFilledConnectorSettings(installed.settings));

    if (ready) {
      if (!result.activate.includes(entry.connectorId)) result.activate.push(entry.connectorId);
    } else if (!result.setupHints.includes(entry.setupHint)) {
      result.setupHints.push(entry.setupHint);
    }
  }

  return result;
};
