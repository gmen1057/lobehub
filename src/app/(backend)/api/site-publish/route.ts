/**
 * Site publish endpoint: publishes an HTML artifact as a live site on
 * *.jhunterpro.ru via the image-studio backend (plan user-sites-publishing).
 *
 * Flow (same auth channel as artifact-export):
 *  1. Read `arckep_token` cookie (JWT from arckep.ru)
 *  2. Validate it via image-studio `/api/auth/validate` → user_id
 *  3. POST to image-studio `/api/chat/site-publish` with X-Arckep-Token,
 *     user_id, html, title and optional site_id (republish → new version)
 *  4. Return JSON { site_id, slug, url, version } to the browser
 *
 * Used by: src/features/Portal/Artifacts/Title.tsx publish button.
 */
import { type NextRequest } from 'next/server';

const IMAGE_STUDIO_BASE = 'http://127.0.0.1:8202';
const HOST_ALLOWLIST = new Set(['127.0.0.1', 'localhost']);
const MAX_HTML_BYTES = 600_000; // 500 KB artifact cap + overhead

interface PublishRequestBody {
  html: string;
  site_id?: number;
  slug?: string;
  title?: string;
}

const getInternalToken = () =>
  process.env.ARCKEP_INTERNAL_TOKEN || process.env.LOBECHAT_BACKEND_KEY;

const getBackendUrl = (): string | null => {
  const base = process.env.IMAGE_STUDIO_API_URL || IMAGE_STUDIO_BASE;
  try {
    const url = new URL(base);
    if (!HOST_ALLOWLIST.has(url.hostname)) {
      console.error('[site-publish] backend host not in allowlist:', url.hostname);
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

  // Validate cookie → user_id via image-studio
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
    console.error('[site-publish] auth validate failed:', error);
    return Response.json({ error: 'Auth validation failed' }, { status: 502 });
  }

  // Parse + validate body
  let body: PublishRequestBody;
  try {
    body = (await req.json()) as PublishRequestBody;
  } catch {
    return Response.json({ error: 'Bad JSON' }, { status: 400 });
  }
  if (!body.html || typeof body.html !== 'string') {
    return Response.json({ error: 'html required' }, { status: 400 });
  }
  if (body.html.length > MAX_HTML_BYTES) {
    return Response.json({ error: 'html too large (max 500KB)' }, { status: 413 });
  }
  if (body.site_id !== undefined && !Number.isInteger(body.site_id)) {
    return Response.json({ error: 'site_id must be an integer' }, { status: 400 });
  }

  // Forward to image-studio (snake_case Pydantic body)
  const forwardBody = {
    html: body.html,
    site_id: body.site_id,
    // Desired address: backend normalizes/validates, ignored on republish
    slug: typeof body.slug === 'string' && body.slug.trim() ? body.slug.slice(0, 80) : undefined,
    title: typeof body.title === 'string' ? body.title.slice(0, 200) : '',
    user_id: Number(userId),
  };

  let upstream: Response;
  try {
    upstream = await fetch(`${backend}/api/chat/site-publish`, {
      body: JSON.stringify(forwardBody),
      headers: {
        'Content-Type': 'application/json',
        'X-Arckep-Token': token,
      },
      method: 'POST',
      // S3 upload + vitrina sync queue — fast; cert issuance is async server-side
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    console.error('[site-publish] backend call failed:', error);
    return Response.json({ error: 'Publish service unreachable' }, { status: 502 });
  }

  // Pass through the response (status + body)
  const text = await upstream.text();
  return new Response(text, {
    headers: { 'Content-Type': upstream.headers.get('content-type') || 'application/json' },
    status: upstream.status,
  });
}
