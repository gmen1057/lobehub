import type { BuiltinToolManifest } from '@lobechat/types';

import { systemPrompt } from './systemRole';
import { ArckepSkillsApiName, ArckepSkillsIdentifier } from './types';

export const ArckepSkillsManifest: BuiltinToolManifest = {
  api: [
    {
      description:
        'Save a skill the person asked for, from text. Returns a card of the saved skill. If the name is taken it returns an error (use replace=true only when the person asked to change that skill).',
      name: ArckepSkillsApiName.saveSkillFromText,
      parameters: {
        properties: {
          content: {
            description:
              'The body of SKILL.md in Markdown, without a header: goal, step-by-step procedure, formats, rules.',
            type: 'string',
          },
          description: {
            description:
              'What the skill does and when to use it, one or two sentences (about 200 characters).',
            type: 'string',
          },
          files: {
            description:
              'Optional text files stored with the skill, e.g. references/notes.md or scripts/run.py. Up to 20 files.',
            items: {
              properties: {
                content: { description: 'The text of the file.', type: 'string' },
                path: {
                  description: 'Relative path inside the skill, e.g. "references/notes.md".',
                  type: 'string',
                },
              },
              required: ['path', 'content'],
              type: 'object',
            },
            type: 'array',
          },
          name: {
            description: 'A short human name of the skill, in the language of the person.',
            type: 'string',
          },
          replace: {
            description:
              'Replace the existing skill with the same name. Only for skills created from text, and only when the person asked to change that skill.',
            type: 'boolean',
          },
        },
        required: ['name', 'description', 'content'],
        type: 'object',
      },
    },
    {
      description:
        'Save a skill from a link: a SKILL.md, a GitHub repository or folder with SKILL.md, or a .zip. Only public https links. Returns a card of the saved skill.',
      name: ArckepSkillsApiName.saveSkillFromUrl,
      parameters: {
        properties: {
          url: { description: 'A public https link.', type: 'string' },
        },
        required: ['url'],
        type: 'object',
      },
    },
    {
      description:
        'Save a skill from a file the person attached to the chat: a .zip with SKILL.md or a SKILL.md file. Pass the id of the file from the <files> block. Returns a card of the saved skill.',
      name: ArckepSkillsApiName.saveSkillFromFile,
      parameters: {
        properties: {
          fileId: {
            description: 'The id of the attached file, as in <file id="...">.',
            type: 'string',
          },
        },
        required: ['fileId'],
        type: 'object',
      },
    },
  ],
  identifier: ArckepSkillsIdentifier,
  meta: {
    avatar: '🧩',
    description:
      'Сохранить навык в «Мои навыки»: из текста, ссылки (SKILL.md, GitHub, zip) или файла из чата. Только по просьбе человека.',
    title: 'Мои навыки',
  },
  systemRole: systemPrompt,
  type: 'builtin',
};
