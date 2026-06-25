import debug from 'debug';
import { type NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { UAParser } from 'ua-parser-js';
import urlJoin from 'url-join';

import { auth } from '@/auth';
import { LOBE_LOCALE_COOKIE } from '@/const/locale';
import { appEnv } from '@/envs/app';
import { authEnv } from '@/envs/auth';
import { validateArckepToken } from '@/libs/arckep/validateToken';
import { type Locales } from '@/locales/resources';
import { parseBrowserLanguage } from '@/utils/locale';
import { RouteVariants } from '@/utils/server/routeVariants';

import { nextjsOnlyRoutes } from '../nextjsOnlyRoutes';
import { createRouteMatcher } from './createRouteMatcher';

// Create debug logger instances
const logDefault = debug('middleware:default');
const logBetterAuth = debug('middleware:better-auth');

// Dev-only debug proxy route should bypass all middleware rewrites.
const dangerousLocalDevProxyRoute = '/_dangerous_local_dev_proxy';

export function defineConfig() {
  const backendApiEndpoints = ['/api', '/trpc', '/webapi', '/oidc'];

  const defaultMiddleware = (request: NextRequest) => {
    const url = request.nextUrl.clone();
    logDefault('Processing request: %s %s', request.method, request.url);

    // skip all api requests
    if (backendApiEndpoints.some((path) => url.pathname.startsWith(path))) {
      logDefault('Skipping API request: %s', url.pathname);
      return NextResponse.next();
    }

    // locale has three levels
    // 1. search params
    // 2. cookie
    // 3. browser

    // highest priority is explicitly in search params, like ?hl=zh-CN
    const explicitlyLocale = (url.searchParams.get('hl') || undefined) as Locales | undefined;

    // if it's a new user, there's no cookie, So we need to use the fallback language parsed by accept-language
    const browserLanguage = parseBrowserLanguage(request.headers);

    const locale =
      explicitlyLocale ||
      ((request.cookies.get(LOBE_LOCALE_COOKIE)?.value || browserLanguage) as Locales);

    const ua = request.headers.get('user-agent');

    const device = new UAParser(ua || '').getDevice();

    logDefault('User preferences: %O', {
      browserLanguage,
      deviceType: device.type,
      hasCookies: {
        locale: !!request.cookies.get(LOBE_LOCALE_COOKIE)?.value,
      },
      locale,
    });

    // 2. Create normalized preference values
    const route = RouteVariants.serializeVariants({
      isMobile: device.type === 'mobile',
      locale: locale as any,
    });

    logDefault('Serialized route variant: %s', route);

    // if app is in docker, rewrite to self container
    // https://github.com/lobehub/lobe-chat/issues/5876
    if (appEnv.MIDDLEWARE_REWRITE_THROUGH_LOCAL) {
      logDefault('Local container rewrite enabled: %O', {
        host: '127.0.0.1',
        original: url.toString(),
        port: process.env.PORT || '3210',
        protocol: 'http',
      });

      url.protocol = 'http';
      url.host = '127.0.0.1';
      url.port = process.env.PORT || '3210';
    }

    if (
      url.pathname === dangerousLocalDevProxyRoute ||
      url.pathname.startsWith(`${dangerousLocalDevProxyRoute}/`)
    ) {
      logDefault('Skipping rewrite for dangerous local dev proxy route: %s', url.pathname);
      return NextResponse.next();
    }

    const isNextjsRoute = nextjsOnlyRoutes.some((r) => url.pathname.startsWith(r));

    // SPA routes: rewrite to /spa/[variants]/[...path] catch-all
    if (!isNextjsRoute) {
      const spaPath = `/spa/${route}${url.pathname === '/' ? '' : url.pathname}`;
      logDefault('SPA route, rewriting to: %s', spaPath);
      url.pathname = spaPath;

      const response = NextResponse.rewrite(url);

      // If locale explicitly provided via query (?hl=), persist it in cookie
      if (explicitlyLocale) {
        const existingLocale = request.cookies.get(LOBE_LOCALE_COOKIE)?.value as
          | Locales
          | undefined;
        if (!existingLocale) {
          response.cookies.set(LOBE_LOCALE_COOKIE, explicitlyLocale, {
            maxAge: 60 * 60 * 24 * 90,
            path: '/',
            sameSite: 'lax',
            secure: process.env.NODE_ENV === 'production',
          });
        }
      }

      return response;
    }

    // Next.js App Router routes: rewrite with variants prefix
    const nextPathname = `/${route}` + (url.pathname === '/' ? '' : url.pathname);
    const nextURL = appEnv.MIDDLEWARE_REWRITE_THROUGH_LOCAL
      ? urlJoin(url.origin, nextPathname)
      : nextPathname;

    logDefault('URL rewrite: %O', {
      isLocalRewrite: appEnv.MIDDLEWARE_REWRITE_THROUGH_LOCAL,
      nextPathname,
      nextURL,
      originalPathname: url.pathname,
    });

    url.pathname = nextPathname;

    logDefault('nextURL after rewrite: %s', url.toString());
    // build rewrite response first
    const rewrite = NextResponse.rewrite(url, { status: 200 });

    // If locale explicitly provided via query (?hl=), persist it in cookie when user has no prior preference
    if (explicitlyLocale) {
      const existingLocale = request.cookies.get(LOBE_LOCALE_COOKIE)?.value as Locales | undefined;
      if (!existingLocale) {
        rewrite.cookies.set(LOBE_LOCALE_COOKIE, explicitlyLocale, {
          // 90 days is a balanced persistence for locale preference
          maxAge: 60 * 60 * 24 * 90,

          path: '/',
          sameSite: 'lax',
          secure: process.env.NODE_ENV === 'production',
        });
        logDefault('Persisted explicit locale to cookie (no prior cookie): %s', explicitlyLocale);
      } else {
        logDefault(
          'Locale cookie exists (%s), skip overwrite with %s',
          existingLocale,
          explicitlyLocale,
        );
      }
    }

    return rewrite;
  };

  const isPublicRoute = createRouteMatcher([
    // backend api
    '/api/v1(.*)', // OpenAPI routes should use OpenAPI auth (API Key/OIDC), not BetterAuth session
    '/api/auth(.*)',
    '/api/bridge(.*)', // arckep.ru SSO bridge — creates Better Auth session from X-User-Id
    '/api/webhooks(.*)',
    '/api/bot-tool(.*)', // arckep «Мои боты» on/off bridge — server-to-server, self-authed via X-Arckep-Token (no BetterAuth session)
    '/api/video-send(.*)', // arckep video→Telegram bridge — server-to-server, self-authed via X-Arckep-Token
    '/api/workflows(.*)',
    '/api/agent(.*)',
    '/api/dev(.*)',
    '/webapi(.*)',
    '/trpc(.*)',
    // version
    '/api/version',
    '/api/desktop/(.*)',
    // better auth
    '/signin',
    '/signup',
    '/auth-error',
    '/verify-email',
    '/reset-password',
    // oauth
    // Make only the consent view public (GET page), not other oauth paths
    '/oauth/consent/(.*)',
    '/oidc/handoff',
    '/oidc/device/auth',
    '/oidc/token',
    // market
    '/market-auth-callback',
    // public share pages
    '/share(.*)',
  ]);

  const betterAuthMiddleware = async (req: NextRequest) => {
    logBetterAuth('BetterAuth middleware processing request: %s %s', req.method, req.url);

    const response = defaultMiddleware(req);

    // when enable auth protection, only public route is not protected, others are all protected
    const isProtected = !isPublicRoute(req);

    logBetterAuth('Route protection status: %s, %s', req.url, isProtected ? 'protected' : 'public');

    // Skip session lookup for public routes to reduce latency
    if (!isProtected) return response;

    // Get full session with user data (Next.js 15.2.0+ feature)
    const session = await auth.api.getSession({
      headers: req.headers,
    });

    const isLoggedIn = !!session?.user;

    logBetterAuth('BetterAuth session status: %O', {
      isLoggedIn,
      userId: session?.user?.id,
    });

    const redirectToBridge = async () => {
      try {
        await auth.api.signOut({ headers: req.headers });
      } catch (err) {
        logBetterAuth('signOut failed', err);
      }
      const bridgeUrl = new URL('/chat/api/bridge', appEnv.APP_URL);
      const fullPath = (req.nextUrl.basePath || '') + req.nextUrl.pathname + req.nextUrl.search;
      bridgeUrl.searchParams.set('return', fullPath);
      return Response.redirect(bridgeUrl);
    };

    if (isLoggedIn && session?.user?.email) {
      // arckep: Check for account switch when user is already logged into BetterAuth
      const arckepToken = req.cookies.get('arckep_token')?.value;
      if (arckepToken) {
        const arckepResult = await validateArckepToken(req);
        if (arckepResult.status === 'valid') {
          const expectedEmail = `user${arckepResult.userId}@arckep.ru`;
          if (session.user.email !== expectedEmail) {
            logBetterAuth(
              'Account switch detected in middleware! Expected %s, got %s',
              expectedEmail,
              session.user.email,
            );
            return redirectToBridge();
          }
        } else if (arckepResult.status === 'expired' || arckepResult.status === 'missing') {
          logBetterAuth('arckep_token expired or missing for active session, forcing re-bridge');
          return redirectToBridge();
        }
      } else {
        // Active LobeChat session but arckep_token is completely gone — clear session and force login
        logBetterAuth('Active BetterAuth session but arckep_token cookie is missing, signing out');
        return redirectToBridge();
      }
    }

    if (!isLoggedIn) {
      // If request a protected route, redirect to sign-in page
      if (isProtected) {
        // arckep.ru SSO bridge: check for arckep_token cookie
        const arckepToken = req.cookies.get('arckep_token')?.value;
        if (arckepToken) {
          // User is logged into arckep.ru — redirect to bridge for auto-login
          logBetterAuth('arckep_token found, redirecting to bridge');
          return redirectToBridge();
        }

        // No arckep session — redirect to main site login
        logBetterAuth('No session, redirecting to arckep.ru login');
        const loginUrl = new URL('https://arckep.ru/login');
        const currentPath =
          (req.nextUrl.basePath || '') + req.nextUrl.pathname + req.nextUrl.search;
        loginUrl.searchParams.set(
          'redirect',
          `https://arckep.ru/chat/api/bridge?return=${encodeURIComponent(currentPath)}`,
        );
        return Response.redirect(loginUrl);
      }
      logBetterAuth('Request a free route but not login, allow visit without auth header');
    }

    return response;
  };

  logDefault('Middleware configuration: %O', { enableOIDC: authEnv.ENABLE_OIDC });

  return { middleware: betterAuthMiddleware };
}
