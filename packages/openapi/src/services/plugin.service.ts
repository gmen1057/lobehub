import { desc, like } from 'drizzle-orm';

import { PluginModel } from '@/database/models/plugin';
import { userInstalledPlugins } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';

/**
 * arckep (план chat-next-redesign, E2): подключения (MCP-коннекторы `mcp-arckep-*`) по REST.
 *
 * Раньше подключения ставились только SQL-скриптами (`/opt/mcp-connectors/scripts`) всем
 * пользователям разом, а новый пользователь оставался без них. Каталог — свежая запись каждого
 * коннектора среди всех пользователей (их и обновляют те же скрипты); установка копирует
 * manifest и customParams себе, настройки (ключи, адреса) у каждого свои.
 */

export const ARCKEP_CONNECTOR_PREFIX = 'mcp-arckep-';

export interface ConnectorSummary {
  description: string;
  identifier: string;
  installed: boolean;
  /** Пользователь что-то сохранил в настройках (ключ, адрес) — для коннекторов, которым это нужно */
  settingsFilled: boolean;
  title: string;
  tools: string[];
  type: string;
}

interface ConnectorRow {
  customParams?: unknown;
  identifier: string;
  manifest?: unknown;
  settings?: unknown;
  source?: string | null;
  type?: string | null;
}

export const summarizeConnector = (row: ConnectorRow, installed: boolean): ConnectorSummary => {
  const manifest = (row.manifest ?? {}) as { api?: unknown; meta?: Record<string, unknown> };
  const meta = manifest.meta ?? {};
  const api = Array.isArray(manifest.api) ? manifest.api : [];
  const settings =
    row.settings && typeof row.settings === 'object'
      ? (row.settings as Record<string, unknown>)
      : {};
  return {
    description: typeof meta.description === 'string' ? meta.description : '',
    identifier: row.identifier,
    installed,
    settingsFilled: Object.keys(settings).length > 0,
    title: typeof meta.title === 'string' && meta.title ? meta.title : row.identifier,
    tools: api
      .map((item) => (item && typeof item === 'object' ? (item as { name?: unknown }).name : ''))
      .filter((name): name is string => typeof name === 'string' && name.length > 0),
    type: row.type ?? 'customPlugin',
  };
};

export class PluginService {
  private pluginModel: PluginModel;

  constructor(
    private db: LobeChatDatabase,
    private userId: string,
  ) {
    this.pluginModel = new PluginModel(db, userId);
  }

  async listInstalled(): Promise<ConnectorSummary[]> {
    const rows = await this.pluginModel.query();
    return rows.map((row) => summarizeConnector(row as ConnectorRow, true));
  }

  async catalog(): Promise<ConnectorSummary[]> {
    const [latest, installed] = await Promise.all([
      this.latestCatalogRows(),
      this.pluginModel.query(),
    ]);
    const mine = new Set(installed.map((row) => row.identifier));
    return latest.map((row) =>
      summarizeConnector({ ...row, settings: null }, mine.has(row.identifier)),
    );
  }

  async install(identifier: string): Promise<ConnectorSummary | null> {
    const row = (await this.latestCatalogRows()).find((item) => item.identifier === identifier);
    if (!row) return null;
    const existing = await this.pluginModel.findById(identifier);
    const created = await this.pluginModel.create({
      customParams: row.customParams as never,
      identifier,
      manifest: row.manifest as never,
      settings: existing?.settings ?? {},
      source: row.source ?? 'custom',
      type: (row.type as 'plugin' | 'customPlugin') ?? 'customPlugin',
    });
    return summarizeConnector(created as ConnectorRow, true);
  }

  async updateSettings(
    identifier: string,
    settings: Record<string, unknown>,
  ): Promise<ConnectorSummary | null> {
    const existing = await this.pluginModel.findById(identifier);
    if (!existing) return null;
    await this.pluginModel.update(identifier, { settings });
    return summarizeConnector({ ...(existing as ConnectorRow), settings }, true);
  }

  async uninstall(identifier: string): Promise<boolean> {
    const existing = await this.pluginModel.findById(identifier);
    if (!existing) return false;
    await this.pluginModel.delete(identifier);
    return true;
  }

  /** Новому пользователю — весь каталог (как SQL-скрипты делали для существующих). */
  async installCatalog(): Promise<string[]> {
    const rows = await this.latestCatalogRows();
    for (const row of rows) {
      await this.pluginModel.create({
        customParams: row.customParams as never,
        identifier: row.identifier,
        manifest: row.manifest as never,
        settings: {},
        source: row.source ?? 'custom',
        type: (row.type as 'plugin' | 'customPlugin') ?? 'customPlugin',
      });
    }
    return rows.map((row) => row.identifier);
  }

  /** Свежая запись каждого коннектора среди всех пользователей — каталог. */
  async latestCatalogRows(): Promise<ConnectorRow[]> {
    return this.db
      .selectDistinctOn([userInstalledPlugins.identifier], {
        customParams: userInstalledPlugins.customParams,
        identifier: userInstalledPlugins.identifier,
        manifest: userInstalledPlugins.manifest,
        source: userInstalledPlugins.source,
        type: userInstalledPlugins.type,
      })
      .from(userInstalledPlugins)
      .where(like(userInstalledPlugins.identifier, `${ARCKEP_CONNECTOR_PREFIX}%`))
      .orderBy(userInstalledPlugins.identifier, desc(userInstalledPlugins.updatedAt));
  }
}
