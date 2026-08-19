import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createProjectStore } from '../src/projects.js';
import { createRemoteStore } from '../src/remote/store.js';

function temporaryDatabase() {
  const root = mkdtempSync(join(tmpdir(), 'agent-remote-store-'));
  return { root, file: join(root, '.agent-remote', 'agent-remote.db') };
}

function namedTunnel() {
  return {
    accountId: 'account-1',
    zoneId: 'zone-1',
    zoneName: 'example.com',
    hostname: 'term.example.com',
    tunnelId: 'tunnel-1',
    tunnelName: 'agent-remote-installatio',
    dnsRecordId: 'record-1',
    dnsTarget: 'tunnel-1.cfargotunnel.com',
  };
}

test('initializes remote settings once and starts with no paired devices', () => {
  const { root, file } = temporaryDatabase();
  try {
    const first = createRemoteStore(file);
    assert.equal(existsSync(file), true);
    assert.equal(statSync(join(root, '.agent-remote')).mode & 0o777, 0o700);
    const settings = first.getSettings();
    assert.match(settings.installationId, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.equal(settings.desiredState, 'stopped');
    assert.equal(settings.hostname, null);
    assert.deepEqual(first.listDevices(), []);
    first.close();

    const second = createRemoteStore(file);
    assert.equal(second.getSettings().installationId, settings.installationId);
    second.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('persists named-tunnel metadata and preserves its installation identity when cleared', () => {
  const { root, file } = temporaryDatabase();
  try {
    const first = createRemoteStore(file);
    const installationId = first.getSettings().installationId;
    const saved = first.saveNamedTunnel(namedTunnel());
    assert.equal(saved.installationId, installationId);
    assert.equal(saved.hostname, 'term.example.com');
    assert.equal(saved.desiredState, 'stopped');
    first.setDesiredState('running');
    first.close();

    const second = createRemoteStore(file);
    assert.deepEqual(second.getSettings(), {
      ...saved,
      desiredState: 'running',
      updatedAt: second.getSettings().updatedAt,
    });
    second.clearNamedTunnel();
    assert.deepEqual(second.getSettings(), {
      installationId,
      accountId: null,
      zoneId: null,
      zoneName: null,
      hostname: null,
      tunnelId: null,
      tunnelName: null,
      dnsRecordId: null,
      dnsTarget: null,
      desiredState: 'stopped',
      updatedAt: second.getSettings().updatedAt,
    });
    second.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('stores canonical public JWKs, retains revoked devices, and limits active-device use', () => {
  const { root, file } = temporaryDatabase();
  try {
    const store = createRemoteStore(file);
    const publicKeyJwk = { y: 'y-coordinate', x: 'x-coordinate', kty: 'EC', crv: 'P-256' };
    const device = store.registerDevice({
      id: 'device-1', name: 'MacBook', publicKeyJwk, fingerprint: 'fingerprint-1', createdAt: 100,
    });
    assert.deepEqual(device, {
      id: 'device-1', name: 'MacBook',
      publicKeyJwk: { crv: 'P-256', kty: 'EC', x: 'x-coordinate', y: 'y-coordinate' },
      fingerprint: 'fingerprint-1', createdAt: 100, lastUsedAt: null, revokedAt: null,
    });
    assert.throws(() => store.registerDevice({
      id: 'device-2', name: 'Duplicate', publicKeyJwk, fingerprint: 'fingerprint-1', createdAt: 101,
    }), /UNIQUE constraint failed/);
    assert.equal(store.touchDevice('device-1', 200), true);
    assert.equal(store.getActiveDevice('device-1').lastUsedAt, 200);
    assert.equal(store.revokeDevice('device-1', 300), true);
    assert.equal(store.getActiveDevice('device-1'), undefined);
    assert.equal(store.touchDevice('device-1', 400), false);
    assert.equal(store.revokeDevice('device-1', 400), false);
    assert.deepEqual(store.listDevices(), [{ ...device, lastUsedAt: 200, revokedAt: 300 }]);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('adds only remote tables to an existing project and chat database', () => {
  const { root, file } = temporaryDatabase();
  try {
    const projects = createProjectStore(file);
    const project = projects.create({ name: 'Existing', cwd: '/tmp/existing', commandLine: 'zsh' });
    projects.saveChat({ name: 'existing-chat', projectId: project.id, createdAt: 100, lastActiveAt: 100 });
    projects.close();

    const remote = createRemoteStore(file);
    assert.equal(remote.getSettings().desiredState, 'stopped');
    remote.close();

    const check = new DatabaseSync(file);
    assert.equal(check.prepare('SELECT name FROM projects WHERE id = ?').get(project.id).name, 'Existing');
    assert.equal(check.prepare('SELECT session_name FROM chats WHERE session_name = ?').get('existing-chat').session_name, 'existing-chat');
    assert.deepEqual(
      check.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('remote_settings', 'remote_devices') ORDER BY name").all().map((row) => row.name),
      ['remote_devices', 'remote_settings'],
    );
    check.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
