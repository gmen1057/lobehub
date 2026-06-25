/**
 * Browser-side data route for the arckep-bot configurator tool (1-on-1 chat).
 *
 * Auth = the BetterAuth SESSION (the user is logged into chat.arckep.ru); the
 * model never supplies the user id. Every query and mutation is scoped by the
 * session user (anti-IDOR → foreign bot id = 404).
 *
 * Used by: src/store/tool/slices/builtin/executors/arckep-bot.ts
 * Note: session-authed, so it does NOT need a proxy isPublicRoute entry (unlike
 * the server-to-server /api/bot-tool toggle route).
 */
import { type NextRequest } from 'next/server';

import { auth } from '@/auth';
import { getServerDB } from '@/database/core/db-adaptor';
import { getBotConfigForUser, listBotsForUser } from '@/server/services/bot/botConfigRead';
import {
  setAccessRule,
  setCommands,
  setGreeting,
  setModel,
} from '@/server/services/bot/botMutationService';
import { setBotEnabled } from '@/server/services/bot/botEnableService';

const MUTATION_ACTIONS = new Set([
  'enable',
  'disable',
  'setGreeting',
  'setCommands',
  'setAccessRule',
  'setModel',
]);

interface BotConfigToolBody {
  action?: unknown;
  bot_id?: unknown;
  greeting?: unknown;
  commands?: unknown;
  dmPolicy?: unknown;
  charLimit?: unknown;
  model?: unknown;
  provider?: unknown;
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

  // ── Read actions (Phase 20) ───────────────────────────────────────────
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

  // ── Mutation actions (Phases 21-22) ───────────────────────────────────
  if (typeof body.action === 'string' && MUTATION_ACTIONS.has(body.action)) {
    const botId = body.bot_id;
    if (typeof botId !== 'string' || !botId) {
      return Response.json({ error: 'bot_id is required' }, { status: 400 });
    }

    try {
      if (body.action === 'enable' || body.action === 'disable') {
        const result = await setBotEnabled(userId, botId, body.action === 'enable');
        if (!result) return Response.json({ error: 'Bot not found' }, { status: 404 });
        return Response.json({ ok: true, status: result.enabled ? 'enabled' : 'disabled' });
      }

      if (body.action === 'setGreeting') {
        if (typeof body.greeting !== 'string' || !body.greeting.trim()) {
          return Response.json({ error: 'greeting is required' }, { status: 400 });
        }
        const result = await setGreeting(userId, botId, body.greeting, serverDB);
        if (!result) return Response.json({ error: 'Bot not found' }, { status: 404 });
        return Response.json({ ok: true });
      }

      if (body.action === 'setCommands') {
        if (!Array.isArray(body.commands)) {
          return Response.json({ error: 'commands must be an array' }, { status: 400 });
        }
        const typedCommands = (body.commands as any[]).map((c) => ({
          description: String(c.description ?? ''),
          name: String(c.name ?? '').toLowerCase(),
          response: String(c.response ?? ''),
        }));
        if (typedCommands.some((c) => !c.name)) {
          return Response.json({ error: 'each command must have a name' }, { status: 400 });
        }
        const result = await setCommands(userId, botId, typedCommands, serverDB);
        if (!result) return Response.json({ error: 'Bot not found' }, { status: 404 });
        return Response.json({ ok: true });
      }

      if (body.action === 'setAccessRule') {
        if (body.dmPolicy !== undefined && typeof body.dmPolicy !== 'string') {
          return Response.json({ error: 'dmPolicy must be a string' }, { status: 400 });
        }
        if (body.charLimit !== undefined && body.charLimit !== null && typeof body.charLimit !== 'number') {
          return Response.json({ error: 'charLimit must be a number' }, { status: 400 });
        }
        const result = await setAccessRule(
          userId, botId,
          body.dmPolicy as string | null | undefined,
          body.charLimit as number | null | undefined,
          serverDB,
        );
        if (!result) return Response.json({ error: 'Bot not found' }, { status: 404 });
        return Response.json({ ok: true });
      }

      if (body.action === 'setModel') {
        if (typeof body.model !== 'string' || !body.model.trim()) {
          return Response.json({ error: 'model is required' }, { status: 400 });
        }
        if (typeof body.provider !== 'string' || !body.provider.trim()) {
          return Response.json({ error: 'provider is required' }, { status: 400 });
        }
        const result = await setModel(userId, botId, body.model, body.provider, serverDB);
        if (!result) return Response.json({ error: 'Bot not found' }, { status: 404 });
        if (!result.ok) return Response.json({ error: 'Bot has no bound agent' }, { status: 400 });
        return Response.json({ ok: true });
      }
    } catch (error) {
      console.error(`[bot-config-tool] ${body.action} failed:`, error);
      return Response.json({ error: 'Operation failed' }, { status: 502 });
    }
  }

  return Response.json(
    { error: 'action must be "list", "config", or a mutation: enable, disable, setGreeting, setCommands, setAccessRule, setModel' },
    { status: 400 },
  );
}
