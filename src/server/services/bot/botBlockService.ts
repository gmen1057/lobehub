import debug from 'debug';

import { getServerDB } from '@/database/core/db-adaptor';
import { AgentBotProviderModel } from '@/database/models/agentBotProvider';
import { KeyVaultsGateKeeper } from '@/server/modules/KeyVaultsEncrypt';
import { GatewayService } from '@/server/services/gateway';

import { getBotMessageRouter } from './BotMessageRouter';

const log = debug('lobe-server:service:bot-block');

export interface SetBotBlockedResult {
  applicationId: string;
  blocked: boolean;
  platform: string;
}

/**
 * Admin-controlled block / unblock of a bot.
 *
 * - `blocked=true` → merges `settings.adminBlocked = true`, stops the client,
 *   invalidates the cache. The bot cannot be re-enabled by the owner until
 *   an admin unblocks it.
 * - `blocked=false` → merges `settings.adminBlocked = false`, invalidates the
 *   cache (so the owner can re-enable).  Does NOT auto-start — the owner
 *   must explicitly re-enable.
 *
 * `userId` MUST be a server-resolved owner id.  The model scopes every
 * read/write by `WHERE id = ? AND userId = ?`, so a foreign (botId, userId)
 * pair touches 0 rows and `findById` returns null → caller surfaces 404
 * (anti-IDOR).
 *
 * Settings merge is shallow — `adminBlocked` is written without clobbering
 * other keys in `agent_bot_providers.settings` JSONB.
 *
 * @returns the result, or null when the bot is not owned by `userId` / missing.
 */
export async function setBotBlocked(
  userId: string,
  botId: string,
  blocked: boolean,
): Promise<SetBotBlockedResult | null> {
  const serverDB = await getServerDB();
  const gateKeeper = await KeyVaultsGateKeeper.initWithEnvKey();
  const model = new AgentBotProviderModel(serverDB, userId, gateKeeper);

  // Anti-IDOR: findById is scoped to this.userId — foreign/missing id → null.
  const existing = await model.findById(botId);
  if (!existing) {
    log('setBotBlocked: bot %s not owned by user %s (or missing)', botId, userId);
    return null;
  }

  const { platform, applicationId } = existing;

  // Merge adminBlocked into settings without clobbering existing keys.
  const currentSettings = (existing.settings ?? {}) as Record<string, unknown>;
  const mergedSettings = { ...currentSettings, adminBlocked: blocked };
  await model.update(botId, { settings: mergedSettings });

  const service = new GatewayService();
  if (blocked) {
    await service.stopClient(platform, applicationId);
  }
  // On unblock we do NOT startClient — the owner must explicitly re-enable.

  // Drop the cached bot so the next webhook reloads fresh config.
  await getBotMessageRouter().invalidateBot(platform, applicationId);

  log(
    'setBotBlocked: %s %s:%s (adminBlocked=%s)',
    blocked ? 'blocked' : 'unblocked',
    platform,
    applicationId,
    blocked,
  );

  return { applicationId, blocked, platform };
}
