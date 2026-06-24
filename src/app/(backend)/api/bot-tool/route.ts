/**
 * Internal server-to-server route for the arckep «Мои боты» on/off toggle.
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
 * Called by: image-studio backend/app/services/bot_service.py :: set_enabled
 */
import { timingSafeEqual } from 'node:crypto';

import { type NextRequest } from 'next/server';

import { setBotEnabled } from '@/server/services/bot/botEnableService';

// Same shared secret arckep validates on the reverse hop (sites-tool → arckep):
// fork env LOBECHAT_BACKEND_KEY === arckep INTERNAL_API_KEY.
const getSharedSecret = () => process.env.ARCKEP_INTERNAL_TOKEN || process.env.LOBECHAT_BACKEND_KEY;

const constantTimeEqual = (a: string, b: string): boolean => {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
};

interface BotToolRequestBody {
  action?: unknown;
  botId?: unknown;
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
  if (
    (action !== 'enable' && action !== 'disable') ||
    typeof botId !== 'string' ||
    !botId ||
    typeof userId !== 'string' ||
    !userId
  ) {
    return Response.json(
      { error: 'action must be "enable" or "disable"; botId and userId are required' },
      { status: 400 },
    );
  }

  try {
    const result = await setBotEnabled(userId, botId, action === 'enable');
    if (!result) {
      // Foreign or missing bot for this owner — 404, never 403 (no existence leak).
      return Response.json({ error: 'Bot not found' }, { status: 404 });
    }
    return Response.json({
      applicationId: result.applicationId,
      ok: true,
      platform: result.platform,
      runtimeStatus: result.runtimeStatus,
      status: result.enabled ? 'enabled' : 'disabled',
    });
  } catch (error) {
    console.error('[bot-tool] setBotEnabled failed:', error);
    return Response.json({ error: 'Bot toggle failed' }, { status: 502 });
  }
}
