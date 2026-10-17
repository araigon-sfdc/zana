import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nextOriginFromEnv, proxyToNext, shouldSpawnNext, spawnNextServer, waitForHttp } from './next-proxy.mjs';
import { createHostedConnect } from '../connect/runtime.mjs';

/**
 * Paths the retired shared-token machine relay used to forward to a laptop.
 * They answer 410 here instead of reaching Next, whose `trailingSlash` would
 * 308 `/install.sh`. Machines now pair through Zana Connect or an SSH tunnel.
 */
const RETIRED_RELAY_PATH = /^\/(?:_zcc\/relay|t\/[^/]+(?:\/.*)?|install\.sh|install\/.*|internal\/(?:hosts|plugins)\/.*)$/u;

export function isRetiredRelayPath(pathname) {
  const path = (pathname ?? '/').replace(/\/+$/u, '') || '/';
  return RETIRED_RELAY_PATH.test(path);
}

function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

function writeHttpError(socket, status, reason) {
  const body = `${reason}\n`;
  socket.write(
    `HTTP/1.1 ${status} ${reason}\r\n` +
      'Connection: close\r\n' +
      'Content-Type: text/plain; charset=utf-8\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      '\r\n' +
      body
  );
  socket.destroy();
}

/**
 * @param {{
 *   port?: number,
 *   host?: string,
 *   env?: NodeJS.ProcessEnv,
 *   cwd?: string,
 *   spawnNext?: boolean,
 *   nextOrigin?: string,
 *   connect?: Awaited<ReturnType<typeof createHostedConnect>>
 * }} [options]
 */
export async function startFrontDoor(options = {}) {
  const env = options.env ?? process.env;
  const spawn = options.spawnNext ?? shouldSpawnNext(env);
  let nextOrigin = (options.nextOrigin ?? nextOriginFromEnv(env)).replace(/\/$/u, '');
  let spawned = null;
  // Bind $PORT before Next is ready — Heroku kills dynos that do not listen in time.
  let nextReady = !spawn;
  const connect = options.connect !== undefined ? options.connect : await createHostedConnect(env);

  const server = createServer((request, response) => {
    if (connect?.matches(request)) { void connect.handleHttp(request, response); return; }
    if (isRetiredRelayPath(new URL(request.url ?? '/', 'http://127.0.0.1').pathname)) {
      sendJson(response, 410, { error: 'relay_removed' });
      return;
    }
    if (!nextReady) {
      sendJson(response, 503, { error: 'site_starting' });
      return;
    }
    proxyToNext(request, response, nextOrigin);
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  // Edge proxies retain idle HTTP/1.1 sockets after multiplexed browser asset
  // loads. A 160-socket cap dropped subsequent API calls without a response.
  // Keep this separate from the much smaller per-desktop stream/queue limits.
  server.maxConnections = 1024;

  server.on('upgrade', (request, socket, head) => {
    if (connect?.matches(request)) { void connect.handleUpgrade(request, socket, head); return; }
    writeHttpError(socket, 404, 'Not Found');
  });

  const port = options.port ?? Number(env.PORT ?? 4321);
  const host = options.host ?? '0.0.0.0';
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(undefined);
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('front door did not bind a TCP address');
  }

  if (spawn) {
    spawned = spawnNextServer({ env, cwd: options.cwd, force: true });
    nextOrigin = spawned.origin;
    void waitForHttp(nextOrigin)
      .then(() => {
        nextReady = true;
      })
      .catch((error) => {
        process.stderr.write(`zcc next: ${error instanceof Error ? error.message : String(error)}\n`);
      });
  }

  return {
    port: address.port,
    url: `http://127.0.0.1:${address.port}/`,
    nextOrigin,
    close: async () => {
      await connect?.close();
      server.closeAllConnections();
      await new Promise((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
      });
      spawned?.child.kill('SIGTERM');
    }
  };
}

const isMain = Boolean(
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
);
if (isMain) {
  const door = await startFrontDoor();
  process.stdout.write(`zcc front door listening on ${door.url}\n`);
  const shutdown = () => {
    void door.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
