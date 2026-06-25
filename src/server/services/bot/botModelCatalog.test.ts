import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// botModelCatalog keeps a module-level TTL cache, so each test loads a fresh
// module instance (vi.resetModules + dynamic import) to isolate cache state.

const loadModule = () => import('./botModelCatalog');

const mockFetch = (ids: string[], opts: { ok?: boolean; status?: number } = {}) => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    json: async () => ({ data: ids.map((id) => ({ id })) }),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchValidModelIds', () => {
  it('returns the set of catalog ids', async () => {
    mockFetch(['deepseek/deepseek-v4-pro', 'anthropic/claude-sonnet-4']);
    const { fetchValidModelIds } = await loadModule();
    const ids = await fetchValidModelIds();
    expect(ids.has('deepseek/deepseek-v4-pro')).toBe(true);
    expect(ids.has('anthropic/claude-sonnet-4')).toBe(true);
    expect(ids.size).toBe(2);
  });

  it('caches within TTL — a second call does not refetch', async () => {
    const fetchMock = mockFetch(['x/y']);
    const { fetchValidModelIds } = await loadModule();
    await fetchValidModelIds();
    await fetchValidModelIds();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws on a non-ok HTTP response', async () => {
    mockFetch([], { ok: false, status: 500 });
    const { fetchValidModelIds } = await loadModule();
    await expect(fetchValidModelIds()).rejects.toThrow(/HTTP 500/);
  });
});

describe('assertModelValid', () => {
  it('accepts a model present in the catalog', async () => {
    mockFetch(['deepseek/deepseek-v4-pro']);
    const { assertModelValid } = await loadModule();
    expect(await assertModelValid('deepseek', 'deepseek-v4-pro')).toEqual({ ok: true });
  });

  it('rejects an unknown model and lists same-provider alternatives', async () => {
    mockFetch([
      'deepseek/deepseek-v4-pro',
      'deepseek/deepseek-v4-flash',
      'anthropic/claude-sonnet-4',
    ]);
    const { assertModelValid } = await loadModule();
    const r = await assertModelValid('deepseek', 'deepseek-chat');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toMatch(/недоступна/);
      expect(r.message).toContain('deepseek/deepseek-v4-pro');
      expect(r.message).toContain('deepseek/deepseek-v4-flash');
      // provider-filtered: a foreign provider's model is not suggested
      expect(r.message).not.toContain('anthropic/claude-sonnet-4');
    }
  });

  it('falls back to the first models when the provider has no matches', async () => {
    mockFetch(['anthropic/claude-sonnet-4', 'openai/gpt-x']);
    const { assertModelValid } = await loadModule();
    const r = await assertModelValid('nosuchprovider', 'foo');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('anthropic/claude-sonnet-4');
  });

  it('fails closed when the catalog is unavailable', async () => {
    mockFetch([], { ok: false, status: 503 });
    const { assertModelValid } = await loadModule();
    const r = await assertModelValid('deepseek', 'anything');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('каталог недоступен');
  });
});
