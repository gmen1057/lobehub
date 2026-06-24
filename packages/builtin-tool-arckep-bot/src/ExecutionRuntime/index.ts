import { type BuiltinServerRuntimeOutput } from '@lobechat/types';

import { type BotConfigResult, type BotSummary, type GetBotConfigParams } from '../types';

interface ArckepBotRuntimeDeps {
  getBotConfig: (botId: string) => Promise<BotConfigResult>;
  listMyBots: () => Promise<BotSummary[]>;
}

/**
 * ArcKep Bot configurator Execution Runtime (shared by client + server paths).
 *
 * Data access is injected by the executors (browser executor for 1-on-1 chat,
 * server runtime for group/background), which resolve the LobeChat user → arckep
 * user_id and read the bots from the canonical agent_bot_providers home (D1) via
 * the image-studio backend. Formatting lives here so both paths give the model
 * identical tool output.
 */
export class ArckepBotExecutionRuntime {
  private deps: ArckepBotRuntimeDeps;

  constructor(deps: ArckepBotRuntimeDeps) {
    this.deps = deps;
  }

  async listMyBots(): Promise<BuiltinServerRuntimeOutput> {
    try {
      const bots = await this.deps.listMyBots();
      const content =
        bots.length === 0
          ? 'У пользователя пока нет подключённых Telegram-ботов. Предложите подключить бота к агенту — после этого им можно будет управлять отсюда.'
          : JSON.stringify({ bots }, null, 2);
      return { content, state: { bots }, success: true };
    } catch (error) {
      return {
        content: `Не удалось получить список ботов: ${(error as Error).message}`,
        success: false,
      };
    }
  }

  async getBotConfig(args: GetBotConfigParams): Promise<BuiltinServerRuntimeOutput> {
    try {
      const config = await this.deps.getBotConfig(args.bot_id);
      return {
        content:
          `Текущая конфигурация бота ${config.application_id} (bot_id=${config.bot_id}):\n\n` +
          JSON.stringify(config, null, 2),
        state: { bot_id: config.bot_id },
        success: true,
      };
    } catch (error) {
      return {
        content: `Не удалось прочитать конфигурацию бота: ${(error as Error).message}`,
        success: false,
      };
    }
  }
}
