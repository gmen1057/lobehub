import { ArckepBotIdentifier } from '@lobechat/builtin-tool-arckep-bot';
import { ArckepBotExecutionRuntime } from '@lobechat/builtin-tool-arckep-bot/executionRuntime';

import { getBotConfigForUser, listBotsForUser } from '@/server/services/bot/botConfigRead';

import { type ServerRuntimeRegistration } from './types';

/**
 * ArcKep Bot configurator — server runtime (group chats / background agents).
 *
 * The user is `context.userId` (the LobeChat user id); the bots are read
 * directly from `agent_bot_providers` scoped to that user. The 1-on-1 browser
 * path uses the client executor (`executors/arckep-bot.ts`).
 */
export const arckepBotRuntime: ServerRuntimeRegistration = {
  factory: (context) => {
    if (!context.userId || !context.serverDB) {
      throw new Error('userId and serverDB are required for ArcKep Bot execution');
    }
    const { serverDB, userId } = context;

    return new ArckepBotExecutionRuntime({
      getBotConfig: async (botId: string) => {
        const config = await getBotConfigForUser(userId, botId, serverDB);
        if (!config) throw new Error('Бот не найден');
        return config;
      },
      listMyBots: () => listBotsForUser(userId, serverDB),
    });
  },
  identifier: ArckepBotIdentifier,
};
