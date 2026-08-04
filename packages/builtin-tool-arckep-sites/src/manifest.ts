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
        'Read the current published HTML of one site by its id (from listSites). Use it as the base for edits — never rewrite a site from memory. For SMALL text changes prefer editSite after reading exact strings.',
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
        'Surgical edit of a published site: exact find/replace on the CURRENT live HTML, then publish a new version immediately (no full-page artifact). Use for small changes — phone, CTA label, form action URL, typo, one section string. Each find must match the live HTML exactly (call readSite first). If a string appears more than once, pass a longer unique find OR set replace_all=true. Do NOT use this for full redesigns / new layout — those still need a full HTML artifact. Max 20 replacements per call.',
      name: ArckepSitesApiName.editSite,
      parameters: {
        additionalProperties: false,
        properties: {
          replacements: {
            description:
              'Ordered list of find/replace steps applied to the live HTML. find must be an exact substring from readSite.',
            items: {
              additionalProperties: false,
              properties: {
                find: {
                  description: 'Exact substring to find in the published HTML',
                  type: 'string',
                },
                replace: {
                  description: 'Replacement text (may be empty to delete)',
                  type: 'string',
                },
                replace_all: {
                  default: false,
                  description:
                    'If true, replace every occurrence. If false (default), find must match exactly once.',
                  type: 'boolean',
                },
              },
              required: ['find', 'replace'],
              type: 'object',
            },
            maxItems: 20,
            minItems: 1,
            type: 'array',
          },
          site_id: {
            description: 'Site id from listSites',
            type: 'number',
          },
        },
        required: ['site_id', 'replacements'],
        type: 'object',
      },
    },
    {
      description:
        'Generate a real image via ArcKep (Nano Banana 2 / Pro) and return a permanent URL. USE THIS whenever the user asks to draw, generate, create, or edit an image in chat — avatars, product shots, covers, illustrations, social posts — NOT only for landing pages. Do NOT switch the chat model to Nano Banana / gemini-*-image; call this tool instead (fixed per-image price, no full chat history billed). For landing HTML, insert the URL into <img src> or CSS. Prefer quality="standard" (Banana 2); quality="high" (Banana Pro) only when the user asks for premium fidelity or hero/main product. Charges RUB; always tell the user the cost from the tool result.',
      name: ArckepSitesApiName.generateImage,
      parameters: {
        additionalProperties: false,
        properties: {
          aspect_ratio: {
            default: 'landscape',
            description:
              'Image aspect ratio. landscape (default, 16:9) for hero/banner; portrait (9:16) for mobile/stories/profile; square (1:1) for avatars/logos/icons.',
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
              'standard (default) — faster, cheaper (Nano Banana 2); high — premium fidelity (Nano Banana Pro), only when user asks premium or for hero/product.',
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
        "Get a design brief (art direction) BEFORE building a NEW landing page: palette, fonts, layout structure, imagery direction, style-specific bans. Free, no charge. Pass business — a short description of what the site is for («кофейня», «репетитор по математике») — for a better style match. Pass style_id ONLY when the user already picked a style (from the /sites picker or from the alternatives you offered). The server guarantees the style differs from the user's recent sites. Do NOT call it for edits of an existing site.",
      name: ArckepSitesApiName.getDesignBrief,
      parameters: {
        additionalProperties: false,
        properties: {
          business: {
            description:
              "Short description of the user's business/purpose in Russian, e.g. «кофейня у дома», «портфолио фотографа».",
            type: 'string',
          },
          style_id: {
            description:
              'Exact style id the user picked (e.g. "brutalist", "dark-luxe"). Omit to let the server choose.',
            type: 'string',
          },
        },
        type: 'object',
      },
    },
    {
      description:
        'Show the full catalog of design styles as an interactive gallery in the chat. Call when the user asks what styles exist («какие стили есть?», «покажи стили») or wants to browse before choosing. The gallery renders itself with color swatches and pick buttons — keep your own text to ONE short sentence inviting the user to pick; do NOT re-list the styles in text. No parameters.',
      name: ArckepSitesApiName.listStyles,
      parameters: {
        additionalProperties: false,
        properties: {},
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
