#!/usr/bin/env node

import { listManagedSessions, startManagedSession, stopManagedSession } from '../src/sessions.js';

function usage() {
  console.log(`Usage:
  agent-remote <command> [args...]              Start a managed session
  agent-remote --name <name> <command> [...]   Start with a custom display name
  agent-remote list                             List managed sessions
  agent-remote stop <session-name>              Stop a managed session

Examples:
  agent-remote grok
  agent-remote claude --resume abc123
  agent-remote --name api-agent claude`);
}

async function main() {
  const input = process.argv.slice(2);
  if (input.length === 0 || input[0] === '--help' || input[0] === '-h') {
    usage();
    return;
  }

  if (input[0] === 'list') {
    const sessions = await listManagedSessions();
    if (sessions.length === 0) return console.log('No managed sessions.');
    for (const session of sessions) console.log(`${session.name}\t${session.label}\t${session.command}`);
    return;
  }

  if (input[0] === 'stop') {
    if (!input[1]) throw new Error('Usage: agent-remote stop <session-name>');
    if (!await stopManagedSession('tmux', input[1])) throw new Error(`Managed session not found: ${input[1]}`);
    console.log(`Stopped ${input[1]}`);
    return;
  }

  let requestedName;
  let cwd = process.cwd();
  while (input[0]?.startsWith('--')) {
    const option = input.shift();
    if (option === '--name') requestedName = input.shift();
    else if (option === '--cwd') cwd = input.shift();
    else throw new Error(`Unknown agent-remote option: ${option}`);
    if (!input.length) throw new Error(`${option} requires a value and command`);
  }

  const command = input.shift();
  const session = await startManagedSession({ command, args: input, cwd, requestedName });
  console.log(`Started ${session.label} (${session.name})`);
  console.log(`Command: ${session.command}`);
  console.log('Open http://127.0.0.1:3000 after running npm start.');
}

main().catch((error) => {
  console.error(`agent-remote: ${error.message}`);
  process.exitCode = 1;
});
