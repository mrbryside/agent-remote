import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createTunnelManager, inspectCloudflared } from '../src/remote/tunnel.js';

const fixture = new URL('./fixtures/cloudflared-remote', import.meta.url).pathname;

function execFileResult({ stdout = '', stderr = '', error } = {}) {
  return (_command, _args, _options, callback) => queueMicrotask(() => callback(error ?? null, stdout, stderr));
}

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.kills = [];
  }

  kill(signal) {
    this.kills.push(signal);
    if (signal === 'SIGTERM' && !this.ignoreTerm) queueMicrotask(() => this.exit(0, signal));
    if (signal === 'SIGKILL') queueMicrotask(() => this.exit(0, signal));
    return true;
  }

  exit(code = 0, signal = null) {
    this.emit('exit', code, signal);
    this.emit('close', code, signal);
  }
}

function childSpawner() {
  const calls = [];
  const spawn = (command, args, options) => {
    const child = new FakeChild();
    calls.push({ command, args, options, child });
    return child;
  };
  return { spawn, calls };
}

function settingsStore() {
  const states = [];
  return { states, setDesiredState: (state) => states.push(state) };
}

test('inspects override and PATH cloudflared commands without throwing for missing or outdated binaries', async () => {
  const fixtureResult = await inspectCloudflared({ command: fixture });
  assert.deepEqual(fixtureResult, { available: true, version: '2025.4.0', source: 'override', error: undefined });

  const supported = await inspectCloudflared({
    command: fixture,
    execFile: execFileResult({ stdout: 'cloudflared version 2025.4.0\n' }),
  });
  assert.deepEqual(supported, { available: true, version: '2025.4.0', source: 'override', error: undefined });

  const fromPath = await inspectCloudflared({
    command: 'cloudflared',
    execFile: execFileResult({ stdout: 'cloudflared version 2026.1.2' }),
  });
  assert.equal(fromPath.available, true);
  assert.equal(fromPath.source, 'path');

  const outdated = await inspectCloudflared({
    command: 'cloudflared',
    execFile: execFileResult({ stdout: 'cloudflared version 2025.3.9' }),
  });
  assert.equal(outdated.available, false);
  assert.equal(outdated.version, '2025.3.9');
  assert.equal(outdated.error.code, 'CLOUDFLARED_OUTDATED');

  const missingError = Object.assign(new Error('not found'), { code: 'ENOENT' });
  const missing = await inspectCloudflared({ command: 'cloudflared', execFile: execFileResult({ error: missingError }) });
  assert.equal(missing.available, false);
  assert.equal(missing.error.code, 'CLOUDFLARED_MISSING');
});

test('serializes idempotent Quick starts, parses the URL, and emits status changes', async () => {
  const fake = childSpawner();
  const manager = createTunnelManager({ spawn: fake.spawn, command: fixture, startupTimeoutMs: 100 });
  const seen = [];
  const unsubscribe = manager.onStatus((status) => seen.push(status));

  const first = manager.startQuick();
  const second = manager.startQuick();
  assert.equal(first, second);
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(fake.calls[0].args, ['tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:3001']);
  fake.calls[0].child.stderr.emit('data', Buffer.from('https://example.trycloudflare.com connected'));

  assert.deepEqual(await first, { mode: 'quick', state: 'running', publicUrl: 'https://example.trycloudflare.com' });
  assert.equal(seen.at(-1).state, 'running');
  unsubscribe();
  await manager.stop();
});

test('times out a Quick startup, cleans up its child, and exposes a stable error', async () => {
  const fake = childSpawner();
  const manager = createTunnelManager({ spawn: fake.spawn, startupTimeoutMs: 5, killTimeoutMs: 5 });

  await assert.rejects(manager.startQuick(), (error) => error.code === 'TUNNEL_START_TIMEOUT');
  assert.deepEqual(fake.calls[0].child.kills, ['SIGTERM']);
  assert.deepEqual(manager.status(), {
    mode: 'none', state: 'error', error: { code: 'TUNNEL_START_TIMEOUT', message: 'Timed out waiting for the Quick Tunnel URL.' },
  });
});

test('stops children with TERM followed by KILL only after the grace period', async () => {
  const fake = childSpawner();
  const manager = createTunnelManager({ spawn: fake.spawn, startupTimeoutMs: 100, killTimeoutMs: 5 });
  const started = manager.startQuick();
  fake.calls[0].child.stderr.emit('data', Buffer.from('https://example.trycloudflare.com'));
  await started;

  fake.calls[0].child.ignoreTerm = true;
  await manager.stop();
  assert.deepEqual(fake.calls[0].child.kills, ['SIGTERM', 'SIGKILL']);
  assert.deepEqual(manager.status(), { mode: 'none', state: 'stopped' });
});

test('keeps named tokens in the child environment, uses the configured hostname, and retries unexpected exits three times', async () => {
  const fake = childSpawner();
  const store = settingsStore();
  const manager = createTunnelManager({
    spawn: fake.spawn,
    store,
    retryDelaysMs: [1, 1, 1],
    startupTimeoutMs: 100,
  });
  const token = 'top-secret-tunnel-token';
  const status = await manager.startNamed({ hostname: 'term.example.com', tunnelToken: token });
  assert.deepEqual(status, {
    mode: 'named', state: 'running', publicUrl: 'https://term.example.com', hostname: 'term.example.com',
  });
  assert.deepEqual(fake.calls[0].args, ['tunnel', '--no-autoupdate', 'run']);
  assert.equal(fake.calls[0].options.env.TUNNEL_TOKEN, token);
  assert.equal(fake.calls[0].args.join(' ').includes(token), false);
  assert.deepEqual(store.states, ['running']);

  fake.calls[0].child.exit(1);
  await new Promise((resolve) => setTimeout(resolve, 10));
  fake.calls[1].child.exit(1);
  await new Promise((resolve) => setTimeout(resolve, 10));
  fake.calls[2].child.exit(1);
  await new Promise((resolve) => setTimeout(resolve, 10));
  fake.calls[3].child.exit(1);
  await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(fake.calls.length, 4);
  assert.equal(manager.status().state, 'error');
  assert.equal(manager.status().error.code, 'TUNNEL_EXITED');
  await manager.stop();
  assert.equal(store.states.at(-1), 'stopped');
});

test('preserves the named desired state when the server closes but explicit Stop turns it off', async () => {
  const closingFake = childSpawner();
  const closingStore = settingsStore();
  const closingManager = createTunnelManager({ spawn: closingFake.spawn, store: closingStore });

  await closingManager.startNamed({ hostname: 'term.example.com', tunnelToken: 'close-token' });
  await closingManager.close();
  assert.deepEqual(closingFake.calls[0].child.kills, ['SIGTERM']);
  assert.deepEqual(closingStore.states, ['running']);
  assert.deepEqual(closingManager.status(), { mode: 'none', state: 'stopped' });

  const stoppingFake = childSpawner();
  const stoppingStore = settingsStore();
  const stoppingManager = createTunnelManager({ spawn: stoppingFake.spawn, store: stoppingStore });

  await stoppingManager.startNamed({ hostname: 'term.example.com', tunnelToken: 'stop-token' });
  await stoppingManager.stop();
  assert.deepEqual(stoppingStore.states, ['running', 'stopped']);

  const idleStore = settingsStore();
  const idleManager = createTunnelManager({ spawn: childSpawner().spawn, store: idleStore });
  await idleManager.stop();
  assert.deepEqual(idleStore.states, ['stopped']);
});

test('runs the executable fixture and leaves no Quick child behind after Stop', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-remote-cloudflared-'));
  try {
    const manager = createTunnelManager({
      command: fixture,
      env: { ...process.env, CLOUDFLARED_QUICK_HOST: 'fixture.trycloudflare.com' },
      startupTimeoutMs: 1_000,
    });
    assert.equal((await manager.startQuick()).publicUrl, 'https://fixture.trycloudflare.com');
    await manager.stop();
    assert.deepEqual(manager.status(), { mode: 'none', state: 'stopped' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
