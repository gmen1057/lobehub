import { beforeEach, describe, expect, it, vi } from 'vitest';

import { checkBotAccess } from './botAccessGate';

const findByProviderAndEndUser = vi.fn();
const findOrCreate = vi.fn();

vi.mock('@/database/models/botEndUser', () => ({
  BotEndUserModel: vi.fn().mockImplementation(() => ({
    findByProviderAndEndUser,
    findOrCreate,
  })),
}));

const base = {
  botProviderId: 'bot-1',
  db: {} as any,
  endUserId: '999',
  platform: 'telegram',
};

const activeRow = { id: 'row-1', messagesUsed: 0, quotaMessages: null, status: 'active' };

beforeEach(() => {
  findByProviderAndEndUser.mockReset();
  findOrCreate.mockReset();
});

describe('checkBotAccess', () => {
  it('always allows the owner, without touching the DB', async () => {
    const d = await checkBotAccess({ ...base, endUserId: '777', ownerPlatformUserId: '777' });
    expect(d.allow).toBe(true);
    expect(d.reason).toBe('owner');
    expect(findByProviderAndEndUser).not.toHaveBeenCalled();
    expect(findOrCreate).not.toHaveBeenCalled();
  });

  it('denies a non-owner when policy = disabled', async () => {
    const d = await checkBotAccess({ ...base, policy: 'disabled' });
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('disabled');
    expect(d.message).toBeTruthy();
  });

  it('open: lazy-creates and allows, returns the row id for usage increment', async () => {
    findOrCreate.mockResolvedValue(activeRow);
    const d = await checkBotAccess({ ...base, policy: 'open' });
    expect(d.allow).toBe(true);
    expect(d.reason).toBe('open');
    expect(d.endUserRowId).toBe('row-1');
    expect(findOrCreate).toHaveBeenCalledTimes(1);
  });

  it('allowlist (default): denies an end-user with no row', async () => {
    findByProviderAndEndUser.mockResolvedValue(undefined);
    const d = await checkBotAccess({ ...base }); // policy undefined ⇒ allowlist (owner-only)
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('not_allowlisted');
    expect(findOrCreate).not.toHaveBeenCalled(); // allowlist must NOT lazy-create
  });

  it('allowlist: allows an active under-quota row', async () => {
    findByProviderAndEndUser.mockResolvedValue({
      ...activeRow,
      messagesUsed: 5,
      quotaMessages: 10,
    });
    const d = await checkBotAccess({ ...base, policy: 'allowlist' });
    expect(d.allow).toBe(true);
    expect(d.reason).toBe('allowlisted');
    expect(d.endUserRowId).toBe('row-1');
  });

  it('denies a suspended user', async () => {
    findByProviderAndEndUser.mockResolvedValue({ ...activeRow, status: 'suspended' });
    const d = await checkBotAccess({ ...base, policy: 'allowlist' });
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('suspended');
  });

  it('denies when the message quota is exhausted', async () => {
    findByProviderAndEndUser.mockResolvedValue({
      ...activeRow,
      messagesUsed: 10,
      quotaMessages: 10,
    });
    const d = await checkBotAccess({ ...base, policy: 'allowlist' });
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('quota_exhausted');
  });

  it('FAILS OPEN when the DB throws (never block real users on infra blips)', async () => {
    findByProviderAndEndUser.mockRejectedValue(new Error('db down'));
    const d = await checkBotAccess({ ...base, policy: 'allowlist' });
    expect(d.allow).toBe(true);
    expect(d.reason).toBe('fail_open');
  });
});
