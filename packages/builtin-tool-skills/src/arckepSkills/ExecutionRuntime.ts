import type { BuiltinServerRuntimeOutput } from '@lobechat/types';

import {
  ARCKEP_SKILL_MARKER,
  type SavedSkillCard,
  type SaveSkillFromFileParams,
  type SaveSkillFromTextParams,
  type SaveSkillFromUrlParams,
  type SaveSkillState,
} from './types';

export interface ArckepSkillsService {
  importFromFile: (fileId: string) => Promise<SaveSkillState>;
  importFromUrl: (url: string) => Promise<SaveSkillState>;
  saveFromText: (
    input: Omit<SaveSkillFromTextParams, 'replace'>,
    options: { replace?: boolean },
  ) => Promise<SaveSkillState>;
}

const CARD_DESCRIPTION_LIMIT = 300;

/** Ответ модели: что сохранено и строка для карточки на экране. */
export const formatSavedSkill = (state: SaveSkillState): string => {
  const { skill, status } = state;
  const verb = {
    created: 'Skill saved',
    unchanged: 'Skill already up to date',
    updated: 'Skill updated',
  }[status];
  const card: SavedSkillCard = {
    ...skill,
    description: skill.description.slice(0, CARD_DESCRIPTION_LIMIT),
  };

  return [
    `${verb}: "${skill.name}".`,
    'The chat shows the person a "Skill added" card with a Delete button. Confirm in one short sentence; do not repeat the skill text.',
    `${ARCKEP_SKILL_MARKER} ${JSON.stringify({ ...card, status })}`,
  ].join('\n');
};

export class ArckepSkillsExecutionRuntime {
  constructor(private readonly service: ArckepSkillsService) {}

  async saveSkillFromText(args: SaveSkillFromTextParams): Promise<BuiltinServerRuntimeOutput> {
    const { replace, ...input } = args ?? ({} as SaveSkillFromTextParams);
    return this.run(() => this.service.saveFromText(input, { replace: replace === true }));
  }

  async saveSkillFromUrl(args: SaveSkillFromUrlParams): Promise<BuiltinServerRuntimeOutput> {
    if (!args?.url) return { content: 'A link is required.', success: false };
    return this.run(() => this.service.importFromUrl(args.url));
  }

  async saveSkillFromFile(args: SaveSkillFromFileParams): Promise<BuiltinServerRuntimeOutput> {
    if (!args?.fileId)
      return { content: 'The id of the attached file is required.', success: false };
    return this.run(() => this.service.importFromFile(args.fileId));
  }

  private async run(save: () => Promise<SaveSkillState>): Promise<BuiltinServerRuntimeOutput> {
    try {
      const state = await save();
      return { content: formatSavedSkill(state), state, success: true };
    } catch (error) {
      // Сообщения сервиса написаны по-русски и объясняют, что делать; модель пересказывает их человеку.
      return { content: `Skill not saved: ${(error as Error).message}`, success: false };
    }
  }
}
