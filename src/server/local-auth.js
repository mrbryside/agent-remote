import { randomBytes, timingSafeEqual } from 'node:crypto';
import { isLoopbackHost } from '../config.js';
import { trustedRequestAuthority } from './http.js';

const COOKIE_NAME = 'agent_remote_local';
const SESSION_ID_BYTES = 32;
const MAX_SESSIONS = 128;

function readCookies(header) {
  const values = new Map();
  if (typeof header !== 'string') return values;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name && value) values.set(name, value);
  }
  return values;
}

function exactSecretMatch(candidate, expected) {
  if (typeof candidate !== 'string' || typeof expected !== 'string') return false;
  const received = Buffer.from(candidate);
  const configured = Buffer.from(expected);
  return received.length === configured.length && timingSafeEqual(received, configured);
}

function bootstrapLocation(url) {
  url.searchParams.delete('token');
  return `${url.pathname}${url.search}${url.hash}`;
}

function responseJson(response, status, payload) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(payload));
}

/**
 * Local workspace authentication deliberately has a very small query-token
 * compatibility window: a configured token may appear only on the initial
 * document navigation (`/?token=...`). That request exchanges it for an
 * HttpOnly, SameSite cookie and redirects to the canonical token-free URL.
 *
 * The listener is loopback-only (also enforced by `loadConfig`). Keeping the
 * session in process memory means closing the server invalidates every local
 * browser session without ever persisting the bearer credential.
 */
export function createLocalAuth(config, { random = randomBytes } = {}) {
  if (!isLoopbackHost(config.host)) {
    throw new Error('Local authentication requires a loopback listener');
  }
  const token = typeof config.token === 'string' ? config.token.trim() : '';
  const sessions = new Set();

  function isAuthorized(request) {
    if (!token) return true;
    const cookie = readCookies(request.headers.cookie).get(COOKIE_NAME);
    if (cookie && sessions.has(cookie)) return true;
    const bearer = request.headers.authorization?.replace(/^Bearer\s+/i, '');
    return exactSecretMatch(bearer, token);
  }

  function hasTokenQuery(request) {
    try { return new URL(request.url, 'http://localhost').searchParams.has('token'); }
    catch { return false; }
  }

  function bootstrap(request, response) {
    let url;
    try { url = new URL(request.url, 'http://localhost'); }
    catch { return false; }
    if (!url.searchParams.has('token')) return false;

    const isInitialDocument = (request.method === 'GET' || request.method === 'HEAD') && url.pathname === '/';
    if (!isInitialDocument || !trustedRequestAuthority(request, config)) {
      responseJson(response, 400, { error: 'A local token may only be used for the initial workspace navigation' });
      return true;
    }

    if (!token) {
      response.writeHead(303, {
        location: bootstrapLocation(url),
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
      });
      response.end();
      return true;
    }
    if (!exactSecretMatch(url.searchParams.get('token'), token)) {
      responseJson(response, 401, { error: 'Unauthorized' });
      return true;
    }

    while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.values().next().value);
    const sessionId = random(SESSION_ID_BYTES).toString('base64url');
    sessions.add(sessionId);
    const secure = request.socket?.encrypted ? '; Secure' : '';
    response.writeHead(303, {
      location: bootstrapLocation(url),
      'set-cookie': `${COOKIE_NAME}=${sessionId}; Path=/; HttpOnly; SameSite=Strict${secure}`,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    });
    response.end();
    return true;
  }

  /** Reject query credentials on APIs, assets, SSE, and WebSocket upgrades. */
  function rejectTokenQuery(request, response) {
    if (!hasTokenQuery(request)) return false;
    if (response) responseJson(response, 400, { error: 'Token query parameters are only accepted for initial workspace navigation' });
    return true;
  }

  function rejectTokenQueryUpgrade(request, socket) {
    if (!hasTokenQuery(request)) return false;
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return true;
  }

  // `workspace-http.js` and the WebSocket router intentionally share the
  // historic `authorized(request, config)` boundary. Adapt a verified cookie
  // to that in-memory boundary instead of making every route learn about local
  // sessions. This never changes a URL or sends the bearer back to a client.
  function prepareAuthorizedRequest(request) {
    if (!token) return true;
    const cookie = readCookies(request.headers.cookie).get(COOKIE_NAME);
    if (!cookie || !sessions.has(cookie)) return false;
    request.headers.authorization = `Bearer ${token}`;
    return true;
  }

  function gateHttp(request, response) {
    if (bootstrap(request, response)) return true;
    if (rejectTokenQuery(request, response)) return true;
    prepareAuthorizedRequest(request);
    return false;
  }

  function gateUpgrade(request, socket) {
    if (rejectTokenQueryUpgrade(request, socket)) return true;
    prepareAuthorizedRequest(request);
    return false;
  }

  return {
    bootstrap,
    authorize: isAuthorized,
    authorizeDevtools: isAuthorized,
    gateHttp,
    gateUpgrade,
    prepareAuthorizedRequest,
    rejectTokenQuery,
    rejectTokenQueryUpgrade,
    sessionCount: () => sessions.size,
  };
}
