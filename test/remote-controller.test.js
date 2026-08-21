import assert from 'node:assert/strict';
import test from 'node:test';

import { createRemoteController } from '../src/remote/controller.js';

function tunnelStatus(overrides = {}) {
  return { mode: 'none', state: 'stopped', ...overrides };
}

function dependencies(overrides = {}) {
  let currentStatus = overrides.status ?? tunnelStatus();
  const calls = [];
  const tokenStore = {
    has: async () => false,
    write: async (token) => calls.push(`write:${token}`),
    remove: async () => { calls.push('remove'); return true; },
    ...overrides.tokenStore,
  };
  const provisioner = {
    validateToken: async () => [{ id: 'zone-1', name: 'example.com' }],
    listZones: async () => [{ id: 'zone-1', name: 'example.com' }],
    checkAvailability: async (zoneId, subdomain) => ({ hostname: `${subdomain}.example.com`, status: 'available', suggestions: [], zoneId }),
    prepareNamed: async ({ zoneId, subdomain }) => ({ hostname: `${subdomain}.example.com`, tunnelToken: `${zoneId}-token` }),
    removeNamed: async () => ({ removed: true, warnings: [] }),
    ...overrides.provisioner,
  };
  const tunnelManager = {
    status: () => ({ ...currentStatus }),
    startQuick: async () => {
      calls.push('quick');
      currentStatus = tunnelStatus({ mode: 'quick', state: 'running', publicUrl: 'https://quick.trycloudflare.com' });
      return { ...currentStatus };
    },
    startNamed: async ({ hostname, tunnelToken }) => {
      calls.push(`named:${hostname}:${tunnelToken}`);
      currentStatus = tunnelStatus({ mode: 'named', state: 'running', hostname, publicUrl: `https://${hostname}` });
      return { ...currentStatus };
    },
    stop: async () => {
      calls.push('stop');
      currentStatus = tunnelStatus();
      return { ...currentStatus };
    },
    ...overrides.tunnelManager,
  };
  const auth = {
    createPairing: async (publicUrl) => ({ pairUrl: `${publicUrl}/pair#super-secret`, expiresAt: 123_000 }),
    cancelPairing: () => calls.push('cancel-pairing'),
    ...overrides.auth,
  };
  const controller = createRemoteController({
    auth,
    provisioner,
    tokenStore,
    tunnelManager,
    inspectCloudflared: async () => ({ available: true, version: '2026.8.2', source: 'bundled' }),
    toDataURL: async (url, options) => {
      calls.push({ qr: { url, options } });
      return 'data:image/png;base64,cXI=';
    },
    platform: 'darwin',
    ...overrides.dependencies,
  });
  return { controller, calls, tokenStore, provisioner, tunnelManager, auth };
}

test('reports a redacted complete local Remote status when supported, unavailable, and unsupported', async () => {
  const supported = dependencies({
    tokenStore: { has: async () => true },
    status: tunnelStatus({ mode: 'named', state: 'running', hostname: 'term.example.com', publicUrl: 'https://term.example.com' }),
    dependencies: { getNamedSettings: () => ({
      zoneName: 'example.com', hostname: 'term.example.com', desiredState: 'running', tunnelToken: 'must-not-leak',
    }) },
  }).controller;
  assert.deepEqual(await supported.status(), {
    supported: true,
    cloudflared: { available: true, version: '2026.8.2', source: 'bundled' },
    tokenConfigured: true,
    tunnel: { mode: 'named', state: 'running', hostname: 'term.example.com', publicUrl: 'https://term.example.com' },
    named: { zoneName: 'example.com', hostname: 'term.example.com', desiredState: 'running' },
  });
  assert.deepEqual(supported.tunnelStatus(), {
    mode: 'named', state: 'running', hostname: 'term.example.com', publicUrl: 'https://term.example.com',
  });

  const missing = dependencies({
    dependencies: { inspectCloudflared: async () => ({
      available: false, source: 'path', error: { code: 'CLOUDFLARED_MISSING', message: 'cloudflared is not available.', token: 'must-not-leak' },
    }) },
  }).controller;
  assert.deepEqual(await missing.status(), {
    supported: true,
    cloudflared: { available: false, source: 'path', error: 'cloudflared is not available.' },
    tokenConfigured: false,
    tunnel: { mode: 'none', state: 'stopped' },
  });

  const unsupported = dependencies({ dependencies: { platform: 'linux' } }).controller;
  assert.deepEqual(await unsupported.status(), {
    supported: false,
    cloudflared: { available: false, error: 'Remote access is supported only on macOS.' },
    tokenConfigured: false,
    tunnel: { mode: 'none', state: 'stopped' },
  });
});

test('validates a token before writing it, lists zones, and removes it from Keychain', async () => {
  const { controller, calls } = dependencies();
  await assert.rejects(controller.setCloudflareToken('  '), (error) => error.code === 'TOKEN_INVALID');
  assert.deepEqual(calls, []);
  assert.deepEqual(await controller.setCloudflareToken('  api-token  '), {
    configured: true, zones: [{ id: 'zone-1', name: 'example.com' }],
  });
  assert.deepEqual(calls, ['write:api-token']);
  assert.deepEqual(await controller.listZones(), { zones: [{ id: 'zone-1', name: 'example.com' }] });
  assert.deepEqual(await controller.removeCloudflareToken(), { configured: false });
  assert.deepEqual(calls, ['write:api-token', 'remove']);
});

test('does not persist a candidate token when Cloudflare rejects it', async () => {
  const rejection = Object.assign(new Error('Cloudflare rejected the token'), { code: 'TOKEN_INVALID', status: 401 });
  const { controller, calls } = dependencies({
    provisioner: { validateToken: async () => { throw rejection; } },
  });
  await assert.rejects(controller.setCloudflareToken('invalid-remote-token'), (error) => error === rejection);
  assert.deepEqual(calls, []);
});

test('checks hostname availability and serializes idempotent Quick, named, Stop, and Remove operations', async () => {
  const { controller, calls } = dependencies();
  assert.deepEqual(await controller.checkHostnameAvailability({ zoneId: 'zone-1', subdomain: 'term' }), {
    hostname: 'term.example.com', status: 'available', suggestions: [], zoneId: 'zone-1',
  });

  const quickFirst = controller.startQuick();
  const quickSecond = controller.startQuick();
  assert.equal(quickFirst, quickSecond);
  assert.equal((await quickFirst).mode, 'quick');
  assert.deepEqual(calls, ['quick']);

  const namedFirst = controller.startNamed({ zoneId: 'zone-1', subdomain: 'term' });
  const namedSecond = controller.startNamed({ zoneId: 'zone-1', subdomain: 'term' });
  assert.equal(namedFirst, namedSecond);
  assert.equal((await namedFirst).hostname, 'term.example.com');
  assert.deepEqual(calls, ['quick', 'stop', 'named:term.example.com:zone-1-token']);
  assert.equal((await controller.startNamed({ zoneId: 'zone-1', subdomain: 'term' })).hostname, 'term.example.com');
  assert.deepEqual(calls, ['quick', 'stop', 'named:term.example.com:zone-1-token']);

  const stopped = await Promise.all([controller.stop(), controller.stop()]);
  assert.deepEqual(stopped, [tunnelStatus(), tunnelStatus()]);
  assert.deepEqual(calls, ['quick', 'stop', 'named:term.example.com:zone-1-token', 'cancel-pairing', 'stop']);

  await controller.stop();
  assert.deepEqual(calls, [
    'quick', 'stop', 'named:term.example.com:zone-1-token',
    'cancel-pairing', 'stop', 'cancel-pairing', 'stop',
  ]);

  assert.deepEqual(await controller.removeNamed(), { removed: true, warnings: [] });
  assert.deepEqual(calls, [
    'quick', 'stop', 'named:term.example.com:zone-1-token',
    'cancel-pairing', 'stop', 'cancel-pairing', 'stop',
  ]);
});

test('stops an owned tunnel before removal and preserves ownership warnings verbatim', async () => {
  const { controller, calls } = dependencies({
    tunnelManager: {
      status: () => tunnelStatus({ mode: 'named', state: 'running', hostname: 'term.example.com', publicUrl: 'https://term.example.com' }),
      stop: async () => { calls.push('stop'); return tunnelStatus(); },
    },
    provisioner: {
      removeNamed: async () => ({ removed: false, warnings: ['DNS changed outside agent-remote; it was left untouched.'] }),
    },
  });
  assert.deepEqual(await controller.removeNamed(), {
    removed: false,
    warnings: ['DNS changed outside agent-remote; it was left untouched.'],
  });
  assert.deepEqual(calls, ['stop']);
});

test('replaces an owned named hostname automatically after validating the new target', async () => {
  const events = [];
  let current = tunnelStatus({
    mode: 'named', state: 'running', hostname: 'old.example.com', publicUrl: 'https://old.example.com',
  });
  const { controller } = dependencies({
    dependencies: { getNamedSettings: () => ({
      zoneId: 'zone-1', zoneName: 'example.com', hostname: 'old.example.com', desiredState: 'running',
    }) },
    provisioner: {
      checkAvailability: async (zoneId, subdomain) => {
        events.push(`check:${zoneId}:${subdomain}`);
        return { hostname: 'new.example.com', status: 'available', suggestions: [] };
      },
      removeNamed: async () => { events.push('remove-old'); return { removed: true, warnings: [] }; },
      prepareNamed: async ({ zoneId, subdomain }) => {
        events.push(`prepare:${zoneId}:${subdomain}`);
        return { hostname: 'new.example.com', tunnelToken: 'replacement-token' };
      },
    },
    tunnelManager: {
      status: () => ({ ...current }),
      stop: async () => { events.push('stop-old'); current = tunnelStatus(); return { ...current }; },
      startNamed: async ({ hostname, tunnelToken }) => {
        events.push(`start:${hostname}:${tunnelToken}`);
        current = tunnelStatus({ mode: 'named', state: 'running', hostname, publicUrl: `https://${hostname}` });
        return { ...current };
      },
    },
  });

  assert.equal((await controller.startNamed({ zoneId: 'zone-1', subdomain: 'new' })).hostname, 'new.example.com');
  assert.deepEqual(events, [
    'check:zone-1:new', 'stop-old', 'remove-old', 'prepare:zone-1:new',
    'start:new.example.com:replacement-token',
  ]);
});

test('keeps the owned named hostname when the replacement target is unavailable', async () => {
  const events = [];
  const { controller } = dependencies({
    dependencies: { getNamedSettings: () => ({
      zoneId: 'zone-1', zoneName: 'example.com', hostname: 'old.example.com', desiredState: 'running',
    }) },
    status: tunnelStatus({
      mode: 'named', state: 'running', hostname: 'old.example.com', publicUrl: 'https://old.example.com',
    }),
    provisioner: {
      checkAvailability: async () => ({
        hostname: 'taken.example.com', status: 'conflict', suggestions: ['taken-2'],
      }),
      removeNamed: async () => { events.push('remove-old'); return { removed: true, warnings: [] }; },
      prepareNamed: async () => { events.push('prepare'); return {}; },
    },
    tunnelManager: {
      stop: async () => { events.push('stop-old'); return tunnelStatus(); },
    },
  });

  await assert.rejects(
    controller.startNamed({ zoneId: 'zone-1', subdomain: 'taken' }),
    (error) => error.code === 'HOSTNAME_CONFLICT' && error.status === 409,
  );
  assert.deepEqual(events, []);
});

test('creates a local pairing QR only for a running public tunnel and never exposes its fragment to logs', async () => {
  const { controller, calls } = dependencies();
  await assert.rejects(controller.createPairing(), /running public tunnel/i);
  await controller.startQuick();
  const pairing = await controller.createPairing();
  assert.deepEqual(pairing, {
    pairUrl: 'https://quick.trycloudflare.com/pair#super-secret',
    qrDataUrl: 'data:image/png;base64,cXI=',
    expiresAt: 123_000,
  });
  assert.deepEqual(calls.at(-1), {
    qr: {
      url: 'https://quick.trycloudflare.com/pair#super-secret',
      options: { errorCorrectionLevel: 'M', type: 'image/png' },
    },
  });
});
