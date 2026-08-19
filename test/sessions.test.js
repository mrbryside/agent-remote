import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { commandExists } from '../src/config.js';
import { prepareManagedCommand, shellQuote, slugify } from '../src/sessions.js';

test('quotes command arguments without changing their shell value', () => {
  assert.equal(shellQuote('plain-value'), 'plain-value');
  assert.equal(shellQuote('two words'), "'two words'");
  assert.equal(shellQuote("it's"), "'it'\"'\"'s'");
});

test('creates safe readable session slugs', () => {
  assert.equal(slugify('API Agent #1'), 'api-agent-1');
  assert.equal(slugify('ภาษาไทย'), 'session');
});

test('prepares interactive Grok sessions for the shared ACP leader', () => {
  const id = '01a015a9-61df-7052-a5d0-17de77a201fa';
  assert.deepEqual(prepareManagedCommand('grok --always-approve', id), {
    commandLine: `grok --leader --session-id ${id} --always-approve`,
    conversationThreadId: id,
  });
  assert.deepEqual(prepareManagedCommand('/opt/bin/grok --leader --session-id 01a015a9-61df-7052-a5d0-17de77a201fb', id), {
    commandLine: '/opt/bin/grok --leader --session-id 01a015a9-61df-7052-a5d0-17de77a201fb',
    conversationThreadId: '01a015a9-61df-7052-a5d0-17de77a201fb',
  });
  for (const commandLine of ['grok agent --leader stdio', 'grok --resume old', 'grok -p hello', 'bash']) {
    assert.deepEqual(prepareManagedCommand(commandLine, id), {
      commandLine, conversationThreadId: undefined,
    });
  }
});

test('agent-remote CLI starts, lists, and stops a managed command session', (context) => {
  if (!commandExists('tmux')) {
    context.skip('tmux is not installed');
    return;
  }
  const label = `cli-${process.pid}`;
  const name = `ar-${label}`;
  try {
    const started = execFileSync(process.execPath, ['bin/agent-remote.js', '--name', label, 'printf', '__CLI_OK__'], { encoding: 'utf8' });
    assert.match(started, new RegExp(`Started ${label} \\(${name}\\)`));
    const listed = execFileSync(process.execPath, ['bin/agent-remote.js', 'list'], { encoding: 'utf8' });
    assert.match(listed, new RegExp(`${name}\\t${label}\\tprintf __CLI_OK__`));
    const windowSize = execFileSync('tmux', ['show-options', '-A', '-w', '-t', name, '-v', 'window-size'], { encoding: 'utf8' }).trim();
    assert.equal(windowSize, 'largest');
    const stopped = execFileSync(process.execPath, ['bin/agent-remote.js', 'stop', name], { encoding: 'utf8' });
    assert.match(stopped, new RegExp(`Stopped ${name}`));
  } finally {
    try { execFileSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' }); } catch {}
  }
});
