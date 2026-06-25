/**
 * Internal server-to-server route for the arckep «Мои боты» mutations.
 *
 * Unlike sites-tool/route.ts (browser → `arckep_token` cookie auth), this route
 * is called by the arckep FastAPI backend over loopback with a SHARED INTERNAL
 * SECRET (no cookie). arckep has already authenticated the user (cookie →
 * /api/auth/validate) and re-checked ownership (get_owned_bot: id AND the owner's
 * resolved LobeChat user_id) before calling here, so the `userId` in the body is a
 * SERVER-RESOLVED owner id — never a model/client-supplied value. The bot model
 * re-scopes every write by that userId (defense in depth): a mismatched
 * (botId, userId) touches 0 rows → 404.
 *
 * Called by: image-studio backend/app/services/bot_service.py :: set_enabled,
 *            and for mutating actions (setGreeting/setCommands/…)
 */
import { timingSafeEqual } from 'node:crypto';

import { type NextRequest } from 'next/server';

import { setBotEnabled } from '@/server/services/bot/botEnableService';
import {
  setAccessRule,
  setCommands,
  setGreeting,
  setModel,
} from '@/server/services/bot/botMutationService';

// Same shared secret arckep validates on the reverse hop (sites-tool → arckep):
// fork env LOBECHAT_BACKEND_KEY === arckep INTERNAL_API_KEY.
const getSharedSecret = () => process.env.ARCKEP_INTERNAL_TOKEN || process.env.LOBECHAT_BACKEND_KEY;

const constantTimeEqual = (a: string, b: string): boolean => {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
};

const VALID_ACTIONS = new Set([
  'enable',
  'disable',
  'setGreeting',
  'setCommands',
  'setAccessRule',
  'setModel',
]);

interface BotToolRequestBody {
  action?: unknown;
  botId?: unknown;
  charLimit?: unknown;
  commands?: unknown;
  dmPolicy?: unknown;
  greeting?: unknown;
  model?: unknown;
  provider?: unknown;
  userId?: unknown;
}

export async function POST(req: NextRequest) {
  const secret = getSharedSecret();
  if (!secret) {
    return Response.json({ error: 'Internal token not configured' }, { status: 500 });
  }

  const provided = req.headers.get('x-arckep-token');
  if (!provided || !constantTimeEqual(provided, secret)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: BotToolRequestBody;
  try {
    body = (await req.json()) as BotToolRequestBody;
  } catch {
    return Response.json({ error: 'Bad JSON' }, { status: 400 });
  }

  const { action, botId, userId } = body;
  if (typeof action !== 'string' || !VALID_ACTIONS.has(action)) {
    return Response.json(
      { error: `action must be one of: ${[...VALID_ACTIONS].join(', ')}` },
      { status: 400 },
    );
  }
  if (typeof botId !== 'string' || !botId || typeof userId !== 'string' || !userId) {
    return Response.json({ error: 'botId and userId are required' }, { status: 400 });
  }

  try {
    // ── enable / disable (Phase 13) ──────────────────────────────────────
    if (action === 'enable' || action === 'disable') {
      const result = await setBotEnabled(userId, botId, action === 'enable');
      if (!result) {
        return Response.json({ error: 'Bot not found' }, { status: 404 });
      }
      return Response.json({
        applicationId: result.applicationId,
        ok: true,
        platform: result.platform,
        runtimeStatus: result.runtimeStatus,
        status: result.enabled ? 'enabled' : 'disabled',
      });
    }

    // ── setGreeting (Phase 22) ───────────────────────────────────────────
    if (action === 'setGreeting') {
      const greeting = body.greeting;
      if (typeof greeting !== 'string' || !greeting.trim()) {
        return Response.json({ error: 'greeting is required' }, { status: 400 });
      }
      const result = await setGreeting(userId, botId, greeting);
      if (!result) {
        return Response.json({ error: 'Bot not found' }, { status: 404 });
      }
      return Response.json({ ok: true });
    }

    // ── setCommands (Phase 22) ───────────────────────────────────────────
    if (action === 'setCommands') {
      const commands = body.commands;
      if (!Array.isArray(commands)) {
        return Response.json({ error: 'commands must be an array' }, { status: 400 });
      }
      const typedCommands = commands.map((c: any) => ({
        description: String(c.description ?? ''),
        name: String(c.name ?? '').toLowerCase(),
        response: String(c.response ?? ''),
      }));
      if (typedCommands.some((c) => !c.name)) {
        return Response.json({ error: 'each command must have a name' }, { status: 400 });
      }
      const result = await setCommands(userId, botId, typedCommands);
      if (!result) {
        return Response.json({ error: 'Bot not found' }, { status: 404 });
      }
      return Response.json({ ok: true });
    }

    // ── setAccessRule (Phase 22) ─────────────────────────────────────────
    if (action === 'setAccessRule') {
      const dmPolicy = body.dmPolicy;
      const charLimit = body.charLimit;
      if (dmPolicy !== undefined && typeof dmPolicy !== 'string') {
        return Response.json({ error: 'dmPolicy must be a string' }, { status: 400 });
      }
      if (charLimit !== undefined && charLimit !== null && typeof charLimit !== 'number') {
        return Response.json({ error: 'charLimit must be a number' }, { status: 400 });
      }
      const result = await setAccessRule(
        userId,
        botId,
        dmPolicy as string | null | undefined,
        charLimit as number | null | undefined,
      );
      if (!result) {
        return Response.json({ error: 'Bot not found' }, { status: 404 });
      }
      return Response.json({ ok: true });
    }

    // ── setModel (Phase 22) ──────────────────────────────────────────────
    if (action === 'setModel') {
      const model = body.model;
      const provider = body.provider;
      if (typeof model !== 'string' || !model.trim()) {
        return Response.json({ error: 'model is required' }, { status: 400 });
      }
      if (typeof provider !== 'string' || !provider.trim()) {
        return Response.json({ error: 'provider is required' }, { status: 400 });
      }
      const result = await setModel(userId, botId, model, provider);
      if (!result) {
        return Response.json({ error: 'Bot not found' }, { status: 404 });
      }
      if (!result.ok) {
        return Response.json(
          { error: result.message || 'Bot has no bound agent' },
          { status: 400 },
        );
      }
      return Response.json({ ok: true });
    }

    return Response.json({ error: `Unknown action: ${action}` }, { status: 400 });
  } catch (error) {
    console.error(`[bot-tool] ${action} failed:`, error);
    return Response.json({ error: 'Operation failed' }, { status: 502 });
  }
}
