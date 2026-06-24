import type { BotConfigResult, BotSummary } from '@lobechat/builtin-tool-arckep-bot';

import { getServerDB } from '@/database/core/db-adaptor';
import { AgentBotProviderModel } from '@/database/models/agentBotProvider';
import { getBotRuntimeStatus } from '@/server/services/gateway/runtimeStatus';

/**
 * Read-only bot config access for the arckep-bot configurator tool.
 *
 * Bot data is native to the LobeChat DB (`agent_bot_providers`, canonical home
 * D1), so we read it directly via the userId-scoped model — no arckep round-trip.
 * `AgentBotProviderModel` filters every query by `userId` (anti-IDOR): a foreign
 * bot id returns null. The mapped shapes are a SAFE subset — the encrypted bot
 * token (`credentials`) is NEVER included.
 *
 * Shared by both the client route (`/chat/api/bot-config-tool`, session-authed)
 * and the server runtime (`serverRuntimes/arckepBot.ts`, group/background).
 */

export async function listBotsForUser(userId: string, serverDB?: any): Promise<BotSummary[]> {
  const db = serverDB ?? (await getServerDB());
  const model = new AgentBotProviderModel(db, userId);
  const rows = await model.query({ platform: 'telegram' });

  return Promise.all(
    rows.map(async (r) => ({
      agent_id: r.agentId ?? null,
      application_id: r.applicationId,
      bot_id: r.id,
      platform: r.platform,
      runtime_status: (await getBotRuntimeStatus(r.platform, r.applicationId)).status,
      status: (r.enabled ? 'enabled' : 'disabled') as 'disabled' | 'enabled',
    })),
  );
}

export async function getBotConfigForUser(
  userId: string,
  botId: string,
  serverDB?: any,
): Promise<BotConfigResult | null> {
  const db = serverDB ?? (await getServerDB());
  const model = new AgentBotProviderModel(db, userId);
  const row = await model.findById(botId);
  if (!row) return null;

  const settings = (row.settings ?? {}) as Record<string, unknown>;
  const dm =
    settings.dm && typeof settings.dm === 'object' ? (settings.dm as Record<string, unknown>) : {};

  return {
    agent_id: row.agentId ?? null,
    application_id: row.applicationId,
    bot_id: row.id,
    char_limit: typeof settings.charLimit === 'number' ? settings.charLimit : null,
    custom_commands: Array.isArray(settings.customCommands) ? settings.customCommands : null,
    dm_policy: typeof dm.policy === 'string' ? dm.policy : null,
    greeting: typeof settings.greeting === 'string' ? settings.greeting : null,
    status: (row.enabled ? 'enabled' : 'disabled') as 'disabled' | 'enabled',
  };
}
