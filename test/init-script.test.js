import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const installer = join(root, 'init.sh');
const releaseDmg = join(root, 'releases', 'v1.0.0', 'Agent Remote_1.0.0_aarch64.dmg');

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

test('init script is valid POSIX shell and documents custom install modes', async () => {
  await execFileAsync('/bin/sh', ['-n', installer]);
  const { stdout } = await execFileAsync('/bin/sh', [installer, '--help']);
  assert.match(stdout, /--install-dir <folder>/);
  assert.match(stdout, /--source-dir <folder>/);
  assert.match(stdout, /--app-bundle <path>/);
  assert.match(stdout, /--dmg <path>/);
  assert.match(stdout, /approve dependency setup/);
  assert.match(stdout, /tmux is installed automatically/);
  assert.match(stdout, /prebuilt, checksum-verified Tauri app/);
  assert.match(stdout, /Paths beginning[\s\S]*with ~\//);
});

test('init script installs tmux and only bootstraps Homebrew with consent', async () => {
  const installerSource = await readFile(installer, 'utf8');
  assert.match(installerSource, /ensure_tmux\(\)/);
  assert.match(installerSource, /\"\$brew_path\" install tmux/);
  assert.match(installerSource, /confirm_homebrew_install\(\)/);
  assert.match(installerSource, /--yes to approve automatic setup/);
  assert.match(installerSource, /raw\.githubusercontent\.com\/Homebrew\/install\/HEAD\/install\.sh/);
});

test('prebuilt release fits raw GitHub hosting and matches the installer checksum', async () => {
  const installerSource = await readFile(installer, 'utf8');
  const configuredHash = installerSource.match(/AGENT_REMOTE_DMG_SHA256:-([a-f0-9]{64})/)?.[1];
  assert.ok(configuredHash, 'init.sh must pin the release SHA-256');
  assert.equal((await stat(releaseDmg)).size < 100 * 1024 * 1024, true);
  assert.equal(await sha256(releaseDmg), configuredHash);
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
