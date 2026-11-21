#!/usr/bin/env node
/**
 * Smart zero-downtime HTTP/SSE Blue-Green router for headless LobeChat engine.
 *
 * Pure Node.js (`node:crypto`, `node:fs`, `node:http`, `node:url`) — zero external dependencies.
 * Listens on 127.0.0.1:3403 (configurable via ROUTER_HOST / ROUTER_PORT) and routes
 * traffic between `blue` (:3411) and `green` (:3412) according to `ROUTER_STATE_FILE`
 * (`/var/lib/lobechat-engine/state.json`), keeping in-flight responses, `_chat_wait`,
 * cron runs, and replay buffers pinned to `drainingPort` until natural completion.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROUTER_SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROUTER_SCRIPT_HASH = (() => {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(ROUTER_SCRIPT_PATH)).digest('hex');
  } catch {
    return 'unknown';
  }
})();

const ROUTER_HOST = process.env.ROUTER_HOST || '127.0.0.1';
const ROUTER_PORT = Number.parseInt(process.env.ROUTER_PORT ?? '3403', 10);
const ROUTER_UPSTREAM_HOST = process.env.ROUTER_UPSTREAM_HOST || '127.0.0.1';
const ROUTER_STATE_FILE = process.env.ROUTER_STATE_FILE || '/var/lib/lobechat-engine/state.json';
const ROUTER_ENV_FILE = process.env.ROUTER_ENV_FILE || '/opt/lobechat-next/.env';
const ROUTER_FALLBACK_KEY_FILE = '/opt/lobechat-next-router/.service-key.env';
const ROUTER_READY_FILE = process.env.ROUTER_READY_FILE || '';
const STATUS_TIMEOUT_MS = Number.parseInt(process.env.ROUTER_STATUS_TIMEOUT_MS ?? '1500', 10);
const SHUTDOWN_TIMEOUT_MS = Number.parseInt(
  process.env.ROUTER_SHUTDOWN_TIMEOUT_MS ?? '1770000',
  10,
);
const MAX_BODY_BYTES = Number.parseInt(
  process.env.ROUTER_MAX_BODY_BYTES ?? String(50 * 1024 * 1024),
  10,
);
const BODY_READ_TIMEOUT_MS = Number.parseInt(
  process.env.ROUTER_BODY_READ_TIMEOUT_MS ?? '30000',
  10,
);
const MAX_TOTAL_BUFFERED_BYTES = Number.parseInt(
  process.env.ROUTER_MAX_TOTAL_BUFFERED_BYTES ?? String(128 * 1024 * 1024),
  10,
);
const OWNS_MESSAGES_MAX_IDS = 20_000;
const OWNS_MESSAGES_CHUNK_SIZE = 1000;
const MIN_SERVICE_KEY_LENGTH = 32;
const STAT_CHECK_INTERVAL_MS = 100;
const MAX_TRACKED_ACTIVE_TOPICS = 50_000;

const upstreamAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 30_000,
  maxFreeSockets: 64,
  maxSockets: 1024,
});

/** @type {{ activeSlot: string; activePort: number; drainingSlot: string | null; drainingPort: number | null; switchEpoch: number }} */
let state = {
  activePort: 3411,
  activeSlot: 'blue',
  drainingPort: null,
  drainingSlot: null,
  switchEpoch: 0,
};

let lastStatCheckAt = 0;
let lastMtimeMs = -1;
let lastIno = -1;
let lastSize = -1;

let currentServiceKey = (process.env.ARCKEP_ENGINE_SERVICE_KEY || '').trim();
let totalBufferedBytes = 0;

/** Topics that already received a 2xx response on `activeSlot` during the current drain epoch. */
const topicsStartedOnActive = new Set();

function rememberTopicOnActive(topicId) {
  if (!topicId) return;
  if (topicsStartedOnActive.size >= MAX_TRACKED_ACTIVE_TOPICS) {
    const oldest = topicsStartedOnActive.values().next().value;
    if (oldest !== undefined) topicsStartedOnActive.delete(oldest);
  }
  topicsStartedOnActive.add(topicId);
}

function parseServiceKeyFromEnvText(rawText) {
  let found = null;
  for (const rawLine of rawText.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim();
    if (line.startsWith('ARCKEP_ENGINE_SERVICE_KEY=')) {
      let val = line.slice('ARCKEP_ENGINE_SERVICE_KEY='.length).trim();
      if (val.length >= 2 && val[0] === val.at(-1) && (val[0] === '"' || val[0] === "'")) {
        val = val.slice(1, -1);
      }
      found = val.trim();
    }
  }
  return found;
}

function reloadServiceKey() {
  const candidates = [ROUTER_ENV_FILE];
  if (ROUTER_ENV_FILE !== ROUTER_FALLBACK_KEY_FILE) {
    candidates.push(ROUTER_FALLBACK_KEY_FILE);
  }
  if (ROUTER_ENV_FILE !== '/opt/lobechat-next/.env') {
    candidates.push('/opt/lobechat-next/.env');
  }

  for (const filePath of candidates) {
    if (!filePath) continue;
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsedKey = parseServiceKeyFromEnvText(raw);
      if (parsedKey !== null && parsedKey.length > 0) {
        currentServiceKey = parsedKey;
        return;
      }
    } catch {
      // File missing or unreadable (e.g. 0600 root:root .env under User=lobechat) — try next fallback
    }
  }

  const envKey = (process.env.ARCKEP_ENGINE_SERVICE_KEY || '').trim();
  if (envKey && !currentServiceKey) {
    currentServiceKey = envKey;
  }
}

function getServiceKey() {
  return currentServiceKey;
}

function normalizeLoadedState(raw) {
  const activeSlot =
    typeof raw?.activeSlot === 'string' && raw.activeSlot ? raw.activeSlot : 'blue';
  const activePort = Number(raw?.activePort) || (activeSlot === 'green' ? 3412 : 3411);
  const rawDrainingPort = raw?.drainingPort ? Number(raw.drainingPort) : null;
  const rawDrainingSlot =
    typeof raw?.drainingSlot === 'string' && raw.drainingSlot ? raw.drainingSlot : null;

  const hasDistinctDraining =
    Boolean(rawDrainingSlot) &&
    Number.isInteger(rawDrainingPort) &&
    rawDrainingPort > 0 &&
    rawDrainingPort !== activePort;

  const switchEpoch = Number.isFinite(Number(raw?.switchEpoch)) ? Number(raw.switchEpoch) : 0;

  return {
    activePort,
    activeSlot,
    drainingPort: hasDistinctDraining ? rawDrainingPort : null,
    drainingSlot: hasDistinctDraining ? rawDrainingSlot : null,
    switchEpoch,
  };
}

function reloadState(force = false) {
  const now = Date.now();
  if (!force && now - lastStatCheckAt < STAT_CHECK_INTERVAL_MS) {
    return state;
  }
  lastStatCheckAt = now;

  let stat;
  try {
    stat = fs.statSync(ROUTER_STATE_FILE);
  } catch {
    return state;
  }

  if (!force && stat.mtimeMs === lastMtimeMs && stat.ino === lastIno && stat.size === lastSize) {
    return state;
  }

  try {
    const rawText = fs.readFileSync(ROUTER_STATE_FILE, 'utf8');
    const parsed = JSON.parse(rawText);
    const next = normalizeLoadedState(parsed);

    const switchedActive =
      next.activeSlot !== state.activeSlot ||
      next.activePort !== state.activePort ||
      next.switchEpoch !== state.switchEpoch ||
      !next.drainingPort;

    lastMtimeMs = stat.mtimeMs;
    lastIno = stat.ino;
    lastSize = stat.size;

    const changed =
      next.activeSlot !== state.activeSlot ||
      next.activePort !== state.activePort ||
      next.drainingSlot !== state.drainingSlot ||
      next.drainingPort !== state.drainingPort ||
      next.switchEpoch !== state.switchEpoch;

    state = next;
    if (switchedActive) {
      topicsStartedOnActive.clear();
    }

    if (changed) {
      console.log(
        `[engine-router] state loaded: active=${state.activeSlot}:${state.activePort} draining=${
          state.drainingSlot ? `${state.drainingSlot}:${state.drainingPort}` : 'none'
        } epoch=${state.switchEpoch}`,
      );
    }
  } catch (error) {
    console.error('[engine-router] failed to reload state file:', error);
  }

  return state;
}

function isLoopbackAddress(addr) {
  if (!addr) return false;
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function normalizeApiV1Path(pathname) {
  let p = pathname || '/';
  if (p.startsWith('/chat/api/v1')) {
    p = p.slice('/chat'.length);
  }
  if (p.length > 1 && p.endsWith('/')) {
    p = p.slice(0, -1);
  }
  return p;
}

function safeDecodeParam(raw) {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * Internal JSON HTTP call to a slot with strict timeout and exact errorCode classification.
 * Never throws.
 */
function requestSlotJson({
  port,
  method,
  path,
  headers = {},
  body = null,
  timeoutMs = STATUS_TIMEOUT_MS,
}) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const done = (result) => {
      if (settled) return;
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      resolve(result);
    };

    const reqHeaders = {
      ...headers,
      'accept-encoding': 'identity',
    };

    let bodyBuffer = null;
    if (body !== null && body !== undefined) {
      bodyBuffer = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
      delete reqHeaders['transfer-encoding'];
      reqHeaders['content-length'] = String(bodyBuffer.length);
    }

    const req = http.request(
      {
        agent: upstreamAgent,
        headers: reqHeaders,
        host: ROUTER_UPSTREAM_HOST,
        method,
        path,
        port,
      },
      (res) => {
        const chunks = [];
        let total = 0;
        res.on('data', (chunk) => {
          total += chunk.length;
          if (total <= 4 * 1024 * 1024) {
            chunks.push(chunk);
          } else {
            req.destroy(new Error('Upstream JSON response exceeded 4MB'));
            done({
              errorCode: 'RESPONSE_TOO_LARGE',
              headers: {},
              json: null,
              ok: false,
              rawBody: Buffer.alloc(0),
              statusCode: 0,
            });
          }
        });
        res.on('end', () => {
          const rawBody = Buffer.concat(chunks);
          let json = null;
          let validJson = false;
          try {
            if (rawBody.length > 0) {
              json = JSON.parse(rawBody.toString('utf8'));
              validJson = true;
            }
          } catch {
            json = null;
            validJson = false;
          }
          done({
            errorCode: null,
            headers: res.headers,
            json,
            ok: true,
            rawBody,
            statusCode: res.statusCode || 500,
            validJson,
          });
        });
        res.on('error', (err) => {
          done({
            errorCode: err?.code || 'RESPONSE_ERROR',
            headers: {},
            json: null,
            ok: false,
            rawBody: Buffer.alloc(0),
            statusCode: 0,
          });
        });
      },
    );

    req.on('socket', (sock) => {
      sock.setNoDelay(true);
    });

    timer = setTimeout(() => {
      const timeoutErr = new Error('Upstream JSON timeout');
      timeoutErr.code = 'TIMEOUT';
      req.destroy(timeoutErr);
      done({
        errorCode: 'TIMEOUT',
        headers: {},
        json: null,
        ok: false,
        rawBody: Buffer.alloc(0),
        statusCode: 0,
      });
    }, timeoutMs);

    req.on('error', (err) => {
      done({
        errorCode: err?.code || 'REQUEST_ERROR',
        headers: {},
        json: null,
        ok: false,
        rawBody: Buffer.alloc(0),
        statusCode: 0,
      });
    });

    if (bodyBuffer) {
      req.end(bodyBuffer);
    } else {
      req.end();
    }
  });
}

/**
 * Tri-state slot status check:
 *   - `state: 'unreachable'` — process is stopped (`ECONNREFUSED`), 0 in-memory operations;
 *   - `state: 'ok'`          — HTTP 200 with valid JSON arrays `activeTopicIds` & `retainedTopicIds`;
 *   - `state: 'unknown'`     — timeout, `5xx`, `401`/`503`, malformed JSON, or socket reset while alive.
 */
async function fetchSlotStatus(port) {
  if (!port) {
    return { activeTopicIds: [], retainedTopicIds: [], state: 'unreachable' };
  }

  const serviceKey = getServiceKey();
  const res = await requestSlotJson({
    headers: {
      ...(serviceKey ? { Authorization: `Bearer ${serviceKey}` } : {}),
      Host: 'arckep.ru',
    },
    method: 'GET',
    path: '/chat/api/v1/arckep/engine-slot/status/',
    port,
    timeoutMs: STATUS_TIMEOUT_MS,
  });

  if (!res.ok) {
    if (res.errorCode === 'ECONNREFUSED') {
      return { activeTopicIds: [], retainedTopicIds: [], state: 'unreachable' };
    }
    return { activeTopicIds: [], retainedTopicIds: [], state: 'unknown' };
  }

  if (
    res.statusCode !== 200 ||
    !res.validJson ||
    !res.json ||
    typeof res.json !== 'object' ||
    !Array.isArray(res.json.activeTopicIds) ||
    !Array.isArray(res.json.retainedTopicIds)
  ) {
    return { activeTopicIds: [], retainedTopicIds: [], state: 'unknown' };
  }

  return {
    activeTopicIds: res.json.activeTopicIds,
    retainedTopicIds: res.json.retainedTopicIds,
    state: 'ok',
  };
}

/**
 * Tri-state chunked message ownership check (supports up to 20,000 IDs in 1,000-ID batches):
 *   - `{ state: 'ok', ownsActiveTopic: boolean }`
 *   - `{ state: 'unreachable', ownsActiveTopic: false }` (`ECONNREFUSED`)
 *   - `{ state: 'unknown', ownsActiveTopic: false }` (timeout / `5xx` / auth / bad JSON)
 */
async function checkDrainingOwnsMessages(drainingPort, messageIds) {
  if (!drainingPort || !Array.isArray(messageIds) || messageIds.length === 0) {
    return { ownsActiveTopic: false, state: 'ok' };
  }
  const serviceKey = getServiceKey();
  if (!serviceKey || serviceKey.length < MIN_SERVICE_KEY_LENGTH) {
    return { ownsActiveTopic: false, state: 'unknown' };
  }

  for (let offset = 0; offset < messageIds.length; offset += OWNS_MESSAGES_CHUNK_SIZE) {
    const chunk = messageIds.slice(offset, offset + OWNS_MESSAGES_CHUNK_SIZE);
    const res = await requestSlotJson({
      body: JSON.stringify({ messageIds: chunk }),
      headers: {
        'Authorization': `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        'Host': 'arckep.ru',
      },
      method: 'POST',
      path: '/chat/api/v1/arckep/engine-slot/owns-messages/',
      port: drainingPort,
      timeoutMs: STATUS_TIMEOUT_MS,
    });

    if (!res.ok) {
      if (res.errorCode === 'ECONNREFUSED') {
        return { ownsActiveTopic: false, state: 'unreachable' };
      }
      return { ownsActiveTopic: false, state: 'unknown' };
    }

    if (
      res.statusCode !== 200 ||
      !res.validJson ||
      !res.json ||
      typeof res.json.ownsActiveTopic !== 'boolean'
    ) {
      return { ownsActiveTopic: false, state: 'unknown' };
    }

    if (res.json.ownsActiveTopic === true) {
      return { ownsActiveTopic: true, state: 'ok' };
    }
  }

  return { ownsActiveTopic: false, state: 'ok' };
}

/**
 * Buffered request body reader with per-request size limit, global memory cap,
 * and read timeout. Always returns `{ buffer, release }` on success and frees
 * reserved bytes automatically on failure.
 */
function readRequestBody(req, requestCtx, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    if (requestCtx.isDisconnected()) {
      const err = new Error('Client aborted request');
      err.code = 'CLIENT_ABORTED';
      reject(err);
      return;
    }

    const declaredLength = Number(req.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      const err = new Error('Payload Too Large');
      err.code = 'PAYLOAD_TOO_LARGE';
      reject(err);
      return;
    }
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > 0 &&
      totalBufferedBytes + declaredLength > MAX_TOTAL_BUFFERED_BYTES
    ) {
      const err = new Error('Router request buffer limit exceeded');
      err.code = 'BUFFER_LIMIT_EXCEEDED';
      reject(err);
      return;
    }

    const chunks = [];
    let total = 0;
    let reservedBytes = 0;
    let finished = false;
    let released = false;

    const releaseReserved = () => {
      if (released) return;
      released = true;
      totalBufferedBytes = Math.max(0, totalBufferedBytes - reservedBytes);
      reservedBytes = 0;
    };

    const fail = (err) => {
      if (finished) return;
      finished = true;
      cleanup();
      releaseReserved();
      reject(err);
    };

    const timer = setTimeout(() => {
      const err = new Error('Request body read timeout');
      err.code = 'BODY_READ_TIMEOUT';
      fail(err);
    }, BODY_READ_TIMEOUT_MS);

    const onData = (chunk) => {
      if (finished) return;
      if (total + chunk.length > maxBytes) {
        const err = new Error('Payload Too Large');
        err.code = 'PAYLOAD_TOO_LARGE';
        fail(err);
        return;
      }
      if (totalBufferedBytes + chunk.length > MAX_TOTAL_BUFFERED_BYTES) {
        const err = new Error('Router request buffer limit exceeded');
        err.code = 'BUFFER_LIMIT_EXCEEDED';
        fail(err);
        return;
      }
      total += chunk.length;
      reservedBytes += chunk.length;
      totalBufferedBytes += chunk.length;
      chunks.push(chunk);
    };

    const onEnd = () => {
      if (finished) return;
      if (requestCtx.isDisconnected()) {
        const err = new Error('Client aborted request');
        err.code = 'CLIENT_ABORTED';
        fail(err);
        return;
      }
      finished = true;
      cleanup();
      resolve({
        buffer: Buffer.concat(chunks),
        release: releaseReserved,
      });
    };

    const onError = (err) => {
      fail(err);
    };

    const onDisconnect = () => {
      const err = new Error('Client aborted request');
      err.code = 'CLIENT_ABORTED';
      fail(err);
    };

    const offDisconnect = requestCtx.onDisconnect(onDisconnect);

    const cleanup = () => {
      clearTimeout(timer);
      offDisconnect();
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
    };

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

function buildForwardHeaders(incomingHeaders, bodyBuffer = null) {
  const out = {};
  for (const [key, value] of Object.entries(incomingHeaders)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (lower === 'connection' || lower === 'keep-alive' || lower === 'upgrade') continue;
    if (bodyBuffer !== null && (lower === 'transfer-encoding' || lower === 'content-length')) {
      continue;
    }
    out[key] = value;
  }
  if (bodyBuffer !== null) {
    out['content-length'] = String(bodyBuffer.length);
  }
  return out;
}

function sendJson(res, statusCode, payload, slotHeader = null, extraHeaders = null) {
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const headers = {
    'Content-Length': String(body.length),
    'Content-Type': 'application/json; charset=UTF-8',
    ...extraHeaders,
  };
  if (slotHeader) {
    headers['X-LobeChat-Slot'] = slotHeader;
  }
  res.writeHead(statusCode, headers);
  res.end(body);
}

function handleBodyReadError(res, err, slotHeader) {
  if (err?.code === 'PAYLOAD_TOO_LARGE') {
    sendJson(res, 413, { error: 'Request entity too large' }, slotHeader, { Connection: 'close' });
  } else if (err?.code === 'BODY_READ_TIMEOUT') {
    sendJson(res, 408, { error: 'Request body read timeout' }, slotHeader, { Connection: 'close' });
  } else if (err?.code === 'BUFFER_LIMIT_EXCEEDED') {
    sendJson(
      res,
      503,
      { error: 'Router request buffer limit exceeded; retry shortly' },
      slotHeader,
      { Connection: 'close' },
    );
  } else if (!res.writableEnded && !res.destroyed) {
    res.destroy();
  }
}

function pipeUpstreamResponse(req, res, upstreamReq, upstreamRes, slotName, onDone) {
  let doneCalled = false;
  const finishOnce = () => {
    if (doneCalled) return;
    doneCalled = true;
    onDone();
  };

  const outHeaders = { ...upstreamRes.headers, ['x-lobechat-slot']: slotName };
  if (isShuttingDown) {
    outHeaders['connection'] = 'close';
  }

  res.writeHead(upstreamRes.statusCode || 502, outHeaders);
  const contentType = String(upstreamRes.headers['content-type'] || '');
  if (contentType.includes('text/event-stream') && typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }

  upstreamRes.on('error', () => {
    finishOnce();
    if (!res.writableEnded) {
      res.destroy();
    }
  });

  upstreamRes.on('end', () => {
    finishOnce();
  });

  upstreamRes.on('close', () => {
    finishOnce();
    if (!upstreamRes.complete && !res.writableEnded) {
      res.destroy();
    }
  });

  upstreamRes.pipe(res);
}

/**
 * Stream-proxy an unbuffered incoming request directly to `targetPort`.
 * Fallback to `fallbackPort` is strictly restricted to idempotent `GET`/`HEAD` requests
 * when `drainingPort` returned `ECONNREFUSED` BEFORE response headers AND client is still connected.
 */
function proxyStreamRequest(req, res, requestCtx, targetPort, slotName, fallback = null) {
  if (requestCtx.isDisconnected()) return;

  let upstreamFinished = false;
  let upstreamResponded = false;
  const methodUpper = (req.method || 'GET').toUpperCase();
  const isIdempotentRead = methodUpper === 'GET' || methodUpper === 'HEAD';

  const forwardHeaders = buildForwardHeaders(req.headers, null);

  const startAttempt = (port, slot, allowFallback) => {
    if (requestCtx.isDisconnected()) return;

    let currentUpstreamRes = null;

    const upstreamReq = http.request(
      {
        agent: upstreamAgent,
        headers: forwardHeaders,
        host: ROUTER_UPSTREAM_HOST,
        method: req.method,
        path: req.url,
        port,
      },
      (upstreamRes) => {
        if (requestCtx.isDisconnected()) {
          upstreamRes.destroy();
          upstreamReq.destroy();
          cleanupAttemptListeners();
          return;
        }
        upstreamResponded = true;
        currentUpstreamRes = upstreamRes;
        pipeUpstreamResponse(req, res, upstreamReq, upstreamRes, slot, () => {
          upstreamFinished = true;
          cleanupAttemptListeners();
        });
      },
    );

    upstreamReq.on('socket', (sock) => {
      sock.setNoDelay(true);
    });

    const onClientPrematureClose = () => {
      if (!res.writableEnded && !upstreamFinished) {
        upstreamFinished = true;
        cleanupAttemptListeners();
        if (currentUpstreamRes) {
          currentUpstreamRes.unpipe(res);
          currentUpstreamRes.destroy();
        }
        upstreamReq.destroy();
      }
    };

    const onReqError = () => {
      if (!upstreamFinished) {
        upstreamFinished = true;
        cleanupAttemptListeners();
        upstreamReq.destroy();
      }
    };

    const offDisconnect = requestCtx.onDisconnect(onClientPrematureClose);

    const cleanupAttemptListeners = () => {
      offDisconnect();
      if (!isIdempotentRead) {
        req.unpipe(upstreamReq);
        req.off('error', onReqError);
      }
    };

    upstreamReq.on('error', (err) => {
      cleanupAttemptListeners();

      if (requestCtx.isDisconnected()) {
        upstreamFinished = true;
        return;
      }

      if (
        isIdempotentRead &&
        allowFallback &&
        fallback &&
        err?.code === 'ECONNREFUSED' &&
        !upstreamResponded &&
        !res.headersSent &&
        !res.writableEnded
      ) {
        startAttempt(fallback.fallbackPort, fallback.fallbackSlot, false);
        return;
      }

      upstreamFinished = true;
      if (!res.headersSent && !res.writableEnded) {
        sendJson(
          res,
          502,
          { error: `Upstream slot ${slot} (${port}) unavailable: ${err.message}` },
          slot,
        );
      } else if (!res.writableEnded) {
        res.destroy();
      }
    });

    if (requestCtx.isDisconnected()) {
      cleanupAttemptListeners();
      upstreamReq.destroy();
      return;
    }

    if (isIdempotentRead || req.readableEnded) {
      upstreamReq.end();
    } else {
      req.on('error', onReqError);
      req.pipe(upstreamReq);
    }
  };

  startAttempt(targetPort, slotName, Boolean(fallback) && isIdempotentRead);
}

/**
 * Proxy an already-buffered mutating request (`bodyBuffer`) to `targetPort`.
 * NEVER retries mutations on another slot (prevents duplicate POST/DELETE execution).
 * Always calls `onSettled()` once the buffer has been written/released and upstream settles.
 */
function proxyBufferedRequest(
  req,
  res,
  requestCtx,
  bodyBuffer,
  targetPort,
  slotName,
  { onResponseStatus = null, onSettled = null } = {},
) {
  let settled = false;
  const finishBuffer = () => {
    if (settled) return;
    settled = true;
    onSettled?.();
  };

  if (requestCtx.isDisconnected()) {
    finishBuffer();
    return;
  }

  let upstreamFinished = false;
  let currentUpstreamRes = null;
  const forwardHeaders = buildForwardHeaders(req.headers, bodyBuffer);

  const upstreamReq = http.request(
    {
      agent: upstreamAgent,
      headers: forwardHeaders,
      host: ROUTER_UPSTREAM_HOST,
      method: req.method,
      path: req.url,
      port: targetPort,
    },
    (upstreamRes) => {
      finishBuffer();
      if (requestCtx.isDisconnected()) {
        upstreamRes.destroy();
        upstreamReq.destroy();
        offDisconnect();
        return;
      }
      currentUpstreamRes = upstreamRes;
      const statusCode = upstreamRes.statusCode || 502;
      onResponseStatus?.(statusCode);
      pipeUpstreamResponse(req, res, upstreamReq, upstreamRes, slotName, () => {
        upstreamFinished = true;
        offDisconnect();
      });
    },
  );

  upstreamReq.on('socket', (sock) => {
    sock.setNoDelay(true);
  });

  const onClientPrematureClose = () => {
    if (!res.writableEnded && !upstreamFinished) {
      upstreamFinished = true;
      offDisconnect();
      finishBuffer();
      if (currentUpstreamRes) {
        currentUpstreamRes.unpipe(res);
        currentUpstreamRes.destroy();
      }
      upstreamReq.destroy();
    }
  };

  const offDisconnect = requestCtx.onDisconnect(onClientPrematureClose);

  upstreamReq.on('error', (err) => {
    offDisconnect();
    finishBuffer();
    upstreamFinished = true;

    if (requestCtx.isDisconnected()) {
      return;
    }

    if (!res.headersSent && !res.writableEnded) {
      sendJson(
        res,
        502,
        { error: `Upstream slot ${slotName} (${targetPort}) unavailable: ${err.message}` },
        slotName,
      );
    } else if (!res.writableEnded) {
      res.destroy();
    }
  });

  if (requestCtx.isDisconnected()) {
    offDisconnect();
    finishBuffer();
    upstreamReq.destroy();
    return;
  }

  upstreamReq.end(bodyBuffer, () => {
    // Request payload has left Node's userland buffer into kernel socket buffer
    finishBuffer();
  });
}

async function handleMergedRunning(req, res, requestCtx, currentState) {
  if (requestCtx.isDisconnected()) return;

  const forwardHeaders = buildForwardHeaders(req.headers, null);

  const [activeRes, drainingRes] = await Promise.all([
    requestSlotJson({
      headers: forwardHeaders,
      method: 'GET',
      path: req.url,
      port: currentState.activePort,
      timeoutMs: 5000,
    }),
    requestSlotJson({
      headers: forwardHeaders,
      method: 'GET',
      path: req.url,
      port: currentState.drainingPort,
      timeoutMs: STATUS_TIMEOUT_MS,
    }),
  ]);

  if (requestCtx.isDisconnected()) return;

  if (!activeRes.ok) {
    sendJson(res, 502, { error: 'Active engine slot unavailable' }, currentState.activeSlot);
    return;
  }

  // Pass through client auth / validation errors (401, 403, etc.) from activeSlot
  if (
    activeRes.statusCode !== 200 ||
    !activeRes.validJson ||
    !Array.isArray(activeRes.json?.topics)
  ) {
    const outHeaders = { ...activeRes.headers, 'x-lobechat-slot': currentState.activeSlot };
    delete outHeaders['transfer-encoding'];
    outHeaders['content-length'] = String(activeRes.rawBody.length);
    res.writeHead(activeRes.statusCode, outHeaders);
    res.end(activeRes.rawBody);
    return;
  }

  const activeTopics = activeRes.json.topics;
  if (
    drainingRes.ok &&
    drainingRes.statusCode === 200 &&
    drainingRes.validJson &&
    Array.isArray(drainingRes.json?.topics)
  ) {
    const mergedTopics = [...new Set([...activeTopics, ...drainingRes.json.topics])];
    sendJson(res, 200, { topics: mergedTopics }, 'merged');
    return;
  }

  // Safe ONLY when draining process is stopped (ECONNREFUSED)
  if (!drainingRes.ok && drainingRes.errorCode === 'ECONNREFUSED') {
    sendJson(res, 200, { topics: activeTopics }, currentState.activeSlot);
    return;
  }

  // Draining slot is alive or timed out — refuse returning a partial running list
  sendJson(
    res,
    503,
    { error: 'Draining engine slot status temporarily unavailable' },
    currentState.drainingSlot,
  );
}

/**
 * Resolve routing decision for a buffered POST /responses across epoch transitions.
 */
async function routeBufferedResponsesPost(req, res, requestCtx, bodyBuf, releaseBody, prevId) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (requestCtx.isDisconnected()) {
      releaseBody();
      return;
    }

    const cur = reloadState(false);
    if (!cur.drainingPort || !cur.drainingSlot || !prevId) {
      proxyBufferedRequest(req, res, requestCtx, bodyBuf, cur.activePort, cur.activeSlot, {
        onResponseStatus: prevId
          ? (code) => {
              if (code >= 200 && code < 300) rememberTopicOnActive(prevId);
            }
          : null,
        onSettled: releaseBody,
      });
      return;
    }

    const drainStatus = await fetchSlotStatus(cur.drainingPort);
    if (requestCtx.isDisconnected()) {
      releaseBody();
      return;
    }

    // Re-verify epoch right before sending in case rollback/drain completed during status probe
    const afterProbe = reloadState(false);
    if (
      afterProbe.switchEpoch !== cur.switchEpoch ||
      afterProbe.drainingPort !== cur.drainingPort
    ) {
      continue;
    }

    if (drainStatus.state === 'unknown') {
      releaseBody();
      sendJson(
        res,
        503,
        { error: 'Cannot verify topic state on draining engine slot; retry shortly' },
        cur.drainingSlot,
      );
      return;
    }

    if (drainStatus.state === 'ok' && drainStatus.activeTopicIds.includes(prevId)) {
      proxyBufferedRequest(req, res, requestCtx, bodyBuf, cur.drainingPort, cur.drainingSlot, {
        onSettled: releaseBody,
      });
      return;
    }

    proxyBufferedRequest(req, res, requestCtx, bodyBuf, cur.activePort, cur.activeSlot, {
      onResponseStatus: (code) => {
        if (code >= 200 && code < 300) rememberTopicOnActive(prevId);
      },
      onSettled: releaseBody,
    });
    return;
  }

  const finalState = reloadState(false);
  releaseBody();
  sendJson(
    res,
    503,
    { error: 'Engine slot state transitioning; retry shortly' },
    finalState.activeSlot,
  );
}

/**
 * Resolve routing decision for a buffered DELETE /messages* across epoch transitions.
 */
async function routeBufferedMessagesDelete(req, res, requestCtx, bodyBuf, releaseBody, messageIds) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (requestCtx.isDisconnected()) {
      releaseBody();
      return;
    }

    const cur = reloadState(false);
    if (!cur.drainingPort || !cur.drainingSlot || messageIds.length === 0) {
      proxyBufferedRequest(req, res, requestCtx, bodyBuf, cur.activePort, cur.activeSlot, {
        onSettled: releaseBody,
      });
      return;
    }

    const drainStatus = await fetchSlotStatus(cur.drainingPort);
    if (requestCtx.isDisconnected()) {
      releaseBody();
      return;
    }

    if (drainStatus.state === 'unknown') {
      const recheck = reloadState(false);
      if (recheck.switchEpoch !== cur.switchEpoch || recheck.drainingPort !== cur.drainingPort) {
        continue;
      }
      releaseBody();
      sendJson(
        res,
        503,
        { error: 'Cannot verify active topics on draining engine slot; retry shortly' },
        cur.drainingSlot,
      );
      return;
    }

    let routeToDraining = false;
    if (drainStatus.state === 'ok' && drainStatus.activeTopicIds.length > 0) {
      const ownsResult = await checkDrainingOwnsMessages(cur.drainingPort, messageIds);
      if (requestCtx.isDisconnected()) {
        releaseBody();
        return;
      }
      if (ownsResult.state === 'unknown') {
        const recheck = reloadState(false);
        if (recheck.switchEpoch !== cur.switchEpoch || recheck.drainingPort !== cur.drainingPort) {
          continue;
        }
        releaseBody();
        sendJson(
          res,
          503,
          { error: 'Cannot verify message ownership on draining engine slot; retry shortly' },
          cur.drainingSlot,
        );
        return;
      }
      routeToDraining = ownsResult.state === 'ok' && ownsResult.ownsActiveTopic;
    }

    const afterProbe = reloadState(false);
    if (
      afterProbe.switchEpoch !== cur.switchEpoch ||
      afterProbe.drainingPort !== cur.drainingPort
    ) {
      continue;
    }

    if (routeToDraining) {
      proxyBufferedRequest(req, res, requestCtx, bodyBuf, cur.drainingPort, cur.drainingSlot, {
        onSettled: releaseBody,
      });
    } else {
      proxyBufferedRequest(req, res, requestCtx, bodyBuf, cur.activePort, cur.activeSlot, {
        onSettled: releaseBody,
      });
    }
    return;
  }

  const finalState = reloadState(false);
  releaseBody();
  sendJson(
    res,
    503,
    { error: 'Engine slot state transitioning; retry shortly' },
    finalState.activeSlot,
  );
}

async function handleRequest(req, res) {
  // P2 #12: Subscribe to premature client disconnect BEFORE any await!
  let clientDisconnected = Boolean(req.aborted || (!res.writableEnded && res.destroyed));
  const disconnectListeners = new Set();
  const markDisconnected = () => {
    if (res.writableEnded || clientDisconnected) return;
    clientDisconnected = true;
    for (const fn of disconnectListeners) {
      try {
        fn();
      } catch {
        // ignore listener errors
      }
    }
  };
  req.once('aborted', markDisconnected);
  req.once('close', () => {
    if (!req.complete && !res.writableEnded) markDisconnected();
  });
  res.once('close', () => {
    if (!res.writableEnded) markDisconnected();
  });

  const requestCtx = {
    isDisconnected: () =>
      clientDisconnected || Boolean(req.aborted || (!res.writableEnded && res.destroyed)),
    onDisconnect: (fn) => {
      if (clientDisconnected) {
        queueMicrotask(fn);
        return () => undefined;
      }
      disconnectListeners.add(fn);
      return () => disconnectListeners.delete(fn);
    },
  };

  req.socket?.setNoDelay?.(true);
  res.on('error', () => undefined);

  const method = (req.method || 'GET').toUpperCase();
  let pathname;
  try {
    pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
  } catch {
    pathname = '/';
  }

  // Loopback-only router diagnostics endpoint
  if (method === 'GET' && (pathname === '/__router/health' || pathname === '/__router/health/')) {
    if (!isLoopbackAddress(req.socket?.remoteAddress)) {
      sendJson(res, 403, { error: 'Forbidden' });
      return;
    }
    const cur = reloadState(false);
    sendJson(res, 200, {
      activePort: cur.activePort,
      activeSlot: cur.activeSlot,
      drainingPort: cur.drainingPort,
      drainingSlot: cur.drainingSlot,
      inFlightRequests,
      routerHash: ROUTER_SCRIPT_HASH,
      serviceKeyConfigured: getServiceKey().length >= MIN_SERVICE_KEY_LENGTH,
      status: 'ok',
      switchEpoch: cur.switchEpoch,
      topicsStartedOnActiveCount: topicsStartedOnActive.size,
      totalBufferedBytes,
    });
    return;
  }

  const cur = reloadState(false);

  // Fast path: single active slot, zero buffering, zero status subrequests
  if (!cur.drainingPort || !cur.drainingSlot) {
    proxyStreamRequest(req, res, requestCtx, cur.activePort, cur.activeSlot);
    return;
  }

  const normPath = normalizeApiV1Path(pathname);

  // 1. GET /chat/api/v1/responses/running(/)
  if (method === 'GET' && normPath === '/api/v1/responses/running') {
    await handleMergedRunning(req, res, requestCtx, cur);
    return;
  }

  // 2. POST /chat/api/v1/responses/:id/cancel(/)
  const cancelMatch =
    method === 'POST' ? /^\/api\/v1\/responses\/([^/]+)\/cancel$/.exec(normPath) : null;
  if (cancelMatch) {
    const id = safeDecodeParam(cancelMatch[1]);
    for (let attempt = 0; attempt < 3; attempt++) {
      const snap = reloadState(false);
      if (!snap.drainingPort || !snap.drainingSlot) {
        proxyStreamRequest(req, res, requestCtx, snap.activePort, snap.activeSlot);
        return;
      }
      const drainStatus = await fetchSlotStatus(snap.drainingPort);
      if (requestCtx.isDisconnected()) return;

      const latest = reloadState(false);
      if (latest.switchEpoch !== snap.switchEpoch || latest.drainingPort !== snap.drainingPort) {
        continue;
      }
      if (drainStatus.state === 'unknown') {
        sendJson(
          res,
          503,
          { error: 'Cannot verify running response on draining engine slot; retry shortly' },
          snap.drainingSlot,
        );
        return;
      }
      if (drainStatus.state === 'ok' && drainStatus.activeTopicIds.includes(id)) {
        // NEVER fallback POST /cancel onto activePort
        proxyStreamRequest(req, res, requestCtx, snap.drainingPort, snap.drainingSlot);
      } else {
        proxyStreamRequest(req, res, requestCtx, snap.activePort, snap.activeSlot);
      }
      return;
    }
    sendJson(res, 503, { error: 'Engine slot state transitioning; retry shortly' }, cur.activeSlot);
    return;
  }

  // 3. GET /chat/api/v1/responses/:id(/) and GET /chat/api/v1/responses/:id/stream(/)
  const responseGetMatch =
    method === 'GET' ? /^\/api\/v1\/responses\/([^/]+)(?:\/stream)?$/.exec(normPath) : null;
  if (responseGetMatch) {
    const id = safeDecodeParam(responseGetMatch[1]);
    if (id !== 'running') {
      for (let attempt = 0; attempt < 3; attempt++) {
        const snap = reloadState(false);
        if (!snap.drainingPort || !snap.drainingSlot) {
          proxyStreamRequest(req, res, requestCtx, snap.activePort, snap.activeSlot);
          return;
        }
        const getFallback = { fallbackPort: snap.activePort, fallbackSlot: snap.activeSlot };
        const drainStatus = await fetchSlotStatus(snap.drainingPort);
        if (requestCtx.isDisconnected()) return;

        let targetDraining = false;
        if (drainStatus.state === 'ok') {
          if (drainStatus.activeTopicIds.includes(id)) {
            targetDraining = true;
          } else if (drainStatus.retainedTopicIds.includes(id)) {
            if (topicsStartedOnActive.has(id)) {
              targetDraining = false;
            } else {
              // Check activePort as ground truth (survives router restarts & ignores 4xx failed POSTs)
              const activeStatus = await fetchSlotStatus(snap.activePort);
              if (requestCtx.isDisconnected()) return;
              if (
                activeStatus.state === 'ok' &&
                (activeStatus.activeTopicIds.includes(id) ||
                  activeStatus.retainedTopicIds.includes(id))
              ) {
                rememberTopicOnActive(id);
                targetDraining = false;
              } else {
                targetDraining = true;
              }
            }
          }
        } else if (drainStatus.state === 'unknown') {
          // Serve from activePort if topic is confirmed there; otherwise 503 rather than false 404
          const activeStatus = await fetchSlotStatus(snap.activePort);
          if (requestCtx.isDisconnected()) return;
          if (
            activeStatus.state === 'ok' &&
            (activeStatus.activeTopicIds.includes(id) || activeStatus.retainedTopicIds.includes(id))
          ) {
            targetDraining = false;
          } else {
            const latestCheck = reloadState(false);
            if (
              latestCheck.switchEpoch !== snap.switchEpoch ||
              latestCheck.drainingPort !== snap.drainingPort
            ) {
              continue;
            }
            sendJson(
              res,
              503,
              { error: 'Draining engine slot status temporarily unavailable' },
              snap.drainingSlot,
            );
            return;
          }
        }

        const latest = reloadState(false);
        if (latest.switchEpoch !== snap.switchEpoch || latest.drainingPort !== snap.drainingPort) {
          continue;
        }

        if (targetDraining) {
          proxyStreamRequest(
            req,
            res,
            requestCtx,
            snap.drainingPort,
            snap.drainingSlot,
            getFallback,
          );
        } else {
          proxyStreamRequest(req, res, requestCtx, snap.activePort, snap.activeSlot);
        }
        return;
      }
      sendJson(
        res,
        503,
        { error: 'Engine slot state transitioning; retry shortly' },
        cur.activeSlot,
      );
      return;
    }
  }

  // 4. POST /chat/api/v1/responses(/)
  if (method === 'POST' && normPath === '/api/v1/responses') {
    let bodyHandle;
    try {
      bodyHandle = await readRequestBody(req, requestCtx, MAX_BODY_BYTES);
    } catch (err) {
      handleBodyReadError(res, err, reloadState(false).activeSlot);
      return;
    }

    let parsed;
    try {
      parsed = bodyHandle.buffer.length > 0 ? JSON.parse(bodyHandle.buffer.toString('utf8')) : null;
    } catch {
      parsed = null;
    }

    const headerPrevId =
      typeof req.headers['x-arckep-previous-response-id'] === 'string'
        ? req.headers['x-arckep-previous-response-id'].trim()
        : '';
    const prevId =
      parsed && typeof parsed === 'object' && typeof parsed.previous_response_id === 'string'
        ? parsed.previous_response_id.trim()
        : headerPrevId;

    await routeBufferedResponsesPost(
      req,
      res,
      requestCtx,
      bodyHandle.buffer,
      bodyHandle.release,
      prevId,
    );
    return;
  }

  // 5. DELETE /chat/api/v1/messages(/) and DELETE /chat/api/v1/messages/:id(/)
  const singleDeleteMatch =
    method === 'DELETE' ? /^\/api\/v1\/messages\/([^/]+)$/.exec(normPath) : null;
  if (method === 'DELETE' && (normPath === '/api/v1/messages' || singleDeleteMatch)) {
    let bodyHandle;
    try {
      bodyHandle = await readRequestBody(req, requestCtx, MAX_BODY_BYTES);
    } catch (err) {
      handleBodyReadError(res, err, reloadState(false).activeSlot);
      return;
    }

    let messageIds = [];
    if (singleDeleteMatch) {
      const singleId = safeDecodeParam(singleDeleteMatch[1]);
      if (singleId) messageIds = [singleId];
    } else if (bodyHandle.buffer.length > 0) {
      try {
        const parsed = JSON.parse(bodyHandle.buffer.toString('utf8'));
        if (Array.isArray(parsed?.messageIds)) {
          messageIds = parsed.messageIds.filter((id) => typeof id === 'string' && id.length > 0);
        }
      } catch {
        messageIds = [];
      }
    }

    if (messageIds.length > OWNS_MESSAGES_MAX_IDS) {
      bodyHandle.release();
      sendJson(
        res,
        400,
        { error: `Too many messageIds (maximum ${OWNS_MESSAGES_MAX_IDS})` },
        reloadState(false).activeSlot,
      );
      return;
    }

    await routeBufferedMessagesDelete(
      req,
      res,
      requestCtx,
      bodyHandle.buffer,
      bodyHandle.release,
      messageIds,
    );
    return;
  }

  // 6. Everything else (/chat/f/..., /chat/api/agent/webhooks/..., /health, /topics, GET /messages, /files, /models)
  const snap = reloadState(false);
  proxyStreamRequest(req, res, requestCtx, snap.activePort, snap.activeSlot);
}

let isShuttingDown = false;
let inFlightRequests = 0;

// Initial service key + state load before listening
reloadServiceKey();
reloadState(true);

process.on('SIGHUP', () => {
  reloadServiceKey();
  reloadState(true);
});

const server = http.createServer((req, res) => {
  inFlightRequests += 1;
  let accounted = false;
  const onRequestSettled = () => {
    if (accounted) return;
    accounted = true;
    inFlightRequests = Math.max(0, inFlightRequests - 1);
    if (isShuttingDown) {
      setImmediate(() => {
        server.closeIdleConnections?.();
      });
    }
  };
  res.once('finish', onRequestSettled);
  res.once('close', onRequestSettled);
  if (isShuttingDown && !res.headersSent) {
    res.setHeader('Connection', 'close');
  }

  handleRequest(req, res).catch((err) => {
    console.error('[engine-router] unhandled request error:', err);
    if (!res.headersSent && !res.writableEnded) {
      sendJson(res, 500, { error: 'Internal router error' }, state.activeSlot);
    } else if (!res.writableEnded) {
      res.destroy();
    }
  });
});

server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;
server.requestTimeout = 0; // Never time out long-running SSE streams

server.on('connection', (socket) => {
  socket.setNoDelay(true);
});

server.on('clientError', (_err, socket) => {
  if (socket.writable) {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  } else {
    socket.destroy();
  }
});

server.listen(ROUTER_PORT, ROUTER_HOST, () => {
  const addr = server.address();
  const boundPort = typeof addr === 'object' && addr ? addr.port : ROUTER_PORT;
  if (ROUTER_READY_FILE) {
    try {
      fs.writeFileSync(
        ROUTER_READY_FILE,
        JSON.stringify({
          host: ROUTER_HOST,
          pid: process.pid,
          port: boundPort,
          routerHash: ROUTER_SCRIPT_HASH,
        }),
        'utf8',
      );
    } catch (err) {
      console.error('[engine-router] failed writing ROUTER_READY_FILE:', err);
    }
  }
  console.log(
    `[engine-router] listening on http://${ROUTER_HOST}:${boundPort} (active=${state.activeSlot}:${state.activePort}, state=${ROUTER_STATE_FILE}, hash=${ROUTER_SCRIPT_HASH.slice(0, 12)})`,
  );
});

const shutdown = () => {
  if (isShuttingDown) return;
  isShuttingDown = true;

  server.close(() => {
    upstreamAgent.destroy();
    process.exit(0);
  });
  server.closeIdleConnections?.();
  if (inFlightRequests === 0) {
    setImmediate(() => {
      server.closeIdleConnections?.();
    });
  }

  setTimeout(() => {
    server.closeAllConnections?.();
    upstreamAgent.destroy();
    process.exit(0);
  }, SHUTDOWN_TIMEOUT_MS).unref();
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
