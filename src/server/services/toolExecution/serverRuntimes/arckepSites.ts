import {
  ArckepSitesIdentifier,
  type EditSiteParams,
  type GenerateImageParams,
  type GetDesignBriefParams,
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

const callBackend = async (path: string, body: Record<string, unknown>, timeoutMs = 30_000) => {
  const token = getInternalToken();
  if (!token) throw new Error('Internal token not configured');
  const res = await fetch(`${getBackendUrl()}${path}`, {
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'X-Arckep-Token': token },
    method: 'POST',
    signal: AbortSignal.timeout(timeoutMs),
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
    const { serverDB, userId, topicId } = context;

    return new ArckepSitesExecutionRuntime({
      generateImage: async (params: GenerateImageParams) => {
        const arckepId = await resolveArckepUserId(serverDB, userId);
        // Group-chat (server) context exposes topicId but not sessionId, so
        // cost attribution for landing images generated inside a group chat is
        // best-effort only and won't fully match a site published from 1-on-1
        // chat. The actual landing-building flow goes through the client
        // executor, which carries both ids.
        return callBackend('/api/chat/sites-tool/generate-image', {
          aspect_ratio: params.aspect_ratio ?? 'landscape',
          prompt: params.prompt,
          quality: params.quality ?? 'standard',
          topic_id: topicId,
          user_id: arckepId,
        });
      },
      getDesignBrief: async (params: GetDesignBriefParams) => {
        const arckepId = await resolveArckepUserId(serverDB, userId);
        return callBackend('/api/chat/sites-tool/design-brief', {
          business: params.business,
          style_id: params.style_id,
          user_id: arckepId,
        });
      },
      listSites: async () => {
        const arckepId = await resolveArckepUserId(serverDB, userId);
        const data = await callBackend('/api/chat/sites-tool/list', { user_id: arckepId });
        return data.sites;
      },
      listStyles: async () => callBackend('/api/chat/sites-tool/list-styles', {}),
      readSite: async (siteId: number) => {
        const arckepId = await resolveArckepUserId(serverDB, userId);
        return callBackend('/api/chat/sites-tool/read', { site_id: siteId, user_id: arckepId });
      },
      editSite: async (params: EditSiteParams) => {
        const arckepId = await resolveArckepUserId(serverDB, userId);
        // edit republishes (S3 + vitrina) — allow longer than list/read
        return callBackend(
          '/api/chat/sites-tool/edit',
          {
            replacements: params.replacements,
            site_id: params.site_id,
            topic_id: topicId,
            user_id: arckepId,
          },
          90_000,
        );
      },
      connectTelegram: async () => {
        const arckepId = await resolveArckepUserId(serverDB, userId);
        return callBackend('/api/chat/sites-tool/telegram-connect-link', { user_id: arckepId });
      },
    });
  },
  identifier: ArckepSitesIdentifier,
};
