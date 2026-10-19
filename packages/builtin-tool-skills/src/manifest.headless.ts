import type { BuiltinToolManifest } from '@lobechat/types';

import { manifestMeta } from './manifest.base';
import { systemPromptHeadless } from './systemRole.headless';
import { SkillsApiName, SkillsIdentifier } from './types';

/**
 * Сколько стоит минута песочницы для человека — в описаниях инструментов, чтобы модель не жгла её впустую.
 * Цена считается по E2B × курс 110 ₽/$ (ТЗ chat-skills-tools, этап 1); меняется здесь и в одном месте.
 */
export const SKILLS_SANDBOX_PRICE_NOTE =
  'about 0.2 RUB per minute of sandbox time, paid by the person';

/**
 * arckep (19.10.2026): манифест инструментов навыков для движка без интерфейса. Отличия от апстримного:
 * без `humanIntervention` (подтверждать некому: команды идут в изолированную платную песочницу человека),
 * описания про песочницу и деньги, `execScript` принимает имя навыка (в серверном пути нет
 * stepContext.activatedSkills, по которому клиент находит активированные навыки).
 */
export const SkillsManifestHeadless: BuiltinToolManifest = {
  api: [
    {
      description:
        'Read a reference file bundled with an activated skill. Use it for files listed under "Available Resources" in the skill\'s instructions. Free.',
      name: SkillsApiName.readReference,
      parameters: {
        properties: {
          id: {
            description: 'The skill name, exactly as in activateSkill.',
            type: 'string',
          },
          path: {
            description: 'The path of the reference file, exactly as listed in the skill.',
            type: 'string',
          },
        },
        required: ['id', 'path'],
        type: 'object',
      },
    },
    {
      description: `Run a shell command in the person's isolated cloud sandbox (${SKILLS_SANDBOX_PRICE_NOTE}). Files persist between calls of this chat. A command is stopped after about 55 seconds. Returns stdout, stderr and the exit code. Default shell is /bin/sh, not bash.`,
      name: SkillsApiName.runCommand,
      parameters: {
        properties: {
          command: {
            description:
              'The shell command to run. Use `bash -c "..."` for bash-specific features.',
            type: 'string',
          },
          description: {
            description: 'What this command does, 5-10 words, in the language of the person.',
            type: 'string',
          },
        },
        required: ['command'],
        type: 'object',
      },
    },
    {
      description: `Run a command that needs the files bundled with a skill (scripts, templates, assets). The skill's files are copied to ~/skills/<skill>/ in the person's sandbox (${SKILLS_SANDBOX_PRICE_NOTE}) and the command runs from that folder. Returns stdout, stderr and the exit code.`,
      name: SkillsApiName.execScript,
      parameters: {
        properties: {
          command: {
            description:
              'The shell command to run from the skill folder, e.g. `python scripts/build.py`. Default shell is /bin/sh.',
            type: 'string',
          },
          description: {
            description: 'What this command does, 5-10 words, in the language of the person.',
            type: 'string',
          },
          skill: {
            description: 'The name of the activated skill whose files the command needs.',
            type: 'string',
          },
        },
        required: ['skill', 'command', 'description'],
        type: 'object',
      },
    },
    {
      description:
        'Save a file made in the sandbox so the person can download it. Returns the file id; the chat shows the person a file card by itself, so do not paste links or paths. Maximum file size is 25 MB.',
      name: SkillsApiName.exportFile,
      parameters: {
        properties: {
          filename: {
            description: 'The name the person will see, e.g. "report.pdf".',
            type: 'string',
          },
          path: {
            description:
              'The path of the file in the sandbox, e.g. "output/report.pdf" (relative to the sandbox home) or an absolute path.',
            type: 'string',
          },
        },
        required: ['path', 'filename'],
        type: 'object',
      },
    },
  ],
  identifier: SkillsIdentifier,
  meta: manifestMeta,
  systemRole: systemPromptHeadless,
  type: 'builtin',
};
