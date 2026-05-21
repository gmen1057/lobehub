import { type ChatCompletionErrorPayload, type ModelRuntime } from '@lobechat/model-runtime';
import { AgentRuntimeError } from '@lobechat/model-runtime';
import { context as otContext } from '@lobechat/observability-otel/api';
import { type ClientSecretPayload } from '@lobechat/types';
import { ChatErrorType } from '@lobechat/types';
import { getXorPayload } from '@lobechat/utils/server';

import { auth } from '@/auth';
import { getServerDB } from '@/database/core/db-adaptor';
import { type LobeChatDatabase } from '@/database/type';
import { LOBE_CHAT_AUTH_HEADER, LOBE_CHAT_OIDC_AUTH_HEADER } from '@/envs/auth';
import { validateArckepToken } from '@/libs/arckep/validateToken';
import { extractTraceContext, injectActiveTraceHeaders } from '@/libs/observability/traceparent';
import { validateOIDCJWT } from '@/libs/oidc-provider/jwt';
import { createErrorResponse } from '@/utils/errorResponse';

import { checkAuthMethod } from './utils';

type CreateRuntime = (jwtPayload: ClientSecretPayload) => ModelRuntime;
type RequestOptions = { createRuntime?: CreateRuntime; params: Promise<{ provider?: string }> };

export type RequestHandler = (
  req: Request,
  options: RequestOptions & {
    jwtPayload: ClientSecretPayload;
    serverDB: LobeChatDatabase;
    userId: string;
  },
) => Promise<Response>;

export const checkAuth =
  (handler: RequestHandler) => async (req: Request, options: RequestOptions) => {
    // Clone the request to avoid "Response body object should not be disturbed or locked" error
    // in Next.js 16 when the body stream has been consumed by Next.js internal mechanisms
    // This ensures the handler can safely read the request body
    const clonedReq = req.clone();

    // Get serverDB for database access
    const serverDB = await getServerDB();

    // we have a special header to debug the api endpoint in development mode
    const isDebugApi = req.headers.get('lobe-auth-dev-backend-api') === '1';
    if (process.env.NODE_ENV === 'development' && isDebugApi) {
      return handler(clonedReq, {
        ...options,
        jwtPayload: { userId: 'DEV_USER' },
        serverDB,
        userId: 'DEV_USER',
      });
    }

    // arckep: tie BetterAuth session lifetime to arckep_token cookie freshness
    // AND to ban state. The backend validate also rejects banned users, so
    // 'expired' here covers both "JWT past exp" and "user banned mid-session".
    //
    // - expired/missing → seamless 302 to /api/bridge?return=<original>. Bridge
    //   will refresh the token if it can (live BetterAuth session + non-banned
    //   user) and bounce back here, otherwise it kicks to arckep.ru/login. The
    //   user never sees the raw "Unauthorized — please sign in again" toast.
    //
    // - unreachable → 503. The previous fail-open turned any backend hiccup
    //   into a window where banned users keep working and the cache mask
    //   silently extends. Reliability of /api/auth/validate is solved
    //   separately, not by widening the auth gap.
    const arckepStatus = await validateArckepToken(req);
    if (arckepStatus === 'unreachable') {
      return new Response(JSON.stringify({ error: 'auth backend temporarily unavailable' }), {
        headers: { 'Content-Type': 'application/json', 'Retry-After': '5' },
        status: 503,
      });
    }
    if (arckepStatus === 'expired' || arckepStatus === 'missing') {
      try {
        await auth.api.signOut({ headers: req.headers });
      } catch {
        /* signOut is best-effort */
      }

      // Build a same-origin return URL from the Referer (only honored when
      // it points at chat.arckep.ru itself — protects against an open
      // redirect via header injection).
      const referer = req.headers.get('referer');
      let returnPath = '/chat/';
      if (referer) {
        try {
          const refUrl = new URL(referer);
          if (refUrl.host === req.headers.get('host') && refUrl.pathname.startsWith('/chat')) {
            returnPath = refUrl.pathname + refUrl.search;
          }
        } catch {
          /* keep default */
        }
      }

      // Hardcode the canonical chat origin instead of trusting the Host
      // header — a `Host: arckep.ru@evil` would otherwise let an
      // attacker steer the Location to evil.com.
      const bridgeUrl = `https://arckep.ru/chat/api/bridge?return=${encodeURIComponent(returnPath)}`;

      // checkAuth wraps SSE/JSON API endpoints (/webapi/chat/*, etc.). A
      // 302 there is harmful: browser fetch follows it, the bridge HTML
      // ends up parsed as an SSE stream and the chat fails opaquely. So
      // we return a 401 with X-Bridge-Location, which the LobeChat client
      // can act on (e.g. window.location.assign). 302 is only safe for
      // actual document navigation, where the browser does the redirect
      // itself — detected via Accept including text/html.
      const accept = req.headers.get('accept') || '';
      const isDocumentNav = accept.includes('text/html');
      if (isDocumentNav) {
        return new Response(null, {
          headers: { Location: bridgeUrl },
          status: 302,
        });
      }
      return new Response(
        JSON.stringify({
          bridge_url: bridgeUrl,
          error: 'arckep session expired',
        }),
        {
          headers: {
            'Content-Type': 'application/json',
            'X-Bridge-Location': bridgeUrl,
          },
          status: 401,
        },
      );
    }

    let jwtPayload: ClientSecretPayload;

    try {
      // get Authorization from header
      const authorization = req.headers.get(LOBE_CHAT_AUTH_HEADER);

      // better auth handler
      const session = await auth.api.getSession({
        headers: req.headers,
      });

      const betterAuthAuthorized = !!session?.user?.id;

      if (!authorization) throw AgentRuntimeError.createError(ChatErrorType.Unauthorized);

      jwtPayload = getXorPayload(authorization);

      const oidcAuthorization = req.headers.get(LOBE_CHAT_OIDC_AUTH_HEADER);
      let isUseOidcAuth = false;
      if (!!oidcAuthorization) {
        const oidc = await validateOIDCJWT(oidcAuthorization);

        isUseOidcAuth = true;

        jwtPayload = {
          ...jwtPayload,
          userId: oidc.userId,
        };
      }

      if (!isUseOidcAuth)
        checkAuthMethod({
          apiKey: jwtPayload.apiKey,
          betterAuthAuthorized,
        });
    } catch (e) {
      const params = await options.params;

      // if the error is not a ChatCompletionErrorPayload, it means the application error
      if (!(e as ChatCompletionErrorPayload).errorType) {
        if ((e as any).code === 'ERR_JWT_EXPIRED')
          return createErrorResponse(ChatErrorType.SystemTimeNotMatchError, e);

        // other issue will be internal server error
        console.error(e);
        return createErrorResponse(ChatErrorType.InternalServerError, {
          error: e,
          provider: params?.provider,
        });
      }

      const {
        errorType = ChatErrorType.InternalServerError,
        error: errorContent,
        ...res
      } = e as ChatCompletionErrorPayload;

      const error = errorContent || e;

      return createErrorResponse(errorType, { error, ...res, provider: params?.provider });
    }

    // Fallback to BetterAuth session userId when JWT payload only carries an
    // API key (happens when the frontend forwards a key-auth header without
    // a userId). Without this fallback, downstream models try to insert rows
    // with user_id='' and hit FK violations.
    let userId = jwtPayload.userId || '';
    if (!userId) {
      try {
        const session = await auth.api.getSession({ headers: req.headers });
        userId = session?.user?.id || '';
      } catch {
        /* empty */
      }
    }
    if (!userId) {
      return createErrorResponse(ChatErrorType.Unauthorized, {
        error: 'Missing userId — session required',
        provider: (await options.params)?.provider,
      });
    }

    const extractedContext = extractTraceContext(req.headers);

    const res = await otContext.with(extractedContext, () =>
      handler(clonedReq, { ...options, jwtPayload, serverDB, userId }),
    );

    // Only inject trace headers when the handler returns a Response
    // NOTICE: this is related to src/app/(backend)/webapi/chat/[provider]/route.test.ts
    if (!(res instanceof Response)) {
      console.warn(
        'Response is not an instance of Response, skipping trace header injection. Possibly bug or mocked response in tests, please check and make sure this is intended behavior.',
      );
      return res;
    }

    try {
      const headers = new Headers(res.headers);
      const traceparent = injectActiveTraceHeaders(headers);
      if (!traceparent) {
        return res;
      }

      return new Response(res.body, { headers, status: res.status, statusText: res.statusText });
    } catch (err) {
      console.error('Failed to inject trace headers:', err);
      return res;
    }
  };
