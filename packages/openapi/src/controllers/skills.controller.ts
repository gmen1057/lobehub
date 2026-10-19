import type { Context } from 'hono';

import {
  type SkillTextInput,
  UserSkillError,
  UserSkillService,
} from '@/server/services/skill/userSkills';

import { BaseController } from '../common/base.controller';

/**
 * arckep (19.10.2026, ТЗ chat-skills-tools, этап 2): навыки человека по REST для экрана «Мои навыки».
 * Права — только свои записи (AgentSkillModel ограничен userId), отдельных scope RBAC у навыков нет.
 * Ту же работу делает инструмент помощника `arckep-skills` (UserSkillService).
 */
export class SkillsController extends BaseController {
  private async service(c: Context) {
    return new UserSkillService(await this.getDatabase(), this.getUserId(c)!);
  }

  /** Ошибки сервиса навыков уходят с их кодом и русским текстом, остальные — общим обработчиком. */
  private fail(c: Context, error: unknown): Response {
    if (error instanceof UserSkillError) return this.error(c, error.message, error.status);
    return this.handleError(c, error);
  }

  /** GET /api/v1/skills — навыки человека и встроенные, у каждого source. */
  async listSkills(c: Context): Promise<Response> {
    try {
      return this.success(c, await (await this.service(c)).list(), 'skills');
    } catch (error) {
      return this.fail(c, error);
    }
  }

  /** GET /api/v1/skills/:id */
  async getSkill(c: Context): Promise<Response> {
    try {
      const { id } = this.getParams<{ id: string }>(c);
      const skill = await (await this.service(c)).get(id);
      if (!skill) return this.error(c, 'Навык не найден.', 404);
      return this.success(c, skill, 'skill');
    } catch (error) {
      return this.fail(c, error);
    }
  }

  /** POST /api/v1/skills — навык из текста. Имя занято — 409. */
  async createSkill(c: Context): Promise<Response> {
    try {
      const body = await this.getBody<SkillTextInput>(c);
      const result = await (await this.service(c)).createFromText(body);
      return this.success(c, result, 'skill created');
    } catch (error) {
      return this.fail(c, error);
    }
  }

  /** POST /api/v1/skills/import — навык по ссылке (`url`) или из файла чата (`fileId`). */
  async importSkill(c: Context): Promise<Response> {
    try {
      const body = await this.getBody<{ fileId?: string; url?: string }>(c);
      const service = await this.service(c);
      const result = body.url
        ? await service.importFromUrl(body.url)
        : await service.importFromFile(body.fileId!);
      return this.success(c, result, 'skill imported');
    } catch (error) {
      return this.fail(c, error);
    }
  }

  /** DELETE /api/v1/skills/:id */
  async deleteSkill(c: Context): Promise<Response> {
    try {
      const { id } = this.getParams<{ id: string }>(c);
      return this.success(c, await (await this.service(c)).remove(id), 'skill removed');
    } catch (error) {
      return this.fail(c, error);
    }
  }
}
