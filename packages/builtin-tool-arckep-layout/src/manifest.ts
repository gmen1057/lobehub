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
    {
      description:
        'Create and verify a complete HTML artifact before showing it to the person. Validates document structure and syntax-checks every inline <script> block (reporting exact 1-based line and column diagnostics if invalid), saves the verified HTML to a chat file, and returns a short <lobeArtifact … src="…"> tag. Show the result with that tag and never re-print the HTML.',
      name: ArckepLayoutApiName.writeArtifact,
      parameters: {
        additionalProperties: false,
        properties: {
          content: {
            description:
              'Complete HTML document source (without outer <lobeArtifact> wrapper tags)',
            type: 'string',
          },
          identifier: {
            description: 'Consistent kebab-case identifier attribute of the text/html artifact',
            type: 'string',
          },
          title: {
            description: 'Concise title of the HTML artifact',
            type: 'string',
          },
        },
        required: ['identifier', 'title', 'content'],
        type: 'object',
      },
    },
    {
      description:
        'Render the latest version of an HTML artifact in headless Chromium (sandboxed, no internet) to inspect real layout geometry, horizontal overflow, loaded/broken images, optional text line positions, and (for vision-capable models only) a scaled preview screenshot. Use ONLY for complex visual HTML artifacts (landing pages, slide decks, dashboards, infographics, styled emails without a PDF mockup) — never for plain code snippets, simple text, or trivial pages. Call at most 1–2 times per turn (hard cap 3/turn; never polish in an endless loop). Never withhold or hide the artifact from the user if rendering is unavailable or after finishing inspection. Do not pass HTML.',
      name: ArckepLayoutApiName.renderArtifact,
      parameters: {
        additionalProperties: false,
        properties: {
          identifier: {
            description:
              'identifier attribute of the text/html <lobeArtifact> to render and inspect',
            type: 'string',
          },
          lines: {
            description:
              'Optional prefixes of key text lines (up to 50, each cut to 60 chars) to check visibility and exact x/y/font metrics on the rendered page',
            items: {
              type: 'string',
            },
            maxItems: 50,
            type: 'array',
          },
          width: {
            description:
              'Viewport width in CSS px (320–1600; default 1280 for desktop/slides, 600 for HTML emails, 390 for mobile)',
            maximum: 1600,
            minimum: 320,
            type: 'number',
          },
        },
        required: ['identifier'],
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
