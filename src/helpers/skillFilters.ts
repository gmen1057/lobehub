import {
  AgentBrowserIdentifier,
  LobeHubIdentifier,
  TaskIdentifier,
} from '@lobechat/builtin-skills';
import { isDesktop } from '@lobechat/const';
import { type BuiltinSkill } from '@lobechat/types';

export interface BuiltinSkillFilterContext {
  isDesktop: boolean;
  /** Движок без интерфейса (ARCKEP_HEADLESS_TOOLS=1); по умолчанию берётся из окружения. */
  isHeadless?: boolean;
}

const DESKTOP_ONLY_BUILTIN_SKILLS = new Set([AgentBrowserIdentifier]);

/**
 * arckep (19.10.2026): LobeHub и Task — про командную строку LobeHub (`lh ...`), нашим людям бесполезны, а в
 * списке навыков каждого запроса занимают место и уводят модель в несуществующую CLI. Апстримный код
 * навыков не удаляется: в движке без интерфейса они просто фильтруются. Artifacts остаётся — его рисует
 * экран студии.
 */
const HEADLESS_HIDDEN_BUILTIN_SKILLS = new Set([LobeHubIdentifier, TaskIdentifier]);

/** Тот же признак, что `isArckepHeadlessTools()` сервера; здесь без серверных импортов — файл общий с клиентом. */
export const isHeadlessSkillMode = (): boolean =>
  typeof process !== 'undefined' && process.env?.ARCKEP_HEADLESS_TOOLS === '1';

const DEFAULT_CONTEXT: BuiltinSkillFilterContext = {
  isDesktop,
};

const resolveBuiltinSkillFilterContext = (
  context: BuiltinSkillFilterContext = DEFAULT_CONTEXT,
): Required<BuiltinSkillFilterContext> => ({
  isDesktop: context.isDesktop ?? DEFAULT_CONTEXT.isDesktop,
  isHeadless: context.isHeadless ?? isHeadlessSkillMode(),
});

export const shouldEnableBuiltinSkill = (
  skillId: string,
  context: BuiltinSkillFilterContext = DEFAULT_CONTEXT,
): boolean => {
  const resolvedContext = resolveBuiltinSkillFilterContext(context);

  if (resolvedContext.isHeadless && HEADLESS_HIDDEN_BUILTIN_SKILLS.has(skillId)) return false;

  if (DESKTOP_ONLY_BUILTIN_SKILLS.has(skillId)) {
    if (!resolvedContext.isDesktop) return false;
    return true;
  }

  return true;
};

export const filterBuiltinSkills = (
  skills: BuiltinSkill[],
  context: BuiltinSkillFilterContext = DEFAULT_CONTEXT,
): BuiltinSkill[] => {
  return skills.filter((skill) => shouldEnableBuiltinSkill(skill.identifier, context));
};

/**
 * arckep (21.10.2026): в движке без интерфейса магазин навыков LobeHub отключён, поэтому
 * ранее установленные из него навыки (`source = 'market'`, например pdf/docx/pptx) не
 * показываем в `<available_skills>`, чтобы модель не тратила на них шаги и песочницу.
 */
export const filterUserSkills = <T extends { source?: string | null }>(
  skills: T[],
  context: BuiltinSkillFilterContext = DEFAULT_CONTEXT,
): T[] => {
  const resolvedContext = resolveBuiltinSkillFilterContext(context);
  if (!resolvedContext.isHeadless) return skills;
  return skills.filter((skill) => skill.source !== 'market');
};
