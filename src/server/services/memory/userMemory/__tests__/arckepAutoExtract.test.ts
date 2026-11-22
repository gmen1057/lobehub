import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AUTO_EXTRACT_FAILED_KEY, runAutoExtract, runDailyDigest } from '../arckepAutoExtract';

// arckep (20.10.2026, автосбор памяти): разбор по одной теме, упавшая помечается и не мешает остальным,
// токены всех вызовов складываются в отчёт. Исполнитель движка и база подменены.

const mocks = vi.hoisted(() => ({
  buildUserPersonaJobInput: vi.fn(),
  composeWriting: vi.fn(),
  create: vi.fn(),
  extractTopic: vi.fn(),
  extractUserDigest: vi.fn(),
  getLatestPersonaDocument: vi.fn(),
  getUserSettings: vi.fn(),
  listener: undefined as undefined | ((usage: any) => void),
}));

vi.mock('../extract', () => ({
  MemoryExtractionExecutor: { create: mocks.create },
}));

vi.mock('../persona/service', () => ({
  UserPersonaService: vi.fn().mockImplementation(() => ({
    composeWriting: mocks.composeWriting,
  })),
  buildUserPersonaJobInput: mocks.buildUserPersonaJobInput,
}));

vi.mock('@/database/models/userMemory/persona', () => ({
  UserPersonaModel: vi.fn().mockImplementation(() => ({
    getLatestPersonaDocument: mocks.getLatestPersonaDocument,
  })),
}));

vi.mock('@/database/models/user', () => ({
  UserModel: vi.fn().mockImplementation(() => ({
    getUserSettings: mocks.getUserSettings,
  })),
}));

vi.mock('@/server/globalConfig/parseMemoryExtractionConfig', () => ({
  parseMemoryExtractionConfig: () => ({
    language: 'Russian',
    reasoningEffort: 'low',
    serviceTier: 'flex',
  }),
}));

const makeDb = (topicIds: string[]) => {
  const updates: Array<{ set: any; where: any }> = [];
  const db = {
    execute: vi.fn(async () => ({ rows: topicIds.map((id) => ({ id })) })),
    update: vi.fn(() => ({
      set: (set: any) => ({
        where: async (where: any) => {
          updates.push({ set, where });
        },
      }),
    })),
  };
  return { db: db as any, updates };
};

const OPTIONS = { days: 30, idleMinutes: 30, limit: 3 };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listener = undefined;
  mocks.create.mockResolvedValue({
    extractTopic: mocks.extractTopic,
    extractUserDigest: mocks.extractUserDigest,
    setUsageListener: (fn: any) => {
      mocks.listener = fn;
    },
  });
});

describe('runAutoExtract', () => {
  it('нет подходящих тем — исполнитель не создаётся', async () => {
    const { db } = makeDb([]);
    const result = await runAutoExtract(db, 'user-1', OPTIONS);
    expect(result).toMatchObject({ extracted: 0, failed: 0, memories: 0, topics: 0 });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('по одной теме; упавшая помечается, остальные разбираются; токены складываются', async () => {
    const { db, updates } = makeDb(['tpc_ok', 'tpc_bad', 'tpc_empty']);
    mocks.extractTopic.mockImplementation(async ({ topicId }: { topicId: string }) => {
      mocks.listener?.({
        outputReasoningTokens: 100,
        totalInputTokens: 1000,
        totalOutputTokens: 300,
      });
      if (topicId === 'tpc_bad') throw new Error('model 500');
      if (topicId === 'tpc_empty') return { extracted: false, memoryIds: [] };
      return { extracted: true, memoryIds: ['m1', 'm2'] };
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runAutoExtract(db, 'user-1', OPTIONS);

    expect(result).toEqual({
      extracted: 1,
      failed: 1,
      memories: 2,
      topics: 3,
      usage: {
        calls: 3,
        inputCachedTokens: 0,
        inputTokens: 3000,
        outputReasoningTokens: 300,
        outputTokens: 900,
      },
    });
    expect(mocks.extractTopic).toHaveBeenCalledTimes(3);
    expect(mocks.extractTopic).toHaveBeenCalledWith(
      expect.objectContaining({
        forceTopics: true,
        layers: [],
        topicId: 'tpc_ok',
        userId: 'user-1',
      }),
    );
    // помечена только упавшая тема — ключом, по которому отбор пропускает её сутки
    expect(updates).toHaveLength(1);
    const params = updates[0].set.metadata.queryChunks.filter(
      (chunk: unknown) => typeof chunk === 'string',
    );
    expect(params.some((param: string) => param.includes(AUTO_EXTRACT_FAILED_KEY))).toBe(true);
    errorSpy.mockRestore();
  });
});

describe('runDailyDigest (суточный разбор)', () => {
  const DIGEST = {
    contextLimit: 60_000,
    days: 30,
    idleMinutes: 60,
    maxMemories: 300,
    maxTopics: 50,
  };

  const digestDb = (rows: { after: string | null; id: string }[]) => {
    const updates: Array<{ set: any }> = [];
    const db = {
      execute: vi.fn(async () => ({ rows })),
      update: vi.fn(() => ({
        set: (set: any) => ({
          where: async () => {
            updates.push({ set });
          },
        }),
      })),
    };
    return { db: db as any, updates };
  };

  it('новых тем нет — модель не зовётся', async () => {
    const { db } = digestDb([]);
    const result = await runDailyDigest(db, 'user-1', DIGEST);
    expect(result.topics).toBe(0);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('все новые темы — одним разбором; у продолженной — курсор прошлого разбора; токены в отчёт', async () => {
    const { db } = digestDb([
      { after: null, id: 'tpc_new' },
      { after: '2026-10-19T10:00:00.000Z', id: 'tpc_continued' },
    ]);
    mocks.extractUserDigest.mockImplementation(async () => {
      mocks.listener?.({
        inputCachedTokens: 9000,
        totalInputTokens: 12_000,
        totalOutputTokens: 400,
      });
      return {
        extracted: true,
        memoryIds: ['m1', 'm2'],
        serviceTier: 'flex',
        topicIds: ['tpc_new', 'tpc_continued'],
      };
    });

    const result = await runDailyDigest(db, 'user-1', DIGEST);

    expect(mocks.extractUserDigest).toHaveBeenCalledTimes(1);
    expect(mocks.extractUserDigest).toHaveBeenCalledWith({
      contextLimit: 60_000,
      maxMemories: 300,
      topics: [
        { after: undefined, topicId: 'tpc_new' },
        { after: new Date('2026-10-19T10:00:00.000Z'), topicId: 'tpc_continued' },
      ],
      userId: 'user-1',
    });
    expect(result).toMatchObject({ extracted: 2, failed: 0, memories: 2, topics: 2 });
    expect(result.usage).toMatchObject({
      calls: 1,
      inputCachedTokens: 9000,
      inputTokens: 12_000,
      serviceTier: 'flex',
    });
  });

  it('разбор упал — включённые темы помечены, чтобы следующий ночной запуск их повторил', async () => {
    const { db, updates } = digestDb([{ after: null, id: 'tpc_a' }]);
    mocks.extractUserDigest.mockResolvedValue({
      error: 'model 500',
      extracted: false,
      memoryIds: [],
      topicIds: ['tpc_a'],
    });

    const result = await runDailyDigest(db, 'user-1', DIGEST);

    expect(result).toMatchObject({ extracted: 0, failed: 1, topics: 1 });
    expect(updates).toHaveLength(1);
    const params = updates[0].set.metadata.queryChunks.filter(
      (chunk: unknown) => typeof chunk === 'string',
    );
    expect(params.some((param: string) => param.includes(AUTO_EXTRACT_FAILED_KEY))).toBe(true);
  });

  it('обновляет persona при >=5 воспоминаний (если персоны нет или >=7 суток), включает observeDigestCalls:true и считает callsBreakdown', async () => {
    let callIdx = 0;
    const db = {
      execute: vi.fn(async () => {
        callIdx += 1;
        if (callIdx === 1) return { rows: [{ after: null, id: 'tpc_1' }] };
        return { rows: [{ total: 6 }] };
      }),
      update: vi.fn(),
    } as any;

    mocks.getLatestPersonaDocument.mockResolvedValue({
      persona: 'Old persona',
      updatedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
    });
    mocks.buildUserPersonaJobInput.mockResolvedValue({
      existingPersona: 'Old persona',
      memoryIds: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'],
      retrievedMemories: '<memories />',
    });
    mocks.extractUserDigest.mockImplementation(async () => {
      mocks.listener?.({
        inputCachedTokens: 8000,
        outputReasoningTokens: 50,
        totalInputTokens: 10_000,
        totalOutputTokens: 300,
      });
      return {
        extracted: true,
        memoryIds: ['m6'],
        serviceTier: 'flex',
        topicIds: ['tpc_1'],
      };
    });
    mocks.composeWriting.mockImplementation(async (_payload: any, opts: any) => {
      opts.onUsage?.(
        {
          inputCachedTokens: 1000,
          outputReasoningTokens: 20,
          totalInputTokens: 2500,
          totalOutputTokens: 200,
        },
        { serviceTier: 'default' }, // Simulate persona fallback from flex -> default on 429
      );
      return { document: { persona: 'New persona' } };
    });

    const result = await runDailyDigest(db, 'user-1', DIGEST);

    expect(mocks.composeWriting).toHaveBeenCalledTimes(1);
    expect(mocks.composeWriting).toHaveBeenCalledWith(
      expect.objectContaining({
        existingPersona: 'Old persona',
        language: 'Russian',
        sourceIds: ['tpc_1'],
        userId: 'user-1',
      }),
      expect.objectContaining({
        observeDigestCalls: true,
        reasoningEffort: 'low',
        serviceTier: 'flex',
      }),
    );

    // Mixed flex + default -> top-level serviceTier MUST be 'default', while callsBreakdown keeps per-call tiers!
    expect(result.usage).toEqual({
      calls: 2,
      callsBreakdown: [
        {
          inputCachedTokens: 8000,
          inputTokens: 10_000,
          outputReasoningTokens: 50,
          outputTokens: 300,
          serviceTier: 'flex',
        },
        {
          inputCachedTokens: 1000,
          inputTokens: 2500,
          outputReasoningTokens: 20,
          outputTokens: 200,
          serviceTier: 'default',
        },
      ],
      inputCachedTokens: 9000,
      inputTokens: 12_500,
      outputReasoningTokens: 70,
      outputTokens: 500,
      serviceTier: 'default',
    });
  });

  it('сбой persona не помечает уже разобранные темы дайджеста как failed и сохраняет usage', async () => {
    let callIdx = 0;
    const { updates } = digestDb([]);
    const db = {
      execute: vi.fn(async () => {
        callIdx += 1;
        if (callIdx === 1) return { rows: [{ after: null, id: 'tpc_ok' }] };
        return { rows: [{ total: 10 }] };
      }),
      update: vi.fn(() => ({
        set: (set: any) => ({
          where: async () => {
            updates.push({ set });
          },
        }),
      })),
    } as any;

    mocks.getLatestPersonaDocument.mockResolvedValue(null);
    mocks.buildUserPersonaJobInput.mockResolvedValue({ retrievedMemories: 'ctx' });
    mocks.extractUserDigest.mockImplementation(async () => {
      mocks.listener?.({ totalInputTokens: 5000, totalOutputTokens: 200 });
      return {
        extracted: true,
        memoryIds: ['m1'],
        serviceTier: 'flex',
        topicIds: ['tpc_ok'],
      };
    });
    mocks.composeWriting.mockRejectedValue(new Error('OpenAI timeout on persona'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runDailyDigest(db, 'user-1', DIGEST);

    expect(result).toMatchObject({ extracted: 1, failed: 0, memories: 1, topics: 1 });
    expect(result.usage.serviceTier).toBe('flex');
    expect(result.usage.calls).toBe(1);
    expect(updates).toHaveLength(0);
    errSpy.mockRestore();
  });
});
