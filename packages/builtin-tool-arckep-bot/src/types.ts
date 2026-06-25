export const ArckepBotIdentifier = 'arckep-bot';

export enum ArckepBotApiName {
  getBotConfig = 'getBotConfig',
  listMyBots = 'listMyBots',
  setGreeting = 'setGreeting',
  setCommands = 'setCommands',
  setAccessRule = 'setAccessRule',
  setModel = 'setModel',
  enableBot = 'enableBot',
  disableBot = 'disableBot',
}

export interface ListMyBotsParams {}

export interface GetBotConfigParams {
  bot_id: string;
}

export interface SetGreetingParams {
  bot_id: string;
  greeting: string;
}

export interface SetCommandsParams {
  bot_id: string;
  commands: Array<{ description: string; name: string; response: string }>;
}

export interface SetAccessRuleParams {
  bot_id: string;
  dm_policy?: string;
  char_limit?: number;
}

export interface SetModelParams {
  bot_id: string;
  model: string;
  provider: string;
}

export interface EnableBotParams {
  bot_id: string;
}

export interface DisableBotParams {
  bot_id: string;
}

/** One row of the user's bot list (safe subset — no token, no owner secrets). */
export interface BotSummary {
  agent_id: string | null;
  application_id: string;
  bot_id: string;
  platform: string;
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
  dm_policy?: string | null;
  greeting?: string | null;
  status: 'disabled' | 'enabled';
}
