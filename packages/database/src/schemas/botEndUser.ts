import { index, integer, numeric, pgTable, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { createInsertSchema } from 'drizzle-zod';

import { timestamps, timestamptz } from './_helpers';
import { agentBotProviders } from './agentBotProvider';

/**
 * Per-end-user access + quota state for a reseller bot's end-users.
 *
 * The bot-level access MODE (open | allowlist | disabled) lives in
 * `agent_bot_providers.settings.dm.policy` (the client's control surface).
 * This table holds the per-end-user state the gate reads BEFORE any paid run:
 *   - `status` = allowlist membership / per-user state (active | suspended | revoked)
 *   - `quotaMessages` / `messagesUsed` = the client's per-user message cap (null = unlimited)
 *   - `quotaSpentRub` = report-only spend attribution against the client's single arckep
 *     balance (§11.1 — NOT an enforced sub-balance; never a billing authority).
 *
 * Lives in the LobeChat DB. Applied via a manual Drizzle migration (see
 * MIGRATION-DEPLOY-PLAYBOOK.md). ON DELETE CASCADE: rows are wiped when the bot
 * provider is deleted (spend history survives in arckep `chat_token_charges`).
 */
export const botEndUserStatuses = ['active', 'suspended', 'revoked', 'pending'] as const;
export type BotEndUserStatus = (typeof botEndUserStatuses)[number];

/** How the end-user came to be granted access (for audit / future grant API). */
export const botEndUserGrantedVia = ['auto', 'owner', 'code', 'payment', 'knock'] as const;
export type BotEndUserGrantedVia = (typeof botEndUserGrantedVia)[number];

export const botEndUsers = pgTable(
  'bot_end_users',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** FK → agent_bot_providers.id. Cascade-deletes with the bot. */
    botProviderId: uuid('bot_provider_id')
      .references(() => agentBotProviders.id, { onDelete: 'cascade' })
      .notNull(),

    /** Platform identifier, mirrors the bot provider ('telegram' | ...). */
    platform: varchar('platform', { length: 50 }).notNull(),

    /** Platform-specific end-user id (e.g. Telegram numeric id as string). */
    endUserId: varchar('end_user_id', { length: 255 }).notNull(),

    /** Display handle for the client's «Мои боты» readout (best-effort). */
    endUserUsername: varchar('end_user_username', { length: 255 }),

    /** Allowlist membership / per-user state. */
    status: varchar('status', { length: 20 }).$type<BotEndUserStatus>().default('active').notNull(),

    /** Per-user message cap. NULL = unlimited (client's control surface). */
    quotaMessages: integer('quota_messages'),

    /** Durable message counter (Redis is the fast path; this is truth). */
    messagesUsed: integer('messages_used').default(0).notNull(),

    /** Report-only spend attribution (₽). NOT an enforced sub-balance (§11.1). */
    quotaSpentRub: numeric('quota_spent_rub', { precision: 12, scale: 4 }).default('0').notNull(),

    /** When the per-period counters reset (NULL = no period reset). */
    periodResetsAt: timestamptz('period_resets_at'),

    /** Provenance of the grant. */
    grantedVia: varchar('granted_via', { length: 20 })
      .$type<BotEndUserGrantedVia>()
      .default('auto')
      .notNull(),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('bot_end_users_provider_end_user_unique').on(t.botProviderId, t.endUserId),
    index('bot_end_users_provider_idx').on(t.botProviderId),
    index('bot_end_users_provider_status_idx').on(t.botProviderId, t.status),
  ],
);

export const insertBotEndUserSchema = createInsertSchema(botEndUsers);

export type NewBotEndUser = typeof botEndUsers.$inferInsert;
export type BotEndUserItem = typeof botEndUsers.$inferSelect;
