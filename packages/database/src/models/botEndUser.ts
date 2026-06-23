import { and, eq, sql } from 'drizzle-orm';

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
   * Durable usage bump (messagesUsed + 1). `updatedAt`/`accessedAt` auto-update via $onUpdate.
   * Redis may front this as a fast counter elsewhere; this table stays the source of truth.
   */
  incrementUsage = async (id: string): Promise<void> => {
    await this.db
      .update(botEndUsers)
      .set({ messagesUsed: sql`${botEndUsers.messagesUsed} + 1` })
      .where(eq(botEndUsers.id, id));
  };

  /** All end-users of a bot (for the «Мои боты» per-user readout, phase 15). */
  listByProvider = async (botProviderId: string): Promise<BotEndUserItem[]> => {
    return this.db.select().from(botEndUsers).where(eq(botEndUsers.botProviderId, botProviderId));
  };
}
