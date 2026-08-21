import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { createRemoteAuth } from '../src/remote/auth.js';
import { createRemoteController } from '../src/remote/controller.js';
import { createRemoteGateway } from '../src/remote/gateway.js';

const localUrl = 'http://127.0.0.1:3100';
const remoteUrl = 'http://127.0.0.1:3101';
const terminalBrowserInstalled = spawnSync('terminal-browser', ['--version'], {
  encoding: 'utf8',
  timeout: 5_000,
}).status === 0;
const hostShim = join(homedir(), '.local', 'bin', 'terminal-browser');
const terminalBrowserCommand = existsSync(hostShim) ? hostShim : 'terminal-browser';

async function localApi(request, path, options = {}) {
  return request.fetch(`${localUrl}${path}`, {
    ...options,
    headers: { Origin: localUrl, ...(options.headers || {}) },
  });
}

async function startQuickAndCreatePairing(request) {
  expect((await localApi(request, '/api/remote/tunnels/quick', { method: 'POST' })).status()).toBe(201);
  const response = await localApi(request, '/api/remote/pairing-sessions', { method: 'POST' });
  expect(response.status()).toBe(201);
  return response.json();
}

async function pairInBrowser(page, request) {
  const before = (await (await localApi(request, '/api/remote/devices')).json()).devices;
  const pairing = await startQuickAndCreatePairing(request);
  await page.goto(pairing.pairUrl);
  await expect(page.locator('#new-project')).toBeVisible();
  const after = (await (await localApi(request, '/api/remote/devices')).json()).devices;
  return { pairing, device: after.find((candidate) => !before.some(({ id }) => id === candidate.id)) };
}

async function clearRemoteCookies(context) {
  await context.clearCookies();
}

test.describe.configure({ mode: 'serial' });

test.describe('Remote gateway browser fixture', () => {
  test('HTTP public origins are rejected by default and accepted only through the explicit fixture seam', async () => {
    const auth = createRemoteAuth({ store: {} });
    await expect(auth.createPairing(remoteUrl)).rejects.toThrow(/HTTPS origin/i);
    auth.close();
    const insecureAuth = createRemoteAuth({ store: {}, allowInsecurePublicOrigin: true, secureCookies: false });
    await expect(insecureAuth.createPairing(remoteUrl)).resolves.toMatchObject({ pairUrl: expect.stringMatching(/^http:/) });
    insecureAuth.close();

    const tunnelManager = {
      status: () => ({ mode: 'quick', state: 'running', publicUrl: remoteUrl }),
      startQuick: async () => ({}), startNamed: async () => ({}), stop: async () => ({}),
    };
    const controller = createRemoteController({
      auth: { createPairing: async () => ({ pairUrl: `${remoteUrl}/pair#fixture`, expiresAt: 1 }) },
      provisioner: { validateToken: async () => [], listZones: async () => [], checkAvailability: async () => ({}), prepareNamed: async () => ({}), removeNamed: async () => ({}) },
      tokenStore: { has: async () => false, write: async () => {}, remove: async () => {} }, tunnelManager,
      inspectCloudflared: async () => ({ available: true }), platform: 'darwin', toDataURL: async () => '',
    });
    await expect(controller.createPairing()).rejects.toThrow(/running public tunnel/i);
    const insecureController = createRemoteController({
      auth: { createPairing: async () => ({ pairUrl: `${remoteUrl}/pair#fixture`, expiresAt: 1 }) },
      provisioner: { validateToken: async () => [], listZones: async () => [], checkAvailability: async () => ({}), prepareNamed: async () => ({}), removeNamed: async () => ({}) },
      tokenStore: { has: async () => false, write: async () => {}, remove: async () => {} }, tunnelManager,
      inspectCloudflared: async () => ({ available: true }), platform: 'darwin', toDataURL: async () => '',
      allowInsecurePublicOrigin: true,
    });
    await expect(insecureController.createPairing()).resolves.toMatchObject({ pairUrl: `${remoteUrl}/pair#fixture` });

    const responseFor = () => ({ status: undefined, writeHead(status) { this.status = status; }, end() {} });
    const request = { url: '/remote-auth/status', method: 'GET', headers: { host: '127.0.0.1:3101' } };
    const gateway = createRemoteGateway({ auth: { authenticate: () => undefined }, getPublicUrl: () => remoteUrl });
    const rejected = responseFor();
    await gateway.handleRequest(request, rejected, async () => {});
    expect(rejected.status).toBe(403);
    const fixtureGateway = createRemoteGateway({ auth: { authenticate: () => undefined }, getPublicUrl: () => remoteUrl, allowInsecurePublicOrigin: true });
    const accepted = responseFor();
    await fixtureGateway.handleRequest(request, accepted, async () => {});
    expect(accepted.status).toBe(200);
  });

  test('quick local connect creates a QR, pairs remotely, and exposes the full app without local administration', async ({ page, request }) => {
    const pairing = await startQuickAndCreatePairing(request);
    expect(pairing.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(pairing.pairUrl).toMatch(/^http:\/\/127\.0\.0\.1:3101\/pair#/);

    const before = (await (await localApi(request, '/api/remote/devices')).json()).devices;
    await page.goto(pairing.pairUrl);
    await expect(page.locator('#new-project')).toBeVisible();
    await expect(page.locator('#remote-button')).toHaveCount(0);
    await expect(page.locator('#remote-dialog')).toHaveCount(0);
    await expect(page.locator('#cloudflare-token-guide-dialog')).toHaveCount(0);
    await expect(page.locator('.sidebar-footer')).toHaveCount(0);
    const firstDevices = (await (await localApi(request, '/api/remote/devices')).json()).devices;
    const firstDevice = firstDevices.find((candidate) => !before.some(({ id }) => id === candidate.id));
    expect(firstDevice.name).toMatch(/^Mac · (?:Chrome|Browser)$/);

    const repeatedPairing = await startQuickAndCreatePairing(request);
    await page.goto(repeatedPairing.pairUrl);
    await expect(page.locator('#new-project')).toBeVisible();
    const repeatedDevices = (await (await localApi(request, '/api/remote/devices')).json()).devices;
    expect(repeatedDevices).toHaveLength(firstDevices.length);
    expect(repeatedDevices.find((candidate) => candidate.id === firstDevice.id)).toMatchObject({
      id: firstDevice.id, name: firstDevice.name, revokedAt: null,
    });

    const admin = await request.get('/api/remote/status');
    expect(admin.status()).toBe(404);
    expect((await page.request.get('/remote-control.js')).status()).toBe(404);
  });

  test('remote iPhone and local desktop both receive the first browser frame from one shared renderer', async ({ page, browser, request }) => {
    test.setTimeout(75_000);
    test.skip(!terminalBrowserInstalled, 'terminal-browser is not installed');
    await pairInBrowser(page, request);
    const sessionLabel = `remote-browser-${Date.now()}`;
    const created = await localApi(request, '/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      data: { commandLine: "printf '__REMOTE_BROWSER_READY__\\r\\n'", name: sessionLabel, cwd: process.cwd() },
    });
    expect(created.status()).toBe(201);
    const sessionName = (await created.json()).session.name;
    const localContext = await browser.newContext({ baseURL: localUrl, viewport: { width: 1280, height: 800 } });
    const localPage = await localContext.newPage();
    try {
      await localPage.goto('/');
      await page.goto('/');
      for (const target of [localPage, page]) {
        await target.locator('.session-row').filter({ hasText: sessionLabel }).locator('.session-button').click();
        await expect(target.locator('#status')).toHaveAttribute('data-state', 'connected');
        await expect(target.locator('#terminal-title')).toHaveText(sessionLabel);
      }

      const split = await localApi(request, '/api/control/split', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        data: {
          session: sessionName,
          argv: [terminalBrowserCommand, 'open', `${localUrl}/health`],
        },
      });
      expect(split.status()).toBe(202);
      expect((await split.json()).delivered).toBeGreaterThanOrEqual(2);
      for (const target of [localPage, page]) {
        await expect(target.locator('#graphics-split')).toBeVisible({ timeout: 10_000 });
        await expect(target.locator('.graphics-terminal-instance:not([hidden]) .graphics-loading'))
          .toContainText('Opening terminal-browser');
      }
      // Change the remote observer to an iPhone viewport while both clients
      // are attaching to the same renderer. This reproduces the production
      // race without depending on a real Cloudflare hostname in CI.
      await page.setViewportSize({ width: 390, height: 844 });

      for (const target of [localPage, page]) {
        const activeHost = target.locator('.graphics-terminal-instance:not([hidden])');
        await expect(target.locator('#graphics-split')).toBeVisible({ timeout: 10_000 });
        await expect(activeHost.locator('.graphics-terminal-transport')).toHaveCSS('visibility', 'hidden');
        await expect.poll(() => activeHost.locator('.browser-frame').evaluate((canvas) =>
          canvas.width > 0 && canvas.height > 0 &&
          canvas.closest('.graphics-terminal-instance')?.querySelector('.browser-surface')?.dataset.ready === 'true',
        ), { timeout: 60_000 }).toBe(true);
        await expect(activeHost.locator('.graphics-loading')).toBeHidden();
      }
    } finally {
      await localContext.close();
      await localApi(request, `/api/sessions/${encodeURIComponent(sessionName)}`, { method: 'DELETE' }).catch(() => {});
    }
  });

  test('a returning IndexedDB credential silently signs a new challenge after its cookie is cleared', async ({ page, context, request }) => {
    await pairInBrowser(page, request);
    await clearRemoteCookies(context);
    await page.goto('/');
    await expect(page.locator('#new-project')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/not paired/i)).toHaveCount(0);
  });

  test('local revocation returns remote HTTP 401, closes an active WebSocket with 4003, and rejects key reuse', async ({ page, context, request }) => {
    const { device } = await pairInBrowser(page, request);
    const socketResult = await page.evaluate(() => new Promise((resolve, reject) => {
      const socket = new WebSocket(`${location.origin.replace('http', 'ws')}/ws`);
      socket.addEventListener('open', () => resolve('open'), { once: true });
      socket.addEventListener('error', () => reject(new Error('socket did not open')), { once: true });
      window.__remoteE2eSocket = socket;
    }));
    expect(socketResult).toBe('open');
    const closed = page.evaluate(() => new Promise((resolve) => {
      window.__remoteE2eSocket.addEventListener('close', (event) => resolve(event.code), { once: true });
    }));

    expect(device).toBeTruthy();
    expect((await localApi(request, `/api/remote/devices/${encodeURIComponent(device.id)}`, { method: 'DELETE' })).status()).toBe(200);
    await expect.poll(() => closed).toBe(4003);
    const remainingDevices = (await (await localApi(request, '/api/remote/devices')).json()).devices;
    expect(remainingDevices.some((candidate) => candidate.id === device.id)).toBe(false);

    expect((await request.get('/api/projects')).status()).toBe(401);
    await clearRemoteCookies(context);
    await page.goto('/');
    await expect(page.locator('#entry-detail')).toContainText(/revoked|not paired/i, { timeout: 10_000 });
  });

  test('rejects expired or used QR secrets, forged signatures, wrong Origin/Host, rate limits, and keeps remote controls hidden', async ({ page, browser, request }) => {
    const expired = await startQuickAndCreatePairing(request);
    await localApi(request, '/__remote-e2e/clock?advanceMs=120000', { method: 'POST' });
    await page.goto(expired.pairUrl);
    await expect(page.getByText(/expired or was already used/i)).toBeVisible();

    const activeContext = await browser.newContext({ baseURL: remoteUrl });
    const activePage = await activeContext.newPage();
    const used = await pairInBrowser(activePage, request);
    const secret = new URL(used.pairing.pairUrl).hash.slice(1);
    const replay = await request.post('/remote-auth/pair', {
      headers: { Origin: remoteUrl, 'content-type': 'application/json' },
      data: { secret, deviceName: 'Replay', publicKeyJwk: {} },
    });
    expect(replay.status()).toBe(410);

    const deviceId = used.device.id;
    const challenge = await request.post('/remote-auth/challenge', {
      headers: { Origin: remoteUrl, 'content-type': 'application/json' }, data: { deviceId },
    });
    const challengeBody = await challenge.json();
    const forged = await request.post('/remote-auth/verify', {
      headers: { Origin: remoteUrl, 'content-type': 'application/json' },
      data: { deviceId, challengeId: challengeBody.challengeId, signature: 'AA' },
    });
    expect(forged.status()).toBe(401);

    expect((await request.post('/remote-auth/challenge', { data: { deviceId } })).status()).toBe(403);
    expect((await request.get('/remote-auth/status', { headers: { Host: 'wrong.example.test' } })).status()).toBe(403);
    for (let index = 0; index < 20; index += 1) {
      await request.post('/remote-auth/challenge', {
        headers: { Origin: remoteUrl, 'content-type': 'application/json', 'cf-connecting-ip': 'rate-limit-fixture' },
        data: { deviceId: 'missing-device' },
      });
    }
    const limited = await request.post('/remote-auth/challenge', {
      headers: { Origin: remoteUrl, 'content-type': 'application/json', 'cf-connecting-ip': 'rate-limit-fixture' },
      data: { deviceId: 'missing-device' },
    });
    expect(limited.status()).toBe(429);
    await expect(activePage.locator('#remote-button')).toBeHidden();
    await activeContext.close();
  });

  test('validated Cloudflare token stays masked and locked until it is removed', async ({ page }) => {
    await page.goto(localUrl);
    await page.locator('#remote-button').click();
    const dialog = page.locator('#remote-dialog');
    await dialog.getByRole('radio', { name: /custom domain/i }).check();
    await dialog.getByRole('button', { name: /next: custom domain/i }).click();
    const token = dialog.getByLabel(/cloudflare api token/i);
    await token.fill('fixture-token');
    await dialog.locator('#remote-token-form').getByRole('button', { name: /validate token/i }).click();
    await expect(token).toHaveValue('••••••••••••');
    await expect(token).toBeDisabled();
    await expect(dialog.getByRole('button', { name: /validate token/i })).toBeHidden();
    await expect(dialog.getByRole('button', { name: /remove token/i })).toBeEnabled();

    await dialog.getByRole('button', { name: /close remote access/i }).click();
    await page.locator('#remote-button').click();
    await dialog.getByRole('radio', { name: /custom domain/i }).check();
    await dialog.getByRole('button', { name: /next: custom domain/i }).click();
    await expect(token).toHaveValue('••••••••••••');
    await expect(token).toBeDisabled();

    await dialog.getByRole('button', { name: /remove token/i }).click();
    await expect(token).toBeEnabled();
    await expect(token).toHaveValue('');
    await expect(dialog.getByRole('button', { name: /validate token/i })).toBeVisible();
    await expect(dialog.getByRole('button', { name: /remove token/i })).toBeDisabled();
  });

  test('named fake flow validates a token, suggests conflicts, reuses owned DNS, and updates a running hostname', async ({ browser, request }) => {
    test.setTimeout(30_000);
    await localApi(request, '/api/remote/tunnels/stop', { method: 'POST' });
    const context = await browser.newContext({ baseURL: localUrl });
    const page = await context.newPage();
    await page.goto('/');
    await page.locator('#remote-button').click();
    const dialog = page.locator('#remote-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/cloudflared/i)).toBeVisible();
    await dialog.getByRole('radio', { name: /custom domain/i }).check();
    await expect(dialog.locator('#remote-power')).toBeDisabled();
    await expect(dialog.locator('#remote-power-hint'))
      .toHaveAttribute('title', 'Validate a Cloudflare API token in Domain first.');
    await dialog.getByRole('button', { name: /next: custom domain/i }).click();
    await dialog.getByLabel(/cloudflare api token/i).fill('fixture-token');
    await dialog.locator('#remote-token-form').getByRole('button', { name: /validate token/i }).click();
    await expect(dialog.getByLabel(/cloudflare api token/i)).toHaveValue('••••••••••••');
    await expect(dialog.getByLabel(/cloudflare api token/i)).toBeDisabled();
    await expect(dialog.getByRole('button', { name: /validate token/i })).toBeHidden();
    await expect(dialog.getByRole('button', { name: /remove token/i })).toBeEnabled();
    await expect(dialog.locator('#remote-zone')).toHaveValue('example.test');
    await dialog.locator('#remote-subdomain').fill('taken');
    await expect(dialog.getByText(/already in use/i)).toBeVisible({ timeout: 5_000 });
    await expect(dialog.getByRole('button', { name: /use taken-2/i })).toBeVisible();
    await dialog.getByRole('button', { name: /use taken-2/i }).click();
    await dialog.getByRole('button', { name: /^start remote$/i }).click();
    await expect(dialog.getByLabel(/remote public url/i)).toHaveValue('http://taken-2.example.test');

    await dialog.getByRole('button', { name: /^stop remote$/i }).click();
    const namedStatus = await localApi(request, '/api/remote/status');
    expect((await namedStatus.json()).named).toMatchObject({ hostname: 'taken-2.example.test', desiredState: 'stopped' });

    // Starting the same owned record again exercises the persisted-DNS reuse
    // path without any external DNS call; Stop does not remove its metadata.
    await dialog.getByRole('button', { name: /^start remote$/i }).click();
    await expect(dialog.getByLabel(/remote public url/i)).toHaveValue('http://taken-2.example.test');
    await dialog.locator('[data-remote-step-target="2"]').click();
    await dialog.locator('#remote-subdomain').fill('warn');
    await page.waitForTimeout(400);
    await expect(dialog.getByRole('button', { name: /^update & restart$/i })).toBeEnabled();
    await dialog.getByRole('button', { name: /^update & restart$/i }).click();
    await expect(dialog.getByLabel(/remote public url/i)).toHaveValue('http://warn.example.test');
    await dialog.getByRole('button', { name: /^stop remote$/i }).click();
    await dialog.locator('[data-remote-step-target="2"]').click();
    await expect(dialog.locator('#remote-remove')).toHaveCount(0);
    await dialog.getByRole('button', { name: /remove token/i }).click();
    await expect(dialog.getByLabel(/cloudflare api token/i)).toBeEnabled();
    await expect(dialog.getByLabel(/cloudflare api token/i)).toHaveValue('');
    await expect(dialog.getByRole('button', { name: /validate token/i })).toBeVisible();
    await expect(dialog.getByRole('button', { name: /remove token/i })).toBeDisabled();
    await context.close();
  });
});
