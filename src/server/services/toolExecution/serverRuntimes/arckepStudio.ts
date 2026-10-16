import {
  ArckepStudioIdentifier,
  type CreateImageParams,
  type CreateSpeechParams,
  type EstimateImageParams,
} from '@lobechat/builtin-tool-arckep-studio';
import { ArckepStudioExecutionRuntime } from '@lobechat/builtin-tool-arckep-studio/executionRuntime';
import { users } from '@lobechat/database/schemas';
import { eq } from 'drizzle-orm';

import { type ServerRuntimeRegistration } from './types';

const IMAGE_STUDIO_BASE = 'http://127.0.0.1:8202';

const getBackendUrl = () =>
  (process.env.IMAGE_STUDIO_API_URL || IMAGE_STUDIO_BASE).replace(/\/$/, '');

const getInternalToken = () =>
  process.env.ARCKEP_INTERNAL_TOKEN || process.env.LOBECHAT_BACKEND_KEY;

// The backend waits for a picture up to ~75 s before it answers "processing"; speech is synchronous
// and its provider budget is 240 s. The calls here wait a little longer than the backend does.
const IMAGE_TIMEOUT_MS = 120_000;
const SPEECH_TIMEOUT_MS = 250_000;

/**
 * Resolve LobeChat user → arckep user_id. The auth bridge creates LobeChat
 * accounts with email `user{arckepId}@arckep.ru` (see api/bridge/route.ts) —
 * that suffix is the canonical mapping. The model never supplies a user.
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

/**
 * The studio's own error text is Russian and says what to do (balance, ban, model...). Pull it out of
 * the JSON envelope (`{detail: {message}}`, `{message}`, `{detail: "text"}`, 422 `{detail: [{msg}]}`) so
 * the model reads the sentence, not a clipped blob of JSON.
 */
export const backendErrorMessage = (status: number, text: string): string => {
  try {
    const json = JSON.parse(text);
    const body = json?.detail ?? json;
    if (typeof body === 'string' && body) return body;
    if (Array.isArray(body)) {
      const parts = body.map((e) => e?.msg).filter(Boolean);
      if (parts.length > 0) return parts.join('; ');
    }
    if (typeof body?.message === 'string' && body.message) return body.message;
  } catch {
    // not JSON: fall through
  }
  return `backend ${status}: ${text.slice(0, 200)}`;
};

// ── Tool arguments come from the model: only known fields, with types checked, go to the backend ──
// (never `...params`: a model must not be able to add `user_id`, `session_id` or anything else).

const clip = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;

const flag = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined;

const count = (value: unknown, min: number, max: number): number | undefined =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.trunc(value)))
    : undefined;

const money = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

/** Undefined values are dropped by JSON.stringify, so only the fields the model really set are sent. */
export const imageOptionsBody = (params: EstimateImageParams | undefined) => ({
  aspect_ratio: clip(params?.aspect_ratio, 16),
  model: clip(params?.model, 120),
  num_images: count(params?.num_images, 1, 4),
  quality: clip(params?.quality, 32),
  resolution: clip(params?.resolution, 16),
  thinking: flag(params?.thinking),
});

export const createImageBody = (params: CreateImageParams) => {
  const prompt = typeof params?.prompt === 'string' ? params.prompt.trim() : '';
  if (!prompt) throw new Error('createImage: prompt должен быть непустой строкой');
  return { ...imageOptionsBody(params), max_cost_rub: money(params.max_cost_rub), prompt };
};

export const createSpeechBody = (params: CreateSpeechParams) => {
  const body = clip(params?.text, 6000);
  if (!body) throw new Error('createSpeech: text должен быть непустой строкой');
  return { style: clip(params.style, 300), text: body, voice_id: clip(params.voice_id, 120) };
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
    throw new Error(backendErrorMessage(res.status, await res.text()));
  }
  return res.json();
};

export const arckepStudioRuntime: ServerRuntimeRegistration = {
  factory: (context) => {
    if (!context.userId || !context.serverDB) {
      throw new Error('userId and serverDB are required for ArcKep Studio execution');
    }
    const { serverDB, userId, topicId } = context;

    return new ArckepStudioExecutionRuntime({
      createImage: async (params: CreateImageParams) => {
        const arckepId = await resolveArckepUserId(serverDB, userId);
        return callBackend(
          '/api/chat/studio-tool/create-image',
          { ...createImageBody(params), topic_id: topicId, user_id: arckepId },
          IMAGE_TIMEOUT_MS,
        );
      },
      createSpeech: async (params: CreateSpeechParams) => {
        const arckepId = await resolveArckepUserId(serverDB, userId);
        return callBackend(
          '/api/chat/studio-tool/create-speech',
          { ...createSpeechBody(params), topic_id: topicId, user_id: arckepId },
          SPEECH_TIMEOUT_MS,
        );
      },
      estimateImage: async (params: EstimateImageParams) => {
        const arckepId = await resolveArckepUserId(serverDB, userId);
        return callBackend('/api/chat/studio-tool/estimate-image', {
          ...imageOptionsBody(params),
          user_id: arckepId,
        });
      },
      getBalance: async () => {
        const arckepId = await resolveArckepUserId(serverDB, userId);
        return callBackend('/api/chat/studio-tool/get-balance', { user_id: arckepId });
      },
      getImage: async (generationId: number) => {
        if (!Number.isInteger(generationId) || generationId < 1) {
          throw new Error('getImage: generation_id должен быть положительным целым числом');
        }
        const arckepId = await resolveArckepUserId(serverDB, userId);
        return callBackend('/api/chat/studio-tool/get-image', {
          generation_id: generationId,
          user_id: arckepId,
        });
      },
      listImageModels: async () => {
        const arckepId = await resolveArckepUserId(serverDB, userId);
        return callBackend('/api/chat/studio-tool/list-models', { user_id: arckepId });
      },
    });
  },
  identifier: ArckepStudioIdentifier,
};
