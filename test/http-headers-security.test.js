import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { once } from 'node:events';
import test from 'node:test';
import { join } from 'node:path';
import { createStaticAssetHandler } from '../src/server/static-assets.js';
import { createWorkspaceHttpHandler } from '../src/server/workspace-http.js';

class CapturingResponse extends Writable {
  constructor() {
    super();
    this.statusCode = undefined;
    this.headers = undefined;
    this.chunks = [];
  }

  writeHead(statusCode, headers) {
    this.statusCode = statusCode;
    this.headers = headers;
    return this;
  }

  _write(chunk, encoding, callback) {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }
}

function request(url, headers = {}, method = 'GET') {
  return {
    url,
    headers,
    method,
    socket: { localAddress: '127.0.0.1', localPort: 3000, encrypted: false },
  };
}

function workspaceHandler({ rendererForDevtoolsAccess = () => undefined } = {}) {
  return createWorkspaceHttpHandler({
    config: {
      host: '127.0.0.1',
      token: 'secret',
      allowedOrigins: [],
      tmuxBacked: false,
      desktopMode: false,
      allowedCwdRoots: [],
    },
    handleRemoteRoute: async () => false,
    handleBrowserControlRoute: async () => false,
    listWorkspaceSessions: async () => [],
    openWorkspaceStream: () => {},
    projectStore: { list: async () => [] },
    agentCatalog: { list: () => [] },
    renderers: new Map(),
    handleConversationFileRoute: async () => false,
    handleConversationControlRoute: async () => false,
    handleConversationMessageRoute: async () => false,
    handleProjectRoute: async () => false,
    serveStaticAsset: () => {},
    rendererForDevtoolsAccess,
    proxyDevtoolsAsset: () => assert.fail('agent-remote.js must not use the upstream proxy'),
  });
}

async function dispatch(handler, input, surface = 'local') {
  const response = new CapturingResponse();
  await handler(input, response, surface);
  if (!response.writableEnded) await once(response, 'finish');
  return response;
}

test('applies anti-framing headers to both local and Remote workspace documents', async () => {
  const serveStaticAsset = createStaticAssetHandler({
    root: process.cwd(),
    publicDir: join(process.cwd(), 'public'),
  });

  for (const surface of ['local', 'remote']) {
    const response = new CapturingResponse();
    serveStaticAsset({ request: request('/'), response, surface, pathname: '/' });
    await once(response, 'finish');
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['x-frame-options'], 'DENY');
    assert.equal(response.headers['referrer-policy'], 'no-referrer');
    assert.match(response.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.match(Buffer.concat(response.chunks).toString('utf8'), /Interactive terminal/);
  }
});

test('requires the local API boundary before serving DevTools assets', async () => {
  let rendererLookups = 0;
  const handler = workspaceHandler({
    rendererForDevtoolsAccess: () => {
      rendererLookups += 1;
      return {};
    },
  });
  const localHeaders = { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' };

  const missingToken = await dispatch(handler, request('/devtools/access/agent-remote.js', localHeaders));
  assert.equal(missingToken.statusCode, 401);
  assert.equal(rendererLookups, 0);

  const badOrigin = await dispatch(handler, request('/devtools/access/agent-remote.js', {
    ...localHeaders,
    origin: 'https://attacker.example',
    authorization: 'Bearer secret',
  }));
  assert.equal(badOrigin.statusCode, 403);
  assert.equal(rendererLookups, 0);

  const permitted = await dispatch(handler, request('/devtools/access/agent-remote.js', {
    ...localHeaders,
    authorization: 'Bearer secret',
  }));
  assert.equal(permitted.statusCode, 200);
  assert.match(Buffer.concat(permitted.chunks).toString('utf8'), /disableDuplicateScreencast/);
  assert.equal(rendererLookups, 1);
});

test('leaves Remote DevTools authorization to the authenticated gateway', async () => {
  const handler = workspaceHandler({ rendererForDevtoolsAccess: () => ({}) });
  const response = await dispatch(handler, request('/devtools/access/agent-remote.js'), 'remote');
  assert.equal(response.statusCode, 200);
});
