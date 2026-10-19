import type { BuiltinServerRuntimeOutput } from '@lobechat/types';

import {
  ARCKEP_CONNECT_LIMIT,
  ARCKEP_CONNECT_MARKER,
  type ConnectorSuggestion,
  type SearchConnectorsParams,
  type SearchConnectorsState,
} from './types';

export interface ArckepConnectorsService {
  /** Предложения по запросу: каталог бэкенда студии плюс установленные подключения человека. */
  search: (query: string) => Promise<ConnectorSuggestion[]>;
}

const QUERY_LIMIT = 200;
const TITLE_LIMIT = 80;
const DESCRIPTION_LIMIT = 200;

/** Одна строка без переводов строк: чужой текст не должен подделать строку-маркер. */
const oneLine = (value: string, limit: number): string =>
  value.replaceAll(/\s+/g, ' ').trim().slice(0, limit);

const sourceLabel = (item: ConnectorSuggestion): string => {
  const parts = [item.source === 'catalog' ? 'from the catalog' : 'in your connections'];
  if (item.installed) parts.push('already installed');
  if (item.needsSetup) parts.push('needs keys or a link');
  if (item.paid) parts.push('paid: runs in a sandbox, about 0.2 RUB per minute');
  return parts.join(', ');
};

/** Ответ модели: короткий список и на каждое предложение строка-маркер для карточки на экране. */
export const formatConnectorSuggestions = (
  query: string,
  suggestions: ConnectorSuggestion[],
): string => {
  const items = suggestions.slice(0, ARCKEP_CONNECT_LIMIT);

  if (items.length === 0) {
    return [
      `No connections found for "${oneLine(query, QUERY_LIMIT)}".`,
      'Tell the person so, in one sentence. Do not invent connections and do not ask for keys in the chat.',
    ].join('\n');
  }

  const lines: string[] = [`Found ${items.length} connection(s) for "${oneLine(query, QUERY_LIMIT)}":`];
  for (const [index, item] of items.entries()) {
    const title = oneLine(item.title, TITLE_LIMIT);
    lines.push(
      `${index + 1}. ${title} (${sourceLabel(item)}): ${oneLine(item.description, DESCRIPTION_LIMIT)}`,
      `${ARCKEP_CONNECT_MARKER} ${JSON.stringify({ id: item.id, source: item.source, title })}`,
    );
  }
  lines.push(
    'The chat shows the person a "Connect ..." card for each item; they press it and enter keys themselves. Tell them in one or two sentences which one fits. Do not ask for keys, tokens or passwords in the chat.',
  );
  return lines.join('\n');
};

export class ArckepConnectorsExecutionRuntime {
  constructor(private readonly service: ArckepConnectorsService) {}

  async searchConnectors(args: SearchConnectorsParams): Promise<BuiltinServerRuntimeOutput> {
    const query = typeof args?.query === 'string' ? oneLine(args.query, QUERY_LIMIT) : '';
    if (!query) return { content: 'A search query is required.', success: false };

    try {
      const items = (await this.service.search(query)).slice(0, ARCKEP_CONNECT_LIMIT);
      const state: SearchConnectorsState = { items, query };
      return { content: formatConnectorSuggestions(query, items), state, success: true };
    } catch (error) {
      return {
        content: `The connections catalog is not available right now: ${(error as Error).message}. Tell the person to open "Connections" on the chat screen.`,
        success: false,
      };
    }
  }
}
