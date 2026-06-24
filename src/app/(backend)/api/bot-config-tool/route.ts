/**
 * Browser-side data route for the arckep-bot configurator tool (1-on-1 chat).
 *
 * Mirrors sites-tool/route.ts but for BOT config, which is native to the
 * LobeChat DB — so this reads `agent_bot_providers` directly (no arckep hop).
 * Auth = the BetterAuth SESSION (the user is logged into chat.arckep.ru); the
 * model never supplies the user id, and the read helper scopes every query by
 * the session user (anti-IDOR → foreign bot id = 404).
 *
 * Used by: src/store/tool/slices/builtin/executors/arckep-bot.ts
 * Note: session-authed, so it does NOT need a proxy isPublicRoute entry (unlike
 * the server-to-server /api/bot-tool toggle route).
 */
import { type NextRequest } from 'next/server';

import { auth } from '@/auth';
import { getServerDB } from '@/database/core/db-adaptor';
import { getBotConfigForUser, listBotsForUser } from '@/server/services/bot/botConfigRead';

interface BotConfigToolBody {
  action?: unknown;
  bot_id?: unknown;
}

export async function POST(req: NextRequest) {
  const session = await auth.api.getSession({ headers: req.headers });
  const userId = session?.user?.id;
  if (!userId) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 });
  }

  let body: BotConfigToolBody;
  try {
    body = (await req.json()) as BotConfigToolBody;
  } catch {
    return Response.json({ error: 'Bad JSON' }, { status: 400 });
  }

  const serverDB = await getServerDB();

  if (body.action === 'list') {
    const bots = await listBotsForUser(userId, serverDB);
    return Response.json({ bots });
  }

  if (body.action === 'config' && typeof body.bot_id === 'string' && body.bot_id) {
    const config = await getBotConfigForUser(userId, body.bot_id, serverDB);
    if (!config) {
      return Response.json({ error: 'Bot not found' }, { status: 404 });
    }
    return Response.json(config);
  }

  return Response.json(
    { error: 'action must be "list" or "config" (with bot_id)' },
    { status: 400 },
  );
}
