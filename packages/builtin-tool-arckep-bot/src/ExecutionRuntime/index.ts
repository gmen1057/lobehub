import { type BuiltinServerRuntimeOutput } from '@lobechat/types';

import {
  type BotConfigResult,
  type BotSummary,
  type DisableBotParams,
  type EnableBotParams,
  type GetBotConfigParams,
  type SetAccessRuleParams,
  type SetCommandsParams,
  type SetGreetingParams,
  type SetModelParams,
} from '../types';

interface ArckepBotRuntimeDeps {
  getBotConfig: (botId: string) => Promise<BotConfigResult>;
  listMyBots: () => Promise<BotSummary[]>;
  setGreeting: (botId: string, greeting: string) => Promise<{ ok: boolean }>;
  setCommands: (botId: string, commands: Array<{ description: string; name: string; response: string }>) => Promise<{ ok: boolean }>;
  setAccessRule: (botId: string, dmPolicy?: string, charLimit?: number) => Promise<{ ok: boolean }>;
  setModel: (botId: string, model: string, provider: string) => Promise<{ ok: boolean }>;
  enableBot: (botId: string) => Promise<{ ok: boolean; status: string }>;
  disableBot: (botId: string) => Promise<{ ok: boolean; status: string }>;
}

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

  async setGreeting(args: SetGreetingParams): Promise<BuiltinServerRuntimeOutput> {
    try {
      await this.deps.setGreeting(args.bot_id, args.greeting);
      return { content: 'Приветствие обновлено.', success: true };
    } catch (error) {
      return {
        content: `Не удалось обновить приветствие: ${(error as Error).message}`,
        success: false,
      };
    }
  }

  async setCommands(args: SetCommandsParams): Promise<BuiltinServerRuntimeOutput> {
    try {
      await this.deps.setCommands(args.bot_id, args.commands);
      const names = args.commands.map((c) => `/${c.name}`).join(', ');
      return {
        content: `Команды обновлены: ${names || '(нет)'}. Меню обновится через несколько секунд.`,
        success: true,
      };
    } catch (error) {
      return {
        content: `Не удалось обновить команды: ${(error as Error).message}`,
        success: false,
      };
    }
  }

  async setAccessRule(args: SetAccessRuleParams): Promise<BuiltinServerRuntimeOutput> {
    try {
      await this.deps.setAccessRule(args.bot_id, args.dm_policy, args.char_limit);
      return { content: 'Правила доступа обновлены.', success: true };
    } catch (error) {
      return {
        content: `Не удалось обновить правила доступа: ${(error as Error).message}`,
        success: false,
      };
    }
  }

  async setModel(args: SetModelParams): Promise<BuiltinServerRuntimeOutput> {
    try {
      await this.deps.setModel(args.bot_id, args.model, args.provider);
      return {
        content: `Модель изменена на ${args.provider}/${args.model}. Изменения вступят в силу со следующего сообщения.`,
        success: true,
      };
    } catch (error) {
      return {
        content: `Не удалось изменить модель: ${(error as Error).message}`,
        success: false,
      };
    }
  }

  async enableBot(args: EnableBotParams): Promise<BuiltinServerRuntimeOutput> {
    try {
      await this.deps.enableBot(args.bot_id);
      return { content: 'Бот включён. Он начнёт отвечать в течение нескольких секунд.', success: true };
    } catch (error) {
      return {
        content: `Не удалось включить бота: ${(error as Error).message}`,
        success: false,
      };
    }
  }

  async disableBot(args: DisableBotParams): Promise<BuiltinServerRuntimeOutput> {
    try {
      await this.deps.disableBot(args.bot_id);
      return { content: 'Бот выключен. Он перестанет отвечать в течение нескольких секунд.', success: true };
    } catch (error) {
      return {
        content: `Не удалось выключить бота: ${(error as Error).message}`,
        success: false,
      };
    }
  }
}
