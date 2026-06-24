export const ArckepBotIdentifier = 'arckep-bot';

export enum ArckepBotApiName {
  getBotConfig = 'getBotConfig',
  listMyBots = 'listMyBots',
}

export interface ListMyBotsParams {}

export interface GetBotConfigParams {
  /** The bot's id from listMyBots — NEVER invented; always taken from the list. */
  bot_id: string;
}

/** One row of the user's bot list (safe subset — no token, no owner secrets). */
export interface BotSummary {
  agent_id: string | null;
  /** Telegram bot id (the @bot's numeric application id). */
  application_id: string;
  /** agent_bot_providers.id (uuid) — the handle for getBotConfig and future edits. */
  bot_id: string;
  platform: string;
  /** Live gateway state (connected/disconnected/…) when known. */
  runtime_status?: string | null;
  status: 'disabled' | 'enabled';
}

/** Full safe config of one bot (greeting/access/limits — never the token). */
export interface BotConfigResult {
  agent_id: string | null;
  application_id: string;
  bot_id: string;
  char_limit?: number | null;
  custom_commands?: unknown[] | null;
  /** Access mode: open | allowlist | disabled. */
  dm_policy?: string | null;
  greeting?: string | null;
  status: 'disabled' | 'enabled';
}
