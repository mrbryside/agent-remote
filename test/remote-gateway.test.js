import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { createRemoteGateway } from '../src/remote/gateway.js';

class FakeSocket extends EventEmitter {
  readyState = 1;

  close(code, reason) {
    this.readyState = 2;
    this.closed = { code, reason };
    this.emit('close', code, Buffer.from(reason));
  }
}

function responseStub() {
  return {
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body?.toString();
    },
  };
}

function remoteRequest(url, cookie = 'session-a', method = 'GET') {
  return {
    method,
    url,
    headers: {
      host: 'term.example.test',
      origin: 'https://term.example.test',
      cookie,
    },
  };
}

test('remote gateway closes sockets and streams on session expiry, logout, and device revocation', async () => {
  const timers = [];
  const loggedOut = [];
  const sessions = {
    'session-a': { sessionId: 'session-a', deviceId: 'device-a', expiresAt: 1_500 },
    'session-b': { sessionId: 'session-b', deviceId: 'device-b', expiresAt: 2_000 },
    'session-c': { sessionId: 'session-c', deviceId: 'device-c', expiresAt: 2_500 },
  };
  const auth = {
    authenticate: (request) => sessions[request.headers.cookie],
    sessionIdFromRequest: (request) => request.headers.cookie,
    logout: (sessionId) => loggedOut.push(sessionId),
    clearSessionCookie: () => 'session=; Max-Age=0',
  };
  const gateway = createRemoteGateway({
    auth,
    getPublicUrl: () => 'https://term.example.test',
    now: () => 1_000,
    setTimer: (callback, delay) => {
      const timer = { callback, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => { timer.cleared = true; },
  });

  const expiringSocket = new FakeSocket();
  let expiredStreamCloses = 0;
  await gateway.handleRequest(remoteRequest('/app.js'), responseStub(), async (request) => {
    gateway.trackSocket(expiringSocket, request);
    gateway.trackStream(() => { expiredStreamCloses += 1; }, request);
  });
  assert.equal(timers[0].delay, 500);
  timers[0].callback();
  assert.deepEqual(expiringSocket.closed, { code: 4003, reason: 'Session expired' });
  assert.equal(expiredStreamCloses, 1);

  const logoutSocket = new FakeSocket();
  await gateway.handleRequest(remoteRequest('/app.js', 'session-b'), responseStub(), async (request) => {
    gateway.trackSocket(logoutSocket, request);
  });
  const logoutResponse = responseStub();
  await gateway.handleRequest(remoteRequest('/remote-auth/session', 'session-b', 'DELETE'), logoutResponse, () => {});
  assert.deepEqual(loggedOut, ['session-b']);
  assert.deepEqual(logoutSocket.closed, { code: 4003, reason: 'Logged out' });
  assert.equal(logoutResponse.status, 200);

  let revokedStreamCloses = 0;
  await gateway.handleRequest(remoteRequest('/app.js', 'session-c'), responseStub(), async (request) => {
    gateway.trackStream(() => { revokedStreamCloses += 1; }, request);
  });
  gateway.closeDeviceConnections('device-c');
  assert.equal(revokedStreamCloses, 1);
  gateway.close();
});
