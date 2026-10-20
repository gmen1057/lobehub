import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AUTO_EXTRACT_FAILED_KEY, runAutoExtract, runDailyDigest } from '../arckepAutoExtract';

// arckep (20.10.2026, автосбор памяти): разбор по одной теме, упавшая помечается и не мешает остальным,
// токены всех вызовов складываются в отчёт. Исполнитель движка и база подменены.

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  extractTopic: vi.fn(),
  extractUserDigest: vi.fn(),
  listener: undefined as undefined | ((usage: any) => void),
}));

vi.mock('../extract', () => ({
  MemoryExtractionExecutor: { create: mocks.create },
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
});
