/**
 * Artifact export endpoint: forwards artifact HTML to image-studio backend
 * for headless Chromium rendering (PDF or PNG via arckep-render-v1 sandbox).
 *
 * Flow:
 *  1. Read `arckep_token` cookie (JWT from arckep.ru)
 *  2. Validate it via image-studio `/api/auth/validate` → user_id
 *  3. POST to image-studio `/api/chat/artifact-export` with X-Arckep-Token,
 *     user_id, html, format
 *  4. Return JSON { url, file_id, mime_type, size_bytes } to the browser
 *
 * Used by: src/features/Portal/Artifacts/Title.tsx export button.
 */
import { type NextRequest } from 'next/server';

const IMAGE_STUDIO_BASE = 'http://127.0.0.1:8202';
const HOST_ALLOWLIST = new Set(['127.0.0.1', 'localhost']);
const MAX_HTML_BYTES = 600_000; // 500 KB content cap + overhead

interface ExportRequestBody {
  format: 'pdf' | 'png';
  html: string;
  message_id?: string;
  topic_id?: string;
}

const getInternalToken = () =>
  process.env.ARCKEP_INTERNAL_TOKEN || process.env.LOBECHAT_BACKEND_KEY;

const getBackendUrl = (): string | null => {
  const base = process.env.IMAGE_STUDIO_API_URL || IMAGE_STUDIO_BASE;
  try {
    const url = new URL(base);
    if (!HOST_ALLOWLIST.has(url.hostname)) {
      console.error('[artifact-export] backend host not in allowlist:', url.hostname);
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
    console.error('[artifact-export] auth validate failed:', error);
    return Response.json({ error: 'Auth validation failed' }, { status: 502 });
  }

  // Parse + validate body
  let body: ExportRequestBody;
  try {
    body = (await req.json()) as ExportRequestBody;
  } catch {
    return Response.json({ error: 'Bad JSON' }, { status: 400 });
  }
  if (!body.html || typeof body.html !== 'string') {
    return Response.json({ error: 'html required' }, { status: 400 });
  }
  if (body.html.length > MAX_HTML_BYTES) {
    return Response.json({ error: 'html too large (max 500KB)' }, { status: 413 });
  }
  if (body.format !== 'pdf' && body.format !== 'png') {
    return Response.json({ error: 'format must be pdf or png' }, { status: 400 });
  }

  // Forward to image-studio (snake_case Pydantic body)
  const forwardBody = {
    format: body.format,
    html: body.html,
    message_id: body.message_id,
    topic_id: body.topic_id,
    user_id: Number(userId),
  };

  let upstream: Response;
  try {
    upstream = await fetch(`${backend}/api/chat/artifact-export`, {
      body: JSON.stringify(forwardBody),
      headers: {
        'Content-Type': 'application/json',
        'X-Arckep-Token': token,
      },
      method: 'POST',
      // Render takes 5-30s for heavy artifacts (Chromium + JS execution)
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    console.error('[artifact-export] backend call failed:', error);
    return Response.json({ error: 'Render service unreachable' }, { status: 502 });
  }

  // Pass through the response (status + body)
  const text = await upstream.text();
  return new Response(text, {
    headers: { 'Content-Type': upstream.headers.get('content-type') || 'application/json' },
    status: upstream.status,
  });
}
