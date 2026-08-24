import assert from 'node:assert/strict';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createServer, request } from 'node:http';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { WebSocket } from 'ws';

const execFile = promisify(execFileCallback);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sidecar = process.env.AGENT_REMOTE_SIDECAR_PATH ??
  join(root, 'src-tauri', 'binaries', 'agent-remote-server-aarch64-apple-darwin');
const cloudflared = process.env.AGENT_REMOTE_CLOUDFLARED_PATH ??
  join(root, 'src-tauri', 'binaries', 'cloudflared-aarch64-apple-darwin');
const runtimeDir = process.env.AGENT_REMOTE_RUNTIME_DIR ?? join(root, 'src-tauri', 'binaries', 'agent-remote-runtime');
const timeoutMs = 15_000;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function openPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function portPair() {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const first = await openPort();
    if (first === 65_535) continue;
    const second = first + 1;
    try {
      await new Promise((resolve, reject) => {
        const server = createServer();
        server.once('error', reject);
        server.listen(second, '127.0.0.1', () => server.close((error) => error ? reject(error) : resolve()));
      });
      return { localPort: first, remotePort: second };
    } catch {
      // Try another ephemeral port.
    }
  }
  throw new Error('Could not reserve adjacent ephemeral ports for the sidecar smoke test');
}

function parseReady(child) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Timed out waiting for sidecar readiness')), timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      output += chunk;
      for (const line of output.split('\n')) {
        try {
          const message = JSON.parse(line);
          if (message.type === 'ready' && typeof message.localUrl === 'string') {
            clearTimeout(timer);
            resolve(message.localUrl);
            return;
          }
        } catch {
          // Human-readable startup lines are not readiness messages.
        }
      }
    });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`Sidecar exited before readiness (code ${code}, signal ${signal})\n${output}`));
    });
  });
}

function httpJson(url) {
  return new Promise((resolve, reject) => {
    const requestHandle = request(url, { timeout: 2_000 }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    requestHandle.once('timeout', () => requestHandle.destroy(new Error(`HTTP timed out: ${url}`)));
    requestHandle.once('error', reject);
    requestHandle.end();
  });
}

async function waitFor(check, description) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try { return await check(); } catch (error) { lastError = error; await delay(100); }
  }
  throw new Error(`Timed out waiting for ${description}: ${lastError?.message ?? 'unknown error'}`);
}

function tcpOpen(port) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.end(); resolve(); });
    socket.once('error', reject);
  });
}

async function exercisePty(localUrl) {
  await new Promise((resolve, reject) => {
    const socket = new WebSocket(localUrl.replace(/^http/, 'ws') + '/ws?cols=80&rows=24');
    let ready = false;
    let output = '';
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error('Timed out waiting for PTY output'));
    }, timeoutMs);
    socket.once('error', (error) => { clearTimeout(timer); reject(error); });
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'ready' && !ready) {
        ready = true;
        socket.send(JSON.stringify({ type: 'input', data: 'printf "agent-remote-sidecar-smoke\\n"; exit\\n' }));
      }
      if (message.type === 'error') {
        clearTimeout(timer);
        socket.close();
        reject(new Error(`PTY sidecar error: ${message.message}`));
      }
      if (message.type === 'output') {
        output += message.data;
        if (output.includes('agent-remote-sidecar-smoke')) {
          clearTimeout(timer);
          socket.close();
          resolve();
        }
      }
    });
  });
}

function exitsAfterSignal(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Sidecar did not exit after SIGTERM')), timeoutMs);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}

async function assertNoSidecarChildren() {
  const { stdout } = await execFile('/bin/ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' });
  const matches = stdout.split('\n').filter((line) =>
    line.includes('agent-remote-runtime/src/server.js') || line.includes('cloudflared-aarch64-apple-darwin'));
  assert.deepEqual(matches, [], `orphaned packaged child processes:\n${matches.join('\n')}`);
}

async function main() {
  const databaseDir = await mkdtemp(join(tmpdir(), 'agent-remote-sidecar-smoke-'));
  let child;
  let stderr = '';
  try {
    await Promise.all([
      access(sidecar, constants.X_OK),
      access(cloudflared, constants.X_OK),
      access(join(runtimeDir, 'node'), constants.X_OK),
      access(join(runtimeDir, 'node_modules', 'node-pty', 'prebuilds', 'darwin-arm64', 'spawn-helper'), constants.X_OK),
    ]);
    const { localPort, remotePort } = await portPair();
    child = spawn(sidecar, [], {
      env: {
        ...process.env,
        PORT: String(localPort),
        REMOTE_PORT: String(remotePort),
        AGENT_REMOTE_DB_PATH: join(databaseDir, 'agent-remote.db'),
        CLOUDFLARED_BIN: cloudflared,
        AGENT_REMOTE_TMUX_SHELL: '0',
        TERMINAL_SHELL: '/bin/sh',
        TERMINAL_SHELL_ARGS: '[]',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const localUrl = await parseReady(child);
    const runtime = await waitFor(async () => {
      const response = await httpJson(`${localUrl}/api/runtime`);
      assert.equal(response.status, 200);
      return JSON.parse(response.body);
    }, 'local control health surface');
    assert.equal(runtime.surface, 'local');
    assert.equal(runtime.remoteReady, true);
    const frontend = await httpJson(localUrl);
    assert.equal(frontend.status, 200);
    assert.match(frontend.body, /<title>Agent Remote<\/title>/);
    await waitFor(() => tcpOpen(remotePort), 'remote gateway listener');
    await exercisePty(localUrl);
    await exitsAfterSignal(child);
    await assertNoSidecarChildren();
    console.log('Sidecar smoke test passed: local and remote listeners, PTY WebSocket, and shutdown');
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        delay(2_000),
      ]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    if (stderr) process.stderr.write(stderr);
    await rm(databaseDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`sidecar:smoke failed: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
