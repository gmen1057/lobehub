import type { ChatTopicMetadata } from '@lobechat/types';
import { z } from 'zod';

import type { TopicItem, UserItem } from '@/database/schemas';

import type { IPaginationQuery, PaginationQueryResponse } from './common.type';
import { PaginationQuerySchema } from './common.type';

// ==================== Topic Query Types ====================

export interface TopicListQuery extends IPaginationQuery {
  agentId?: string | null;
  excludeTriggers?: string[];
  groupId?: string | null;
  isInbox?: boolean;
}

export const TopicListQuerySchema = z
  .object({
    agentId: z.string().nullish(),
    // arckep (19.10.2026): `?excludeTriggers=cron` или `?excludeTriggers=cron,eval` (и повтор ключа) — одна
    // строка приходит из Hono строкой, а не массивом, поэтому ждём и то и другое
    excludeTriggers: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .transform((value) =>
        value === undefined
          ? undefined
          : (Array.isArray(value) ? value : [value])
              .flatMap((item) => item.split(','))
              .map((item) => item.trim())
              .filter(Boolean),
      ),
    groupId: z.string().nullish(),
    isInbox: z
      .string()
      .optional()
      .transform((v) => v === 'true'),
  })
  .extend(PaginationQuerySchema.shape);

// ==================== Topic CRUD Types ====================

export interface TopicCreateRequest {
  agentId?: string | null;
  clientId?: string;
  favorite?: boolean;
  groupId?: string | null;
  title: string;
}

export const TopicCreateRequestSchema = z.object({
  agentId: z.string().nullish(),
  clientId: z.string().optional(),
  favorite: z.boolean().optional(),
  groupId: z.string().nullish(),
  title: z.string().min(1, '标题不能为空'),
});

export interface TopicUpdateRequest {
  /** arckep: перенос в другого помощника; null — «без проекта» */
  agentId?: string | null;
  favorite?: boolean;
  historySummary?: string;
  metadata?: ChatTopicMetadata;
  title?: string;
}

export const TopicUpdateRequestSchema = z.object({
  // arckep (chat-next-redesign, E1): перенос переписки в другого помощника; null — «без проекта»
  agentId: z.string().nullable().optional(),
  favorite: z.boolean().optional(),
  historySummary: z.string().optional(),
  metadata: z
    .object({
      model: z.string().optional(),
      provider: z.string().optional(),
      boundDeviceId: z.string().optional(),
      workingDirectory: z.string().optional(),
    })
    .optional(),
  title: z.string().min(1, '标题不能为空').optional(),
});

// ==================== Topic Response Types ====================

export interface TopicResponse extends TopicItem {
  messageCount: number;
  user: UserItem;
}

/**
 * Topic list response type
 */
export type TopicListResponse = PaginationQueryResponse<{
  topics: TopicResponse[];
}>;

// ==================== Common Schemas ====================

export const TopicGetParamSchema = z.object({
  id: z.string().min(1, '话题ID不能为空'),
});

export const TopicDeleteParamSchema = z.object({
  id: z.string().min(1, '话题ID不能为空'),
});

export const TopicUpdateParamSchema = z.object({
  id: z.string().min(1, '话题ID不能为空'),
});
