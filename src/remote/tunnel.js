import { execFile as defaultExecFile, spawn as defaultSpawn } from 'node:child_process';

import { remoteError } from './errors.js';

const MINIMUM_VERSION = [2025, 4, 0];
const QUICK_URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i;
const MAX_OUTPUT_BYTES = 8 * 1024;

function cleanStatus(status) {
  return Object.fromEntries(Object.entries(status).filter(([, value]) => value !== undefined));
}

function versionParts(value) {
  const match = /\b(\d+)\.(\d+)\.(\d+)\b/.exec(value);
  return match ? match.slice(1).map(Number) : undefined;
}

function versionAtLeast(actual, expected) {
  for (let index = 0; index < expected.length; index += 1) {
    if (actual[index] > expected[index]) return true;
    if (actual[index] < expected[index]) return false;
  }
  return true;
}

function runExecFile(execFile, command, args) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (error, stdout = '', stderr = '') => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(`${stdout ?? ''}\n${stderr ?? ''}`);
    };
    try {
      const result = execFile(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 }, done);
      if (result?.then) result.then((value) => done(null, value?.stdout ?? value, value?.stderr), done);
    } catch (error) {
      done(error);
    }
  });
}

/**
 * Probes cloudflared without making local startup depend on it. `source` is
 * `override` for an explicit binary path and `path` for normal PATH lookup.
 */
export async function inspectCloudflared({ command = 'cloudflared', execFile = defaultExecFile } = {}) {
  const source = command.includes('/') ? 'override' : 'path';
  try {
    const output = await runExecFile(execFile, command, ['--version']);
    const parts = versionParts(output);
    if (!parts) {
      return { available: false, version: undefined, source, error: remoteError('CLOUDFLARED_MISSING', 'cloudflared could not be identified.') };
    }
    const version = parts.join('.');
    if (!versionAtLeast(parts, MINIMUM_VERSION)) {
      return {
        available: false,
        version,
        source,
        error: remoteError('CLOUDFLARED_OUTDATED', 'cloudflared 2025.4.0 or newer is required.'),
      };
    }
    return { available: true, version, source, error: undefined };
  } catch {
    return {
      available: false,
      version: undefined,
      source,
      error: remoteError('CLOUDFLARED_MISSING', 'cloudflared is not available.'),
    };
  }
}

function waitForExit(child) {
  return new Promise((resolve) => child.once('exit', resolve));
}

function configuredPublicUrl(hostname) {
  if (!hostname || typeof hostname !== 'string') throw new TypeError('A named tunnel hostname is required.');
  return `https://${hostname}`;
}

/**
 * Owns at most one cloudflared child. Dependencies are injectable for tests:
 * `{ command, spawn, store, env, remoteOrigin, startupTimeoutMs,
 * killTimeoutMs, retryDelaysMs, setTimeout, clearTimeout }`.
 */
export function createTunnelManager(dependencies = {}) {
  const command = dependencies.command ?? dependencies.cloudflaredBin ?? 'cloudflared';
  const spawn = dependencies.spawn ?? defaultSpawn;
  const store = dependencies.store;
  const env = dependencies.env ?? process.env;
  const remoteOrigin = dependencies.remoteOrigin ?? 'http://127.0.0.1:3001';
  const startupTimeoutMs = dependencies.startupTimeoutMs ?? 15_000;
  const killTimeoutMs = dependencies.killTimeoutMs ?? 5_000;
  const retryDelaysMs = dependencies.retryDelaysMs ?? [1_000, 2_000, 4_000, 10_000, 30_000, 60_000];
  const schedule = dependencies.setTimeout ?? globalThis.setTimeout;
  const cancelSchedule = dependencies.clearTimeout ?? globalThis.clearTimeout;
  const listeners = new Set();
  let current = cleanStatus({ mode: 'none', state: 'stopped' });
  let active;
  let operation;
  let retryTimer;
  let closed = false;

  function publish(status) {
    current = cleanStatus(status);
    for (const listener of listeners) listener({ ...current, error: current.error && { ...current.error } });
    return current;
  }

  function status() {
    return cleanStatus({ ...current, error: current.error && { ...current.error } });
  }

  function setDesiredState(value) {
    try {
      return Promise.resolve(store?.setDesiredState?.(value));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  function childEnvironment(tunnelToken) {
    const childEnv = { ...env };
    delete childEnv.TUNNEL_TOKEN;
    if (tunnelToken) childEnv.TUNNEL_TOKEN = tunnelToken;
    return childEnv;
  }

  function appendOutput(record, data) {
    const value = String(data);
    record.output = `${record.output}${value}`.slice(-MAX_OUTPUT_BYTES);
    return record.output;
  }

  function clearRetry() {
    if (retryTimer !== undefined) cancelSchedule(retryTimer);
    retryTimer = undefined;
  }

  function markExited(record, code, signal) {
    if (active !== record) return;
    active = undefined;
    if (record.explicitStop || closed) return;
    if (record.mode === 'quick') {
      publish({
        mode: 'none', state: 'error',
        error: { code: 'TUNNEL_EXITED', message: 'The Quick Tunnel stopped unexpectedly.' },
      });
      record.reject?.(remoteError('TUNNEL_EXITED', 'The Quick Tunnel stopped unexpectedly.'));
      return;
    }
    if (retryDelaysMs.length > 0) {
      // A named tunnel represents persisted desired state. Keep retrying at
      // the final bounded interval until Stop changes that state; otherwise a
      // Mac sleep or a long network outage can leave Remote permanently down.
      const delay = retryDelaysMs[Math.min(record.attempt, retryDelaysMs.length - 1)];
      publish({ mode: 'named', state: 'starting', publicUrl: record.publicUrl, hostname: record.hostname });
      retryTimer = schedule(() => {
        retryTimer = undefined;
        if (closed || record.explicitStop || current.mode !== 'named') return;
        launchNamed({ ...record, attempt: record.attempt + 1 });
      }, delay);
      return;
    }
    publish({
      mode: 'named', state: 'error', publicUrl: record.publicUrl, hostname: record.hostname,
      error: { code: 'TUNNEL_EXITED', message: 'The named tunnel stopped unexpectedly.' },
    });
  }

  function attachChild(record) {
    record.child.once('exit', (code, signal) => markExited(record, code, signal));
    record.child.once('error', () => markExited(record, 1, null));
    record.child.stdout?.on('data', (data) => onOutput(record, data));
    record.child.stderr?.on('data', (data) => onOutput(record, data));
  }

  function onOutput(record, data) {
    const output = appendOutput(record, data);
    if (record.mode !== 'quick' || record.resolved) return;
    const url = output.match(QUICK_URL_PATTERN)?.[0];
    if (!url) return;
    record.resolved = true;
    cancelSchedule(record.timeout);
    publish({ mode: 'quick', state: 'running', publicUrl: url });
    record.resolve(status());
  }

  function launchQuick() {
    publish({ mode: 'quick', state: 'starting' });
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const record = {
      mode: 'quick', output: '', resolve, reject, resolved: false, explicitStop: false,
      child: spawn(command, ['tunnel', '--no-autoupdate', '--url', remoteOrigin], {
        env: childEnvironment(), stdio: ['ignore', 'pipe', 'pipe'],
      }),
    };
    active = record;
    attachChild(record);
    record.timeout = schedule(async () => {
      if (active !== record || record.resolved) return;
      record.explicitStop = true;
      await terminate(record);
      if (active === record) active = undefined;
      const error = remoteError('TUNNEL_START_TIMEOUT', 'Timed out waiting for the Quick Tunnel URL.');
      publish({ mode: 'none', state: 'error', error: { code: error.code, message: error.message } });
      reject(error);
    }, startupTimeoutMs);
    return promise;
  }

  function launchNamed(input) {
    const record = {
      mode: 'named', hostname: input.hostname, publicUrl: input.publicUrl,
      tunnelToken: input.tunnelToken, attempt: input.attempt ?? 0, output: '', explicitStop: false,
      child: spawn(command, ['tunnel', '--no-autoupdate', 'run'], {
        env: childEnvironment(input.tunnelToken), stdio: ['ignore', 'pipe', 'pipe'],
      }),
    };
    active = record;
    attachChild(record);
    publish({ mode: 'named', state: 'running', publicUrl: record.publicUrl, hostname: record.hostname });
    return record;
  }

  async function terminate(record) {
    if (!record?.child || record.terminated) return;
    record.terminated = true;
    const exited = waitForExit(record.child);
    try { record.child.kill('SIGTERM'); } catch { return; }
    let escalation;
    await Promise.race([
      exited,
      new Promise((resolve) => {
        escalation = schedule(() => {
          try { record.child.kill('SIGKILL'); } catch { /* child already gone */ }
          resolve();
        }, killTimeoutMs);
      }),
    ]);
    if (escalation !== undefined) cancelSchedule(escalation);
  }

  function startQuick() {
    if (closed) return Promise.reject(new Error('Tunnel manager is closed.'));
    if (current.mode === 'quick' && operation) return operation;
    if (active) {
      operation = stop().then(() => launchQuick());
    } else {
      operation = launchQuick();
    }
    operation.catch(() => {});
    return operation;
  }

  function startNamed(config) {
    if (closed) return Promise.reject(new Error('Tunnel manager is closed.'));
    const hostname = config?.hostname;
    const tunnelToken = config?.tunnelToken ?? config?.token;
    if (!tunnelToken || typeof tunnelToken !== 'string') return Promise.reject(new TypeError('A named tunnel token is required.'));
    const publicUrl = configuredPublicUrl(hostname);
    if (current.mode === 'named' && operation) return operation;
    operation = (active ? stop() : Promise.resolve()).then(async () => {
      await setDesiredState('running');
      launchNamed({ hostname, publicUrl, tunnelToken });
      return status();
    });
    operation.catch(() => {});
    return operation;
  }

  function stop({ preserveDesiredState = false } = {}) {
    if (operation && current.state === 'stopping') return operation;
    clearRetry();
    const record = active;
    if (!record && current.mode !== 'named') {
      const persistStopped = preserveDesiredState ? Promise.resolve() : setDesiredState('stopped');
      publish({ mode: 'none', state: 'stopped' });
      return persistStopped.then(() => status());
    }
    publish({ mode: current.mode, state: 'stopping', publicUrl: current.publicUrl, hostname: current.hostname });
    if (record) record.explicitStop = true;
    const stopOperation = Promise.resolve()
      .then(() => !preserveDesiredState && (current.mode === 'named' || record?.mode === 'named')
        ? setDesiredState('stopped')
        : undefined)
      .then(() => terminate(record))
      .then(() => {
        if (active === record) active = undefined;
        publish({ mode: 'none', state: 'stopped' });
        return status();
      });
    operation = stopOperation;
    stopOperation.finally(() => {
      if (operation === stopOperation) operation = undefined;
    }).catch(() => {});
    return stopOperation;
  }

  return {
    status,
    startQuick,
    startNamed,
    stop,
    async close() {
      closed = true;
      clearRetry();
      await stop({ preserveDesiredState: true });
      listeners.clear();
    },
    onStatus(listener) {
      if (typeof listener !== 'function') throw new TypeError('Status listener must be a function.');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
