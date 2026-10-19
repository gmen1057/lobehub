import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';

import { SkillsController } from '../controllers/skills.controller';
import { requireAuth } from '../middleware';

/**
 * arckep (ТЗ chat-skills-tools, этап 2): навыки человека для экрана «Мои навыки». Образец — plugins.route.ts.
 * «Выключенного» навыка в движке нет (в agent_skills нет такого поля), поэтому PATCH нет.
 */
const SkillsRoutes = new Hono();

export const SkillIdSchema = z.object({
  id: z.string().regex(/^[\w.:-]{1,100}$/),
});

export const SkillTextSchema = z.object({
  content: z.string().min(1).max(200_000),
  description: z.string().min(1).max(1024),
  files: z
    .array(z.object({ content: z.string().max(200_000), path: z.string().min(1).max(300) }))
    .max(20)
    .optional(),
  name: z.string().min(1).max(100),
});

export const SkillImportSchema = z
  .object({
    fileId: z.string().min(1).max(100).optional(),
    url: z.string().min(1).max(2000).optional(),
  })
  .refine((body) => Boolean(body.url) !== Boolean(body.fileId), {
    message: 'Укажите ровно одно: url или fileId',
  });

// GET /api/v1/skills — навыки человека и встроенные (с source)
SkillsRoutes.get('/', requireAuth, async (c) => {
  return await new SkillsController().listSkills(c);
});

// POST /api/v1/skills — навык из текста
SkillsRoutes.post('/', requireAuth, zValidator('json', SkillTextSchema), async (c) => {
  return await new SkillsController().createSkill(c);
});

// POST /api/v1/skills/import — по ссылке (url) или из файла чата (fileId)
SkillsRoutes.post('/import', requireAuth, zValidator('json', SkillImportSchema), async (c) => {
  return await new SkillsController().importSkill(c);
});

// GET /api/v1/skills/:id
SkillsRoutes.get('/:id', requireAuth, zValidator('param', SkillIdSchema), async (c) => {
  return await new SkillsController().getSkill(c);
});

// DELETE /api/v1/skills/:id
SkillsRoutes.delete('/:id', requireAuth, zValidator('param', SkillIdSchema), async (c) => {
  return await new SkillsController().deleteSkill(c);
});

export default SkillsRoutes;
