import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import { REMOTE_ERROR_CODES, RemoteError, remoteError } from '../src/remote/errors.js';

test('loads remote config defaults and environment overrides', { concurrency: false }, () => {
  const defaults = loadConfig({ env: { PATH: '' } });
  assert.equal(defaults.host, '127.0.0.1');
  assert.equal(defaults.port, 3000);
  assert.equal(defaults.remoteHost, '127.0.0.1');
  assert.equal(defaults.remotePort, 3001);
  assert.equal(defaults.cloudflaredBin, 'cloudflared');
  assert.equal(defaults.desktopMode, false);
  assert.equal(defaults.pairingTtlMs, 120_000);
  assert.equal(defaults.challengeTtlMs, 60_000);
  assert.equal(defaults.remoteSessionTtlMs, 43_200_000);

  const overridden = loadConfig({
    env: {
      PATH: '',
      PORT: '4010',
      REMOTE_PORT: '4011',
      CLOUDFLARED_BIN: '/opt/homebrew/bin/cloudflared',
      AGENT_REMOTE_DESKTOP: '1',
    },
  });
  assert.equal(overridden.remotePort, 4011);
  assert.equal(overridden.cloudflaredBin, '/opt/homebrew/bin/cloudflared');
  assert.equal(overridden.desktopMode, true);
});

test('uses an ephemeral remote port with an ephemeral local port', { concurrency: false }, () => {
  const config = loadConfig({ env: { PATH: '', PORT: '0' } });
  assert.equal(config.port, 0);
  assert.equal(config.remotePort, 0);
});

test('rejects invalid remote listener configuration', { concurrency: false }, () => {
  assert.throws(
    () => loadConfig({ env: { PATH: '', REMOTE_HOST: '0.0.0.0' } }),
    /REMOTE_HOST/,
  );
  assert.throws(
    () => loadConfig({ env: { PATH: '', REMOTE_PORT: 'not-a-port' } }),
    /REMOTE_PORT/,
  );
  assert.throws(
    () => loadConfig({ env: { PATH: '', REMOTE_PORT: '65536' } }),
    /REMOTE_PORT/,
  );
});

test('exposes stable remote errors', { concurrency: false }, () => {
  assert.deepEqual(REMOTE_ERROR_CODES, [
    'REMOTE_UNSUPPORTED',
    'CLOUDFLARED_MISSING',
    'CLOUDFLARED_OUTDATED',
    'TOKEN_INVALID',
    'ZONE_FORBIDDEN',
    'HOSTNAME_CONFLICT',
    'TUNNEL_START_TIMEOUT',
    'PAIRING_EXPIRED',
    'DEVICE_REVOKED',
    'REMOTE_UNAUTHORIZED',
  ]);

  const error = remoteError('TOKEN_INVALID', 'The Cloudflare token is invalid', 401);
  assert.ok(error instanceof Error);
  assert.ok(error instanceof RemoteError);
  assert.equal(error.name, 'RemoteError');
  assert.equal(error.code, 'TOKEN_INVALID');
  assert.equal(error.message, 'The Cloudflare token is invalid');
  assert.equal(error.status, 401);
});

test('uses a named tmux session when tmux is executable', () => {
  const config = loadConfig({
    env: { PATH: '/bin:/usr/bin' },
    tmuxSession: 'grok',
    tmuxCommand: '/bin/sh',
  });
  assert.equal(config.useTmux, true);
  assert.equal(config.command, '/bin/sh');
  assert.deepEqual(config.args, ['new-session', '-A', '-s', 'grok']);
});

test('falls back to the configured shell when tmux is unavailable', () => {
  const config = loadConfig({
    env: { PATH: '/bin:/usr/bin' },
    shell: '/bin/sh',
    shellArgs: [],
    tmuxSession: 'grok',
    tmuxCommand: '/definitely/missing/tmux',
  });
  assert.equal(config.useTmux, false);
  assert.equal(config.command, '/bin/sh');
  assert.deepEqual(config.args, []);
});

test('validates shell arguments as a JSON string array', () => {
  assert.throws(
    () => loadConfig({ env: { TERMINAL_SHELL_ARGS: '--login' } }),
    /TERMINAL_SHELL_ARGS/,
  );
});

test('uses a persistent tmux-backed default shell when available', () => {
  const config = loadConfig({
    env: { PATH: '/bin:/usr/bin' },
    tmuxCommand: '/bin/sh',
    tmuxSession: '',
    tmuxShell: true,
    tmuxShellSession: 'agent-remote-test-shell',
  });
  assert.equal(config.tmuxBacked, true);
  assert.equal(config.useTmuxShell, true);
  assert.deepEqual(config.args, ['new-session', '-A', '-s', 'agent-remote-test-shell']);
});
