import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setBotBlocked } from '../botBlockService';

const mockFindById = vi.hoisted(() => vi.fn());
const mockUpdate = vi.hoisted(() => vi.fn());
const mockInitWithEnvKey = vi.hoisted(() => vi.fn());
const mockGetServerDB = vi.hoisted(() => vi.fn());
const mockStopClient = vi.hoisted(() => vi.fn());
const mockStartClient = vi.hoisted(() => vi.fn());
const mockInvalidateBot = vi.hoisted(() => vi.fn());

// Prevent transitive LLM config from loading (apiKeyManager → getLLMConfig).
// Mock ModelRuntime before it gets imported through the chain.
vi.mock('@/server/modules/ModelRuntime', () => ({
  ApiKeyManager: class {
    getKey() {
      return 'test-key';
    }
  },
}));

// Prevent SearchService from loading its env-dependent config.
vi.mock('@/server/services/search', () => ({
  SearchService: class {},
}));

vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: mockGetServerDB,
}));

vi.mock('@/database/models/agentBotProvider', () => ({
  AgentBotProviderModel: vi.fn().mockImplementation(() => ({
    findById: mockFindById,
    update: mockUpdate,
  })),
}));

vi.mock('@/server/modules/KeyVaultsEncrypt', () => ({
  KeyVaultsGateKeeper: { initWithEnvKey: mockInitWithEnvKey },
}));

vi.mock('@/server/services/gateway', () => ({
  GatewayService: vi.fn().mockImplementation(() => ({
    startClient: mockStartClient,
    stopClient: mockStopClient,
  })),
}));

vi.mock('../BotMessageRouter', () => ({
  getBotMessageRouter: () => ({ invalidateBot: mockInvalidateBot }),
}));

const bot = {
  id: 'bot-1',
  applicationId: '8677993854',
  platform: 'telegram',
  settings: { greeting: 'hi' },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockInitWithEnvKey.mockResolvedValue({});
  mockGetServerDB.mockResolvedValue({});
  mockStopClient.mockResolvedValue(undefined);
  mockInvalidateBot.mockResolvedValue(undefined);
});

describe('setBotBlocked', () => {
  it('block: merges adminBlocked=true, stops client, invalidates cache', async () => {
    mockFindById.mockResolvedValue(bot);
    mockUpdate.mockResolvedValue(undefined);

    const result = await setBotBlocked('user-1', 'bot-1', true);
    expect(result).toBeTruthy();
    expect(result!.blocked).toBe(true);

    // Should merge settings without clobbering
    expect(mockUpdate).toHaveBeenCalledWith('bot-1', {
      settings: { greeting: 'hi', adminBlocked: true },
    });
    expect(mockStopClient).toHaveBeenCalledWith('telegram', '8677993854');
    expect(mockInvalidateBot).toHaveBeenCalledWith('telegram', '8677993854');
    // Should NOT auto-start
    expect(mockStartClient).not.toHaveBeenCalled();
  });

  it('unblock: merges adminBlocked=false, invalidates cache, does NOT auto-start', async () => {
    mockFindById.mockResolvedValue({
      ...bot,
      settings: { greeting: 'hi', adminBlocked: true },
    });
    mockUpdate.mockResolvedValue(undefined);

    const result = await setBotBlocked('user-1', 'bot-1', false);
    expect(result).toBeTruthy();
    expect(result!.blocked).toBe(false);

    expect(mockUpdate).toHaveBeenCalledWith('bot-1', {
      settings: { greeting: 'hi', adminBlocked: false },
    });
    // Does NOT call startClient on unblock
    expect(mockStartClient).not.toHaveBeenCalled();
    expect(mockInvalidateBot).toHaveBeenCalled();
  });

  it('foreign userId → returns null (anti-IDOR, 404)', async () => {
    mockFindById.mockResolvedValue(null);

    const result = await setBotBlocked('foreign-user', 'bot-1', true);
    expect(result).toBeNull();
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
