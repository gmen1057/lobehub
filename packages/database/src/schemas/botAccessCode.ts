import { index, integer, pgTable, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';

import { timestamps, timestamptz } from './_helpers';
import { agentBotProviders } from './agentBotProvider';

/**
 * Single-use access codes for reseller bot end-users (Phase 27).
 *
 * Each code is scoped to one bot provider and is consumed atomically:
 * `UPDATE ... SET consumed_at=now() WHERE consumed_at IS NULL`.
 * Exactly one redeemer wins under concurrency — no read-then-write.
 *
 * ON DELETE CASCADE: codes are wiped when the bot provider is deleted.
 */
export const botAccessCodes = pgTable(
  'bot_access_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** FK → agent_bot_providers.id. Cascade-deletes with the bot. */
    botProviderId: uuid('bot_provider_id')
      .references(() => agentBotProviders.id, { onDelete: 'cascade' })
      .notNull(),

    /** The code string (8-10 chars, base32, no ambiguous chars). */
    code: varchar('code', { length: 20 }).notNull(),

    /** Status to set on the end-user row when this code is redeemed. */
    statusOnGrant: varchar('status_on_grant', { length: 20 }).default('active').notNull(),

    /** Optional message quota the redeemer receives. */
    quotaMessages: integer('quota_messages'),

    /** When the code was consumed (NULL = still available). */
    consumedAt: timestamptz('consumed_at'),

    /** Platform id of the end-user who redeemed the code. */
    consumedBy: varchar('consumed_by', { length: 255 }),

    /** How this code was created: 'owner' = cabinet, 'admin' = admin panel. */
    createdVia: varchar('created_via', { length: 20 }).default('owner').notNull(),

    ...timestamps,
  },
  (t) => [
    /** One code per bot — UNIQUE prevents duplicate codes within a bot. */
    uniqueIndex('bot_access_codes_provider_code_unique').on(t.botProviderId, t.code),
    /** Fast lookup of unconsumed codes for a bot. */
    index('bot_access_codes_provider_consumed_idx').on(t.botProviderId, t.consumedAt),
  ],
);

export type NewBotAccessCode = typeof botAccessCodes.$inferInsert;
export type BotAccessCodeItem = typeof botAccessCodes.$inferSelect;
