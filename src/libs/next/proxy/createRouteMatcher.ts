import { type NextRequest } from 'next/server';

/**
 * Creates a route matcher function that checks if a request path matches any of the given patterns
 * @param patterns Array of route patterns - supports `(.*)` as wildcard
 * @returns Function that returns true if the request matches any pattern
 */
export function createRouteMatcher(patterns: string[]) {
  const regexPatterns = patterns.map((pattern) => {
    // Escape all special regex chars (including parentheses), then restore (.*) to wildcard
    const regexStr = pattern
      .replaceAll(/[$()*+.?[\\\]^{|}]/g, '\\$&')
      .replaceAll('\\(\\.\\*\\)', '.*');
    return new RegExp(`^${regexStr}$`);
  });

  return (req: NextRequest) => {
    // arckep: Next.js middleware includes basePath (/chat) in nextUrl.pathname.
    // Patterns are written without basePath, so strip it before matching —
    // otherwise every free route (signin, signup, /api/bridge, …) is treated
    // as protected and the middleware redirects to bridge in a loop.
    const raw = req.nextUrl.pathname;
    const pathname = raw === '/chat' ? '/' : raw.startsWith('/chat/') ? raw.slice(5) : raw;
    return regexPatterns.some((regex) => regex.test(pathname));
  };
}
