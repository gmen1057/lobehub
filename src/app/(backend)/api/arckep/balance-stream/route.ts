/**
 * SSE balance stream for the chat.arckep.ru header widget.
 *
 * Companion to /api/arckep/balance — same auth model: BetterAuth session →
 * X-Lobechat-User-Id forwarded to image-studio backend with shared secret.
 * Streams the upstream SSE body straight through to the browser.
 *
 * Why a Next.js relay instead of nginx proxying directly? nginx can't validate
 * a BetterAuth session cookie without a backend round-trip — easier to do that
 * resolution server-side here once and stream the rest.
 */
import { auth } from '@/auth';

const BACKEND_URL = process.env.LOBECHAT_BACKEND_INTERNAL_URL || 'http://127.0.0.1:8202';
const INTERNAL_TOKEN = process.env.LOBECHAT_BACKEND_KEY || '';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  if (!INTERNAL_TOKEN) {
    return new Response('Server not configured', { status: 500 });
  }

  const session = await auth.api.getSession({ headers: req.headers });
  const userId = session?.user?.id;
  if (!userId) {
    return new Response('Unauthorized', { status: 401 });
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${BACKEND_URL}/api/balance/stream`, {
      headers: {
        'Accept': 'text/event-stream',
        'X-Arckep-Token': INTERNAL_TOKEN,
        'X-Lobechat-User-Id': userId,
      },
      signal: req.signal,
    });
  } catch (err) {
    console.error('arckep/balance-stream: backend unreachable', err);
    return new Response('Balance service unavailable', { status: 502 });
  }

  if (!upstream.ok || !upstream.body) {
    return new Response(`Upstream ${upstream.status}`, { status: upstream.status });
  }

  return new Response(upstream.body, {
    headers: {
      'Cache-Control': 'no-cache',
      'Content-Type': 'text/event-stream',
      'X-Accel-Buffering': 'no',
    },
    status: 200,
  });
}
