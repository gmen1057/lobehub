// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { arckepSkillsRuntime } from '../arckepSkills';

const { service } = vi.hoisted(() => ({
  service: {
    createFromText: vi.fn(),
    importFromFile: vi.fn(),
    importFromUrl: vi.fn(),
  },
}));

vi.mock('@/server/services/skill/userSkills', () => ({
  UserSkillService: class {
    constructor() {
      return service as any;
    }
  },
}));

// arckep (19.10.2026): всё, что сохраняет помощник, идёт с меткой via: 'assistant' (шапка навыка и предел за час).

const saved = {
  skill: { description: 'd', id: 'skill_1', identifier: 'user.a', name: 'N', source: 'user' },
  status: 'created',
};

const runtime = () =>
  arckepSkillsRuntime.factory({ serverDB: {} as any, userId: 'user_1' } as any) as any;

beforeEach(() => {
  vi.clearAllMocks();
  service.createFromText.mockResolvedValue(saved);
  service.importFromUrl.mockResolvedValue(saved);
  service.importFromFile.mockResolvedValue(saved);
});

describe('runtime arckep-skills на сервере', () => {
  it('нужны база и человек', () => {
    expect(() => arckepSkillsRuntime.factory({ userId: 'u' } as any)).toThrow('serverDB');
    expect(() => arckepSkillsRuntime.factory({ serverDB: {} } as any)).toThrow('userId');
  });

  it('текст: via assistant и replace доходят до сервиса, ответ с карточкой', async () => {
    const result = await runtime().saveSkillFromText({
      content: 'c',
      description: 'd',
      name: 'N',
      replace: true,
    });

    expect(service.createFromText).toHaveBeenCalledWith(
      { content: 'c', description: 'd', name: 'N' },
      { replace: true, via: 'assistant' },
    );
    expect(result.success).toBe(true);
    expect(result.content).toContain(
      'ARCKEP_SKILL {"description":"d","id":"skill_1","identifier":"user.a"',
    );
  });

  it('ссылка и файл — тоже via assistant', async () => {
    await runtime().saveSkillFromUrl({ url: 'https://github.com/a/b' });
    expect(service.importFromUrl).toHaveBeenCalledWith('https://github.com/a/b', {
      via: 'assistant',
    });

    await runtime().saveSkillFromFile({ fileId: 'file_1' });
    expect(service.importFromFile).toHaveBeenCalledWith('file_1', { via: 'assistant' });
  });

  it('ошибка сервиса (предел за час, имя занято) уходит модели текстом', async () => {
    service.createFromText.mockRejectedValue(
      new Error('Помощник уже сохранил 10 навыков за последний час'),
    );
    const result = await runtime().saveSkillFromText({ content: 'c', description: 'd', name: 'N' });
    expect(result.success).toBe(false);
    expect(result.content).toContain('Skill not saved: Помощник уже сохранил 10 навыков');
  });
});
