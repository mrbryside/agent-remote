import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveProjectFiles, searchProjectFiles } from '../src/conversations/files.js';

test('project file completion is fuzzy, bounded, and ignores dependency trees', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-remote-files-'));
  try {
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'node_modules', 'ignored'), { recursive: true });
    await writeFile(join(root, 'src', 'mobile-conversation.js'), 'export {};');
    await writeFile(join(root, 'src', 'server.js'), 'export {};');
    await writeFile(join(root, 'node_modules', 'ignored', 'mobile.js'), '');
    const results = await searchProjectFiles(root, 'mobconv');
    assert.equal(results[0].path, 'src/mobile-conversation.js');
    assert.equal(results.some((entry) => entry.path.includes('node_modules')), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('file mentions resolve only regular files contained by the project root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-remote-files-'));
  const outside = await mkdtemp(join(tmpdir(), 'agent-remote-outside-'));
  try {
    await writeFile(join(root, 'inside.txt'), 'inside');
    await writeFile(join(outside, 'outside.txt'), 'outside');
    await symlink(join(outside, 'outside.txt'), join(root, 'escape.txt'));
    assert.equal((await resolveProjectFiles(root, ['inside.txt']))[0].absolutePath, await realpath(join(root, 'inside.txt')));
    await assert.rejects(resolveProjectFiles(root, ['../outside.txt']), { code: 'FILE_MENTION_INVALID' });
    await assert.rejects(resolveProjectFiles(root, ['escape.txt']), { code: 'FILE_MENTION_INVALID' });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
