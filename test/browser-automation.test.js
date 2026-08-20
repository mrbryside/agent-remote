import assert from 'node:assert/strict';
import test from 'node:test';
import {
  closeTerminalBrowserAgentSession,
  reapStaleTerminalBrowserAgentSessions,
  terminalBrowserAgentPaths,
} from '../src/browser-automation.js';

function socketEntry(name) {
  return { name, isSocket: () => true };
}

test('derives the installed terminal-browser agent runtime paths', () => {
  assert.deepEqual(terminalBrowserAgentPaths({
    environment: {}, home: '/Users/tester',
  }), {
    socketDir: '/Users/tester/.local/state/terminal-browser/agent-browser',
    binary: '/Users/tester/.local/share/terminal-browser/app/agent-browser/bin/agent-browser',
  });
});

test('closes only an existing validated browser-owned agent session', async () => {
  const calls = [];
  const paths = { socketDir: '/state/agent-browser', binary: '/app/agent-browser' };
  const closed = await closeTerminalBrowserAgentSession('3106-2', {
    paths,
    environment: { TEST_MARKER: 'yes' },
    exists: (path) => path === '/state/agent-browser/terminal-browser-3106-2.sock',
    run: async (...args) => calls.push(args),
  });
  assert.equal(closed, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][0], '/app/agent-browser');
  assert.deepEqual(calls[0][1], ['--session', 'terminal-browser-3106-2', 'close']);
  assert.equal(calls[0][2].env.AGENT_BROWSER_SOCKET_DIR, '/state/agent-browser');
  assert.equal(calls[0][2].env.TEST_MARKER, 'yes');

  assert.equal(await closeTerminalBrowserAgentSession('../other', {
    paths, exists: () => true, run: async () => assert.fail('must not execute'),
  }), false);
  assert.equal(await closeTerminalBrowserAgentSession('missing-1', {
    paths, exists: () => false, run: async () => assert.fail('must not execute'),
  }), false);
});

test('reaps live agent sockets only when their browser owner is absent', async () => {
  const calls = [];
  const paths = { socketDir: '/state/agent-browser', binary: '/app/agent-browser' };
  const stale = await reapStaleTerminalBrowserAgentSessions(['active-1'], {
    paths,
    readDir: () => [
      socketEntry('terminal-browser-active-1.sock'),
      socketEntry('terminal-browser-stale-2.sock'),
      { name: 'terminal-browser-note.txt', isSocket: () => false },
    ],
    exists: () => true,
    run: async (_binary, args) => calls.push(args),
  });
  assert.deepEqual(stale, ['stale-2']);
  assert.deepEqual(calls, [['--session', 'terminal-browser-stale-2', 'close']]);
});
