import { beforeEach, describe, expect, it, vi } from 'vitest';

import { parseRedeemCode, redeemCode } from './botAccessCodeService';

// Mock BotEndUserModel
const upsertActive = vi.fn();
vi.mock('@/database/models/botEndUser', () => ({
  BotEndUserModel: vi.fn().mockImplementation(() => ({
    upsertActive,
  })),
}));

// Mock BotAccessCodeModel
const consumeCode = vi.fn();
vi.mock('@/database/models/botAccessCode', () => ({
  BotAccessCodeModel: vi.fn().mockImplementation(() => ({
    consumeCode,
  })),
}));

beforeEach(() => {
  upsertActive.mockReset();
  consumeCode.mockReset();
});

const base = {
  botProviderId: 'bot-1',
  code: 'ABCD1234',
  endUserId: '999',
  endUserUsername: 'testuser',
  platform: 'telegram',
  db: {} as any,
};

describe('parseRedeemCode', () => {
  it('parses /start <code>', () => {
    expect(parseRedeemCode('/start ABCDEFGH')).toBe('ABCDEFGH');
  });

  it('parses /redeem <code>', () => {
    expect(parseRedeemCode('/redeem XYZ12345')).toBe('XYZ12345');
  });

  it('parses /start with extra spaces', () => {
    expect(parseRedeemCode('/start   CODE123  ')).toBe('CODE123');
  });

  it('returns null for plain text', () => {
    expect(parseRedeemCode('hello world')).toBeNull();
  });

  it('returns null for empty /start', () => {
    expect(parseRedeemCode('/start ')).toBeNull();
  });

  it('returns null for null/undefined', () => {
    expect(parseRedeemCode(null)).toBeNull();
    expect(parseRedeemCode(undefined)).toBeNull();
  });
});

describe('redeemCode', () => {
  it('returns ok:true on successful consume', async () => {
    consumeCode.mockResolvedValue({ id: 'code-1', code: 'ABCD1234', quotaMessages: 50 });
    upsertActive.mockResolvedValue({ id: 'eu-1' });

    const result = await redeemCode(base);

    expect(result.ok).toBe(true);
    expect(result.message).toBe('Доступ активирован!');
    // Atomically consumed
    expect(consumeCode).toHaveBeenCalledWith('bot-1', 'ABCD1234', '999');
    // End user upserted with code's quota
    expect(upsertActive).toHaveBeenCalledWith({
      botProviderId: 'bot-1',
      endUserId: '999',
      endUserUsername: 'testuser',
      platform: 'telegram',
      quotaMessages: 50,
    });
  });

  it('returns ok:false when code is already consumed', async () => {
    consumeCode.mockResolvedValue(undefined); // no row returned = code consumed/invalid

    const result = await redeemCode(base);

    expect(result.ok).toBe(false);
    expect(result.message).toBeTruthy();
    // upsertActive must NOT be called on failed redeem
    expect(upsertActive).not.toHaveBeenCalled();
  });

  it('returns ok:false for non-existent code', async () => {
    consumeCode.mockResolvedValue(undefined);

    const result = await redeemCode({ ...base, code: 'INVALID' });

    expect(result.ok).toBe(false);
    expect(consumeCode).toHaveBeenCalledWith('bot-1', 'INVALID', '999');
  });
});

describe('redeemCode — single-use under concurrency', () => {
  it('exactly one concurrent redeem wins', async () => {
    // First call wins
    consumeCode
      .mockResolvedValueOnce({ id: 'code-1', code: 'ABCD1234', quotaMessages: null })
      // Second call loses — consumed_at already set
      .mockResolvedValueOnce(undefined);

    upsertActive.mockResolvedValue({ id: 'eu-1' });

    const [r1, r2] = await Promise.all([redeemCode(base), redeemCode(base)]);

    // Exactly one ok:true
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(false);
    // consumeCode called twice — the UPDATE WHERE consumed_at IS NULL is the arbiter
    expect(consumeCode).toHaveBeenCalledTimes(2);
    // upsertActive called exactly once (for the winning call)
    expect(upsertActive).toHaveBeenCalledTimes(1);
  });

  it('repeat redeem of same code returns ok:false', async () => {
    // First redeem succeeds
    consumeCode.mockResolvedValueOnce({ id: 'code-1', code: 'ABCD1234', quotaMessages: 100 });
    upsertActive.mockResolvedValue({ id: 'eu-1' });

    const r1 = await redeemCode(base);
    expect(r1.ok).toBe(true);

    // Second redeem — code already consumed
    consumeCode.mockResolvedValue(undefined);
    const r2 = await redeemCode(base);
    expect(r2.ok).toBe(false);
  });
});
