import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = new URL('..', import.meta.url).pathname;

test('Tauri sidecar packaging contract pins and builds both Apple Silicon sidecars', () => {
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const tauriConfig = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(root, 'src-tauri/sidecars.lock.json'), 'utf8'));
  const ignore = readFileSync(join(root, '.gitignore'), 'utf8');
  const notices = readFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8');

  for (const script of ['desktop:prepare', 'sidecar:build', 'sidecar:smoke', 'desktop:dev', 'desktop:build']) {
    assert.equal(typeof packageJson.scripts[script], 'string', `${script} script is present`);
  }
  assert.equal(packageJson.devDependencies['@tauri-apps/cli'] !== undefined, true);
  assert.equal(packageJson.devDependencies['@yao-pkg/pkg'] !== undefined, true);
  assert.deepEqual(packageJson.pkg.targets, ['node22-macos-arm64']);
  assert.match(packageJson.scripts['sidecar:smoke'], /smoke-sidecar\.js/);

  assert.equal(existsSync(join(root, 'scripts/prepare-tauri-sidecars.js')), true);
  assert.equal(existsSync(join(root, 'scripts/smoke-sidecar.js')), true);
  assert.equal(lock.cloudflared.version, '2026.8.2');
  assert.equal(lock.cloudflared.filename, 'cloudflared-darwin-arm64.tgz');
  assert.equal(
    lock.cloudflared.url,
    'https://github.com/cloudflare/cloudflared/releases/download/2026.8.2/cloudflared-darwin-arm64.tgz',
  );
  assert.match(lock.cloudflared.sha256, /^[a-f0-9]{64}$/);
  assert.equal(lock.cloudflared.license, 'Apache-2.0');
  assert.deepEqual(tauriConfig.bundle.externalBin, [
    'binaries/agent-remote-server',
    'binaries/cloudflared',
  ]);
  assert.deepEqual(tauriConfig.bundle.resources, ['binaries/agent-remote-runtime']);
  assert.match(ignore, /src-tauri\/binaries\//);
  assert.match(notices, /cloudflared[\s\S]*2026\.8\.2[\s\S]*Apache-2\.0/i);
});
