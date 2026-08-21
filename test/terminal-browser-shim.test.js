import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const shim = resolve('bin/terminal-browser');

function runShim(args, environment) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [shim, ...args], {
      cwd: process.cwd(),
      env: { ...process.env, ...environment },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolveRun({ code, signal, stdout, stderr }));
  });
}

async function withBackend(handler, run) {
  const server = createServer(handler);
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

test('does not launch a real terminal browser when agent-remote rejects session routing', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-remote-terminal-browser-shim-'));
  const marker = join(directory, 'real-browser-ran');
  const fakeBrowser = join(directory, 'terminal-browser-real');
  writeFileSync(fakeBrowser, `#!/bin/sh\ntouch '${marker}'\n`);
  chmodSync(fakeBrowser, 0o755);
  try {
    await withBackend((request, response) => {
      response.writeHead(409, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'More than one active chat uses that project folder' }));
    }, async (url) => {
      const result = await runShim(['open', 'https://example.test'], {
        AGENT_REMOTE_URL: url,
        TERMINAL_BROWSER_REAL: fakeBrowser,
      });
      assert.equal(result.code, 1);
      assert.match(result.stderr, /More than one active chat/);
      assert.equal(existsSync(marker), false);
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('does not launch a long-lived real browser when a managed backend is temporarily unavailable', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-remote-terminal-browser-unavailable-'));
  const marker = join(directory, 'real-browser-ran');
  const fakeBrowser = join(directory, 'terminal-browser-real');
  writeFileSync(fakeBrowser, `#!/bin/sh\ntouch '${marker}'\n`);
  chmodSync(fakeBrowser, 0o755);
  try {
    const result = await runShim(['open', 'https://example.test'], {
      AGENT_REMOTE_URL: 'http://127.0.0.1:1',
      AGENT_REMOTE_WEB: '',
      AGENT_REMOTE_ACP: '',
      TERM_PROGRAM: 'agent-remote',
      TERMINAL_BROWSER_REAL: fakeBrowser,
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /agent-remote backend/i);
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('preserves host terminal-browser fallback outside an agent-remote terminal', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-remote-terminal-browser-host-'));
  const marker = join(directory, 'real-browser-ran');
  const fakeBrowser = join(directory, 'terminal-browser-real');
  writeFileSync(fakeBrowser, `#!/bin/sh\ntouch '${marker}'\n`);
  chmodSync(fakeBrowser, 0o755);
  try {
    const result = await runShim(['open', 'https://example.test'], {
      AGENT_REMOTE_URL: 'http://127.0.0.1:1',
      AGENT_REMOTE_WEB: '',
      AGENT_REMOTE_ACP: '',
      TERM_PROGRAM: 'external-terminal',
      TERMINAL_BROWSER_REAL: fakeBrowser,
    });
    assert.equal(result.code, 0);
    assert.equal(existsSync(marker), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('lists only the browser state returned for the resolved agent-remote session', async () => {
  await withBackend((request, response) => {
    assert.match(request.url, /^\/api\/control\/browser-state\?/);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      self: 'session-browser-a',
      browsers: [{
        key: 'session-browser-a', url: 'https://one.example/', title: 'One',
        tabs: [{ id: 1, url: 'https://one.example/', title: 'One', active: true }],
      }],
    }));
  }, async (url) => {
    const result = await runShim(['ls', '--all', '--json'], { AGENT_REMOTE_URL: url });
    assert.equal(result.code, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.browsers.length, 1);
    assert.equal(payload.browsers[0].key, 'session-browser-a');
    assert.deepEqual(payload.browsers[0].tabs.map((tab) => tab.url), ['https://one.example/']);
  });
});
