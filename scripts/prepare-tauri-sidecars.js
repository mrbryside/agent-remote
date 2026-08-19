import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { access, chmod, copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const binariesDir = join(root, 'src-tauri', 'binaries');
const target = join(binariesDir, 'cloudflared-aarch64-apple-darwin');
const serverTarget = join(binariesDir, 'agent-remote-server-aarch64-apple-darwin');
const runtimeDir = join(binariesDir, 'agent-remote-runtime');
const lock = JSON.parse(await readFile(join(root, 'src-tauri', 'sidecars.lock.json'), 'utf8')).cloudflared;

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function executable(file) {
  await access(file, constants.X_OK);
  return file;
}

async function installedVersion(file) {
  const { stdout, stderr } = await execFile(file, ['--version'], {
    encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024,
  });
  const output = `${stdout}\n${stderr}`;
  const version = output.match(/cloudflared\s+version\s+([0-9]+(?:\.[0-9]+){1,3})/i)?.[1];
  if (version !== lock.version) {
    throw new Error(`cloudflared must be ${lock.version}; ${file} reported ${version ?? 'no version'}`);
  }
}

async function downloadPinnedAsset() {
  const response = await fetch(lock.url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Could not download cloudflared ${lock.version}: HTTP ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  const actual = sha256(archive);
  if (actual !== lock.sha256) {
    throw new Error(`cloudflared checksum mismatch: expected ${lock.sha256}, received ${actual}`);
  }
  return archive;
}

async function extractDownloadedBinary() {
  const temporaryDir = await mkdtemp(join(tmpdir(), 'agent-remote-cloudflared-'));
  try {
    const archive = await downloadPinnedAsset();
    const archivePath = join(temporaryDir, lock.filename);
    await writeFile(archivePath, archive, { mode: 0o600 });
    await execFile('/usr/bin/tar', ['-xzf', archivePath, '-C', temporaryDir], { maxBuffer: 64 * 1024 });
    return join(temporaryDir, 'cloudflared');
  } catch (error) {
    await rm(temporaryDir, { recursive: true, force: true });
    throw error;
  }
}

async function copyRuntimePackage(name, copied) {
  if (copied.has(name)) return;
  copied.add(name);
  const source = join(root, 'node_modules', name);
  const destination = join(runtimeDir, 'node_modules', name);
  const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  await cp(source, destination, { recursive: true, dereference: true });
  for (const dependency of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
    await copyRuntimePackage(dependency, copied);
  }
}

async function buildNativeLauncher() {
  const temporaryDir = await mkdtemp(join(tmpdir(), 'agent-remote-launcher-'));
  const source = join(temporaryDir, 'launcher.c');
const program = `#include <limits.h>
#include <mach-o/dyld.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

extern char **environ;

int main(void) {
  char executable[PATH_MAX];
  char canonical[PATH_MAX];
  uint32_t executable_size = sizeof(executable);
  if (_NSGetExecutablePath(executable, &executable_size) != 0 || realpath(executable, canonical) == NULL) {
    fprintf(stderr, "agent-remote server launcher could not resolve itself\\n");
    return 127;
  }
  strcpy(executable, canonical);
  char *slash = strrchr(executable, '/');
  if (slash == NULL) return 127;
  *slash = '\\0';
  char packaged[PATH_MAX];
  char development[PATH_MAX];
  snprintf(packaged, sizeof(packaged), "%s/../Resources/binaries/agent-remote-runtime", executable);
  snprintf(development, sizeof(development), "%s/agent-remote-runtime", executable);
  const char *runtime = access(packaged, R_OK) == 0 ? packaged : development;
  char node[PATH_MAX];
  char entry[PATH_MAX];
  snprintf(node, sizeof(node), "%s/node", runtime);
  snprintf(entry, sizeof(entry), "%s/src/server.js", runtime);
  char *const arguments[] = { node, entry, NULL };
  execve(node, arguments, environ);
  fprintf(stderr, "agent-remote server launcher failed for %s\\n", node);
  perror("agent-remote server launcher");
  return 127;
}`;
  try {
    await writeFile(source, program, { mode: 0o600 });
    await execFile('/usr/bin/cc', ['-O2', '-arch', 'arm64', source, '-o', serverTarget], { maxBuffer: 64 * 1024 });
    await chmod(serverTarget, 0o755);
  } finally {
    await rm(temporaryDir, { recursive: true, force: true });
  }
}

async function buildServerSidecar() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error('Tauri sidecars are intentionally supported only on Darwin ARM64');
  }
  await mkdir(binariesDir, { recursive: true, mode: 0o755 });
  await rm(runtimeDir, { recursive: true, force: true });
  await mkdir(join(runtimeDir, 'node_modules'), { recursive: true, mode: 0o755 });
  await copyFile(join(root, 'node_modules', 'node', 'bin', 'node'), join(runtimeDir, 'node'));
  await chmod(join(runtimeDir, 'node'), 0o755);
  await Promise.all([
    cp(join(root, 'src'), join(runtimeDir, 'src'), { recursive: true, dereference: true }),
    cp(join(root, 'public'), join(runtimeDir, 'public'), { recursive: true, dereference: true }),
    cp(join(root, 'bin'), join(runtimeDir, 'bin'), { recursive: true, dereference: true }),
  ]);
  const copied = new Set();
  for (const dependency of [
    'node-pty', 'ws', 'qrcode', '@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-image',
    'marked', 'dompurify',
  ]) {
    await copyRuntimePackage(dependency, copied);
  }
  await chmod(join(runtimeDir, 'node_modules', 'node-pty', 'prebuilds', 'darwin-arm64', 'spawn-helper'), 0o755);
  await buildNativeLauncher();
  console.log(`Built ${serverTarget} with the Node 22 runtime at ${runtimeDir}`);
}

async function main() {
  if (process.argv.includes('--server')) return buildServerSidecar();
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error('Tauri sidecars are intentionally supported only on Darwin ARM64');
  }

  const candidates = [process.env.CLOUDFLARED_BIN, target].filter(Boolean);
  let source;
  for (const candidate of candidates) {
    try {
      await executable(candidate);
      await installedVersion(candidate);
      source = candidate;
      break;
    } catch (error) {
      if (candidate === target) continue;
      throw new Error(`CLOUDFLARED_BIN is not the pinned ${lock.version} binary: ${error.message}`);
    }
  }

  let temporaryDir;
  if (!source) {
    source = await extractDownloadedBinary();
    temporaryDir = dirname(source);
    await chmod(source, 0o755);
    await installedVersion(source);
  }

  try {
    await mkdir(binariesDir, { recursive: true, mode: 0o755 });
    await copyFile(source, target);
    await chmod(target, 0o755);
    await installedVersion(target);
  } finally {
    if (temporaryDir) await rm(temporaryDir, { recursive: true, force: true });
  }

  console.log(`Prepared ${target} (cloudflared ${lock.version})`);
}

main().catch((error) => {
  console.error(`desktop:prepare failed: ${error.message}`);
  process.exitCode = 1;
});
