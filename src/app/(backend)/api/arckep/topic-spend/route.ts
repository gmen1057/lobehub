/**
 * Already-charged RUB for the current LobeChat topic (live run tray).
 * Same auth as /api/arckep/balance: BetterAuth session + internal token.
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

  const url = new URL(req.url);
  const sessionId = url.searchParams.get('session_id') || '';
  const topicId = url.searchParams.get('topic_id') || '';
  if (!sessionId || !topicId) {
    return Response.json({ error: 'Missing session_id or topic_id' }, { status: 400 });
  }

  try {
    const upstream = await fetch(
      `${BACKEND_URL}/api/chat/topic-spend?session_id=${encodeURIComponent(sessionId)}&topic_id=${encodeURIComponent(topicId)}`,
      {
        headers: {
          'X-Arckep-Token': INTERNAL_TOKEN,
          'X-Lobechat-User-Id': userId,
        },
      },
    );
    const body = await upstream.text();
    return new Response(body, {
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': upstream.headers.get('content-type') || 'application/json',
      },
      status: upstream.status,
    });
  } catch (err) {
    console.error('arckep/topic-spend: backend unreachable', err);
    return Response.json({ error: 'Spend service unavailable' }, { status: 502 });
  }
}
