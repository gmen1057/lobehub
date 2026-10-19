import { ARCKEP_USER_MCP_PREFIX, isArckepUserMcpId } from '@lobechat/builtin-tools';
import { desc, like } from 'drizzle-orm';

import { PluginModel } from '@/database/models/plugin';
import { userInstalledPlugins } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import {
  buildUserMcpHeaders,
  buildUserMcpManifest,
  getUserMcpGatewayUrl,
  listUserMcpTools,
  UserMcpGatewayError,
} from '@/server/services/userMcp/gateway';

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
  /**
   * arckep (19.10.2026, этап 3): только у своих подключений `umcp-*` — вид и то, что показать человеку (хост
   * ссылки, ключ сервера каталога, `owner/repo`). Шифротекст настроек (`sealed`) наружу не отдаётся никогда.
   */
  userMcp?: { display: Record<string, string>; kind: string };
}

export const USER_MCP_KINDS = ['remote', 'catalog', 'github'] as const;
export type UserMcpKind = (typeof USER_MCP_KINDS)[number];

export interface UserMcpCreateInput {
  /** Номер человека в студии (по нему шлюз считает деньги и квоты) */
  arckepUserId: number;
  description: string;
  display: Record<string, string>;
  identifier: string;
  kind: UserMcpKind;
  /** Шифротекст `enc:v1:…` настроек: расшифровывает только шлюз */
  sealed: string;
  title: string;
}

/** `display` и `kind` из customParams.arckepUserMcp — только строки; ничего другого (и `sealed`) не берётся. */
const pickUserMcp = (customParams: unknown): ConnectorSummary['userMcp'] | undefined => {
  const stored = (customParams as { arckepUserMcp?: { display?: unknown; kind?: unknown } } | null)
    ?.arckepUserMcp;
  if (!stored || typeof stored !== 'object') return undefined;
  const display: Record<string, string> = {};
  if (stored.display && typeof stored.display === 'object') {
    for (const [key, value] of Object.entries(stored.display as Record<string, unknown>)) {
      if (typeof value === 'string') display[key] = value;
    }
  }
  return { display, kind: typeof stored.kind === 'string' ? stored.kind : '' };
};

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
  const userMcp = row.identifier.startsWith(ARCKEP_USER_MCP_PREFIX)
    ? pickUserMcp(row.customParams)
    : undefined;
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
    ...(userMcp ? { userMcp } : {}),
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

  /**
   * arckep (19.10.2026, этап 3, п. 3.В): добавить своё подключение. Шлюз получает `initialize` → `tools/list`
   * с заголовками п. 3.Б (номер человека, идентификатор, шифротекст настроек); ответ (вплоть до 2 минут — шлюз
   * может поднимать песочницу) становится manifest. Ошибка шлюза — `UserMcpGatewayError` с русским текстом,
   * строка не пишется. Строка: `customParams = {mcp: {type: 'http', url}, arckepUserMcp: {kind, sealed, display}}`.
   */
  async createUserMcp(input: UserMcpCreateInput): Promise<ConnectorSummary> {
    const tools = await listUserMcpTools({
      headers: buildUserMcpHeaders({
        arckepUserId: input.arckepUserId,
        identifier: input.identifier,
        sealed: input.sealed,
      }),
    });
    if (tools.length === 0) {
      throw new UserMcpGatewayError('Сервер не отдал ни одного подходящего инструмента', 422);
    }
    const url = getUserMcpGatewayUrl();
    const row = await this.pluginModel.create({
      customParams: {
        arckepUserMcp: { display: input.display, kind: input.kind, sealed: input.sealed },
        mcp: { type: 'http', url },
      } as never,
      identifier: input.identifier,
      manifest: buildUserMcpManifest({
        description: input.description,
        identifier: input.identifier,
        title: input.title,
        tools,
        url,
      }) as never,
      settings: {},
      source: 'custom',
      type: 'customPlugin',
    });
    return summarizeConnector(row as ConnectorRow, true);
  }

  /** Перечитать `tools/list` своего подключения и обновить manifest; название и описание остаются. */
  async refreshUserMcp(
    identifier: string,
    arckepUserId: number,
  ): Promise<ConnectorSummary | null> {
    if (!isArckepUserMcpId(identifier)) return null;
    const existing = await this.pluginModel.findById(identifier);
    if (!existing) return null;
    const sealed = (existing.customParams as { arckepUserMcp?: { sealed?: unknown } } | null)
      ?.arckepUserMcp?.sealed;
    if (typeof sealed !== 'string' || !sealed.startsWith('enc:v1:')) {
      throw new UserMcpGatewayError(
        'Подключение повреждено: удалите его и добавьте заново',
        409,
      );
    }
    const tools = await listUserMcpTools({
      // refresh: шлюз держит tools/list в кэше 10 минут и без заголовка вернул бы старый список
      headers: buildUserMcpHeaders({ arckepUserId, identifier, refresh: true, sealed }),
    });
    if (tools.length === 0) {
      throw new UserMcpGatewayError('Сервер не отдал ни одного подходящего инструмента', 422);
    }
    const meta = ((existing.manifest ?? {}) as { meta?: { description?: unknown; title?: unknown } })
      .meta;
    const manifest = buildUserMcpManifest({
      description: typeof meta?.description === 'string' ? meta.description : '',
      identifier,
      title: typeof meta?.title === 'string' && meta.title ? meta.title : identifier,
      tools,
    });
    await this.pluginModel.update(identifier, { manifest: manifest as never });
    return summarizeConnector({ ...(existing as ConnectorRow), manifest }, true);
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
