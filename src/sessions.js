import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { commandExists } from './config.js';

const execFileAsync = promisify(execFile);
const separator = '\x1f';
const agentRemoteBin = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin');
export const validSessionName = /^[A-Za-z0-9_.-]{1,64}$/;
const grokSessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function tmux(command, args) {
  const { stdout } = await execFileAsync(command, args, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  return stdout;
}

function target(name) {
  if (!validSessionName.test(name)) throw new Error('Invalid session name');
  return name;
}

export function shellQuote(value) {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

export function slugify(value) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || 'session';
}

export async function sessionExists(command, name) {
  try {
    await tmux(command, ['has-session', '-t', target(name)]);
    return true;
  } catch {
    return false;
  }
}

export async function stabilizeManagedSessionSize(command, name) {
  await tmux(command, ['set-window-option', '-t', target(name), 'window-size', 'largest']);
}

export async function managedSessionProcessId(command, name) {
  const output = await tmux(command, ['list-panes', '-t', target(name), '-F', '#{pane_pid}']);
  const processId = Number(output.trim().split('\n')[0]);
  return Number.isInteger(processId) && processId > 0 ? processId : undefined;
}

export async function sendManagedSessionInput(command, name, data, {
  submitDelayMs = 100,
  runTmux = tmux,
} = {}) {
  if (typeof data !== 'string') throw new Error('Session input must be a string');
  const submit = data.endsWith('\r');
  const input = submit ? data.slice(0, -1) : data;
  if (input) await runTmux(command, ['send-keys', '-t', target(name), '-l', input]);
  if (submit) {
    await new Promise((resolve) => setTimeout(resolve, submitDelayMs));
    await runTmux(command, ['send-keys', '-t', target(name), 'Enter']);
  }
}

export function prepareManagedCommand(commandLine, sessionId = randomUUID()) {
  const match = commandLine.match(/^(\s*(?:['"]?[^\s'"]*\/)?grok['"]?)(?=\s|$)([\s\S]*)$/i);
  if (!match) return { commandLine, conversationThreadId: undefined };
  const rest = match[2] || '';
  if (/^\s*agent(?:\s|$)/i.test(rest) || /(?:^|\s)(?:-p|--prompt|--resume)(?:\s|=|$)/i.test(rest)) {
    return { commandLine, conversationThreadId: undefined };
  }
  const suppliedId = rest.match(/(?:^|\s)--session-id(?:=|\s+)([0-9a-f-]{36})(?=\s|$)/i)?.[1];
  const conversationThreadId = grokSessionIdPattern.test(suppliedId || '') ? suppliedId : sessionId;
  const flags = [
    /(?:^|\s)--leader(?:\s|$)/i.test(rest) ? '' : ' --leader',
    suppliedId ? '' : ` --session-id ${conversationThreadId}`,
  ].join('');
  return { commandLine: `${match[1]}${flags}${rest}`, conversationThreadId };
}

const reservedSessionNames = new Set();

async function reserveSessionName(command, baseName) {
  let existing = new Set();
  try {
    const output = await tmux(command, ['list-sessions', '-F', '#{session_name}']);
    existing = new Set(output.trim().split('\n').filter(Boolean));
  } catch {
    // tmux exits non-zero when it has no server/sessions yet.
  }
  let name = baseName;
  let suffix = 2;
  while (existing.has(name) || reservedSessionNames.has(name)) name = `${baseName}-${suffix++}`;
  reservedSessionNames.add(name);
  return name;
}

export async function listManagedSessions(command = 'tmux') {
  if (!commandExists(command)) return [];
  let output;
  try {
    output = await tmux(command, [
      'list-sessions',
      '-F',
      ['#{session_name}', '#{session_windows}', '#{session_attached}', '#{session_created}', '#{@agent_remote}', '#{@agent_remote_label}', '#{@agent_remote_command}', '#{pane_current_path}', '#{@agent_remote_project}', '#{@agent_remote_auto_title}', '#{@agent_remote_conversation_thread}'].join(separator),
    ]);
  } catch {
    return [];
  }

  return output
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, windows, attached, created, managed, label, sessionCommand, cwd, projectId, autoTitle, conversationThreadId] = line.split(separator);
      return {
        name,
        label: label || name,
        command: sessionCommand || '',
        cwd: cwd || '',
        windows: Number(windows),
        attached: Number(attached),
        createdAt: Number(created) * 1000,
        managed: managed === '1',
        projectId: projectId || null,
        autoTitle: autoTitle === '1',
        conversationThreadId: grokSessionIdPattern.test(conversationThreadId || '') ? conversationThreadId : null,
      };
    })
    .filter((session) => session.managed)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function startManagedSession({
  tmuxCommand = 'tmux',
  command,
  args = [],
  rawCommand,
  cwd = process.cwd(),
  requestedName,
  agentRemoteUrl = process.env.AGENT_REMOTE_URL || 'http://127.0.0.1:3000',
  agentRemoteToken = process.env.AGENT_REMOTE_TOKEN || '',
  projectId,
  autoTitle = false,
}) {
  if (!commandExists(tmuxCommand)) throw new Error('tmux is not installed');
  if (!command && !rawCommand) throw new Error('A command is required');
  if (requestedName && /[\x00-\x1f\x7f]/.test(requestedName)) throw new Error('Session name contains control characters');
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
    throw new Error('Arguments must be strings');
  }

  const requestedCommandLine = rawCommand?.trim() || [command, ...args].map(shellQuote).join(' ');
  if (!requestedCommandLine) throw new Error('A command is required');
  const prepared = prepareManagedCommand(requestedCommandLine);
  const commandLine = prepared.commandLine;
  const conversationThreadId = prepared.conversationThreadId;
  const commandLabel = command || requestedCommandLine.split(/\s+/)[0];
  const label = slugify(requestedName || commandLabel.split('/').at(-1));
  const baseName = `ar-${label}`;
  const sessionPath = `${agentRemoteBin}${delimiter}${process.env.PATH ?? ''}`;
  // `has-session` followed by `new-session` is a TOCTOU race when several
  // chats are started at once. Let tmux atomically claim the name instead and
  // only retry the request that lost the race. This keeps rapid creates
  // concurrent without ever attaching two UI rows to the same tmux session.
  let name;
  for (;;) {
    name = await reserveSessionName(tmuxCommand, baseName);
    try {
      await tmux(tmuxCommand, [
        'new-session', '-d', '-s', name, '-c', cwd,
        '-e', `PATH=${sessionPath}`,
        '-e', 'AGENT_REMOTE_WEB=1',
        '-e', `AGENT_REMOTE_URL=${agentRemoteUrl}`,
        '-e', `AGENT_REMOTE_SESSION=${name}`,
        '-e', `AGENT_REMOTE_TOKEN=${agentRemoteToken}`,
        '-e', 'TERM_PROGRAM=agent-remote',
      ]);
      break;
    } catch (error) {
      reservedSessionNames.delete(name);
      if (!(await sessionExists(tmuxCommand, name))) throw error;
    } finally {
      reservedSessionNames.delete(name);
    }
  }
  try {
    await tmux(tmuxCommand, ['set-option', '-t', target(name), '@agent_remote', '1']);
    await tmux(tmuxCommand, ['set-option', '-t', target(name), 'status', 'off']);
    // A managed pane may be viewed from a desktop and a phone at the same
    // time. tmux defaults to `latest`, so touching the narrow phone client
    // shrinks the shared window and fills the desktop client with padding.
    // `largest` keeps the biggest connected viewport authoritative while
    // tmux safely crops the same pane for smaller clients.
    await stabilizeManagedSessionSize(tmuxCommand, name);
    await tmux(tmuxCommand, ['set-option', '-t', target(name), '@agent_remote_label', requestedName || label]);
    await tmux(tmuxCommand, ['set-option', '-t', target(name), '@agent_remote_command', commandLine.replace(/[\r\n]+/g, ' ')]);
    if (conversationThreadId) {
      await tmux(tmuxCommand, ['set-option', '-t', target(name), '@agent_remote_conversation_thread', conversationThreadId]);
    }
    if (projectId) await tmux(tmuxCommand, ['set-option', '-t', target(name), '@agent_remote_project', projectId]);
    await tmux(tmuxCommand, ['set-option', '-t', target(name), '@agent_remote_auto_title', autoTitle ? '1' : '0']);
    const bootstrap = [
      `PATH=${shellQuote(agentRemoteBin)}:"$PATH"`,
      'AGENT_REMOTE_WEB=1',
      `AGENT_REMOTE_URL=${shellQuote(agentRemoteUrl)}`,
      `AGENT_REMOTE_SESSION=${shellQuote(name)}`,
      `AGENT_REMOTE_TOKEN=${shellQuote(agentRemoteToken)}`,
      'TERM_PROGRAM=agent-remote',
    ].join(' ');
    const exportCommand = `export ${bootstrap}`;
    await tmux(tmuxCommand, ['send-keys', '-t', target(name), '-l', exportCommand]);
    await tmux(tmuxCommand, ['send-keys', '-t', target(name), 'Enter']);
    await tmux(tmuxCommand, ['send-keys', '-t', target(name), '-l', commandLine]);
    await tmux(tmuxCommand, ['send-keys', '-t', target(name), 'Enter']);
  } catch (error) {
    await tmux(tmuxCommand, ['kill-session', '-t', target(name)]).catch(() => {});
    throw error;
  }

  return {
    name, label: requestedName || label, command: commandLine, cwd,
    projectId: projectId || null, autoTitle, conversationThreadId: conversationThreadId || null,
  };
}

export async function renameManagedSession(command, name, label) {
  const normalized = label.trim().replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').slice(0, 80);
  if (!normalized) throw new Error('Session title cannot be empty');
  const sessions = await listManagedSessions(command);
  if (!sessions.some((session) => session.name === name)) return undefined;
  await tmux(command, ['set-option', '-t', target(name), '@agent_remote_label', normalized]);
  await tmux(command, ['set-option', '-t', target(name), '@agent_remote_auto_title', '0']);
  return normalized;
}

export async function stopManagedSession(command, name) {
  const sessions = await listManagedSessions(command);
  if (!sessions.some((session) => session.name === name)) return false;
  await tmux(command, ['kill-session', '-t', target(name)]);
  return true;
}
