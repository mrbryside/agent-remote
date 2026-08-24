import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { terminalBrowserAgentPaths } from '../browser-automation.js';

function inside(directory, candidate) {
  if (typeof candidate !== 'string' || !candidate) return false;
  const root = `${resolve(directory)}${sep}`;
  return resolve(candidate).startsWith(root);
}

export function terminalBrowserServerEnvironment({
  environment = process.env,
  databaseFile,
} = {}) {
  const stateDirectory = dirname(resolve(databaseFile));
  const runtimeIdentity = createHash('sha256').update(resolve(databaseFile)).digest('hex').slice(0, 12);
  const userId = typeof process.getuid === 'function' ? process.getuid() : 'user';
  return {
    ...environment,
    // The browser daemon is a server-owned sidecar. Giving it a dedicated
    // runtime socket and Chromium profile prevents a hung Agent Remote pane
    // from poisoning terminal-browser sessions launched by the host terminal
    // (and lets us recycle it without touching another application).
    // Unix-domain socket paths are capped at roughly 104 bytes on macOS.
    // Project/test state roots can be much longer, so keep only sockets in a
    // short deterministic private namespace while persistent profile data
    // remains beside the database.
    XDG_RUNTIME_DIR: environment.AGENT_REMOTE_TERMINAL_BROWSER_RUNTIME_DIR ||
      join('/tmp', `agent-remote-tb-${userId}-${runtimeIdentity}`),
    TERMINAL_BROWSER_APPDATA: join(stateDirectory, 'terminal-browser-appdata'),
    AGENT_REMOTE_GRAPHICS: '1',
  };
}

export function terminalBrowserOwnedListing(listAllBrowsers, paths) {
  return async function listOwnedTerminalBrowsers() {
    const browsers = await listAllBrowsers();
    // Browser registry control sockets live under `instances/`; automation
    // worker sockets use the separate `agent-browser/` directory.
    return browsers.filter((browser) => inside(paths.instancesDir, browser?.socket));
  };
}

function alive(pid, killProcess) {
  try {
    killProcess(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilGone(pid, killProcess, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(pid, killProcess)) return true;
    await delay(50);
  }
  return !alive(pid, killProcess);
}

export function createTerminalBrowserSupervisor({
  override,
  environment,
  command,
  execFile,
  listBrowsers,
  reapAgentSessions,
  paths = terminalBrowserAgentPaths({ environment }),
  lsofCommand = 'lsof',
  psCommand = 'ps',
  killProcess = process.kill.bind(process),
  socketExists = existsSync,
  shutdownTimeoutMs = 5_000,
  terminateTimeoutMs = 2_000,
  sweepIntervalMs = 30_000,
} = {}) {
  if (override) return override;
  let maintenance;
  let sweepTimer;
  let stopped = false;

  async function daemonPid() {
    if (!socketExists(paths.daemonSocket)) return undefined;
    let pids;
    try {
      const { stdout } = await execFile(lsofCommand, ['-t', paths.daemonSocket], {
        encoding: 'utf8', timeout: 3_000, maxBuffer: 64 * 1024,
      });
      pids = stdout.split(/\s+/).map(Number).filter((pid) => Number.isInteger(pid) && pid > 1);
    } catch {
      return undefined;
    }
    for (const pid of pids) {
      try {
        const { stdout } = await execFile(psCommand, ['-p', String(pid), '-o', 'command='], {
          encoding: 'utf8', timeout: 3_000, maxBuffer: 256 * 1024,
        });
        const entrypoint = join(paths.distRoot, 'browser', 'dist', 'main.js');
        if (stdout.includes(entrypoint) && /(?:^|\s)--daemon(?:\s|$)/.test(stdout)) return pid;
      } catch {}
    }
    return undefined;
  }

  async function terminateHungDaemon() {
    const pid = await daemonPid();
    if (!pid) return false;
    try { killProcess(pid, 'SIGTERM'); } catch { return true; }
    if (await waitUntilGone(pid, killProcess, terminateTimeoutMs)) return true;
    try { killProcess(pid, 'SIGKILL'); } catch {}
    return waitUntilGone(pid, killProcess, 500);
  }

  async function shutdownDaemon() {
    try {
      await execFile(command, ['shutdown'], {
        encoding: 'utf8', timeout: shutdownTimeoutMs, maxBuffer: 1024 * 1024, env: environment,
      });
      await delay(100);
      return true;
    } catch {
      // terminal-browser v0.5.x cannot identify a daemon that hangs before
      // its first browser reaches the registry. Resolve the owner from our
      // private daemon socket, verify its exact executable, then stop only it.
      return terminateHungDaemon();
    }
  }

  async function reap(active = new Set()) {
    return reapAgentSessions(active, { environment, paths });
  }

  function serialize(operation) {
    if (maintenance) return maintenance;
    maintenance = operation().finally(() => { maintenance = undefined; });
    return maintenance;
  }

  function scheduleSweep() {
    if (stopped || sweepIntervalMs <= 0 || sweepTimer) return;
    sweepTimer = setTimeout(async () => {
      sweepTimer = undefined;
      await serialize(async () => {
        const active = await listBrowsers();
        const stale = await reap(new Set(active.map((browser) => browser.key).filter(Boolean)));
        if (active.length === 0 && stale.length > 0) await shutdownDaemon();
      }).catch(() => {});
      scheduleSweep();
    }, sweepIntervalMs);
    sweepTimer.unref?.();
  }

  return {
    environment,
    paths,
    listBrowsers,
    async start() {
      stopped = false;
      const result = await serialize(async () => {
        // A new server cannot adopt a prior process's renderer WebSockets or
        // CDP state. Its private daemon is therefore stale by definition.
        await shutdownDaemon();
        return reap(new Set());
      });
      scheduleSweep();
      return result;
    },
    async recover() {
      return serialize(async () => {
        const active = await listBrowsers();
        if (active.length > 0) return false;
        await reap(new Set());
        return shutdownDaemon();
      });
    },
    async sweep(activeBrowserKeys) {
      return serialize(() => reap(new Set(activeBrowserKeys)));
    },
    async stop() {
      stopped = true;
      clearTimeout(sweepTimer);
      sweepTimer = undefined;
      return serialize(async () => {
        await shutdownDaemon();
        return reap(new Set());
      });
    },
  };
}
