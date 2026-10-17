import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect as netConnect, type Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isRetiredRelayPath, startFrontDoor } from './front-door.mjs';

let door: Awaited<ReturnType<typeof startFrontDoor>> | null = null;
let next: Server | null = null;

afterEach(async () => {
  await door?.close();
  door = null;
  await new Promise<void>((resolve) => {
    if (!next) {
      resolve();
      return;
    }
    next.close(() => resolve());
  });
  next = null;
});

async function listenNext(): Promise<string> {
  next = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<html>docs ${request.url}</html>`);
  });
  await new Promise<void>((resolve) => next!.listen(0, '127.0.0.1', () => resolve()));
  const address = next.address();
  if (!address || typeof address === 'string') throw new Error('next stub did not bind');
  return `http://127.0.0.1:${address.port}`;
}

/** Send one raw request and resolve with the status line. */
function rawStatus(port: number, request: string): Promise<string> {
  return new Promise((resolve) => {
    let received = '';
    const socket = netConnect(port, '127.0.0.1', () => socket.write(request));
    socket.setTimeout(3_000, () => socket.destroy());
    socket.on('data', (chunk) => {
      received += chunk.toString();
      if (received.includes('\r\n')) {
        resolve(received.split('\r\n')[0]);
        socket.destroy();
      }
    });
    socket.on('error', () => resolve(received));
    socket.on('close', () => resolve(received));
  });
}

function upgradeRequest(path: string, host = 'localhost'): string {
  return `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n` +
    'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n';
}

describe('isRetiredRelayPath', () => {
  it.each([
    '/_zcc/relay', '/_zcc/relay/', '/t/zcrs_abcdefghijklmnop', '/t/zcrs_abcdefghijklmnop/install.sh',
    '/install.sh', '/install.sh/', '/install/version', '/install/zcc-host.tgz',
    '/internal/hosts/enroll', '/internal/hosts/ws', `/internal/plugins/x/host/${'a'.repeat(64)}`
  ])('retires %s', (path) => {
    expect(isRetiredRelayPath(path)).toBe(true);
  });

  it.each(['/', '/t', '/tools', '/docs/install', '/extensions/install', '/download', '/connect/', '/internal', '/api/connect/phone/start'])(
    'leaves %s to the website',
    (path) => {
      expect(isRetiredRelayPath(path)).toBe(false);
    }
  );

  it('treats a missing path as the root', () => {
    expect(isRetiredRelayPath(undefined)).toBe(false);
  });
});

describe('front door', () => {
  it('keeps a cold browser load alive across more than 160 proxy connections', async () => {
    const nextOrigin = await listenNext();
    door = await startFrontDoor({ host: '127.0.0.1', port: 0, spawnNext: false, nextOrigin, connect: null, env: {} as NodeJS.ProcessEnv });
    const sockets: Socket[] = [];
    try {
      // Hold completed HTTP connections open as an edge proxy does. The app's
      // module graph plus API calls exceeds the old 160-socket front-door cap.
      const replies = await Promise.all(Array.from({ length: 240 }, () => new Promise<string>((resolve) => {
        let received = '';
        const socket = netConnect(door!.port, '127.0.0.1', () => {
          socket.write('GET /install.sh HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n');
        });
        sockets.push(socket);
        socket.setTimeout(3_000, () => socket.destroy());
        socket.on('data', (chunk) => {
          received += chunk.toString();
          if (received.includes('\r\n\r\n')) resolve(received.split('\r\n')[0]);
        });
        socket.on('error', () => resolve(received));
        socket.on('close', () => resolve(received));
      })));
      expect(replies.filter((status) => status === 'HTTP/1.1 410 Gone')).toHaveLength(240);
    } finally {
      for (const socket of sockets) socket.destroy();
    }
  });

  it('serves Next for website paths and 410s retired relay paths without a redirect', async () => {
    const nextOrigin = await listenNext();
    door = await startFrontDoor({ host: '127.0.0.1', port: 0, spawnNext: false, nextOrigin, connect: null, env: {} as NodeJS.ProcessEnv });
    const site = await fetch(new URL('docs/multiple-devices', door.url), { redirect: 'manual' });
    expect(site.status).toBe(200);
    await expect(site.text()).resolves.toContain('docs /docs/multiple-devices');

    for (const [method, path] of [
      ['HEAD', 'install.sh'], ['GET', 'install.sh'], ['GET', 'install/zcc-host.tgz'], ['GET', '_zcc/relay'],
      ['GET', 't/zcrs_abcdefghijklmnop/install.sh'], ['POST', 'internal/hosts/enroll']
    ]) {
      const response = await fetch(new URL(path, door.url), { method, redirect: 'manual' });
      expect(response.status, `${method} /${path}`).toBe(410);
      expect(response.headers.get('location')).toBeNull();
      expect(response.headers.get('cache-control')).toBe('no-store');
      if (method !== 'HEAD') await expect(response.json()).resolves.toEqual({ error: 'relay_removed' });
    }
  });

  it('refuses every non-Connect WebSocket upgrade, including the old laptop and host sockets', async () => {
    door = await startFrontDoor({ host: '127.0.0.1', port: 0, spawnNext: false, nextOrigin: 'http://127.0.0.1:9', connect: null, env: {} as NodeJS.ProcessEnv });
    for (const path of ['/_zcc/relay', '/internal/hosts/ws', '/t/zcrs_abcdefghijklmnop/internal/hosts/ws', '/']) {
      await expect(rawStatus(door.port, upgradeRequest(path))).resolves.toBe('HTTP/1.1 404 Not Found');
    }
  });

  it('routes Connect hosts first, so a laptop address still serves its own installer', async () => {
    const nextOrigin = await listenNext();
    const connect = {
      matches: vi.fn((request: IncomingMessage) => request.headers.host?.startsWith('my-computer.') ?? false),
      handleHttp: vi.fn(async (request: IncomingMessage, response: ServerResponse) => {
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end(`connect ${request.url}`);
      }),
      handleUpgrade: vi.fn((_request: IncomingMessage, socket: Socket) => {
        socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
      }),
      close: vi.fn(async () => undefined)
    };
    door = await startFrontDoor({ host: '127.0.0.1', port: 0, spawnNext: false, nextOrigin, connect: connect as never, env: {} as NodeJS.ProcessEnv });

    const viaConnect = await rawStatus(door.port, 'GET /install.sh HTTP/1.1\r\nHost: my-computer.zana.localhost\r\nConnection: close\r\n\r\n');
    expect(viaConnect).toBe('HTTP/1.1 200 OK');
    expect(connect.handleHttp).toHaveBeenCalledTimes(1);
    await expect(rawStatus(door.port, upgradeRequest('/internal/hosts/ws', 'my-computer.zana.localhost')))
      .resolves.toBe('HTTP/1.1 101 Switching Protocols');
    expect(connect.handleUpgrade).toHaveBeenCalledTimes(1);

    const site = await fetch(new URL('install.sh', door.url), { redirect: 'manual' });
    expect(site.status).toBe(410);
    expect(connect.handleHttp).toHaveBeenCalledTimes(1);

    await door.close();
    door = null;
    expect(connect.close).toHaveBeenCalledTimes(1);
  });

  it('looks up Connect from the environment when none is injected', async () => {
    door = await startFrontDoor({ host: '127.0.0.1', port: 0, spawnNext: false, nextOrigin: 'http://127.0.0.1:9', env: {} as NodeJS.ProcessEnv });
    const response = await fetch(new URL('_zcc/relay', door.url));
    expect(response.status).toBe(410);
  });

  it('answers 503 while the spawned Next server starts, then proxies to it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zcc-front-door-'));
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
    const nextPort = (probe.address() as { port: number }).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    writeFileSync(join(dir, 'server.js'), [
      "const { createServer } = require('node:http');",
      "setTimeout(() => createServer((q, r) => r.end('spawned ' + q.url)).listen(Number(process.env.PORT), process.env.HOSTNAME), 400);"
    ].join('\n'));
    try {
      door = await startFrontDoor({ host: '127.0.0.1', port: 0, spawnNext: true, cwd: dir, connect: null, env: { ZCC_NEXT_PORT: String(nextPort) } as NodeJS.ProcessEnv });
      expect(door.nextOrigin).toBe(`http://127.0.0.1:${nextPort}`);
      const starting = await fetch(new URL('docs', door.url));
      expect(starting.status).toBe(503);
      await expect(starting.json()).resolves.toEqual({ error: 'site_starting' });
      await expect.poll(async () => (await fetch(new URL('docs', door!.url))).status, { timeout: 10_000 }).toBe(200);
      await expect((await fetch(new URL('docs', door.url))).text()).resolves.toBe('spawned /docs');
    } finally {
      await door?.close();
      door = null;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
