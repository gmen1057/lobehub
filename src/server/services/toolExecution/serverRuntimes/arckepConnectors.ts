import {
  ARCKEP_CONNECT_LIMIT,
  ArckepConnectorsIdentifier,
  type ConnectorSuggestion,
} from '@lobechat/builtin-tool-skills';
import {
  ArckepConnectorsExecutionRuntime,
  type ArckepConnectorsService,
} from '@lobechat/builtin-tool-skills/arckepConnectorsRuntime';
import { ARCKEP_USER_MCP_PREFIX } from '@lobechat/builtin-tools';
import debug from 'debug';

import { PluginModel } from '@/database/models/plugin';
import { type LobeChatDatabase } from '@/database/type';

import { type ServerRuntimeRegistration } from './types';

const log = debug('lobe-server:arckep-connectors');

const IMAGE_STUDIO_BASE = 'http://127.0.0.1:8202';
const CATALOG_TIMEOUT_MS = 5000;
const TITLE_LIMIT = 80;
const DESCRIPTION_LIMIT = 300;

const oneLine = (value: unknown, limit: number): string =>
  typeof value === 'string' ? value.replaceAll(/\s+/g, ' ').trim().slice(0, limit) : '';

/**
 * Каталог подключений бэкенда студии (arckep, 19.10.2026, этап 3, п. 3.Г): `GET /api/internal/chat-mcp-catalog`
 * служебным ключом студии. Контракт ответа: `{items: [{id, source, title, description, needsSetup, paid}]}`.
 * Ответ чужого формата не доверяется: строки сжимаются до одной строки, лишнее отбрасывается.
 */
export const fetchCatalogSuggestions = async (
  query: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ConnectorSuggestion[]> => {
  const base = (process.env.IMAGE_STUDIO_API_URL || IMAGE_STUDIO_BASE).replace(/\/$/, '');
  const token = process.env.ARCKEP_INTERNAL_TOKEN || process.env.LOBECHAT_BACKEND_KEY;
  const url = `${base}/api/internal/chat-mcp-catalog?${new URLSearchParams({
    limit: String(ARCKEP_CONNECT_LIMIT),
    q: query,
  })}`;

  const response = await fetchImpl(url, {
    headers: token ? { 'x-arckep-token': token } : {},
    signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const body = (await response.json()) as { items?: unknown };
  if (!Array.isArray(body?.items)) return [];

  const items: ConnectorSuggestion[] = [];
  for (const raw of body.items) {
    const item = (raw ?? {}) as Record<string, unknown>;
    const id = oneLine(item.id, 200);
    const title = oneLine(item.title, TITLE_LIMIT);
    if (!id || !title || (item.source !== 'catalog' && item.source !== 'connection')) continue;
    items.push({
      description: oneLine(item.description, DESCRIPTION_LIMIT),
      id,
      needsSetup: item.needsSetup === true,
      paid: item.paid === true,
      source: item.source,
      title,
    });
  }
  return items;
};

/** Установленные подключения человека, подходящие под запрос: по названию, описанию, ключу и именам инструментов. */
export const matchInstalledConnections = async (
  db: LobeChatDatabase,
  userId: string,
  query: string,
): Promise<ConnectorSuggestion[]> => {
  const words = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 2);
  if (words.length === 0) return [];

  const rows = await new PluginModel(db, userId).query();
  const found: ConnectorSuggestion[] = [];
  for (const row of rows) {
    const manifest = (row.manifest ?? {}) as {
      api?: Array<{ name?: unknown }>;
      meta?: { description?: unknown; title?: unknown };
    };
    // подключения человека — это `mcp-*` (студия, шлюз) и свои `umcp-*`; прочие записи таблицы не предлагаем
    if (!row.identifier.startsWith('mcp-') && !row.identifier.startsWith(ARCKEP_USER_MCP_PREFIX)) {
      continue;
    }
    const title = oneLine(manifest.meta?.title, TITLE_LIMIT) || row.identifier;
    const description = oneLine(manifest.meta?.description, DESCRIPTION_LIMIT);
    const toolNames = (manifest.api ?? []).map((api) => String(api?.name ?? '')).join(' ');
    const haystack = `${row.identifier} ${title} ${description} ${toolNames}`.toLowerCase();
    if (!words.some((word) => haystack.includes(word))) continue;
    found.push({
      description,
      id: row.identifier,
      installed: true,
      needsSetup: false,
      paid: false,
      source: 'connection',
      title,
    });
  }
  return found;
};

/**
 * Поиск подключений для модели (`arckep-connectors`, п. 3.Г): каталог бэкенда студии плюс установленные
 * подключения человека, до 5 строк. Каталог не ответил — остаются установленные; не нашлось ничего и каталог
 * недоступен — ошибка модели текстом (чтобы она не сказала «такого подключения нет»).
 */
export const arckepConnectorsRuntime: ServerRuntimeRegistration = {
  factory: (context) => {
    if (!context.serverDB) throw new Error('serverDB is required for connector search');
    if (!context.userId) throw new Error('userId is required for connector search');
    const { serverDB, userId } = context;

    const service: ArckepConnectorsService = {
      search: async (query) => {
        let catalog: ConnectorSuggestion[] = [];
        let catalogError: Error | undefined;
        try {
          catalog = await fetchCatalogSuggestions(query);
        } catch (error) {
          catalogError = error as Error;
          log('catalog search failed: %O', error);
        }

        let installed: ConnectorSuggestion[] = [];
        try {
          installed = await matchInstalledConnections(serverDB, userId, query);
        } catch (error) {
          log('installed connections lookup failed: %O', error);
        }

        // Один и тот же id из двух источников — одна строка (установленное знает, что оно уже стоит)
        const merged = new Map<string, ConnectorSuggestion>();
        for (const item of catalog) merged.set(`${item.source}:${item.id}`, item);
        for (const item of installed) {
          const key = `${item.source}:${item.id}`;
          merged.set(key, { ...merged.get(key), ...item });
        }
        const items = [...merged.values()].slice(0, ARCKEP_CONNECT_LIMIT);
        if (items.length === 0 && catalogError) throw catalogError;
        return items;
      },
    };

    return new ArckepConnectorsExecutionRuntime(service);
  },
  identifier: ArckepConnectorsIdentifier,
};
