import { type BuiltinToolManifest } from '@lobechat/types';

import { systemPrompt } from './systemRole';
import { ArckepLayoutApiName, ArckepLayoutIdentifier } from './types';

export const ArckepLayoutManifest: BuiltinToolManifest = {
  api: [
    {
      description:
        'Check the latest version of an HTML artifact against the attached PDF mockup (its <layout> block). Call once right after you built the HTML from a mockup (again only after you rewrote a page that the answer says still uses mail-breaking techniques). The engine renders the page, compares line positions, font sizes, pictures and overall look with the mockup, checks that the page does not rely on techniques mail clients drop (position:absolute/fixed, flex, grid, float, <script>, external styles), and fixes differences in its own short rounds outside this conversation (at most 3, the best version wins). Returns what was fixed, what still differs and a short <lobeArtifact … src="…"> tag: show the result with that tag and never re-print the HTML. Do not pass HTML.',
      name: ArckepLayoutApiName.checkLayout,
      parameters: {
        additionalProperties: false,
        properties: {
          file: {
            description:
              'Name of the PDF with the mockup, only if the topic has several. Default: the latest PDF of the topic that has a layout description.',
            type: 'string',
          },
          identifier: {
            description: 'identifier attribute of the text/html <lobeArtifact> to check',
            type: 'string',
          },
        },
        required: ['identifier'],
        type: 'object',
      },
    },
    {
      description:
        'Edit the latest version of an HTML artifact with small find/replace pieces instead of re-printing the page (the person asked: "make the button blue", "here are my image links"). Each find must occur in the HTML exactly once, otherwise that edit is not applied and the answer says why. Empty replace deletes the piece. Max 30 edits. Returns a short <lobeArtifact … src="…"> tag: show the result with it and never re-print the HTML. Do not pass HTML.',
      name: ArckepLayoutApiName.editArtifact,
      parameters: {
        additionalProperties: false,
        properties: {
          edits: {
            description: 'Ordered find/replace steps applied to the latest version',
            items: {
              additionalProperties: false,
              properties: {
                find: {
                  description: 'Exact piece of the current HTML that occurs exactly once',
                  type: 'string',
                },
                replace: {
                  description: 'What to put instead; empty string deletes the piece',
                  type: 'string',
                },
              },
              required: ['find', 'replace'],
              type: 'object',
            },
            maxItems: 30,
            minItems: 1,
            type: 'array',
          },
          identifier: {
            description: 'identifier attribute of the text/html <lobeArtifact> to edit',
            type: 'string',
          },
        },
        required: ['identifier', 'edits'],
        type: 'object',
      },
    },
  ],
  identifier: ArckepLayoutIdentifier,
  meta: {
    avatar: '📐',
    description:
      'Сверка HTML-письма или страницы с макетом PDF и правки артефакта кусками: движок сам исправляет расхождения короткими кругами и показывает лучшую версию тегом.',
    title: 'Сверка с макетом (ArcKep)',
  },
  systemRole: systemPrompt,
  type: 'builtin',
};
