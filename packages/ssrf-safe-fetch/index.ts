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

const createAbortError = (reason: unknown, fallbackMessage: string): Error => {
  if (reason instanceof Error) return reason;
  const err = new Error(typeof reason === 'string' && reason ? reason : fallbackMessage);
  err.name = 'AbortError';
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

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let onCallerAbort: (() => void) | undefined;
  let timedOut = false;

  try {
    // Configure SSRF protection options with proper precedence using nullish coalescing
    const envAllowPrivate = process.env.SSRF_ALLOW_PRIVATE_IP_ADDRESS === '1';
    const allowPrivate = ssrfOptions?.allowPrivateIPAddress ?? envAllowPrivate;

    const agentOptions: RequestFilteringAgentOptions = {
      allowIPAddressList:
        ssrfOptions?.allowIPAddressList ??
        process.env.SSRF_ALLOW_IP_ADDRESS_LIST?.split(',').filter(Boolean) ??
        [],
      allowMetaIPAddress: allowPrivate,
      allowPrivateIPAddress: allowPrivate,
      denyIPAddressList: [],
    };

    // Create agents for both protocols
    const httpAgent = new RequestFilteringHttpAgent(agentOptions);
    const httpsAgent = new RequestFilteringHttpsAgent(agentOptions);

    let effectiveSignal: AbortSignal | undefined = callerSignal ?? undefined;
    let abortPromise: Promise<never> | undefined;

    if (hasTimeout) {
      const controller = new AbortController();
      effectiveSignal = controller.signal;

      let rejectOnAbort: ((err: Error) => void) | undefined;
      abortPromise = new Promise<never>((_, reject) => {
        rejectOnAbort = reject;
      });
      // Prevent unhandled rejections if the underlying request settles or fails first
      abortPromise.catch(() => {});

      const triggerAbort = (err: Error) => {
        if (!controller.signal.aborted) {
          controller.abort(err);
        }
        rejectOnAbort?.(err);
      };

      if (callerSignal) {
        if (callerSignal.aborted) {
          const abortErr = createAbortError(callerSignal.reason, 'The operation was aborted');
          triggerAbort(abortErr);
          throw abortErr;
        }
        onCallerAbort = () => {
          triggerAbort(createAbortError(callerSignal.reason, 'The operation was aborted'));
        };
        callerSignal.addEventListener('abort', onCallerAbort, { once: true });
      }

      timeoutId = setTimeout(() => {
        timedOut = true;
        const timeoutErr = new Error(`Request timed out after ${timeoutMs}ms`);
        timeoutErr.name = 'AbortError';
        triggerAbort(timeoutErr);
      }, timeoutMs);
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
    const errorMessage = timedOut
      ? `Request timed out after ${timeoutMs}ms`
      : error instanceof Error
        ? error.message
        : String(error);
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
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
    if (callerSignal && onCallerAbort) {
      callerSignal.removeEventListener('abort', onCallerAbort);
    }
  }
};
