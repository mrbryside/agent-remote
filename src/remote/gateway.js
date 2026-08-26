import { WebSocket } from 'ws';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  parseRequestUrl,
  rejectInvalidRequestTarget,
  rejectInvalidUpgrade,
} from '../server/request-target.js';

const maxJsonBytes = 64 * 1024;
const authHeaders = Object.freeze({
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
});
const remoteEntryAssets = new Map([
  ['/remote-entry.html', { file: fileURLToPath(new URL('../../public/remote-entry.html', import.meta.url)), type: 'text/html; charset=utf-8' }],
  ['/remote-entry.js', { file: fileURLToPath(new URL('../../public/remote-entry.js', import.meta.url)), type: 'text/javascript; charset=utf-8' }],
  ['/remote-entry.css', { file: fileURLToPath(new URL('../../public/remote-entry.css', import.meta.url)), type: 'text/css; charset=utf-8' }],
]);

function sendJson(response, status, payload, headers = {}) {
  response.writeHead(status, {
    ...authHeaders,
    ...headers,
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(payload));
}

async function sendEntryAsset(response, method, pathname) {
  const asset = remoteEntryAssets.get(pathname);
  if (!asset) return false;
  response.writeHead(200, {
    ...authHeaders,
    'content-type': asset.type,
  });
  response.end(method === 'HEAD' ? undefined : await readFile(asset.file));
  return true;
}

function rejectUpgrade(socket, status, message) {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

function publicOrigin(getPublicUrl, allowInsecurePublicOrigin) {
  const value = getPublicUrl();
  if (typeof value !== 'string' || !value) return undefined;
  try {
    const url = new URL(value);
    if ((url.protocol !== 'https:' && !(allowInsecurePublicOrigin && url.protocol === 'http:'))
      || url.username || url.password || url.search || url.hash) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

function isStateChanging(request) {
  return request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'OPTIONS';
}

function responseError(response, error) {
  const status = Number.isInteger(error?.status) ? error.status : 400;
  const payload = { error: error?.message || 'Invalid remote authentication request' };
  if (typeof error?.code === 'string') payload.code = error.code;
  sendJson(response, status, payload);
}

async function readJson(request) {
  const contentType = request.headers['content-type'];
  if (typeof contentType !== 'string' || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)) {
    const error = new Error('Content-Type must be application/json');
    error.status = 415;
    throw error;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxJsonBytes) {
      const error = new Error('Request body is too large');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('Invalid JSON body');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('JSON body must be an object');
  return body;
}

function safeDevice(device) {
  return {
    id: device.id,
    name: device.name,
    createdAt: device.createdAt,
    lastUsedAt: device.lastUsedAt,
  };
}

export function createRemoteGateway({
  auth,
  getPublicUrl,
  allowInsecurePublicOrigin = false,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (!auth || typeof auth.authenticate !== 'function') throw new TypeError('auth.authenticate is required');
  if (typeof getPublicUrl !== 'function') throw new TypeError('getPublicUrl is required');
  if (typeof now !== 'function' || typeof setTimer !== 'function' || typeof clearTimer !== 'function') {
    throw new TypeError('now, setTimer, and clearTimer must be functions');
  }

  const socketsByDevice = new Map();
  const socketsBySession = new Map();
  const streamsByDevice = new Map();
  const streamsBySession = new Map();
  const sessionExpiryTimers = new Map();

  function expectedOrigin() {
    return publicOrigin(getPublicUrl, allowInsecurePublicOrigin);
  }

  function hostAllowed(request, origin) {
    return Boolean(origin) && request.headers.host === new URL(origin).host;
  }

  function originAllowed(request, origin, required) {
    if (!required && !request.headers.origin) return true;
    return Boolean(origin) && request.headers.origin === origin;
  }

  function authenticate(request) {
    const session = auth.authenticate(request);
    if (!session?.deviceId) return undefined;
    request.remoteDeviceId = session.deviceId;
    request.remoteSessionId = session.sessionId;
    request.remoteSessionExpiresAt = session.expiresAt;
    return session;
  }

  function addConnection(map, key, connection) {
    if (!key) return;
    let connections = map.get(key);
    if (!connections) {
      connections = new Set();
      map.set(key, connections);
    }
    connections.add(connection);
  }

  function removeConnection(map, key, connection) {
    const connections = key && map.get(key);
    if (!connections) return;
    connections.delete(connection);
    if (connections.size === 0) map.delete(key);
  }

  function clearSessionExpiryIfIdle(sessionId) {
    if (!sessionId || socketsBySession.has(sessionId) || streamsBySession.has(sessionId)) return;
    const timer = sessionExpiryTimers.get(sessionId);
    if (timer) clearTimer(timer);
    sessionExpiryTimers.delete(sessionId);
  }

  function closeStreams(streams) {
    if (!streams) return;
    for (const closeStream of [...streams]) {
      Promise.resolve(closeStream()).catch(() => {});
    }
  }

  function closeSessionConnections(sessionId, code = 4003, reason = 'Session expired') {
    const timer = sessionExpiryTimers.get(sessionId);
    if (timer) clearTimer(timer);
    sessionExpiryTimers.delete(sessionId);
    const sockets = socketsBySession.get(sessionId);
    if (sockets) {
      for (const socket of [...sockets]) {
        if (socket.readyState < WebSocket.CLOSING) socket.close(code, reason);
      }
    }
    closeStreams(streamsBySession.get(sessionId));
  }

  function ensureSessionExpiry(sessionId, expiresAt) {
    if (!sessionId || !Number.isFinite(expiresAt) || sessionExpiryTimers.has(sessionId)) return;
    const timer = setTimer(
      () => closeSessionConnections(sessionId, 4003, 'Session expired'),
      Math.max(0, expiresAt - now()),
    );
    timer?.unref?.();
    sessionExpiryTimers.set(sessionId, timer);
  }

  async function handleAuthRequest(request, response, origin) {
    const pathname = parseRequestUrl(request).pathname;
    try {
      if (request.method === 'GET' && pathname === '/remote-auth/status') {
        const session = authenticate(request);
        return sendJson(response, 200, session
          ? { authenticated: true, deviceId: session.deviceId, expiresAt: session.expiresAt }
          : { authenticated: false });
      }
      if (request.method === 'POST' && pathname === '/remote-auth/pair') {
        const body = await readJson(request);
        const result = await auth.pair({ ...body, request });
        return sendJson(response, 201, {
          authenticated: true,
          device: safeDevice(result.device),
          expiresAt: result.expiresAt,
        }, { 'set-cookie': result.setCookie });
      }
      if (request.method === 'POST' && pathname === '/remote-auth/challenge') {
        const body = await readJson(request);
        const result = await auth.createChallenge(body.deviceId, { request });
        return sendJson(response, 200, result);
      }
      if (request.method === 'POST' && pathname === '/remote-auth/verify') {
        const body = await readJson(request);
        const result = await auth.verifyChallenge({ ...body, origin, request });
        return sendJson(response, 200, {
          authenticated: true,
          expiresAt: result.expiresAt,
        }, { 'set-cookie': result.setCookie });
      }
      if (request.method === 'DELETE' && pathname === '/remote-auth/session') {
        const sessionId = auth.sessionIdFromRequest(request);
        if (sessionId) {
          auth.logout(sessionId);
          closeSessionConnections(sessionId, 4003, 'Logged out');
        }
        return sendJson(response, 200, { authenticated: false }, { 'set-cookie': auth.clearSessionCookie() });
      }
      return sendJson(response, 404, { error: 'Not found' });
    } catch (error) {
      return responseError(response, error);
    }
  }

  function trackSocket(socket, request) {
    const deviceId = request?.remoteDeviceId;
    if (!deviceId) return;
    const sessionId = request.remoteSessionId;
    addConnection(socketsByDevice, deviceId, socket);
    addConnection(socketsBySession, sessionId, socket);
    ensureSessionExpiry(sessionId, request.remoteSessionExpiresAt);
    const remove = () => {
      removeConnection(socketsByDevice, deviceId, socket);
      removeConnection(socketsBySession, sessionId, socket);
      clearSessionExpiryIfIdle(sessionId);
    };
    socket.once('close', remove);
    socket.once('error', remove);
  }

  function trackStream(closeStream, request) {
    const deviceId = request?.remoteDeviceId;
    if (!deviceId || typeof closeStream !== 'function') return () => {};
    const sessionId = request.remoteSessionId;
    addConnection(streamsByDevice, deviceId, closeStream);
    addConnection(streamsBySession, sessionId, closeStream);
    ensureSessionExpiry(sessionId, request.remoteSessionExpiresAt);
    let tracked = true;
    return () => {
      if (!tracked) return;
      tracked = false;
      removeConnection(streamsByDevice, deviceId, closeStream);
      removeConnection(streamsBySession, sessionId, closeStream);
      clearSessionExpiryIfIdle(sessionId);
    };
  }

  function closeDeviceConnections(deviceId) {
    const sockets = socketsByDevice.get(deviceId);
    if (sockets) {
      for (const socket of [...sockets]) {
        if (socket.readyState < WebSocket.CLOSING) socket.close(4003, 'Device revoked');
      }
    }
    closeStreams(streamsByDevice.get(deviceId));
  }

  return {
    async handleRequest(request, response, handleWorkspaceRequest) {
      const requestUrl = parseRequestUrl(request);
      if (!requestUrl) return rejectInvalidRequestTarget(response);
      const { pathname } = requestUrl;
      if (pathname.startsWith('/api/remote/')) return sendJson(response, 404, { error: 'Not found' });
      const origin = expectedOrigin();
      if (!hostAllowed(request, origin)) return sendJson(response, 403, { error: 'Host is not allowed' });
      if (!originAllowed(request, origin, isStateChanging(request))) {
        return sendJson(response, 403, { error: 'Origin is not allowed' });
      }
      if (pathname.startsWith('/remote-auth/')) return handleAuthRequest(request, response, origin);
      if ((request.method === 'GET' || request.method === 'HEAD') && await sendEntryAsset(response, request.method, pathname)) {
        return;
      }
      if ((request.method === 'GET' || request.method === 'HEAD') && (pathname === '/p' || pathname === '/pair')) {
        await sendEntryAsset(response, request.method, '/remote-entry.html');
        return;
      }
      const session = authenticate(request);
      if (!session) {
        if ((request.method === 'GET' || request.method === 'HEAD') && pathname === '/') {
          await sendEntryAsset(response, request.method, '/remote-entry.html');
          return;
        }
        return sendJson(response, 401, { error: 'Unauthorized', code: 'REMOTE_UNAUTHORIZED' });
      }
      return handleWorkspaceRequest(request, response, 'remote');
    },

    handleUpgrade(request, socket, head, handleWorkspaceUpgrade) {
      const requestUrl = parseRequestUrl(request);
      if (!requestUrl) return rejectInvalidUpgrade(socket);
      const { pathname } = requestUrl;
      if (pathname.startsWith('/api/remote/') || pathname.startsWith('/remote-auth/')) return rejectUpgrade(socket, 404, 'Not Found');
      const origin = expectedOrigin();
      if (!hostAllowed(request, origin) || !originAllowed(request, origin, true)) {
        return rejectUpgrade(socket, 403, 'Forbidden');
      }
      if (!authenticate(request)) return rejectUpgrade(socket, 401, 'Unauthorized');
      return handleWorkspaceUpgrade(request, socket, head, 'remote');
    },

    trackSocket,
    trackStream,
    closeDeviceConnections,
    close() {
      for (const deviceId of new Set([...socketsByDevice.keys(), ...streamsByDevice.keys()])) {
        closeDeviceConnections(deviceId);
      }
      for (const timer of sessionExpiryTimers.values()) clearTimer(timer);
      socketsByDevice.clear();
      socketsBySession.clear();
      streamsByDevice.clear();
      streamsBySession.clear();
      sessionExpiryTimers.clear();
    },
  };
}
