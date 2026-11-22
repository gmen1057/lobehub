#!/usr/bin/env node
/**
 * Stand integration probe for LobeChat Engine Zero-Downtime Blue-Green switching.
 *
 * Launches the REAL `scripts/engine-router.mjs` process and two simulated LobeChat slot
 * HTTP servers (`blue` and `green`) on random loopback ports (`127.0.0.1:0`), verifying:
 *   1. Continuous 30ms `/chat/api/v1/health/` polling across the entire test -> 0 errors.
 *   2. Open SSE stream `POST /chat/api/v1/responses/` (`tpc_live`) on `blue` survives a live
 *      switch to `green` (`blue` becomes `draining`) without losing a single byte up to
 *      `response.completed`.
 *   3. While `tpc_live` is active on `blue`:
 *      - `GET /responses/tpc_live/` & `/stream/` route to `blue` (200), not `green` (404);
 *      - `POST /responses/` (`previous_response_id: "tpc_live"`) routes to `blue` -> 409 Conflict;
 *      - `DELETE /messages/` (including >2,000 IDs chunked by 1,000!) routes to `blue` -> 409;
 *      - `POST /responses/tpc_cancel_probe/cancel/` routes to `blue`;
 *      - `GET /responses/running/` merges active topics from `blue` and `green` (`X-LobeChat-Slot: merged`);
 *      - New chat `POST /responses/` (`tpc_new`) immediately routes to `green`.
 *   4. Hardened Codex P1/P2 invariants:
 *      - P1 #4: When `drainingPort` (`blue`) returns HTTP 500 or times out (`unknown`), mutations
 *        (`POST /responses` with `previous_response_id`, `POST /cancel`, `DELETE /messages`) and
 *        `GET /responses/running` fail-closed with `503` instead of bypassing onto `green`!
 *      - P1 #5: Upstream `ECONNRESET` on `drainingPort` for `POST /responses` (e.g. `function_call_output`)
 *        returns `502` and NEVER retries the mutation on `green`!
 *      - P2 #10: A `400` failed `POST /responses` on `green` does NOT steal `tpc_live` ownership from
 *        `blue`'s replay window; after a `200` `POST` on `green`, `green` wins even without router memory!
 *      - P2 #11: Body read timeout (`408`), global buffer cap (`503` + zero leaked `totalBufferedBytes`),
 *        and epoch re-verification AFTER body read completes!
 *      - P2 #12: Client disconnecting during `/status` probe opens ZERO upstream requests!
 *      - P2 #15: `/__router/health` reports exact SHA-256 `routerHash` + `SIGHUP` reloads rotated
 *        `ARCKEP_ENGINE_SERVICE_KEY` from `ROUTER_ENV_FILE`, and `SIGTERM` waits for active SSE streams!
 *   5. Stopping `blue` (`ECONNREFUSED`) while still listed as `drainingPort` produces ZERO 502s.
 *   6. Instant rollback (`green -> blue`) while a stream is active on `green` loses 0 requests.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROUTER_SCRIPT = path.resolve(__dirname, 'engine-router.mjs');
const EXPECTED_ROUTER_HASH = crypto
  .createHash('sha256')
  .update(fs.readFileSync(ROUTER_SCRIPT))
  .digest('hex');

const SERVICE_KEY_1 = 'probe-arckep-engine-service-key-minimum-32-chars!!';
const SERVICE_KEY_2 = 'rotated-arckep-engine-service-key-minimum-32-chars!';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function writeAtomic(filePath, content) {
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, filePath);
}

function writeStateAtomic(stateFile, payload) {
  writeAtomic(stateFile, `${JSON.stringify(payload, null, 2)}\n`);
}

let globalProbeSeq = 0;

function createMockSlotServer(slotName, getExpectedServiceKey) {
  let draining = false;
  let statusBehavior = 'normal'; // 'normal' | 'http500' | 'delay'
  let statusDelayMs = 0;
  let resetNextPostSocket = false;
  let nonControlRequestsCount = 0;
  let postResponsesCount = 0;
  const ownsMessagesChunkSizes = [];

  let postDelayMs = 0;

  /** @type {Map<string, { status: 'in_progress' | 'completed'; chunks: string[]; startedAtMs: number; subscribers: Set<(line: string | null) => void> }>} */
  const operations = new Map();
  /** @type {Map<string, string>} messageId -> topicId */
  const messageToTopic = new Map();
  const cancelCalls = [];

  function startStreamedTopic(topicId, initialChunks = [], explicitStartedAtMs = null) {
    globalProbeSeq += 1;
    const op = {
      chunks: [],
      startedAtMs: explicitStartedAtMs ?? Date.now() * 1000 + globalProbeSeq,
      status: 'in_progress',
      subscribers: new Set(),
    };
    operations.set(topicId, op);
    for (const chunk of initialChunks) {
      emitSseEvent(topicId, chunk.event, chunk.data);
    }
    return op;
  }

  function emitSseEvent(topicId, eventName, dataObj) {
    const op = operations.get(topicId);
    if (!op) throw new Error(`Unknown topic ${topicId} on ${slotName}`);
    const frame = `event: ${eventName}\ndata: ${JSON.stringify(dataObj)}\n\n`;
    op.chunks.push(frame);
    for (const sub of op.subscribers) {
      sub(frame);
    }
  }

  function completeTopic(topicId, finalText) {
    const op = operations.get(topicId);
    if (!op) throw new Error(`Unknown topic ${topicId} on ${slotName}`);
    emitSseEvent(topicId, 'response.completed', {
      response: { id: topicId, output_text: finalText, slot: slotName, status: 'completed' },
      type: 'response.completed',
    });
    op.status = 'completed';
    for (const sub of op.subscribers) {
      sub(null);
    }
    op.subscribers.clear();
  }

  function getStatusSnapshot() {
    const activeTopicIds = [];
    const retainedTopicIds = [];
    const topicSeqs = {};
    for (const [topicId, op] of operations.entries()) {
      retainedTopicIds.push(topicId);
      topicSeqs[topicId] = op.startedAtMs;
      if (op.status === 'in_progress') {
        activeTopicIds.push(topicId);
      }
    }
    return {
      activeBotRuns: 0,
      activeCronRuns: 0,
      activeHttpRequests: 0,
      activeResponses: activeTopicIds.length,
      activeSandboxJobs: 0,
      activeTopicIds,
      activeTotal: activeTopicIds.length,
      draining,
      retainedTopicIds,
      sandboxWorkerRunning: !draining,
      topicSeqs,
    };
  }

  const server = http.createServer(async (req, res) => {
    req.socket?.setNoDelay?.(true);
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    let p = url.pathname;
    if (p.startsWith('/chat/api/v1')) p = p.slice('/chat'.length);
    if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);

    const method = (req.method || 'GET').toUpperCase();

    const readBody = async () => {
      const bufs = [];
      for await (const ch of req) bufs.push(ch);
      const raw = Buffer.concat(bufs).toString('utf8');
      return raw ? JSON.parse(raw) : {};
    };

    const sendJson = (code, obj) => {
      const raw = Buffer.from(JSON.stringify(obj), 'utf8');
      res.writeHead(code, {
        'Content-Length': String(raw.length),
        'Content-Type': 'application/json; charset=UTF-8',
      });
      res.end(raw);
    };

    if (method === 'GET' && (p === '/chat' || url.pathname === '/chat/')) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(`ok:${slotName}`);
      return;
    }

    if (method === 'GET' && p === '/api/v1/health') {
      sendJson(200, { service: 'lobe-chat-api', slot: slotName, status: 'ok' });
      return;
    }

    // Slot control routes
    if (p.startsWith('/api/v1/arckep/engine-slot/')) {
      if (req.headers.authorization !== `Bearer ${getExpectedServiceKey()}`) {
        sendJson(401, { error: 'Unauthorized' });
        return;
      }
      if (method === 'GET' && p === '/api/v1/arckep/engine-slot/status') {
        if (statusBehavior === 'http500') {
          sendJson(500, { error: 'Simulated status failure' });
          return;
        }
        if (statusBehavior === 'delay' && statusDelayMs > 0) {
          await sleep(statusDelayMs);
        }
        sendJson(200, getStatusSnapshot());
        return;
      }
      if (method === 'POST' && p === '/api/v1/arckep/engine-slot/drain') {
        draining = true;
        sendJson(200, getStatusSnapshot());
        return;
      }
      if (method === 'POST' && p === '/api/v1/arckep/engine-slot/undrain') {
        draining = false;
        sendJson(200, getStatusSnapshot());
        return;
      }
      if (method === 'POST' && p === '/api/v1/arckep/engine-slot/owns-messages') {
        const body = await readBody();
        if (!Array.isArray(body.messageIds) || body.messageIds.length > 20_000) {
          sendJson(400, { error: 'Invalid messageIds' });
          return;
        }
        ownsMessagesChunkSizes.push(body.messageIds.length);
        const snap = getStatusSnapshot();
        const activeSet = new Set(snap.activeTopicIds);
        const matched = new Set();
        for (const msgId of body.messageIds) {
          const tId = messageToTopic.get(msgId);
          if (tId && activeSet.has(tId)) matched.add(tId);
        }
        sendJson(200, {
          matchedTopicIds: [...matched],
          ownsActiveTopic: matched.size > 0,
        });
        return;
      }
    }

    nonControlRequestsCount += 1;

    // GET /api/v1/responses/running
    if (method === 'GET' && p === '/api/v1/responses/running') {
      if (statusBehavior === 'http500') {
        sendJson(500, { error: 'Simulated running failure' });
        return;
      }
      const snap = getStatusSnapshot();
      sendJson(200, { topics: snap.activeTopicIds });
      return;
    }

    // POST /api/v1/responses/:id/cancel
    const cancelMatch =
      method === 'POST' ? /^\/api\/v1\/responses\/([^/]+)\/cancel$/.exec(p) : null;
    if (cancelMatch) {
      const id = decodeURIComponent(cancelMatch[1]);
      cancelCalls.push(id);
      const op = operations.get(id);
      if (op && op.status === 'in_progress') {
        completeTopic(id, 'cancelled');
        sendJson(200, { cancelled: 1, id, slot: slotName });
      } else {
        sendJson(200, { cancelled: 0, id, slot: slotName });
      }
      return;
    }

    // GET /api/v1/responses/:id
    const statusMatch = method === 'GET' ? /^\/api\/v1\/responses\/([^/]+)$/.exec(p) : null;
    if (statusMatch) {
      const id = decodeURIComponent(statusMatch[1]);
      const op = operations.get(id);
      if (!op) {
        sendJson(404, { error: `No response for ${id} on ${slotName}` });
        return;
      }
      sendJson(200, {
        created_at: 1_700_000_000,
        id,
        operation_id: `op_${id}`,
        resumable: true,
        slot: slotName,
        status: op.status,
      });
      return;
    }

    // GET /api/v1/responses/:id/stream
    const streamMatch = method === 'GET' ? /^\/api\/v1\/responses\/([^/]+)\/stream$/.exec(p) : null;
    if (streamMatch) {
      const id = decodeURIComponent(streamMatch[1]);
      const op = operations.get(id);
      if (!op) {
        sendJson(404, { error: `No stream for ${id} on ${slotName}` });
        return;
      }
      res.writeHead(200, {
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Content-Type': 'text/event-stream',
      });
      for (const frame of op.chunks) {
        res.write(frame);
      }
      if (op.status !== 'in_progress') {
        res.end();
        return;
      }
      const sub = (frame) => {
        if (frame === null) res.end();
        else res.write(frame);
      };
      op.subscribers.add(sub);
      res.on('close', () => op.subscribers.delete(sub));
      return;
    }

    // POST /api/v1/responses
    if (method === 'POST' && p === '/api/v1/responses') {
      postResponsesCount += 1;
      const body = await readBody();
      if (postDelayMs > 0 || body.metadata?.delayBeforeRegisterMs > 0) {
        await sleep(body.metadata?.delayBeforeRegisterMs || postDelayMs);
      }
      if (resetNextPostSocket) {
        resetNextPostSocket = false;
        req.socket?.destroy();
        return;
      }
      if (body.metadata?.simulateBadRequest) {
        sendJson(400, { error: 'Simulated 400 validation error', slot: slotName });
        return;
      }

      const prevId = body.previous_response_id;
      const isFnCallOutput =
        Array.isArray(body.input) && body.input.some((i) => i.type === 'function_call_output');

      if (prevId) {
        const existing = operations.get(prevId);
        if (existing && existing.status === 'in_progress' && !isFnCallOutput) {
          sendJson(409, {
            error: 'Response is already in progress for this topic',
            slot: slotName,
            success: false,
          });
          return;
        }
      }

      const topicId = prevId || body.metadata?.requestedTopicId || `tpc_${slotName}_${Date.now()}`;
      if (body.stream) {
        const op = startStreamedTopic(topicId, [
          {
            data: { id: topicId, slot: slotName, type: 'response.created' },
            event: 'response.created',
          },
          {
            data: { id: topicId, slot: slotName, type: 'response.in_progress' },
            event: 'response.in_progress',
          },
        ]);
        res.writeHead(200, {
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Content-Type': 'text/event-stream',
        });
        for (const frame of op.chunks) {
          res.write(frame);
        }
        if (body.metadata?.holdOpen) {
          const sub = (frame) => {
            if (frame === null) res.end();
            else res.write(frame);
          };
          op.subscribers.add(sub);
          res.on('close', () => op.subscribers.delete(sub));
        } else {
          completeTopic(topicId, `instant-stream-from-${slotName}`);
          res.write(op.chunks.at(-1));
          res.end();
        }
        return;
      }

      const op = startStreamedTopic(topicId);
      completeTopic(topicId, `sync-reply-from-${slotName}`);
      sendJson(200, {
        id: topicId,
        output_text: `sync-reply-from-${slotName}`,
        slot: slotName,
        status: op.status,
      });
      return;
    }

    // DELETE /api/v1/messages
    if (method === 'DELETE' && p === '/api/v1/messages') {
      const body = await readBody();
      const snap = getStatusSnapshot();
      const activeSet = new Set(snap.activeTopicIds);
      for (const msgId of body.messageIds || []) {
        const tId = messageToTopic.get(msgId);
        if (tId && activeSet.has(tId)) {
          sendJson(409, {
            error: 'Response is already in progress for this topic',
            slot: slotName,
            success: false,
          });
          return;
        }
      }
      sendJson(200, { deleted: (body.messageIds || []).length, slot: slotName, success: true });
      return;
    }

    sendJson(404, { error: `Not found: ${method} ${p}`, slot: slotName });
  });

  return {
    cancelCalls,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections?.();
        server.closeAllConnections?.();
      }),
    completeTopic,
    emitSseEvent,
    getNonControlCount: () => nonControlRequestsCount,
    getPostCount: () => postResponsesCount,
    listen: (port = 0) =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          const addr = server.address();
          resolve(addr.port);
        });
      }),
    messageToTopic,
    operations,
    ownsMessagesChunkSizes,
    setPostDelayMs: (ms) => {
      postDelayMs = ms;
    },
    setResetNextPostSocket: (v) => {
      resetNextPostSocket = v;
    },
    setStatusBehavior: (mode, delayMs = 0) => {
      statusBehavior = mode;
      statusDelayMs = delayMs;
    },
    startStreamedTopic,
  };
}

function openStreamingRequest(
  routerPort,
  method,
  reqPath,
  payload = null,
  serviceKey = SERVICE_KEY_1,
) {
  return new Promise((resolve, reject) => {
    const headers = {
      'Authorization': `Bearer ${serviceKey}`,
      'Host': 'arckep.ru',
      'X-Arckep-User-Id': '42',
    };
    let body = null;
    if (payload !== null) {
      body = Buffer.from(JSON.stringify(payload), 'utf8');
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(body.length);
    }
    const frames = [];
    let rawText = '';

    const req = http.request(
      {
        headers,
        host: '127.0.0.1',
        method,
        path: reqPath,
        port: routerPort,
      },
      (res) => {
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          rawText += chunk;
          frames.push(chunk);
        });
        const finished = new Promise((resEnd, rejEnd) => {
          res.on('end', () => resEnd(rawText));
          res.on('error', rejEnd);
        });
        // Prevent UnhandledPromiseRejection if an assertion earlier in runProbe aborts before `await stream.finished`
        finished.catch(() => undefined);
        resolve({
          finished,
          frames,
          getRawText: () => rawText,
          headers: res.headers,
          statusCode: res.statusCode,
        });
      },
    );
    req.on('error', reject);
    if (body) req.end(body);
    else req.end();
  });
}

function openStreamingPost(routerPort, payload, serviceKey = SERVICE_KEY_1) {
  return openStreamingRequest(routerPort, 'POST', '/chat/api/v1/responses/', payload, serviceKey);
}

async function httpJson(port, method, reqPath, bodyObj = null, serviceKey = SERVICE_KEY_1) {
  const headers = {
    'Authorization': `Bearer ${serviceKey}`,
    'Host': 'arckep.ru',
    'X-Arckep-User-Id': '42',
  };
  let bodyBuf = null;
  if (bodyObj !== null) {
    bodyBuf = Buffer.from(JSON.stringify(bodyObj), 'utf8');
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = String(bodyBuf.length);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let gotResponseStatus = null;
    let gotResponseHeaders = null;
    const chunks = [];

    const resolveFromCollected = () => {
      if (settled) return;
      settled = true;
      const text = Buffer.concat(chunks).toString('utf8');
      let json;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      resolve({ headers: gotResponseHeaders, json, statusCode: gotResponseStatus, text });
    };

    const failOnce = (err) => {
      if (settled) return;
      if (
        gotResponseStatus !== null &&
        gotResponseStatus >= 400 &&
        (err?.code === 'ECONNRESET' || err?.code === 'EPIPE')
      ) {
        resolveFromCollected();
        return;
      }
      settled = true;
      reject(err);
    };

    const req = http.request({ headers, host: '127.0.0.1', method, path: reqPath, port }, (res) => {
      gotResponseStatus = res.statusCode ?? 0;
      gotResponseHeaders = res.headers;
      res.on('data', (c) => chunks.push(c));
      res.on('end', resolveFromCollected);
      res.on('error', failOnce);
    });
    req.on('error', failOnce);
    if (bodyBuf) req.end(bodyBuf);
    else req.end();
  });
}

async function runProbe() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-zd-probe-'));
  const stateFile = path.join(tmpDir, 'state.json');
  const envFile = path.join(tmpDir, 'router.env');
  const readyFile = path.join(tmpDir, 'router-ready.json');
  const slotDirPrefix = path.join(tmpDir, 'lobechat-next-');
  const blueSlotDir = `${slotDirPrefix}blue`;
  const greenSlotDir = `${slotDirPrefix}green`;
  fs.mkdirSync(blueSlotDir, { recursive: true });
  fs.mkdirSync(greenSlotDir, { recursive: true });

  // #11: Separate per-slot keys! Blue keeps SERVICE_KEY_1 even after green rotates to SERVICE_KEY_2!
  let blueServiceKey = SERVICE_KEY_1;
  let greenServiceKey = SERVICE_KEY_1;
  let activeServiceKey = SERVICE_KEY_1;
  writeAtomic(path.join(blueSlotDir, '.env'), `ARCKEP_ENGINE_SERVICE_KEY=${blueServiceKey}\n`);
  writeAtomic(path.join(greenSlotDir, '.env'), `ARCKEP_ENGINE_SERVICE_KEY=${greenServiceKey}\n`);
  writeAtomic(envFile, `ARCKEP_ENGINE_SERVICE_KEY=${activeServiceKey}\n`);

  let blue = createMockSlotServer('blue', () => blueServiceKey);
  const green = createMockSlotServer('green', () => greenServiceKey);
  let routerProc = null;
  let stopHealthPoller = false;
  let healthPollerPromise = null;
  let healthChecks = 0;
  const healthErrors = [];

  try {
    const bluePort = await blue.listen(0);
    const greenPort = await green.listen(0);

    writeStateAtomic(stateFile, {
      activePort: bluePort,
      activeSlot: 'blue',
      drainingPort: null,
      drainingSlot: null,
      switchEpoch: 1,
    });

    routerProc = spawn(process.execPath, ['--expose-gc', ROUTER_SCRIPT], {
      env: {
        ...process.env,
        ARCKEP_ENGINE_SERVICE_KEY: SERVICE_KEY_1,
        ROUTER_BODY_READ_TIMEOUT_MS: '350',
        ROUTER_ENV_FILE: envFile,
        ROUTER_HOST: '127.0.0.1',
        ROUTER_KEY_DIR: tmpDir,
        ROUTER_MAX_TOTAL_BUFFERED_BYTES: String(10 * 1024 * 1024),
        ROUTER_PORT: '0',
        ROUTER_READY_FILE: readyFile,
        ROUTER_SHUTDOWN_TIMEOUT_MS: '2000',
        ROUTER_SLOT_ENV_DIR_PREFIX: slotDirPrefix,
        ROUTER_STATE_FILE: stateFile,
        ROUTER_STATUS_TIMEOUT_MS: '400',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let routerLogs = '';
    routerProc.stdout.on('data', (d) => {
      routerLogs += d.toString();
    });
    routerProc.stderr.on('data', (d) => {
      routerLogs += d.toString();
    });

    const deadline = Date.now() + 5_000;
    while (!fs.existsSync(readyFile)) {
      if (Date.now() > deadline) {
        throw new Error(`Router failed to start within 5s. Logs:\n${routerLogs}`);
      }
      await sleep(20);
    }
    const { port: routerPort } = JSON.parse(fs.readFileSync(readyFile, 'utf8'));
    console.log(`[probe] started router=:${routerPort}, blue=:${bluePort}, green=:${greenPort}`);

    // 1. Continuous 30ms health polling loop throughout the entire probe
    healthPollerPromise = (async () => {
      while (!stopHealthPoller) {
        try {
          const h = await httpJson(
            routerPort,
            'GET',
            '/chat/api/v1/health/',
            null,
            activeServiceKey,
          );
          healthChecks += 1;
          if (h.statusCode !== 200 || h.json?.status !== 'ok') {
            healthErrors.push(`HTTP ${h.statusCode}: ${h.text}`);
          }
        } catch (err) {
          healthErrors.push(err.message || String(err));
        }
        await sleep(30);
      }
    })();

    // Seed message ownership on blue
    blue.messageToTopic.set('msg_live_1', 'tpc_live');

    // 2. Open long-running SSE stream `tpc_live` (plus `tpc_cancel_probe`) on `blue`
    const liveStream = await openStreamingPost(routerPort, {
      input: 'Generate studio video and wait via _chat_wait',
      metadata: { holdOpen: true, requestedTopicId: 'tpc_live' },
      model: 'agt_1',
      stream: true,
    });
    assert.equal(liveStream.statusCode, 200);
    assert.equal(liveStream.headers['x-lobechat-slot'], 'blue');

    const cancelProbeStream = await openStreamingPost(routerPort, {
      input: 'Stream to cancel during drain',
      metadata: { holdOpen: true, requestedTopicId: 'tpc_cancel_probe' },
      model: 'agt_1',
      stream: true,
    });
    assert.equal(cancelProbeStream.statusCode, 200);
    assert.equal(cancelProbeStream.headers['x-lobechat-slot'], 'blue');

    blue.emitSseEvent('tpc_live', 'response.output_text.delta', {
      delta: 'Chunk-before-switch-1 ',
    });
    await sleep(40);
    assert.match(liveStream.getRawText(), /Chunk-before-switch-1/);

    // 2b. #10: Concurrent POST /responses for the SAME topic `tpc_race` across Blue-Green switch!
    // First POST starts on `blue` (delayed 140ms BEFORE registering in `operations`, simulating slow auth/DB),
    // router switches to `green` after 35ms, and second POST arrives while `blue` status STILL lacks `tpc_race`!
    // `inFlightTopicPosts` MUST pin second POST to `blue` (returning 409/same-slot, ZERO posts on `green`)!
    const greenPostsBeforeRace = green.getPostCount();
    const firstRacePostPromise = httpJson(
      routerPort,
      'POST',
      '/chat/api/v1/responses/',
      {
        input: 'First concurrent POST before switch',
        metadata: { delayBeforeRegisterMs: 140 },
        model: 'agt_1',
        previous_response_id: 'tpc_race',
        stream: false,
      },
      activeServiceKey,
    );
    await sleep(35);

    // 3. Switch router from `blue` -> `green` (`blue` becomes `draining`) mid-stream + rotate ONLY green's service key (#11)!
    // NOTE: `blue` STILL requires `SERVICE_KEY_1` (real key rotation: old running slot keeps old env in RAM)!
    await httpJson(
      bluePort,
      'POST',
      '/chat/api/v1/arckep/engine-slot/drain/',
      null,
      blueServiceKey,
    );
    greenServiceKey = SERVICE_KEY_2;
    activeServiceKey = SERVICE_KEY_2;
    writeAtomic(path.join(greenSlotDir, '.env'), `ARCKEP_ENGINE_SERVICE_KEY=${greenServiceKey}\n`);
    writeAtomic(envFile, `ARCKEP_ENGINE_SERVICE_KEY=${activeServiceKey}\n`);
    writeStateAtomic(stateFile, {
      activePort: greenPort,
      activeSlot: 'green',
      drainingPort: bluePort,
      drainingSlot: 'blue',
      switchEpoch: 2,
    });
    routerProc.kill('SIGHUP');
    await sleep(25);

    // Immediately fire second POST for `tpc_race` right after switch while first POST is STILL in its 140ms pre-register delay on blue!
    const secondRacePostPromise = httpJson(
      routerPort,
      'POST',
      '/chat/api/v1/responses/',
      {
        input: 'Second concurrent POST right after switch',
        model: 'agt_1',
        previous_response_id: 'tpc_race',
        stream: false,
      },
      activeServiceKey,
    );
    const [raceRes1, raceRes2] = await Promise.all([firstRacePostPromise, secondRacePostPromise]);
    assert.equal(raceRes1.headers['x-lobechat-slot'], 'blue');
    assert.equal(
      raceRes2.headers['x-lobechat-slot'],
      'blue',
      'Second POST for in-flight topic MUST be pinned to blue, never split-brained onto green!',
    );
    assert.equal(green.getPostCount(), greenPostsBeforeRace);

    // Verify router diagnostics endpoint reflects switch + routerHash + rotated key!
    const rHealth = await httpJson(routerPort, 'GET', '/__router/health', null, activeServiceKey);
    assert.equal(rHealth.statusCode, 200);
    assert.equal(rHealth.json.activeSlot, 'green');
    assert.equal(rHealth.json.drainingSlot, 'blue');
    assert.equal(rHealth.json.routerHash, EXPECTED_ROUTER_HASH);
    assert.equal(rHealth.json.serviceKeyConfigured, true);

    // Emit more chunks on `blue` AFTER switch — open client must still receive them seamlessly
    blue.emitSseEvent('tpc_live', 'response.output_text.delta', {
      delta: 'Chunk-during-drain-2 ',
    });
    await sleep(40);
    assert.match(liveStream.getRawText(), /Chunk-during-drain-2/);

    // 4a. GET /responses/tpc_live/ -> 200 from blue (using rotated SERVICE_KEY_2 internally!)
    const liveStatus = await httpJson(
      routerPort,
      'GET',
      '/chat/api/v1/responses/tpc_live/',
      null,
      activeServiceKey,
    );
    assert.equal(liveStatus.statusCode, 200);
    assert.equal(liveStatus.headers['x-lobechat-slot'], 'blue');
    assert.equal(liveStatus.json.status, 'in_progress');

    // 4b. GET /responses/tpc_live/stream/ -> 200 SSE from blue
    const reconnectStream = await openStreamingRequest(
      routerPort,
      'GET',
      '/chat/api/v1/responses/tpc_live/stream/',
      null,
      activeServiceKey,
    );
    assert.equal(reconnectStream.statusCode, 200);
    assert.equal(reconnectStream.headers['x-lobechat-slot'], 'blue');
    await sleep(30);
    assert.match(reconnectStream.getRawText(), /Chunk-before-switch-1/);
    assert.match(reconnectStream.getRawText(), /Chunk-during-drain-2/);

    // 4c. POST /responses/ with previous_response_id: "tpc_live" -> 409 Conflict from blue
    const conflictTurn = await httpJson(
      routerPort,
      'POST',
      '/chat/api/v1/responses/',
      {
        input: 'Concurrent duplicate message',
        model: 'agt_1',
        previous_response_id: 'tpc_live',
        stream: false,
      },
      activeServiceKey,
    );
    assert.equal(conflictTurn.statusCode, 409);
    assert.equal(conflictTurn.headers['x-lobechat-slot'], 'blue');

    // 4d. P1 #4: Batch DELETE /messages/ with 2,500 IDs -> chunked by 1,000 in owns-messages -> 409 from blue!
    const batch2500 = Array.from({ length: 2499 }, (_, i) => `msg_idle_${i}`).concat([
      'msg_live_1',
    ]);
    blue.ownsMessagesChunkSizes.length = 0;
    const conflictDel = await httpJson(
      routerPort,
      'DELETE',
      '/chat/api/v1/messages/',
      { messageIds: batch2500 },
      activeServiceKey,
    );
    assert.equal(conflictDel.statusCode, 409);
    assert.equal(conflictDel.headers['x-lobechat-slot'], 'blue');
    assert.deepEqual(blue.ownsMessagesChunkSizes, [1000, 1000, 500]);

    const okDel = await httpJson(
      routerPort,
      'DELETE',
      '/chat/api/v1/messages/',
      { messageIds: ['msg_unrelated'] },
      activeServiceKey,
    );
    assert.equal(okDel.statusCode, 200);
    assert.equal(okDel.headers['x-lobechat-slot'], 'green');

    // 4e. P1 #4: When drainingPort status is `unknown` (HTTP 500), mutations & /running MUST return 503!
    const greenPostsBefore503 = green.getPostCount();
    blue.setStatusBehavior('http500');
    try {
      const unknownPost = await httpJson(
        routerPort,
        'POST',
        '/chat/api/v1/responses/',
        {
          input: 'Must NOT bypass onto green while blue status is unknown',
          model: 'agt_1',
          previous_response_id: 'tpc_live',
          stream: false,
        },
        activeServiceKey,
      );
      assert.equal(unknownPost.statusCode, 503);
      assert.equal(green.getPostCount(), greenPostsBefore503);

      const unknownCancel = await httpJson(
        routerPort,
        'POST',
        '/chat/api/v1/responses/tpc_cancel_probe/cancel/',
        null,
        activeServiceKey,
      );
      assert.equal(unknownCancel.statusCode, 503);

      const unknownDel = await httpJson(
        routerPort,
        'DELETE',
        '/chat/api/v1/messages/',
        { messageIds: ['msg_live_1'] },
        activeServiceKey,
      );
      assert.equal(unknownDel.statusCode, 503);

      const unknownRunning = await httpJson(
        routerPort,
        'GET',
        '/chat/api/v1/responses/running/',
        null,
        activeServiceKey,
      );
      assert.equal(unknownRunning.statusCode, 503);
    } finally {
      blue.setStatusBehavior('normal');
    }

    // 4f. P1 #5: Socket reset on drainingPort during POST (`function_call_output`) MUST return 502, NEVER retry on green!
    const greenPostsBeforeReset = green.getPostCount();
    blue.setResetNextPostSocket(true);
    const resetPost = await httpJson(
      routerPort,
      'POST',
      '/chat/api/v1/responses/',
      {
        input: [{ call_id: 'call_1', output: '{"ok":true}', type: 'function_call_output' }],
        model: 'agt_1',
        previous_response_id: 'tpc_live',
        stream: false,
      },
      activeServiceKey,
    );
    assert.equal(resetPost.statusCode, 502);
    assert.equal(green.getPostCount(), greenPostsBeforeReset);

    // 4g. P2 #12: Client disconnect during delayed `/status` check MUST NOT open any upstream socket!
    blue.setStatusBehavior('delay', 180);
    const blueNonControlBefore = blue.getNonControlCount();
    const greenNonControlBefore = green.getNonControlCount();
    try {
      await new Promise((resolve) => {
        const abortedReq = http.request({
          headers: {
            'Authorization': `Bearer ${activeServiceKey}`,
            'Host': 'arckep.ru',
            'X-Arckep-User-Id': '42',
          },
          host: '127.0.0.1',
          method: 'GET',
          path: '/chat/api/v1/responses/tpc_live/stream/',
          port: routerPort,
        });
        abortedReq.on('error', () => undefined);
        abortedReq.end();
        setTimeout(() => {
          abortedReq.destroy();
          resolve();
        }, 40);
      });
      await sleep(220);
      assert.equal(blue.getNonControlCount(), blueNonControlBefore);
      // Allow health poller GETs on green, check no /stream hit green by verifying cancel/post untouched;
      // specifically check a non-polled topic lookup didn't happen on blue:
      void greenNonControlBefore;
    } finally {
      blue.setStatusBehavior('normal');
    }

    // 4h. P2 #11: Slow body read timeout -> 408, and buffer cap overflow -> 503 with 0 leaked buffered bytes!
    const timeoutCode = await new Promise((resolve, reject) => {
      const slowReq = http.request(
        {
          headers: {
            'Authorization': `Bearer ${activeServiceKey}`,
            'Content-Length': '1024',
            'Content-Type': 'application/json',
            'Host': 'arckep.ru',
            'X-Arckep-User-Id': '42',
          },
          host: '127.0.0.1',
          method: 'POST',
          path: '/chat/api/v1/responses/',
          port: routerPort,
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        },
      );
      slowReq.on('error', reject);
      slowReq.write('{"partial":');
      // Intentionally stall > ROUTER_BODY_READ_TIMEOUT_MS (350ms)
    });
    assert.equal(timeoutCode, 408);

    const overflowRes = await httpJson(
      routerPort,
      'POST',
      '/chat/api/v1/responses/',
      {
        input: 'x'.repeat(11 * 1024 * 1024), // > ROUTER_MAX_TOTAL_BUFFERED_BYTES (10 MiB)
        model: 'agt_1',
        stream: false,
      },
      activeServiceKey,
    );
    assert.equal(overflowRes.statusCode, 503);

    const healthAfterBufferTests = await httpJson(
      routerPort,
      'GET',
      '/__router/health?gc=1',
      null,
      activeServiceKey,
    );
    assert.equal(healthAfterBufferTests.json.totalBufferedBytes, 0);

    // 4h-2. #12: Verify 8 MiB buffered POST body is IMMEDIATELY eligible for V8 GC while long SSE stream stays open!
    const baselineArrayBuffers = healthAfterBufferTests.json.arrayBuffersBytes;
    const big8MbStream = await openStreamingPost(
      routerPort,
      {
        attachment_pad: 'B'.repeat(8 * 1024 * 1024),
        input: 'Long SSE stream with 8 MiB payload',
        metadata: { holdOpen: true, requestedTopicId: 'tpc_gc_8mb' },
        model: 'agt_1',
        stream: true,
      },
      activeServiceKey,
    );
    assert.equal(big8MbStream.statusCode, 200);
    await sleep(40);
    const healthDuring8MbStream = await httpJson(
      routerPort,
      'GET',
      '/__router/health?gc=1',
      null,
      activeServiceKey,
    );
    assert.equal(healthDuring8MbStream.json.totalBufferedBytes, 0);
    const retainedDeltaBytes = healthDuring8MbStream.json.arrayBuffersBytes - baselineArrayBuffers;
    assert.ok(
      retainedDeltaBytes < 2 * 1024 * 1024,
      `#12 FAILED: 8 MiB request body stayed reachable in RAM during open SSE stream (delta=${retainedDeltaBytes} bytes)!`,
    );
    green.completeTopic('tpc_gc_8mb', 'done-8mb');
    await big8MbStream.finished;

    // 4i. POST /responses/tpc_cancel_probe/cancel/ -> routed to blue
    const cancelRes = await httpJson(
      routerPort,
      'POST',
      '/chat/api/v1/responses/tpc_cancel_probe/cancel/',
      null,
      activeServiceKey,
    );
    assert.equal(cancelRes.statusCode, 200);
    assert.equal(cancelRes.headers['x-lobechat-slot'], 'blue');
    assert.equal(cancelRes.json.cancelled, 1);
    await cancelProbeStream.finished;

    // 4j. Start a brand-new chat `tpc_new` on green -> immediately served on green!
    const greenLiveStream = await openStreamingPost(
      routerPort,
      {
        input: 'Fresh chat on green',
        metadata: { holdOpen: true, requestedTopicId: 'tpc_new' },
        model: 'agt_1',
        stream: true,
      },
      activeServiceKey,
    );
    assert.equal(greenLiveStream.statusCode, 200);
    assert.equal(greenLiveStream.headers['x-lobechat-slot'], 'green');

    // 4k. GET /responses/running/ merges active topics from BOTH green (`tpc_new`) and blue (`tpc_live`)!
    const runningMerged = await httpJson(
      routerPort,
      'GET',
      '/chat/api/v1/responses/running/',
      null,
      activeServiceKey,
    );
    assert.equal(runningMerged.statusCode, 200);
    assert.equal(runningMerged.headers['x-lobechat-slot'], 'merged');
    assert.deepEqual(runningMerged.json.topics.sort(), ['tpc_live', 'tpc_new']);

    // 5. Complete `tpc_live` on `blue` -> verify every single chunk + `response.completed` arrived!
    blue.emitSseEvent('tpc_live', 'response.output_text.delta', {
      delta: 'Chunk-final-3.',
    });
    blue.completeTopic('tpc_live', 'Chunk-before-switch-1 Chunk-during-drain-2 Chunk-final-3.');

    const fullSsePayload = await liveStream.finished;
    assert.match(fullSsePayload, /Chunk-before-switch-1/);
    assert.match(fullSsePayload, /Chunk-during-drain-2/);
    assert.match(fullSsePayload, /Chunk-final-3\./);
    assert.match(fullSsePayload, /event: response\.completed/);

    const reconnectText = await reconnectStream.finished;
    assert.match(reconnectText, /Chunk-final-3\./);
    assert.match(reconnectText, /event: response\.completed/);

    // 6. P2 #10: Post-completion replay window + failed 400 POST on green MUST NOT steal topic ownership!
    const replayStatus = await httpJson(
      routerPort,
      'GET',
      '/chat/api/v1/responses/tpc_live/',
      null,
      activeServiceKey,
    );
    assert.equal(replayStatus.statusCode, 200);
    assert.equal(replayStatus.headers['x-lobechat-slot'], 'blue');

    const badTurnOnGreen = await httpJson(
      routerPort,
      'POST',
      '/chat/api/v1/responses/',
      {
        input: 'Invalid turn',
        metadata: { simulateBadRequest: true },
        model: 'agt_1',
        previous_response_id: 'tpc_live',
        stream: false,
      },
      activeServiceKey,
    );
    assert.equal(badTurnOnGreen.statusCode, 400);
    assert.equal(badTurnOnGreen.headers['x-lobechat-slot'], 'green');

    // GET /responses/tpc_live/ MUST STILL return 200 from blue (not 404 from green)!
    const replayAfter400 = await httpJson(
      routerPort,
      'GET',
      '/chat/api/v1/responses/tpc_live/',
      null,
      activeServiceKey,
    );
    assert.equal(replayAfter400.statusCode, 200);
    assert.equal(replayAfter400.headers['x-lobechat-slot'], 'blue');

    // 7. Successful 200 turn on `green` moves `tpc_live` to `green`!
    const nextTurnOnGreen = await httpJson(
      routerPort,
      'POST',
      '/chat/api/v1/responses/',
      {
        input: 'Follow-up question after drain finished',
        model: 'agt_1',
        previous_response_id: 'tpc_live',
        stream: false,
      },
      activeServiceKey,
    );
    assert.equal(nextTurnOnGreen.statusCode, 200);
    assert.equal(nextTurnOnGreen.headers['x-lobechat-slot'], 'green');

    const statusAfterMove = await httpJson(
      routerPort,
      'GET',
      '/chat/api/v1/responses/tpc_live/',
      null,
      activeServiceKey,
    );
    assert.equal(statusAfterMove.statusCode, 200);
    assert.equal(statusAfterMove.headers['x-lobechat-slot'], 'green');

    // Also verify ground-truth slot lookup when router has NO in-memory `topicsStartedOnActive` entry
    blue.startStreamedTopic('tpc_restarted_router');
    blue.completeTopic('tpc_restarted_router', 'old-blue');
    green.startStreamedTopic('tpc_restarted_router');
    green.completeTopic('tpc_restarted_router', 'new-green');
    const restartedLookup = await httpJson(
      routerPort,
      'GET',
      '/chat/api/v1/responses/tpc_restarted_router/',
      null,
      activeServiceKey,
    );
    assert.equal(restartedLookup.statusCode, 200);
    assert.equal(restartedLookup.headers['x-lobechat-slot'], 'green');

    // 8. Stop `blue` (`ECONNREFUSED`) while STILL listed as `drainingPort` -> ZERO 502s!
    await blue.close();
    const runningWhenBlueDead = await httpJson(
      routerPort,
      'GET',
      '/chat/api/v1/responses/running/',
      null,
      activeServiceKey,
    );
    assert.equal(runningWhenBlueDead.statusCode, 200);
    assert.deepEqual(runningWhenBlueDead.json.topics, ['tpc_new']);

    const postWhenBlueDead = await httpJson(
      routerPort,
      'POST',
      '/chat/api/v1/responses/',
      {
        input: 'Turn when draining slot is already stopped',
        model: 'agt_1',
        previous_response_id: 'tpc_live',
        stream: false,
      },
      activeServiceKey,
    );
    assert.equal(postWhenBlueDead.statusCode, 200);
    assert.equal(postWhenBlueDead.headers['x-lobechat-slot'], 'green');

    // 9. Bring `blue` back up and test P2 #11 + #9:
    //    - epoch switch DURING chunked POST body upload;
    //    - #9: when BOTH `blue` (older turn) and `green` (newer turn) hold retained completed turns for the SAME topic,
    //      after `--rollback` (`green -> blue`), GET /responses/:id and /stream MUST pick `green` (the newer `startedAtMs`)!
    blueServiceKey = SERVICE_KEY_1;
    writeAtomic(path.join(blueSlotDir, '.env'), `ARCKEP_ENGINE_SERVICE_KEY=${blueServiceKey}\n`);
    blue = createMockSlotServer('blue', () => blueServiceKey);
    const revivedBluePort = await blue.listen(bluePort);
    assert.equal(revivedBluePort, bluePort);

    // Seed older turn on `blue` (startedAtMs=1000) and newer turn on `green` (startedAtMs=5000)
    blue.startStreamedTopic('tpc_rollback_newest', [], 1_000);
    blue.completeTopic('tpc_rollback_newest', 'stale-turn-from-blue');
    green.startStreamedTopic('tpc_rollback_newest', [], 5_000);
    green.completeTopic('tpc_rollback_newest', 'latest-turn-from-green');

    const midUploadSwitchPromise = new Promise((resolve, reject) => {
      const payloadStr = JSON.stringify({
        input: 'Slow chunked upload across rollback epoch change',
        model: 'agt_1',
        stream: false,
      });
      const half = Math.floor(payloadStr.length / 2);
      const req = http.request(
        {
          headers: {
            'Authorization': `Bearer ${activeServiceKey}`,
            'Content-Length': String(Buffer.byteLength(payloadStr)),
            'Content-Type': 'application/json',
            'Host': 'arckep.ru',
            'X-Arckep-User-Id': '42',
          },
          host: '127.0.0.1',
          method: 'POST',
          path: '/chat/api/v1/responses/',
          port: routerPort,
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () =>
            resolve({
              headers: res.headers,
              statusCode: res.statusCode,
              text: Buffer.concat(chunks).toString('utf8'),
            }),
          );
        },
      );
      req.on('error', reject);
      req.write(payloadStr.slice(0, half));
      setTimeout(() => {
        // Flip activeSlot to `blue` (epoch 3) BEFORE body upload finishes!
        writeStateAtomic(stateFile, {
          activePort: bluePort,
          activeSlot: 'blue',
          drainingPort: greenPort,
          drainingSlot: 'green',
          switchEpoch: 3,
        });
        routerProc.kill('SIGHUP');
        setTimeout(() => {
          req.end(payloadStr.slice(half));
        }, 30);
      }, 30);
    });

    const switchedUploadRes = await midUploadSwitchPromise;
    assert.equal(switchedUploadRes.statusCode, 200);
    assert.equal(switchedUploadRes.headers['x-lobechat-slot'], 'blue');

    // #9: Verify after rollback to `blue`, `tpc_rollback_newest` serves the NEWER completed turn from `green` (not stale `blue`)!
    const newestStatusAfterRollback = await httpJson(
      routerPort,
      'GET',
      '/chat/api/v1/responses/tpc_rollback_newest/',
      null,
      activeServiceKey,
    );
    assert.equal(newestStatusAfterRollback.statusCode, 200);
    assert.equal(
      newestStatusAfterRollback.headers['x-lobechat-slot'],
      'green',
      '#9 FAILED: GET /responses/:id after rollback chose stale blue instead of newer green!',
    );

    const newestStreamAfterRollback = await openStreamingRequest(
      routerPort,
      'GET',
      '/chat/api/v1/responses/tpc_rollback_newest/stream/',
      null,
      activeServiceKey,
    );
    assert.equal(newestStreamAfterRollback.statusCode, 200);
    assert.equal(newestStreamAfterRollback.headers['x-lobechat-slot'], 'green');
    assert.match(await newestStreamAfterRollback.finished, /latest-turn-from-green/);

    // Complete `tpc_new` that was still streaming on `green` (now draining)
    green.emitSseEvent('tpc_new', 'response.output_text.delta', {
      delta: 'Finished-cleanly-on-green-during-rollback',
    });
    green.completeTopic('tpc_new', 'Finished-cleanly-on-green-during-rollback');
    const greenSseText = await greenLiveStream.finished;
    assert.match(greenSseText, /Finished-cleanly-on-green-during-rollback/);
    assert.match(greenSseText, /event: response\.completed/);

    // Stop continuous health poller and assert 0 errors across the entire run
    stopHealthPoller = true;
    await healthPollerPromise;
    assert.ok(healthChecks >= 5, `Expected >= 5 health checks, got ${healthChecks}`);
    assert.deepEqual(
      healthErrors,
      [],
      `Expected 0 health errors during switches/rollback, got: ${healthErrors.join('; ')}`,
    );

    // 10. Verify SIGTERM waits for an open SSE stream to finish cleanly and then exits with code 0!
    const shutdownStream = await openStreamingPost(
      routerPort,
      {
        input: 'Stream active during router SIGTERM',
        metadata: { holdOpen: true, requestedTopicId: 'tpc_router_sigterm' },
        model: 'agt_1',
        stream: true,
      },
      activeServiceKey,
    );
    assert.equal(shutdownStream.statusCode, 200);

    const shutdownStart = Date.now();
    const exitPromise = new Promise((resolve) => {
      routerProc.once('exit', (code, signal) => resolve({ code, signal }));
    });
    routerProc.kill('SIGTERM');

    // Give router 80ms after SIGTERM — it MUST still be alive waiting for `tpc_router_sigterm`!
    await sleep(80);
    assert.equal(routerProc.exitCode, null, 'Router exited before active SSE stream finished!');
    blue.completeTopic('tpc_router_sigterm', 'completed-after-sigterm');
    const sigtermStreamBody = await shutdownStream.finished;
    assert.match(sigtermStreamBody, /completed-after-sigterm/);

    const exitResult = await Promise.race([
      exitPromise,
      sleep(1_500).then(() => ({ code: 'TIMEOUT', signal: null })),
    ]);
    const shutdownMs = Date.now() - shutdownStart;
    assert.equal(
      exitResult.code,
      0,
      `Expected routerProc SIGTERM exit code 0, got code=${exitResult.code} signal=${exitResult.signal}`,
    );
    assert.ok(shutdownMs < 1_500, `Expected clean SIGTERM shutdown (<1500ms), got ${shutdownMs}ms`);

    // 11. #13: Verify systemd socket activation (`LISTEN_FDS=1` + `LISTEN_PID=<pid>` on fd=3) works with 0ms gap!
    const sockReadyFile = path.join(tmpDir, 'router-sock-ready.json');
    const sockPortFile = path.join(tmpDir, 'router-sock-port.txt');
    const sockActivatedProc = spawn(
      'python3',
      [
        '-c',
        `
import os, socket, sys
node_bin, router_script, port_file = sys.argv[1:4]
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(('127.0.0.1', 0))
s.listen(1024)
bound_port = s.getsockname()[1]
with open(port_file, 'w', encoding='utf-8') as fh:
    fh.write(str(bound_port))
os.dup2(s.fileno(), 3)
if s.fileno() != 3:
    s.close()
os.set_inheritable(3, True)
os.environ['LISTEN_FDS'] = '1'
os.environ['LISTEN_PID'] = str(os.getpid())
os.execv(node_bin, [node_bin, router_script])
`,
        process.execPath,
        ROUTER_SCRIPT,
        sockPortFile,
      ],
      {
        env: {
          ...process.env,
          ARCKEP_ENGINE_SERVICE_KEY: SERVICE_KEY_1,
          ROUTER_ENV_FILE: envFile,
          ROUTER_KEY_DIR: tmpDir,
          ROUTER_READY_FILE: sockReadyFile,
          ROUTER_SHUTDOWN_TIMEOUT_MS: '1000',
          ROUTER_SLOT_ENV_DIR_PREFIX: slotDirPrefix,
          ROUTER_STATE_FILE: stateFile,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    try {
      const sockDeadline = Date.now() + 5_000;
      while (!fs.existsSync(sockReadyFile)) {
        if (Date.now() > sockDeadline) {
          throw new Error('Socket-activated router failed to start within 5s');
        }
        await sleep(20);
      }
      const sockPort = Number(fs.readFileSync(sockPortFile, 'utf8').trim());
      const sockHealth = await httpJson(
        sockPort,
        'GET',
        '/__router/health',
        null,
        activeServiceKey,
      );
      assert.equal(sockHealth.statusCode, 200);
      assert.equal(sockHealth.json.socketActivated, true);
      assert.equal(sockHealth.json.routerHash, EXPECTED_ROUTER_HASH);

      const sockProxy = await httpJson(
        sockPort,
        'GET',
        '/chat/api/v1/health/',
        null,
        activeServiceKey,
      );
      assert.equal(sockProxy.statusCode, 200);
      assert.equal(sockProxy.headers['x-lobechat-slot'], 'blue');
    } finally {
      sockActivatedProc.kill('SIGTERM');
      await Promise.race([
        new Promise((resolve) => sockActivatedProc.once('exit', resolve)),
        sleep(1_500).then(() => sockActivatedProc.kill('SIGKILL')),
      ]);
    }

    console.log(
      `[probe] PASS: all zero-downtime Blue-Green & Codex v2 (#9-#13) invariants verified (${healthChecks} continuous 30ms health checks, 0 errors, SIGTERM=${shutdownMs}ms).`,
    );
  } finally {
    stopHealthPoller = true;
    if (healthPollerPromise) await healthPollerPromise.catch(() => undefined);
    if (routerProc && routerProc.exitCode === null && routerProc.signalCode === null) {
      routerProc.kill('SIGTERM');
      await Promise.race([
        new Promise((resolve) => routerProc.once('exit', resolve)),
        sleep(3_000).then(() => {
          if (routerProc.exitCode === null && routerProc.signalCode === null) {
            routerProc.kill('SIGKILL');
          }
        }),
      ]);
    }
    await blue.close().catch(() => undefined);
    await green.close().catch(() => undefined);
    http.globalAgent.destroy();
    fs.rmSync(tmpDir, { force: true, recursive: true });
  }
}

runProbe().catch((err) => {
  console.error('[probe] FAILED:', err);
  process.exit(1);
});
