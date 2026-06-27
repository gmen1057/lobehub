import { BotAccessCodeModel } from '@/database/models/botAccessCode';
import { BotEndUserModel } from '@/database/models/botEndUser';
import type { LobeChatDatabase } from '@/database/type';

/**
 * Redeem a single-use access code (Phase 27).
 *
 * Atomicity guarantee: `BotAccessCodeModel.consumeCode` uses
 * `UPDATE ... WHERE consumed_at IS NULL` — the database serialises concurrent
 * attempts, so exactly one call wins (gets the RETURNING row). All others get
 * undefined and receive a friendly denial.
 *
 * On success the end-user row is upserted as `status='active'`, `granted_via='code'`,
 * and inherits the code's quota (if any).
 */
export async function redeemCode(params: {
  botProviderId: string;
  code: string;
  endUserId: string;
  endUserUsername?: string | null;
  platform: string;
  db: LobeChatDatabase;
}): Promise<{ ok: boolean; message: string }> {
  const { botProviderId, code, endUserId, endUserUsername, platform, db } = params;

  const codeModel = new BotAccessCodeModel(db);

  // Atomically consume the code — only one caller gets the row.
  const consumed = await codeModel.consumeCode(botProviderId, code, endUserId);
  if (!consumed) {
    return { ok: false, message: 'Код недействителен или уже использован' };
  }

  // Upsert the end-user as active with the code's quota and granted_via='code'.
  const endUserModel = new BotEndUserModel(db);
  await endUserModel.upsertActive({
    botProviderId,
    endUserId,
    endUserUsername,
    platform,
    quotaMessages: consumed.quotaMessages,
  });

  return { ok: true, message: 'Доступ активирован!' };
}

/**
 * Parse a Telegram `/start <code>` or `/redeem <code>` message and return the code.
 * Returns null if the text doesn't look like a redeem attempt.
 */
export function parseRedeemCode(text?: string | null): string | null {
  if (!text) return null;
  const trimmed = text.trim();

  for (const prefix of ['/start ', '/redeem ']) {
    if (trimmed.startsWith(prefix)) {
      const code = trimmed.slice(prefix.length).trim();
      return code || null;
    }
  }
  return null;
}
