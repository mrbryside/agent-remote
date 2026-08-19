import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { rm } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export default async function cleanupPlaywrightTmux() {
  // Tests run on a dedicated tmux socket. Clearing it before and after the
  // suite prevents an interrupted run from being discovered by the real app
  // as an orphaned "Other sessions" chat.
  await execFileAsync(resolve('test/fixtures/tmux-playwright'), ['kill-server']).catch(() => {});
  await rm(resolve('test-results/remote-playwright'), { recursive: true, force: true }).catch(() => {});
}
