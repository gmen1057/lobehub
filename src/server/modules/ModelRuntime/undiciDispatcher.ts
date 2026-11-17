import { DEFAULT_LLM_REQUEST_TIMEOUT_MS } from '@lobechat/model-runtime';
import { Agent, ProxyAgent, setGlobalDispatcher } from 'undici';

let configured = false;

/**
 * Raise Node.js global fetch (undici) headersTimeout and bodyTimeout to 25 minutes
 * so non-streaming LLM requests (generateObject, stream: false via billing_proxy
 * _proxy_simple) are not killed at undici's default 5-minute headersTimeout.
 */
export const ensureServerUndiciDispatcher = (): boolean => {
  if (configured) return false;
  if (
    typeof process === 'undefined' ||
    !process.versions?.node ||
    typeof (globalThis as Record<string, unknown>).EdgeRuntime !== 'undefined'
  ) {
    return false;
  }

  const timeoutOptions = {
    bodyTimeout: DEFAULT_LLM_REQUEST_TIMEOUT_MS,
    headersTimeout: DEFAULT_LLM_REQUEST_TIMEOUT_MS,
  };

  const proxyUrl =
    process.env.NODE_ENV === 'development'
      ? process.env.HTTPS_PROXY ||
        process.env.https_proxy ||
        process.env.HTTP_PROXY ||
        process.env.http_proxy
      : undefined;

  const dispatcher = proxyUrl
    ? new ProxyAgent({ ...timeoutOptions, uri: proxyUrl })
    : new Agent(timeoutOptions);

  setGlobalDispatcher(dispatcher);
  configured = true;
  return true;
};

export const resetServerUndiciDispatcherForTest = () => {
  configured = false;
};
