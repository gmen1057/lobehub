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
 *      - `DELETE /messages/` for a message in `tpc_live` routes to `blue` -> 409 Conflict;
 *      - `POST /responses/tpc_live/cancel/` (tested via `tpc_cancel_probe`) routes to `blue`;
 *      - `GET /responses/running/` merges active topics from `blue` and `green` (`X-LobeChat-Slot: merged`);
 *      - New chat `POST /responses/` (`tpc_new`) immediately routes to `green` (`X-LobeChat-Slot: green`).
 *   4. After `tpc_live` finishes on `blue`:
 *      - Replay window `GET /responses/tpc_live/` still serves `200` from `blue`;
 *      - Next user turn `POST /responses/` (`previous_response_id: "tpc_live"`) moves `tpc_live`
 *        to `green`, and subsequent `GET /responses/tpc_live/` also routes to `green`.
 *   5. Stopping `blue` while still listed as `drainingPort` in `state.json` produces ZERO 502s
 *      (graceful fallback to `green`).
 *   6. Instant rollback (`green -> blue`) while a stream is active on `green` loses 0 requests.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROUTER_SCRIPT = path.resolve(__dirname, 'engine-router.mjs');
const SERVICE_KEY = 'probe-arckep-engine-service-key-minimum-32-chars!!';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function writeStateAtomic(stateFile, payload) {
  const tmp = `${stateFile}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, stateFile);
}

/**
 * Create a realistic mock LobeChat engine slot server (`blue` or `green`).
 */
function createMockSlotServer(slotName) {
  let draining = false;
  /** @type {Map<string, { status: 'in_progress' | 'completed'; chunks: string[]; subscribers: Set<(line: string | null) => void> }>} */
  const operations = new Map();
  /** @type {Map<string, string>} messageId -> topicId */
  const messageToTopic = new Map();
  const cancelCalls = [];

  function startStreamedTopic(topicId, initialChunks = []) {
    const op = {
      chunks: [],
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
    for (const [topicId, op] of operations.entries()) {
      retainedTopicIds.push(topicId);
      if (op.status === 'in_progress') {
        activeTopicIds.push(topicId);
      }
    }
    return {
      activeCronRuns: 0,
      activeResponses: activeTopicIds.length,
      activeSandboxJobs: 0,
      activeTopicIds,
      activeTotal: activeTopicIds.length,
      draining,
      retainedTopicIds,
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
      if (req.headers.authorization !== `Bearer ${SERVICE_KEY}`) {
        sendJson(401, { error: 'Unauthorized' });
        return;
      }
      if (method === 'GET' && p === '/api/v1/arckep/engine-slot/status') {
        sendJson(200, getStatusSnapshot());
        return;
      }
      if (method === 'POST' && p === '/api/v1/arckep/engine-slot/drain') {
        draining = true;
        sendJson(200, getStatusSnapshot());
        return;
      }
      if (method === 'POST' && p === '/api/v1/arckep/engine-slot/owns-messages') {
        const body = await readBody();
        const snap = getStatusSnapshot();
        const activeSet = new Set(snap.activeTopicIds);
        const matched = new Set();
        for (const msgId of body.messageIds || []) {
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

    // GET /api/v1/responses/running
    if (method === 'GET' && p === '/api/v1/responses/running') {
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
      const body = await readBody();
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

      // Non-streaming response
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
    startStreamedTopic,
  };
}

function openStreamingRequest(routerPort, method, reqPath, payload = null) {
  return new Promise((resolve, reject) => {
    const headers = {
      'Authorization': `Bearer ${SERVICE_KEY}`,
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

function openStreamingPost(routerPort, payload) {
  return openStreamingRequest(routerPort, 'POST', '/chat/api/v1/responses/', payload);
}

async function httpJson(port, method, reqPath, bodyObj = null) {
  const headers = {
    'Authorization': `Bearer ${SERVICE_KEY}`,
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
    const req = http.request({ headers, host: '127.0.0.1', method, path: reqPath, port }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          json = null;
        }
        resolve({ headers: res.headers, json, statusCode: res.statusCode, text });
      });
    });
    req.on('error', reject);
    if (bodyBuf) req.end(bodyBuf);
    else req.end();
  });
}

async function runProbe() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-zd-probe-'));
  const stateFile = path.join(tmpDir, 'state.json');
  const readyFile = path.join(tmpDir, 'router-ready.json');

  let blue = createMockSlotServer('blue');
  const green = createMockSlotServer('green');
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

    routerProc = spawn(process.execPath, [ROUTER_SCRIPT], {
      env: {
        ...process.env,
        ARCKEP_ENGINE_SERVICE_KEY: SERVICE_KEY,
        ROUTER_HOST: '127.0.0.1',
        ROUTER_PORT: '0',
        ROUTER_READY_FILE: readyFile,
        ROUTER_STATE_FILE: stateFile,
        ROUTER_STATUS_TIMEOUT_MS: '800',
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
          const h = await httpJson(routerPort, 'GET', '/chat/api/v1/health/');
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

    // 3. Switch router from `blue` -> `green` (`blue` becomes `draining`) mid-stream!
    await httpJson(bluePort, 'POST', '/chat/api/v1/arckep/engine-slot/drain/');
    writeStateAtomic(stateFile, {
      activePort: greenPort,
      activeSlot: 'green',
      drainingPort: bluePort,
      drainingSlot: 'blue',
      switchEpoch: 2,
    });
    routerProc.kill('SIGHUP');

    // Verify router diagnostics endpoint reflects switch immediately
    const rHealth = await httpJson(routerPort, 'GET', '/__router/health');
    assert.equal(rHealth.statusCode, 200);
    assert.equal(rHealth.json.activeSlot, 'green');
    assert.equal(rHealth.json.drainingSlot, 'blue');

    // Emit more chunks on `blue` AFTER switch — open client must still receive them seamlessly
    blue.emitSseEvent('tpc_live', 'response.output_text.delta', {
      delta: 'Chunk-during-drain-2 ',
    });
    await sleep(40);
    assert.match(liveStream.getRawText(), /Chunk-during-drain-2/);

    // 4. Verify all in-flight affinity rules while `tpc_live` is running on `blue`:
    // 4a. GET /responses/tpc_live/ -> 200 from blue (not 404 from green)
    const liveStatus = await httpJson(routerPort, 'GET', '/chat/api/v1/responses/tpc_live/');
    assert.equal(liveStatus.statusCode, 200);
    assert.equal(liveStatus.headers['x-lobechat-slot'], 'blue');
    assert.equal(liveStatus.json.status, 'in_progress');

    // 4b. GET /responses/tpc_live/stream/ -> 200 SSE from blue (open while tpc_live is in_progress)
    const reconnectStream = await openStreamingRequest(
      routerPort,
      'GET',
      '/chat/api/v1/responses/tpc_live/stream/',
    );
    assert.equal(reconnectStream.statusCode, 200);
    assert.equal(reconnectStream.headers['x-lobechat-slot'], 'blue');
    await sleep(30);
    assert.match(reconnectStream.getRawText(), /Chunk-before-switch-1/);
    assert.match(reconnectStream.getRawText(), /Chunk-during-drain-2/);

    // 4c. POST /responses/ with previous_response_id: "tpc_live" -> 409 Conflict from blue
    const conflictTurn = await httpJson(routerPort, 'POST', '/chat/api/v1/responses/', {
      input: 'Concurrent duplicate message',
      model: 'agt_1',
      previous_response_id: 'tpc_live',
      stream: false,
    });
    assert.equal(conflictTurn.statusCode, 409);
    assert.equal(conflictTurn.headers['x-lobechat-slot'], 'blue');

    // 4d. DELETE /messages/ for msg_live_1 -> 409 Conflict from blue; unrelated msg -> 200 from green
    const conflictDel = await httpJson(routerPort, 'DELETE', '/chat/api/v1/messages/', {
      messageIds: ['msg_unrelated', 'msg_live_1'],
    });
    assert.equal(conflictDel.statusCode, 409);
    assert.equal(conflictDel.headers['x-lobechat-slot'], 'blue');

    const okDel = await httpJson(routerPort, 'DELETE', '/chat/api/v1/messages/', {
      messageIds: ['msg_unrelated'],
    });
    assert.equal(okDel.statusCode, 200);
    assert.equal(okDel.headers['x-lobechat-slot'], 'green');

    // 4e. POST /responses/tpc_cancel_probe/cancel/ -> routed to blue
    const cancelRes = await httpJson(
      routerPort,
      'POST',
      '/chat/api/v1/responses/tpc_cancel_probe/cancel/',
    );
    assert.equal(cancelRes.statusCode, 200);
    assert.equal(cancelRes.headers['x-lobechat-slot'], 'blue');
    assert.equal(cancelRes.json.cancelled, 1);
    await cancelProbeStream.finished;

    // 4f. Start a brand-new chat `tpc_new` (held open briefly on green) -> immediately served on green!
    const greenLiveStream = await openStreamingPost(routerPort, {
      input: 'Fresh chat on green',
      metadata: { holdOpen: true, requestedTopicId: 'tpc_new' },
      model: 'agt_1',
      stream: true,
    });
    assert.equal(greenLiveStream.statusCode, 200);
    assert.equal(greenLiveStream.headers['x-lobechat-slot'], 'green');

    // 4g. GET /responses/running/ merges active topics from BOTH green (`tpc_new`) and blue (`tpc_live`)!
    const runningMerged = await httpJson(routerPort, 'GET', '/chat/api/v1/responses/running/');
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

    // 6. Post-completion replay window: GET /responses/tpc_live/ still returns 200 from blue!
    const replayStatus = await httpJson(routerPort, 'GET', '/chat/api/v1/responses/tpc_live/');
    assert.equal(replayStatus.statusCode, 200);
    assert.equal(replayStatus.headers['x-lobechat-slot'], 'blue');
    assert.equal(replayStatus.json.status, 'completed');

    // 7. Next user turn in `tpc_live` (`previous_response_id: "tpc_live"`) moves to `green`,
    //    and all subsequent GET /responses/tpc_live/ calls also go to `green`!
    const nextTurnOnGreen = await httpJson(routerPort, 'POST', '/chat/api/v1/responses/', {
      input: 'Follow-up question after drain finished',
      model: 'agt_1',
      previous_response_id: 'tpc_live',
      stream: false,
    });
    assert.equal(nextTurnOnGreen.statusCode, 200);
    assert.equal(nextTurnOnGreen.headers['x-lobechat-slot'], 'green');

    const statusAfterMove = await httpJson(routerPort, 'GET', '/chat/api/v1/responses/tpc_live/');
    assert.equal(statusAfterMove.statusCode, 200);
    assert.equal(statusAfterMove.headers['x-lobechat-slot'], 'green');

    // 8. Stop `blue` while it is STILL listed as `drainingPort` in `state.json` -> ZERO 502s!
    await blue.close();
    const runningWhenBlueDead = await httpJson(
      routerPort,
      'GET',
      '/chat/api/v1/responses/running/',
    );
    assert.equal(runningWhenBlueDead.statusCode, 200);
    assert.deepEqual(runningWhenBlueDead.json.topics, ['tpc_new']);

    const postWhenBlueDead = await httpJson(routerPort, 'POST', '/chat/api/v1/responses/', {
      input: 'Turn when draining slot is already stopped',
      model: 'agt_1',
      previous_response_id: 'tpc_live',
      stream: false,
    });
    assert.equal(postWhenBlueDead.statusCode, 200);
    assert.equal(postWhenBlueDead.headers['x-lobechat-slot'], 'green');

    // 9. Bring `blue` back up and perform instant rollback (`green -> blue`) while `tpc_new` streams on `green`!
    blue = createMockSlotServer('blue');
    const revivedBluePort = await blue.listen(bluePort);
    assert.equal(revivedBluePort, bluePort);

    writeStateAtomic(stateFile, {
      activePort: bluePort,
      activeSlot: 'blue',
      drainingPort: greenPort,
      drainingSlot: 'green',
      switchEpoch: 3,
    });
    routerProc.kill('SIGHUP');

    const postAfterRollback = await httpJson(routerPort, 'POST', '/chat/api/v1/responses/', {
      input: 'New request after rollback to blue',
      model: 'agt_1',
      stream: false,
    });
    assert.equal(postAfterRollback.statusCode, 200);
    assert.equal(postAfterRollback.headers['x-lobechat-slot'], 'blue');

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

    // 10. Verify SIGTERM closes idle HTTP keep-alive connections and exits cleanly with code 0 (< 1.5s)
    const shutdownStart = Date.now();
    const exitPromise = new Promise((resolve) => {
      routerProc.once('exit', (code, signal) => resolve({ code, signal }));
    });
    routerProc.kill('SIGTERM');
    const exitResult = await Promise.race([
      exitPromise,
      sleep(2_000).then(() => ({ code: 'TIMEOUT', signal: null })),
    ]);
    const shutdownMs = Date.now() - shutdownStart;
    assert.equal(
      exitResult.code,
      0,
      `Expected routerProc SIGTERM exit code 0, got code=${exitResult.code} signal=${exitResult.signal}`,
    );
    assert.ok(shutdownMs < 1_500, `Expected fast SIGTERM shutdown (<1500ms), got ${shutdownMs}ms`);

    console.log(
      `[probe] PASS: all zero-downtime Blue-Green invariants verified (${healthChecks} continuous 30ms health checks, 0 errors, SIGTERM=${shutdownMs}ms).`,
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
