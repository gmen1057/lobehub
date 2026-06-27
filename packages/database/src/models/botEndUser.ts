import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';

import type {
  BotEndUserGrantedVia,
  BotEndUserItem,
  BotEndUserStatus,
  NewBotEndUser,
} from '../schemas';
import { botEndUsers } from '../schemas';
import type { LobeChatDatabase } from '../type';

/**
 * Bot-scoped (NOT user-scoped) access/quota state for a reseller bot's end-users.
 * Read by the access gate BEFORE any paid agent run. See botEndUser schema.
 */
export class BotEndUserModel {
  private db: LobeChatDatabase;

  constructor(db: LobeChatDatabase) {
    this.db = db;
  }

  findByProviderAndEndUser = async (
    botProviderId: string,
    endUserId: string,
  ): Promise<BotEndUserItem | undefined> => {
    const [row] = await this.db
      .select()
      .from(botEndUsers)
      .where(
        and(eq(botEndUsers.botProviderId, botProviderId), eq(botEndUsers.endUserId, endUserId)),
      )
      .limit(1);
    return row;
  };

  /**
   * Get the row, or lazily create it. Race-safe via the UNIQUE(bot_provider_id, end_user_id)
   * index: a concurrent insert is swallowed by onConflictDoNothing and the row is re-read.
   */
  findOrCreate = async (params: {
    botProviderId: string;
    endUserId: string;
    endUserUsername?: string | null;
    grantedVia?: BotEndUserGrantedVia;
    platform: string;
    status?: BotEndUserStatus;
  }): Promise<BotEndUserItem> => {
    const existing = await this.findByProviderAndEndUser(params.botProviderId, params.endUserId);
    if (existing) return existing;

    await this.db
      .insert(botEndUsers)
      .values({
        botProviderId: params.botProviderId,
        endUserId: params.endUserId,
        endUserUsername: params.endUserUsername ?? null,
        grantedVia: params.grantedVia ?? 'auto',
        platform: params.platform,
        status: params.status ?? 'active',
      } satisfies NewBotEndUser)
      .onConflictDoNothing({ target: [botEndUsers.botProviderId, botEndUsers.endUserId] });

    const row = await this.findByProviderAndEndUser(params.botProviderId, params.endUserId);
    if (!row) {
      throw new Error('BotEndUserModel.findOrCreate: row missing after insert');
    }
    return row;
  };

  /**
   * Atomically consume one quota unit: increment messagesUsed by 1 **only if** the
   * row is still under its quota (or quotaMessages is NULL = unlimited). Returns
   * true when a unit was consumed (caller may proceed), false when the quota is
   * already exhausted.
   *
   * The conditional UPDATE is the single arbiter: concurrent messages cannot
   * overshoot the quota, and the count is never silently dropped (replaces the
   * old fire-and-forget increment). `updatedAt`/`accessedAt` auto-update via
   * $onUpdate.
   */
  tryConsumeQuota = async (id: string): Promise<boolean> => {
    const rows = await this.db
      .update(botEndUsers)
      .set({ messagesUsed: sql`${botEndUsers.messagesUsed} + 1` })
      .where(
        and(
          eq(botEndUsers.id, id),
          or(
            isNull(botEndUsers.quotaMessages),
            lt(botEndUsers.messagesUsed, botEndUsers.quotaMessages),
          ),
        ),
      )
      .returning({ id: botEndUsers.id });
    return rows.length > 0;
  };

  /** All end-users of a bot (for the «Мои боты» per-user readout, phase 15). */
  listByProvider = async (botProviderId: string): Promise<BotEndUserItem[]> => {
    return this.db.select().from(botEndUsers).where(eq(botEndUsers.botProviderId, botProviderId));
  };

  /**
   * Find a row by sentinel username key (`uname:<normalized>`).
   * Used at first contact: when a known user with no numeric-id row writes,
   * we match by the pre-provisioned sentinel.
   */
  findByProviderAndUsername = async (
    botProviderId: string,
    unameKey: string,
  ): Promise<BotEndUserItem | undefined> => {
    const [row] = await this.db
      .select()
      .from(botEndUsers)
      .where(and(eq(botEndUsers.botProviderId, botProviderId), eq(botEndUsers.endUserId, unameKey)))
      .limit(1);
    return row;
  };

  /**
   * Backfill a sentinel (uname:) row with the real numeric Telegram id.
   * Returns the updated row, or null if the sentinel row no longer exists
   * (0 rows updated). On a UNIQUE collision — a row with the real numeric id
   * already exists — the UPDATE THROWS; the caller catches it and deletes the
   * sentinel so the id-based row wins.
   */
  bindNumericId = async (
    rowId: string,
    botProviderId: string,
    realNumericId: string,
  ): Promise<BotEndUserItem | null> => {
    // Try UPDATE: replace sentinel end_user_id with the real numeric id.
    const result = await this.db
      .update(botEndUsers)
      .set({ endUserId: realNumericId })
      .where(and(eq(botEndUsers.id, rowId), eq(botEndUsers.botProviderId, botProviderId)))
      .returning();

    if (result.length > 0) {
      return result[0];
    }
    return null;
  };

  /**
   * Idempotently create a pending knock row for a stranger contacting an allowlist bot.
   * ON CONFLICT (bot_provider_id, end_user_id) → do nothing.
   */
  createPending = async (params: {
    botProviderId: string;
    endUserId: string;
    endUserUsername?: string | null;
    platform: string;
  }): Promise<BotEndUserItem> => {
    await this.db
      .insert(botEndUsers)
      .values({
        botProviderId: params.botProviderId,
        endUserId: params.endUserId,
        endUserUsername: params.endUserUsername ?? null,
        grantedVia: 'knock',
        platform: params.platform,
        status: 'pending',
      } satisfies NewBotEndUser)
      .onConflictDoNothing({ target: [botEndUsers.botProviderId, botEndUsers.endUserId] });

    const row = await this.findByProviderAndEndUser(params.botProviderId, params.endUserId);
    if (!row) {
      throw new Error('BotEndUserModel.createPending: row missing after insert');
    }
    return row;
  };

  /** Delete a row by its primary key (for backfill collision cleanup). */
  deleteById = async (id: string): Promise<void> => {
    await this.db.delete(botEndUsers).where(eq(botEndUsers.id, id));
  };

  /**
   * Upsert an active end-user row granting access (Phase 27 code redeem).
   * INSERT ... ON CONFLICT DO UPDATE ensures the row is always active, even if
   * a suspended/revoked row already exists.
   */
  upsertActive = async (params: {
    botProviderId: string;
    endUserId: string;
    endUserUsername?: string | null;
    platform: string;
    quotaMessages?: number | null;
  }): Promise<BotEndUserItem> => {
    const [row] = await this.db
      .insert(botEndUsers)
      .values({
        botProviderId: params.botProviderId,
        endUserId: params.endUserId,
        endUserUsername: params.endUserUsername ?? null,
        grantedVia: 'code',
        platform: params.platform,
        status: 'active',
        quotaMessages: params.quotaMessages ?? null,
      } satisfies NewBotEndUser)
      .onConflictDoUpdate({
        target: [botEndUsers.botProviderId, botEndUsers.endUserId],
        set: {
          status: 'active',
          grantedVia: 'code',
          endUserUsername: params.endUserUsername ?? botEndUsers.endUserUsername,
          quotaMessages: params.quotaMessages ?? botEndUsers.quotaMessages,
          updatedAt: sql`now()`,
        },
      })
      .returning();

    if (!row) {
      throw new Error('BotEndUserModel.upsertActive: row missing after upsert');
    }
    return row;
  };
}
