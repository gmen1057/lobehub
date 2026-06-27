import { DEFAULT_PROVIDER } from '@lobechat/business-const';
import { DEFAULT_MODEL } from '@lobechat/const';

import type { BuiltinAgentDefinition } from '../../types';
import { BUILTIN_AGENT_SLUGS } from '../../types';
import { systemRoleTemplate } from './systemRole';

/**
 * Bot Configurator — builtin agent for managing Telegram bots.
 * Uses the arckep-bot tool plugin for bot configuration commands.
 */
export const BOT_CONFIGURATOR: BuiltinAgentDefinition = {
  avatar: '/avatars/robot.png',
  // Persist config — stored in database
  persist: {
    model: DEFAULT_MODEL,
    provider: DEFAULT_PROVIDER,
  },

  // Runtime function — generates dynamic config
  runtime: (ctx) => {
    const botContext = ctx.botId
      ? `\n\n=== КОНТЕКСТ ТЕКУЩЕГО БОТА ===\nСейчас мы работаем с ботом id: ${ctx.botId}. Сразу покажи его текущие настройки через listMyBots и другие инструменты.`
      : '';

    return {
      plugins: ['arckep-bot', ...(ctx.plugins || [])],
      systemRole: systemRoleTemplate + botContext,
    };
  },

  slug: BUILTIN_AGENT_SLUGS.botConfigurator,
};
