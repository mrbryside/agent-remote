import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

export function commandExists(command, envPath = process.env.PATH ?? '') {
  if (command.includes('/')) {
    try {
      accessSync(command, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  return envPath.split(delimiter).some((directory) => {
    try {
      accessSync(`${directory}/${command}`, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function parseArguments(value, fallback) {
  if (value === undefined) return fallback;
  if (value.trim() === '') return [];

  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
      throw new Error('must be a JSON array of strings');
    }
    return parsed;
  } catch (error) {
    throw new Error(`TERMINAL_SHELL_ARGS ${error.message}`);
  }
}

function parsePort(value, name) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`${name} must be an integer from 0 to 65535`);
  }
  return port;
}

function parseRemoteHost(value) {
  if (value !== '127.0.0.1') {
    throw new Error('REMOTE_HOST must be 127.0.0.1');
  }
  return value;
}

function isLoopbackHost(value) {
  if (value === 'localhost' || value === '::1' || value === '[::1]') return true;
  const octets = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  return Boolean(octets) && octets.slice(1).every((octet) => Number(octet) <= 255);
}

export function loadConfig(overrides = {}) {
  const env = overrides.env ?? process.env;
  const port = Number(overrides.port ?? env.PORT ?? 3000);
  const host = overrides.host ?? env.HOST ?? '127.0.0.1';
  const token = overrides.token ?? env.TERMINAL_TOKEN ?? '';
  if (!isLoopbackHost(host) && (typeof token !== 'string' || !token.trim())) {
    throw new Error('TERMINAL_TOKEN is required when HOST is not a loopback address');
  }
  const remoteHost = parseRemoteHost(overrides.remoteHost ?? env.REMOTE_HOST ?? '127.0.0.1');
  const remotePort = parsePort(
    overrides.remotePort ?? env.REMOTE_PORT ?? (port === 0 ? 0 : port + 1),
    'REMOTE_PORT',
  );
  const tmuxSession = overrides.tmuxSession ?? env.TMUX_SESSION?.trim();
  const tmuxCommand = overrides.tmuxCommand ?? env.TMUX_COMMAND ?? 'tmux';
  const shell = overrides.shell ?? env.TERMINAL_SHELL ?? env.SHELL ?? '/bin/zsh';
  const shellArgs = overrides.shellArgs ?? parseArguments(env.TERMINAL_SHELL_ARGS, ['-l']);
  const useTmux = Boolean(tmuxSession) && commandExists(tmuxCommand, env.PATH);
  const tmuxShell = overrides.tmuxShell ?? env.AGENT_REMOTE_TMUX_SHELL !== '0';
  const useTmuxShell = !useTmux && tmuxShell && commandExists(tmuxCommand, env.PATH);
  const tmuxShellSession = overrides.tmuxShellSession ?? env.AGENT_REMOTE_SHELL_SESSION ?? 'agent-remote-shell';
  const configuredRoots = env.ALLOWED_CWD_ROOTS
    ? env.ALLOWED_CWD_ROOTS.split(',').map((root) => root.trim()).filter(Boolean)
    : [homedir(), process.cwd()];
  const databaseFile = resolve(
    overrides.databaseFile ?? env.AGENT_REMOTE_DB_PATH ?? join(homedir(), '.agent-remote', 'agent-remote.db'),
  );
  const grokLeaderSocket = resolve(
    overrides.grokLeaderSocket ?? env.AGENT_REMOTE_GROK_LEADER_SOCKET ?? `${databaseFile}.grok.sock`,
  );

  return {
    host,
    port,
    remoteHost,
    remotePort,
    cloudflaredBin: overrides.cloudflaredBin ?? env.CLOUDFLARED_BIN ?? 'cloudflared',
    desktopMode: overrides.desktopMode ?? env.AGENT_REMOTE_DESKTOP === '1',
    pairingTtlMs: 120_000,
    challengeTtlMs: 60_000,
    remoteSessionTtlMs: 43_200_000,
    token,
    allowedOrigins: overrides.allowedOrigins ?? (env.ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    allowedCwdRoots: [...new Set((overrides.allowedCwdRoots ?? configuredRoots).map((root) => resolve(root)))],
    databaseFile,
    grokLeaderSocket,
    maxConnections: Number(overrides.maxConnections ?? env.MAX_CONNECTIONS ?? 20),
    cwd: overrides.cwd ?? env.TERMINAL_CWD ?? process.cwd(),
    shell,
    shellArgs,
    tmuxSession,
    tmuxCommand,
    useTmux,
    useTmuxShell,
    tmuxBacked: useTmux || useTmuxShell,
    tmuxShellSession,
    command: useTmux || useTmuxShell ? tmuxCommand : shell,
    args: useTmux
      ? ['new-session', '-A', '-s', tmuxSession]
      : useTmuxShell
        ? ['new-session', '-A', '-s', tmuxShellSession]
        : shellArgs,
  };
}
