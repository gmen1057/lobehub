import { and, eq, isNull, sql } from 'drizzle-orm';

import type { BotAccessCodeItem, NewBotAccessCode } from '../schemas';
import { botAccessCodes } from '../schemas';
import type { LobeChatDatabase } from '../type';

/**
 * Single-use access-code operations (Phase 27).
 *
 * The core invariant: `consumeCode` uses an atomic UPDATE ... WHERE consumed_at IS NULL
 * so exactly one caller wins under concurrency. No read-then-write — the RETURNING clause
 * is the single arbiter of success.
 */
export class BotAccessCodeModel {
  private db: LobeChatDatabase;

  constructor(db: LobeChatDatabase) {
    this.db = db;
  }

  /**
   * Atomically consume a code.  Returns the updated row on success, undefined otherwise.
   *
   * Under ANY concurrent calls for the same (botProviderId, code), exactly ONE call
   * receives the row with the newly-set consumed_at; all others receive undefined.
   */
  consumeCode = async (
    botProviderId: string,
    code: string,
    consumedBy: string,
  ): Promise<BotAccessCodeItem | undefined> => {
    const [row] = await this.db
      .update(botAccessCodes)
      .set({
        consumedAt: sql`now()`,
        consumedBy,
      })
      .where(
        and(
          eq(botAccessCodes.botProviderId, botProviderId),
          eq(botAccessCodes.code, code),
          isNull(botAccessCodes.consumedAt),
        ),
      )
      .returning();
    return row;
  };

  /** Insert codes in bulk (for the backend generate API). Idempotent per UNIQUE(bot, code). */
  insertCodes = async (codes: NewBotAccessCode[]): Promise<void> => {
    await this.db
      .insert(botAccessCodes)
      .values(codes)
      .onConflictDoNothing({ target: [botAccessCodes.botProviderId, botAccessCodes.code] });
  };

  /** List all codes for a bot (for the «Мои боты» readout). */
  listByProvider = async (botProviderId: string): Promise<BotAccessCodeItem[]> => {
    return this.db
      .select()
      .from(botAccessCodes)
      .where(eq(botAccessCodes.botProviderId, botProviderId))
      .orderBy(botAccessCodes.createdAt);
  };
}
