/**
 * arckep (19.10.2026, этап 3 «свои инструменты»): встроенный инструмент «Подключения» — модель ищет по каталогу,
 * какое подключение нужно человеку (GitHub, Notion, базы данных, свой MCP), и показывает карточку «Подключить …».
 * Сама модель ничего не подключает: ключи и ссылки вводит человек на экране «Подключения». Грузится по
 * требованию через активатор, в постоянной части запроса его нет.
 */
export const ArckepConnectorsIdentifier = 'arckep-connectors';

export const ArckepConnectorsApiName = {
  searchConnectors: 'searchConnectors',
} as const;

/** Метка перед JSON карточки в ответе инструмента (читает экран студии): `ARCKEP_CONNECT {json}`. */
export const ARCKEP_CONNECT_MARKER = 'ARCKEP_CONNECT';

/** Сколько предложений отдаём модели за один поиск. */
export const ARCKEP_CONNECT_LIMIT = 5;

export interface SearchConnectorsParams {
  query: string;
}

/** Откуда предложение: каталог серверов E2B или подключение студии/шлюза из «Подключений». */
export type ConnectorSource = 'catalog' | 'connection';

export interface ConnectorSuggestion {
  description: string;
  id: string;
  /** Уже установлено у человека (только своё подключение, найденное в базе движка) */
  installed?: boolean;
  /** Нужны ключи или ссылка: человек вводит их на экране */
  needsSetup: boolean;
  /** Запуск идёт в песочнице за счёт человека */
  paid: boolean;
  source: ConnectorSource;
  title: string;
}

export interface SearchConnectorsState {
  items: ConnectorSuggestion[];
  query: string;
}
