#!/usr/bin/env node
/**
 * Smart zero-downtime HTTP/SSE Blue-Green router for headless LobeChat engine.
 *
 * Pure Node.js (`node:http`, `node:fs`) — zero external dependencies.
 * Listens on 127.0.0.1:3403 (configurable via ROUTER_HOST / ROUTER_PORT) and routes
 * traffic between `blue` (:3411) and `green` (:3412) according to `ROUTER_STATE_FILE`
 * (`/var/lib/lobechat-engine/state.json`), keeping in-flight responses, `_chat_wait`,
 * cron runs, and replay buffers pinned to `drainingPort` until natural completion.
 */

import fs from 'node:fs';
import http from 'node:http';
import process from 'node:process';

const ROUTER_HOST = process.env.ROUTER_HOST || '127.0.0.1';
const ROUTER_PORT = Number.parseInt(process.env.ROUTER_PORT ?? '3403', 10);
const ROUTER_UPSTREAM_HOST = process.env.ROUTER_UPSTREAM_HOST || '127.0.0.1';
const ROUTER_STATE_FILE = process.env.ROUTER_STATE_FILE || '/var/lib/lobechat-engine/state.json';
const ROUTER_READY_FILE = process.env.ROUTER_READY_FILE || '';
const STATUS_TIMEOUT_MS = Number.parseInt(process.env.ROUTER_STATUS_TIMEOUT_MS ?? '1500', 10);
const SHUTDOWN_TIMEOUT_MS = Number.parseInt(process.env.ROUTER_SHUTDOWN_TIMEOUT_MS ?? '10000', 10);
const MAX_BODY_BYTES = Number.parseInt(
  process.env.ROUTER_MAX_BODY_BYTES ?? String(50 * 1024 * 1024),
  10,
);
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

/** Topics that already started a new turn on `activeSlot` during the current drain epoch. */
const topicsStartedOnActive = new Set();

function rememberTopicOnActive(topicId) {
  if (!topicId) return;
  if (topicsStartedOnActive.size >= MAX_TRACKED_ACTIVE_TOPICS) {
    const oldest = topicsStartedOnActive.values().next().value;
    if (oldest !== undefined) topicsStartedOnActive.delete(oldest);
  }
  topicsStartedOnActive.add(topicId);
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

function getServiceKey() {
  return (process.env.ARCKEP_ENGINE_SERVICE_KEY || '').trim();
}

/**
 * Internal JSON HTTP call to a slot with strict timeout. Never throws.
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
            done({ headers: {}, json: null, ok: false, rawBody: Buffer.alloc(0), statusCode: 0 });
          }
        });
        res.on('end', () => {
          const rawBody = Buffer.concat(chunks);
          let json;
          try {
            json = rawBody.length > 0 ? JSON.parse(rawBody.toString('utf8')) : null;
          } catch {
            json = null;
          }
          done({
            headers: res.headers,
            json,
            ok: true,
            rawBody,
            statusCode: res.statusCode || 500,
          });
        });
        res.on('error', () => {
          done({ headers: {}, json: null, ok: false, rawBody: Buffer.alloc(0), statusCode: 0 });
        });
      },
    );

    req.on('socket', (sock) => {
      sock.setNoDelay(true);
    });

    timer = setTimeout(() => {
      req.destroy(new Error('Upstream JSON timeout'));
      done({ headers: {}, json: null, ok: false, rawBody: Buffer.alloc(0), statusCode: 0 });
    }, timeoutMs);

    req.on('error', () => {
      done({ headers: {}, json: null, ok: false, rawBody: Buffer.alloc(0), statusCode: 0 });
    });

    if (bodyBuffer) {
      req.end(bodyBuffer);
    } else {
      req.end();
    }
  });
}

async function fetchDrainingStatus(drainingPort) {
  const empty = {
    activeTopicIds: [],
    retainedTopicIds: [],
    unreachable: true,
  };
  if (!drainingPort) return empty;

  const serviceKey = getServiceKey();
  if (!serviceKey) return empty;

  const res = await requestSlotJson({
    headers: {
      Authorization: `Bearer ${serviceKey}`,
      Host: 'arckep.ru',
    },
    method: 'GET',
    path: '/chat/api/v1/arckep/engine-slot/status/',
    port: drainingPort,
    timeoutMs: STATUS_TIMEOUT_MS,
  });

  if (!res.ok || res.statusCode !== 200 || !res.json || typeof res.json !== 'object') {
    return empty;
  }

  return {
    activeTopicIds: Array.isArray(res.json.activeTopicIds) ? res.json.activeTopicIds : [],
    retainedTopicIds: Array.isArray(res.json.retainedTopicIds) ? res.json.retainedTopicIds : [],
    unreachable: false,
  };
}

async function checkDrainingOwnsMessages(drainingPort, messageIds) {
  if (!drainingPort || !Array.isArray(messageIds) || messageIds.length === 0) {
    return false;
  }
  const serviceKey = getServiceKey();
  if (!serviceKey) return false;

  const res = await requestSlotJson({
    body: JSON.stringify({ messageIds }),
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

  if (!res.ok || res.statusCode !== 200 || !res.json) {
    return false;
  }
  return res.json.ownsActiveTopic === true;
}

function readRequestBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let finished = false;

    const onData = (chunk) => {
      if (finished) return;
      total += chunk.length;
      if (total > maxBytes) {
        finished = true;
        cleanup();
        const err = new Error('Payload Too Large');
        err.code = 'PAYLOAD_TOO_LARGE';
        reject(err);
        return;
      }
      chunks.push(chunk);
    };

    const onEnd = () => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve(Buffer.concat(chunks));
    };

    const onError = (err) => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(err);
    };

    const onAborted = () => {
      if (finished) return;
      finished = true;
      cleanup();
      const err = new Error('Client aborted request');
      err.code = 'CLIENT_ABORTED';
      reject(err);
    };

    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
    };

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
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

function sendJson(res, statusCode, payload, slotHeader = null) {
  if (res.headersSent || res.writableEnded) return;
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const headers = {
    'Content-Length': String(body.length),
    'Content-Type': 'application/json; charset=UTF-8',
  };
  if (slotHeader) {
    headers['X-LobeChat-Slot'] = slotHeader;
  }
  res.writeHead(statusCode, headers);
  res.end(body);
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
 * If `fallbackPort` is provided (when targeting `drainingPort`) and connection fails
 * BEFORE response headers arrive AND no request body bytes were consumed (e.g. GET/HEAD
 * or empty-body POST), transparently falls back to `fallbackPort`.
 */
function proxyStreamRequest(req, res, targetPort, slotName, fallback = null) {
  let upstreamFinished = false;
  let upstreamResponded = false;
  let reqBytesPiped = 0;
  const methodUpper = (req.method || 'GET').toUpperCase();
  const hasNoRequestBody = methodUpper === 'GET' || methodUpper === 'HEAD';

  const forwardHeaders = buildForwardHeaders(req.headers, null);

  const startAttempt = (port, slot, allowFallback) => {
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

    const onReqData = (chunk) => {
      reqBytesPiped += chunk.length;
    };

    const onReqError = () => {
      if (!upstreamFinished) {
        upstreamFinished = true;
        cleanupAttemptListeners();
        upstreamReq.destroy();
      }
    };

    const cleanupAttemptListeners = () => {
      res.off('close', onClientPrematureClose);
      req.off('aborted', onClientPrematureClose);
      if (!hasNoRequestBody) {
        req.unpipe(upstreamReq);
        req.off('data', onReqData);
        req.off('error', onReqError);
      }
    };

    res.on('close', onClientPrematureClose);
    req.on('aborted', onClientPrematureClose);

    upstreamReq.on('error', (err) => {
      cleanupAttemptListeners();

      if (
        allowFallback &&
        fallback &&
        !upstreamResponded &&
        !res.headersSent &&
        reqBytesPiped === 0
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

    if (hasNoRequestBody || req.readableEnded) {
      upstreamReq.end();
    } else {
      req.on('data', onReqData);
      req.on('error', onReqError);
      req.pipe(upstreamReq);
    }
  };

  startAttempt(targetPort, slotName, Boolean(fallback));
}

/**
 * Proxy an already-buffered request (`bodyBuffer`) to `targetPort`, with safe retry on
 * `fallbackPort` if `drainingPort` closed/died right before accepting headers.
 */
function proxyBufferedRequest(req, res, bodyBuffer, targetPort, slotName, fallback = null) {
  let upstreamFinished = false;
  let upstreamResponded = false;

  const forwardHeaders = buildForwardHeaders(req.headers, bodyBuffer);

  const startAttempt = (port, slot, allowFallback) => {
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
        upstreamResponded = true;
        currentUpstreamRes = upstreamRes;
        pipeUpstreamResponse(req, res, upstreamReq, upstreamRes, slot, () => {
          upstreamFinished = true;
          res.off('close', onClientPrematureClose);
        });
      },
    );

    upstreamReq.on('socket', (sock) => {
      sock.setNoDelay(true);
    });

    const onClientPrematureClose = () => {
      if (!res.writableEnded && !upstreamFinished) {
        upstreamFinished = true;
        res.off('close', onClientPrematureClose);
        if (currentUpstreamRes) {
          currentUpstreamRes.unpipe(res);
          currentUpstreamRes.destroy();
        }
        upstreamReq.destroy();
      }
    };

    res.on('close', onClientPrematureClose);

    upstreamReq.on('error', (err) => {
      res.off('close', onClientPrematureClose);

      if (allowFallback && fallback && !upstreamResponded && !res.headersSent) {
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

    upstreamReq.end(bodyBuffer);
  };

  startAttempt(targetPort, slotName, Boolean(fallback));
}

async function handleMergedRunning(req, res, currentState) {
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

  if (!activeRes.ok) {
    sendJson(res, 502, { error: 'Active engine slot unavailable' }, currentState.activeSlot);
    return;
  }

  if (activeRes.statusCode !== 200 || !activeRes.json || !Array.isArray(activeRes.json.topics)) {
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
    drainingRes.json &&
    Array.isArray(drainingRes.json.topics)
  ) {
    const mergedTopics = [...new Set([...activeTopics, ...drainingRes.json.topics])];
    sendJson(res, 200, { topics: mergedTopics }, 'merged');
    return;
  }

  sendJson(res, 200, { topics: activeTopics }, currentState.activeSlot);
}

async function handleRequest(req, res) {
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
      status: 'ok',
      switchEpoch: cur.switchEpoch,
      topicsStartedOnActiveCount: topicsStartedOnActive.size,
    });
    return;
  }

  const cur = reloadState(false);

  // Fast path: single active slot, zero buffering, zero status subrequests
  if (!cur.drainingPort || !cur.drainingSlot) {
    proxyStreamRequest(req, res, cur.activePort, cur.activeSlot);
    return;
  }

  const normPath = normalizeApiV1Path(pathname);
  const fallback = { fallbackPort: cur.activePort, fallbackSlot: cur.activeSlot };

  // 1. GET /chat/api/v1/responses/running(/)
  if (method === 'GET' && normPath === '/api/v1/responses/running') {
    await handleMergedRunning(req, res, cur);
    return;
  }

  // 2. POST /chat/api/v1/responses/:id/cancel(/)
  const cancelMatch =
    method === 'POST' ? /^\/api\/v1\/responses\/([^/]+)\/cancel$/.exec(normPath) : null;
  if (cancelMatch) {
    const id = safeDecodeParam(cancelMatch[1]);
    const drainStatus = await fetchDrainingStatus(cur.drainingPort);
    if (!drainStatus.unreachable && drainStatus.activeTopicIds.includes(id)) {
      proxyStreamRequest(req, res, cur.drainingPort, cur.drainingSlot, fallback);
    } else {
      proxyStreamRequest(req, res, cur.activePort, cur.activeSlot);
    }
    return;
  }

  // 3. GET /chat/api/v1/responses/:id(/) and GET /chat/api/v1/responses/:id/stream(/)
  const responseGetMatch =
    method === 'GET' ? /^\/api\/v1\/responses\/([^/]+)(?:\/stream)?$/.exec(normPath) : null;
  if (responseGetMatch) {
    const id = safeDecodeParam(responseGetMatch[1]);
    if (id !== 'running') {
      const drainStatus = await fetchDrainingStatus(cur.drainingPort);
      const onDraining =
        !drainStatus.unreachable &&
        (drainStatus.activeTopicIds.includes(id) ||
          (drainStatus.retainedTopicIds.includes(id) && !topicsStartedOnActive.has(id)));

      if (onDraining) {
        proxyStreamRequest(req, res, cur.drainingPort, cur.drainingSlot, fallback);
      } else {
        proxyStreamRequest(req, res, cur.activePort, cur.activeSlot);
      }
      return;
    }
  }

  // 4. POST /chat/api/v1/responses(/)
  if (method === 'POST' && normPath === '/api/v1/responses') {
    let bodyBuf;
    try {
      bodyBuf = await readRequestBody(req, MAX_BODY_BYTES);
    } catch (err) {
      if (err?.code === 'PAYLOAD_TOO_LARGE') {
        sendJson(res, 413, { error: 'Request entity too large' }, cur.activeSlot);
      } else if (!res.writableEnded) {
        res.destroy();
      }
      return;
    }

    let parsed;
    try {
      parsed = bodyBuf.length > 0 ? JSON.parse(bodyBuf.toString('utf8')) : null;
    } catch {
      parsed = null;
    }

    const prevId =
      parsed && typeof parsed === 'object' && typeof parsed.previous_response_id === 'string'
        ? parsed.previous_response_id.trim()
        : '';

    if (prevId) {
      const drainStatus = await fetchDrainingStatus(cur.drainingPort);
      if (!drainStatus.unreachable && drainStatus.activeTopicIds.includes(prevId)) {
        proxyBufferedRequest(req, res, bodyBuf, cur.drainingPort, cur.drainingSlot, fallback);
        return;
      }
      rememberTopicOnActive(prevId);
    }

    proxyBufferedRequest(req, res, bodyBuf, cur.activePort, cur.activeSlot);
    return;
  }

  // 5. DELETE /chat/api/v1/messages(/) and DELETE /chat/api/v1/messages/:id(/)
  const singleDeleteMatch =
    method === 'DELETE' ? /^\/api\/v1\/messages\/([^/]+)$/.exec(normPath) : null;
  if (method === 'DELETE' && (normPath === '/api/v1/messages' || singleDeleteMatch)) {
    let bodyBuf;
    try {
      bodyBuf = await readRequestBody(req, MAX_BODY_BYTES);
    } catch (err) {
      if (err?.code === 'PAYLOAD_TOO_LARGE') {
        sendJson(res, 413, { error: 'Request entity too large' }, cur.activeSlot);
      } else if (!res.writableEnded) {
        res.destroy();
      }
      return;
    }

    let messageIds = [];
    if (singleDeleteMatch) {
      const singleId = safeDecodeParam(singleDeleteMatch[1]);
      if (singleId) messageIds = [singleId];
    } else if (bodyBuf.length > 0) {
      try {
        const parsed = JSON.parse(bodyBuf.toString('utf8'));
        if (Array.isArray(parsed?.messageIds)) {
          messageIds = parsed.messageIds.filter((id) => typeof id === 'string' && id.length > 0);
        }
      } catch {
        messageIds = [];
      }
    }

    if (messageIds.length > 0) {
      const drainStatus = await fetchDrainingStatus(cur.drainingPort);
      if (!drainStatus.unreachable && drainStatus.activeTopicIds.length > 0) {
        const ownsActive = await checkDrainingOwnsMessages(cur.drainingPort, messageIds);
        if (ownsActive) {
          proxyBufferedRequest(req, res, bodyBuf, cur.drainingPort, cur.drainingSlot, fallback);
          return;
        }
      }
    }

    proxyBufferedRequest(req, res, bodyBuf, cur.activePort, cur.activeSlot);
    return;
  }

  // 6. Everything else (/chat/f/..., /chat/api/agent/webhooks/..., /health, /topics, GET /messages, /files, /models)
  proxyStreamRequest(req, res, cur.activePort, cur.activeSlot);
}

let isShuttingDown = false;
let inFlightRequests = 0;

// Initial state load before listening
reloadState(true);

process.on('SIGHUP', () => {
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
        JSON.stringify({ host: ROUTER_HOST, pid: process.pid, port: boundPort }),
        'utf8',
      );
    } catch (err) {
      console.error('[engine-router] failed writing ROUTER_READY_FILE:', err);
    }
  }
  console.log(
    `[engine-router] listening on http://${ROUTER_HOST}:${boundPort} (active=${state.activeSlot}:${state.activePort}, state=${ROUTER_STATE_FILE})`,
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
