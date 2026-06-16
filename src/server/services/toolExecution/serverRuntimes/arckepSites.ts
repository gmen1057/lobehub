import {
  ArckepSitesIdentifier,
  type GenerateImageParams,
} from '@lobechat/builtin-tool-arckep-sites';
import { ArckepSitesExecutionRuntime } from '@lobechat/builtin-tool-arckep-sites/executionRuntime';
import { users } from '@lobechat/database/schemas';
import { eq } from 'drizzle-orm';

import { type ServerRuntimeRegistration } from './types';

const IMAGE_STUDIO_BASE = 'http://127.0.0.1:8202';

const getBackendUrl = () =>
  (process.env.IMAGE_STUDIO_API_URL || IMAGE_STUDIO_BASE).replace(/\/$/, '');

const getInternalToken = () =>
  process.env.ARCKEP_INTERNAL_TOKEN || process.env.LOBECHAT_BACKEND_KEY;

/**
 * Resolve LobeChat user → arckep user_id. The auth bridge creates LobeChat
 * accounts with email `user{arckepId}@arckep.ru` (see api/bridge/route.ts) —
 * that suffix is the canonical mapping.
 */
const resolveArckepUserId = async (serverDB: any, lobeUserId: string): Promise<number> => {
  const rows = await serverDB
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, lobeUserId))
    .limit(1);
  const email: string | null = rows[0]?.email ?? null;
  const match = email?.match(/^user(\d+)@arckep\.ru$/);
  if (!match) {
    throw new Error('Аккаунт не связан с arckep.ru — зайдите в чат через arckep.ru');
  }
  return Number(match[1]);
};

const callBackend = async (path: string, body: Record<string, unknown>) => {
  const token = getInternalToken();
  if (!token) throw new Error('Internal token not configured');
  const res = await fetch(`${getBackendUrl()}${path}`, {
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'X-Arckep-Token': token },
    method: 'POST',
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`backend ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
};

export const arckepSitesRuntime: ServerRuntimeRegistration = {
  factory: (context) => {
    if (!context.userId || !context.serverDB) {
      throw new Error('userId and serverDB are required for ArcKep Sites execution');
    }
    const { serverDB, userId } = context;

    return new ArckepSitesExecutionRuntime({
      generateImage: async (params: GenerateImageParams) => {
        const arckepId = await resolveArckepUserId(serverDB, userId);
        return callBackend('/api/chat/sites-tool/generate-image', {
          aspect_ratio: params.aspect_ratio ?? 'landscape',
          prompt: params.prompt,
          quality: params.quality ?? 'standard',
          user_id: arckepId,
        });
      },
      listSites: async () => {
        const arckepId = await resolveArckepUserId(serverDB, userId);
        const data = await callBackend('/api/chat/sites-tool/list', { user_id: arckepId });
        return data.sites;
      },
      readSite: async (siteId: number) => {
        const arckepId = await resolveArckepUserId(serverDB, userId);
        return callBackend('/api/chat/sites-tool/read', { site_id: siteId, user_id: arckepId });
      },
      connectTelegram: async () => {
        const arckepId = await resolveArckepUserId(serverDB, userId);
        return callBackend('/api/chat/sites-tool/telegram-connect-link', { user_id: arckepId });
      },
    });
  },
  identifier: ArckepSitesIdentifier,
};
