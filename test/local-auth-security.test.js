import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { Writable } from 'node:stream';
import { createLocalAuth } from '../src/server/local-auth.js';

class CapturingResponse extends Writable {
  constructor() {
    super();
    this.statusCode = undefined;
    this.headers = undefined;
    this.chunks = [];
  }

  writeHead(status, headers) {
    this.statusCode = status;
    this.headers = headers;
    return this;
  }

  _write(chunk, encoding, callback) {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }
}

function request(url, { method = 'GET', headers = {} } = {}) {
  return {
    url,
    method,
    headers: { host: '127.0.0.1:3000', ...headers },
    socket: { localAddress: '127.0.0.1', localPort: 3000, encrypted: false },
  };
}

async function boot(auth, input) {
  const response = new CapturingResponse();
  assert.equal(auth.bootstrap(input, response), true);
  await once(response, 'finish');
  return response;
}

test('exchanges the one-time initial local token query for an HttpOnly same-site session cookie', async () => {
  const auth = createLocalAuth({ host: '127.0.0.1', token: 'correct horse battery staple' });
  const response = await boot(auth, request('/?view=mobile&token=correct+horse+battery+staple'));

  assert.equal(response.statusCode, 303);
  assert.equal(response.headers.location, '/?view=mobile');
  assert.match(response.headers['set-cookie'], /^agent_remote_local=[A-Za-z0-9_-]+; Path=\/; HttpOnly; SameSite=Strict$/);
  assert.equal(auth.authorize(request('/api/sessions')), false);
  assert.equal(auth.authorize(request('/api/sessions', { headers: { cookie: response.headers['set-cookie'] } })), true);
  assert.equal(auth.authorize(request('/api/sessions?token=correct%20horse%20battery%20staple')), false);
  assert.equal(auth.authorize(request('/api/sessions', { headers: { authorization: 'Bearer correct horse battery staple' } })), true);

  const cookieRequest = request('/api/sessions', { headers: { cookie: response.headers['set-cookie'] } });
  assert.equal(auth.gateHttp(cookieRequest, new CapturingResponse()), false);
  assert.equal(cookieRequest.headers.authorization, 'Bearer correct horse battery staple');
});

test('does not accept a token query outside the initial document bootstrap', async () => {
  const auth = createLocalAuth({ host: '127.0.0.1', token: 'secret' });
  const response = new CapturingResponse();
  assert.equal(auth.rejectTokenQuery(request('/api/sessions?token=secret'), response), true);
  await once(response, 'finish');
  assert.equal(response.statusCode, 400);
  assert.equal(auth.authorize(request('/api/sessions?token=secret')), false);

  const assetResponse = await boot(auth, request('/app.js?token=secret'));
  assert.equal(assetResponse.statusCode, 400);

  const upgradeSocket = { written: '', destroyed: false, write(value) { this.written += value; }, destroy() { this.destroyed = true; } };
  assert.equal(auth.gateUpgrade(request('/ws?token=secret'), upgradeSocket), true);
  assert.match(upgradeSocket.written, /^HTTP\/1\.1 400 Bad Request/);
  assert.equal(upgradeSocket.destroyed, true);
});

test('refuses bootstrap requests that do not identify the local listener', async () => {
  const auth = createLocalAuth({ host: '127.0.0.1', token: 'secret' });
  const response = await boot(auth, request('/?token=secret', { headers: { host: 'attacker.example:3000' } }));
  assert.equal(response.statusCode, 400);
  assert.equal(auth.sessionCount(), 0);
});

test('strips a legacy token parameter even when local token authentication is disabled', async () => {
  const auth = createLocalAuth({ host: '127.0.0.1', token: '' });
  const response = await boot(auth, request('/?token=old-token'));
  assert.equal(response.statusCode, 303);
  assert.equal(response.headers.location, '/');
  assert.equal(response.headers['set-cookie'], undefined);
});
