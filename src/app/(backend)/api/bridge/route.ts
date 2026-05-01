/**
 * Bridge endpoint: creates a Better-Auth session for arckep.ru users.
 *
 * Flow:
 * 1. Reads arckep_token cookie (JWT from arckep.ru)
 * 2. Validates JWT via backend /api/auth/validate → gets userId
 * 3. Calls Better Auth sign-up + sign-in via internal HTTP
 * 4. Returns raw Response(302) with Set-Cookie headers copied from sign-in
 *
 * IMPORTANT: Uses `new Response()` not `NextResponse.redirect()` because
 * NextResponse drops manually appended Set-Cookie headers on redirects.
 *
 * Verified on: LobeChat v2.1.46, Better Auth 1.4.x
 * Contract: POST /api/auth/sign-up/email + POST /api/auth/sign-in/email
 */
import { type NextRequest } from 'next/server';

const INTERNAL_URL = 'http://127.0.0.1:' + (process.env.PORT || '3402');

export async function GET(req: NextRequest) {
  const authSecret = process.env.AUTH_SECRET;
  if (!authSecret) {
    console.error('Bridge: AUTH_SECRET is not set');
    return Response.json({ error: 'Server configuration error' }, { status: 500 });
  }

  // Read arckep_token from cookie
  const arckepToken = req.cookies.get('arckep_token')?.value;
  if (!arckepToken) {
    return Response.redirect(
      'https://arckep.ru/?login=1&redirect=https://chat.arckep.ru/api/bridge',
      302,
    );
  }

  // Validate JWT via our backend
  let userId: string;
  try {
    const validateRes = await fetch('http://127.0.0.1:8202/api/auth/validate', {
      headers: { Cookie: `arckep_token=${arckepToken}` },
    });
    if (!validateRes.ok) {
      return Response.redirect(
        'https://arckep.ru/?login=1&redirect=https://chat.arckep.ru/api/bridge',
        302,
      );
    }
    userId = validateRes.headers.get('X-User-Id') || '';
    if (!userId) {
      return Response.redirect(
        'https://arckep.ru/?login=1&redirect=https://chat.arckep.ru/api/bridge',
        302,
      );
    }
  } catch {
    console.error('Bridge: failed to validate arckep token');
    return Response.redirect(
      'https://arckep.ru/?login=1&redirect=https://chat.arckep.ru/api/bridge',
      302,
    );
  }

  const email = `user${userId}@arckep.ru`;
  const password = `arckep_bridge_${userId}_${authSecret.slice(0, 8)}`;

  try {
    // Sign-up via HTTP (idempotent)
    await fetch(`${INTERNAL_URL}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, name: `User ${userId}`, password }),
    }).catch(() => {});

    // Sign-in via HTTP — returns proper Set-Cookie headers
    const signInRes = await fetch(`${INTERNAL_URL}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    if (!signInRes.ok) {
      console.error('Bridge: sign-in failed', signInRes.status);
      return Response.json({ error: 'Session creation failed' }, { status: 500 });
    }

    // Build redirect URL (validate to prevent open redirect)
    let returnUrl = req.nextUrl.searchParams.get('return') || '/';
    if (!returnUrl.startsWith('/') || returnUrl.startsWith('//')) {
      returnUrl = '/';
    }
    const redirectUrl = new URL(returnUrl, `https://${req.headers.get('host')}`).toString();

    // Build raw Response with Set-Cookie headers
    // Using new Response() instead of NextResponse.redirect() because
    // NextResponse drops manually appended Set-Cookie on redirects
    const headers = new Headers();
    headers.set('Location', redirectUrl);

    // Copy session cookies from Better Auth
    const setCookies = signInRes.headers.getSetCookie?.() || [];
    for (const cookie of setCookies) {
      headers.append('Set-Cookie', cookie);
    }

    // Add locale cookie
    headers.append('Set-Cookie', 'LOBE_LOCALE=ru-RU; Path=/; Max-Age=31536000; SameSite=Lax');

    // arckep: refresh arckep_token cookie so its TTL keeps pace with the
    // BetterAuth session we just (re-)created. Without this, the cookie can
    // expire while the chat session is still alive — breaking the balance
    // widget and any other arckep-cookie-gated endpoint until the next
    // arckep.ru visit.
    try {
      const refreshRes = await fetch('http://127.0.0.1:8202/api/auth/refresh-token', {
        method: 'POST',
        headers: { Cookie: `arckep_token=${arckepToken}` },
      });
      if (refreshRes.ok) {
        const refreshed = (await refreshRes.json()) as {
          access_token: string;
          expires_in_minutes: number;
        };
        const maxAgeSec = Math.max(60, refreshed.expires_in_minutes * 60);
        headers.append(
          'Set-Cookie',
          `arckep_token=${refreshed.access_token}; Domain=.arckep.ru; Path=/; ` +
            `Max-Age=${maxAgeSec}; SameSite=Lax; Secure; HttpOnly`,
        );
      }
    } catch (refreshErr) {
      // Non-fatal — user can keep using chat with the old cookie until next visit
      console.warn('Bridge: arckep_token refresh failed', refreshErr);
    }

    return new Response(null, { status: 302, headers });
  } catch (error) {
    console.error('Bridge auth error:', error);
    return Response.json({ error: 'Session creation failed' }, { status: 500 });
  }
}
