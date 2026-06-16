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
    {
      description:
        'Generate a real image for use in a landing page and return its permanent URL. Use for every photo slot a landing needs (hero, product shots, team, backgrounds). Insert the returned URL directly into <img src="..."> or CSS background-image. Charges the user in RUB — prefer quality="standard" for supporting images, quality="high" for hero/product where fidelity matters.',
      name: ArckepSitesApiName.generateImage,
      parameters: {
        additionalProperties: false,
        properties: {
          aspect_ratio: {
            default: 'landscape',
            description:
              'Image aspect ratio. landscape (default, 16:9) for hero/banner; portrait (9:16) for mobile/profile; square (1:1) for avatars/logos/icons.',
            enum: ['landscape', 'portrait', 'square'],
            type: 'string',
          },
          prompt: {
            description:
              'Vivid, detailed image description in English. Include subject, style, lighting, mood. Example: "modern SPA reception desk with soft lighting, minimalist interior, photorealistic".',
            type: 'string',
          },
          quality: {
            default: 'standard',
            description:
              'standard (default) — faster, cheaper (Nano Banana 2); high — premium fidelity (Nano Banana Pro), use only for hero/product images.',
            enum: ['high', 'standard'],
            type: 'string',
          },
        },
        required: ['prompt'],
        type: 'object',
      },
    },
    {
      description:
        "When the site you built includes a contact/lead form, offer the user Telegram notifications for new submissions. Returns a connect link the user taps to receive leads in Telegram. If already connected, tell the user they're all set. No parameters.",
      name: ArckepSitesApiName.connectTelegram,
      parameters: {
        additionalProperties: false,
        properties: {},
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
