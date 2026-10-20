import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AUTO_EXTRACT_FAILED_KEY, runAutoExtract } from '../arckepAutoExtract';

// arckep (20.10.2026, автосбор памяти): разбор по одной теме, упавшая помечается и не мешает остальным,
// токены всех вызовов складываются в отчёт. Исполнитель движка и база подменены.

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  extractTopic: vi.fn(),
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
