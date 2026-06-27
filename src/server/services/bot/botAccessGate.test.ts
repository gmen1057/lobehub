import { beforeEach, describe, expect, it, vi } from 'vitest';

import { checkBotAccess } from './botAccessGate';

const findByProviderAndEndUser = vi.fn();
const findOrCreate = vi.fn();
const findByProviderAndUsername = vi.fn();
const bindNumericId = vi.fn();
const createPending = vi.fn();
const deleteById = vi.fn();
const tryConsumeQuota = vi.fn();

vi.mock('@/database/models/botEndUser', () => ({
  BotEndUserModel: vi.fn().mockImplementation(() => ({
    findByProviderAndEndUser,
    findOrCreate,
    findByProviderAndUsername,
    bindNumericId,
    createPending,
    deleteById,
    tryConsumeQuota,
  })),
}));

const base = {
  botProviderId: 'bot-1',
  db: {} as any,
  endUserId: '999',
  platform: 'telegram',
};

const activeRow = { id: 'row-1', messagesUsed: 0, quotaMessages: null, status: 'active' };
const sentinelRow = { id: 'row-uname-1', messagesUsed: 0, quotaMessages: null, status: 'active' };
const pendingRow = { id: 'row-pending-1', messagesUsed: 0, quotaMessages: null, status: 'pending' };

beforeEach(() => {
  findByProviderAndEndUser.mockReset();
  findOrCreate.mockReset();
  findByProviderAndUsername.mockReset();
  bindNumericId.mockReset();
  createPending.mockReset();
  deleteById.mockReset();
  tryConsumeQuota.mockReset();
  // Default: quota available — a unit is consumed and the message proceeds.
  tryConsumeQuota.mockResolvedValue(true);
});

describe('checkBotAccess', () => {
  // ── Existing invariants (untouched) ──────────────────────────────────────

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

  it('allowlist: allows an active under-quota row (consumes one quota unit)', async () => {
    findByProviderAndEndUser.mockResolvedValue({
      ...activeRow,
      messagesUsed: 5,
      quotaMessages: 10,
    });
    const d = await checkBotAccess({ ...base, policy: 'allowlist' });
    expect(d.allow).toBe(true);
    expect(d.reason).toBe('allowlisted');
    expect(d.endUserRowId).toBe('row-1');
    // Quota consumed atomically at the allow decision.
    expect(tryConsumeQuota).toHaveBeenCalledWith('row-1');
  });

  it('denies a suspended user WITHOUT consuming quota', async () => {
    findByProviderAndEndUser.mockResolvedValue({ ...activeRow, status: 'suspended' });
    const d = await checkBotAccess({ ...base, policy: 'allowlist' });
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('suspended');
    expect(tryConsumeQuota).not.toHaveBeenCalled();
  });

  it('denies a revoked user WITHOUT consuming quota', async () => {
    findByProviderAndEndUser.mockResolvedValue({ ...activeRow, status: 'revoked' });
    const d = await checkBotAccess({ ...base, policy: 'allowlist' });
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('suspended');
    expect(tryConsumeQuota).not.toHaveBeenCalled();
  });

  it('denies when the quota is exhausted (atomic consume returns false)', async () => {
    findByProviderAndEndUser.mockResolvedValue({ ...activeRow });
    tryConsumeQuota.mockResolvedValue(false);
    const d = await checkBotAccess({ ...base, policy: 'allowlist' });
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('quota_exhausted');
    expect(tryConsumeQuota).toHaveBeenCalledWith('row-1');
  });

  it('FAILS OPEN when the DB throws (never block real users on infra blips)', async () => {
    findByProviderAndEndUser.mockRejectedValue(new Error('db down'));
    const d = await checkBotAccess({ ...base, policy: 'allowlist' });
    expect(d.allow).toBe(true);
    expect(d.reason).toBe('fail_open');
  });

  // ── BRIEF-08 Part A: username match + backfill ───────────────────────────

  it('allowlist: id-miss + uname-row → ALLOW + backfill numeric id', async () => {
    // No numeric-id row
    findByProviderAndEndUser.mockResolvedValue(undefined);
    // Sentinel row exists
    findByProviderAndUsername.mockResolvedValue(sentinelRow);
    // bind succeeds
    bindNumericId.mockResolvedValue({ ...sentinelRow, endUserId: '999' });

    const d = await checkBotAccess({
      ...base,
      policy: 'allowlist',
      endUserUsername: 'SomeUser',
    });

    expect(d.allow).toBe(true);
    expect(d.reason).toBe('uname_match');
    expect(d.endUserRowId).toBe('row-uname-1');
    // Backfill was called with correct args
    expect(bindNumericId).toHaveBeenCalledWith('row-uname-1', 'bot-1', '999');
    // Normalised: lowercased, @ stripped
    expect(findByProviderAndUsername).toHaveBeenCalledWith('bot-1', 'uname:someuser');
  });

  it('allowlist: after backfill, next message matches by numeric id', async () => {
    // Row now exists by numeric id
    findByProviderAndEndUser.mockResolvedValue({ ...activeRow, endUserId: '999' });

    const d = await checkBotAccess({ ...base, policy: 'allowlist' });

    expect(d.allow).toBe(true);
    expect(d.reason).toBe('allowlisted');
    // No username lookup needed
    expect(findByProviderAndUsername).not.toHaveBeenCalled();
  });

  it('allowlist: bind collision — delete sentinel, use existing id-row', async () => {
    // No numeric-id row initially
    findByProviderAndEndUser
      .mockResolvedValueOnce(undefined) // first call: miss
      .mockResolvedValueOnce(activeRow); // after delete: id-row found
    findByProviderAndUsername.mockResolvedValue(sentinelRow);
    // bind throws UNIQUE violation
    bindNumericId.mockRejectedValue(new Error('duplicate key'));

    const d = await checkBotAccess({
      ...base,
      policy: 'allowlist',
      endUserUsername: 'CollisionUser',
    });

    expect(d.allow).toBe(true);
    expect(d.reason).toBe('allowlisted');
    // Sentinel was deleted
    expect(deleteById).toHaveBeenCalledWith('row-uname-1');
    // bind was attempted
    expect(bindNumericId).toHaveBeenCalled();
  });

  it('allowlist: no username on message → uname match skipped, pending created', async () => {
    findByProviderAndEndUser.mockResolvedValue(undefined);
    createPending.mockResolvedValue(pendingRow);

    const d = await checkBotAccess({
      ...base,
      policy: 'allowlist',
      endUserUsername: null, // no @nick
    });

    expect(d.allow).toBe(false);
    expect(d.reason).toBe('pending');
    expect(createPending).toHaveBeenCalledWith({
      botProviderId: 'bot-1',
      endUserId: '999',
      endUserUsername: null,
      platform: 'telegram',
    });
    // Username lookup never called
    expect(findByProviderAndUsername).not.toHaveBeenCalled();
  });

  it('allowlist: miss by id AND miss by username → pending created + deny', async () => {
    findByProviderAndEndUser.mockResolvedValue(undefined);
    findByProviderAndUsername.mockResolvedValue(undefined);
    createPending.mockResolvedValue(pendingRow);

    const d = await checkBotAccess({
      ...base,
      policy: 'allowlist',
      endUserUsername: 'StrangerUser',
    });

    expect(d.allow).toBe(false);
    expect(d.reason).toBe('pending');
    expect(d.message).toBeTruthy();
    expect(createPending).toHaveBeenCalledWith({
      botProviderId: 'bot-1',
      endUserId: '999',
      endUserUsername: 'StrangerUser',
      platform: 'telegram',
    });
  });

  it('allowlist: pending row → deny (not allowed until approved)', async () => {
    findByProviderAndEndUser.mockResolvedValue(pendingRow);

    const d = await checkBotAccess({ ...base, policy: 'allowlist' });

    expect(d.allow).toBe(false);
    expect(d.reason).toBe('pending');
    expect(d.message).toBeTruthy();
  });

  it('allowlist: username with leading @ is stripped correctly', async () => {
    findByProviderAndEndUser.mockResolvedValue(undefined);
    findByProviderAndUsername.mockResolvedValue(sentinelRow);
    bindNumericId.mockResolvedValue({ ...sentinelRow, endUserId: '999' });

    const d = await checkBotAccess({
      ...base,
      policy: 'allowlist',
      endUserUsername: '@TeStUsEr',
    });

    expect(d.allow).toBe(true);
    expect(d.reason).toBe('uname_match');
    // Normalised to 'testuser'
    expect(findByProviderAndUsername).toHaveBeenCalledWith('bot-1', 'uname:testuser');
  });

  it('open policy remains untouched by username matching', async () => {
    findOrCreate.mockResolvedValue(activeRow);
    const d = await checkBotAccess({ ...base, policy: 'open' });
    expect(d.allow).toBe(true);
    expect(d.reason).toBe('open');
    expect(findByProviderAndUsername).not.toHaveBeenCalled();
  });

  // ── Unit: normalizeUsername ──────────────────────────────────────────────

  it('normalizeUsername: strips @ and lowercases', async () => {
    const { normalizeUsername } = await import('./botAccessGate');
    expect(normalizeUsername('@TestBot')).toBe('testbot');
    expect(normalizeUsername('testbot')).toBe('testbot');
    expect(normalizeUsername('  @FooBar  ')).toBe('foobar');
    expect(normalizeUsername(null)).toBeNull();
    expect(normalizeUsername(undefined)).toBeNull();
    expect(normalizeUsername('')).toBeNull();
  });
});
