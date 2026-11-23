import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { ensureUpstreamAgentIdleRetirement, handleRequest } from './engine-router-core.mjs';

const CORE_MODULE_URL = pathToFileURL(
  new URL('./engine-router-core.mjs', import.meta.url).pathname,
).href;

function listenServer(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve(addr.port);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

function sendHttpRequest({
  agent = false,
  body = null,
  headers = {},
  method = 'GET',
  path = '/',
  port,
}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        agent,
        headers,
        host: '127.0.0.1',
        method,
        path,
        port,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            body: Buffer.concat(chunks).toString('utf8'),
            headers: res.headers,
            reusedSocket: Boolean(req.reusedSocket),
            statusCode: res.statusCode,
          });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (body !== null) {
      req.end(body);
    } else {
      req.end();
    }
  });
}

function createTestRuntime(activePort, drainingPort = null) {
  return {
    defaultServiceKey: '',
    inFlightRequests: 0,
    inFlightTopicPosts: new Map(),
    isShuttingDown: false,
    lastIno: -1,
    lastMtimeMs: -1,
    lastSize: -1,
    lastStatCheckAt: Date.now() + 60_000,
    reloadCount: 0,
    routerHash: 'test-hash',
    shellHash: 'test-shell-hash',
    slotServiceKeys: new Map(),
    socketActivated: false,
    state: {
      activePort,
      activeSlot: 'blue',
      drainingPort,
      drainingSlot: drainingPort ? 'green' : null,
      switchEpoch: 1,
    },
    topicsStartedOnActive: new Set(),
    totalBufferedBytes: 0,
    upstreamAgent: new http.Agent({
      keepAlive: true,
      keepAliveMsecs: 30_000,
      maxFreeSockets: 64,
      maxSockets: 1024,
    }),
  };
}

function countFreeSockets(agent) {
  let count = 0;
  for (const list of Object.values(agent.freeSockets || {})) {
    if (Array.isArray(list)) count += list.length;
  }
  return count;
}

test('retires idle pooled socket at idleMs while active SSE stream longer than idleMs completes without timeout', async () => {
  const upstreamServer = http.createServer((req, res) => {
    if (req.url === '/sse') {
      res.writeHead(200, {
        'Cache-Control': 'no-cache',
        'Content-Type': 'text/event-stream',
        'Keep-Alive': 'timeout=65',
      });
      res.write('data: chunk-1\n\n');
      setTimeout(() => {
        res.write('data: chunk-2\n\n');
        setTimeout(() => {
          res.write('data: done\n\n');
          res.end();
        }, 250);
      }, 250);
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Keep-Alive': 'timeout=65',
    });
    res.end(JSON.stringify({ ok: true }));
  });
  upstreamServer.keepAliveTimeout = 65_000;
  upstreamServer.headersTimeout = 70_000;

  const upstreamPort = await listenServer(upstreamServer);
  const agent = new http.Agent({
    keepAlive: true,
    keepAliveMsecs: 30_000,
    maxFreeSockets: 64,
    maxSockets: 1024,
  });

  // Shortened idle timeout (220ms) so the test proves both:
  // 1) idle pooled socket closes at ~220ms (well before server's 65s keepAliveTimeout)
  // 2) an active 500ms SSE stream on a reused socket NEVER fires timeout!
  ensureUpstreamAgentIdleRetirement(agent, {
    bufferMs: 5_000,
    defaultIdleMs: 200,
    maxIdleMs: 220,
    minIdleMs: 50,
  });

  try {
    // Warm one pooled socket
    const warmRes = await sendHttpRequest({ agent, path: '/warm', port: upstreamPort });
    assert.equal(warmRes.statusCode, 200);
    assert.equal(countFreeSockets(agent), 1);

    // Inspect the free socket's armed idle timeout before reuse
    const [pooledSocket] = Object.values(agent.freeSockets)[0];
    assert.equal(pooledSocket.timeout, 220);

    // Immediately reuse that socket for a 500ms active SSE stream (> 220ms idle timeout!)
    let reqTimedOut = false;
    let sockTimedOutDuringSse = false;
    const sseBody = await new Promise((resolve, reject) => {
      const sseReq = http.request(
        {
          agent,
          host: '127.0.0.1',
          method: 'GET',
          path: '/sse',
          port: upstreamPort,
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
          res.on('error', reject);
        },
      );
      sseReq.on('socket', (sock) => {
        assert.equal(sseReq.reusedSocket, true, 'SSE request should reuse pooled socket');
        assert.equal(sock.timeout, 0, 'Active reused socket must have timeout=0 during SSE');
        sock.on('timeout', () => {
          sockTimedOutDuringSse = true;
        });
      });
      sseReq.on('timeout', () => {
        reqTimedOut = true;
      });
      sseReq.on('error', reject);
      sseReq.end();
    });

    assert.equal(reqTimedOut, false, 'SSE request must never emit timeout');
    assert.equal(sockTimedOutDuringSse, false, 'SSE socket must never emit timeout while active');
    assert.ok(sseBody.includes('data: chunk-1'));
    assert.ok(sseBody.includes('data: chunk-2'));
    assert.ok(sseBody.includes('data: done'));

    // After SSE finishes, the socket returns to freeSockets with idle timeout re-armed (220ms)
    assert.equal(countFreeSockets(agent), 1);
    const [idleSocket] = Object.values(agent.freeSockets)[0];
    assert.equal(idleSocket.timeout, 220);

    const idleStart = Date.now();
    await new Promise((resolve, reject) => {
      const failTimer = setTimeout(() => {
        reject(new Error('Idle pooled socket did not close after idle timeout'));
      }, 2000);
      idleSocket.once('close', () => {
        clearTimeout(failTimer);
        resolve();
      });
    });
    const elapsedMs = Date.now() - idleStart;
    assert.ok(
      elapsedMs >= 150 && elapsedMs < 1500,
      `Expected idle socket to retire near 220ms, closed in ${elapsedMs}ms`,
    );
    assert.equal(countFreeSockets(agent), 0);
  } finally {
    agent.destroy();
    await closeServer(upstreamServer);
  }
});

test('GET retries once with fresh socket (agent: false) when pooled sockets hit ECONNRESET, while POST returns 502 without retry', async () => {
  const poisonedServerSockets = new Set();
  let poisonEnabled = false;
  let getAttempts = 0;
  let postAttempts = 0;

  const upstreamServer = http.createServer((req, res) => {
    if (req.url === '/warm') {
      poisonedServerSockets.add(req.socket);
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Keep-Alive': 'timeout=65' });
        res.end(JSON.stringify({ warmed: true }));
      }, 40);
      return;
    }

    if (req.url === '/read-test') {
      getAttempts += 1;
      if (poisonEnabled && poisonedServerSockets.has(req.socket)) {
        req.socket.resetAndDestroy();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({ attempts: getAttempts, fresh: !poisonedServerSockets.has(req.socket) }),
      );
      return;
    }

    if (req.url === '/mutate-test') {
      postAttempts += 1;
      if (poisonEnabled && poisonedServerSockets.has(req.socket)) {
        req.socket.resetAndDestroy();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404);
    res.end();
  });
  upstreamServer.keepAliveTimeout = 65_000;

  const upstreamPort = await listenServer(upstreamServer);
  const runtime = createTestRuntime(upstreamPort);

  const routerServer = http.createServer((req, res) => {
    void handleRequest(req, res, runtime);
  });
  const routerPort = await listenServer(routerServer);

  try {
    // Populate TWO distinct pooled sockets in runtime.upstreamAgent.freeSockets
    // so that a retry reusing runtime.upstreamAgent would pick a 2nd stale socket and fail!
    const [w1, w2] = await Promise.all([
      sendHttpRequest({ method: 'GET', path: '/warm', port: routerPort }),
      sendHttpRequest({ method: 'GET', path: '/warm', port: routerPort }),
    ]);
    assert.equal(w1.statusCode, 200);
    assert.equal(w2.statusCode, 200);
    assert.equal(countFreeSockets(runtime.upstreamAgent), 2);
    assert.equal(poisonedServerSockets.size, 2);

    // Now simulate stale pooled sockets (server resets any reused pooled socket)
    poisonEnabled = true;

    // 1) GET hits ECONNRESET on stale socket #1 -> retries ONCE with agent: false (fresh socket!) -> 200 OK
    const getRes = await sendHttpRequest({ method: 'GET', path: '/read-test', port: routerPort });
    assert.equal(getRes.statusCode, 200);
    assert.deepEqual(JSON.parse(getRes.body), { attempts: 2, fresh: true });
    assert.equal(getAttempts, 2);
    // Socket #2 is still sitting in freeSockets (retry bypassed pool via agent: false)
    assert.equal(countFreeSockets(runtime.upstreamAgent), 1);

    // 2) POST hits ECONNRESET on stale socket #2 -> MUST NOT retry -> returns 502 immediately
    const postRes = await sendHttpRequest({
      body: JSON.stringify({ hello: 'world' }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
      path: '/mutate-test',
      port: routerPort,
    });
    assert.equal(postRes.statusCode, 502);
    assert.equal(postAttempts, 1, 'Non-idempotent POST must NEVER be retried on ECONNRESET');
  } finally {
    runtime.upstreamAgent.destroy();
    await closeServer(routerServer);
    await closeServer(upstreamServer);
  }
});

test('requestSlotJson retries GET once with agent: false on stale ECONNRESET (merged /responses/running)', async () => {
  const poisonedSockets = new Set();
  let poisonEnabled = false;
  let activeRunningCalls = 0;

  const activeServer = http.createServer((req, res) => {
    if (req.url === '/warm') {
      poisonedSockets.add(req.socket);
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Keep-Alive': 'timeout=65' });
        res.end(JSON.stringify({ warmed: true }));
      }, 30);
      return;
    }
    if (req.url === '/chat/api/v1/responses/running') {
      activeRunningCalls += 1;
      if (poisonEnabled && poisonedSockets.has(req.socket)) {
        req.socket.resetAndDestroy();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ topics: ['tpc_active'] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const drainingServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ topics: ['tpc_draining'] }));
  });

  const activePort = await listenServer(activeServer);
  const drainingPort = await listenServer(drainingServer);
  const runtime = createTestRuntime(activePort, drainingPort);

  const routerServer = http.createServer((req, res) => {
    void handleRequest(req, res, runtime);
  });
  const routerPort = await listenServer(routerServer);

  try {
    // Put 2 stale pooled sockets to activePort into runtime.upstreamAgent.freeSockets
    await Promise.all([
      sendHttpRequest({ method: 'GET', path: '/warm', port: routerPort }),
      sendHttpRequest({ method: 'GET', path: '/warm', port: routerPort }),
    ]);
    assert.equal(poisonedSockets.size, 2);

    poisonEnabled = true;
    const runningRes = await sendHttpRequest({
      method: 'GET',
      path: '/chat/api/v1/responses/running',
      port: routerPort,
    });
    assert.equal(runningRes.statusCode, 200);
    assert.deepEqual(JSON.parse(runningRes.body), { topics: ['tpc_active', 'tpc_draining'] });
    assert.equal(activeRunningCalls, 2);
  } finally {
    runtime.upstreamAgent.destroy();
    await closeServer(routerServer);
    await closeServer(activeServer);
    await closeServer(drainingServer);
  }
});

test('repeated wrapper install and simulated SIGHUP dynamic reload are idempotent without double-wrapping', async () => {
  let baseKeepCalls = 0;
  let baseReuseCalls = 0;

  const agent = new http.Agent({
    keepAlive: true,
    keepAliveMsecs: 30_000,
    maxFreeSockets: 64,
    maxSockets: 1024,
  });

  const origKeep = agent.keepSocketAlive;
  const origReuse = agent.reuseSocket;
  agent.keepSocketAlive = function trackedBaseKeep(sock) {
    baseKeepCalls += 1;
    return origKeep.call(this, sock);
  };
  agent.reuseSocket = function trackedBaseReuse(sock, req) {
    baseReuseCalls += 1;
    return origReuse.call(this, sock, req);
  };

  // Same-module repeated install is a no-op
  ensureUpstreamAgentIdleRetirement(agent);
  const keepFn1 = agent.keepSocketAlive;
  const reuseFn1 = agent.reuseSocket;
  ensureUpstreamAgentIdleRetirement(agent);
  assert.equal(agent.keepSocketAlive, keepFn1);
  assert.equal(agent.reuseSocket, reuseFn1);

  // Simulate SIGHUP hot-reload importing a fresh ESM instance of engine-router-core.mjs
  const reloadedMod1 = await import(`${CORE_MODULE_URL}?v=sighup-test-1`);
  const reloadedMod2 = await import(`${CORE_MODULE_URL}?v=sighup-test-2`);

  reloadedMod1.ensureUpstreamAgentIdleRetirement(agent);
  const keepFnAfterReload1 = agent.keepSocketAlive;
  reloadedMod2.ensureUpstreamAgentIdleRetirement(agent);
  assert.notEqual(
    agent.keepSocketAlive,
    keepFnAfterReload1,
    'SIGHUP reload upgrades wrapper cleanly',
  );

  const patchMeta = agent[Symbol.for('arckep.engineRouter.upstreamAgentIdlePatch')];
  assert.equal(patchMeta.baseKeepSocketAlive.name, 'trackedBaseKeep');
  assert.equal(patchMeta.baseReuseSocket.name, 'trackedBaseReuse');

  // Verify base methods are called EXACTLY ONCE per keep/reuse (no chained double-wrapping!)
  const server = http.createServer((req, res) => {
    if (req.url === '/legacy-5s') {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Keep-Alive': 'timeout=5' });
      res.end('ok');
      return;
    }
    if (req.url === '/no-hint') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Keep-Alive': 'timeout=65' });
    res.end('ok');
  });
  const port = await listenServer(server);
  try {
    const r1 = await sendHttpRequest({ agent, path: '/1', port });
    assert.equal(r1.statusCode, 200);
    assert.equal(baseKeepCalls, 1);
    assert.equal(baseReuseCalls, 0);

    // Even if SIGHUP reloads WHILE socket is sitting idle in freeSockets, reuse cleans v2 timer cleanly!
    const reloadedMod3 = await import(`${CORE_MODULE_URL}?v=sighup-test-3`);
    reloadedMod3.ensureUpstreamAgentIdleRetirement(agent);

    const r2 = await sendHttpRequest({ agent, path: '/2', port });
    assert.equal(r2.statusCode, 200);
    assert.equal(r2.reusedSocket, true);
    assert.equal(
      baseReuseCalls,
      1,
      'reuseSocket base must be invoked exactly once (no double wrap)',
    );
    assert.equal(baseKeepCalls, 2, 'keepSocketAlive base must be invoked exactly once per release');

    // Verify computed idle timeout for Keep-Alive: timeout=65 is 60_000ms (65_000 - 5_000)
    const [sock65] = Object.values(agent.freeSockets)[0];
    assert.equal(sock65.timeout, 60_000);

    // Verify Keep-Alive: timeout=5 clamps safely to 1_000ms (still keeps socket alive!)
    const r3 = await sendHttpRequest({ agent, path: '/legacy-5s', port });
    assert.equal(r3.statusCode, 200);
    const [sock5] = Object.values(agent.freeSockets)[0];
    assert.equal(sock5.timeout, 1_000);

    // Verify absent Keep-Alive header falls back to 55_000ms default
    // (must set keepAliveTimeout=0 before request so ServerResponse omits Keep-Alive header)
    server.keepAliveTimeout = 0;
    const r4 = await sendHttpRequest({ agent, path: '/no-hint', port });
    assert.equal(r4.statusCode, 200);
    assert.equal(r4.headers['keep-alive'], undefined);
    const [sockDefault] = Object.values(agent.freeSockets)[0];
    assert.equal(sockDefault.timeout, 55_000);
  } finally {
    agent.destroy();
    await closeServer(server);
  }
});
