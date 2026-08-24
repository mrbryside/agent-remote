import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  createTerminalBrowserSupervisor,
  terminalBrowserOwnedListing,
  terminalBrowserServerEnvironment,
} from '../src/server/terminal-browser-supervisor.js';

test('isolates the server-owned terminal-browser runtime and Chromium profile', () => {
  const environment = terminalBrowserServerEnvironment({
    environment: { PATH: '/bin' },
    databaseFile: '/state/agent-remote.db',
  });
  const identity = createHash('sha256').update('/state/agent-remote.db').digest('hex').slice(0, 12);
  const userId = typeof process.getuid === 'function' ? process.getuid() : 'user';
  assert.equal(environment.PATH, '/bin');
  assert.equal(environment.XDG_RUNTIME_DIR, `/tmp/agent-remote-tb-${userId}-${identity}`);
  assert.equal(environment.TERMINAL_BROWSER_APPDATA, '/state/terminal-browser-appdata');
  assert.equal(environment.AGENT_REMOTE_GRAPHICS, '1');
});

test('lists only browsers registered under the server-owned agent socket directory', async () => {
  const list = terminalBrowserOwnedListing(async () => [
    { key: 'owned', socket: '/runtime/instances/terminal-browser-owned.sock' },
    { key: 'host', socket: '/host/instances/terminal-browser-host.sock' },
  ], { instancesDir: '/runtime/instances' });
  assert.deepEqual((await list()).map((browser) => browser.key), ['owned']);
});

test('does not recycle the private daemon while an owned browser is active', async () => {
  let reaped = false;
  const supervisor = createTerminalBrowserSupervisor({
    environment: {}, command: '/terminal-browser',
    paths: { daemonSocket: '/runtime/daemon.sock', distRoot: '/dist' },
    execFile: async () => assert.fail('must not shut down an active daemon'),
    listBrowsers: async () => [{ key: 'active' }],
    reapAgentSessions: async () => { reaped = true; },
    sweepIntervalMs: 0,
  });
  assert.equal(await supervisor.recover(), false);
  assert.equal(reaped, false);
});

test('kills only the verified owner of a hung private daemon socket', async () => {
  const calls = [];
  let daemonAlive = true;
  const paths = { daemonSocket: '/runtime/daemon.sock', distRoot: '/dist' };
  const supervisor = createTerminalBrowserSupervisor({
    environment: { MARKER: 'server' }, command: '/terminal-browser', paths,
    listBrowsers: async () => [],
    reapAgentSessions: async (active, options) => {
      calls.push(['reap', [...active], options.environment.MARKER]);
      return ['stale'];
    },
    execFile: async (command, args) => {
      if (command === '/terminal-browser') throw new Error('daemon did not answer');
      if (command === 'lsof') return { stdout: '4321\n' };
      if (command === 'ps') return { stdout: '/dist/browser/dist/main.js --daemon\n' };
      throw new Error(`unexpected command ${command} ${args.join(' ')}`);
    },
    socketExists: () => true,
    killProcess: (pid, signal) => {
      assert.equal(pid, 4321);
      if (signal === 0) {
        if (!daemonAlive) throw new Error('gone');
        return;
      }
      calls.push(['kill', signal]);
      daemonAlive = false;
    },
    sweepIntervalMs: 0,
  });
  assert.equal(await supervisor.recover(), true);
  assert.deepEqual(calls, [
    ['reap', [], 'server'],
    ['kill', 'SIGTERM'],
  ]);
});

test('refuses to kill a process that does not match the terminal-browser daemon entrypoint', async () => {
  const supervisor = createTerminalBrowserSupervisor({
    environment: {}, command: '/terminal-browser',
    paths: { daemonSocket: '/runtime/daemon.sock', distRoot: '/dist' },
    listBrowsers: async () => [],
    reapAgentSessions: async () => [],
    execFile: async (command) => {
      if (command === '/terminal-browser') throw new Error('daemon did not answer');
      if (command === 'lsof') return { stdout: '4321\n' };
      return { stdout: '/some/other/process --daemon\n' };
    },
    socketExists: () => true,
    killProcess: (_pid, signal) => {
      if (signal !== 0) assert.fail('must not kill an unverified process');
    },
    sweepIntervalMs: 0,
  });
  assert.equal(await supervisor.recover(), false);
});
