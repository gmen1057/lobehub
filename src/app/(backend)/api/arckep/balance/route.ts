/**
 * Initial balance fetch for the chat.arckep.ru header widget.
 *
 * Uses the BetterAuth session as source of truth (NOT arckep_token cookie).
 * This decouples the widget from JWT freshness — incident 2026-05-01 where
 * the cookie expired while the chat session was still alive and the widget
 * blanked out.
 *
 * Flow:
 *   1. Read BetterAuth session via auth.api.getSession
 *   2. Forward userId to image-studio backend with shared internal secret
 *   3. Stream JSON balance back to the browser
 */
import { auth } from '@/auth';

const BACKEND_URL = process.env.LOBECHAT_BACKEND_INTERNAL_URL || 'http://127.0.0.1:8202';
const INTERNAL_TOKEN = process.env.LOBECHAT_BACKEND_KEY || '';

export async function GET(req: Request) {
  if (!INTERNAL_TOKEN) {
    return Response.json({ error: 'Server not configured' }, { status: 500 });
  }

  const session = await auth.api.getSession({ headers: req.headers });
  const userId = session?.user?.id;
  if (!userId) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 });
  }

  try {
    const upstream = await fetch(`${BACKEND_URL}/api/balance/by-lobechat`, {
      headers: {
        'X-Arckep-Token': INTERNAL_TOKEN,
        'X-Lobechat-User-Id': userId,
      },
    });
    const body = await upstream.text();
    return new Response(body, {
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': upstream.headers.get('content-type') || 'application/json',
      },
      status: upstream.status,
    });
  } catch (err) {
    console.error('arckep/balance: backend unreachable', err);
    return Response.json({ error: 'Balance service unavailable' }, { status: 502 });
  }
}
