import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setAccessRule, setCommands, setGreeting, setModel } from './botMutationService';

const findById = vi.fn();
const update = vi.fn();
const invalidateBot = vi.fn();
const agentUpdate = vi.fn();

vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: vi.fn().mockResolvedValue({}),
}));

vi.mock('@/database/models/agentBotProvider', () => ({
  AgentBotProviderModel: vi.fn().mockImplementation(() => ({ findById, update })),
}));

vi.mock('@/database/models/agent', () => ({
  AgentModel: vi.fn().mockImplementation(() => ({ update: agentUpdate })),
}));

vi.mock('@/server/modules/KeyVaultsEncrypt', () => ({
  KeyVaultsGateKeeper: { initWithEnvKey: vi.fn().mockResolvedValue({}) },
}));

vi.mock('./BotMessageRouter', () => ({
  getBotMessageRouter: () => ({ invalidateBot }),
}));

const { assertModelValid } = vi.hoisted(() => ({
  assertModelValid: vi.fn(),
}));
vi.mock('./botModelCatalog', () => ({ assertModelValid }));

const OWNER = 'user-1';
const BOT = 'bot-uuid-1';
const row = {
  agentId: 'agent-1',
  applicationId: '8677993854',
  id: BOT,
  platform: 'telegram',
  settings: { greeting: 'old greeting' },
};

beforeEach(() => {
  findById.mockReset();
  update.mockReset().mockResolvedValue(undefined);
  invalidateBot.mockReset().mockResolvedValue(undefined);
  agentUpdate.mockReset().mockResolvedValue(undefined);
  assertModelValid.mockReset();
});

describe('setGreeting', () => {
  it('merges greeting into settings (does not overwrite other fields)', async () => {
    findById.mockResolvedValue(row);
    await setGreeting(OWNER, BOT, 'New greeting', {});
    expect(update).toHaveBeenCalledWith(BOT, {
      settings: { greeting: 'New greeting' },
    });
    expect(invalidateBot).toHaveBeenCalledWith('telegram', '8677993854');
  });

  it('returns null for foreign bot', async () => {
    findById.mockResolvedValue(undefined);
    const r = await setGreeting(OWNER, BOT, 'Does not matter', {});
    expect(r).toBeNull();
    expect(update).not.toHaveBeenCalled();
    expect(invalidateBot).not.toHaveBeenCalled();
  });
});

describe('setCommands', () => {
  it('merges customCommands into settings', async () => {
    findById.mockResolvedValue({ ...row, settings: { greeting: 'hi' } });
    await setCommands(
      OWNER,
      BOT,
      [{ description: 'Price list', name: 'price', response: '100₽' }],
      {},
    );
    expect(update).toHaveBeenCalledWith(BOT, {
      settings: {
        greeting: 'hi',
        customCommands: [{ description: 'Price list', name: 'price', response: '100₽' }],
      },
    });
    expect(invalidateBot).toHaveBeenCalledWith('telegram', '8677993854');
  });

  it('returns null for foreign bot', async () => {
    findById.mockResolvedValue(undefined);
    const r = await setCommands(OWNER, BOT, [], {});
    expect(r).toBeNull();
  });
});

describe('setAccessRule', () => {
  it('merges dm.policy and charLimit into settings', async () => {
    findById.mockResolvedValue({ ...row, settings: { greeting: 'hi' } });
    await setAccessRule(OWNER, BOT, 'open', 2000, {});
    expect(update).toHaveBeenCalledWith(BOT, {
      settings: { greeting: 'hi', dm: { policy: 'open' }, charLimit: 2000 },
    });
  });

  it('only sets dm.policy when charLimit is undefined', async () => {
    findById.mockResolvedValue(row);
    await setAccessRule(OWNER, BOT, 'allowlist', undefined, {});
    const callArg = update.mock.calls[0][1].settings;
    expect(callArg.dm).toEqual({ policy: 'allowlist' });
    expect(callArg.charLimit).toBeUndefined();
  });
});

describe('setModel', () => {
  it('updates the bound agent and invalidates bot when model is valid', async () => {
    findById.mockResolvedValue(row);
    assertModelValid.mockResolvedValue({ ok: true });
    await setModel(OWNER, BOT, 'claude-sonnet-4', 'anthropic', {});
    expect(agentUpdate).toHaveBeenCalledWith('agent-1', {
      model: 'claude-sonnet-4',
      provider: 'anthropic',
    });
    expect(invalidateBot).toHaveBeenCalledWith('telegram', '8677993854');
  });

  it('returns {ok:false, error:"no_agent"} when bot has no bound agent', async () => {
    findById.mockResolvedValue({ ...row, agentId: null });
    const r = await setModel(OWNER, BOT, 'claude-sonnet-4', 'anthropic', {});
    expect(r).toEqual({ botId: BOT, ok: false, error: 'no_agent' });
    expect(agentUpdate).not.toHaveBeenCalled();
    expect(assertModelValid).not.toHaveBeenCalled();
  });

  it('returns null for foreign bot (anti-IDOR, no validation)', async () => {
    findById.mockResolvedValue(undefined);
    const r = await setModel(OWNER, BOT, 'claude-sonnet-4', 'anthropic', {});
    expect(r).toBeNull();
    expect(assertModelValid).not.toHaveBeenCalled();
  });

  it('rejects unknown model and does NOT call agentModel.update', async () => {
    findById.mockResolvedValue(row);
    assertModelValid.mockResolvedValue({
      ok: false,
      message:
        'Модель «deepseek/deepseek-chat» недоступна. Доступные: deepseek/deepseek-v4-pro, deepseek/deepseek-v4-flash',
    });

    const r = await setModel(OWNER, BOT, 'deepseek-chat', 'deepseek', {});

    expect(r).toEqual({
      botId: BOT,
      ok: false,
      error: 'unknown_model',
      message: expect.stringContaining('deepseek/deepseek-chat'),
    });
    expect(r!.message).toMatch(/недоступна/);
    expect(agentUpdate).not.toHaveBeenCalled();
    expect(invalidateBot).not.toHaveBeenCalled();
  });

  it('rejects when catalog is unavailable (fail-closed)', async () => {
    findById.mockResolvedValue(row);
    assertModelValid.mockResolvedValue({
      ok: false,
      message: 'Не удалось проверить модель (каталог недоступен), попробуйте ещё раз позже.',
    });

    const r = await setModel(OWNER, BOT, 'any-model', 'any-provider', {});

    expect(r).toEqual({
      botId: BOT,
      ok: false,
      error: 'catalog_unavailable',
      message: expect.stringContaining('каталог недоступен'),
    });
    expect(agentUpdate).not.toHaveBeenCalled();
    expect(invalidateBot).not.toHaveBeenCalled();
  });
});
