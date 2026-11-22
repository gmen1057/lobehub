/**
 * Hot-reloadable HTTP/SSE routing logic for headless LobeChat Blue-Green engine (`engine-router-core.mjs`).
 *
 * Loaded dynamically by the thin immutable socket wrapper `scripts/engine-router.mjs` and
 * hot-reloaded on `SIGHUP` (`<2ms`, zero socket drops, zero `systemctl restart`).
 * All mutable state (`state`, `slotServiceKeys`, `topicsStartedOnActive`, `inFlightTopicPosts`,
 * `inFlightRequests`, `totalBufferedBytes`, `upstreamAgent`) lives in the `runtime` object passed
 * by `engine-router.mjs`, so active SSE streams and topic pins survive hot-reloads seamlessly.
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';

const ROUTER_UPSTREAM_HOST = process.env.ROUTER_UPSTREAM_HOST || '127.0.0.1';
const ROUTER_STATE_FILE = process.env.ROUTER_STATE_FILE || '/var/lib/lobechat-engine/state.json';
const ROUTER_ENV_FILE = process.env.ROUTER_ENV_FILE || '/opt/lobechat-next/.env';
const ROUTER_FALLBACK_KEY_FILE = '/opt/lobechat-next-router/.service-key.env';
const ROUTER_SLOT_ENV_DIR_PREFIX = process.env.ROUTER_SLOT_ENV_DIR_PREFIX || '/opt/lobechat-next-';
const ROUTER_KEY_DIR =
  process.env.ROUTER_KEY_DIR || path.dirname(ROUTER_ENV_FILE || ROUTER_FALLBACK_KEY_FILE);
const STATUS_TIMEOUT_MS = Number.parseInt(process.env.ROUTER_STATUS_TIMEOUT_MS ?? '1500', 10);
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
const IN_FLIGHT_TOPIC_GRACE_MS = Number.parseInt(
  process.env.ROUTER_IN_FLIGHT_TOPIC_GRACE_MS ?? '2000',
  10,
);

function rememberTopicOnActive(runtime, topicId) {
  if (!topicId) return;
  if (runtime.topicsStartedOnActive.size >= MAX_TRACKED_ACTIVE_TOPICS) {
    const oldest = runtime.topicsStartedOnActive.values().next().value;
    if (oldest !== undefined) runtime.topicsStartedOnActive.delete(oldest);
  }
  runtime.topicsStartedOnActive.add(topicId);
}

function pruneInFlightTopicPosts(runtime, now = Date.now()) {
  if (runtime.inFlightTopicPosts.size === 0) return;
  for (const [topicId, entry] of runtime.inFlightTopicPosts) {
    if (entry.count <= 0 && now >= entry.untilMs) {
      runtime.inFlightTopicPosts.delete(topicId);
    }
  }
}

function getPinnedInFlightTopicPost(runtime, topicId) {
  if (!topicId) return null;
  const entry = runtime.inFlightTopicPosts.get(topicId);
  if (!entry) return null;
  if (entry.count <= 0 && Date.now() >= entry.untilMs) {
    runtime.inFlightTopicPosts.delete(topicId);
    return null;
  }
  return entry;
}

function acquireInFlightTopicPost(runtime, topicId, port, slot) {
  if (!topicId) return () => undefined;
  const now = Date.now();
  if (runtime.inFlightTopicPosts.size > 4096) {
    pruneInFlightTopicPosts(runtime, now);
  }

  let entry = runtime.inFlightTopicPosts.get(topicId);
  if (entry && entry.port === port) {
    entry.count += 1;
    entry.slot = slot;
    entry.untilMs = Math.max(entry.untilMs, now + IN_FLIGHT_TOPIC_GRACE_MS);
  } else {
    entry = {
      count: 1,
      port,
      slot,
      untilMs: now + IN_FLIGHT_TOPIC_GRACE_MS,
    };
    runtime.inFlightTopicPosts.set(topicId, entry);
  }

  let released = false;
  return (statusCode = 0) => {
    if (released) return;
    released = true;
    const current = runtime.inFlightTopicPosts.get(topicId);
    if (!current || current !== entry) return;
    current.count = Math.max(0, current.count - 1);
    if (statusCode >= 200 && statusCode < 300) {
      current.untilMs = Math.max(current.untilMs, Date.now() + IN_FLIGHT_TOPIC_GRACE_MS);
    } else if (current.count === 0 && Date.now() >= current.untilMs) {
      runtime.inFlightTopicPosts.delete(topicId);
    } else if (current.count === 0 && statusCode !== 409) {
      // Non-2xx / non-409 rejection (e.g. 400 validation error or socket failure) with 0 in-flight
      runtime.inFlightTopicPosts.delete(topicId);
    }
  };
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

function readServiceKeyFileSafe(filePath) {
  if (!filePath) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsedKey = parseServiceKeyFromEnvText(raw);
    if (parsedKey !== null && parsedKey.length > 0) {
      return parsedKey;
    }
  } catch {
    // File missing or unreadable (e.g. 0600 root:root .env under User=lobechat)
  }
  return null;
}

/**
 * Reloads global fallback key AND per-slot keys (#11):
 *   1. `${ROUTER_SLOT_ENV_DIR_PREFIX}${slot}/.env` (`/opt/lobechat-next-${slot}/.env`)
 *   2. `${ROUTER_KEY_DIR}/.service-key-${slot}.env` (`0640 root:lobechat` per-slot key mirror)
 *   3. `ROUTER_ENV_FILE` / `ROUTER_FALLBACK_KEY_FILE` / `/opt/lobechat-next/.env`
 *   4. `process.env.ARCKEP_ENGINE_SERVICE_KEY`
 */
export function reloadServiceKey(runtime) {
  const globalCandidates = [ROUTER_ENV_FILE];
  if (ROUTER_ENV_FILE !== ROUTER_FALLBACK_KEY_FILE) {
    globalCandidates.push(ROUTER_FALLBACK_KEY_FILE);
  }
  if (ROUTER_ENV_FILE !== '/opt/lobechat-next/.env') {
    globalCandidates.push('/opt/lobechat-next/.env');
  }

  let loadedGlobal = '';
  for (const filePath of globalCandidates) {
    const k = readServiceKeyFileSafe(filePath);
    if (k) {
      loadedGlobal = k;
      break;
    }
  }

  const envFallback = (process.env.ARCKEP_ENGINE_SERVICE_KEY || '').trim();
  if (loadedGlobal) {
    runtime.defaultServiceKey = loadedGlobal;
  } else if (envFallback && !runtime.defaultServiceKey) {
    runtime.defaultServiceKey = envFallback;
  }

  for (const slotName of ['blue', 'green']) {
    const ordered = [];
    const pushUnique = (k) => {
      if (k && !ordered.includes(k)) ordered.push(k);
    };
    pushUnique(readServiceKeyFileSafe(`${ROUTER_SLOT_ENV_DIR_PREFIX}${slotName}/.env`));
    pushUnique(readServiceKeyFileSafe(path.join(ROUTER_KEY_DIR, `.service-key-${slotName}.env`)));
    pushUnique(runtime.defaultServiceKey);
    pushUnique(envFallback);
    runtime.slotServiceKeys.set(slotName, ordered);
  }
}

function getServiceKeysForSlot(runtime, slotName) {
  if (slotName && runtime.slotServiceKeys.has(slotName)) {
    const keys = runtime.slotServiceKeys.get(slotName);
    if (keys && keys.length > 0) return keys;
  }
  return runtime.defaultServiceKey ? [runtime.defaultServiceKey] : [];
}

function getPrimaryServiceKeyForSlot(runtime, slotName) {
  return getServiceKeysForSlot(runtime, slotName)[0] || '';
}

function normalizeLoadedState(raw) {
  const activeSlot =
    typeof raw?.activeSlot === 'string' && raw.activeSlot ? raw.activeSlot : 'blue';
  const activePort = Number(raw?.activePort) || (activeSlot === 'green' ? 3405 : 3404);
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

export function reloadState(runtime, force = false) {
  const now = Date.now();
  if (!force && now - runtime.lastStatCheckAt < STAT_CHECK_INTERVAL_MS) {
    return runtime.state;
  }
  runtime.lastStatCheckAt = now;

  let stat;
  try {
    stat = fs.statSync(ROUTER_STATE_FILE);
  } catch {
    return runtime.state;
  }

  if (
    !force &&
    stat.mtimeMs === runtime.lastMtimeMs &&
    stat.ino === runtime.lastIno &&
    stat.size === runtime.lastSize
  ) {
    return runtime.state;
  }

  try {
    const rawText = fs.readFileSync(ROUTER_STATE_FILE, 'utf8');
    const parsed = JSON.parse(rawText);
    const next = normalizeLoadedState(parsed);

    const switchedActive =
      next.activeSlot !== runtime.state.activeSlot ||
      next.activePort !== runtime.state.activePort ||
      next.switchEpoch !== runtime.state.switchEpoch ||
      !next.drainingPort;

    runtime.lastMtimeMs = stat.mtimeMs;
    runtime.lastIno = stat.ino;
    runtime.lastSize = stat.size;

    const changed =
      next.activeSlot !== runtime.state.activeSlot ||
      next.activePort !== runtime.state.activePort ||
      next.drainingSlot !== runtime.state.drainingSlot ||
      next.drainingPort !== runtime.state.drainingPort ||
      next.switchEpoch !== runtime.state.switchEpoch;

    runtime.state = next;
    if (switchedActive) {
      runtime.topicsStartedOnActive.clear();
    }
    if (changed || force) {
      reloadServiceKey(runtime);
    }

    if (changed) {
      console.log(
        `[engine-router] state loaded: active=${runtime.state.activeSlot}:${runtime.state.activePort} draining=${
          runtime.state.drainingSlot
            ? `${runtime.state.drainingSlot}:${runtime.state.drainingPort}`
            : 'none'
        } epoch=${runtime.state.switchEpoch}`,
      );
    }
  } catch (error) {
    console.error('[engine-router] failed to reload state file:', error);
  }

  return runtime.state;
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
function requestSlotJson(
  runtime,
  { port, method, path: reqPath, headers = {}, body = null, timeoutMs = STATUS_TIMEOUT_MS },
) {
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
        agent: runtime.upstreamAgent,
        headers: reqHeaders,
        host: ROUTER_UPSTREAM_HOST,
        method,
        path: reqPath,
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

async function requestSlotControlJson(
  runtime,
  { port, slotName, method, path: reqPath, body = null },
) {
  const candidateKeys = getServiceKeysForSlot(runtime, slotName).filter(
    (k) => k && k.length >= MIN_SERVICE_KEY_LENGTH,
  );
  if (candidateKeys.length === 0) {
    const rawKey = getPrimaryServiceKeyForSlot(runtime, slotName);
    return requestSlotJson(runtime, {
      body,
      headers: {
        ...(rawKey ? { Authorization: `Bearer ${rawKey}` } : {}),
        ...(body !== null ? { 'Content-Type': 'application/json' } : {}),
        Host: 'arckep.ru',
      },
      method,
      path: reqPath,
      port,
      timeoutMs: STATUS_TIMEOUT_MS,
    });
  }

  let lastRes = null;
  for (const key of candidateKeys) {
    const res = await requestSlotJson(runtime, {
      body,
      headers: {
        Authorization: `Bearer ${key}`,
        ...(body !== null ? { 'Content-Type': 'application/json' } : {}),
        Host: 'arckep.ru',
      },
      method,
      path: reqPath,
      port,
      timeoutMs: STATUS_TIMEOUT_MS,
    });
    lastRes = res;
    if (!res.ok || res.statusCode !== 401) {
      return res;
    }
  }
  return lastRes;
}

/**
 * Tri-state slot status check:
 *   - `state: 'unreachable'` — process is stopped (`ECONNREFUSED`), 0 in-memory operations;
 *   - `state: 'ok'`          — HTTP 200 with valid JSON arrays `activeTopicIds`, `retainedTopicIds`, & `topicSeqs`;
 *   - `state: 'unknown'`     — timeout, `5xx`, `401`/`503`, malformed JSON, or socket reset while alive.
 */
async function fetchSlotStatus(runtime, port, slotName) {
  if (!port) {
    return { activeTopicIds: [], retainedTopicIds: [], state: 'unreachable', topicSeqs: {} };
  }

  const res = await requestSlotControlJson(runtime, {
    method: 'GET',
    path: '/chat/api/v1/arckep/engine-slot/status/',
    port,
    slotName,
  });

  if (!res || !res.ok) {
    if (res?.errorCode === 'ECONNREFUSED') {
      return { activeTopicIds: [], retainedTopicIds: [], state: 'unreachable', topicSeqs: {} };
    }
    return { activeTopicIds: [], retainedTopicIds: [], state: 'unknown', topicSeqs: {} };
  }

  if (
    res.statusCode !== 200 ||
    !res.validJson ||
    !res.json ||
    typeof res.json !== 'object' ||
    !Array.isArray(res.json.activeTopicIds) ||
    !Array.isArray(res.json.retainedTopicIds)
  ) {
    return { activeTopicIds: [], retainedTopicIds: [], state: 'unknown', topicSeqs: {} };
  }

  const topicSeqs =
    res.json.topicSeqs &&
    typeof res.json.topicSeqs === 'object' &&
    !Array.isArray(res.json.topicSeqs)
      ? res.json.topicSeqs
      : {};

  return {
    activeTopicIds: res.json.activeTopicIds,
    retainedTopicIds: res.json.retainedTopicIds,
    state: 'ok',
    topicSeqs,
  };
}

/**
 * Tri-state chunked message ownership check (supports up to 20,000 IDs in 1,000-ID batches):
 *   - `{ state: 'ok', ownsActiveTopic: boolean }`
 *   - `{ state: 'unreachable', ownsActiveTopic: false }` (`ECONNREFUSED`)
 *   - `{ state: 'unknown', ownsActiveTopic: false }` (timeout / `5xx` / auth / bad JSON)
 */
async function checkDrainingOwnsMessages(runtime, drainingPort, drainingSlot, messageIds) {
  if (!drainingPort || !Array.isArray(messageIds) || messageIds.length === 0) {
    return { ownsActiveTopic: false, state: 'ok' };
  }
  const primaryKey = getPrimaryServiceKeyForSlot(runtime, drainingSlot);
  if (!primaryKey || primaryKey.length < MIN_SERVICE_KEY_LENGTH) {
    return { ownsActiveTopic: false, state: 'unknown' };
  }

  for (let offset = 0; offset < messageIds.length; offset += OWNS_MESSAGES_CHUNK_SIZE) {
    const chunk = messageIds.slice(offset, offset + OWNS_MESSAGES_CHUNK_SIZE);
    const res = await requestSlotControlJson(runtime, {
      body: JSON.stringify({ messageIds: chunk }),
      method: 'POST',
      path: '/chat/api/v1/arckep/engine-slot/owns-messages/',
      port: drainingPort,
      slotName: drainingSlot,
    });

    if (!res || !res.ok) {
      if (res?.errorCode === 'ECONNREFUSED') {
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
 * Standalone byte-reservation tracker (#12): lives in its own top-level lexical scope so V8
 * NEVER retains `req` or `chunks` in a shared closure context while long SSE streams stay open!
 */
function createByteReservation(runtime) {
  let reserved = 0;
  let released = false;
  return {
    add(bytes) {
      if (released || bytes <= 0) return;
      reserved += bytes;
      runtime.totalBufferedBytes += bytes;
    },
    release() {
      if (released) return;
      released = true;
      runtime.totalBufferedBytes = Math.max(0, runtime.totalBufferedBytes - reserved);
      reserved = 0;
    },
  };
}

/**
 * Buffered request body reader with per-request size limit, global memory cap,
 * and read timeout. Returns a mutable `{ buffer, release }` handle so `buffer`
 * can be nulled out for GC immediately after `upstreamReq.end(buf)` (#12).
 */
function readRequestBody(runtime, req, requestCtx, maxBytes = MAX_BODY_BYTES) {
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
      runtime.totalBufferedBytes + declaredLength > MAX_TOTAL_BUFFERED_BYTES
    ) {
      const err = new Error('Router request buffer limit exceeded');
      err.code = 'BUFFER_LIMIT_EXCEEDED';
      reject(err);
      return;
    }

    let chunks = [];
    let total = 0;
    let finished = false;
    const reservation = createByteReservation(runtime);

    const fail = (err) => {
      if (finished) return;
      finished = true;
      cleanup();
      if (chunks) {
        chunks.length = 0;
        chunks = null;
      }
      reservation.release();
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
      if (runtime.totalBufferedBytes + chunk.length > MAX_TOTAL_BUFFERED_BYTES) {
        const err = new Error('Router request buffer limit exceeded');
        err.code = 'BUFFER_LIMIT_EXCEEDED';
        fail(err);
        return;
      }
      total += chunk.length;
      reservation.add(chunk.length);
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
      const fullBuffer =
        chunks.length === 0
          ? Buffer.alloc(0)
          : chunks.length === 1
            ? chunks[0]
            : Buffer.concat(chunks, total);
      chunks.length = 0;
      chunks = null;
      resolve({
        buffer: fullBuffer,
        release: reservation.release,
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

function buildForwardHeaders(incomingHeaders, contentLength = null) {
  const out = {};
  for (const [key, value] of Object.entries(incomingHeaders)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (lower === 'connection' || lower === 'keep-alive' || lower === 'upgrade') continue;
    if (contentLength !== null && (lower === 'transfer-encoding' || lower === 'content-length')) {
      continue;
    }
    out[key] = value;
  }
  if (contentLength !== null) {
    out['content-length'] = String(contentLength);
  }
  return out;
}

export function sendJson(res, statusCode, payload, slotHeader = null, extraHeaders = null) {
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

function handleBodyReadError(req, res, err, slotHeader) {
  const respondAfterBriefDrain = (statusCode, message) => {
    if (req.complete || req.destroyed) {
      sendJson(res, statusCode, { error: message }, slotHeader, { Connection: 'close' });
      return;
    }
    let responded = false;
    const finishResponse = () => {
      if (responded) return;
      responded = true;
      clearTimeout(drainTimer);
      req.off('end', finishResponse);
      req.off('error', finishResponse);
      sendJson(res, statusCode, { error: message }, slotHeader, { Connection: 'close' });
      if (!req.complete && !req.destroyed) {
        setImmediate(() => {
          if (!req.destroyed) req.destroy();
        });
      }
    };
    const drainTimer = setTimeout(finishResponse, 150);
    drainTimer.unref();
    req.once('end', finishResponse);
    req.once('error', finishResponse);
    req.resume();
  };

  if (err?.code === 'PAYLOAD_TOO_LARGE') {
    respondAfterBriefDrain(413, 'Request entity too large');
  } else if (err?.code === 'BODY_READ_TIMEOUT') {
    sendJson(res, 408, { error: 'Request body read timeout' }, slotHeader, { Connection: 'close' });
    setTimeout(() => {
      if (!req.destroyed) req.destroy();
    }, 50).unref();
  } else if (err?.code === 'BUFFER_LIMIT_EXCEEDED') {
    respondAfterBriefDrain(503, 'Router request buffer limit exceeded; retry shortly');
  } else if (!res.writableEnded && !res.destroyed) {
    res.destroy();
  }
}

function pipeUpstreamResponse(runtime, req, res, upstreamReq, upstreamRes, slotName, onDone) {
  let doneCalled = false;
  const finishOnce = () => {
    if (doneCalled) return;
    doneCalled = true;
    onDone();
  };

  const outHeaders = { ...upstreamRes.headers, ['x-lobechat-slot']: slotName };
  if (runtime.isShuttingDown) {
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
function proxyStreamRequest(runtime, req, res, requestCtx, targetPort, slotName, fallback = null) {
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
        agent: runtime.upstreamAgent,
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
        pipeUpstreamResponse(runtime, req, res, upstreamReq, upstreamRes, slot, () => {
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
 * Proxy an already-buffered mutating request (`bodyHandle`) to `targetPort`.
 * Detaches `bodyHandle.buffer` immediately upon writing to `upstreamReq` (#12) so the
 * `Buffer` is eligible for V8 GC throughout 20-minute SSE responses!
 * NEVER retries mutations on another slot (prevents duplicate POST/DELETE execution).
 */
function proxyBufferedRequest(
  runtime,
  req,
  res,
  requestCtx,
  bodyHandle,
  targetPort,
  slotName,
  { onBeforeHeadersClose = null, onResponseStatus = null } = {},
) {
  let payload = bodyHandle.buffer;
  bodyHandle.buffer = null;
  let releaseFn = bodyHandle.release;
  bodyHandle.release = () => undefined;

  let responseStatusReported = false;
  let onBeforeHeadersCloseFn = onBeforeHeadersClose;
  let onResponseStatusFn = onResponseStatus;

  const finishBuffer = () => {
    payload = null;
    const fn = releaseFn;
    releaseFn = null;
    fn?.();
  };

  const notifyEndedBeforeHeaders = () => {
    if (responseStatusReported) return;
    responseStatusReported = true;
    const fn = onBeforeHeadersCloseFn;
    onBeforeHeadersCloseFn = null;
    onResponseStatusFn = null;
    fn?.();
  };

  if (requestCtx.isDisconnected()) {
    finishBuffer();
    notifyEndedBeforeHeaders();
    return;
  }

  let upstreamFinished = false;
  let currentUpstreamRes = null;
  const contentLength = payload ? payload.length : 0;
  const forwardHeaders = buildForwardHeaders(req.headers, contentLength);

  const upstreamReq = http.request(
    {
      agent: runtime.upstreamAgent,
      headers: forwardHeaders,
      host: ROUTER_UPSTREAM_HOST,
      method: req.method,
      path: req.url,
      port: targetPort,
    },
    (upstreamRes) => {
      finishBuffer();
      const statusCode = upstreamRes.statusCode || 502;
      if (!responseStatusReported) {
        responseStatusReported = true;
        const statusCb = onResponseStatusFn;
        onResponseStatusFn = null;
        onBeforeHeadersCloseFn = null;
        statusCb?.(statusCode);
      }
      if (requestCtx.isDisconnected()) {
        upstreamRes.destroy();
        upstreamReq.destroy();
        offDisconnect();
        return;
      }
      currentUpstreamRes = upstreamRes;
      pipeUpstreamResponse(runtime, req, res, upstreamReq, upstreamRes, slotName, () => {
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
      notifyEndedBeforeHeaders();
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
    notifyEndedBeforeHeaders();
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
    notifyEndedBeforeHeaders();
    upstreamReq.destroy();
    return;
  }

  upstreamReq.end(payload, () => {
    // Request payload has left Node's userland buffer into kernel socket buffer (#12)
    finishBuffer();
  });
}

async function handleMergedRunning(runtime, req, res, requestCtx, currentState) {
  if (requestCtx.isDisconnected()) return;

  const forwardHeaders = buildForwardHeaders(req.headers, null);

  const [activeRes, drainingRes] = await Promise.all([
    requestSlotJson(runtime, {
      headers: forwardHeaders,
      method: 'GET',
      path: req.url,
      port: currentState.activePort,
      timeoutMs: 5000,
    }),
    requestSlotJson(runtime, {
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

function dispatchResponsesPostToSlot(
  runtime,
  req,
  res,
  requestCtx,
  bodyHandle,
  targetPort,
  targetSlot,
  prevId,
  sentEpoch,
  isActiveSlot,
) {
  const releaseTopicPin = prevId
    ? acquireInFlightTopicPost(runtime, prevId, targetPort, targetSlot)
    : null;
  proxyBufferedRequest(runtime, req, res, requestCtx, bodyHandle, targetPort, targetSlot, {
    onBeforeHeadersClose: () => {
      releaseTopicPin?.(0);
    },
    onResponseStatus: (code) => {
      releaseTopicPin?.(code);
      if (isActiveSlot && prevId && code >= 200 && code < 300) {
        // #9: Verify epoch & activePort STILL match at header arrival time!
        const latest = reloadState(runtime, false);
        if (latest.switchEpoch === sentEpoch && latest.activePort === targetPort) {
          rememberTopicOnActive(runtime, prevId);
        }
      }
    },
  });
}

/**
 * Resolve routing decision for a buffered POST /responses across epoch transitions (#9 + #10).
 */
async function routeBufferedResponsesPost(runtime, req, res, requestCtx, bodyHandle, prevId) {
  const discardBody = () => {
    bodyHandle.buffer = null;
    bodyHandle.release();
  };

  for (let attempt = 0; attempt < 3; attempt++) {
    if (requestCtx.isDisconnected()) {
      discardBody();
      return;
    }

    const cur = reloadState(runtime, false);
    if (!cur.drainingPort || !cur.drainingSlot || !prevId) {
      dispatchResponsesPostToSlot(
        runtime,
        req,
        res,
        requestCtx,
        bodyHandle,
        cur.activePort,
        cur.activeSlot,
        prevId,
        cur.switchEpoch,
        true,
      );
      return;
    }

    const drainStatus = await fetchSlotStatus(runtime, cur.drainingPort, cur.drainingSlot);
    if (requestCtx.isDisconnected()) {
      discardBody();
      return;
    }

    // Re-verify epoch right before sending in case rollback/drain completed during status probe
    const afterProbe = reloadState(runtime, false);
    if (
      afterProbe.switchEpoch !== cur.switchEpoch ||
      afterProbe.drainingPort !== cur.drainingPort
    ) {
      continue;
    }

    if (drainStatus.state === 'unknown') {
      discardBody();
      sendJson(
        res,
        503,
        { error: 'Cannot verify topic state on draining engine slot; retry shortly' },
        cur.drainingSlot,
      );
      return;
    }

    if (drainStatus.state === 'unreachable') {
      const stalePin = getPinnedInFlightTopicPost(runtime, prevId);
      if (stalePin && stalePin.port === cur.drainingPort) {
        runtime.inFlightTopicPosts.delete(prevId);
      }
      dispatchResponsesPostToSlot(
        runtime,
        req,
        res,
        requestCtx,
        bodyHandle,
        cur.activePort,
        cur.activeSlot,
        prevId,
        cur.switchEpoch,
        true,
      );
      return;
    }

    // #10: Route to drainingPort if topic is active there OR has an in-flight / recent POST pinned to drainingPort!
    const pinned = getPinnedInFlightTopicPost(runtime, prevId);
    const pinnedToDraining = Boolean(pinned && pinned.port === cur.drainingPort);

    if (drainStatus.activeTopicIds.includes(prevId) || pinnedToDraining) {
      dispatchResponsesPostToSlot(
        runtime,
        req,
        res,
        requestCtx,
        bodyHandle,
        cur.drainingPort,
        cur.drainingSlot,
        prevId,
        cur.switchEpoch,
        false,
      );
      return;
    }

    dispatchResponsesPostToSlot(
      runtime,
      req,
      res,
      requestCtx,
      bodyHandle,
      cur.activePort,
      cur.activeSlot,
      prevId,
      cur.switchEpoch,
      true,
    );
    return;
  }

  const finalState = reloadState(runtime, false);
  discardBody();
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
async function routeBufferedMessagesDelete(runtime, req, res, requestCtx, bodyHandle, messageIds) {
  const discardBody = () => {
    bodyHandle.buffer = null;
    bodyHandle.release();
  };

  for (let attempt = 0; attempt < 3; attempt++) {
    if (requestCtx.isDisconnected()) {
      discardBody();
      return;
    }

    const cur = reloadState(runtime, false);
    if (!cur.drainingPort || !cur.drainingSlot || messageIds.length === 0) {
      proxyBufferedRequest(
        runtime,
        req,
        res,
        requestCtx,
        bodyHandle,
        cur.activePort,
        cur.activeSlot,
      );
      return;
    }

    const drainStatus = await fetchSlotStatus(runtime, cur.drainingPort, cur.drainingSlot);
    if (requestCtx.isDisconnected()) {
      discardBody();
      return;
    }

    if (drainStatus.state === 'unknown') {
      const recheck = reloadState(runtime, false);
      if (recheck.switchEpoch !== cur.switchEpoch || recheck.drainingPort !== cur.drainingPort) {
        continue;
      }
      discardBody();
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
      const ownsResult = await checkDrainingOwnsMessages(
        runtime,
        cur.drainingPort,
        cur.drainingSlot,
        messageIds,
      );
      if (requestCtx.isDisconnected()) {
        discardBody();
        return;
      }
      if (ownsResult.state === 'unknown') {
        const recheck = reloadState(runtime, false);
        if (recheck.switchEpoch !== cur.switchEpoch || recheck.drainingPort !== cur.drainingPort) {
          continue;
        }
        discardBody();
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

    const afterProbe = reloadState(runtime, false);
    if (
      afterProbe.switchEpoch !== cur.switchEpoch ||
      afterProbe.drainingPort !== cur.drainingPort
    ) {
      continue;
    }

    if (routeToDraining) {
      proxyBufferedRequest(
        runtime,
        req,
        res,
        requestCtx,
        bodyHandle,
        cur.drainingPort,
        cur.drainingSlot,
      );
    } else {
      proxyBufferedRequest(
        runtime,
        req,
        res,
        requestCtx,
        bodyHandle,
        cur.activePort,
        cur.activeSlot,
      );
    }
    return;
  }

  const finalState = reloadState(runtime, false);
  discardBody();
  sendJson(
    res,
    503,
    { error: 'Engine slot state transitioning; retry shortly' },
    finalState.activeSlot,
  );
}

export async function handleRequest(req, res, runtime) {
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
  let parsedUrl = null;
  try {
    parsedUrl = new URL(req.url || '/', 'http://127.0.0.1');
    pathname = parsedUrl.pathname;
  } catch {
    pathname = '/';
  }

  // Loopback-only router diagnostics endpoint
  if (method === 'GET' && (pathname === '/__router/health' || pathname === '/__router/health/')) {
    if (!isLoopbackAddress(req.socket?.remoteAddress)) {
      sendJson(res, 403, { error: 'Forbidden' });
      return;
    }
    if (parsedUrl?.searchParams.get('gc') === '1' && typeof globalThis.gc === 'function') {
      globalThis.gc();
    }
    const cur = reloadState(runtime, false);
    const activeKeyOk =
      getPrimaryServiceKeyForSlot(runtime, cur.activeSlot).length >= MIN_SERVICE_KEY_LENGTH;
    const drainingKeyOk = cur.drainingSlot
      ? getPrimaryServiceKeyForSlot(runtime, cur.drainingSlot).length >= MIN_SERVICE_KEY_LENGTH
      : true;
    sendJson(res, 200, {
      activePort: cur.activePort,
      activeSlot: cur.activeSlot,
      arrayBuffersBytes: process.memoryUsage().arrayBuffers,
      drainingPort: cur.drainingPort,
      drainingSlot: cur.drainingSlot,
      inFlightRequests: Math.max(0, runtime.inFlightRequests - 1),
      inFlightTopicPostsCount: runtime.inFlightTopicPosts.size,
      reloadCount: runtime.reloadCount,
      routerHash: runtime.routerHash,
      serviceKeyConfigured: activeKeyOk && drainingKeyOk,
      shellHash: runtime.shellHash,
      socketActivated: Boolean(runtime.socketActivated),
      status: 'ok',
      switchEpoch: cur.switchEpoch,
      topicsStartedOnActiveCount: runtime.topicsStartedOnActive.size,
      totalBufferedBytes: runtime.totalBufferedBytes,
    });
    return;
  }

  const normPath = normalizeApiV1Path(pathname);

  // #10: ALWAYS handle POST /api/v1/responses through buffered topic tracker (even before a switch
  // when drainingPort is null!) so in-flight topic POSTs are tracked across slot switches!
  if (method === 'POST' && normPath === '/api/v1/responses') {
    let bodyHandle;
    try {
      bodyHandle = await readRequestBody(runtime, req, requestCtx, MAX_BODY_BYTES);
    } catch (err) {
      handleBodyReadError(req, res, err, reloadState(runtime, false).activeSlot);
      return;
    }

    const prevId = (() => {
      const headerPrevId =
        typeof req.headers['x-arckep-previous-response-id'] === 'string'
          ? req.headers['x-arckep-previous-response-id'].trim()
          : '';
      try {
        const parsed =
          bodyHandle.buffer && bodyHandle.buffer.length > 0
            ? JSON.parse(bodyHandle.buffer.toString('utf8'))
            : null;
        return parsed &&
          typeof parsed === 'object' &&
          typeof parsed.previous_response_id === 'string'
          ? parsed.previous_response_id.trim()
          : headerPrevId;
      } catch {
        return headerPrevId;
      }
    })();

    await routeBufferedResponsesPost(runtime, req, res, requestCtx, bodyHandle, prevId);
    return;
  }

  const cur = reloadState(runtime, false);

  // Fast path: single active slot, zero buffering, zero status subrequests
  if (!cur.drainingPort || !cur.drainingSlot) {
    proxyStreamRequest(runtime, req, res, requestCtx, cur.activePort, cur.activeSlot);
    return;
  }

  // 1. GET /chat/api/v1/responses/running(/)
  if (method === 'GET' && normPath === '/api/v1/responses/running') {
    await handleMergedRunning(runtime, req, res, requestCtx, cur);
    return;
  }

  // 2. POST /chat/api/v1/responses/:id/cancel(/)
  const cancelMatch =
    method === 'POST' ? /^\/api\/v1\/responses\/([^/]+)\/cancel$/.exec(normPath) : null;
  if (cancelMatch) {
    const id = safeDecodeParam(cancelMatch[1]);
    for (let attempt = 0; attempt < 3; attempt++) {
      const snap = reloadState(runtime, false);
      if (!snap.drainingPort || !snap.drainingSlot) {
        proxyStreamRequest(runtime, req, res, requestCtx, snap.activePort, snap.activeSlot);
        return;
      }
      const drainStatus = await fetchSlotStatus(runtime, snap.drainingPort, snap.drainingSlot);
      if (requestCtx.isDisconnected()) return;

      const latest = reloadState(runtime, false);
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
      const pinned = getPinnedInFlightTopicPost(runtime, id);
      if (
        drainStatus.state === 'ok' &&
        (drainStatus.activeTopicIds.includes(id) ||
          Boolean(pinned && pinned.port === snap.drainingPort))
      ) {
        // NEVER fallback POST /cancel onto activePort
        proxyStreamRequest(runtime, req, res, requestCtx, snap.drainingPort, snap.drainingSlot);
      } else {
        proxyStreamRequest(runtime, req, res, requestCtx, snap.activePort, snap.activeSlot);
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
        const snap = reloadState(runtime, false);
        if (!snap.drainingPort || !snap.drainingSlot) {
          proxyStreamRequest(runtime, req, res, requestCtx, snap.activePort, snap.activeSlot);
          return;
        }
        const getFallback = { fallbackPort: snap.activePort, fallbackSlot: snap.activeSlot };
        const drainStatus = await fetchSlotStatus(runtime, snap.drainingPort, snap.drainingSlot);
        if (requestCtx.isDisconnected()) return;

        let targetDraining = false;
        if (drainStatus.state === 'ok') {
          const drainingHasActive = drainStatus.activeTopicIds.includes(id);
          if (drainingHasActive) {
            targetDraining = true;
          } else if (drainStatus.retainedTopicIds.includes(id)) {
            const pinnedPost = getPinnedInFlightTopicPost(runtime, id);
            const pinnedToActive = Boolean(pinnedPost && pinnedPost.port === snap.activePort);
            if (runtime.topicsStartedOnActive.has(id) || pinnedToActive) {
              targetDraining = false;
            } else {
              // #9 + v3 #3: Check activePort as ground truth and compare `topicSeqs[id]` (`startedAtMs`)
              // when BOTH slots hold retained completed turns (e.g. after fast `--rollback`).
              // When `drainingPort` ONLY holds a completed turn in `retainedTopicIds` (`!drainingHasActive`)
              // and `activePort` status is `unknown` (timeout / 5xx / parse error) or unreachable, return
              // 503 Service Unavailable instead of blindly serving stale HTTP 200 from `drainingPort`!
              const activeStatus = await fetchSlotStatus(runtime, snap.activePort, snap.activeSlot);
              if (requestCtx.isDisconnected()) return;
              if (activeStatus.state === 'ok') {
                if (activeStatus.activeTopicIds.includes(id)) {
                  const latest = reloadState(runtime, false);
                  if (
                    latest.switchEpoch === snap.switchEpoch &&
                    latest.activePort === snap.activePort
                  ) {
                    rememberTopicOnActive(runtime, id);
                  }
                  targetDraining = false;
                } else if (activeStatus.retainedTopicIds.includes(id)) {
                  const drainTs = Number(drainStatus.topicSeqs?.[id] ?? 0);
                  const activeTs = Number(activeStatus.topicSeqs?.[id] ?? 0);
                  if (drainTs > activeTs) {
                    targetDraining = true;
                  } else {
                    const latest = reloadState(runtime, false);
                    if (
                      latest.switchEpoch === snap.switchEpoch &&
                      latest.activePort === snap.activePort
                    ) {
                      rememberTopicOnActive(runtime, id);
                    }
                    targetDraining = false;
                  }
                } else {
                  targetDraining = true;
                }
              } else {
                const latestCheck = reloadState(runtime, false);
                if (
                  latestCheck.switchEpoch !== snap.switchEpoch ||
                  latestCheck.drainingPort !== snap.drainingPort
                ) {
                  continue;
                }
                sendJson(
                  res,
                  503,
                  { error: 'Active engine slot status temporarily unavailable; retry shortly' },
                  snap.activeSlot,
                );
                return;
              }
            }
          }
        } else if (drainStatus.state === 'unknown') {
          // Serve from activePort ONLY if topic is actively running there (unambiguously newest);
          // otherwise fail-closed 503 rather than risking a stale turn or false 404!
          const activeStatus = await fetchSlotStatus(runtime, snap.activePort, snap.activeSlot);
          if (requestCtx.isDisconnected()) return;
          if (
            activeStatus.state === 'ok' &&
            (activeStatus.activeTopicIds.includes(id) ||
              (runtime.topicsStartedOnActive.has(id) && activeStatus.retainedTopicIds.includes(id)))
          ) {
            targetDraining = false;
          } else {
            const latestCheck = reloadState(runtime, false);
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

        const latest = reloadState(runtime, false);
        if (latest.switchEpoch !== snap.switchEpoch || latest.drainingPort !== snap.drainingPort) {
          continue;
        }

        if (targetDraining) {
          proxyStreamRequest(
            runtime,
            req,
            res,
            requestCtx,
            snap.drainingPort,
            snap.drainingSlot,
            getFallback,
          );
        } else {
          proxyStreamRequest(runtime, req, res, requestCtx, snap.activePort, snap.activeSlot);
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

  // 5. DELETE /chat/api/v1/messages(/) and DELETE /chat/api/v1/messages/:id(/)
  const singleDeleteMatch =
    method === 'DELETE' ? /^\/api\/v1\/messages\/([^/]+)$/.exec(normPath) : null;
  if (method === 'DELETE' && (normPath === '/api/v1/messages' || singleDeleteMatch)) {
    let bodyHandle;
    try {
      bodyHandle = await readRequestBody(runtime, req, requestCtx, MAX_BODY_BYTES);
    } catch (err) {
      handleBodyReadError(req, res, err, reloadState(runtime, false).activeSlot);
      return;
    }

    let messageIds = [];
    if (singleDeleteMatch) {
      const singleId = safeDecodeParam(singleDeleteMatch[1]);
      if (singleId) messageIds = [singleId];
    } else if (bodyHandle.buffer && bodyHandle.buffer.length > 0) {
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
      bodyHandle.buffer = null;
      bodyHandle.release();
      sendJson(
        res,
        400,
        { error: `Too many messageIds (maximum ${OWNS_MESSAGES_MAX_IDS})` },
        reloadState(runtime, false).activeSlot,
      );
      return;
    }

    await routeBufferedMessagesDelete(runtime, req, res, requestCtx, bodyHandle, messageIds);
    return;
  }

  // 6. Everything else (/chat/f/..., /chat/api/agent/webhooks/..., /health, /topics, GET /messages, /files, /models)
  const snap = reloadState(runtime, false);
  proxyStreamRequest(runtime, req, res, requestCtx, snap.activePort, snap.activeSlot);
}
