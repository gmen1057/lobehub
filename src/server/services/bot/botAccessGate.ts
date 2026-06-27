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
  | 'quota_exhausted'
  | 'pending'
  | 'uname_match';

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
const DENY_SUSPENDED = 'Ваш доступ к этому боту приостановлен.';
const DENY_QUOTA = 'Вы исчерпали лимит сообщений для этого бота.';
const DENY_PENDING = 'Запрос на доступ отправлен. Владелец бота одобрит его в ближайшее время.';

/** Normalize a Telegram username for sentinel matching: lowercase, strip leading @. */
export function normalizeUsername(raw?: string | null): string | null {
  if (!raw) return null;
  let s = raw.trim().toLowerCase();
  if (s.startsWith('@')) s = s.slice(1);
  return s || null;
}

/** Status-only deny (pending / suspended / revoked). Quota is enforced separately
 *  by an atomic consume (see `decide` below) so it can never overshoot under
 *  concurrency. */
function denyByStatus(row: { status: string }): AccessDecision | null {
  if (row.status === 'pending') {
    return { allow: false, message: DENY_PENDING, reason: 'pending' };
  }
  if (row.status === 'suspended' || row.status === 'revoked') {
    return { allow: false, message: DENY_SUSPENDED, reason: 'suspended' };
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

    // Allow an active row iff a quota unit can be atomically consumed. The
    // conditional UPDATE in tryConsumeQuota is the arbiter — no read-then-write
    // race, no fire-and-forget undercount. Owner / fail-open never reach here.
    const decide = async (
      decideRow: { id: string; status: string },
      reason: AccessReason,
    ): Promise<AccessDecision> => {
      const statusDeny = denyByStatus(decideRow);
      if (statusDeny) return statusDeny;
      const consumed = await model.tryConsumeQuota(decideRow.id);
      if (!consumed) {
        return { allow: false, message: DENY_QUOTA, reason: 'quota_exhausted' };
      }
      return { allow: true, endUserRowId: decideRow.id, reason };
    };

    if (policy === 'open') {
      const row = await model.findOrCreate({
        botProviderId,
        endUserId,
        endUserUsername: params.endUserUsername,
        platform,
      });
      return decide(row, 'open');
    }

    // allowlist (also the owner-only default): only an existing active row passes.
    const row = await model.findByProviderAndEndUser(botProviderId, endUserId);
    if (row) {
      return decide(row, 'allowlisted');
    }

    // No numeric-id row. Try sentinel (username-based) match — BRIEF-08 Part A.
    const uname = normalizeUsername(params.endUserUsername);
    if (uname) {
      const sentinelKey = `uname:${uname}`;
      const sentinelRow = await model.findByProviderAndUsername(botProviderId, sentinelKey);
      if (sentinelRow) {
        // Backfill: replace the sentinel end_user_id with the real numeric id.
        try {
          const bound = await model.bindNumericId(sentinelRow.id, botProviderId, endUserId);
          if (bound) {
            return decide(bound, 'uname_match');
          }
        } catch {
          // UNIQUE collision: a row with the real numeric id already exists.
          // Delete the sentinel — the id-based row wins.
        }
        await model.deleteById(sentinelRow.id);
        // Re-query by numeric id (the collision row or a row we just bound).
        const idRow = await model.findByProviderAndEndUser(botProviderId, endUserId);
        if (idRow) {
          return decide(idRow, 'allowlisted');
        }
      }
    }

    // No match by id or username → create a pending knock row (BRIEF-08 Part B).
    await model.createPending({
      botProviderId,
      endUserId,
      endUserUsername: params.endUserUsername,
      platform,
    });
    return { allow: false, message: DENY_PENDING, reason: 'pending' };
  } catch (error) {
    console.error('[botAccessGate] access check failed — failing OPEN:', error);
    return { allow: true, reason: 'fail_open' };
  }
}
