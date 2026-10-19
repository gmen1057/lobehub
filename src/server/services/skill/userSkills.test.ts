// @vitest-environment node
import { builtinSkills } from '@lobechat/builtin-skills';
import { describe, expect, it, vi } from 'vitest';

import { SkillImportError, SkillManifestError, SkillParseError } from './errors';
import { SkillParser } from './parser';
import {
  MAX_ASSISTANT_SAVES_PER_HOUR,
  MAX_USER_SKILLS,
  UserSkillError,
  UserSkillService,
  type UserSkillServiceDeps,
} from './userSkills';

// arckep (19.10.2026): один сервис для инструмента помощника и REST «Мои навыки».

const NOW = new Date('2026-10-19T10:00:00Z');

const row = (overrides: Record<string, unknown> = {}) => ({
  content: 'Шаги навыка',
  createdAt: NOW,
  description: 'Делает отчёт',
  id: 'skill_1',
  identifier: 'user.abc',
  manifest: { description: 'Делает отчёт', name: 'Отчёт' },
  name: 'Отчёт',
  resources: {},
  source: 'user' as const,
  updatedAt: NOW,
  zipFileHash: null,
  ...overrides,
});

const make = (overrides: Partial<UserSkillServiceDeps> = {}) => {
  const skillModel = {
    create: vi.fn(async (data: any) => row({ ...data, id: 'skill_new' })),
    delete: vi.fn(async () => ({ success: true })),
    findAll: vi.fn(async () => ({ data: [], total: 0 })),
    findAllWithResources: vi.fn(async () => [] as any[]),
    findById: vi.fn(async (_id: string) => undefined as any),
    findByName: vi.fn(async (_name: string) => undefined as any),
    replace: vi.fn(async (_id: string, data: any) => row({ ...data })),
    update: vi.fn(async (_id: string, data: any) => row({ ...data })),
  };
  const importer = {
    importFromUrl: vi.fn(async () => ({
      skill: row({ id: 'skill_url', source: 'market' }),
      status: 'created' as const,
    })),
    importFromZip: vi.fn(async () => ({
      skill: row({ id: 'skill_zip' }),
      status: 'created' as const,
    })),
  };
  const fileModel = { findById: vi.fn(async () => undefined as any) };
  const fileService = { getFileContent: vi.fn(async () => '') };
  const resourceService = {
    storeResources: vi.fn(async (_hash: string, files: Map<string, Buffer>) =>
      Object.fromEntries(
        [...files].map(([path, buffer]) => [path, { fileHash: 'h', size: buffer.length }]),
      ),
    ),
  };
  const service = new UserSkillService({} as any, 'user_1', {
    fileModel,
    fileService,
    importer,
    parser: new SkillParser(),
    resourceService,
    skillModel,
    ...overrides,
  } as any);
  return { fileModel, fileService, importer, resourceService, service, skillModel };
};

const text = { content: 'Шаг 1. Сделай.', description: 'Делает отчёт', name: 'Отчёт' };

describe('createFromText', () => {
  it('создаёт навык человека с идентификатором user.*', async () => {
    const { service, skillModel } = make();
    const result = await service.createFromText(text);

    expect(result.status).toBe('created');
    expect(result.skill).toMatchObject({
      description: 'Делает отчёт',
      name: 'Отчёт',
      source: 'user',
    });
    const data = skillModel.create.mock.calls[0][0];
    expect(data.identifier).toMatch(/^user\.[\w-]{12}$/);
    expect(data.source).toBe('user');
    expect(data.manifest).toEqual({ description: 'Делает отчёт', name: 'Отчёт' });
    expect(data.resources).toEqual({});
  });

  it('шапку SKILL.md в content убирает, имя и описание берутся из параметров', async () => {
    const { service, skillModel } = make();
    await service.createFromText({
      ...text,
      content: '---\nname: другое\ndescription: другое описание\n---\n\n# Тело\nШаги',
    });
    expect(skillModel.create.mock.calls[0][0].content).toBe('# Тело\nШаги');
    expect(skillModel.create.mock.calls[0][0].name).toBe('Отчёт');
  });

  it('файлы-приложения кладутся в хранилище и попадают в resources', async () => {
    const { resourceService, service, skillModel } = make();
    await service.createFromText({
      ...text,
      files: [
        { content: 'print(1)', path: 'scripts/run.py' },
        { content: '# заметки', path: './references/notes.md' },
      ],
    });

    const [hash, map] = resourceService.storeResources.mock.calls[0] as unknown as [
      string,
      Map<string, Buffer>,
    ];
    expect(hash).toMatch(/^[\da-f]{64}$/);
    expect([...map.keys()]).toEqual(['references/notes.md', 'scripts/run.py']);
    expect(Object.keys(skillModel.create.mock.calls[0][0].resources)).toEqual([
      'references/notes.md',
      'scripts/run.py',
    ]);
  });

  describe('имя уже занято', () => {
    it('без replace — понятная ошибка CONFLICT с подсказкой', async () => {
      const { service, skillModel } = make();
      skillModel.findByName.mockResolvedValue(row());

      const error = await service.createFromText(text).catch((e) => e);

      expect(error).toBeInstanceOf(UserSkillError);
      expect(error.code).toBe('CONFLICT');
      expect(error.status).toBe(409);
      expect(error.message).toContain('уже есть');
      expect(error.message).toContain('replace=true');
      expect(skillModel.create).not.toHaveBeenCalled();
      expect(skillModel.replace).not.toHaveBeenCalled();
    });

    it('с replace — обновляет навык, созданный из текста, и сбрасывает старые файлы', async () => {
      const { service, skillModel } = make();
      skillModel.findByName.mockResolvedValue(
        row({ resources: { 'old.md': { fileHash: 'x', size: 1 } } }),
      );

      const result = await service.createFromText(
        { ...text, content: 'Новая версия' },
        { replace: true },
      );

      expect(result.status).toBe('updated');
      expect(skillModel.replace).toHaveBeenCalledWith(
        'skill_1',
        expect.objectContaining({ content: 'Новая версия', resources: {} }),
      );
      expect(skillModel.create).not.toHaveBeenCalled();
    });

    it('с replace навык, добавленный по ссылке, не заменяется', async () => {
      const { service, skillModel } = make();
      skillModel.findByName.mockResolvedValue(row({ source: 'market' }));

      const error = await service.createFromText(text, { replace: true }).catch((e) => e);

      expect(error.code).toBe('CONFLICT');
      expect(error.message).toContain('по ссылке');
      expect(skillModel.replace).not.toHaveBeenCalled();
    });
  });

  it('имя встроенного навыка занято (иначе активация брала бы встроенный)', async () => {
    const { service } = make();
    for (const name of ['Artifacts', 'seo demand', 'LobeHub']) {
      const error = await service.createFromText({ ...text, name }).catch((e) => e);
      expect(error.code, name).toBe('CONFLICT');
      expect(error.message).toContain('встроенным');
    }
  });

  it('предел числа навыков', async () => {
    const { service, skillModel } = make();
    skillModel.findAll.mockResolvedValue({ data: [], total: MAX_USER_SKILLS });
    const error = await service.createFromText(text).catch((e) => e);
    expect(error.code).toBe('LIMIT');
    expect(skillModel.create).not.toHaveBeenCalled();
  });

  it('гонка двух сохранений: нарушение уникальности — тоже CONFLICT', async () => {
    const { service, skillModel } = make();
    skillModel.create.mockRejectedValue(Object.assign(new Error('dup'), { code: '23505' }));
    const error = await service.createFromText(text).catch((e) => e);
    expect(error.code).toBe('CONFLICT');
  });

  describe('проверка входа', () => {
    it.each([
      ['пустое имя', { name: '  ' }],
      ['кавычка в имени', { name: 'Мой "навык"' }],
      ['скобка в имени', { name: 'a<b' }],
      ['перевод строки в имени', { name: 'a\nb' }],
      ['длинное имя', { name: 'я'.repeat(101) }],
      ['пустое описание', { description: '' }],
      ['длинное описание', { description: 'я'.repeat(1025) }],
      ['пустой текст', { content: ' ' }],
    ])('%s → INVALID', async (_, patch) => {
      const { service, skillModel } = make();
      const error = await service.createFromText({ ...text, ...patch }).catch((e) => e);
      expect(error).toBeInstanceOf(UserSkillError);
      expect(['INVALID', 'TOO_LARGE']).toContain(error.code);
      expect(skillModel.create).not.toHaveBeenCalled();
    });

    it('слишком длинный текст — TOO_LARGE', async () => {
      const { service } = make();
      const error = await service
        .createFromText({ ...text, content: 'я'.repeat(200_001) })
        .catch((e) => e);
      expect(error.code).toBe('TOO_LARGE');
    });

    it.each(['', '/etc/passwd', '../x.md', 'a/../../b', 'SKILL.md', 'a\u0000b'])(
      'небезопасный путь файла %j отклоняется',
      async (path) => {
        const { resourceService, service } = make();
        const error = await service
          .createFromText({ ...text, files: [{ content: 'x', path }] })
          .catch((e) => e);
        expect(error.code).toBe('INVALID');
        expect(resourceService.storeResources).not.toHaveBeenCalled();
      },
    );

    it('повтор пути, больше 20 файлов и слишком большие файлы', async () => {
      const { service } = make();
      const dup = await service
        .createFromText({
          ...text,
          files: [
            { content: 'a', path: 'a.md' },
            { content: 'b', path: './a.md' },
          ],
        })
        .catch((e) => e);
      expect(dup.code).toBe('INVALID');

      const many = await service
        .createFromText({
          ...text,
          files: Array.from({ length: 21 }, (_, i) => ({ content: 'x', path: `f${i}.md` })),
        })
        .catch((e) => e);
      expect(many.code).toBe('TOO_LARGE');

      const big = await service
        .createFromText({
          ...text,
          files: Array.from({ length: 6 }, (_, i) => ({
            content: 'x'.repeat(190_000),
            path: `f${i}.md`,
          })),
        })
        .catch((e) => e);
      expect(big.code).toBe('TOO_LARGE');
    });
  });
});

describe('importFromUrl', () => {
  it('https-ссылка уходит импортёру', async () => {
    const { importer, service } = make();
    const result = await service.importFromUrl(
      ' https://github.com/anthropics/skills/tree/main/skills/pdf ',
    );
    expect(importer.importFromUrl).toHaveBeenCalledWith({
      url: 'https://github.com/anthropics/skills/tree/main/skills/pdf',
    });
    expect(result).toMatchObject({
      skill: { id: 'skill_url', source: 'market' },
      status: 'created',
    });
  });

  it.each(['http://example.com/SKILL.md', 'ftp://x/y', 'не ссылка', 'file:///etc/passwd'])(
    '%j отклоняется до скачивания',
    async (url) => {
      const { importer, service } = make();
      const error = await service.importFromUrl(url).catch((e) => e);
      expect(error.code).toBe('INVALID');
      expect(importer.importFromUrl).not.toHaveBeenCalled();
    },
  );

  it('ошибки импортёра переводятся в понятные', async () => {
    const cases: Array<[Error, string, string]> = [
      [
        new SkillImportError('Skill with name "X" already exists', 'CONFLICT'),
        'CONFLICT',
        'Удалите старый',
      ],
      [
        new SkillImportError('Resource not found at https://x', 'NOT_FOUND'),
        'NOT_FOUND',
        'Не найдено',
      ],
      [new SkillImportError('boom', 'DOWNLOAD_FAILED'), 'DOWNLOAD_FAILED', 'Не удалось скачать'],
      [new SkillManifestError('Invalid skill manifest: name'), 'INVALID', 'name и description'],
      [new SkillParseError('SKILL.md not found in zip package'), 'INVALID', 'Не удалось разобрать'],
      [new Error('SSRF blocked: 127.0.0.1 is not allowed'), 'INVALID', 'публичный адрес https'],
    ];
    for (const [thrown, code, text] of cases) {
      const { importer, service } = make();
      importer.importFromUrl.mockRejectedValue(thrown);
      const error = await service.importFromUrl('https://example.com/x.zip').catch((e) => e);
      expect(error, thrown.message).toBeInstanceOf(UserSkillError);
      expect(error.code).toBe(code);
      expect(error.message).toContain(text);
    }
  });

  it('предел числа навыков проверяется до скачивания', async () => {
    const { importer, service, skillModel } = make();
    skillModel.findAll.mockResolvedValue({ data: [], total: MAX_USER_SKILLS });
    const error = await service.importFromUrl('https://example.com/SKILL.md').catch((e) => e);
    expect(error.code).toBe('LIMIT');
    expect(importer.importFromUrl).not.toHaveBeenCalled();
  });
});

describe('importFromFile', () => {
  it('чужого или выдуманного файла нет — NOT_FOUND', async () => {
    const { service } = make();
    const error = await service.importFromFile('file_x').catch((e) => e);
    expect(error.code).toBe('NOT_FOUND');
  });

  it('zip идёт импортёру архивов', async () => {
    const { fileModel, importer, service } = make();
    fileModel.findById.mockResolvedValue({
      fileType: 'application/zip',
      name: 'skill.zip',
      size: 1000,
      url: 'k',
    });
    const result = await service.importFromFile('file_1');
    expect(importer.importFromZip).toHaveBeenCalledWith({ zipFileId: 'file_1' });
    expect(result.skill.id).toBe('skill_zip');
  });

  it('SKILL.md с шапкой превращается в навык человека', async () => {
    const { fileModel, fileService, service, skillModel } = make();
    fileModel.findById.mockResolvedValue({
      fileType: 'text/markdown',
      name: 'SKILL.md',
      size: 100,
      url: 'files/k',
    });
    fileService.getFileContent.mockResolvedValue(
      '---\nname: Письмо клиенту\ndescription: Пишет вежливое письмо\n---\n\n# Письмо\nШаги',
    );

    const result = await service.importFromFile('file_2');

    expect(fileService.getFileContent).toHaveBeenCalledWith('files/k');
    expect(result.status).toBe('created');
    expect(skillModel.create.mock.calls[0][0]).toMatchObject({
      content: '# Письмо\nШаги',
      description: 'Пишет вежливое письмо',
      name: 'Письмо клиенту',
      source: 'user',
    });
  });

  it('текст без шапки — ошибка с подсказкой сохранить как текст', async () => {
    const { fileModel, fileService, service } = make();
    fileModel.findById.mockResolvedValue({
      fileType: 'text/markdown',
      name: 'notes.md',
      size: 10,
      url: 'k',
    });
    fileService.getFileContent.mockResolvedValue('Просто заметки без шапки');
    const error = await service.importFromFile('file_3').catch((e) => e);
    expect(error.code).toBe('INVALID');
    expect(error.message).toContain('сохраните его как текст');
  });

  it('другой тип файла и слишком большой файл отклоняются', async () => {
    const { fileModel, service } = make();
    fileModel.findById.mockResolvedValue({
      fileType: 'application/pdf',
      name: 'a.pdf',
      size: 10,
      url: 'k',
    });
    expect((await service.importFromFile('f').catch((e) => e)).message).toContain('zip-архив');

    fileModel.findById.mockResolvedValue({
      fileType: 'application/zip',
      name: 'a.zip',
      size: 11 * 1024 * 1024,
      url: 'k',
    });
    expect((await service.importFromFile('f').catch((e) => e)).code).toBe('TOO_LARGE');
  });
});

describe('list / get / remove', () => {
  it('в списке навыки человека и встроенные с source; LobeHub и Task в движке без интерфейса скрыты', async () => {
    vi.stubEnv('ARCKEP_HEADLESS_TOOLS', '1');
    try {
      const { service, skillModel } = make();
      skillModel.findAllWithResources.mockResolvedValue([
        row({ resources: { 'a.md': { fileHash: 'x', size: 3 } } }),
        row({
          id: 'skill_2',
          identifier: 'github.x',
          manifest: { sourceUrl: 'https://github.com/x/y', version: '1.2' },
          name: 'GitHub',
          source: 'market',
          zipFileHash: 'z',
        }),
        row({ id: 'skill_3', name: 'Без файлов' }),
      ]);

      const { skills, total } = await service.list();

      const sources = Object.fromEntries(skills.map((skill) => [skill.name, skill.source]));
      expect(sources).toMatchObject({
        'Artifacts': 'builtin',
        'GitHub': 'market',
        'Отчёт': 'user',
        'SEO Demand': 'builtin',
      });
      expect(sources).not.toHaveProperty('LobeHub');
      expect(sources).not.toHaveProperty('Task');
      expect(total).toBe(skills.length);

      const mine = skills.find((skill) => skill.name === 'Отчёт')!;
      expect(mine).toMatchObject({
        deletable: true,
        hasResources: true,
        id: 'skill_1',
        identifier: 'user.abc',
      });
      expect(mine.createdAt).toBe(NOW.toISOString());

      const github = skills.find((skill) => skill.name === 'GitHub')!;
      expect(github).toMatchObject({
        hasResources: true,
        sourceUrl: 'https://github.com/x/y',
        version: '1.2',
      });
      expect(skills.find((skill) => skill.name === 'Без файлов')!.hasResources).toBe(false);

      const seo = skills.find((skill) => skill.name === 'SEO Demand')!;
      expect(seo).toMatchObject({
        avatar: '📊',
        deletable: false,
        hasResources: true,
        id: 'seo-demand',
        source: 'builtin',
      });
      // значок-картинка (data:) не отдаётся
      expect(skills.find((skill) => skill.name === 'Artifacts')!.avatar).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('get: навык человека с текстом и файлами, встроенный по идентификатору, чужой — null', async () => {
    const { service, skillModel } = make();
    skillModel.findById.mockImplementation(async (id: string) =>
      id === 'skill_1'
        ? row({ resources: { 'scripts/run.py': { fileHash: 'x', size: 8 } } })
        : undefined,
    );

    const mine = await service.get('skill_1');
    expect(mine).toMatchObject({
      content: 'Шаги навыка',
      files: [{ path: 'scripts/run.py', size: 8 }],
      source: 'user',
    });

    const builtin = await service.get('seo-demand');
    expect(builtin).toMatchObject({ id: 'seo-demand', source: 'builtin' });
    expect(builtin!.files.map((file) => file.path)).toEqual(['references/workflow']);
    expect(builtin!.content).toContain('Wordstat');

    expect(await service.get('skill_other')).toBeNull();
  });

  it('remove: удаляет своё, встроенное запрещено, чужое — не найдено', async () => {
    const { service, skillModel } = make();
    skillModel.findById.mockImplementation(async (id: string) =>
      id === 'skill_1' ? row() : undefined,
    );

    expect(await service.remove('skill_1')).toEqual({ id: 'skill_1' });
    expect(skillModel.delete).toHaveBeenCalledWith('skill_1');

    const builtin = await service.remove('artifacts').catch((e) => e);
    const builtinReal = await service.remove(builtinSkills[1].identifier).catch((e) => e);
    expect(builtin.code).toBe('NOT_FOUND');
    expect(builtinReal.code).toBe('FORBIDDEN');

    const other = await service.remove('skill_other').catch((e) => e);
    expect(other.code).toBe('NOT_FOUND');
    expect(skillModel.delete).toHaveBeenCalledTimes(1);
  });
});

describe('кто сохранил: метка savedVia и предел для помощника (arckep, 19.10.2026)', () => {
  const recent = (n: number, savedVia: string, minutesAgo = 5) =>
    Array.from({ length: n }, (_, i) =>
      row({
        id: `skill_r${i}`,
        manifest: { description: 'd', name: `R${i}`, savedVia },
        name: `R${i}`,
        updatedAt: new Date(Date.now() - minutesAgo * 60_000),
      }),
    );

  it('текстовый навык несёт метку в шапке и показывает её в списке', async () => {
    const { service, skillModel } = make();
    await service.createFromText(text, { via: 'assistant' });
    expect(skillModel.create.mock.calls[0][0].manifest).toEqual({
      description: 'Делает отчёт',
      name: 'Отчёт',
      savedVia: 'assistant',
    });

    skillModel.findAllWithResources.mockResolvedValue([
      row({ manifest: { savedVia: 'assistant' } }),
      row({ id: 'skill_2', manifest: { savedVia: 'screen' }, name: 'B' }),
      row({ id: 'skill_3', manifest: {}, name: 'C' }),
    ]);
    const { skills } = await service.list();
    const byName = Object.fromEntries(skills.map((skill) => [skill.name, skill.savedVia]));
    expect(byName).toMatchObject({ B: 'screen', C: null, Отчёт: 'assistant' });
  });

  it('без via метки нет (старое поведение)', async () => {
    const { service, skillModel } = make();
    await service.createFromText(text);
    expect(skillModel.create.mock.calls[0][0].manifest).toEqual({
      description: 'Делает отчёт',
      name: 'Отчёт',
    });
  });

  it('помощник: больше 10 сохранений за час — LIMIT, у человека на экране предела нет', async () => {
    const { service, skillModel } = make();
    skillModel.findAll.mockResolvedValue({
      data: recent(MAX_ASSISTANT_SAVES_PER_HOUR, 'assistant'),
      total: MAX_ASSISTANT_SAVES_PER_HOUR,
    } as any);

    const error = await service.createFromText(text, { via: 'assistant' }).catch((e) => e);
    expect(error.code).toBe('LIMIT');
    expect(error.message).toContain('за последний час');
    expect(skillModel.create).not.toHaveBeenCalled();

    expect((await service.createFromText(text, { via: 'screen' })).status).toBe('created');
  });

  it('старые сохранения (больше часа назад) и чужие метки не считаются', async () => {
    const { service, skillModel } = make();
    skillModel.findAll.mockResolvedValue({
      data: [...recent(6, 'assistant', 120), ...recent(6, 'screen')],
      total: 12,
    } as any);
    expect((await service.createFromText(text, { via: 'assistant' })).status).toBe('created');
  });

  it('предел действует и на ссылки и файлы, замена тоже считается', async () => {
    const full = { data: recent(MAX_ASSISTANT_SAVES_PER_HOUR, 'assistant'), total: 10 } as any;

    const url = make();
    url.skillModel.findAll.mockResolvedValue(full);
    expect(
      (
        await url.service
          .importFromUrl('https://example.com/SKILL.md', { via: 'assistant' })
          .catch((e) => e)
      ).code,
    ).toBe('LIMIT');
    expect(url.importer.importFromUrl).not.toHaveBeenCalled();

    const replace = make();
    replace.skillModel.findAll.mockResolvedValue(full);
    replace.skillModel.findByName.mockResolvedValue(row());
    expect(
      (
        await replace.service
          .createFromText(text, { replace: true, via: 'assistant' })
          .catch((e) => e)
      ).code,
    ).toBe('LIMIT');
  });

  it('замена при заполненном общем пределе числа навыков работает (новых навыков она не добавляет)', async () => {
    const { service, skillModel } = make();
    skillModel.findAll.mockResolvedValue({ data: [], total: MAX_USER_SKILLS });
    skillModel.findByName.mockResolvedValue(row());
    expect((await service.createFromText(text, { replace: true })).status).toBe('updated');
  });

  it('импорт по ссылке с via ставит метку на созданный навык, неизменённый не трогает', async () => {
    const created = make();
    await created.service.importFromUrl('https://github.com/a/b', { via: 'assistant' });
    expect(created.skillModel.update).toHaveBeenCalledWith('skill_url', {
      manifest: { savedVia: 'assistant' },
    });

    const same = make();
    same.importer.importFromUrl.mockResolvedValue({
      skill: row({ id: 'skill_url' }),
      status: 'unchanged',
    } as any);
    await same.service.importFromUrl('https://github.com/a/b', { via: 'assistant' });
    expect(same.skillModel.update).not.toHaveBeenCalled();

    const noVia = make();
    await noVia.service.importFromUrl('https://github.com/a/b');
    expect(noVia.skillModel.update).not.toHaveBeenCalled();
  });

  it('SKILL.md из файла несёт via дальше в createFromText', async () => {
    const { fileModel, fileService, service, skillModel } = make();
    fileModel.findById.mockResolvedValue({
      fileType: 'text/markdown',
      name: 'SKILL.md',
      size: 10,
      url: 'k',
    });
    fileService.getFileContent.mockResolvedValue('---\nname: Из файла\ndescription: d\n---\nТекст');
    await service.importFromFile('file_9', { via: 'assistant' });
    expect(skillModel.create.mock.calls[0][0].manifest).toMatchObject({ savedVia: 'assistant' });
  });
});
