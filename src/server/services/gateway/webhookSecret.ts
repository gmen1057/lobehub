import { randomBytes } from 'node:crypto';

import type { DecryptedBotProvider } from '@/database/models/agentBotProvider';
import { AgentBotProviderModel } from '@/database/models/agentBotProvider';
import type { LobeChatDatabase } from '@/database/type';

interface GateKeeper {
  decrypt: (ciphertext: string) => Promise<{ plaintext: string }>;
  encrypt: (plaintext: string) => Promise<string>;
}

/**
 * Telegram `secret_token` accepts 1–256 chars of `A-Z a-z 0-9 _ -`.
 * 32 random bytes → 64 hex chars: well within range, 256 bits of entropy.
 */
export function generateWebhookSecret(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Ensure a per-bot webhook secret exists (G2 — make the inbound webhook
 * unspoofable). Idempotent: a no-op when the provider already carries
 * `credentials.secretToken`.
 *
 * When absent, generates a secret, persists it (encrypted, alongside `botToken`
 * in the credentials blob) and mutates the in-memory provider so the caller's
 * subsequent `client.start()` registers it with Telegram (`setWebhook
 * secret_token`) in the SAME run. This keeps Telegram's registration and the
 * adapter's incoming-header verification in lockstep — no window where the
 * adapter verifies a secret Telegram has not yet been told to send (which would
 * lock the live bot out).
 *
 * The secret is treated like a credential: encrypted at rest, never echoed back
 * through tRPC config surfaces (see `redactWebhookSecret`). The incoming-request
 * comparison is performed by the vendored `@chat-adapter/telegram` adapter
 * (constant-time `timingSafeEqual` against `x-telegram-bot-api-secret-token`,
 * 401 on mismatch, before the update is parsed) — we only generate, store and
 * register the secret.
 *
 * @returns true if a new secret was generated, false if one already existed.
 */
export async function ensureWebhookSecret(
  db: LobeChatDatabase,
  gateKeeper: GateKeeper,
  provider: DecryptedBotProvider,
): Promise<boolean> {
  if (provider.credentials.secretToken) return false;

  const secret = generateWebhookSecret();
  const model = new AgentBotProviderModel(db, provider.userId, gateKeeper);
  await model.update(provider.id, {
    credentials: { ...provider.credentials, secretToken: secret },
  });
  // Mutate in place so the caller's client.start() this run registers the secret.
  provider.credentials.secretToken = secret;
  return true;
}

/**
 * Strip the server-managed webhook secret from a credentials blob before it
 * crosses a client-facing tRPC boundary. The secret must never be echoed (G2);
 * the client neither sets nor needs it.
 */
export function redactWebhookSecret<T extends Record<string, string> | undefined>(
  credentials: T,
): T {
  if (!credentials?.secretToken) return credentials;
  const rest = { ...credentials } as Record<string, string>;
  delete rest.secretToken;
  return rest as T;
}
