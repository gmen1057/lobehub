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
    {
      description:
        "Set the bot's welcome greeting message (shown to new users). The greeting is plain text; the bot sends it as the first message when a new user starts a conversation.",
      name: ArckepBotApiName.setGreeting,
      parameters: {
        additionalProperties: false,
        properties: {
          bot_id: { description: 'Bot id from listMyBots', type: 'string' },
          greeting: { description: 'New greeting text (empty to clear)', type: 'string' },
        },
        required: ['bot_id', 'greeting'],
        type: 'object',
      },
    },
    {
      description:
        "Set custom slash-commands for the bot (name, description, canned response). These appear in the Telegram / menu. Built-in /new and /stop are always present. The model NEVER includes /new or /stop in this list.",
      name: ArckepBotApiName.setCommands,
      parameters: {
        additionalProperties: false,
        properties: {
          bot_id: { description: 'Bot id from listMyBots', type: 'string' },
          commands: {
            description: 'Array of {name, description, response} objects',
            items: {
              additionalProperties: false,
              properties: {
                description: { description: 'Short description shown in the menu', type: 'string' },
                name: { description: 'Command name without the slash (e.g. "price")', type: 'string' },
                response: { description: 'Canned text the bot replies with when the command is used', type: 'string' },
              },
              required: ['name', 'description', 'response'],
              type: 'object',
            },
            type: 'array',
          },
        },
        required: ['bot_id', 'commands'],
        type: 'object',
      },
    },
    {
      description:
        "Set the bot's access mode (dm.policy) and character limit. dm.policy: 'open' (anyone), 'allowlist' (selected users), 'disabled' (no one). charLimit: max message length the bot accepts (null = no limit).",
      name: ArckepBotApiName.setAccessRule,
      parameters: {
        additionalProperties: false,
        properties: {
          bot_id: { description: 'Bot id from listMyBots', type: 'string' },
          dm_policy: { description: "'open', 'allowlist', or 'disabled'", type: 'string' },
          char_limit: { description: 'Max message length, null for unlimited', type: 'number' },
        },
        required: ['bot_id'],
        type: 'object',
      },
    },
    {
      description:
        "Change the AI model the bot uses. model is a model name string (e.g. 'claude-sonnet-4-20250514'); provider is the provider id (e.g. 'anthropic', 'openai', 'google'). The bot must have a bound agent — editing model changes that agent's configuration.",
      name: ArckepBotApiName.setModel,
      parameters: {
        additionalProperties: false,
        properties: {
          bot_id: { description: 'Bot id from listMyBots', type: 'string' },
          model: { description: 'Model name string', type: 'string' },
          provider: { description: 'Provider id (anthropic, openai, google, etc.)', type: 'string' },
        },
        required: ['bot_id', 'model', 'provider'],
        type: 'object',
      },
    },
    {
      description:
        "Enable a disabled bot — it starts accepting messages again. Takes effect within seconds.",
      name: ArckepBotApiName.enableBot,
      parameters: {
        additionalProperties: false,
        properties: {
          bot_id: { description: 'Bot id from listMyBots', type: 'string' },
        },
        required: ['bot_id'],
        type: 'object',
      },
    },
    {
      description:
        "Disable an enabled bot — it stops accepting messages. Takes effect within seconds.",
      name: ArckepBotApiName.disableBot,
      parameters: {
        additionalProperties: false,
        properties: {
          bot_id: { description: 'Bot id from listMyBots', type: 'string' },
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
