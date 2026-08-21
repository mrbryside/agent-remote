import assert from 'node:assert/strict';
import test from 'node:test';

import { createRemoteProvisioner, validateSubdomain } from '../src/remote/provisioner.js';

const zone = { id: 'zone-1', name: 'example.com', account: { id: 'account-1' } };

function namedSettings(overrides = {}) {
  return {
    installationId: '12345678-1234-1234-1234-123456789abc',
    accountId: null,
    zoneId: null,
    zoneName: null,
    hostname: null,
    tunnelId: null,
    tunnelName: null,
    dnsRecordId: null,
    dnsTarget: null,
    desiredState: 'stopped',
    ...overrides,
  };
}

function fakeStore(initial = namedSettings()) {
  let settings = { ...initial };
  const saves = [];
  let clears = 0;
  return {
    saves,
    get clears() { return clears; },
    getSettings: () => ({ ...settings }),
    saveNamedTunnel: (input) => {
      saves.push(input);
      settings = { ...settings, ...input };
      return { ...settings };
    },
    clearNamedTunnel: () => {
      clears += 1;
      settings = namedSettings({ installationId: settings.installationId });
    },
  };
}

function fakeClient(overrides = {}) {
  const calls = [];
  const client = {
    verifyToken: async () => { calls.push('verifyToken'); },
    listZones: async () => { calls.push('listZones'); return [zone]; },
    checkHostname: async (_zoneId, hostname) => { calls.push(`check:${hostname}`); return { hostname, records: [] }; },
    getTunnel: async (_accountId, tunnelId) => { calls.push(`getTunnel:${tunnelId}`); return { id: tunnelId, name: 'agent-remote-12345678-123' }; },
    configureTunnel: async (_accountId, tunnelId) => { calls.push(`configure:${tunnelId}`); },
    createTunnel: async (_accountId, name) => { calls.push(`createTunnel:${name}`); return { id: 'tunnel-1', name }; },
    createDnsRoute: async (_zoneId, hostname, tunnelId) => {
      calls.push(`createDns:${hostname}`);
      return { id: 'dns-1', name: hostname, type: 'CNAME', content: `${tunnelId}.cfargotunnel.com` };
    },
    getTunnelToken: async (_accountId, tunnelId) => { calls.push(`token:${tunnelId}`); return 'run-token'; },
    getDnsRecord: async (_zoneId, recordId) => { calls.push(`getDns:${recordId}`); return undefined; },
    cleanupTunnelConnections: async (_accountId, tunnelId) => { calls.push(`cleanupTunnel:${tunnelId}`); },
    deleteDnsRoute: async (_zoneId, recordId) => { calls.push(`deleteDns:${recordId}`); },
    deleteTunnel: async (_accountId, tunnelId) => { calls.push(`deleteTunnel:${tunnelId}`); },
    ...overrides,
  };
  return { client, calls };
}

function provisioner({ store = fakeStore(), client = fakeClient().client, ...dependencies } = {}) {
  return createRemoteProvisioner({
    store,
    tokenStore: { read: async () => 'keychain-token' },
    createClient: ({ token }) => {
      assert.equal(token, 'keychain-token');
      return client;
    },
    remoteOrigin: 'http://127.0.0.1:3001',
    ...dependencies,
  });
}

test('validates one lowercase ASCII DNS label and canonicalizes hostnames', async () => {
  for (const label of ['remote', 'r2', 'a-b', 'a'.repeat(63)]) {
    assert.equal(validateSubdomain(label), label);
  }
  for (const label of ['', '@', 'remote.example.com', '_remote', '-remote', 'remote-', 'REMOTE', 'a'.repeat(64)]) {
    assert.throws(() => validateSubdomain(label), /subdomain/i);
  }

  const result = await provisioner().checkAvailability('zone-1', 'remote');
  assert.deepEqual(result, { hostname: 'remote.example.com', status: 'available', suggestions: [] });
});

test('validates a candidate Cloudflare token directly without reading the Keychain', async () => {
  const { client, calls } = fakeClient();
  const createdWith = [];
  const subject = createRemoteProvisioner({
    store: fakeStore(),
    tokenStore: { read: async () => { throw new Error('Keychain must not be read'); } },
    createClient: ({ token }) => {
      createdWith.push(token);
      return client;
    },
    remoteOrigin: 'http://127.0.0.1:3001',
  });

  assert.deepEqual(await subject.validateToken('  candidate-token  '), [zone]);
  assert.deepEqual(createdWith, ['candidate-token']);
  assert.deepEqual(calls, ['verifyToken', 'listZones']);
});

test('reports an exact, locally owned DNS and tunnel as reusable', async () => {
  const store = fakeStore(namedSettings({
    accountId: 'account-1', zoneId: 'zone-1', zoneName: 'example.com', hostname: 'remote.example.com',
    tunnelId: 'tunnel-1', tunnelName: 'agent-remote-12345678-123', dnsRecordId: 'dns-1',
    dnsTarget: 'tunnel-1.cfargotunnel.com',
  }));
  const { client } = fakeClient({
    checkHostname: async () => ({ hostname: 'remote.example.com', records: [
      { id: 'dns-1', name: 'remote.example.com', type: 'CNAME', content: 'tunnel-1.cfargotunnel.com' },
    ] }),
  });

  const result = await provisioner({ store, client }).checkAvailability('zone-1', 'remote');
  assert.equal(result.status, 'reusable');
});

test('never treats a record as owned without matching local metadata and offers bounded suggestions', async () => {
  const { client, calls } = fakeClient({
    checkHostname: async (_zoneId, hostname) => {
      calls.push(`check:${hostname}`);
      return { hostname, records: hostname === 'remote.example.com' ? [{ id: 'foreign', type: 'A', name: hostname }] : [] };
    },
  });
  const result = await provisioner({ client }).checkAvailability('zone-1', 'remote');

  assert.equal(result.status, 'conflict');
  assert.deepEqual(result.suggestions, ['remote-2', 'remote-3', 'remote-4', 'remote-5']);
  assert.deepEqual(calls.filter((call) => call.startsWith('check:')), [
    'check:remote.example.com', 'check:remote-2.example.com', 'check:remote-3.example.com',
    'check:remote-4.example.com', 'check:remote-5.example.com',
  ]);
});

test('prepares a named tunnel in Cloudflare order and retains partial metadata for retry', async () => {
  const store = fakeStore();
  const { client, calls } = fakeClient();
  const result = await provisioner({ store, client }).prepareNamed({ zoneId: 'zone-1', subdomain: 'remote' });

  assert.deepEqual(result, {
    hostname: 'remote.example.com', tunnelToken: 'run-token',
    record: { id: 'dns-1', name: 'remote.example.com', type: 'CNAME', content: 'tunnel-1.cfargotunnel.com' },
  });
  assert.deepEqual(calls.slice(0, 7), [
    'verifyToken', 'listZones', 'check:remote.example.com', 'createTunnel:agent-remote-12345678-123',
    'configure:tunnel-1', 'createDns:remote.example.com', 'token:tunnel-1',
  ]);
  assert.equal(store.saves.length, 2);
  assert.deepEqual(store.saves[0], {
    accountId: 'account-1', zoneId: 'zone-1', zoneName: 'example.com', hostname: 'remote.example.com',
    tunnelId: 'tunnel-1', tunnelName: 'agent-remote-12345678-123', dnsRecordId: null, dnsTarget: null,
  });
});

test('keeps DNS ownership metadata when tunnel-token retrieval fails, allowing a safe retry', async () => {
  const store = fakeStore();
  const { client } = fakeClient();
  let dnsCreated = false;
  let tokenAttempts = 0;
  client.checkHostname = async (_zoneId, hostname) => ({
    hostname,
    records: dnsCreated ? [{
      id: 'dns-1', name: hostname, type: 'CNAME', content: 'tunnel-1.cfargotunnel.com',
    }] : [],
  });
  client.createDnsRoute = async (_zoneId, hostname, tunnelId) => {
    dnsCreated = true;
    return { id: 'dns-1', name: hostname, type: 'CNAME', content: `${tunnelId}.cfargotunnel.com` };
  };
  client.getTunnelToken = async () => {
    tokenAttempts += 1;
    if (tokenAttempts === 1) throw new Error('temporary Cloudflare failure');
    return 'run-token';
  };

  const subject = provisioner({ store, client });
  await assert.rejects(subject.prepareNamed({ zoneId: 'zone-1', subdomain: 'remote' }), /temporary Cloudflare failure/);
  assert.equal(store.getSettings().dnsRecordId, 'dns-1');

  const retry = await subject.prepareNamed({ zoneId: 'zone-1', subdomain: 'remote' });
  assert.equal(retry.tunnelToken, 'run-token');
});

test('removes only exact owned resources and keeps metadata when DNS changed externally', async () => {
  const settings = namedSettings({
    accountId: 'account-1', zoneId: 'zone-1', zoneName: 'example.com', hostname: 'remote.example.com',
    tunnelId: 'tunnel-1', tunnelName: 'agent-remote-12345678-123', dnsRecordId: 'dns-1',
    dnsTarget: 'tunnel-1.cfargotunnel.com',
  });
  const store = fakeStore(settings);
  const { client, calls } = fakeClient({
    getDnsRecord: async () => ({ id: 'dns-1', name: 'remote.example.com', type: 'CNAME', content: 'elsewhere.example' }),
  });

  const result = await provisioner({ store, client }).removeNamed();
  assert.equal(result.removed, false);
  assert.match(result.warnings[0], /DNS/i);
  assert.equal(calls.some((call) => call.startsWith('delete')), false);
  assert.equal(store.clears, 0);
});

test('clears only named settings after exact owned Cloudflare removal', async () => {
  const settings = namedSettings({
    accountId: 'account-1', zoneId: 'zone-1', zoneName: 'example.com', hostname: 'remote.example.com',
    tunnelId: 'tunnel-1', tunnelName: 'agent-remote-12345678-123', dnsRecordId: 'dns-1',
    dnsTarget: 'tunnel-1.cfargotunnel.com', desiredState: 'running',
  });
  const store = fakeStore(settings);
  const { client, calls } = fakeClient({
    getDnsRecord: async () => ({ id: 'dns-1', name: 'remote.example.com', type: 'CNAME', content: 'tunnel-1.cfargotunnel.com' }),
  });

  const result = await provisioner({ store, client }).removeNamed();
  assert.deepEqual(result, { removed: true, warnings: [] });
  assert.deepEqual(calls.filter((call) => /^(cleanup|delete)/.test(call)), [
    'cleanupTunnel:tunnel-1', 'deleteDns:dns-1', 'deleteTunnel:tunnel-1',
  ]);
  assert.equal(store.clears, 1);
});

test('cleans stale connectors and retries an active tunnel deletion before clearing metadata', async () => {
  const settings = namedSettings({
    accountId: 'account-1', zoneId: 'zone-1', zoneName: 'example.com', hostname: 'remote.example.com',
    tunnelId: 'tunnel-1', tunnelName: 'agent-remote-12345678-123', dnsRecordId: 'dns-1',
    dnsTarget: 'tunnel-1.cfargotunnel.com', desiredState: 'running',
  });
  const store = fakeStore(settings);
  const waits = [];
  let deleteAttempts = 0;
  const { client, calls } = fakeClient({
    getDnsRecord: async () => ({ id: 'dns-1', name: 'remote.example.com', type: 'CNAME', content: 'tunnel-1.cfargotunnel.com' }),
    deleteTunnel: async (_accountId, tunnelId) => {
      calls.push(`deleteTunnel:${tunnelId}`);
      deleteAttempts += 1;
      if (deleteAttempts < 3) {
        throw Object.assign(new Error('connector still active'), {
          code: 'CLOUDFLARE_API_ERROR', status: 409, operation: 'delete tunnel',
        });
      }
    },
  });

  const result = await provisioner({
    store,
    client,
    wait: async (milliseconds) => { waits.push(milliseconds); },
    tunnelDeleteRetryDelaysMs: [25, 50, 100],
  }).removeNamed();

  assert.deepEqual(result, { removed: true, warnings: [] });
  assert.deepEqual(waits, [25, 50]);
  assert.deepEqual(calls.filter((call) => /^(cleanup|delete)/.test(call)), [
    'cleanupTunnel:tunnel-1', 'deleteDns:dns-1', 'deleteTunnel:tunnel-1',
    'cleanupTunnel:tunnel-1', 'deleteTunnel:tunnel-1',
    'cleanupTunnel:tunnel-1', 'deleteTunnel:tunnel-1',
  ]);
  assert.equal(store.clears, 1);
});

test('preserves local ownership metadata if named removal only partially succeeds', async () => {
  const settings = namedSettings({
    accountId: 'account-1', zoneId: 'zone-1', zoneName: 'example.com', hostname: 'remote.example.com',
    tunnelId: 'tunnel-1', tunnelName: 'agent-remote-12345678-123', dnsRecordId: 'dns-1',
    dnsTarget: 'tunnel-1.cfargotunnel.com',
  });
  const store = fakeStore(settings);
  const { client } = fakeClient({
    getDnsRecord: async () => ({ id: 'dns-1', name: 'remote.example.com', type: 'CNAME', content: 'tunnel-1.cfargotunnel.com' }),
    deleteTunnel: async () => { throw new Error('Cloudflare unavailable'); },
  });

  await assert.rejects(provisioner({ store, client }).removeNamed(), /Cloudflare unavailable/);
  assert.equal(store.clears, 0);
  assert.equal(store.getSettings().tunnelId, 'tunnel-1');
});
