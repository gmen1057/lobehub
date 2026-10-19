// @vitest-environment node
import type { LobeChatDatabase } from '@lobechat/database';
import { agentSkills, users } from '@lobechat/database/schemas';
import { getTestDB } from '@lobechat/database/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MAX_ASSISTANT_SAVES_PER_HOUR, UserSkillService } from './userSkills';

// arckep (19.10.2026): сервис «Мои навыки» на настоящей базе: уникальность имени, замена, файлы, удаление,
// изоляция людей. Хранилище файлов подменено, как в importer.test.ts.
vi.mock('@/server/services/file/impls', () => ({
  createFileServiceModule: vi.fn().mockImplementation(() => ({
    createPreSignedUrl: vi.fn().mockResolvedValue('mock-presigned-url'),
    createPreSignedUrlForPreview: vi.fn().mockResolvedValue('mock-preview-url'),
    deleteFile: vi.fn().mockResolvedValue(undefined),
    deleteFiles: vi.fn().mockResolvedValue(undefined),
    getFileByteArray: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3, 4])),
    getFileContent: vi.fn().mockResolvedValue('mock-content'),
    getFileMetadata: vi.fn().mockResolvedValue({ contentLength: 100 }),
    getFullFileUrl: vi.fn().mockResolvedValue('mock-full-url'),
    getKeyFromFullUrl: vi.fn().mockResolvedValue(null),
    uploadBuffer: vi.fn().mockResolvedValue({ key: 'mock-key' }),
    uploadContent: vi.fn().mockResolvedValue(undefined),
    uploadMedia: vi.fn().mockResolvedValue({ key: 'mock-key' }),
  })),
}));

describe('UserSkillService на базе', () => {
  let db: LobeChatDatabase;
  let userId: string;
  let otherUserId: string;
  let service: UserSkillService;

  beforeEach(async () => {
    db = await getTestDB();
    userId = `skills-user-${Date.now()}`;
    otherUserId = `${userId}-other`;
    await db.insert(users).values([{ id: userId }, { id: otherUserId }]);
    service = new UserSkillService(db, userId);
  });

  afterEach(async () => {
    // база теста своя у каждого файла; люди удаляются вместе с навыками (каскад)
    await db.delete(users);
  });

  const text = { content: '# Шаги\n1. Сделай', description: 'Делает отчёт', name: 'Отчёт' };

  it('создание → список → карточка → удаление', async () => {
    const created = await service.createFromText(text);
    expect(created.status).toBe('created');
    expect(created.skill).toMatchObject({ name: 'Отчёт', source: 'user' });
    expect(created.skill.identifier).toMatch(/^user\./);

    const { skills } = await service.list();
    const mine = skills.find((skill) => skill.id === created.skill.id)!;
    expect(mine).toMatchObject({ deletable: true, hasResources: false, source: 'user' });
    // встроенные тоже в списке
    expect(skills.some((skill) => skill.source === 'builtin')).toBe(true);

    const detail = await service.get(created.skill.id);
    expect(detail).toMatchObject({ content: '# Шаги\n1. Сделай', description: 'Делает отчёт' });

    await expect(service.remove(created.skill.id)).resolves.toEqual({ id: created.skill.id });
    expect(await service.get(created.skill.id)).toBeNull();
  });

  it('имя занято: без replace — CONFLICT, с replace — обновление, старые файлы сброшены', async () => {
    const first = await service.createFromText({
      ...text,
      files: [{ content: 'print(1)', path: 'scripts/old.py' }],
    });
    expect((await service.get(first.skill.id))!.files.map((file) => file.path)).toEqual([
      'scripts/old.py',
    ]);

    await expect(service.createFromText(text)).rejects.toMatchObject({ code: 'CONFLICT' });

    const second = await service.createFromText(
      { ...text, content: 'Новая версия', files: [{ content: '# n', path: 'references/new.md' }] },
      { replace: true },
    );
    expect(second.status).toBe('updated');
    expect(second.skill.id).toBe(first.skill.id);

    const detail = (await service.get(first.skill.id))!;
    expect(detail.content).toBe('Новая версия');
    expect(detail.files.map((file) => file.path)).toEqual(['references/new.md']);
  });

  it('навык импортированный по ссылке заменить текстом нельзя', async () => {
    await db.insert(agentSkills).values({
      content: 'x',
      description: 'd',
      identifier: 'github.a.b',
      manifest: { description: 'd', name: 'Из GitHub' },
      name: 'Из GitHub',
      source: 'market',
      userId,
    });

    await expect(
      service.createFromText({ ...text, name: 'Из GitHub' }, { replace: true }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('люди друг друга не видят: список, карточка и удаление — только свои', async () => {
    const mine = await service.createFromText(text);
    const other = new UserSkillService(db, otherUserId);

    expect((await other.list()).skills.some((skill) => skill.id === mine.skill.id)).toBe(false);
    expect(await other.get(mine.skill.id)).toBeNull();
    await expect(other.remove(mine.skill.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await service.get(mine.skill.id)).not.toBeNull();

    // то же имя у другого человека — отдельный навык
    const theirs = await other.createFromText(text);
    expect(theirs.status).toBe('created');
    expect(theirs.skill.id).not.toBe(mine.skill.id);
  });

  it('метка «кто сохранил» и предел для помощника на настоящей базе', async () => {
    const byAssistant = await service.createFromText(text, { via: 'assistant' });
    const detail = (await service.get(byAssistant.skill.id))!;
    expect(detail.savedVia).toBe('assistant');

    const byScreen = await service.createFromText({ ...text, name: 'С экрана' }, { via: 'screen' });
    expect((await service.get(byScreen.skill.id))!.savedVia).toBe('screen');

    // одиннадцатый за час отклоняется, человек на экране может дальше
    for (let i = 0; i < MAX_ASSISTANT_SAVES_PER_HOUR - 1; i++) {
      await service.createFromText({ ...text, name: `Помощник ${i}` }, { via: 'assistant' });
    }
    await expect(
      service.createFromText({ ...text, name: 'Лишний' }, { via: 'assistant' }),
    ).rejects.toMatchObject({ code: 'LIMIT' });
    await expect(
      service.createFromText({ ...text, name: 'Лишний' }, { via: 'screen' }),
    ).resolves.toMatchObject({ status: 'created' });
  });

  it('два одинаковых сохранения подряд: второе — понятный CONFLICT, а не ошибка базы', async () => {
    const results = await Promise.allSettled([
      service.createFromText({ ...text, name: 'Гонка' }),
      service.createFromText({ ...text, name: 'Гонка' }),
    ]);
    const failed = results.filter(
      (result) => result.status === 'rejected',
    ) as PromiseRejectedResult[];
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0].reason).toMatchObject({ code: 'CONFLICT' });
  });
});
