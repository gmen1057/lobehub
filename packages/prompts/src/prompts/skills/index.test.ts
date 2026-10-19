import { describe, expect, it } from 'vitest';

import {
  SKILL_LIST_DESCRIPTION_LIMIT,
  type SkillItem,
  skillPrompt,
  skillsPrompts,
  truncateSkillDescription,
} from './index';

describe('skillPrompt', () => {
  it('should generate skill tag with location', () => {
    const skill: SkillItem = {
      description: 'Extracts text and tables from PDF files',
      identifier: 'pdf-processing',
      location: '/path/to/skills/pdf-processing/SKILL.md',
      name: 'PDF Processing',
    };

    expect(skillPrompt(skill)).toBe(
      '  <skill name="PDF Processing" location="/path/to/skills/pdf-processing/SKILL.md">Extracts text and tables from PDF files</skill>',
    );
  });

  it('should generate skill tag without location', () => {
    const skill: SkillItem = {
      description: 'Custom skill description',
      identifier: 'my-skill',
      name: 'My Skill',
    };

    expect(skillPrompt(skill)).toBe('  <skill name="My Skill">Custom skill description</skill>');
  });
});

describe('skillsPrompts', () => {
  it('should generate available_skills block with multiple skills', () => {
    const skills: SkillItem[] = [
      {
        description: 'Extracts text and tables from PDF files',
        identifier: 'pdf-processing',
        location: '/path/to/skills/pdf-processing/SKILL.md',
        name: 'PDF Processing',
      },
      {
        description: 'Analyzes datasets and generates charts',
        identifier: 'data-analysis',
        location: '/path/to/skills/data-analysis/SKILL.md',
        name: 'Data Analysis',
      },
    ];

    const expected = `<available_skills>
  <skill name="PDF Processing" location="/path/to/skills/pdf-processing/SKILL.md">Extracts text and tables from PDF files</skill>
  <skill name="Data Analysis" location="/path/to/skills/data-analysis/SKILL.md">Analyzes datasets and generates charts</skill>
</available_skills>

Call the \`activateSkill\` tool (lobe-activator) with a skill's exact name to load its instructions when the task matches it.`;

    expect(skillsPrompts(skills)).toBe(expected);
  });

  it('should generate mixed skills with and without location', () => {
    const skills: SkillItem[] = [
      {
        description: 'Generate interactive UI components',
        identifier: 'artifacts',
        location: '/path/to/skills/artifacts/SKILL.md',
        name: 'Artifacts',
      },
      {
        description: 'Custom skill description',
        identifier: 'my-skill',
        name: 'My Skill',
      },
    ];

    const expected = `<available_skills>
  <skill name="Artifacts" location="/path/to/skills/artifacts/SKILL.md">Generate interactive UI components</skill>
  <skill name="My Skill">Custom skill description</skill>
</available_skills>

Call the \`activateSkill\` tool (lobe-activator) with a skill's exact name to load its instructions when the task matches it.`;

    expect(skillsPrompts(skills)).toBe(expected);
  });

  it('should return empty string for empty skills array', () => {
    expect(skillsPrompts([])).toBe('');
  });
});

describe('truncateSkillDescription (arckep: описание в списке навыков)', () => {
  it('короткое описание не меняет', () => {
    expect(truncateSkillDescription('Спрос и семантика через Wordstat')).toBe(
      'Спрос и семантика через Wordstat',
    );
  });

  it('схлопывает переводы строк и лишние пробелы', () => {
    expect(truncateSkillDescription('Первая строка\n\n  вторая   строка\t')).toBe(
      'Первая строка вторая строка',
    );
  });

  it('режет по границе слова, не длиннее лимита + многоточие', () => {
    const long = Array.from({ length: 80 }, (_, i) => `слово${i}`).join(' ');
    const cut = truncateSkillDescription(long);

    expect(cut.endsWith('…')).toBe(true);
    expect(cut.length).toBeLessThanOrEqual(SKILL_LIST_DESCRIPTION_LIMIT + 1);
    expect(cut.length).toBeGreaterThan(SKILL_LIST_DESCRIPTION_LIMIT / 2);
    // последнее слово целое: оно есть в исходнике как отдельное слово
    const lastWord = cut.slice(0, -1).split(' ').at(-1)!;
    expect(long.split(' ')).toContain(lastWord);
  });

  it('слово ровно на границе лимита остаётся целым', () => {
    const limit = 20;
    const text = `${'a'.repeat(limit - 5)} word and more words`;
    // 'word' заканчивается ровно на 20-м знаке, дальше пробел
    expect(truncateSkillDescription(text, limit)).toBe(`${'a'.repeat(limit - 5)} word…`);
  });

  it('строка без пробелов режется как есть', () => {
    const cut = truncateSkillDescription('x'.repeat(500));
    expect(cut).toBe(`${'x'.repeat(SKILL_LIST_DESCRIPTION_LIMIT)}…`);
  });

  it('не оставляет половину эмодзи на границе', () => {
    const text = `${'a'.repeat(SKILL_LIST_DESCRIPTION_LIMIT - 1)}😀${'b'.repeat(50)}`;
    const cut = truncateSkillDescription(text);
    expect(cut).toBe(`${'a'.repeat(SKILL_LIST_DESCRIPTION_LIMIT - 1)}…`);
  });

  it('убирает висящую пунктуацию перед многоточием', () => {
    const text = `${'a'.repeat(SKILL_LIST_DESCRIPTION_LIMIT - 2)}, и ещё много текста дальше`;
    expect(truncateSkillDescription(text)).toBe(`${'a'.repeat(SKILL_LIST_DESCRIPTION_LIMIT - 2)}…`);
  });

  it('skillPrompt и skillsPrompts режут длинные описания', () => {
    const description = Array.from({ length: 60 }, () => 'длинное').join(' ');
    const line = skillPrompt({ description, identifier: 'x', name: 'Длинный' });

    expect(line.startsWith('  <skill name="Длинный">')).toBe(true);
    expect(line.endsWith('…</skill>')).toBe(true);
    expect(line.length).toBeLessThan(description.length);
    expect(skillsPrompts([{ description, identifier: 'x', name: 'Длинный' }])).toContain(
      'activateSkill',
    );
  });
});
