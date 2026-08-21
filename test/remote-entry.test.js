import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  base64url,
  challengePayload,
  createPersistedCredential,
  extractPairingSecret,
  getOrCreatePersistedCredential,
  inferBrowserDeviceName,
  logout,
  pairDevice,
  reauthenticateDevice,
  restoreCredential,
} from '../public/remote-entry.js';
import { createRemoteGateway } from '../src/remote/gateway.js';

const publicDir = new URL('../public/', import.meta.url);

function requestResult(result) {
  const request = { result, error: undefined, onsuccess: undefined, onerror: undefined };
  queueMicrotask(() => request.onsuccess?.());
  return request;
}

function fakeIndexedDb() {
  const records = new Map();
  return {
    open() {
      const request = { result: undefined, error: undefined, onupgradeneeded: undefined, onsuccess: undefined, onerror: undefined };
      queueMicrotask(() => {
        const database = {
          objectStoreNames: { contains: () => true },
          createObjectStore: () => {},
          transaction: () => ({
            objectStore: () => ({
              put: (value) => { records.set(value.id, structuredClone(value)); return requestResult(undefined); },
              get: (id) => requestResult(records.get(id)),
            }),
          }),
        };
        request.result = database;
        request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  };
}

function fakeCrypto(calls) {
  const privateKey = { type: 'private', extractable: false, algorithm: { name: 'ECDSA', namedCurve: 'P-256' } };
  const publicKey = { type: 'public', extractable: true, algorithm: { name: 'ECDSA', namedCurve: 'P-256' } };
  return {
    subtle: {
      async generateKey(algorithm, extractable, usages) {
        calls.push({ method: 'generateKey', algorithm, extractable, usages });
        return { privateKey: { ...privateKey, extractable }, publicKey };
      },
      async exportKey(format, key) {
        calls.push({ method: 'exportKey', format, key });
        return key.type === 'public'
          ? { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' }
          : { kty: 'EC', crv: 'P-256', d: 'private', x: 'x', y: 'y' };
      },
      async importKey(format, key, algorithm, extractable, usages) {
        calls.push({ method: 'importKey', format, key, algorithm, extractable, usages });
        return { ...privateKey, extractable, usages };
      },
      async sign(algorithm, key, data) {
        calls.push({ method: 'sign', algorithm, key, data: new Uint8Array(data) });
        return new Uint8Array([1, 2, 3]).buffer;
      },
      async verify(algorithm, key, signature, data) {
        calls.push({ method: 'verify', algorithm, key, signature, data: new Uint8Array(data) });
        return true;
      },
    },
  };
}

test('remote entry auto-pairs without asking for a device name or exposing local administration controls', async () => {
  const [html, js, css] = await Promise.all([
    readFile(new URL('remote-entry.html', publicDir), 'utf8'),
    readFile(new URL('remote-entry.js', publicDir), 'utf8'),
    readFile(new URL('remote-entry.css', publicDir), 'utf8'),
  ]);
  assert.match(html, /Remote access is locked/);
  assert.match(html, /This browser is not paired/);
  assert.doesNotMatch(html, /device-name|pair-form|Pair this device/);
  assert.doesNotMatch(html, /entry-message|id="connecting"/);
  assert.doesNotMatch(html, /cloudflare|quick tunnel|remote modal|tauri/i);
  assert.match(js, /history\.replaceState/);
  assert.match(css, /\.entry-card\s*\{[^}]*border:\s*0;/s);
  assert.match(css, /prefers-reduced-motion/);
});

test('creates a P-256 credential with a non-extractable stored private key and signs after an IndexedDB round trip', async () => {
  const calls = [];
  const indexedDB = fakeIndexedDb();
  const credential = await createPersistedCredential({
    crypto: fakeCrypto(calls),
    indexedDB,
  });
  assert.deepEqual(credential.publicKeyJwk, { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' });
  assert.equal(credential.privateKey.extractable, false);
  assert.ok(calls.some((call) => call.method === 'generateKey' && call.algorithm.name === 'ECDSA' && call.algorithm.namedCurve === 'P-256' && call.extractable === false));
  assert.ok(calls.some((call) => call.method === 'sign' && call.key.extractable === false));
  assert.ok(calls.some((call) => call.method === 'verify'));
  const restored = await restoreCredential({ indexedDB });
  assert.equal(restored.privateKey.extractable, false);
  const reused = await getOrCreatePersistedCredential({ crypto: fakeCrypto(calls), indexedDB });
  assert.equal(reused.privateKey.extractable, false);
  assert.equal(calls.filter((call) => call.method === 'generateKey').length, 1);
});

test('uses canonical base64url and exact challenge payloads', () => {
  assert.equal(base64url(new Uint8Array([255, 239, 191])), '_--_');
  assert.equal(
    new TextDecoder().decode(challengePayload({ challengeId: 'id', challenge: 'nonce' }, 'https://term.example.test')),
    'agent-remote:v1:id:nonce:https://term.example.test',
  );
});

test('infers stable browser device names for automatic pairing', () => {
  assert.equal(inferBrowserDeviceName({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/18.6 Mobile/15E148 Safari/604.1',
    platform: 'iPhone',
  }), 'iPhone · Safari');
  assert.equal(inferBrowserDeviceName({ userAgent: '', platform: '' }), 'Paired device');
});

test('removes the pairing fragment before the pair request and recognises missing or expired pairing links', () => {
  const historyCalls = [];
  const location = { href: 'https://term.example.test/pair#secret', pathname: '/pair', search: '' };
  const history = { replaceState: (...args) => historyCalls.push(args) };
  assert.equal(extractPairingSecret({ location, history }), 'secret');
  assert.deepEqual(historyCalls, [[null, '', '/pair']]);
  assert.equal(extractPairingSecret({ location: { href: 'https://term.example.test/pair', pathname: '/pair', search: '' }, history }), undefined);
  assert.equal(extractPairingSecret({ location: { href: 'https://term.example.test/pair#bad secret', pathname: '/pair', search: '' }, history }), undefined);
});

test('pairs only after the credential is ready, silently signs a returning challenge, and logs out', async () => {
  const requests = [];
  const location = { replace: (path) => requests.push({ redirect: path }) };
  const indexedDB = fakeIndexedDb();
  const credential = {
    id: 'current', deviceId: undefined, privateKey: { extractable: false }, publicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
  };
  const fetchFn = async (path, options) => {
    requests.push({ path, options });
    if (path === '/remote-auth/pair') return { ok: true, json: async () => ({ device: { id: 'device-1' } }) };
    if (path === '/remote-auth/challenge') return { ok: true, json: async () => ({ challengeId: 'challenge-id', challenge: 'challenge-value' }) };
    if (path === '/remote-auth/verify') return { ok: true, json: async () => ({ authenticated: true }) };
    if (path === '/remote-auth/session') return { ok: true, json: async () => ({ authenticated: false }) };
    throw new Error(`Unexpected path: ${path}`);
  };
  await pairDevice({ secret: 'secret', deviceName: 'Test device', credential, fetchFn, location, indexedDB });
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    secret: 'secret', deviceName: 'Test device', publicKeyJwk: credential.publicKeyJwk,
  });
  assert.equal(requests[1].redirect, '/');

  const calls = [];
  await reauthenticateDevice({
    credential: { ...credential, deviceId: 'device-1' },
    crypto: fakeCrypto(calls), fetchFn, origin: 'https://term.example.test',
  });
  const verify = requests.findLast((request) => request.path === '/remote-auth/verify');
  const signed = calls.find((call) => call.method === 'sign');
  assert.equal(new TextDecoder().decode(signed.data), 'agent-remote:v1:challenge-id:challenge-value:https://term.example.test');
  assert.equal(JSON.parse(verify.options.body).signature, 'AQID');
  assert.deepEqual(await logout({ fetchFn }), { authenticated: false });
  assert.equal(requests.at(-1).options.method, 'DELETE');
});

test('gateway statically whitelists only the entry assets before remote authentication', async () => {
  const gateway = await readFile(fileURLToPath(new URL('../src/remote/gateway.js', import.meta.url)), 'utf8');
  assert.match(gateway, /remote-entry\.html/);
  assert.match(gateway, /remote-entry\.js/);
  assert.match(gateway, /remote-entry\.css/);
  assert.match(gateway, /pathname\.startsWith\('\/remote-auth\/'\)/);
  assert.doesNotMatch(gateway, /entryHtml\s*=/);
});

test('gateway serves the three entry assets before authentication and forwards an authenticated root request', async () => {
  const gateway = createRemoteGateway({
    auth: { authenticate: (request) => request.headers.cookie === 'session' ? { deviceId: 'device-1' } : undefined },
    getPublicUrl: () => 'https://term.example.test',
  });
  const request = (url, cookie) => ({
    method: 'GET', url, headers: { host: 'term.example.test', origin: 'https://term.example.test', ...(cookie ? { cookie } : {}) },
  });
  const fetchGateway = async (url, cookie) => {
    const result = {};
    await gateway.handleRequest(request(url, cookie), {
      writeHead: (status, headers) => { result.status = status; result.headers = headers; },
      end: (body) => { result.body = body?.toString(); },
    }, async (_request, response, surface) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end(`workspace:${surface}`);
    });
    return result;
  };
  const [entry, pair, script, styles, application] = await Promise.all([
    fetchGateway('/'), fetchGateway('/pair'), fetchGateway('/remote-entry.js'), fetchGateway('/remote-entry.css'), fetchGateway('/app.js'),
  ]);
  assert.match(entry.body, /Remote access is locked/);
  assert.match(pair.body, /Remote access is locked/);
  assert.match(script.headers['content-type'], /^text\/javascript/);
  assert.match(styles.headers['content-type'], /^text\/css/);
  assert.equal(application.status, 401);
  const authenticatedRoot = await fetchGateway('/', 'session');
  assert.equal(authenticatedRoot.body, 'workspace:remote');
});
