import debug from 'debug';

import { getServerDB } from '@/database/core/db-adaptor';
import { AgentBotProviderModel } from '@/database/models/agentBotProvider';
import { KeyVaultsGateKeeper } from '@/server/modules/KeyVaultsEncrypt';
import { GatewayService } from '@/server/services/gateway';
import { getBotRuntimeStatus } from '@/server/services/gateway/runtimeStatus';

import { getBotMessageRouter } from './BotMessageRouter';

const log = debug('lobe-server:service:bot-enable');

export interface SetBotEnabledResult {
  applicationId: string;
  enabled: boolean;
  platform: string;
  runtimeStatus: string;
}

/**
 * Flip a bot's `enabled` flag AND apply the live runtime side effects so the
 * change takes effect immediately, not on a cold reload.
 *
 * Single source of truth for "toggle a bot on/off with live-apply". It mirrors
 * the side effects the tRPC router performs (routers/lambda/agentBotProvider.ts):
 *   - enable  → update(enabled:true) [commit-then-register] → GatewayService.startClient → invalidateBot
 *   - disable → update(enabled:false) → GatewayService.stopClient → invalidateBot
 * If the side-effect set changes here, keep the tRPC `update` / `connectBot`
 * mutations in sync — a bare `model.update()` writes config but never reloads the
 * running bot, so the toggle would silently no-op until the next process restart.
 *
 * `userId` MUST be a server-resolved owner id. The model scopes every read/write
 * by `WHERE id = ? AND userId = ?`, so a foreign (botId, userId) pair touches 0
 * rows and `findById` returns null → caller surfaces 404, never 403 (anti-IDOR).
 *
 * @returns the new state, or null when the bot is not owned by `userId` / missing.
 */
export async function setBotEnabled(
  userId: string,
  botId: string,
  enabled: boolean,
): Promise<SetBotEnabledResult | null> {
  const serverDB = await getServerDB();
  const gateKeeper = await KeyVaultsGateKeeper.initWithEnvKey();
  const model = new AgentBotProviderModel(serverDB, userId, gateKeeper);

  // Anti-IDOR: findById is scoped to this.userId — foreign/missing id → null.
  const existing = await model.findById(botId);
  if (!existing) {
    log('setBotEnabled: bot %s not owned by user %s (or missing)', botId, userId);
    return null;
  }

  const { platform, applicationId } = existing;

  // Persist the flag FIRST (commit-then-register): startClient reads the enabled
  // row back from the DB, so the write must land before the webhook is registered.
  await model.update(botId, { enabled });

  const service = new GatewayService();
  if (enabled) {
    await service.startClient(platform, applicationId, userId);
  } else {
    await service.stopClient(platform, applicationId);
  }

  // Drop the cached bot so the next webhook reloads fresh config.
  await getBotMessageRouter().invalidateBot(platform, applicationId);

  const runtime = await getBotRuntimeStatus(platform, applicationId);
  log(
    'setBotEnabled: %s %s:%s → runtimeStatus=%s',
    enabled ? 'enabled' : 'disabled',
    platform,
    applicationId,
    runtime.status,
  );

  return { applicationId, enabled, platform, runtimeStatus: runtime.status };
}
