import { access, chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const dispatcher = join(projectRoot, 'bin', 'terminal-browser');
const realBinary = join(homedir(), '.local', 'share', 'terminal-browser', 'app', 'bin', 'terminal-browser');
const hostShim = join(homedir(), '.local', 'bin', 'terminal-browser');
const desired = `#!/bin/sh\nexport TERMINAL_BROWSER_REAL=${JSON.stringify(realBinary)}\nexec ${JSON.stringify(dispatcher)} "$@"\n`;

try {
  await access(realBinary, constants.X_OK);
} catch {
  process.exit(0);
}

let current = '';
try {
  current = await readFile(hostShim, 'utf8');
} catch {
  // The shim will be created below.
}

if (current === desired) {
  await chmod(hostShim, 0o755);
  process.exit(0);
}

const safeToReplace = !current ||
  current.includes(realBinary) ||
  current.includes(dispatcher);
if (!safeToReplace) {
  console.warn(`agent-remote: left custom terminal-browser launcher unchanged: ${hostShim}`);
  process.exit(0);
}

await mkdir(dirname(hostShim), { recursive: true });
await writeFile(hostShim, desired, { mode: 0o755 });
await chmod(hostShim, 0o755);
console.log(`agent-remote: terminal-browser dispatcher ready at ${hostShim}`);
