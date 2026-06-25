import debug from 'debug';

import { AgentModel } from '@/database/models/agent';
import { AgentBotProviderModel } from '@/database/models/agentBotProvider';
import { getServerDB } from '@/database/core/db-adaptor';
import { KeyVaultsGateKeeper } from '@/server/modules/KeyVaultsEncrypt';

import { getBotMessageRouter } from './BotMessageRouter';

const log = debug('lobe-server:service:bot-mutation');

export interface SetGreetingParams {
  botId: string;
  greeting: string;
  userId: string;
}

export interface SetCommandsParams {
  botId: string;
  commands: Array<{ description: string; name: string; response: string }>;
  userId: string;
}

export interface SetAccessRuleParams {
  botId: string;
  charLimit?: number | null;
  dmPolicy?: string | null;
  userId: string;
}

export interface SetModelParams {
  botId: string;
  model: string;
  provider: string;
  userId: string;
}

export interface MutationResult {
  botId: string;
  ok: boolean;
}

function mergeSettings(
  existing: Record<string, unknown> | null,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  return { ...(existing ?? {}), ...patch };
}

async function getBotModel(userId: string, serverDB?: any) {
  const db = serverDB ?? (await getServerDB());
  const gateKeeper = await KeyVaultsGateKeeper.initWithEnvKey();
  return new AgentBotProviderModel(db, userId, gateKeeper);
}

export async function setGreeting(
  userId: string,
  botId: string,
  greeting: string,
  serverDB?: any,
): Promise<MutationResult | null> {
  const model = await getBotModel(userId, serverDB);
  const bot = await model.findById(botId);
  if (!bot) {
    log('setGreeting: bot %s not owned by user %s', botId, userId);
    return null;
  }

  // Merge greeting into settings (don't overwrite other fields)
  const existing = (bot.settings ?? {}) as Record<string, unknown>;
  const merged = mergeSettings(existing, { greeting });
  await model.update(botId, { settings: merged });

  await getBotMessageRouter().invalidateBot(bot.platform, bot.applicationId);
  log('setGreeting: %s updated for bot %s:%s', greeting, bot.platform, bot.applicationId);

  return { botId, ok: true };
}

export async function setCommands(
  userId: string,
  botId: string,
  commands: Array<{ description: string; name: string; response: string }>,
  serverDB?: any,
): Promise<MutationResult | null> {
  const model = await getBotModel(userId, serverDB);
  const bot = await model.findById(botId);
  if (!bot) {
    log('setCommands: bot %s not owned by user %s', botId, userId);
    return null;
  }

  const existing = (bot.settings ?? {}) as Record<string, unknown>;
  const merged = mergeSettings(existing, { customCommands: commands });
  await model.update(botId, { settings: merged });

  await getBotMessageRouter().invalidateBot(bot.platform, bot.applicationId);
  log(
    'setCommands: %d commands for bot %s:%s',
    commands.length,
    bot.platform,
    bot.applicationId,
  );

  return { botId, ok: true };
}

export async function setAccessRule(
  userId: string,
  botId: string,
  dmPolicy: string | null | undefined,
  charLimit: number | null | undefined,
  serverDB?: any,
): Promise<MutationResult | null> {
  const model = await getBotModel(userId, serverDB);
  const bot = await model.findById(botId);
  if (!bot) {
    log('setAccessRule: bot %s not owned by user %s', botId, userId);
    return null;
  }

  const existing = (bot.settings ?? {}) as Record<string, unknown>;
  const existingDm = (existing.dm && typeof existing.dm === 'object'
    ? (existing.dm as Record<string, unknown>)
    : {}) as Record<string, unknown>;

  const patch: Record<string, unknown> = {
    dm: { ...existingDm, ...(dmPolicy !== undefined ? { policy: dmPolicy } : {}) },
  };
  if (charLimit !== undefined) {
    patch.charLimit = charLimit;
  }

  const merged = mergeSettings(existing, patch);
  await model.update(botId, { settings: merged });

  await getBotMessageRouter().invalidateBot(bot.platform, bot.applicationId);
  log(
    'setAccessRule: dm=%s, charLimit=%s for bot %s:%s',
    dmPolicy,
    charLimit,
    bot.platform,
    bot.applicationId,
  );

  return { botId, ok: true };
}

export async function setModel(
  userId: string,
  botId: string,
  modelName: string,
  provider: string,
  serverDB?: any,
): Promise<MutationResult | null> {
  const botModel = await getBotModel(userId, serverDB);
  const bot = await botModel.findById(botId);
  if (!bot) {
    log('setModel: bot %s not owned by user %s', botId, userId);
    return null;
  }

  if (!bot.agentId) {
    log('setModel: bot %s has no bound agent', botId);
    return { botId, ok: false };
  }

  const db = serverDB ?? (await getServerDB());
  const agentModel = new AgentModel(db, userId);
  await agentModel.update(bot.agentId, { model: modelName, provider });

  await getBotMessageRouter().invalidateBot(bot.platform, bot.applicationId);
  log(
    'setModel: %s/%s for bot %s:%s (agent=%s)',
    provider,
    modelName,
    bot.platform,
    bot.applicationId,
    bot.agentId,
  );

  return { botId, ok: true };
}
