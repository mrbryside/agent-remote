import { randomUUID, timingSafeEqual, webcrypto } from 'node:crypto';
import { remoteError } from './errors.js';

const COOKIE_NAME = '__Host-agent_remote';
const PAIRING_TTL_MS = 120_000;
const CHALLENGE_TTL_MS = 60_000;
const SESSION_TTL_MS = 43_200_000;
const AUTH_WINDOW_MS = 60_000;
const GLOBAL_AUTH_LIMIT = 100;
const CLIENT_AUTH_LIMIT = 20;
const encoder = new TextEncoder();

function base64url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

function decodeBase64url(value, field) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new TypeError(`${field} must be a base64url string`);
  }
  const decoded = Buffer.from(value, 'base64url');
  if (!decoded.length || base64url(decoded) !== value) {
    throw new TypeError(`${field} must be canonical base64url`);
  }
  return decoded;
}

function canonicalPublicJwk(publicKeyJwk) {
  if (!publicKeyJwk || typeof publicKeyJwk !== 'object' || Array.isArray(publicKeyJwk)) {
    throw new TypeError('publicKeyJwk must be an object');
  }
  if (publicKeyJwk.kty !== 'EC' || publicKeyJwk.crv !== 'P-256') {
    throw new TypeError('publicKeyJwk must be an ECDSA P-256 public key');
  }
  if (Object.hasOwn(publicKeyJwk, 'd')) {
    throw new TypeError('publicKeyJwk must not include private key material');
  }
  const x = decodeBase64url(publicKeyJwk.x, 'publicKeyJwk.x');
  const y = decodeBase64url(publicKeyJwk.y, 'publicKeyJwk.y');
  if (x.length !== 32 || y.length !== 32) {
    throw new TypeError('publicKeyJwk coordinates must be 32 bytes');
  }
  return { crv: 'P-256', kty: 'EC', x: publicKeyJwk.x, y: publicKeyJwk.y };
}

function canonicalJwkJson(publicKeyJwk) {
  return JSON.stringify(canonicalPublicJwk(publicKeyJwk));
}

function sanitizeDeviceName(value) {
  if (typeof value !== 'string') throw new TypeError('deviceName must be a string');
  const name = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim() || 'Paired device';
  if (Array.from(name).length > 80) throw new TypeError('deviceName must not exceed 80 characters');
  return name;
}

function cookieParts(sessionId, maxAge, secureCookies, cookieName = COOKIE_NAME) {
  const parts = [`${cookieName}=${sessionId}`, `Max-Age=${maxAge}`, 'Path=/', 'HttpOnly'];
  if (secureCookies) parts.push('Secure');
  parts.push('SameSite=Strict');
  return parts.join('; ');
}

export function parseCookies(value) {
  if (typeof value !== 'string') return {};
  return value.split(';').reduce((cookies, part) => {
    const separator = part.indexOf('=');
    if (separator <= 0) return cookies;
    const key = part.slice(0, separator).trim();
    const rawValue = part.slice(separator + 1).trim();
    try {
      cookies[key] = decodeURIComponent(rawValue);
    } catch {
      // Malformed cookie values are unauthenticated, not a request failure.
    }
    return cookies;
  }, {});
}

export function createRemoteAuth({
  store,
  now = Date.now,
  randomBytes = (size) => webcrypto.getRandomValues(new Uint8Array(size)),
  subtle = webcrypto.subtle,
  secureCookies = true,
  // This is intentionally programmatic-only: the Playwright fixture exercises
  // the gateway over loopback HTTP, while every real launch retains HTTPS-only
  // pairing and challenge origins.
  allowInsecurePublicOrigin = false,
  onRevoke = () => {},
} = {}) {
  if (!store) throw new TypeError('store is required');
  if (typeof now !== 'function' || typeof randomBytes !== 'function') throw new TypeError('now and randomBytes must be functions');
  if (!subtle || typeof subtle.digest !== 'function') {
    throw new TypeError('subtle must provide digest');
  }
  if (typeof onRevoke !== 'function') throw new TypeError('onRevoke must be a function');

  let pairing;
  const challenges = new Map();
  const sessions = new Map();
  const rateBuckets = new Map();
  let closed = false;
  const importKey = subtle.importKey?.bind(subtle) || webcrypto.subtle.importKey.bind(webcrypto.subtle);
  const verify = subtle.verify?.bind(subtle) || webcrypto.subtle.verify.bind(webcrypto.subtle);
  // Browsers correctly reject a __Host- cookie without Secure.  The fixture's
  // explicit non-secure mode therefore uses an unrelated test cookie name;
  // normal launches always retain the __Host- contract.
  const cookieName = secureCookies ? COOKIE_NAME : 'agent_remote_test';

  function currentTime() {
    const value = now();
    if (!Number.isFinite(value)) throw new TypeError('now must return a finite number');
    return value;
  }

  function requireOpen() {
    if (closed) throw new Error('remote auth is closed');
  }

  async function sha256(value) {
    return Buffer.from(await subtle.digest('SHA-256', value));
  }

  function newToken(size = 32) {
    const value = randomBytes(size);
    if (!value || typeof value.length !== 'number' || value.length !== size) {
      throw new TypeError(`randomBytes must return ${size} bytes`);
    }
    return base64url(value);
  }

  function activeOrError(deviceId) {
    const device = store.getActiveDevice(deviceId);
    if (device) return device;
    if (store.listDevices().some((candidate) => candidate.id === deviceId && candidate.revokedAt !== null)) {
      throw remoteError('DEVICE_REVOKED', 'This device has been revoked', 403);
    }
    throw remoteError('REMOTE_UNAUTHORIZED', 'This device is not paired', 401);
  }

  function clientId(input) {
    if (typeof input === 'string' && input) return input;
    if (input && typeof input === 'object') {
      if (typeof input.clientId === 'string' && input.clientId) return input.clientId;
      if (typeof input.clientIp === 'string' && input.clientIp) return input.clientIp;
      const request = input.request;
      const forwarded = request?.headers?.['cf-connecting-ip'];
      if (typeof forwarded === 'string' && forwarded) return forwarded;
      if (typeof request?.socket?.remoteAddress === 'string' && request.socket.remoteAddress) return request.socket.remoteAddress;
    }
    return 'unknown';
  }

  function cleanupRateBuckets(bucket) {
    for (const key of rateBuckets.keys()) {
      if (key < bucket) rateBuckets.delete(key);
    }
  }

  function assertRateLimit(input) {
    requireOpen();
    const timestamp = currentTime();
    const bucket = Math.floor(timestamp / AUTH_WINDOW_MS);
    cleanupRateBuckets(bucket);
    const counts = rateBuckets.get(bucket) || { global: 0, clients: new Map() };
    const client = clientId(input);
    const count = counts.clients.get(client) || 0;
    if (counts.global >= GLOBAL_AUTH_LIMIT || count >= CLIENT_AUTH_LIMIT) {
      throw remoteError('REMOTE_UNAUTHORIZED', 'Too many authentication attempts', 429);
    }
    counts.global += 1;
    counts.clients.set(client, count + 1);
    rateBuckets.set(bucket, counts);
  }

  function issueSession(deviceId) {
    const issuedAt = currentTime();
    const sessionId = newToken();
    const expiresAt = issuedAt + SESSION_TTL_MS;
    sessions.set(sessionId, { deviceId, expiresAt });
    return {
      sessionId,
      expiresAt,
      setCookie: cookieParts(sessionId, SESSION_TTL_MS / 1000, secureCookies, cookieName),
    };
  }

  function sessionIdFromRequest(request) {
    const cookie = typeof request === 'string' ? request : request?.headers?.cookie;
    const sessionId = parseCookies(cookie)[cookieName];
    return typeof sessionId === 'string' && /^[A-Za-z0-9_-]+$/.test(sessionId) ? sessionId : undefined;
  }

  return {
    async createPairing(publicUrl) {
      requireOpen();
      const url = new URL(publicUrl);
      if ((url.protocol !== 'https:' && !(allowInsecurePublicOrigin && url.protocol === 'http:'))
        || url.username || url.password || url.search || url.hash) {
        throw new TypeError('publicUrl must be an HTTPS origin');
      }
      const secretBytes = randomBytes(32);
      if (!secretBytes || typeof secretBytes.length !== 'number' || secretBytes.length !== 32) {
        throw new TypeError('randomBytes must return 32 bytes');
      }
      const secret = base64url(secretBytes);
      const createdAt = currentTime();
      pairing = {
        secretHash: await sha256(secretBytes),
        expiresAt: createdAt + PAIRING_TTL_MS,
      };
      url.pathname = `${url.pathname.replace(/\/$/, '')}/pair`;
      url.hash = secret;
      return { pairUrl: url.toString(), expiresAt: pairing.expiresAt };
    },

    async pair({ secret, deviceName, publicKeyJwk, ...request } = {}) {
      assertRateLimit(request);
      if (!pairing || currentTime() >= pairing.expiresAt) {
        pairing = undefined;
        throw remoteError('PAIRING_EXPIRED', 'Pairing session has expired or was already used', 410);
      }
      let secretHash;
      try {
        secretHash = await sha256(decodeBase64url(secret, 'secret'));
      } catch {
        throw remoteError('PAIRING_EXPIRED', 'Pairing session has expired or was already used', 410);
      }
      if (secretHash.length !== pairing.secretHash.length || !timingSafeEqual(secretHash, pairing.secretHash)) {
        throw remoteError('PAIRING_EXPIRED', 'Pairing session has expired or was already used', 410);
      }
      pairing = undefined;
      const canonical = canonicalPublicJwk(publicKeyJwk);
      const fingerprint = base64url(await sha256(encoder.encode(canonicalJwkJson(canonical))));
      if (store.listDevices().some((device) => device.fingerprint === fingerprint)) {
        throw new TypeError('A device with this public key is already paired');
      }
      const device = store.registerDevice({
        id: randomUUID(),
        name: sanitizeDeviceName(deviceName),
        publicKeyJwk: canonical,
        fingerprint,
        createdAt: currentTime(),
      });
      return { authenticated: true, device, ...issueSession(device.id) };
    },

    async createChallenge(deviceId, request) {
      assertRateLimit(request);
      activeOrError(deviceId);
      const challengeId = newToken();
      const challenge = newToken();
      const createdAt = currentTime();
      const entry = { deviceId, challenge, expiresAt: createdAt + CHALLENGE_TTL_MS };
      challenges.set(challengeId, entry);
      return { challengeId, challenge, expiresAt: entry.expiresAt };
    },

    async verifyChallenge({ deviceId, challengeId, signature, origin, ...request } = {}) {
      assertRateLimit(request);
      const challenge = challenges.get(challengeId);
      challenges.delete(challengeId);
      if (!challenge || challenge.deviceId !== deviceId || currentTime() >= challenge.expiresAt) {
        throw remoteError('REMOTE_UNAUTHORIZED', 'Challenge is invalid or expired', 401);
      }
      const device = activeOrError(deviceId);
      let key;
      let valid = false;
      try {
        const parsedOrigin = new URL(origin);
        if (parsedOrigin.origin !== origin
          || (parsedOrigin.protocol !== 'https:' && !(allowInsecurePublicOrigin && parsedOrigin.protocol === 'http:'))) {
          throw new TypeError('Invalid origin');
        }
        key = await importKey('jwk', canonicalPublicJwk(device.publicKeyJwk), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
        const data = encoder.encode(`agent-remote:v1:${challengeId}:${challenge.challenge}:${origin}`);
        valid = await verify({ name: 'ECDSA', hash: 'SHA-256' }, key, decodeBase64url(signature, 'signature'), data);
      } catch {
        valid = false;
      }
      if (!valid) throw remoteError('REMOTE_UNAUTHORIZED', 'Challenge signature is invalid', 401);
      store.touchDevice(deviceId, currentTime());
      return { authenticated: true, ...issueSession(deviceId) };
    },

    authenticate(request) {
      requireOpen();
      const sessionId = sessionIdFromRequest(request);
      if (!sessionId) return undefined;
      const session = sessions.get(sessionId);
      if (!session || currentTime() >= session.expiresAt) {
        sessions.delete(sessionId);
        return undefined;
      }
      if (!store.getActiveDevice(session.deviceId)) {
        sessions.delete(sessionId);
        return undefined;
      }
      return { sessionId, deviceId: session.deviceId, expiresAt: session.expiresAt };
    },

    logout(sessionId) {
      requireOpen();
      return sessions.delete(sessionId);
    },

    revokeDevice(deviceId) {
      requireOpen();
      const revoked = store.revokeDevice(deviceId, currentTime());
      if (!revoked) return false;
      for (const [sessionId, session] of sessions) {
        if (session.deviceId === deviceId) sessions.delete(sessionId);
      }
      onRevoke(deviceId);
      return true;
    },

    assertRateLimit,

    sessionIdFromRequest,

    serializeSessionCookie(sessionId) {
      return cookieParts(sessionId, SESSION_TTL_MS / 1000, secureCookies, cookieName);
    },

    clearSessionCookie() {
      return cookieParts('', 0, secureCookies, cookieName);
    },

    close() {
      pairing = undefined;
      challenges.clear();
      sessions.clear();
      rateBuckets.clear();
      closed = true;
    },
  };
}
