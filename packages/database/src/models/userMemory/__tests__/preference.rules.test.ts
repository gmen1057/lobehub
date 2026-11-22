// @vitest-environment node
import { LayersEnum } from '@lobechat/types';
import { beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../../core/getTestDB';
import { userMemories, userMemoriesPreferences, users } from '../../../schemas';
import type { LobeChatDatabase } from '../../../type';
import { UserMemoryModel } from '../model';
import {
  countMemoryRuleChars,
  estimateMemoryRuleTokens,
  MAX_MEMORY_RULES,
  MAX_MEMORY_RULES_TOKENS,
  MemoryRuleError,
  normalizeMemoryRuleText,
  UserMemoryPreferenceModel,
  utf8ByteLength,
} from '../preference';

const userId = 'rule-test-user';
const otherUserId = 'rule-other-user';

const serverDB: LobeChatDatabase = await getTestDB();
let preferenceModel: UserMemoryPreferenceModel;

beforeEach(async () => {
  await serverDB.delete(users);
  await serverDB.insert(users).values([{ id: userId }, { id: otherUserId }]);
  preferenceModel = new UserMemoryPreferenceModel(serverDB, userId);
});

describe('Memory rules token & char helpers (PROD-1 contract)', () => {
  it('computes UTF-8 bytes, Unicode code points, and Cyrillic tokens identically to contract', () => {
    expect(normalizeMemoryRuleText('  Отвечай кратко\r\nи по делу  ')).toBe(
      'Отвечай кратко\nи по делу',
    );
    expect(estimateMemoryRuleTokens('   ')).toBe(0);

    // "Отвечай кратко и по делу": 20 Cyrillic letters (40B) + 4 spaces (4B) = 44B -> ceil(44/3) = 15
    expect(utf8ByteLength('Отвечай кратко и по делу')).toBe(44);
    expect(countMemoryRuleChars('Отвечай кратко и по делу')).toBe(24);
    expect(estimateMemoryRuleTokens('Отвечай кратко и по делу')).toBe(15);

    // Surrogate-pair emoji: 1 code point, 4 UTF-8 bytes -> ceil(4/3) = 2 tokens
    expect(countMemoryRuleChars('🚀🔥')).toBe(2);
    expect(utf8ByteLength('🚀🔥')).toBe(8);
    expect(estimateMemoryRuleTokens('🚀🔥')).toBe(3);
  });
});

describe('UserMemoryPreferenceModel rules CRUD & filtering', () => {
  it('creates rules with parent user_memories, enforces 2..200 chars, case-insensitive duplicates, <=15 count, <=500 tokens', async () => {
    await expect(preferenceModel.createRule('а')).rejects.toMatchObject({
      code: 'RULE_LENGTH_INVALID',
    });
    await expect(preferenceModel.createRule('я'.repeat(201))).rejects.toMatchObject({
      code: 'RULE_LENGTH_INVALID',
    });

    const created1 = await preferenceModel.createRule('  Отвечай кратко и по делу  ');
    expect(created1).toMatchObject({
      maxRules: MAX_MEMORY_RULES,
      maxTokens: MAX_MEMORY_RULES_TOKENS,
      total: 1,
      usedTokens: 15,
    });
    expect(created1.item.text).toBe('Отвечай кратко и по делу');
    expect(created1.item.tokens).toBe(15);

    // Duplicate (case-insensitive)
    await expect(preferenceModel.createRule('отвечай КРАТКО и по делу')).rejects.toMatchObject({
      code: 'RULE_DUPLICATE',
    });

    // Token limit <= 500 using Cyrillic rules (180 'ф' chars = 360 UTF-8 bytes = 120 tokens each)
    await preferenceModel.createRule(`1 ${'ф'.repeat(180)}`); // 121 tokens (total 136)
    await preferenceModel.createRule(`2 ${'ф'.repeat(180)}`); // 121 tokens (total 257)
    await preferenceModel.createRule(`3 ${'ф'.repeat(180)}`); // 121 tokens (total 378)
    await preferenceModel.createRule(`4 ${'ф'.repeat(180)}`); // 121 tokens (total 499)

    await expect(preferenceModel.createRule('Лишнее правило')).rejects.toMatchObject({
      code: 'RULE_TOKEN_LIMIT',
    });
  });

  it('enforces max 15 rules and returns deterministic created_at ASC, id ASC order', async () => {
    const createdIds: string[] = [];
    for (let i = 1; i <= 15; i += 1) {
      const res = await preferenceModel.createRule(`Rule #${String(i).padStart(2, '0')}`);
      createdIds.push(res.item.id);
    }

    await expect(preferenceModel.createRule('Rule #16')).rejects.toBeInstanceOf(MemoryRuleError);
    await expect(preferenceModel.createRule('Rule #16')).rejects.toMatchObject({
      code: 'RULE_COUNT_LIMIT',
    });

    const queried = await preferenceModel.queryRules();
    expect(queried.map((r) => r.id)).toEqual(createdIds);
  });

  it('updates rule text and parent user_memories without mutating id or createdAt, and deletes idempotently', async () => {
    const r1 = await preferenceModel.createRule('Первое правило');
    const r2 = await preferenceModel.createRule('Второе правило');

    await expect(preferenceModel.updateRule('missing-id', 'Новое')).rejects.toMatchObject({
      code: 'RULE_NOT_FOUND',
    });
    await expect(preferenceModel.updateRule(r2.item.id, 'первое правило')).rejects.toMatchObject({
      code: 'RULE_DUPLICATE',
    });

    const updated = await preferenceModel.updateRule(
      r1.item.id,
      'Цены и расчёты всегда указывай в ₽',
    );
    expect(updated.item.id).toBe(r1.item.id);
    expect(updated.item.createdAt).toBe(r1.item.createdAt);
    expect(updated.item.text).toBe('Цены и расчёты всегда указывай в ₽');

    const rulesAfterUpdate = await preferenceModel.queryRules();
    expect(rulesAfterUpdate[0].id).toBe(r1.item.id);
    expect(rulesAfterUpdate[1].id).toBe(r2.item.id);

    const parentMem = await serverDB.query.userMemories.findFirst({
      where: (m, { eq }) => eq(m.id, rulesAfterUpdate[0].userMemoryId!),
    });
    expect(parentMem?.summary).toBe('Цены и расчёты всегда указывай в ₽');

    // Delete rule cascades parent user_memories and is idempotent
    const del1 = await preferenceModel.deleteRule(r1.item.id);
    expect(del1).toEqual({ deleted: true, id: r1.item.id });

    const del2 = await preferenceModel.deleteRule(r1.item.id);
    expect(del2).toEqual({ deleted: false, id: r1.item.id });

    const remainingParent = await serverDB.query.userMemories.findFirst({
      where: (m, { eq }) => eq(m.id, rulesAfterUpdate[0].userMemoryId!),
    });
    expect(remainingParent).toBeUndefined();
  });

  it('queryPreferencesExcludingRules excludes type="rule" from both items and total while keeping regular preferences', async () => {
    await preferenceModel.createRule('Отвечай кратко и по делу');

    const memoryModel = new UserMemoryModel(serverDB, userId);
    const { preference: autoPref } = await memoryModel.createPreferenceMemory({
      details: 'Любит таблицы',
      memoryCategory: 'communication',
      memoryLayer: LayersEnum.Preference,
      memoryType: 'preference' as any,
      preference: {
        conclusionDirectives: 'Показывать сравнения в виде таблиц',
        conclusionDirectivesVector: null,
        metadata: {},
        scorePriority: 0.7,
        suggestions: null,
        tags: [],
        type: 'communication',
      },
      summary: 'Любит таблицы',
      title: 'Таблицы',
    });

    // Also add a null-type preference to verify COALESCE(type, '') <> 'rule' keeps NULLs!
    const [nullParent] = await serverDB
      .insert(userMemories)
      .values({
        lastAccessedAt: new Date(),
        memoryLayer: 'preference',
        memoryType: 'preference',
        summary: 'Null type pref',
        title: 'Null type pref',
        userId,
      })
      .returning();
    const [nullPref] = await serverDB
      .insert(userMemoriesPreferences)
      .values({
        conclusionDirectives: 'Null type directive',
        type: null,
        userId,
        userMemoryId: nullParent.id,
      })
      .returning();

    const filtered = await preferenceModel.queryPreferencesExcludingRules({
      page: 1,
      pageSize: 50,
    });

    expect(filtered.total).toBe(2);
    expect(filtered.items.map((i) => i.preference.id).sort()).toEqual(
      [autoPref.id, nullPref.id].sort(),
    );
  });
});
