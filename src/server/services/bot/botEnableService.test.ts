import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setBotEnabled } from './botEnableService';

const findById = vi.fn();
const update = vi.fn();
const startClient = vi.fn();
const stopClient = vi.fn();
const invalidateBot = vi.fn();
const getBotRuntimeStatus = vi.fn();

vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: vi.fn().mockResolvedValue({}),
}));

vi.mock('@/database/models/agentBotProvider', () => ({
  AgentBotProviderModel: vi.fn().mockImplementation(() => ({ findById, update })),
}));

vi.mock('@/server/modules/KeyVaultsEncrypt', () => ({
  KeyVaultsGateKeeper: { initWithEnvKey: vi.fn().mockResolvedValue({}) },
}));

vi.mock('@/server/services/gateway', () => ({
  GatewayService: vi.fn().mockImplementation(() => ({ startClient, stopClient })),
}));

vi.mock('@/server/services/gateway/runtimeStatus', () => ({
  getBotRuntimeStatus: (...a: unknown[]) => getBotRuntimeStatus(...a),
}));

vi.mock('./BotMessageRouter', () => ({
  getBotMessageRouter: () => ({ invalidateBot }),
}));

const OWNER = 'user-1';
const BOT = 'bot-uuid-1';
const row = { applicationId: '8677993854', id: BOT, platform: 'telegram' };

beforeEach(() => {
  findById.mockReset();
  update.mockReset().mockResolvedValue(undefined);
  startClient.mockReset().mockResolvedValue('started');
  stopClient.mockReset().mockResolvedValue(undefined);
  invalidateBot.mockReset().mockResolvedValue(undefined);
  getBotRuntimeStatus.mockReset().mockResolvedValue({ status: 'connected' });
});

describe('setBotEnabled', () => {
  it('returns null for a foreign/missing bot WITHOUT touching the runtime (anti-IDOR)', async () => {
    findById.mockResolvedValue(undefined);

    const r = await setBotEnabled(OWNER, BOT, true);

    expect(r).toBeNull();
    expect(update).not.toHaveBeenCalled();
    expect(startClient).not.toHaveBeenCalled();
    expect(stopClient).not.toHaveBeenCalled();
    expect(invalidateBot).not.toHaveBeenCalled();
  });

  it('enable: persists enabled:true, starts client, invalidates cache, returns runtimeStatus', async () => {
    findById.mockResolvedValue(row);

    const r = await setBotEnabled(OWNER, BOT, true);

    expect(update).toHaveBeenCalledWith(BOT, { enabled: true });
    expect(startClient).toHaveBeenCalledWith('telegram', '8677993854', OWNER);
    expect(stopClient).not.toHaveBeenCalled();
    expect(invalidateBot).toHaveBeenCalledWith('telegram', '8677993854');
    expect(r).toEqual({
      applicationId: '8677993854',
      enabled: true,
      platform: 'telegram',
      runtimeStatus: 'connected',
    });
  });

  it('commit-then-register: update lands BEFORE startClient', async () => {
    findById.mockResolvedValue(row);
    const order: string[] = [];
    update.mockImplementation(async () => {
      order.push('update');
    });
    startClient.mockImplementation(async () => {
      order.push('startClient');
      return 'started';
    });

    await setBotEnabled(OWNER, BOT, true);

    expect(order).toEqual(['update', 'startClient']);
  });

  it('disable: persists enabled:false, stops client, invalidates cache, no startClient', async () => {
    findById.mockResolvedValue(row);
    getBotRuntimeStatus.mockResolvedValue({ status: 'disconnected' });

    const r = await setBotEnabled(OWNER, BOT, false);

    expect(update).toHaveBeenCalledWith(BOT, { enabled: false });
    expect(stopClient).toHaveBeenCalledWith('telegram', '8677993854');
    expect(startClient).not.toHaveBeenCalled();
    expect(invalidateBot).toHaveBeenCalledWith('telegram', '8677993854');
    expect(r?.enabled).toBe(false);
    expect(r?.runtimeStatus).toBe('disconnected');
  });
});
