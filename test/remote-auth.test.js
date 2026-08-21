import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRemoteAuth } from '../src/remote/auth.js';
import { createRemoteStore } from '../src/remote/store.js';

function temporaryStore() {
  const root = mkdtempSync(join(tmpdir(), 'agent-remote-auth-'));
  return { root, store: createRemoteStore(join(root, '.agent-remote', 'agent-remote.db')) };
}

function deterministicBytes() {
  let value = 0;
  return (size) => Buffer.from(Array.from({ length: size }, () => value++ & 0xff));
}

async function publicKey() {
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return {
    pair,
    jwk: await webcrypto.subtle.exportKey('jwk', pair.publicKey),
  };
}

function secretFromPairUrl(pairUrl) {
  return new URL(pairUrl).hash.slice(1);
}

test('pairing hashes secrets, replaces previous sessions, expires them, and consumes a session once', async () => {
  const { root, store } = temporaryStore();
  let time = 1_000;
  const digestInputs = [];
  const subtle = {
    ...webcrypto.subtle,
    digest: async (algorithm, value) => {
      digestInputs.push(Buffer.from(value));
      return webcrypto.subtle.digest(algorithm, value);
    },
  };
  try {
    const auth = createRemoteAuth({ store, now: () => time, randomBytes: deterministicBytes(), subtle });
    const first = await auth.createPairing('https://term.example.test');
    const second = await auth.createPairing('https://term.example.test');
    assert.equal(first.expiresAt, 121_000);
    assert.match(first.pairUrl, /^https:\/\/term\.example\.test\/pair#[A-Za-z0-9_-]+$/);
    assert.deepEqual(digestInputs[0], Buffer.from(secretFromPairUrl(first.pairUrl), 'base64url'));
    assert.equal(digestInputs[0].length, 32);
    const { jwk } = await publicKey();
    await assert.rejects(
      auth.pair({ secret: secretFromPairUrl(first.pairUrl), deviceName: 'Phone', publicKeyJwk: jwk }),
      (error) => error.code === 'PAIRING_EXPIRED',
    );
    const paired = await auth.pair({ secret: secretFromPairUrl(second.pairUrl), deviceName: 'Phone', publicKeyJwk: jwk });
    assert.equal(paired.authenticated, true);
    assert.ok(digestInputs.some((value) => value.equals(Buffer.from(secretFromPairUrl(second.pairUrl), 'base64url'))));
    await assert.rejects(
      auth.pair({ secret: secretFromPairUrl(second.pairUrl), deviceName: 'Phone', publicKeyJwk: jwk }),
      (error) => error.code === 'PAIRING_EXPIRED',
    );
    const expired = await auth.createPairing('https://term.example.test');
    time = expired.expiresAt;
    await assert.rejects(
      auth.pair({ secret: secretFromPairUrl(expired.pairUrl), deviceName: 'Phone', publicKeyJwk: jwk }),
      (error) => error.code === 'PAIRING_EXPIRED',
    );
    auth.close();
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('pairing validates canonical P-256 public keys and updates a repeated fingerprint in place', async () => {
  const { root, store } = temporaryStore();
  let time = 10_000;
  try {
    const auth = createRemoteAuth({ store, now: () => time, randomBytes: deterministicBytes() });
    const { jwk } = await publicKey();
    const pair = async (publicKeyJwk, deviceName = '  My\u0000 Phone  ') => {
      const session = await auth.createPairing('https://term.example.test');
      return auth.pair({ secret: secretFromPairUrl(session.pairUrl), deviceName, publicKeyJwk });
    };
    await assert.rejects(pair({ ...jwk, crv: 'P-384' }), /P-256/);
    await assert.rejects(pair({ ...jwk, x: 'not-a-coordinate' }), /32 bytes/);
    await assert.rejects(pair(jwk, 'x'.repeat(81)), /80 characters/);
    const first = await pair(jwk);
    assert.equal(first.device.name, 'My Phone');
    time = 20_000;
    const repeated = await pair(jwk, 'iPhone · Safari');
    assert.equal(repeated.device.id, first.device.id);
    assert.equal(repeated.device.name, 'iPhone · Safari');
    assert.equal(repeated.device.lastUsedAt, 20_000);
    assert.equal(store.listDevices().length, 1);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('pairing infers a useful device label when the browser does not submit one', async () => {
  const { root, store } = temporaryStore();
  try {
    const auth = createRemoteAuth({ store, randomBytes: deterministicBytes() });
    const { jwk } = await publicKey();
    const pairing = await auth.createPairing('https://term.example.test');
    const result = await auth.pair({
      secret: secretFromPairUrl(pairing.pairUrl),
      publicKeyJwk: jwk,
      request: { headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/18.6 Mobile/15E148 Safari/604.1' } },
    });
    assert.equal(result.device.name, 'iPhone · Safari');

    const nullNamePairing = await auth.createPairing('https://term.example.test');
    const nullNameResult = await auth.pair({
      secret: secretFromPairUrl(nullNamePairing.pairUrl),
      deviceName: null,
      publicKeyJwk: jwk,
      request: { headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/18.6 Mobile/15E148 Safari/604.1' } },
    });
    assert.equal(nullNameResult.device.name, 'iPhone · Safari');
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('challenges verify only the active P-256 device, expected origin, and single use', async () => {
  const { root, store } = temporaryStore();
  let time = 4_000;
  try {
    const auth = createRemoteAuth({ store, now: () => time, randomBytes: deterministicBytes() });
    const { pair, jwk } = await publicKey();
    const pairing = await auth.createPairing('https://term.example.test');
    const device = await auth.pair({ secret: secretFromPairUrl(pairing.pairUrl), deviceName: 'Laptop', publicKeyJwk: jwk });
    const challenge = await auth.createChallenge(device.device.id);
    assert.equal(challenge.expiresAt, 64_000);
    const signed = new TextEncoder().encode(`agent-remote:v1:${challenge.challengeId}:${challenge.challenge}:https://term.example.test`);
    const signature = Buffer.from(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, signed)).toString('base64url');
    await assert.rejects(
      auth.verifyChallenge({ deviceId: device.device.id, challengeId: challenge.challengeId, signature, origin: 'https://wrong.example.test' }),
      (error) => error.code === 'REMOTE_UNAUTHORIZED',
    );
    const validChallenge = await auth.createChallenge(device.device.id);
    const validSigned = new TextEncoder().encode(`agent-remote:v1:${validChallenge.challengeId}:${validChallenge.challenge}:https://term.example.test`);
    const validSignature = Buffer.from(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, validSigned)).toString('base64url');
    const verified = await auth.verifyChallenge({ deviceId: device.device.id, challengeId: validChallenge.challengeId, signature: validSignature, origin: 'https://term.example.test' });
    assert.equal(verified.authenticated, true);
    assert.equal(store.getActiveDevice(device.device.id).lastUsedAt, time);
    await assert.rejects(
      auth.verifyChallenge({ deviceId: device.device.id, challengeId: validChallenge.challengeId, signature: validSignature, origin: 'https://term.example.test' }),
      (error) => error.code === 'REMOTE_UNAUTHORIZED',
    );
    const expired = await auth.createChallenge(device.device.id);
    time = expired.expiresAt;
    await assert.rejects(
      auth.verifyChallenge({ deviceId: device.device.id, challengeId: expired.challengeId, signature, origin: 'https://term.example.test' }),
      (error) => error.code === 'REMOTE_UNAUTHORIZED',
    );
    assert.equal(auth.revokeDevice(device.device.id), true);
    await assert.rejects(auth.createChallenge(device.device.id), (error) => error.code === 'DEVICE_REVOKED');
    auth.close();
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('sessions use a host cookie, expire, logout, and invalidate when a device is revoked', async () => {
  const { root, store } = temporaryStore();
  let time = 10_000;
  const revoked = [];
  try {
    const auth = createRemoteAuth({
      store, now: () => time, randomBytes: deterministicBytes(), onRevoke: (deviceId) => revoked.push(deviceId),
    });
    const { jwk } = await publicKey();
    const pairing = await auth.createPairing('https://term.example.test');
    const paired = await auth.pair({ secret: secretFromPairUrl(pairing.pairUrl), deviceName: 'Laptop', publicKeyJwk: jwk });
    assert.match(paired.setCookie, /^__Host-agent_remote=[A-Za-z0-9_-]+; Max-Age=43200; Path=\/; HttpOnly; Secure; SameSite=Strict$/);
    assert.deepEqual(auth.authenticate({ headers: { cookie: paired.setCookie } }), {
      sessionId: paired.sessionId, deviceId: paired.device.id, expiresAt: 43_210_000,
    });
    time += 43_200_000;
    assert.equal(auth.authenticate({ headers: { cookie: paired.setCookie } }), undefined);
    time = 10_000;
    const { jwk: secondJwk } = await publicKey();
    const secondPairing = await auth.createPairing('https://term.example.test');
    const second = await auth.pair({ secret: secretFromPairUrl(secondPairing.pairUrl), deviceName: 'Tablet', publicKeyJwk: secondJwk });
    assert.equal(auth.logout(second.sessionId), true);
    assert.equal(auth.authenticate({ headers: { cookie: second.setCookie } }), undefined);
    const { jwk: thirdJwk } = await publicKey();
    const thirdPairing = await auth.createPairing('https://term.example.test');
    const third = await auth.pair({ secret: secretFromPairUrl(thirdPairing.pairUrl), deviceName: 'Desktop', publicKeyJwk: thirdJwk });
    assert.equal(auth.revokeDevice(third.device.id), true);
    assert.equal(auth.authenticate({ headers: { cookie: third.setCookie } }), undefined);
    assert.equal(store.listDevices().some((device) => device.id === third.device.id), false);
    assert.deepEqual(revoked, [third.device.id]);
    assert.match(auth.clearSessionCookie(), /Max-Age=0/);
    auth.close();
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('revokes every paired device in one batch and invalidates all sessions', async () => {
  const { root, store } = temporaryStore();
  const revoked = [];
  try {
    const auth = createRemoteAuth({
      store, randomBytes: deterministicBytes(), onRevoke: (deviceId) => revoked.push(deviceId),
    });
    const devices = [];
    for (const name of ['Phone', 'Tablet']) {
      const { jwk } = await publicKey();
      const pairing = await auth.createPairing('https://term.example.test');
      devices.push(await auth.pair({ secret: secretFromPairUrl(pairing.pairUrl), deviceName: name, publicKeyJwk: jwk }));
    }
    assert.equal(auth.revokeAllDevices(), 2);
    assert.deepEqual(store.listDevices(), []);
    for (const device of devices) assert.equal(auth.authenticate({ headers: { cookie: device.setCookie } }), undefined);
    assert.deepEqual(new Set(revoked), new Set(devices.map(({ device }) => device.id)));
    assert.equal(auth.revokeAllDevices(), 0);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('revoke and clear operations invalidate a pending pairing even when no device rows exist', async () => {
  const { root, store } = temporaryStore();
  try {
    const auth = createRemoteAuth({ store, randomBytes: deterministicBytes() });
    const { jwk } = await publicKey();

    const cleared = await auth.createPairing('https://term.example.test');
    assert.equal(auth.revokeAllDevices(), 0);
    await assert.rejects(
      auth.pair({ secret: secretFromPairUrl(cleared.pairUrl), publicKeyJwk: jwk }),
      (error) => error.code === 'PAIRING_EXPIRED',
    );

    const revoked = await auth.createPairing('https://term.example.test');
    assert.equal(auth.revokeDevice('missing-device'), false);
    await assert.rejects(
      auth.pair({ secret: secretFromPairUrl(revoked.pairUrl), publicKeyJwk: jwk }),
      (error) => error.code === 'PAIRING_EXPIRED',
    );

    const cancelled = await auth.createPairing('https://term.example.test');
    assert.equal(auth.cancelPairing(), true);
    assert.equal(auth.cancelPairing(), false);
    await assert.rejects(
      auth.pair({ secret: secretFromPairUrl(cancelled.pairUrl), publicKeyJwk: jwk }),
      (error) => error.code === 'PAIRING_EXPIRED',
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('authentication attempts are capped globally and per client in fixed one-minute windows', async () => {
  const { root, store } = temporaryStore();
  let time = 0;
  try {
    const auth = createRemoteAuth({ store, now: () => time, randomBytes: deterministicBytes() });
    for (let attempt = 0; attempt < 20; attempt += 1) auth.assertRateLimit('client-a');
    assert.throws(() => auth.assertRateLimit('client-a'), (error) => error.status === 429);
    for (let attempt = 0; attempt < 80; attempt += 1) auth.assertRateLimit(`client-${attempt}`);
    assert.throws(() => auth.assertRateLimit('client-last'), (error) => error.status === 429);
    time = 60_000;
    assert.doesNotThrow(() => auth.assertRateLimit('client-a'));
    auth.close();
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
