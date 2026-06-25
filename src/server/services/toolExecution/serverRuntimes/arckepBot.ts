import { ArckepBotIdentifier } from '@lobechat/builtin-tool-arckep-bot';
import { ArckepBotExecutionRuntime } from '@lobechat/builtin-tool-arckep-bot/executionRuntime';

import {
  getBotConfigForUser,
  listBotsForUser,
} from '@/server/services/bot/botConfigRead';
import {
  setAccessRule,
  setCommands,
  setGreeting,
  setModel,
} from '@/server/services/bot/botMutationService';
import { setBotEnabled } from '@/server/services/bot/botEnableService';

import { type ServerRuntimeRegistration } from './types';

export const arckepBotRuntime: ServerRuntimeRegistration = {
  factory: (context) => {
    if (!context.userId || !context.serverDB) {
      throw new Error('userId and serverDB are required for ArcKep Bot execution');
    }
    const { serverDB, userId } = context;

    return new ArckepBotExecutionRuntime({
      disableBot: async (botId: string) => {
        const r = await setBotEnabled(userId, botId, false);
        if (!r) throw new Error('Бот не найден');
        return { ok: true, status: r.enabled ? 'enabled' : 'disabled' };
      },
      enableBot: async (botId: string) => {
        const r = await setBotEnabled(userId, botId, true);
        if (!r) throw new Error('Бот не найден');
        return { ok: true, status: r.enabled ? 'enabled' : 'disabled' };
      },
      getBotConfig: async (botId: string) => {
        const config = await getBotConfigForUser(userId, botId, serverDB);
        if (!config) throw new Error('Бот не найден');
        return config;
      },
      listMyBots: () => listBotsForUser(userId, serverDB),
      setAccessRule: async (botId: string, dmPolicy?: string, charLimit?: number) => {
        const r = await setAccessRule(userId, botId, dmPolicy, charLimit, serverDB);
        if (!r) throw new Error('Бот не найден');
        return r;
      },
      setCommands: async (
        botId: string,
        commands: Array<{ description: string; name: string; response: string }>,
      ) => {
        const r = await setCommands(userId, botId, commands, serverDB);
        if (!r) throw new Error('Бот не найден');
        return r;
      },
      setGreeting: async (botId: string, greeting: string) => {
        const r = await setGreeting(userId, botId, greeting, serverDB);
        if (!r) throw new Error('Бот не найден');
        return r;
      },
      setModel: async (botId: string, model: string, provider: string) => {
        const r = await setModel(userId, botId, model, provider, serverDB);
        if (!r || !r.ok) throw new Error('Не удалось изменить модель');
        return r;
      },
    });
  },
  identifier: ArckepBotIdentifier,
};
