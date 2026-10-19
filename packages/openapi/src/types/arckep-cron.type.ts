import { z } from 'zod';

/**
 * arckep (19.10.2026, задачи помощника по расписанию): типы REST `/api/v1/arckep/cron-jobs`.
 * Шаблон и пояс проверяются в контроллере (`src/server/services/arckepCron/schedule.ts`), чтобы ответ 400
 * нёс понятный текст для человека и модели, а не разбор zod.
 */

const IdSchema = z.string().regex(/^[\w-]{1,100}$/);

const NameSchema = z.string().trim().min(1).max(80);
const ContentSchema = z
  .string()
  .max(8000)
  .refine((value) => value.trim().length > 0, 'content must not be empty');
const CronPatternSchema = z.string().min(1).max(100);
const TimezoneSchema = z.string().max(64);
const MaxExecutionsSchema = z.number().int().min(1).max(10_000).nullable();
const DescriptionSchema = z.string().max(1000).nullable();

export const CronJobIdParamSchema = z.object({ id: IdSchema });

export const CronJobListQuerySchema = z.object({
  agentId: IdSchema.optional(),
});

export const CronJobTopicsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const CronJobCreateSchema = z.object({
  agentId: IdSchema,
  content: ContentSchema,
  cronPattern: CronPatternSchema,
  description: DescriptionSchema.optional(),
  enabled: z.boolean().optional(),
  maxExecutions: MaxExecutionsSchema.optional(),
  name: NameSchema,
  timezone: TimezoneSchema.optional(),
});

export const CronJobUpdateSchema = z
  .object({
    agentId: IdSchema,
    content: ContentSchema,
    cronPattern: CronPatternSchema,
    description: DescriptionSchema,
    enabled: z.boolean(),
    maxExecutions: MaxExecutionsSchema,
    name: NameSchema,
    timezone: TimezoneSchema,
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'at least one field is required');

// Модель и провайдер запуска (хранит студия): только парой; `null` читается как «не задано».
const RunOverrideSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .nullish()
  .transform((value) => value ?? undefined);

export const CronJobRunSchema = z
  .object({
    model: RunOverrideSchema,
    provider: RunOverrideSchema,
    runId: z.string().trim().min(1).max(100),
  })
  .refine((value) => (value.model === undefined) === (value.provider === undefined), {
    message: 'model and provider must be passed together',
    path: ['model'],
  });

export type CronJobCreateRequest = z.infer<typeof CronJobCreateSchema>;
export type CronJobUpdateRequest = z.infer<typeof CronJobUpdateSchema>;
export type CronJobRunRequest = z.infer<typeof CronJobRunSchema>;

/** Задача в ответах REST: поля модели движка в camelCase, без служебных (userId, groupId, editData). */
export interface CronJobResponse {
  agentId: string;
  content: string;
  createdAt: string;
  cronPattern: string;
  description: string | null;
  enabled: boolean;
  executionConditions: unknown;
  id: string;
  lastExecutedAt: string | null;
  maxExecutions: number | null;
  name: string | null;
  remainingExecutions: number | null;
  timezone: string;
  totalExecutions: number;
  updatedAt: string;
}

export interface CronJobTopicResponse {
  createdAt: string;
  id: string;
  title: string | null;
  updatedAt: string;
}
