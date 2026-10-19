import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { UserSkillError } from '@/server/services/skill/userSkills';

import SkillsRoutes from '../skills.route';

const { service } = vi.hoisted(() => ({
  service: {
    createFromText: vi.fn(),
    get: vi.fn(),
    importFromFile: vi.fn(),
    importFromUrl: vi.fn(),
    list: vi.fn(),
    remove: vi.fn(),
  },
}));

vi.mock('@/const/rbac', () => ({ RBAC_PERMISSIONS: {} }));
vi.mock('@/database/core/db-adaptor', () => ({ getServerDB: async () => ({}) }));
vi.mock('@/database/models/rbac', () => ({ RbacModel: class {} }));
vi.mock('../../middleware', () => ({
  requireAuth: async (c: any, next: any) => {
    c.set('userId', 'user_1');
    await next();
  },
}));
vi.mock('@/server/services/skill/userSkills', () => {
  class UserSkillError extends Error {
    status: number;
    constructor(
      message: string,
      readonly code: string,
    ) {
      super(message);
      this.status = { CONFLICT: 409, INVALID: 400, NOT_FOUND: 404 }[code] ?? 500;
    }
  }
  return {
    UserSkillError,
    UserSkillService: class {
      constructor() {
        return service as any;
      }
    },
  };
});

// arckep (19.10.2026): контракт REST для экрана «Мои навыки» — пути, тела, ответы, коды ошибок.

const app = new Hono().route('/skills', SkillsRoutes);

const request = (method: string, path: string, body?: unknown) =>
  app.request(`/skills${path}`, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
    method,
  });

const card = { description: 'd', id: 'skill_1', identifier: 'user.a', name: 'N', source: 'user' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /skills', () => {
  it('отдаёт {skills, total} в общей обёртке', async () => {
    service.list.mockResolvedValue({ skills: [card], total: 1 });

    const response = await request('GET', '');
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toMatchObject({ data: { skills: [card], total: 1 }, success: true });
    expect(json.timestamp).toBeTruthy();
  });
});

describe('GET /skills/:id', () => {
  it('найден — 200 с навыком', async () => {
    service.get.mockResolvedValue({ ...card, content: 'text' });
    const response = await request('GET', '/skill_1');
    expect(response.status).toBe(200);
    expect((await response.json()).data.content).toBe('text');
    expect(service.get).toHaveBeenCalledWith('skill_1');
  });

  it('не найден — 404 с текстом', async () => {
    service.get.mockResolvedValue(null);
    const response = await request('GET', '/nope');
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: 'Навык не найден.', success: false });
  });

  it('странный идентификатор не доходит до сервиса', async () => {
    const response = await request('GET', '/a%20b');
    expect(response.status).toBe(400);
    expect(service.get).not.toHaveBeenCalled();
  });
});

describe('POST /skills (из текста)', () => {
  const body = { content: 'Шаги', description: 'Делает', name: 'Навык' };

  it('создаёт и возвращает {status, skill}', async () => {
    service.createFromText.mockResolvedValue({ skill: card, status: 'created' });

    const response = await request('POST', '', body);

    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ skill: card, status: 'created' });
    expect(service.createFromText).toHaveBeenCalledWith(body);
  });

  it('файлы-приложения принимаются', async () => {
    service.createFromText.mockResolvedValue({ skill: card, status: 'created' });
    const files = [{ content: 'print(1)', path: 'scripts/run.py' }];
    await request('POST', '', { ...body, files });
    expect(service.createFromText).toHaveBeenCalledWith({ ...body, files });
  });

  it('имя занято — 409 с русским текстом сервиса', async () => {
    service.createFromText.mockRejectedValue(
      new UserSkillError('Навык «Навык» уже есть.', 'CONFLICT'),
    );

    const response = await request('POST', '', body);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: 'Навык «Навык» уже есть.',
      success: false,
    });
  });

  it.each([
    ['без имени', { content: 'c', description: 'd' }],
    ['пустой текст', { content: '', description: 'd', name: 'n' }],
    ['слишком длинное описание', { content: 'c', description: 'я'.repeat(1025), name: 'n' }],
    [
      '21 файл',
      {
        content: 'c',
        description: 'd',
        files: Array.from({ length: 21 }, (_, i) => ({ content: 'x', path: `f${i}` })),
        name: 'n',
      },
    ],
  ])('%s — 400, сервис не вызывается', async (_, payload) => {
    const response = await request('POST', '', payload);
    expect(response.status).toBe(400);
    expect(service.createFromText).not.toHaveBeenCalled();
  });
});

describe('POST /skills/import', () => {
  it('по ссылке', async () => {
    service.importFromUrl.mockResolvedValue({ skill: card, status: 'created' });
    const response = await request('POST', '/import', { url: 'https://github.com/a/b' });
    expect(response.status).toBe(200);
    expect(service.importFromUrl).toHaveBeenCalledWith('https://github.com/a/b');
    expect(service.importFromFile).not.toHaveBeenCalled();
  });

  it('из файла чата', async () => {
    service.importFromFile.mockResolvedValue({ skill: card, status: 'created' });
    const response = await request('POST', '/import', { fileId: 'file_1' });
    expect(response.status).toBe(200);
    expect(service.importFromFile).toHaveBeenCalledWith('file_1');
    expect(service.importFromUrl).not.toHaveBeenCalled();
  });

  it('нужно ровно одно из url и fileId', async () => {
    expect((await request('POST', '/import', {})).status).toBe(400);
    expect((await request('POST', '/import', { fileId: 'f', url: 'https://x' })).status).toBe(400);
    expect(service.importFromUrl).not.toHaveBeenCalled();
    expect(service.importFromFile).not.toHaveBeenCalled();
  });

  it('ошибка сервиса уходит с его кодом', async () => {
    service.importFromUrl.mockRejectedValue(
      new UserSkillError('Принимаются только ссылки https://', 'INVALID'),
    );
    const response = await request('POST', '/import', { url: 'http://x' });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('https');
  });
});

describe('DELETE /skills/:id', () => {
  it('удаляет своё', async () => {
    service.remove.mockResolvedValue({ id: 'skill_1' });
    const response = await request('DELETE', '/skill_1');
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ id: 'skill_1' });
  });

  it('чужое или несуществующее — 404', async () => {
    service.remove.mockRejectedValue(new UserSkillError('Навык не найден.', 'NOT_FOUND'));
    expect((await request('DELETE', '/skill_x')).status).toBe(404);
  });
});

describe('PATCH', () => {
  it('«выключенного» навыка в движке нет: PATCH не объявлен', async () => {
    const response = await request('PATCH', '/skill_1', { enabled: false });
    expect(response.status).toBe(404);
  });
});
