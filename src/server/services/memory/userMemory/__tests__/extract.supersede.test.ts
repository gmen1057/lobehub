// @vitest-environment node
import type { LobeChatDatabase } from '@lobechat/database';
import {
  userMemories,
  userMemoriesContexts,
  userMemoriesExperiences,
  userMemoriesPreferences,
  users,
} from '@lobechat/database/schemas';
import { getTestDB } from '@lobechat/database/test-utils';
import { ContextStatusEnum, LayersEnum, MemorySourceType } from '@lobechat/types';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { UserMemoryModel } from '@/database/models/userMemory';
import { UserMemoryPreferenceModel } from '@/database/models/userMemory/preference';

import { MemoryExtractionExecutor } from '../extract';

const testDB: LobeChatDatabase = await getTestDB();
vi.mock('@/database/server', () => ({
  getServerDB: vi.fn(async () => testDB),
}));

const userId = 'digest-supersede-user';
const otherUserId = 'digest-other-user';

beforeEach(async () => {
  await testDB.delete(users);
  await testDB.insert(users).values([{ id: userId }, { id: otherUserId }]);
});

describe('Nightly digest supersedeIds, pinned="true", and rule/tenant protection', () => {
  it('formatAllUserMemories marks type="rule" preferences with pinned="true", and runDigestSingleCall preserves supersedeIds', async () => {
    const prefModel = new UserMemoryPreferenceModel(testDB, userId);
    const rule = await prefModel.createRule('Всегда отвечай на русском');

    const memModel = new UserMemoryModel(testDB, userId);
    const { preference: autoPref } = await memModel.createPreferenceMemory({
      details: 'Старое предпочтение',
      memoryCategory: 'style',
      memoryLayer: LayersEnum.Preference,
      memoryType: 'preference' as any,
      preference: {
        conclusionDirectives: 'Пиши длинные вступления',
        conclusionDirectivesVector: null,
        metadata: {},
        scorePriority: 0.5,
        suggestions: null,
        tags: [],
        type: 'communication',
      },
      summary: 'Старое предпочтение',
      title: 'Длинные вступления',
    });

    const executor = await MemoryExtractionExecutor.create();
    const xml = await (executor as any).formatAllUserMemories(userId, 100);

    expect(xml).toContain(`id="${rule.item.id}" pinned="true"`);
    expect(xml).toContain(`id="${autoPref.id}" date=`);
    expect(xml).not.toContain(`id="${autoPref.id}" pinned="true"`);

    const fakeLayerRuntime = {
      generateObject: vi.fn().mockResolvedValue({
        activity: { memories: [] },
        context: {
          memories: [
            {
              details: 'Merged project details',
              memoryCategory: 'work',
              memoryType: 'context',
              summary: 'Merged project',
              supersedeIds: ['ctx_old_1'],
              tags: ['project'],
              title: 'Project X',
              withContext: {
                associatedObjects: [],
                associatedSubjects: [],
                currentStatus: ContextStatusEnum.Ongoing,
                description: 'Ongoing project X',
                labels: [],
                scoreImpact: 0.8,
                scoreUrgency: 0.6,
                title: 'Project X',
                type: 'project',
              },
            },
          ],
        },
        experience: {
          memories: [
            {
              details: 'Learned lesson',
              memoryCategory: 'tech',
              memoryType: 'activity',
              summary: 'Lesson',
              supersedeIds: ['exp_old_1'],
              tags: [],
              title: 'Lesson X',
              withExperience: {
                action: 'Switched to batch',
                keyLearning: 'Batch saves 50%',
                knowledgeValueScore: 0.9,
                labels: [],
                possibleOutcome: 'Lower cost',
                problemSolvingScore: 0.9,
                reasoning: 'Too many calls',
                scoreConfidence: 0.9,
                situation: 'High API cost',
                type: 'optimization',
              },
            },
          ],
        },
        identity: { add: [], remove: [], update: [] },
        preference: {
          memories: [
            {
              details: 'Updated style',
              memoryCategory: 'style',
              memoryType: 'preference',
              summary: 'No intros',
              supersedeIds: [autoPref.id, rule.item.id],
              tags: [],
              title: 'No intros',
              withPreference: {
                appContext: null,
                conclusionDirectives: 'Skip introductions',
                extractedLabels: [],
                extractedScopes: [],
                originContext: null,
                scorePriority: 0.8,
                suggestions: [],
                type: 'rule', // Attempted hijack -> must become 'preference'!
              },
            },
          ],
        },
      }),
    };

    const singleCallResult = await (executor as any).runDigestSingleCall({
      availableCategories: ['work', 'style'],
      digestContext: xml,
      language: 'Russian',
      runtimes: { layerExtractor: fakeLayerRuntime },
      sessionDate: '2026-11-22T00:00:00.000Z',
    });

    expect(singleCallResult.outputs.preference.data.memories[0].supersedeIds).toEqual([
      autoPref.id,
      rule.item.id,
    ]);
    expect(singleCallResult.outputs.context.data.memories[0].supersedeIds).toEqual(['ctx_old_1']);
    expect(singleCallResult.outputs.experience.data.memories[0].supersedeIds).toEqual([
      'exp_old_1',
    ]);
  });

  it('supersedes own outdated preference/context/experience + parent user_memories, NEVER deletes pinned rules or other users entries, and blocks auto type="rule"', async () => {
    const prefModel = new UserMemoryPreferenceModel(testDB, userId);
    const pinnedRule = await prefModel.createRule('Цены всегда в ₽');

    const ownModel = new UserMemoryModel(testDB, userId);
    const otherModel = new UserMemoryModel(testDB, otherUserId);

    const { memory: ownOldPrefParent, preference: ownOldPref } =
      await ownModel.createPreferenceMemory({
        details: 'Old pref',
        memoryCategory: 'style',
        memoryLayer: LayersEnum.Preference,
        memoryType: 'preference' as any,
        preference: {
          conclusionDirectives: 'Old directive',
          conclusionDirectivesVector: null,
          metadata: {},
          scorePriority: 0.4,
          suggestions: null,
          tags: [],
          type: 'style',
        },
        summary: 'Old pref',
        title: 'Old pref',
      });

    const { memory: otherPrefParent, preference: otherPref } =
      await otherModel.createPreferenceMemory({
        details: 'Other user pref',
        memoryCategory: 'style',
        memoryLayer: LayersEnum.Preference,
        memoryType: 'preference' as any,
        preference: {
          conclusionDirectives: 'Other user directive',
          conclusionDirectivesVector: null,
          metadata: {},
          scorePriority: 0.9,
          suggestions: null,
          tags: [],
          type: 'style',
        },
        summary: 'Other user pref',
        title: 'Other user pref',
      });

    const { context: ownOldCtx, memory: ownOldCtxParent } = await ownModel.createContextMemory({
      context: {
        associatedObjects: null,
        associatedSubjects: null,
        currentStatus: 'ongoing',
        description: 'Old context',
        descriptionVector: null,
        metadata: {},
        scoreImpact: 0.5,
        scoreUrgency: 0.5,
        tags: [],
        title: 'Old context',
        type: 'project',
      },
      details: 'Old context',
      memoryCategory: 'work',
      memoryLayer: LayersEnum.Context,
      memoryType: 'context' as any,
      summary: 'Old context',
      title: 'Old context',
    });

    const { context: otherCtx } = await otherModel.createContextMemory({
      context: {
        associatedObjects: null,
        associatedSubjects: null,
        currentStatus: 'ongoing',
        description: 'Other context',
        descriptionVector: null,
        metadata: {},
        scoreImpact: 0.5,
        scoreUrgency: 0.5,
        tags: [],
        title: 'Other context',
        type: 'project',
      },
      details: 'Other context',
      memoryCategory: 'work',
      memoryLayer: LayersEnum.Context,
      memoryType: 'context' as any,
      summary: 'Other context',
      title: 'Other context',
    });

    const { experience: ownOldExp, memory: ownOldExpParent } =
      await ownModel.createExperienceMemory({
        details: 'Old exp',
        experience: {
          action: 'Old action',
          actionVector: null,
          keyLearning: 'Old learning',
          keyLearningVector: null,
          metadata: {},
          possibleOutcome: null,
          reasoning: null,
          scoreConfidence: 0.5,
          situation: 'Old sit',
          situationVector: null,
          tags: [],
          type: 'work',
        },
        memoryCategory: 'work',
        memoryLayer: LayersEnum.Experience,
        memoryType: 'activity' as any,
        summary: 'Old exp',
        title: 'Old exp',
      });

    const executor = await MemoryExtractionExecutor.create();
    const dummyEmbedRuntime = {
      embeddings: vi.fn().mockResolvedValue([]),
    } as any;
    const job = {
      source: MemorySourceType.ChatTopic,
      sourceId: 'tpc_1',
      sourceUpdatedAt: new Date(),
      userId,
    } as any;

    await executor.persistPreferenceMemories(
      job,
      ['msg_1'],
      {
        memories: [
          {
            details: 'Merged pref',
            memoryCategory: 'style',
            memoryType: 'preference',
            summary: 'Merged pref',
            // Includes own old pref (should delete), own pinned rule (MUST NOT delete), and other user's pref (MUST NOT delete)
            supersedeIds: [ownOldPref.id, pinnedRule.item.id, otherPref.id],
            tags: [],
            title: 'Merged pref',
            withPreference: {
              appContext: null,
              conclusionDirectives: 'Merged directive',
              extractedLabels: [],
              extractedScopes: [],
              originContext: null,
              scorePriority: 0.8,
              suggestions: [],
              type: 'RULE', // Must be sanitized to 'preference'
            },
          } as any,
        ],
      },
      dummyEmbedRuntime,
      'text-embedding-3-small',
      undefined,
      testDB,
    );

    await executor.persistContextMemories(
      job,
      ['msg_1'],
      {
        memories: [
          {
            details: 'Merged ctx',
            memoryCategory: 'work',
            memoryType: 'context',
            summary: 'Merged ctx',
            supersedeIds: [ownOldCtx.id, otherCtx.id],
            tags: [],
            title: 'Merged ctx',
            withContext: {
              associatedObjects: [],
              associatedSubjects: [],
              currentStatus: ContextStatusEnum.Ongoing,
              description: 'Merged ctx desc',
              labels: [],
              scoreImpact: 0.9,
              scoreUrgency: 0.7,
              title: 'Merged ctx',
              type: 'project',
            },
          } as any,
        ],
      },
      dummyEmbedRuntime,
      'text-embedding-3-small',
      undefined,
      testDB,
    );

    await executor.persistExperienceMemories(
      job,
      ['msg_1'],
      {
        memories: [
          {
            details: 'Merged exp',
            memoryCategory: 'work',
            memoryType: 'activity',
            summary: 'Merged exp',
            supersedeIds: [ownOldExp.id],
            tags: [],
            title: 'Merged exp',
            withExperience: {
              action: 'New action',
              keyLearning: 'New learning',
              knowledgeValueScore: 0.8,
              labels: [],
              possibleOutcome: 'Good',
              problemSolvingScore: 0.8,
              reasoning: 'Reason',
              scoreConfidence: 0.9,
              situation: 'New sit',
              type: 'work',
            },
          } as any,
        ],
      },
      dummyEmbedRuntime,
      'text-embedding-3-small',
      undefined,
      testDB,
    );

    // 1. Own superseded entries AND their parent user_memories rows are gone
    expect(
      await testDB.query.userMemoriesPreferences.findFirst({
        where: eq(userMemoriesPreferences.id, ownOldPref.id),
      }),
    ).toBeUndefined();
    expect(
      await testDB.query.userMemories.findFirst({
        where: eq(userMemories.id, ownOldPrefParent.id),
      }),
    ).toBeUndefined();
    expect(
      await testDB.query.userMemoriesContexts.findFirst({
        where: eq(userMemoriesContexts.id, ownOldCtx.id),
      }),
    ).toBeUndefined();
    expect(
      await testDB.query.userMemories.findFirst({
        where: eq(userMemories.id, ownOldCtxParent.id),
      }),
    ).toBeUndefined();
    expect(
      await testDB.query.userMemoriesExperiences.findFirst({
        where: eq(userMemoriesExperiences.id, ownOldExp.id),
      }),
    ).toBeUndefined();
    expect(
      await testDB.query.userMemories.findFirst({
        where: eq(userMemories.id, ownOldExpParent.id),
      }),
    ).toBeUndefined();

    // 2. Pinned rule is 100% untouched!
    const remainingRules = await prefModel.queryRules();
    expect(remainingRules).toHaveLength(1);
    expect(remainingRules[0].id).toBe(pinnedRule.item.id);

    // 3. Newly inserted preference was NOT stored with type='rule'!
    const ownPrefs = await testDB.query.userMemoriesPreferences.findMany({
      where: eq(userMemoriesPreferences.userId, userId),
    });
    const insertedMerged = ownPrefs.find((p) => p.conclusionDirectives === 'Merged directive');
    expect(insertedMerged).toBeDefined();
    expect(insertedMerged?.type).toBe('preference');

    // 4. Other user's entries are 100% untouched!
    expect(
      await testDB.query.userMemoriesPreferences.findFirst({
        where: eq(userMemoriesPreferences.id, otherPref.id),
      }),
    ).toBeDefined();
    expect(
      await testDB.query.userMemories.findFirst({
        where: eq(userMemories.id, otherPrefParent.id),
      }),
    ).toBeDefined();
    expect(
      await testDB.query.userMemoriesContexts.findFirst({
        where: eq(userMemoriesContexts.id, otherCtx.id),
      }),
    ).toBeDefined();
  });
});
