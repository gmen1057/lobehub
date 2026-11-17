/**
 * Default client-side safety timeout for LLM provider HTTP/SDK requests (26 minutes).
 * Kept 60s above Studio billing_proxy upstream timeout (1500s = 25m) and aligned with
 * Gunicorn/Nginx (1560s) so billing_proxy always catches 25m ReadTimeout first and
 * returns a controlled 504 upstream_timeout with retrySafe: false.
 */
export const DEFAULT_LLM_REQUEST_TIMEOUT_MS = 26 * 60 * 1000;

/**
 * Total request + stream body ceiling for @google/genai (30 minutes).
 * Unlike OpenAI/Anthropic fetchWithTimeout, @google/genai's httpOptions.timeout sets
 * a single AbortController timer over the entire stream lifecycle without resetting
 * on incoming chunks; 30m lets a response that started streaming near 25m finish,
 * while billing_proxy still enforces the 25m silence timeout upstream.
 */
export const DEFAULT_GOOGLE_TOTAL_STREAM_TIMEOUT_MS = 30 * 60 * 1000;
