import { LayersEnum } from '@lobechat/types';
import type { AnyColumn, SQL } from 'drizzle-orm';
import { and, asc, desc, eq, sql } from 'drizzle-orm';

import type { NewUserMemoryPreference, UserMemoryPreference } from '../../schemas';
import { userMemories, userMemoriesPreferences } from '../../schemas';
import type { LobeChatDatabase } from '../../type';
import { sanitizeBm25Query } from '../../utils/bm25';

export const MAX_MEMORY_RULES = 15;
export const MIN_MEMORY_RULE_CHARS = 2;
export const MAX_MEMORY_RULE_CHARS = 200;
export const MAX_MEMORY_RULES_TOKENS = 500;

export function utf8ByteLength(str: string): number {
  let bytes = 0;
  for (const ch of str) {
    const cp = ch.codePointAt(0)!;
    if (cp <= 0x7f) bytes += 1;
    else if (cp <= 0x7ff) bytes += 2;
    else if (cp <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

export function normalizeMemoryRuleText(raw: string): string {
  return raw.replaceAll(/\r\n?/g, '\n').trim();
}

export function countMemoryRuleChars(raw: string): number {
  return Array.from(normalizeMemoryRuleText(raw)).length;
}

export function estimateMemoryRuleTokens(raw: string): number {
  const normalized = normalizeMemoryRuleText(raw);
  if (!normalized) return 0;
  return Math.ceil(utf8ByteLength(normalized) / 3);
}

export type MemoryRuleErrorCode =
  | 'RULE_COUNT_LIMIT'
  | 'RULE_DUPLICATE'
  | 'RULE_LENGTH_INVALID'
  | 'RULE_NOT_FOUND'
  | 'RULE_TOKEN_LIMIT';

export class MemoryRuleError extends Error {
  readonly code: MemoryRuleErrorCode;

  constructor(code: MemoryRuleErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'MemoryRuleError';
    this.code = code;
  }
}

export interface MemoryRuleRow {
  conclusionDirectives: string;
  createdAt: Date;
  id: string;
  updatedAt: Date;
  userMemoryId: string | null;
}

export interface MemoryRuleItem {
  createdAt: string;
  id: string;
  text: string;
  tokens: number;
  updatedAt: string;
}

export interface MemoryRuleMutationResult {
  item: MemoryRuleItem;
  maxRules: number;
  maxTokens: number;
  total: number;
  usedTokens: number;
}

export class UserMemoryPreferenceModel {
  private userId: string;
  private db: LobeChatDatabase;

  constructor(db: LobeChatDatabase, userId: string) {
    this.userId = userId;
    this.db = db;
  }

  private queryRulesWithExecutor = async (executor: LobeChatDatabase): Promise<MemoryRuleRow[]> => {
    const rows = await executor
      .select({
        conclusionDirectives: userMemoriesPreferences.conclusionDirectives,
        createdAt: userMemoriesPreferences.createdAt,
        id: userMemoriesPreferences.id,
        updatedAt: userMemoriesPreferences.updatedAt,
        userMemoryId: userMemoriesPreferences.userMemoryId,
      })
      .from(userMemoriesPreferences)
      .innerJoin(
        userMemories,
        and(
          eq(userMemoriesPreferences.userMemoryId, userMemories.id),
          eq(userMemoriesPreferences.userId, this.userId),
          eq(userMemories.userId, this.userId),
          eq(userMemories.memoryLayer, 'preference'),
        ),
      )
      .where(
        and(
          eq(userMemoriesPreferences.userId, this.userId),
          eq(userMemoriesPreferences.type, 'rule'),
        ),
      )
      .orderBy(asc(userMemoriesPreferences.createdAt), asc(userMemoriesPreferences.id));

    return rows.map((row) => ({
      conclusionDirectives: row.conclusionDirectives ?? '',
      createdAt: row.createdAt,
      id: row.id,
      updatedAt: row.updatedAt,
      userMemoryId: row.userMemoryId,
    }));
  };

  queryRules = async (): Promise<MemoryRuleRow[]> => {
    return this.queryRulesWithExecutor(this.db);
  };

  createRule = async (rawText: string): Promise<MemoryRuleMutationResult> => {
    const text = normalizeMemoryRuleText(rawText);
    const chars = Array.from(text).length;
    if (chars < MIN_MEMORY_RULE_CHARS || chars > MAX_MEMORY_RULE_CHARS) {
      throw new MemoryRuleError('RULE_LENGTH_INVALID');
    }

    const tokens = estimateMemoryRuleTokens(text);
    const normalizedLower = text.toLowerCase();
    const title = Array.from(text).slice(0, 80).join('');

    return this.db.transaction(async (tx) => {
      const existing = await this.queryRulesWithExecutor(tx);

      if (
        existing.some(
          (r) => normalizeMemoryRuleText(r.conclusionDirectives).toLowerCase() === normalizedLower,
        )
      ) {
        throw new MemoryRuleError('RULE_DUPLICATE');
      }

      if (existing.length >= MAX_MEMORY_RULES) {
        throw new MemoryRuleError('RULE_COUNT_LIMIT');
      }

      const existingUsedTokens = existing.reduce(
        (sum, r) => sum + estimateMemoryRuleTokens(r.conclusionDirectives),
        0,
      );
      if (existingUsedTokens + tokens > MAX_MEMORY_RULES_TOKENS) {
        throw new MemoryRuleError('RULE_TOKEN_LIMIT');
      }

      const now = new Date();
      const [memory] = await tx
        .insert(userMemories)
        .values({
          capturedAt: now,
          details: text,
          lastAccessedAt: now,
          memoryCategory: 'rule',
          memoryLayer: 'preference',
          memoryType: 'preference',
          summary: text,
          title,
          userId: this.userId,
        })
        .returning();

      if (!memory) {
        throw new Error('Failed to create parent user memory for rule');
      }

      const [preference] = await tx
        .insert(userMemoriesPreferences)
        .values({
          capturedAt: now,
          conclusionDirectives: text,
          metadata: { pinnedRule: true },
          scorePriority: 1,
          type: 'rule',
          userId: this.userId,
          userMemoryId: memory.id,
        })
        .returning();

      const usedTokens = existingUsedTokens + tokens;

      return {
        item: {
          createdAt: preference.createdAt.toISOString(),
          id: preference.id,
          text,
          tokens,
          updatedAt: preference.updatedAt.toISOString(),
        },
        maxRules: MAX_MEMORY_RULES,
        maxTokens: MAX_MEMORY_RULES_TOKENS,
        total: existing.length + 1,
        usedTokens,
      };
    });
  };

  updateRule = async (id: string, rawText: string): Promise<MemoryRuleMutationResult> => {
    const text = normalizeMemoryRuleText(rawText);
    const chars = Array.from(text).length;
    if (chars < MIN_MEMORY_RULE_CHARS || chars > MAX_MEMORY_RULE_CHARS) {
      throw new MemoryRuleError('RULE_LENGTH_INVALID');
    }

    const newTokens = estimateMemoryRuleTokens(text);
    const normalizedLower = text.toLowerCase();
    const title = Array.from(text).slice(0, 80).join('');

    return this.db.transaction(async (tx) => {
      const existing = await this.queryRulesWithExecutor(tx);
      const target = existing.find((r) => r.id === id);

      if (!target) {
        throw new MemoryRuleError('RULE_NOT_FOUND');
      }

      if (
        existing.some(
          (r) =>
            r.id !== id &&
            normalizeMemoryRuleText(r.conclusionDirectives).toLowerCase() === normalizedLower,
        )
      ) {
        throw new MemoryRuleError('RULE_DUPLICATE');
      }

      const existingUsedTokens = existing.reduce(
        (sum, r) => sum + estimateMemoryRuleTokens(r.conclusionDirectives),
        0,
      );
      const oldTokens = estimateMemoryRuleTokens(target.conclusionDirectives);
      const nextUsedTokens = existingUsedTokens - oldTokens + newTokens;

      if (nextUsedTokens > MAX_MEMORY_RULES_TOKENS) {
        throw new MemoryRuleError('RULE_TOKEN_LIMIT');
      }

      const now = new Date();
      const [updated] = await tx
        .update(userMemoriesPreferences)
        .set({
          conclusionDirectives: text,
          updatedAt: now,
        })
        .where(
          and(
            eq(userMemoriesPreferences.id, id),
            eq(userMemoriesPreferences.userId, this.userId),
            eq(userMemoriesPreferences.type, 'rule'),
          ),
        )
        .returning();

      if (!updated) {
        throw new MemoryRuleError('RULE_NOT_FOUND');
      }

      if (target.userMemoryId) {
        await tx
          .update(userMemories)
          .set({
            details: text,
            summary: text,
            title,
            updatedAt: now,
          })
          .where(
            and(eq(userMemories.id, target.userMemoryId), eq(userMemories.userId, this.userId)),
          );
      }

      return {
        item: {
          createdAt: updated.createdAt.toISOString(),
          id: updated.id,
          text,
          tokens: newTokens,
          updatedAt: updated.updatedAt.toISOString(),
        },
        maxRules: MAX_MEMORY_RULES,
        maxTokens: MAX_MEMORY_RULES_TOKENS,
        total: existing.length,
        usedTokens: nextUsedTokens,
      };
    });
  };

  deleteRule = async (id: string): Promise<{ deleted: boolean; id: string }> => {
    return this.db.transaction(async (tx) => {
      const rule = await tx.query.userMemoriesPreferences.findFirst({
        where: and(
          eq(userMemoriesPreferences.id, id),
          eq(userMemoriesPreferences.userId, this.userId),
          eq(userMemoriesPreferences.type, 'rule'),
        ),
      });

      if (!rule) {
        return { deleted: false, id };
      }

      if (rule.userMemoryId) {
        await tx
          .delete(userMemories)
          .where(and(eq(userMemories.id, rule.userMemoryId), eq(userMemories.userId, this.userId)));
      }

      await tx
        .delete(userMemoriesPreferences)
        .where(
          and(
            eq(userMemoriesPreferences.id, id),
            eq(userMemoriesPreferences.userId, this.userId),
            eq(userMemoriesPreferences.type, 'rule'),
          ),
        );

      return { deleted: true, id };
    });
  };

  queryPreferencesExcludingRules = async ({
    order = 'desc',
    page = 1,
    pageSize = 50,
    q,
  }: {
    order?: 'asc' | 'desc';
    page?: number;
    pageSize?: number;
    q?: string;
  } = {}) => {
    const normalizedPage = Math.max(1, page ?? 1);
    const normalizedPageSize = Math.min(Math.max(pageSize ?? 50, 1), 100);
    const offset = (normalizedPage - 1) * normalizedPageSize;
    const normalizedQuery = typeof q === 'string' ? q.trim() : '';
    const bm25Query = normalizedQuery ? sanitizeBm25Query(normalizedQuery) : '';
    const applyOrder = order === 'asc' ? asc : desc;

    const orderByClauses = [
      applyOrder(userMemoriesPreferences.capturedAt as AnyColumn),
      applyOrder(userMemoriesPreferences.updatedAt as AnyColumn),
      applyOrder(userMemoriesPreferences.createdAt as AnyColumn),
    ];

    const joinCondition = and(
      eq(userMemories.id, userMemoriesPreferences.userMemoryId),
      eq(userMemoriesPreferences.userId, this.userId),
    );

    const filters: Array<SQL | undefined> = [
      eq(userMemories.userId, this.userId),
      eq(userMemories.memoryLayer, LayersEnum.Preference),
      sql`COALESCE(${userMemoriesPreferences.type}, '') <> 'rule'`,
      bm25Query
        ? sql`(${userMemories.title} @@@ ${bm25Query} OR ${userMemories.summary} @@@ ${bm25Query} OR ${userMemories.details} @@@ ${bm25Query} OR ${userMemoriesPreferences.conclusionDirectives} @@@ ${bm25Query} OR ${userMemoriesPreferences.suggestions} @@@ ${bm25Query})`
        : undefined,
    ];

    const whereClause = and(...(filters.filter((f): f is SQL => f !== undefined) as SQL[]));

    const baseSelection = {
      accessedAt: userMemories.accessedAt,
      accessedCount: userMemories.accessedCount,
      createdAt: userMemories.createdAt,
      id: userMemories.id,
      lastAccessedAt: userMemories.lastAccessedAt,
      memoryCategory: userMemories.memoryCategory,
      memoryLayer: userMemories.memoryLayer,
      memoryType: userMemories.memoryType,
      metadata: userMemories.metadata,
      status: userMemories.status,
      tags: userMemories.tags,
      title: userMemories.title,
      updatedAt: userMemories.updatedAt,
      userId: userMemories.userId,
    };

    const rowsQuery = this.db
      .select({
        memory: baseSelection,
        preference: {
          accessedAt: userMemoriesPreferences.accessedAt,
          conclusionDirectives: userMemoriesPreferences.conclusionDirectives,
          createdAt: userMemoriesPreferences.createdAt,
          id: userMemoriesPreferences.id,
          metadata: userMemoriesPreferences.metadata,
          scorePriority: userMemoriesPreferences.scorePriority,
          tags: userMemoriesPreferences.tags,
          type: userMemoriesPreferences.type,
          updatedAt: userMemoriesPreferences.updatedAt,
          userId: userMemoriesPreferences.userId,
          userMemoryId: userMemoriesPreferences.userMemoryId,
        },
      })
      .from(userMemories)
      .innerJoin(userMemoriesPreferences, joinCondition)
      .where(whereClause)
      .orderBy(...orderByClauses)
      .limit(normalizedPageSize)
      .offset(offset);

    const totalQuery = this.db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(userMemories)
      .innerJoin(userMemoriesPreferences, joinCondition)
      .where(whereClause);

    const [rows, totalResult] = await Promise.all([rowsQuery, totalQuery]);

    return {
      items: rows.map((row) => ({
        layer: LayersEnum.Preference,
        memory: row.memory,
        preference: row.preference,
      })),
      page: normalizedPage,
      pageSize: normalizedPageSize,
      total: Number(totalResult[0]?.count ?? 0),
    };
  };

  create = async (params: Omit<NewUserMemoryPreference, 'userId'>) => {
    const [result] = await this.db
      .insert(userMemoriesPreferences)
      .values({ ...params, userId: this.userId })
      .returning();

    return result;
  };

  delete = async (id: string) => {
    return this.db.transaction(async (tx) => {
      const preference = await tx.query.userMemoriesPreferences.findFirst({
        where: and(
          eq(userMemoriesPreferences.id, id),
          eq(userMemoriesPreferences.userId, this.userId),
        ),
      });

      if (!preference || !preference.userMemoryId) {
        return { success: false };
      }

      // Delete the base user memory (cascade will handle the preference)
      await tx
        .delete(userMemories)
        .where(
          and(eq(userMemories.id, preference.userMemoryId), eq(userMemories.userId, this.userId)),
        );

      return { success: true };
    });
  };

  deleteAll = async () => {
    return this.db
      .delete(userMemoriesPreferences)
      .where(eq(userMemoriesPreferences.userId, this.userId));
  };

  query = async (limit = 50) => {
    return this.db.query.userMemoriesPreferences.findMany({
      limit,
      orderBy: [desc(userMemoriesPreferences.createdAt)],
      where: eq(userMemoriesPreferences.userId, this.userId),
    });
  };

  findById = async (id: string) => {
    return this.db.query.userMemoriesPreferences.findFirst({
      where: and(
        eq(userMemoriesPreferences.id, id),
        eq(userMemoriesPreferences.userId, this.userId),
      ),
    });
  };

  update = async (id: string, value: Partial<UserMemoryPreference>) => {
    return this.db
      .update(userMemoriesPreferences)
      .set({ ...value, updatedAt: new Date() })
      .where(
        and(eq(userMemoriesPreferences.id, id), eq(userMemoriesPreferences.userId, this.userId)),
      );
  };
}
