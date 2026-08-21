import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import { createTerminalServer } from '../src/server.js';
import { createDevtoolsProxy } from '../src/server/devtools-proxy.js';

async function withServer(options, run) {
  const stateRoot = mkdtempSync(join(tmpdir(), 'agent-remote-transport-'));
  const app = createTerminalServer({
    host: '127.0.0.1',
    port: 0,
    remoteHost: '127.0.0.1',
    remotePort: 0,
    shell: '/bin/sh',
    shellArgs: [],
    tmuxSession: '',
    tmuxShell: false,
    databaseFile: join(stateRoot, 'agent-remote.db'),
    reapBrowserAutomationSessions: async () => [],
    ...options,
  });
  const { url } = await app.listen();
  try {
    await run(url, app);
  } finally {
    await app.close();
    rmSync(stateRoot, { recursive: true, force: true });
  }
}

function conversationRegistry() {
  return {
    async read() {
      return { items: [], thread: { id: 'thread-1' } };
    },
    async watch() {
      return async () => {};
    },
    async close() {},
  };
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('Timed out waiting for a connection to close');
}

test('uses finite HTTP transport timeouts and normalizes invalid connection limits', async () => {
  await withServer({ maxConnections: Number.NaN }, async (_url, app) => {
    for (const server of [app.server, app.remoteServer]) {
      assert.equal(server.requestTimeout, 120_000);
      assert.equal(server.headersTimeout, 30_000);
      assert.equal(server.keepAliveTimeout, 5_000);
      assert.equal(server.timeout, 0);
      assert.equal(server.maxHeadersCount, 100);
      assert.equal(server.maxRequestsPerSocket, 100);
    }
    assert.equal(app.config.maxConnections, 20);
  });

  await withServer({ maxConnections: -1 }, async (_url, app) => {
    assert.equal(app.config.maxConnections, 20);
  });
});

test('shares one bounded capacity across workspace and conversation HTTP streams', async () => {
  await withServer({
    maxConnections: 2,
    conversationRegistry: conversationRegistry(),
    listWorkspaceSessions: async () => [{ name: 'chat-1', cwd: process.cwd() }],
    managedSessionProcessId: async () => 1,
  }, async (url) => {
    const workspace = await fetch(`${url}/api/workspace/stream`);
    assert.equal(workspace.status, 200);

    const conversation = await fetch(`${url}/api/conversations/chat-1/stream`);
    assert.equal(conversation.status, 200);

    const rejected = await fetch(`${url}/api/workspace/stream`);
    assert.equal(rejected.status, 503);

    await workspace.body.cancel();
    await waitFor(() => workspace.body?.locked === false);
    const replacement = await fetch(`${url}/api/workspace/stream`);
    assert.equal(replacement.status, 200);

    await replacement.body.cancel();
    await conversation.body.cancel();
  });
});

test('releases a DevTools transport reservation when its downstream socket closes', async () => {
  const upstreamServer = createServer();
  const upstreamWss = new WebSocketServer({ server: upstreamServer });
  await new Promise((resolve) => upstreamServer.listen(0, '127.0.0.1', resolve));
  const upstreamPort = upstreamServer.address().port;

  const downstreamServer = createServer();
  const downstreamWss = new WebSocketServer({ server: downstreamServer });
  const clients = new Set();
  let releases = 0;
  const { bridgeDevtoolsSocket } = createDevtoolsProxy({
    createHttpRequest: () => { throw new Error('not used'); },
    devtoolsClients: clients,
    remoteDeviceSockets: new Map(),
    remoteGateway: { trackSocket() {} },
  });
  downstreamWss.on('connection', (socket) => {
    bridgeDevtoolsSocket(socket, { cdpPort: upstreamPort }, 'target-1', {}, () => { releases += 1; });
  });
  await new Promise((resolve) => downstreamServer.listen(0, '127.0.0.1', resolve));
  const downstreamPort = downstreamServer.address().port;
  const downstream = new WebSocket(`ws://127.0.0.1:${downstreamPort}`);
  await new Promise((resolve, reject) => {
    downstream.once('open', resolve);
    downstream.once('error', reject);
  });
  downstream.close();
  await waitFor(() => releases === 1);
  assert.equal(clients.size, 0);

  await new Promise((resolve) => downstreamWss.close(resolve));
  await new Promise((resolve) => downstreamServer.close(resolve));
  await new Promise((resolve) => upstreamWss.close(resolve));
  await new Promise((resolve) => upstreamServer.close(resolve));
});
