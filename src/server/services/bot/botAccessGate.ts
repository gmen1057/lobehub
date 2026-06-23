import { BotEndUserModel } from '@/database/models/botEndUser';
import type { LobeChatDatabase } from '@/database/type';

/**
 * Bot-level access mode (the client's control surface, stored in
 * `agent_bot_providers.settings.dm.policy`). Mirrors the telegram schema enum.
 *   - open      → anyone may use the bot (client pays for all consumption, §11.1)
 *   - allowlist → only end-users with an active bot_end_users row (default = owner-only)
 *   - disabled  → nobody but the owner
 */
export type DmPolicy = 'open' | 'allowlist' | 'disabled';

export type AccessReason =
  | 'owner'
  | 'open'
  | 'allowlisted'
  | 'fail_open'
  | 'not_allowlisted'
  | 'disabled'
  | 'suspended'
  | 'quota_exhausted';

export interface AccessDecision {
  allow: boolean;
  /** bot_end_users.id of the allowed non-owner row, for usage increment after allow. */
  endUserRowId?: string;
  /** Friendly message to post to the end-user on deny. */
  message?: string;
  reason: AccessReason;
}

// Friendly, non-technical deny messages (RU — primary market). Clients may customise later.
const DENY_DISABLED = 'Этот бот сейчас недоступен.';
const DENY_NOT_ALLOWLISTED = 'У вас нет доступа к этому боту. Обратитесь к его владельцу.';
const DENY_SUSPENDED = 'Ваш доступ к этому боту приостановлен.';
const DENY_QUOTA = 'Вы исчерпали лимит сообщений для этого бота.';

function denyByStatusOrQuota(row: {
  messagesUsed: number;
  quotaMessages: number | null;
  status: string;
}): AccessDecision | null {
  if (row.status === 'suspended' || row.status === 'revoked') {
    return { allow: false, message: DENY_SUSPENDED, reason: 'suspended' };
  }
  if (row.quotaMessages != null && row.messagesUsed >= row.quotaMessages) {
    return { allow: false, message: DENY_QUOTA, reason: 'quota_exhausted' };
  }
  return null;
}

/**
 * Decide whether an inbound end-user message may trigger a (paid) agent run.
 * MUST be called BEFORE any topic/typing/agent work so a denied message costs nothing.
 *
 * Fail-OPEN (owner decision D3, 2026-06-23): on any DB error the gate ALLOWS and logs,
 * so a transient infra blip never blocks real users. The owner pays for all consumption
 * (§11.1), so erring toward availability is his stated preference.
 */
export async function checkBotAccess(params: {
  botProviderId: string;
  db: LobeChatDatabase;
  endUserId: string;
  endUserUsername?: string | null;
  /** settings.dm.policy; undefined ⇒ owner-only default ('allowlist'). */
  policy?: DmPolicy;
  platform: string;
  /** settings.userId — the owner's platform user id. Always allowed (it's their bot). */
  ownerPlatformUserId?: string;
}): Promise<AccessDecision> {
  const { botProviderId, db, endUserId, platform } = params;
  const policy: DmPolicy = params.policy ?? 'allowlist';

  try {
    // The bot owner is always allowed, regardless of policy — it is their own bot.
    if (params.ownerPlatformUserId && String(params.ownerPlatformUserId) === String(endUserId)) {
      return { allow: true, reason: 'owner' };
    }

    if (policy === 'disabled') {
      return { allow: false, message: DENY_DISABLED, reason: 'disabled' };
    }

    const model = new BotEndUserModel(db);

    if (policy === 'open') {
      const row = await model.findOrCreate({
        botProviderId,
        endUserId,
        endUserUsername: params.endUserUsername,
        platform,
      });
      return denyByStatusOrQuota(row) ?? { allow: true, endUserRowId: row.id, reason: 'open' };
    }

    // allowlist (also the owner-only default): only an existing active row passes.
    const row = await model.findByProviderAndEndUser(botProviderId, endUserId);
    if (!row) {
      return { allow: false, message: DENY_NOT_ALLOWLISTED, reason: 'not_allowlisted' };
    }
    return denyByStatusOrQuota(row) ?? { allow: true, endUserRowId: row.id, reason: 'allowlisted' };
  } catch (error) {
    console.error('[botAccessGate] access check failed — failing OPEN:', error);
    return { allow: true, reason: 'fail_open' };
  }
}
