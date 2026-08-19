#!/usr/bin/env node
// Dedicated E2E server: no Keychain, cloudflared executable, or Cloudflare
// network traffic is involved.  It deliberately exposes the remote listener
// directly on loopback, with the production HTTPS/cookie invariants relaxed
// only through createTerminalServer's programmatic test seams.
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { createTerminalServer } from '../../src/server.js';

const root = resolve('test-results/remote-playwright');
const databaseFile = resolve(root, 'agent-remote.db');
const localUrl = 'http://127.0.0.1:3100';
const publicUrl = 'http://127.0.0.1:3101';
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });

let now = 1_800_000_000_000;
let current = { mode: 'none', state: 'stopped' };
let token;
let app;

const tokenStore = {
  async has() { return Boolean(token); },
  async read() { return token; },
  async write(value) { token = value; },
  async remove() { token = undefined; return true; },
};

const zones = [{ id: 'zone-fixture', name: 'example.test', account: { id: 'account-fixture' } }];

const tunnelManager = {
  status: () => ({ ...current }),
  async startQuick() {
    current = { mode: 'quick', state: 'running', publicUrl };
    return { ...current };
  },
  async startNamed({ hostname }) {
    app.remoteStore.setDesiredState('running');
    current = { mode: 'named', state: 'running', hostname, publicUrl: `http://${hostname}` };
    return { ...current };
  },
  async stop() {
    if (current.mode === 'named') app.remoteStore.setDesiredState('stopped');
    current = { mode: 'none', state: 'stopped' };
    return { ...current };
  },
  async close() { current = { mode: 'none', state: 'stopped' }; },
};

function assertFixtureToken() {
  if (token !== 'fixture-token') {
    const error = new Error('Cloudflare rejected the token');
    error.code = 'TOKEN_INVALID';
    error.status = 401;
    throw error;
  }
}

const provisioner = {
  async validateToken(value) {
    if (value !== 'fixture-token') throw Object.assign(new Error('Cloudflare rejected the token'), { code: 'TOKEN_INVALID', status: 401 });
    return zones;
  },
  async listZones() { assertFixtureToken(); return zones; },
  async checkAvailability(zoneId, subdomain) {
    assertFixtureToken();
    if (zoneId !== zones[0].id) throw Object.assign(new Error('The selected Cloudflare zone is unavailable.'), { code: 'ZONE_FORBIDDEN', status: 403 });
    const hostname = `${subdomain}.example.test`;
    if (subdomain === 'taken') return { hostname, status: 'conflict', suggestions: ['taken-2', 'taken-3'] };
    const settings = app.remoteStore.getSettings();
    if (settings.hostname === hostname) return { hostname, status: 'reusable', suggestions: [] };
    return { hostname, status: 'available', suggestions: [] };
  },
  async prepareNamed({ zoneId, subdomain }) {
    const availability = await this.checkAvailability(zoneId, subdomain);
    if (availability.status === 'conflict') throw Object.assign(new Error('That hostname is already in use.'), { code: 'HOSTNAME_CONFLICT', status: 409 });
    const hostname = availability.hostname;
    app.remoteStore.saveNamedTunnel({
      accountId: 'account-fixture', zoneId, zoneName: 'example.test', hostname,
      tunnelId: 'tunnel-fixture', tunnelName: 'agent-remote-fixture',
      dnsRecordId: 'dns-fixture', dnsTarget: 'tunnel-fixture.cfargotunnel.com',
    });
    return { hostname, tunnelToken: 'fixture-named-tunnel-token', record: { id: 'dns-fixture' } };
  },
  async removeNamed() {
    const settings = app.remoteStore.getSettings();
    if (settings.hostname === 'warn.example.test') {
      return { removed: false, warnings: ['DNS changed outside agent-remote; it was left untouched.'] };
    }
    app.remoteStore.clearNamedTunnel();
    return { removed: true, warnings: [] };
  },
};

app = createTerminalServer({
  host: '127.0.0.1', port: 3100, remoteHost: '127.0.0.1', remotePort: 3101,
  shell: '/bin/sh', shellArgs: [], tmuxSession: '', tmuxShell: false,
  databaseFile,
  remotePlatform: 'darwin', remoteTokenStore: tokenStore, remoteProvisioner: provisioner,
  tunnelManager, remotePublicUrl: publicUrl,
  remoteSecureCookies: false, remoteAllowInsecurePublicOrigin: true,
  remoteAuthNow: () => now,
  remoteInspectCloudflared: async () => ({ available: true, version: '2026.8.2', source: 'fixture' }),
  remoteToDataURL: async () => 'data:image/png;base64,iVBORw0KGgo=',
});

// Clock control is intentionally local-only and exists solely for expiry
// tests. It is installed before the normal handler so no production route is
// added to src/server.js.
app.server.prependListener('request', (request, response) => {
  const url = new URL(request.url, localUrl);
  if (!url.pathname.startsWith('/__remote-e2e/')) return;
  if (url.pathname === '/__remote-e2e/clock' && request.method === 'POST') {
    now += Number(url.searchParams.get('advanceMs') || 0);
  }
});

await app.listen();
console.log(JSON.stringify({ type: 'ready', localUrl, remoteUrl: publicUrl }));

async function shutdown() {
  await app.close().catch(() => {});
  process.exit(0);
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
