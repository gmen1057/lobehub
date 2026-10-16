import { timingSafeEqual } from 'node:crypto';

import { verifyPassword } from 'better-auth/crypto';
import debug from 'debug';
import { and, eq } from 'drizzle-orm';

import { UserModel } from '@/database/models/user';
import { account, userRoles } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';

/**
 * arckep: служебный вход студии в REST движка (план lobechat-engine-studio-chat, D13).
 *
 * Бэкенд студии шлёт `Authorization: Bearer <ARCKEP_ENGINE_SERVICE_KEY>` и
 * `X-Arckep-User-Id: <id пользователя студии>`. Движок находит своего пользователя
 * `user{N}@arckep.ru`; если его нет — создаёт через Better Auth sign-up ровно так же,
 * как `/api/bridge`, и выдаёт роль `arckep_owner` (scripts/arckep/seed-rbac-owner.sql).
 *
 * Совпадения email недостаточно (кто-то мог заранее зарегистрировать `user4@arckep.ru`):
 * учётка принимается только если её пароль — производный пароль bridge. Проверка идёт по
 * хэшу в `accounts` (provider `credential`), сессии Better Auth не создаются.
 *
 * Ключ намеренно не похож на API-ключ `sk-lh-…`; без переменной окружения код инертен.
 */
const log = debug('lobe-hono:arckep-service-auth');

export const ARCKEP_USER_HEADER = 'x-arckep-user-id';
export const ARCKEP_OWNER_ROLE_ID = 'arckep_owner';
const MIN_KEY_LENGTH = 32;
const CACHE_TTL_MS = 5 * 60 * 1000;

const constantTimeEqual = (a: string, b: string): boolean => {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
};

export const getArckepServiceKey = (): string => process.env.ARCKEP_ENGINE_SERVICE_KEY || '';

export const isArckepServiceBearer = (bearer?: string | null): boolean => {
  const key = getArckepServiceKey();
  if (!key || key.length < MIN_KEY_LENGTH || !bearer) return false;
  return constantTimeEqual(bearer, key);
};

export const parseArckepUserId = (raw?: string | null): number | null => {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!/^\d{1,12}$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value > 0 ? value : null;
};

export const arckepEmailFor = (studioUserId: number): string => `user${studioUserId}@arckep.ru`;

export const arckepBridgePasswordFor = (studioUserId: number): string => {
  const authSecret = process.env.AUTH_SECRET;
  if (!authSecret) throw new Error('AUTH_SECRET is not set');
  return `arckep_bridge_${studioUserId}_${authSecret.slice(0, 8)}`;
};

export type ArckepSignUp = (params: {
  email: string;
  name: string;
  password: string;
}) => Promise<void>;

const defaultSignUp: ArckepSignUp = async ({ email, name, password }) => {
  const port = process.env.PORT || '3402';
  const res = await fetch(`http://127.0.0.1:${port}/chat/api/auth/sign-up/email`, {
    body: JSON.stringify({ email, name, password }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`sign-up failed: ${res.status}`);
};

/** Учётка создана bridge/служебным входом: её credential-пароль равен производному паролю. */
export const verifyArckepOwnership = async (
  db: LobeChatDatabase,
  userId: string,
  password: string,
): Promise<boolean> => {
  const rows = await db
    .select({ password: account.password })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, 'credential')))
    .limit(1);
  const hash = rows[0]?.password;
  if (!hash) return false;
  return verifyPassword({ hash, password });
};

export const ensureArckepOwnerRole = async (
  db: LobeChatDatabase,
  userId: string,
): Promise<void> => {
  await db.insert(userRoles).values({ roleId: ARCKEP_OWNER_ROLE_ID, userId }).onConflictDoNothing();
};

const resolvedCache = new Map<number, { timestamp: number; userId: string }>();

export const clearArckepUserCache = () => resolvedCache.clear();

/**
 * Найти (или создать) пользователя LobeChat для пользователя студии.
 * Возвращает id пользователя LobeChat или null, если создать не удалось.
 */
export const resolveArckepUser = async (
  db: LobeChatDatabase,
  studioUserId: number,
  signUp: ArckepSignUp = defaultSignUp,
): Promise<string | null> => {
  const cached = resolvedCache.get(studioUserId);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) return cached.userId;

  const email = arckepEmailFor(studioUserId);
  const password = arckepBridgePasswordFor(studioUserId);
  let user = await UserModel.findByEmail(db, email);

  if (!user) {
    try {
      await signUp({ email, name: `User ${studioUserId}`, password });
    } catch (error) {
      log('sign-up for studio user %d failed: %O', studioUserId, error);
      return null;
    }
    user = await UserModel.findByEmail(db, email);
    if (!user) {
      log('studio user %d still missing after sign-up', studioUserId);
      return null;
    }
  }

  if (!(await verifyArckepOwnership(db, user.id, password))) {
    // Учётка с таким email есть, но заведена не bridge — чужая регистрация, не доверяем.
    log('studio user %d: account %s is not bridge-owned, refusing', studioUserId, user.id);
    return null;
  }

  try {
    await ensureArckepOwnerRole(db, user.id);
  } catch (error) {
    // Роль не посеяна (живая база до переключения) — доступ отклонит RBAC, вход не ломаем.
    log('ensureArckepOwnerRole failed for %s: %O', user.id, error);
  }

  resolvedCache.set(studioUserId, { timestamp: Date.now(), userId: user.id });
  return user.id;
};
