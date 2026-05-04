/**
 * arckep_token freshness check for the LobeChat backend middleware.
 *
 * BetterAuth sessions live for 90 days, but our JWT (`arckep_token` cookie)
 * is shorter. Without this check the chat keeps working long after the cookie
 * expires while the balance widget and other arckep-cookie-gated paths blank
 * out. This helper hits our backend `/api/auth/validate` and caches the
 * result so we don't hammer it on every request.
 *
 * The backend `/api/auth/validate` decodes the JWT AND checks
 * banned_identifiers, so 'valid' here also implies the user isn't banned
 * — that's how a banned user gets kicked out within CACHE_TTL_MS even
 * though their JWT is still cryptographically valid.
 *
 * Returned status:
 *   "valid"        — JWT decoded fine and user is not banned
 *   "expired"      — cookie present but JWT rejected OR user banned
 *                    (caller should kill BA session and force re-bridge)
 *   "missing"      — no cookie at all
 *   "unreachable"  — backend unreachable (caller MUST reject — failing open
 *                    here turns a backend blip into a billing-bypass window)
 */

const BACKEND_URL = process.env.LOBECHAT_BACKEND_INTERNAL_URL || 'http://127.0.0.1:8202';
const CACHE_TTL_MS = 60_000;
const VALIDATE_TIMEOUT_MS = 1500;

type CacheEntry = {
  expiresAt: number;
  status: 'valid' | 'expired';
};

const cache = new Map<string, CacheEntry>();

function readArckepCookie(req: Request): string | null {
  const cookieHeader = req.headers.get('cookie');
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === 'arckep_token') return rest.join('=') || null;
  }
  return null;
}

export async function validateArckepToken(
  req: Request,
): Promise<'valid' | 'expired' | 'missing' | 'unreachable'> {
  const token = readArckepCookie(req);
  if (!token) return 'missing';

  const now = Date.now();
  const cached = cache.get(token);
  if (cached && cached.expiresAt > now) return cached.status;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VALIDATE_TIMEOUT_MS);
  try {
    const res = await fetch(`${BACKEND_URL}/api/auth/validate`, {
      headers: { Cookie: `arckep_token=${token}` },
      signal: controller.signal,
    });
    const status: 'valid' | 'expired' = res.ok ? 'valid' : 'expired';
    cache.set(token, { expiresAt: now + CACHE_TTL_MS, status });
    return status;
  } catch {
    return 'unreachable';
  } finally {
    clearTimeout(timer);
  }
}

export function clearArckepValidationCache(): void {
  cache.clear();
}
