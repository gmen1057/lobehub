import { describe, expect, it } from 'vitest';

import {
  builtinSkills,
  ContentArticlesIdentifier,
  SeoDemandIdentifier,
  YandexDirectGuideIdentifier,
} from './index';

/** Функции Wordstat в шлюзе коннекторов (/opt/mcp-connectors/gateway/wordstat.js). */
const WORDSTAT_TOOLS = [
  'get_wordstat',
  'get_wordstat_batch',
  'get_wordstat_dynamics',
  'get_wordstat_regions',
];

const seoSkills = [SeoDemandIdentifier, ContentArticlesIdentifier, YandexDirectGuideIdentifier].map(
  (identifier) => builtinSkills.find((skill) => skill.identifier === identifier)!,
);

describe('SEO-навыки (arckep, возвращены 19.10.2026)', () => {
  it('все три в списке встроенных навыков, имена не повторяются', () => {
    expect(seoSkills.every(Boolean)).toBe(true);
    expect(seoSkills.map((skill) => skill.name)).toEqual([
      'SEO Demand',
      'Content Articles',
      'Yandex Direct Guide',
    ]);

    const names = builtinSkills.map((skill) => skill.name);
    expect(new Set(names).size).toBe(names.length);
    const ids = builtinSkills.map((skill) => skill.identifier);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(seoSkills.map((skill) => [skill.name, skill] as const))(
    '%s: описание короткое и по-русски, источник builtin',
    (_, skill) => {
      expect(skill.source).toBe('builtin');
      expect(skill.description.length).toBeLessThanOrEqual(200);
      expect(skill.description).toMatch(/[А-Яа-я]/);
    },
  );

  it.each(seoSkills.map((skill) => [skill.name, skill] as const))(
    '%s: Wordstat подключается через activateTools по mcp-arckep-wordstat',
    (_, skill) => {
      expect(skill.content).toContain('mcp-arckep-wordstat');
      expect(skill.content).toContain('activateTools');
      expect(skill.content).toContain('<available_tools>');
    },
  );

  it.each(seoSkills.map((skill) => [skill.name, skill] as const))(
    '%s: в тексте только существующие функции Wordstat и нет устаревших имён',
    (_, skill) => {
      const used = new Set(skill.content.match(/get_wordstat\w*/g) ?? []);
      for (const name of used) expect(WORDSTAT_TOOLS).toContain(name);

      expect(skill.content).not.toMatch(/runSkill|lobe-skill-store|skill_store/);
      // «tool-результатов», «tool вернул» — прежняя калька; теперь «инструмент»
      expect(skill.content).not.toMatch(/\btools?\b/i);
    },
  );

  it('справочники на месте и совпадают с путями в тексте навыка', () => {
    const expected: Record<string, string> = {
      [SeoDemandIdentifier]: 'references/workflow',
      [ContentArticlesIdentifier]: 'references/article-brief',
      [YandexDirectGuideIdentifier]: 'references/structure',
    };

    for (const skill of seoSkills) {
      const path = expected[skill.identifier];
      const resource = skill.resources?.[path];
      expect(resource?.content, `${skill.name}: ${path}`).toBeTruthy();
      expect(resource!.size).toBe(new TextEncoder().encode(resource!.content!).length);
      expect(skill.content).toContain(path);
    }
  });

  it('Директ: нет доступа к кабинету и просьбы о токене', () => {
    const direct = seoSkills.find((skill) => skill.identifier === YandexDirectGuideIdentifier)!;
    expect(direct.content).toContain('без доступа к кабинету');
    expect(direct.content).toMatch(/Просить OAuth\/токен Директа/);
  });

  it('лимиты Wordstat в тексте совпадают с шлюзом (30/300/2000 и 12/60/150, batch до 8)', () => {
    const demand = seoSkills.find((skill) => skill.identifier === SeoDemandIdentifier)!;
    expect(demand.content).toContain('30/мин, 300/час, 2000/день');
    expect(demand.content).toContain('12/мин, 60/час, 150/день');
    expect(demand.content).toMatch(/максимум \*\*8\*\* фраз/);
  });
});
