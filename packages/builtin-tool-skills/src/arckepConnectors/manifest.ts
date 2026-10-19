import type { BuiltinToolManifest } from '@lobechat/types';

import { systemPrompt } from './systemRole';
import { ArckepConnectorsApiName, ArckepConnectorsIdentifier } from './types';

export const ArckepConnectorsManifest: BuiltinToolManifest = {
  api: [
    {
      description:
        'Search the catalog of connections (services and MCP servers) for one the person needs, and show them a "Connect ..." card. The PERSON connects it by pressing the button and enters keys themselves: you cannot connect anything and must never ask for keys, tokens or passwords in the chat. Returns up to 5 matches as text, each followed by an ARCKEP_CONNECT line that the chat turns into a card.',
      name: ArckepConnectorsApiName.searchConnectors,
      parameters: {
        properties: {
          query: {
            description:
              'What the person needs: a service name or a short task, e.g. "github", "notion", "база postgres", "поиск по сайтам".',
            type: 'string',
          },
        },
        required: ['query'],
        type: 'object',
      },
    },
  ],
  identifier: ArckepConnectorsIdentifier,
  meta: {
    avatar: '🔌',
    description:
      'Найти подключение (сервис или MCP-сервер) и показать карточку «Подключить …». Подключает человек кнопкой, ключи в чате не нужны.',
    title: 'Подключения',
  },
  systemRole: systemPrompt,
  type: 'builtin',
};
