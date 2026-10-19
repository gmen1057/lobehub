import { ArckepSkillsIdentifier } from '@lobechat/builtin-tool-skills';
import {
  ArckepSkillsExecutionRuntime,
  type ArckepSkillsService,
} from '@lobechat/builtin-tool-skills/arckepSkillsRuntime';

import { type SkillSaveResult, UserSkillService } from '@/server/services/skill/userSkills';

import { type ServerRuntimeRegistration } from './types';

const toState = (result: SkillSaveResult) => ({ skill: result.skill, status: result.status });

/**
 * «Мои навыки» (arckep, 19.10.2026): помощник сам сохраняет навык человека — из текста, ссылки или файла в
 * чате. Тот же сервис, что у REST `/api/v1/skills`; подтверждений нет (карточка «Навык добавлен» с кнопкой
 * «Удалить» — на экране студии).
 */
export const arckepSkillsRuntime: ServerRuntimeRegistration = {
  factory: (context) => {
    if (!context.serverDB) throw new Error('serverDB is required for skill saving');
    if (!context.userId) throw new Error('userId is required for skill saving');

    const skills = new UserSkillService(context.serverDB, context.userId);
    const service: ArckepSkillsService = {
      // via: 'assistant' — метка в шапке навыка и предел «за час»: сохраняет помощник без подтверждения
      importFromFile: async (fileId) =>
        toState(await skills.importFromFile(fileId, { via: 'assistant' })),
      importFromUrl: async (url) => toState(await skills.importFromUrl(url, { via: 'assistant' })),
      saveFromText: async (input, options) =>
        toState(await skills.createFromText(input, { ...options, via: 'assistant' })),
    };

    return new ArckepSkillsExecutionRuntime(service);
  },
  identifier: ArckepSkillsIdentifier,
};
