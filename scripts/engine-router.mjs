#!/usr/bin/env node
/**
 * Thin immutable HTTP/SSE socket shell for headless LobeChat Blue-Green router (`engine-router.mjs`).
 *
 * Holds the listening socket (`127.0.0.1:3403` or systemd socket-activated `LISTEN_FDS=1` fd=3)
 * and shared `routerRuntime` state (`inFlightTopicPosts`, `topicsStartedOnActive`,
 * `inFlightRequests`, `totalBufferedBytes`, `upstreamAgent`) across `SIGHUP` hot-reloads of
 * `./engine-router-core.mjs` (`<2ms`, zero `systemctl restart`, zero SSE or HTTP interruptions).
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROUTER_SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROUTER_CORE_PATH =
  process.env.ROUTER_CORE_MODULE ||
  path.join(path.dirname(ROUTER_SCRIPT_PATH), 'engine-router-core.mjs');

const SHELL_SCRIPT_HASH = (() => {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(ROUTER_SCRIPT_PATH)).digest('hex');
  } catch {
    return 'unknown';
  }
})();

const ROUTER_HOST = process.env.ROUTER_HOST || '127.0.0.1';
const ROUTER_PORT = Number.parseInt(process.env.ROUTER_PORT ?? '3403', 10);
const ROUTER_STATE_FILE = process.env.ROUTER_STATE_FILE || '/var/lib/lobechat-engine/state.json';
const ROUTER_READY_FILE = process.env.ROUTER_READY_FILE || '';
const SHUTDOWN_TIMEOUT_MS = Number.parseInt(
  process.env.ROUTER_SHUTDOWN_TIMEOUT_MS ?? '1770000',
  10,
);
const SD_LISTEN_FDS_START = 3;

const USE_SOCKET_ACTIVATION =
  process.env.LISTEN_FDS === '1' && Number(process.env.LISTEN_PID) === process.pid;

const routerRuntime = {
  defaultServiceKey: (process.env.ARCKEP_ENGINE_SERVICE_KEY || '').trim(),
  inFlightRequests: 0,
  inFlightTopicPosts: new Map(),
  isShuttingDown: false,
  lastIno: -1,
  lastMtimeMs: -1,
  lastSize: -1,
  lastStatCheckAt: 0,
  reloadCount: 0,
  routerHash: 'unknown',
  shellHash: SHELL_SCRIPT_HASH,
  slotServiceKeys: new Map(),
  socketActivated: USE_SOCKET_ACTIVATION,
  state: {
    activePort: 3404,
    activeSlot: 'blue',
    drainingPort: null,
    drainingSlot: null,
    switchEpoch: 0,
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

let currentHandler = null;
let reloadSeq = 0;
let reloadInProgress = false;
let reloadQueued = false;

function isValidCoreModule(mod) {
  return Boolean(
    mod &&
    typeof mod.handleRequest === 'function' &&
    typeof mod.reloadServiceKey === 'function' &&
    typeof mod.reloadState === 'function',
  );
}

async function importCoreModuleIfChanged(forceImport = false) {
  const stat = fs.statSync(ROUTER_CORE_PATH);
  const coreBytes = fs.readFileSync(ROUTER_CORE_PATH);
  const nextCoreHash = crypto.createHash('sha256').update(coreBytes).digest('hex');

  if (!forceImport && currentHandler && nextCoreHash === routerRuntime.routerHash) {
    return false;
  }

  reloadSeq += 1;
  const moduleHref = `${pathToFileURL(ROUTER_CORE_PATH).href}?v=${stat.mtimeMs}-${reloadSeq}`;
  const candidate = await import(moduleHref);
  if (!isValidCoreModule(candidate)) {
    throw new Error(
      `Invalid router core module ${ROUTER_CORE_PATH}: missing required exports (handleRequest, reloadServiceKey, reloadState)`,
    );
  }

  const prevHash = routerRuntime.routerHash;
  currentHandler = candidate;
  routerRuntime.routerHash = nextCoreHash;
  routerRuntime.reloadCount += 1;
  if (prevHash !== 'unknown' && prevHash !== nextCoreHash) {
    console.log(
      `[engine-router] hot-reloaded core handler (${prevHash.slice(0, 12)} -> ${nextCoreHash.slice(0, 12)}, reloadCount=${routerRuntime.reloadCount}, inFlight=${routerRuntime.inFlightRequests})`,
    );
  }
  return true;
}

async function reloadOnSighup() {
  if (reloadInProgress) {
    reloadQueued = true;
    return;
  }
  reloadInProgress = true;
  try {
    do {
      reloadQueued = false;
      try {
        await importCoreModuleIfChanged(false);
      } catch (err) {
        console.error(
          '[engine-router] ERROR: failed to hot-reload engine-router-core.mjs; keeping previous handler active:',
          err,
        );
      }
      try {
        currentHandler?.reloadServiceKey(routerRuntime);
        currentHandler?.reloadState(routerRuntime, true);
      } catch (err) {
        console.error(
          '[engine-router] ERROR: failed to reload service key / state on SIGHUP:',
          err,
        );
      }
    } while (reloadQueued);
  } finally {
    reloadInProgress = false;
  }
}

await importCoreModuleIfChanged(true);
currentHandler.reloadServiceKey(routerRuntime);
currentHandler.reloadState(routerRuntime, true);

process.on('SIGHUP', () => {
  void reloadOnSighup();
});

const server = http.createServer((req, res) => {
  routerRuntime.inFlightRequests += 1;
  let accounted = false;
  const onRequestSettled = () => {
    if (accounted) return;
    accounted = true;
    routerRuntime.inFlightRequests = Math.max(0, routerRuntime.inFlightRequests - 1);
    if (routerRuntime.isShuttingDown) {
      setImmediate(() => {
        server.closeIdleConnections?.();
      });
    }
  };
  res.once('finish', onRequestSettled);
  res.once('close', onRequestSettled);
  if (routerRuntime.isShuttingDown && !res.headersSent) {
    res.setHeader('Connection', 'close');
  }

  Promise.resolve()
    .then(() => currentHandler.handleRequest(req, res, routerRuntime))
    .catch((err) => {
      console.error('[engine-router] unhandled request error:', err);
      if (!res.headersSent && !res.writableEnded) {
        const body = Buffer.from(JSON.stringify({ error: 'Internal router error' }), 'utf8');
        res.writeHead(500, {
          'Content-Length': String(body.length),
          'Content-Type': 'application/json; charset=UTF-8',
          'X-LobeChat-Slot': routerRuntime.state.activeSlot,
        });
        res.end(body);
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

const onServerListening = () => {
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
          routerHash: routerRuntime.routerHash,
          shellHash: routerRuntime.shellHash,
          socketActivated: USE_SOCKET_ACTIVATION,
        }),
        'utf8',
      );
    } catch (err) {
      console.error('[engine-router] failed writing ROUTER_READY_FILE:', err);
    }
  }
  console.log(
    `[engine-router] listening on http://${ROUTER_HOST}:${boundPort} (socketActivated=${USE_SOCKET_ACTIVATION}, active=${routerRuntime.state.activeSlot}:${routerRuntime.state.activePort}, state=${ROUTER_STATE_FILE}, hash=${routerRuntime.routerHash.slice(0, 12)})`,
  );
};

if (USE_SOCKET_ACTIVATION) {
  server.listen({ fd: SD_LISTEN_FDS_START }, onServerListening);
} else {
  server.listen(ROUTER_PORT, ROUTER_HOST, onServerListening);
}

const shutdown = () => {
  if (routerRuntime.isShuttingDown) return;
  routerRuntime.isShuttingDown = true;

  server.close(() => {
    routerRuntime.upstreamAgent.destroy();
    process.exit(0);
  });
  server.closeIdleConnections?.();
  if (routerRuntime.inFlightRequests === 0) {
    setImmediate(() => {
      server.closeIdleConnections?.();
    });
  }

  setTimeout(() => {
    server.closeAllConnections?.();
    routerRuntime.upstreamAgent.destroy();
    process.exit(0);
  }, SHUTDOWN_TIMEOUT_MS).unref();
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
