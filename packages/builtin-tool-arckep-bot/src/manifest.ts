import { type BuiltinToolManifest } from '@lobechat/types';

import { systemPrompt } from './systemRole';
import { ArckepBotApiName, ArckepBotIdentifier } from './types';

export const ArckepBotManifest: BuiltinToolManifest = {
  api: [
    {
      description:
        "List the current user's connected Telegram bots (bot_id, telegram application id, agent, status, live state). Call this FIRST whenever the user asks about «мой бот / этого бота / бота X» — every later action takes a bot_id from this list, never an invented one.",
      name: ArckepBotApiName.listMyBots,
      parameters: {
        additionalProperties: false,
        properties: {},
        type: 'object',
      },
    },
    {
      description:
        "Read one bot's current configuration (status on/off, greeting, access mode, message limit, custom commands) by its bot_id from listMyBots. Use it before describing or editing a bot — never reconstruct settings from memory.",
      name: ArckepBotApiName.getBotConfig,
      parameters: {
        additionalProperties: false,
        properties: {
          bot_id: {
            description: 'Bot id from listMyBots (never invented or guessed)',
            type: 'string',
          },
        },
        required: ['bot_id'],
        type: 'object',
      },
    },
  ],
  identifier: ArckepBotIdentifier,
  meta: {
    avatar: '🤖',
    title: 'Мои боты (ArcKep)',
  },
  systemRole: systemPrompt,
  type: 'builtin',
};
