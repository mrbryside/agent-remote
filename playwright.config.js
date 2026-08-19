import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';

export default defineConfig({
  testDir: './test',
  testMatch: '*.spec.js',
  globalSetup: './test/cleanup-playwright-tmux.js',
  globalTeardown: './test/cleanup-playwright-tmux.js',
  timeout: 15_000,
  retries: 0,
  // The browser renderer, tmux server and SQLite database are process-global
  // integration fixtures, so parallel workers would mutate each other's state.
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:3100',
    headless: true,
  },
  projects: [
    { name: 'local', testIgnore: /remote-e2e\.spec\.js/ },
    {
      name: 'remote',
      testMatch: /remote-e2e\.spec\.js/,
      use: { baseURL: 'http://127.0.0.1:3101' },
    },
  ],
  webServer: {
    command: 'node test/fixtures/remote-playwright-server.js',
    url: 'http://127.0.0.1:3100/health',
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: '3100',
      TERMINAL_SHELL: '/bin/sh',
      TERMINAL_SHELL_ARGS: '[]',
      TMUX_COMMAND: resolve('test/fixtures/tmux-playwright'),
      TMUX_SESSION: '',
      AGENT_REMOTE_TMUX_SHELL: '0',
      AGENT_REMOTE_DB_PATH: resolve('test-results/agent-remote.db'),
    },
    reuseExistingServer: false,
    timeout: 10_000,
  },
});
