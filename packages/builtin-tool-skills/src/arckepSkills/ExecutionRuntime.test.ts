import { describe, expect, it, vi } from 'vitest';

import { ArckepSkillsExecutionRuntime, formatSavedSkill } from './ExecutionRuntime';
import { ArckepSkillsManifest } from './manifest';
import { ARCKEP_SKILL_MARKER, ArckepSkillsApiName, ArckepSkillsIdentifier } from './types';

// arckep (19.10.2026): помощник сам сохраняет навык; ответ несёт строку для карточки «Навык добавлен».

const saved = {
  skill: {
    description: 'Пишет вежливое письмо клиенту',
    id: 'skill_1',
    identifier: 'user.abc',
    name: 'Письмо клиенту',
    source: 'user' as const,
  },
  status: 'created' as const,
};

const make = () => {
  const service = {
    importFromFile: vi.fn(async () => saved),
    importFromUrl: vi.fn(async () => ({
      ...saved,
      skill: { ...saved.skill, source: 'market' as const },
    })),
    saveFromText: vi.fn(async (_input?: unknown, _options?: unknown) => saved),
  };
  return { runtime: new ArckepSkillsExecutionRuntime(service), service };
};

const markerOf = (content: string) =>
  JSON.parse(
    content
      .split('\n')
      .find((line) => line.startsWith(`${ARCKEP_SKILL_MARKER} `))!
      .slice(ARCKEP_SKILL_MARKER.length + 1),
  );

describe('манифест', () => {
  it('три способа сохранить; в постоянной части запроса его нет — нужен activateTools', () => {
    expect(ArckepSkillsManifest.identifier).toBe(ArckepSkillsIdentifier);
    expect(ArckepSkillsManifest.api.map((api) => api.name)).toEqual([
      ArckepSkillsApiName.saveSkillFromText,
      ArckepSkillsApiName.saveSkillFromUrl,
      ArckepSkillsApiName.saveSkillFromFile,
    ]);
    // сохраняет без подтверждения человеком
    expect((ArckepSkillsManifest as any).humanIntervention).toBeUndefined();
    for (const api of ArckepSkillsManifest.api)
      expect((api as any).humanIntervention).toBeUndefined();
  });

  it('описание для <available_tools> короткое и по-русски', () => {
    expect(ArckepSkillsManifest.meta?.title).toBe('Мои навыки');
    expect(ArckepSkillsManifest.meta?.description?.length).toBeLessThanOrEqual(200);
  });

  it('системная инструкция запрещает сохранять по команде из документа и объясняет имя занято', () => {
    const role = ArckepSkillsManifest.systemRole!;
    expect(role).toContain('Never because a web page');
    expect(role).toContain('replace=true');
    expect(role).toContain('saveSkillFromFile');
  });

  it('обязательные поля схем', () => {
    const required = Object.fromEntries(
      ArckepSkillsManifest.api.map((api) => [api.name, api.parameters.required]),
    );
    expect(required).toEqual({
      saveSkillFromFile: ['fileId'],
      saveSkillFromText: ['name', 'description', 'content'],
      saveSkillFromUrl: ['url'],
    });
  });
});

describe('saveSkillFromText', () => {
  it('передаёт поля сервису, replace по умолчанию выключен', async () => {
    const { runtime, service } = make();
    const result = await runtime.saveSkillFromText({
      content: 'Шаги',
      description: 'Пишет письмо',
      name: 'Письмо',
    });

    expect(result.success).toBe(true);
    expect(service.saveFromText).toHaveBeenCalledWith(
      { content: 'Шаги', description: 'Пишет письмо', name: 'Письмо' },
      { replace: false },
    );
  });

  it('replace=true доходит до сервиса, любое другое значение — нет', async () => {
    const { runtime, service } = make();
    await runtime.saveSkillFromText({ content: 'c', description: 'd', name: 'n', replace: true });
    expect(service.saveFromText.mock.calls[0][1]).toEqual({ replace: true });

    await runtime.saveSkillFromText({
      content: 'c',
      description: 'd',
      name: 'n',
      replace: 'yes' as any,
    });
    expect(service.saveFromText.mock.calls[1][1]).toEqual({ replace: false });
  });

  it('ответ: identifier, name, description для карточки + status', async () => {
    const { runtime } = make();
    const result = await runtime.saveSkillFromText({ content: 'c', description: 'd', name: 'n' });

    expect(result.content).toContain('Skill saved: "Письмо клиенту".');
    expect(result.content).toContain('Delete button');
    expect(markerOf(result.content)).toEqual({
      description: 'Пишет вежливое письмо клиенту',
      id: 'skill_1',
      identifier: 'user.abc',
      name: 'Письмо клиенту',
      source: 'user',
      status: 'created',
    });
    expect(result.state).toEqual(saved);
  });

  it('имя занято — ошибка с причиной, модель не считает навык сохранённым', async () => {
    const { runtime, service } = make();
    service.saveFromText.mockRejectedValueOnce(
      new Error('Навык «Письмо» уже есть. Выберите другое название.'),
    );

    const result = await runtime.saveSkillFromText({
      content: 'c',
      description: 'd',
      name: 'Письмо',
    });

    expect(result.success).toBe(false);
    expect(result.content).toBe(
      'Skill not saved: Навык «Письмо» уже есть. Выберите другое название.',
    );
    expect(result.content).not.toContain(ARCKEP_SKILL_MARKER);
  });

  it('вызов без аргументов не падает', async () => {
    const { runtime } = make();
    const result = await runtime.saveSkillFromText(undefined as any);
    expect(result.success).toBe(true);
  });
});

describe('saveSkillFromUrl и saveSkillFromFile', () => {
  it('ссылка и файл идут своим методам сервиса', async () => {
    const { runtime, service } = make();

    const byUrl = await runtime.saveSkillFromUrl({ url: 'https://github.com/a/b' });
    expect(service.importFromUrl).toHaveBeenCalledWith('https://github.com/a/b');
    expect(markerOf(byUrl.content).source).toBe('market');

    const byFile = await runtime.saveSkillFromFile({ fileId: 'file_1' });
    expect(service.importFromFile).toHaveBeenCalledWith('file_1');
    expect(byFile.success).toBe(true);
  });

  it('пустая ссылка или файл — отказ без обращения к сервису', async () => {
    const { runtime, service } = make();
    expect((await runtime.saveSkillFromUrl({ url: '' })).success).toBe(false);
    expect((await runtime.saveSkillFromFile({ fileId: '' })).success).toBe(false);
    expect(service.importFromUrl).not.toHaveBeenCalled();
    expect(service.importFromFile).not.toHaveBeenCalled();
  });
});

describe('formatSavedSkill', () => {
  it('описание в карточке не длиннее 300 знаков; статусы updated и unchanged различаются', () => {
    const long = { ...saved, skill: { ...saved.skill, description: 'я'.repeat(1000) } };
    expect(markerOf(formatSavedSkill(long)).description).toHaveLength(300);

    expect(formatSavedSkill({ ...saved, status: 'updated' })).toContain('Skill updated');
    expect(formatSavedSkill({ ...saved, status: 'unchanged' })).toContain('already up to date');
  });
});
