import { expect, test } from '@playwright/test';
import { createRemoteAuth } from '../src/remote/auth.js';
import { createRemoteController } from '../src/remote/controller.js';
import { createRemoteGateway } from '../src/remote/gateway.js';

const localUrl = 'http://127.0.0.1:3100';
const remoteUrl = 'http://127.0.0.1:3101';

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

async function pairInBrowser(page, request, name = 'Remote E2E device') {
  const pairing = await startQuickAndCreatePairing(request);
  await page.goto(pairing.pairUrl);
  await expect(page.getByLabel(/device name/i)).toBeVisible();
  await page.getByLabel(/device name/i).fill(name);
  await page.getByRole('button', { name: /pair this device/i }).click();
  await expect(page.locator('#new-project')).toBeVisible();
  return pairing;
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

    await page.goto(pairing.pairUrl);
    await page.getByLabel(/device name/i).fill('Quick phone');
    await page.getByRole('button', { name: /pair this device/i }).click();
    await expect(page.locator('#new-project')).toBeVisible();
    await expect(page.locator('#remote-button')).toBeHidden();

    const admin = await request.get('/api/remote/status');
    expect(admin.status()).toBe(404);
    await expect(page.locator('#remote-dialog')).toBeHidden();
  });

  test('a returning IndexedDB credential silently signs a new challenge after its cookie is cleared', async ({ page, context, request }) => {
    await pairInBrowser(page, request, 'Returning device');
    await clearRemoteCookies(context);
    await page.goto('/');
    await expect(page.locator('#new-project')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/not paired/i)).toHaveCount(0);
  });

  test('local revocation returns remote HTTP 401, closes an active WebSocket with 4003, and rejects key reuse', async ({ page, context, request }) => {
    await pairInBrowser(page, request, 'Revoked device');
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

    const devices = await localApi(request, '/api/remote/devices');
    const device = (await devices.json()).devices.find((candidate) => candidate.name === 'Revoked device');
    expect(device).toBeTruthy();
    expect((await localApi(request, `/api/remote/devices/${encodeURIComponent(device.id)}`, { method: 'DELETE' })).status()).toBe(200);
    await expect.poll(() => closed).toBe(4003);

    expect((await request.get('/api/projects')).status()).toBe(401);
    await clearRemoteCookies(context);
    await page.goto('/');
    await expect(page.locator('#entry-detail')).toContainText(/revoked|not paired/i, { timeout: 10_000 });
  });

  test('rejects expired or used QR secrets, forged signatures, wrong Origin/Host, rate limits, and keeps remote controls hidden', async ({ page, browser, request }) => {
    const expired = await startQuickAndCreatePairing(request);
    await localApi(request, '/__remote-e2e/clock?advanceMs=120000', { method: 'POST' });
    await page.goto(expired.pairUrl);
    await page.getByLabel(/device name/i).fill('Expired phone');
    await page.getByRole('button', { name: /pair this device/i }).click();
    await expect(page.getByText(/expired or was already used/i)).toBeVisible();

    const activeContext = await browser.newContext({ baseURL: remoteUrl });
    const activePage = await activeContext.newPage();
    const used = await pairInBrowser(activePage, request, 'Used QR phone');
    const secret = new URL(used.pairUrl).hash.slice(1);
    const replay = await request.post('/remote-auth/pair', {
      headers: { Origin: remoteUrl, 'content-type': 'application/json' },
      data: { secret, deviceName: 'Replay', publicKeyJwk: {} },
    });
    expect(replay.status()).toBe(410);

    const devices = await localApi(request, '/api/remote/devices');
    const deviceId = (await devices.json()).devices.find((candidate) => candidate.name === 'Used QR phone').id;
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

  test('named fake flow validates a token, suggests conflicts, reuses owned DNS, stops/restarts, and preserves ownership warnings', async ({ browser, request }) => {
    test.setTimeout(30_000);
    const context = await browser.newContext({ baseURL: localUrl });
    const page = await context.newPage();
    await page.goto('/');
    await page.locator('#remote-button').click();
    const dialog = page.locator('#remote-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/cloudflared/i)).toBeVisible();
    await dialog.getByRole('radio', { name: /custom domain/i }).check();
    await dialog.getByRole('button', { name: /next: custom domain/i }).click();
    await dialog.getByLabel(/cloudflare api token/i).fill('fixture-token');
    await dialog.locator('#remote-token-form').getByRole('button', { name: /validate token/i }).click();
    await expect(dialog.locator('#remote-zone')).toHaveValue('example.test');
    await dialog.locator('#remote-subdomain').fill('taken');
    await expect(dialog.getByText(/already in use/i)).toBeVisible({ timeout: 5_000 });
    await expect(dialog.getByRole('button', { name: /use taken-2/i })).toBeVisible();
    await dialog.getByRole('button', { name: /use taken-2/i }).click();
    await dialog.getByRole('button', { name: /connect custom domain/i }).click();
    await expect(dialog.getByLabel(/remote public url/i)).toHaveValue('http://taken-2.example.test');

    await dialog.getByRole('button', { name: /^stop$/i }).click();
    const namedStatus = await localApi(request, '/api/remote/status');
    expect((await namedStatus.json()).named).toMatchObject({ hostname: 'taken-2.example.test', desiredState: 'stopped' });

    // Starting the same owned record again exercises the persisted-DNS reuse
    // path without any external DNS call; Stop does not remove its metadata.
    await dialog.getByRole('button', { name: /connect custom domain/i }).click();
    await expect(dialog.getByLabel(/remote public url/i)).toHaveValue('http://taken-2.example.test');
    await dialog.getByRole('button', { name: /^stop$/i }).click();

    await dialog.locator('#remote-subdomain').fill('warn');
    await page.waitForTimeout(400);
    await dialog.getByRole('button', { name: /connect custom domain/i }).click();
    await dialog.getByRole('button', { name: /^stop$/i }).click();
    // Stop intentionally leaves the owned DNS metadata present, so Remove is
    // still actionable and reports ownership warnings without deleting it.
    await expect(dialog.locator('#remote-remove')).toBeEnabled();
    page.once('dialog', (prompt) => prompt.accept());
    await dialog.locator('#remote-remove').click();
    await expect(dialog.getByText(/DNS changed outside agent-remote/i)).toBeVisible();
    await context.close();
  });
});
