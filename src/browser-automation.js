import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

function runtimeRoot(environment, home) {
  if (isAbsolute(environment.XDG_RUNTIME_DIR || '')) return environment.XDG_RUNTIME_DIR;
  if (isAbsolute(environment.XDG_STATE_HOME || '')) return environment.XDG_STATE_HOME;
  return join(home, '.local', 'state');
}

export function terminalBrowserAgentPaths({ environment = process.env, home = homedir() } = {}) {
  const distRoot = isAbsolute(environment.TERMINAL_BROWSER_DIST_ROOT || '')
    ? environment.TERMINAL_BROWSER_DIST_ROOT
    : join(home, '.local', 'share', 'terminal-browser', 'app');
  let physicalDistRoot = distRoot;
  try { physicalDistRoot = realpathSync(distRoot); } catch {}
  // terminal-browser isolates every installation under a hash of its physical
  // distribution root. The old un-hashed path silently made the startup
  // reaper a no-op, leaving every agent-browser worker behind after its owner
  // closed until the accumulated Chromium processes exhausted the host.
  const suffix = createHash('sha256').update(physicalDistRoot).digest('hex').slice(0, 8);
  const runtimeDir = join(runtimeRoot(environment, home), `terminal-browser-${suffix}`);
  return {
    distRoot: physicalDistRoot,
    runtimeDir,
    instancesDir: join(runtimeDir, 'instances'),
    socketDir: join(runtimeDir, 'agent-browser'),
    daemonSocket: join(runtimeDir, 'daemon.sock'),
    binary: environment.TERMINAL_BROWSER_AGENT || join(physicalDistRoot, 'agent-browser', 'bin', 'agent-browser'),
  };
}

function runAgentBrowser(binary, args, options) {
  return new Promise((resolve, reject) => {
    execFile(binary, args, options, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function safeBrowserKey(browserKey) {
  return typeof browserKey === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(browserKey);
}

export async function closeTerminalBrowserAgentSession(browserKey, options = {}) {
  if (!safeBrowserKey(browserKey)) return false;
  const environment = options.environment ?? process.env;
  const paths = options.paths ?? terminalBrowserAgentPaths({ environment, home: options.home });
  const session = `terminal-browser-${browserKey}`;
  if (!(options.exists ?? existsSync)(join(paths.socketDir, `${session}.sock`))) return false;
  try {
    await (options.run ?? runAgentBrowser)(paths.binary, ['--session', session, 'close'], {
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
      env: { ...environment, AGENT_BROWSER_SOCKET_DIR: paths.socketDir },
    });
    return true;
  } catch (error) {
    options.onError?.(error);
    return false;
  }
}

export async function reapStaleTerminalBrowserAgentSessions(activeBrowserKeys, options = {}) {
  const environment = options.environment ?? process.env;
  const paths = options.paths ?? terminalBrowserAgentPaths({ environment, home: options.home });
  const active = new Set([...activeBrowserKeys].filter(safeBrowserKey));
  let entries;
  try {
    entries = (options.readDir ?? readdirSync)(paths.socketDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const stale = entries
    .filter((entry) => entry.isSocket?.() && entry.name.startsWith('terminal-browser-') && entry.name.endsWith('.sock'))
    .map((entry) => entry.name.slice('terminal-browser-'.length, -'.sock'.length))
    .filter((key) => safeBrowserKey(key) && !active.has(key));
  // Close sequentially. Reaping a crash backlog is exactly when the host is
  // resource constrained; spawning one cleanup client per stale worker at
  // once can otherwise trigger the same signal-9 pressure we are recovering.
  for (const key of stale) {
    await closeTerminalBrowserAgentSession(key, { ...options, environment, paths });
  }
  return stale;
}
