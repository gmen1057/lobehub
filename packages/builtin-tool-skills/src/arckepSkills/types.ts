/**
 * arckep (19.10.2026): инструмент «Мои навыки» — помощник сам сохраняет навык человека, без подтверждения.
 * Подключается по требованию через активатор (в постоянной части запроса его нет). Результат несёт строку
 * `ARCKEP_SKILL {json}`, по которой экран студии рисует карточку «Навык добавлен» с кнопкой «Удалить».
 */
export const ArckepSkillsIdentifier = 'arckep-skills';

export const ArckepSkillsApiName = {
  saveSkillFromFile: 'saveSkillFromFile',
  saveSkillFromText: 'saveSkillFromText',
  saveSkillFromUrl: 'saveSkillFromUrl',
} as const;

/** Метка перед JSON карточки в ответе инструмента (читает экран студии). */
export const ARCKEP_SKILL_MARKER = 'ARCKEP_SKILL';

export interface SaveSkillFromTextParams {
  content: string;
  description: string;
  /** Текстовые файлы-приложения: references/…, scripts/… */
  files?: Array<{ content: string; path: string }>;
  name: string;
  /** Заменить навык с таким же названием (только созданный из текста) */
  replace?: boolean;
}

export interface SaveSkillFromUrlParams {
  url: string;
}

export interface SaveSkillFromFileParams {
  fileId: string;
}

export interface SavedSkillCard {
  description: string;
  id: string;
  identifier: string;
  name: string;
  source: 'builtin' | 'market' | 'user';
}

export interface SaveSkillState {
  skill: SavedSkillCard;
  status: 'created' | 'unchanged' | 'updated';
}
