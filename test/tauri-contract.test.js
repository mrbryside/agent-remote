import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = new URL('..', import.meta.url).pathname;
const tauriDir = join(root, 'src-tauri');

test('Tauri desktop contract is a local Apple Silicon wrapper', () => {
  const config = JSON.parse(readFileSync(join(tauriDir, 'tauri.conf.json'), 'utf8'));
  const capabilities = readFileSync(join(tauriDir, 'capabilities/default.json'), 'utf8');
  const windowControls = JSON.parse(readFileSync(
    join(tauriDir, 'capabilities/desktop-window-controls.json'), 'utf8',
  ));
  const cargo = readFileSync(join(tauriDir, 'Cargo.toml'), 'utf8');
  const cargoConfig = readFileSync(join(tauriDir, '.cargo/config.toml'), 'utf8');
  const source = readFileSync(join(tauriDir, 'src/main.rs'), 'utf8');

  assert.equal(config.identifier, 'com.sirawat.agent-remote');
  assert.equal(config.build.frontendDist, '../desktop');
  assert.equal(config.app.windows[0].titleBarStyle, 'Overlay');
  assert.deepEqual(config.app.windows[0].trafficLightPosition, { x: 12, y: 10 });
  assert.equal(config.app.windows[0].hiddenTitle, true);
  assert.deepEqual(config.bundle.externalBin, [
    'binaries/agent-remote-server',
    'binaries/cloudflared',
  ]);
  assert.match(cargoConfig, /target\s*=\s*"aarch64-apple-darwin"/);
  assert.doesNotMatch(capabilities, /remote|https?:\/\//i);
  assert.match(capabilities, /"core:default"/);
  assert.doesNotMatch(capabilities, /shell:|opener:/);
  assert.equal(windowControls.local, false);
  assert.deepEqual(windowControls.remote.urls, ['http://127.0.0.1:3000/*']);
  assert.deepEqual(windowControls.windows, ['main']);
  assert.deepEqual(windowControls.permissions, [
    'core:window:allow-start-dragging',
    'core:window:allow-internal-toggle-maximize',
  ]);
  assert.doesNotMatch(cargo, /tauri-plugin-shell/);
  assert.doesNotMatch(source, /tauri_plugin_shell/);
  assert.match(source, /resolve_packaged_sidecar_path[\s\S]*sidecar_dir\.join\(name\)/);
  assert.match(source, /Show Agent Remote/);
  assert.match(source, /Open in Browser/);
  assert.match(source, /Quit/);
  assert.match(source, /\.env\("HOST", "127\.0\.0\.1"\)/);
  assert.match(source, /\.env\("PORT", "3000"\)/);
  assert.match(source, /\.env\("REMOTE_HOST", "127\.0\.0\.1"\)/);
  assert.match(source, /\.env\("REMOTE_PORT", "3001"\)/);
  assert.match(source, /AGENT_REMOTE_PARENT_PID/);
  assert.match(source, /start_backend_supervisor/);
  assert.match(source, /RunEvent::Resumed/);
  assert.match(source, /RunEvent::Reopen/);
  assert.match(source, /RunEvent::Exit/);
  assert.match(source, /agent-remote-resume/);
  assert.match(source, /desktopShell = 'tauri'/);
  const appDocument = readFileSync(join(root, 'public/index.html'), 'utf8');
  assert.match(appDocument, /class="sidebar-header" data-tauri-drag-region="deep"/);
  assert.match(appDocument, /class="topbar" data-tauri-drag-region="deep"/);
  assert.match(source, /UserInitiatedAllowingIdleSystemSleep/);
  assert.match(source, /runtime\.remote_ready/);
  assert.equal(existsSync(join(root, 'desktop/index.html')), true);
  assert.deepEqual(
    readFileSync(join(tauriDir, 'icons/icon.png')),
    readFileSync(join(root, 'public/icon-512.png')),
    'the Tauri app icon must be the exact PWA icon asset',
  );
});
