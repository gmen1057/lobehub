export { buildResourcesTreeText, resourcesTreePrompt } from './resourcesTree';

export interface SkillItem {
  description: string;
  identifier: string;
  location?: string;
  name: string;
}

/**
 * arckep (19.10.2026): список навыков идёт в каждый запрос, а описания импортированных навыков бывают
 * по 700+ знаков (у живых навыков студии среднее — 651). В списке нужно лишь понять, когда навык
 * подходит; полный текст модель получает по `activateSkill`.
 */
export const SKILL_LIST_DESCRIPTION_LIMIT = 200;

/**
 * Описание для списка: пробелы и переводы строк схлопываются, длинный текст режется по границе слова
 * примерно на `limit` знаках и заканчивается многоточием.
 */
export const truncateSkillDescription = (
  description: string,
  limit: number = SKILL_LIST_DESCRIPTION_LIMIT,
): string => {
  const flat = description.replaceAll(/\s+/g, ' ').trim();
  if (flat.length <= limit) return flat;

  let head = flat.slice(0, limit);
  // Слово не обрезано, если сразу за пределом стоит пробел; иначе откатываемся к последнему пробелу
  // (но не дальше половины лимита: длинная строка без пробелов режется как есть).
  if (flat[limit] !== ' ') {
    const lastSpace = head.lastIndexOf(' ');
    if (lastSpace >= limit / 2) head = head.slice(0, lastSpace);
  }
  // Не оставляем половину суррогатной пары (эмодзи) на границе.
  const lastCode = head.charCodeAt(head.length - 1);
  if (lastCode >= 0xd8_00 && lastCode <= 0xdb_ff) head = head.slice(0, -1);

  return `${head.replace(/[\s,.:;!?—–-]+$/, '')}…`;
};

export const skillPrompt = (skill: SkillItem) => {
  const description = truncateSkillDescription(skill.description);

  return skill.location
    ? `  <skill name="${skill.name}" location="${skill.location}">${description}</skill>`
    : `  <skill name="${skill.name}">${description}</skill>`;
};

export const skillsPrompts = (skills: SkillItem[]) => {
  if (skills.length === 0) return '';

  const skillTags = skills.map((skill) => skillPrompt(skill)).join('\n');

  // arckep (19.10.2026): подвал ссылался на несуществующий `runSkill`; навык включает `activateSkill`
  // активатора (lobe-activator).
  return `<available_skills>
${skillTags}
</available_skills>

Call the \`activateSkill\` tool (lobe-activator) with a skill's exact name to load its instructions when the task matches it.`;
};
