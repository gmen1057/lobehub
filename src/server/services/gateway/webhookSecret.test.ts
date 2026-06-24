import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureWebhookSecret, generateWebhookSecret, redactWebhookSecret } from './webhookSecret';

const update = vi.fn();

vi.mock('@/database/models/agentBotProvider', () => ({
  AgentBotProviderModel: vi.fn().mockImplementation(() => ({ update })),
}));

const gateKeeper = { decrypt: vi.fn(), encrypt: vi.fn() } as any;

beforeEach(() => {
  update.mockReset();
  update.mockResolvedValue(undefined);
});

describe('generateWebhookSecret', () => {
  it('produces a 64-char hex token within Telegram secret_token constraints', () => {
    const s = generateWebhookSecret();
    expect(s).toMatch(/^[a-f0-9]{64}$/);
  });

  it('produces a unique value each call', () => {
    expect(generateWebhookSecret()).not.toBe(generateWebhookSecret());
  });
});

describe('ensureWebhookSecret', () => {
  it('is a no-op when a secret already exists (does not touch the DB)', async () => {
    const provider = {
      credentials: { botToken: 't', secretToken: 'existing' },
      id: 'p1',
      userId: 'u1',
    } as any;

    const created = await ensureWebhookSecret({} as any, gateKeeper, provider);

    expect(created).toBe(false);
    expect(update).not.toHaveBeenCalled();
    expect(provider.credentials.secretToken).toBe('existing');
  });

  it('generates, persists (preserving botToken), and mutates the provider when absent', async () => {
    const provider = { credentials: { botToken: 't' }, id: 'p1', userId: 'u1' } as any;

    const created = await ensureWebhookSecret({} as any, gateKeeper, provider);

    expect(created).toBe(true);
    expect(update).toHaveBeenCalledTimes(1);

    const [id, value] = update.mock.calls[0];
    expect(id).toBe('p1');
    // existing credentials are preserved, the secret is added
    expect(value.credentials.botToken).toBe('t');
    expect(value.credentials.secretToken).toMatch(/^[a-f0-9]{64}$/);
    // in-memory provider carries the secret so client.start() registers it this run
    expect(provider.credentials.secretToken).toBe(value.credentials.secretToken);
  });

  it('generates a distinct secret per provider', async () => {
    const p1 = { credentials: {}, id: 'a', userId: 'u' } as any;
    const p2 = { credentials: {}, id: 'b', userId: 'u' } as any;

    await ensureWebhookSecret({} as any, gateKeeper, p1);
    await ensureWebhookSecret({} as any, gateKeeper, p2);

    expect(p1.credentials.secretToken).not.toBe(p2.credentials.secretToken);
  });
});

describe('redactWebhookSecret', () => {
  it('removes the secret but keeps every other credential', () => {
    const out = redactWebhookSecret({ botToken: 't', secretToken: 's', webhookProxyUrl: 'u' });
    expect(out).toEqual({ botToken: 't', webhookProxyUrl: 'u' });
  });

  it('does not mutate the input', () => {
    const input = { botToken: 't', secretToken: 's' };
    redactWebhookSecret(input);
    expect(input.secretToken).toBe('s');
  });

  it('passes through credentials with no secret (and undefined)', () => {
    expect(redactWebhookSecret({ botToken: 't' })).toEqual({ botToken: 't' });
    expect(redactWebhookSecret(undefined)).toBeUndefined();
  });
});
