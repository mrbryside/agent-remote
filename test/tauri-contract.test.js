import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = new URL('..', import.meta.url).pathname;
const tauriDir = join(root, 'src-tauri');

test('Tauri desktop contract is a local Apple Silicon wrapper', () => {
  const config = JSON.parse(readFileSync(join(tauriDir, 'tauri.conf.json'), 'utf8'));
  const capabilities = readFileSync(join(tauriDir, 'capabilities/default.json'), 'utf8');
  const cargo = readFileSync(join(tauriDir, 'Cargo.toml'), 'utf8');
  const cargoConfig = readFileSync(join(tauriDir, '.cargo/config.toml'), 'utf8');
  const source = readFileSync(join(tauriDir, 'src/main.rs'), 'utf8');

  assert.equal(config.identifier, 'com.sirawat.agent-remote');
  assert.equal(config.build.frontendDist, '../desktop');
  assert.deepEqual(config.bundle.externalBin, [
    'binaries/agent-remote-server',
    'binaries/cloudflared',
  ]);
  assert.match(cargoConfig, /target\s*=\s*"aarch64-apple-darwin"/);
  assert.doesNotMatch(capabilities, /remote|https?:\/\//i);
  assert.match(capabilities, /"core:default"/);
  assert.doesNotMatch(capabilities, /shell:|opener:/);
  assert.doesNotMatch(cargo, /tauri-plugin-shell/);
  assert.doesNotMatch(source, /tauri_plugin_shell/);
  assert.match(source, /resolve_packaged_sidecar_path[\s\S]*sidecar_dir\.join\(name\)/);
  assert.match(source, /Show Agent Remote/);
  assert.match(source, /Open in Browser/);
  assert.match(source, /Quit/);
  assert.equal(existsSync(join(root, 'desktop/index.html')), true);
});
