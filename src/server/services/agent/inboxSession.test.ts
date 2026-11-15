// @vitest-environment node
import { DEFAULT_AGENT_CONFIG } from '@lobechat/const';
import { describe, expect, it, vi } from 'vitest';

import { SessionModel } from '@/database/models/session';

import { defaultInboxPlugins } from './inboxPlugins';

describe('creation-only inbox persistence', () => {
  it('includes the full selection at creation despite the nonempty builtin seed', async () => {
    const db = { query: { sessions: { findFirst: vi.fn().mockResolvedValue(undefined) } } };
    const model = new SessionModel(db as never, 'owner');
    const create = vi.spyOn(model, 'create').mockResolvedValue({ id: 'new-inbox' } as never);
    await model.createInbox({ plugins: defaultInboxPlugins() });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: 'inbox',
        config: expect.objectContaining({
          plugins: expect.arrayContaining([
            ...(DEFAULT_AGENT_CONFIG.plugins ?? []),
            'mcp-arckep-studio-images',
            'mcp-arckep-studio-documents',
            'mcp-arckep-e2b-sandbox',
          ]),
        }),
      }),
    );
  });

  it('leaves an existing inbox and its custom or disabled plugin choices untouched', async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: 'existing', plugins: ['custom-tool'] });
    const model = new SessionModel({ query: { sessions: { findFirst } } } as never, 'owner');
    const create = vi.spyOn(model, 'create');
    await model.createInbox({ plugins: defaultInboxPlugins() });
    expect(create).not.toHaveBeenCalled();
  });

  it('respects an explicit empty initial selection', async () => {
    const model = new SessionModel(
      { query: { sessions: { findFirst: vi.fn() } } } as never,
      'owner',
    );
    const create = vi.spyOn(model, 'create').mockResolvedValue({ id: 'new-inbox' } as never);
    await model.createInbox({ plugins: [] });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ config: expect.objectContaining({ plugins: [] }) }),
    );
  });

  it.each([false, true])(
    'accepts the concurrent unique-slug winner (wrapped error %j) without updating it',
    async (wrapped) => {
      const findFirst = vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ id: 'winner' });
      const model = new SessionModel({ query: { sessions: { findFirst } } } as never, 'owner');
      const duplicate = { code: '23505', constraint: 'slug_user_id_unique' };
      const create = vi
        .spyOn(model, 'create')
        .mockRejectedValue(wrapped ? { cause: duplicate } : duplicate);
      await expect(model.createInbox({ plugins: defaultInboxPlugins() })).resolves.toBeUndefined();
      expect(create).toHaveBeenCalledTimes(1);
      expect(findFirst).toHaveBeenCalledTimes(2);
    },
  );

  it('does not swallow unrelated conflicts or a missing concurrent winner', async () => {
    const model = new SessionModel(
      { query: { sessions: { findFirst: vi.fn() } } } as never,
      'owner',
    );
    const create = vi.spyOn(model, 'create');
    const unrelated = { code: '23505', constraint: 'other_constraint' };
    create.mockRejectedValueOnce(unrelated);
    await expect(model.createInbox({})).rejects.toBe(unrelated);
    const noWinner = { code: '23505', constraint: 'slug_user_id_unique' };
    create.mockRejectedValueOnce(noWinner);
    await expect(model.createInbox({})).rejects.toBe(noWinner);
  });
});
