import { type BuiltinToolManifest } from '@lobechat/types';

import { systemPrompt } from './systemRole';
import { ArckepSitesApiName, ArckepSitesIdentifier } from './types';

export const ArckepSitesManifest: BuiltinToolManifest = {
  api: [
    {
      description:
        "List the current user's published sites on ArcKep (id, address, title, status, current version). Call this first when the user asks to edit «мой сайт».",
      name: ArckepSitesApiName.listSites,
      parameters: {
        additionalProperties: false,
        properties: {},
        type: 'object',
      },
    },
    {
      description:
        'Read the current published HTML of one site by its id (from listSites). Use it as the base for edits — never rewrite a site from memory.',
      name: ArckepSitesApiName.readSite,
      parameters: {
        additionalProperties: false,
        properties: {
          site_id: {
            description: 'Site id from listSites',
            type: 'number',
          },
        },
        required: ['site_id'],
        type: 'object',
      },
    },
  ],
  identifier: ArckepSitesIdentifier,
  meta: {
    avatar: '🌐',
    title: 'Мои сайты (ArcKep)',
  },
  systemRole: systemPrompt,
  type: 'builtin',
};
