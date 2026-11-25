import type * as http from 'node:http';
import type * as https from 'node:https';

import fetch from 'node-fetch';
import type { RequestFilteringAgentOptions } from 'request-filtering-agent';
import { RequestFilteringHttpAgent, RequestFilteringHttpsAgent } from 'request-filtering-agent';

/**
 * Options for per-call SSRF configuration overrides
 */
export interface SSRFOptions {
  /** List of IP addresses to allow */
  allowIPAddressList?: string[];
  /** Whether to allow private/local IP addresses */
  allowPrivateIPAddress?: boolean;
}

/**
 * Extended RequestInit supporting an end-to-end request timeout.
 */
export interface SSRFSafeFetchOptions extends RequestInit {
  /** Optional request timeout in milliseconds covering both headers and response body read */
  timeoutMs?: number;
}

interface AgentPair {
  httpAgent: RequestFilteringHttpAgent;
  httpsAgent: RequestFilteringHttpsAgent;
}

const MAX_AGENT_POOL_SIZE = 32;
const agentPool = new Map<string, AgentPair>();

const getOrCreateAgents = (allowPrivate: boolean, allowIPAddressList: string[]): AgentPair => {
  const normalizedAllowList = [
    ...new Set(allowIPAddressList.map((ip) => ip.trim()).filter(Boolean)),
  ].sort();
  const cacheKey = `${allowPrivate ? '1' : '0'}|${normalizedAllowList.join(',')}`;

  const cached = agentPool.get(cacheKey);
  if (cached) {
    agentPool.delete(cacheKey);
    agentPool.set(cacheKey, cached);
    return cached;
  }

  const agentOptions: http.AgentOptions & https.AgentOptions & RequestFilteringAgentOptions = {
    allowIPAddressList: normalizedAllowList,
    allowMetaIPAddress: allowPrivate,
    allowPrivateIPAddress: allowPrivate,
    denyIPAddressList: [],
    keepAlive: true,
  };

  const pair: AgentPair = {
    httpAgent: new RequestFilteringHttpAgent(agentOptions),
    httpsAgent: new RequestFilteringHttpsAgent(agentOptions),
  };

  if (agentPool.size >= MAX_AGENT_POOL_SIZE) {
    const oldestKey = agentPool.keys().next().value;
    if (oldestKey !== undefined) {
      agentPool.delete(oldestKey);
    }
  }
  agentPool.set(cacheKey, pair);
  return pair;
};

export const clearSSRFAgentPoolForTest = (): void => {
  agentPool.clear();
};

const createCallerAbortError = (reason: unknown, fallbackMessage: string): Error => {
  const message =
    reason instanceof Error
      ? reason.message || fallbackMessage
      : typeof reason === 'string' && reason
        ? reason
        : fallbackMessage;
  const err = new Error(message, reason instanceof Error ? { cause: reason } : undefined);
  err.name = 'AbortError';
  (err as Error & { isCallerAbort?: boolean }).isCallerAbort = true;
  return err;
};

const createTimeoutError = (timeoutMs: number, rawCause?: unknown): Error => {
  const err = new Error(
    `Request timed out after ${timeoutMs}ms`,
    rawCause instanceof Error ? { cause: rawCause } : undefined,
  );
  err.name = 'TimeoutError';
  (err as Error & { isTimeout?: boolean }).isTimeout = true;
  return err;
};

/**
 * SSRF-safe fetch implementation for server-side use
 * Uses request-filtering-agent to prevent requests to private IP addresses
 *
 * @param url - The URL to fetch
 * @param options - Standard fetch options (with optional timeoutMs)
 * @param ssrfOptions - Optional per-call SSRF configuration overrides
 * @see https://lobehub.com/docs/self-hosting/environment-variables/basic#ssrf-allow-private-ip-address
 */
export const ssrfSafeFetch = async (
  url: string,
  options?: SSRFSafeFetchOptions,
  ssrfOptions?: SSRFOptions,
): Promise<Response> => {
  const { signal: callerSignal, timeoutMs, ...restOptions } = options ?? {};
  const hasTimeout = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0;

  let effectiveSignal: AbortSignal | undefined;
  let timeoutSignal: AbortSignal | undefined;
  let onEffectiveAbort: (() => void) | undefined;
  let timedOut = false;

  try {
    if (callerSignal?.aborted) {
      throw createCallerAbortError(callerSignal.reason, 'The operation was aborted');
    }

    // Configure SSRF protection options with proper precedence using nullish coalescing
    const envAllowPrivate = process.env.SSRF_ALLOW_PRIVATE_IP_ADDRESS === '1';
    const allowPrivate = ssrfOptions?.allowPrivateIPAddress ?? envAllowPrivate;
    const rawAllowList =
      ssrfOptions?.allowIPAddressList ??
      process.env.SSRF_ALLOW_IP_ADDRESS_LIST?.split(',').filter(Boolean) ??
      [];

    const { httpAgent, httpsAgent } = getOrCreateAgents(allowPrivate, rawAllowList);

    if (hasTimeout) {
      timeoutSignal = AbortSignal.timeout(timeoutMs);
      effectiveSignal = callerSignal
        ? AbortSignal.any([callerSignal, timeoutSignal])
        : timeoutSignal;
    } else if (callerSignal) {
      effectiveSignal = callerSignal;
    }

    let abortPromise: Promise<never> | undefined;
    if (effectiveSignal) {
      const activeSignal = effectiveSignal;
      const activeTimeoutMs = hasTimeout ? (timeoutMs as number) : 0;
      abortPromise = new Promise<never>((_, reject) => {
        const handleAbort = () => {
          if (timeoutSignal?.aborted && !callerSignal?.aborted) {
            timedOut = true;
            reject(createTimeoutError(activeTimeoutMs, timeoutSignal.reason));
            return;
          }
          if (callerSignal?.aborted) {
            reject(createCallerAbortError(callerSignal.reason, 'The operation was aborted'));
            return;
          }
          if (hasTimeout) {
            timedOut = true;
            reject(createTimeoutError(activeTimeoutMs, activeSignal.reason));
            return;
          }
          reject(createCallerAbortError(activeSignal.reason, 'The operation was aborted'));
        };

        if (activeSignal.aborted) {
          handleAbort();
          return;
        }

        onEffectiveAbort = handleAbort;
        activeSignal.addEventListener('abort', onEffectiveAbort, { once: true });
      });
      // Prevent unhandled rejections if the underlying request settles or fails first
      abortPromise.catch(() => {});
    }

    const requestInit: Record<string, unknown> = {
      ...restOptions,
      agent: (parsedURL: URL) => (parsedURL.protocol === 'https:' ? httpsAgent : httpAgent),
    };
    if (effectiveSignal) {
      requestInit.signal = effectiveSignal;
    }

    // Use node-fetch with SSRF protection agent
    // Pass a function to dynamically select agent based on URL protocol
    // This handles redirects from HTTP to HTTPS correctly
    const fetchPromise = fetch(url, requestInit as any);
    if (abortPromise && fetchPromise && typeof fetchPromise.catch === 'function') {
      fetchPromise.catch(() => {});
    }

    const response = abortPromise
      ? await Promise.race([fetchPromise, abortPromise])
      : await fetchPromise;

    const bufferPromise = response.arrayBuffer();
    if (abortPromise && bufferPromise && typeof bufferPromise.catch === 'function') {
      bufferPromise.catch(() => {});
    }

    const arrayBuffer = abortPromise
      ? await Promise.race([bufferPromise, abortPromise])
      : await bufferPromise;

    // Convert node-fetch Response to standard Response
    return new Response(arrayBuffer, {
      headers: response.headers as any,
      status: response.status,
      statusText: response.statusText,
    });
  } catch (error) {
    const isTimeout =
      timedOut ||
      Boolean(timeoutSignal?.aborted && !callerSignal?.aborted) ||
      (hasTimeout && error instanceof Error && error.name === 'TimeoutError');
    const isCallerAbort =
      !isTimeout &&
      (Boolean(callerSignal?.aborted) ||
        Boolean((error as { isCallerAbort?: boolean } | null)?.isCallerAbort));

    if (isTimeout && hasTimeout) {
      const timeoutCause =
        error instanceof Error && error.name === 'TimeoutError'
          ? error
          : createTimeoutError(timeoutMs, error);
      console.error('Fetch error:', error);
      const wrappedTimeout = new Error(`Fetch failed: Request timed out after ${timeoutMs}ms`, {
        cause: timeoutCause,
      });
      (wrappedTimeout as Error & { isTimeout?: boolean }).isTimeout = true;
      throw wrappedTimeout;
    }

    if (isCallerAbort) {
      const abortCause =
        error instanceof Error &&
        error.name === 'AbortError' &&
        (error as Error & { isCallerAbort?: boolean }).isCallerAbort
          ? error
          : createCallerAbortError(callerSignal?.reason ?? error, 'The operation was aborted');
      console.error('Fetch error:', error);
      const wrappedAbort = new Error(`Fetch failed: ${abortCause.message}`, {
        cause: abortCause,
      });
      wrappedAbort.name = 'AbortError';
      (wrappedAbort as Error & { isCallerAbort?: boolean }).isCallerAbort = true;
      throw wrappedAbort;
    }

    const errorMessage = error instanceof Error ? error.message : String(error);
    // request-filtering-agent errors contain "is not allowed" when blocking private/denied IPs
    const isSSRFBlock = errorMessage.includes('is not allowed');

    if (isSSRFBlock) {
      console.error('SSRF protection blocked request:', error);
      throw new Error(
        `SSRF blocked: ${errorMessage}. ` +
          'See: https://lobehub.com/docs/self-hosting/environment-variables/basic#ssrf-allow-private-ip-address',
        { cause: error },
      );
    }

    console.error('Fetch error:', error);
    throw new Error(`Fetch failed: ${errorMessage}`, { cause: error });
  } finally {
    if (effectiveSignal && onEffectiveAbort) {
      effectiveSignal.removeEventListener('abort', onEffectiveAbort);
    }
  }
};
