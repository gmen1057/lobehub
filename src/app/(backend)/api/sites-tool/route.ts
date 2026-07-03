/**
 * Sites tool endpoint for the CLIENT-side chat flow: list/read the user's
 * published ArcKep sites (plan user-sites-publishing, Phase 7 follow-up).
 *
 * Plain 1-on-1 chat executes builtin tools in the browser (Tool Store
 * executor registry) — the server runtime in services/toolExecution only
 * serves the server agent loop (group chats, background agents). This route
 * gives the browser executor an authenticated path to the same data.
 *
 * Flow (same auth channel as site-publish):
 *  1. Read `arckep_token` cookie (JWT from arckep.ru)
 *  2. Validate it via image-studio `/api/auth/validate` → user_id
 *  3. POST to image-studio `/api/chat/sites-tool/{list,read,generate-image}` with the
 *     internal token
 *
 * Used by: src/store/tool/slices/builtin/executors/arckep-sites.ts
 */
import { type NextRequest } from 'next/server';

const IMAGE_STUDIO_BASE = 'http://127.0.0.1:8202';
const HOST_ALLOWLIST = new Set(['127.0.0.1', 'localhost']);

interface SitesToolRequestBody {
  action: 'design-brief' | 'generate-image' | 'list' | 'read' | 'telegram-connect-link';
  // generate-image fields (model-supplied only — user_id injected server-side)
  aspect_ratio?: 'landscape' | 'portrait' | 'square';
  // design-brief fields
  business?: string;
  prompt?: string;
  quality?: 'high' | 'standard';
  session_id?: string;
  // read field
  site_id?: number;
  style_id?: string;
  topic_id?: string;
}

const getInternalToken = () =>
  process.env.ARCKEP_INTERNAL_TOKEN || process.env.LOBECHAT_BACKEND_KEY;

const getBackendUrl = (): string | null => {
  const base = process.env.IMAGE_STUDIO_API_URL || IMAGE_STUDIO_BASE;
  try {
    const url = new URL(base);
    if (!HOST_ALLOWLIST.has(url.hostname)) {
      console.error('[sites-tool] backend host not in allowlist:', url.hostname);
      return null;
    }
    return base.replace(/\/$/, '');
  } catch {
    return null;
  }
};

export async function POST(req: NextRequest) {
  const token = getInternalToken();
  if (!token) {
    return Response.json({ error: 'Internal token not configured' }, { status: 500 });
  }
  const backend = getBackendUrl();
  if (!backend) {
    return Response.json({ error: 'Backend host invalid' }, { status: 500 });
  }

  const arckepToken = req.cookies.get('arckep_token')?.value;
  if (!arckepToken) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 });
  }

  let userId: string;
  try {
    const v = await fetch(`${backend}/api/auth/validate`, {
      headers: { Cookie: `arckep_token=${arckepToken}` },
    });
    if (!v.ok) {
      return Response.json({ error: 'Invalid session' }, { status: 401 });
    }
    userId = v.headers.get('X-User-Id') || '';
    if (!userId) {
      return Response.json({ error: 'No user id from validate' }, { status: 401 });
    }
  } catch (error) {
    console.error('[sites-tool] auth validate failed:', error);
    return Response.json({ error: 'Auth validation failed' }, { status: 502 });
  }

  let body: SitesToolRequestBody;
  try {
    body = (await req.json()) as SitesToolRequestBody;
  } catch {
    return Response.json({ error: 'Bad JSON' }, { status: 400 });
  }

  let path: string;
  let forwardBody: Record<string, unknown>;
  if (body.action === 'list') {
    path = '/api/chat/sites-tool/list';
    forwardBody = { user_id: Number(userId) };
  } else if (body.action === 'read' && Number.isInteger(body.site_id)) {
    path = '/api/chat/sites-tool/read';
    forwardBody = { site_id: body.site_id, user_id: Number(userId) };
  } else if (body.action === 'generate-image' && typeof body.prompt === 'string' && body.prompt) {
    path = '/api/chat/sites-tool/generate-image';
    // user_id injected here from the authenticated session — never from the model
    forwardBody = {
      aspect_ratio: body.aspect_ratio ?? 'landscape',
      prompt: body.prompt,
      quality: body.quality ?? 'standard',
      user_id: Number(userId),
      session_id: typeof body.session_id === 'string' ? body.session_id.slice(0, 64) : undefined,
      topic_id: typeof body.topic_id === 'string' ? body.topic_id.slice(0, 64) : undefined,
    };
  } else if (body.action === 'design-brief') {
    path = '/api/chat/sites-tool/design-brief';
    forwardBody = {
      business: typeof body.business === 'string' ? body.business.slice(0, 200) : undefined,
      style_id: typeof body.style_id === 'string' ? body.style_id.slice(0, 40) : undefined,
      user_id: Number(userId),
    };
  } else if (body.action === 'telegram-connect-link') {
    path = '/api/chat/sites-tool/telegram-connect-link';
    forwardBody = { user_id: Number(userId) };
  } else {
    return Response.json(
      {
        error:
          'action must be list, read (with integer site_id), generate-image (with prompt), or telegram-connect-link',
      },
      { status: 400 },
    );
  }

  // Image generation can take up to 90 s for high-quality models; other ops are fast.
  const timeoutMs = body.action === 'generate-image' ? 120_000 : 30_000;

  let upstream: Response;
  try {
    upstream = await fetch(`${backend}${path}`, {
      body: JSON.stringify(forwardBody),
      headers: { 'Content-Type': 'application/json', 'X-Arckep-Token': token },
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    console.error('[sites-tool] backend call failed:', error);
    return Response.json({ error: 'Sites service unreachable' }, { status: 502 });
  }

  const text = await upstream.text();
  return new Response(text, {
    headers: { 'Content-Type': upstream.headers.get('content-type') || 'application/json' },
    status: upstream.status,
  });
}
