import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const installer = join(root, 'init.sh');

test('init script is valid POSIX shell and documents custom install modes', async () => {
  await execFileAsync('/bin/sh', ['-n', installer]);
  const { stdout } = await execFileAsync('/bin/sh', [installer, '--help']);
  assert.match(stdout, /--install-dir <folder>/);
  assert.match(stdout, /--source-dir <folder>/);
  assert.match(stdout, /--app-bundle <path>/);
  assert.match(stdout, /Paths beginning[\s\S]*with ~\//);
});

test('init script installs and replaces a validated bundle in a custom folder', {
  skip: process.platform !== 'darwin' || process.arch !== 'arm64',
}, async (context) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'agent-remote-init-test-'));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));

  const sourceBundle = join(temporaryRoot, 'Build Output', 'Agent Remote.app');
  const macosDir = join(sourceBundle, 'Contents', 'MacOS');
  const runtimeDir = join(sourceBundle, 'Contents', 'Resources', 'binaries', 'agent-remote-runtime');
  await mkdir(macosDir, { recursive: true });
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(join(sourceBundle, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.sirawat.agent-remote</string></dict></plist>
`);
  for (const executable of [
    join(macosDir, 'agent-remote-desktop'),
    join(macosDir, 'agent-remote-server'),
    join(macosDir, 'cloudflared'),
    join(runtimeDir, 'node'),
  ]) {
    await writeFile(executable, '#!/bin/sh\nexit 0\n');
    await chmod(executable, 0o755);
  }

  const installDir = join(temporaryRoot, 'Custom App Folder');
  const arguments_ = [
    '--app-bundle', sourceBundle,
    '--install-dir', installDir,
    '--yes',
    '--no-launch',
  ];
  await execFileAsync('/bin/sh', [installer, ...arguments_], { cwd: root });

  const installedExecutable = join(installDir, 'Agent Remote.app', 'Contents', 'MacOS', 'agent-remote-desktop');
  assert.equal((await lstat(join(installDir, 'Agent Remote.app'))).isSymbolicLink(), false);
  assert.equal((await lstat(installedExecutable)).mode & 0o111, 0o111);

  await writeFile(join(sourceBundle, 'Contents', 'install-marker.txt'), 'replacement');
  await execFileAsync('/bin/sh', [installer, ...arguments_], { cwd: root });
  assert.equal(
    await readFile(join(installDir, 'Agent Remote.app', 'Contents', 'install-marker.txt'), 'utf8'),
    'replacement',
  );
});
