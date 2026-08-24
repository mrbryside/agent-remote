import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';

const fallbackProjectName = basename(process.cwd());

async function cleanWorkspace(request) {
  const projectsResponse = await request.get('/api/projects');
  if (projectsResponse.ok()) {
    const { projects } = await projectsResponse.json();
    const testProjects = projects.filter((project) => [
      fallbackProjectName, 'Second project', 'Resizable', 'Session limit', 'Optimistic', 'Cache switching',
      'Refresh cache', 'Agent loading', 'Recent activity', 'Pinned open A', 'Pinned open B', 'Responsive',
      'Grok ACP gate', 'Preserve A', 'Preserve B', 'Renamed B', 'Renamed from home', 'Mobile keyboard',
      'Mobile conversation', 'Mobile ACP startup', 'Lifecycle status',
      'Cross device sync', 'Model picker',
    ].includes(project.name));
    for (const project of testProjects) await request.delete(`/api/projects/${encodeURIComponent(project.id)}`);
  }
}

async function createProject(page, { name = '', marker, agentId } = {}) {
  const selectedAgentId = agentId || (marker === '__CACHE_READY__' ? 'fixture-cache' : 'fixture-shell');
  await page.locator('#new-project').click();
  await expect(page.locator('#create-dialog')).toBeVisible();
  await page.locator('#project-name').fill(name);
  await page.locator('#project-agent').selectOption(selectedAgentId);
  await page.locator('#folder-path').fill(process.cwd());
  await page.locator('#go-folder').click();
  await expect(page.locator('#selected-folder')).toHaveText(process.cwd());
  await page.locator('#save-project').click();
  await expect(page.locator('#create-dialog')).not.toBeVisible();
  await expect(page.locator('#terminal')).toBeVisible({ timeout: 8_000 });
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'connected');
  if (marker && selectedAgentId === 'fixture-shell') {
    const sessionName = await page.locator('#terminal').getAttribute('data-session');
    execFileSync('tmux', ['-L', 'agent-remote-playwright', 'send-keys', '-t', sessionName, '-l', `printf '${marker}\\r\\n'`]);
    execFileSync('tmux', ['-L', 'agent-remote-playwright', 'send-keys', '-t', sessionName, 'Enter']);
  }
  if (marker) await expect(page.locator('#terminal .xterm-rows')).toContainText(marker, { timeout: 5_000 });
  const expectedName = name || fallbackProjectName;
  const project = page.locator('.project-group').filter({
    has: page.locator('.project-name', { hasText: expectedName }),
  });
  await expect(project).toHaveCount(1);
  return project;
}

test.beforeEach(async ({ request, page }) => {
  await cleanWorkspace(request);
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
});

test.afterEach(async ({ request }) => {
  await cleanWorkspace(request);
});

test('keeps Remote administration out of the compact mobile surface', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.locator('.local-remote-control')).toBeHidden();
  await expect(page.locator('#remote-button')).toBeHidden();
  await expect(page.locator('#remote-dialog')).toBeHidden();
  await page.waitForTimeout(100);
  const remoteAdminRequests = await page.evaluate(() => performance.getEntriesByType('resource')
    .map(({ name }) => name)
    .filter((url) => new URL(url).pathname.startsWith('/api/remote/')));
  expect(remoteAdminRequests).toEqual([]);
});

test('separates the mobile shell marker from the command draft', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => {
    const conversation = document.querySelector('#mobile-conversation');
    conversation.hidden = false;
    document.querySelector('#mobile-conversation-composer').hidden = false;
  });

  const composer = page.locator('#mobile-conversation-composer');
  const input = page.locator('#mobile-conversation-input');
  const prefix = page.locator('#mobile-conversation-shell-prefix');
  await input.fill('!echo hello');
  await expect(input).toHaveValue('echo hello');
  await expect(input).toHaveAttribute('aria-label', 'Shell command');
  await expect(composer).toHaveAttribute('data-shell', 'true');
  await expect(prefix).toBeVisible();
  await expect(prefix).toHaveText('!');
  await expect(prefix).toHaveCSS('color', 'rgb(232, 164, 101)');

  await input.fill('');
  await expect(prefix).toBeVisible();
  await input.press('Backspace');
  await expect(prefix).toBeHidden();
  await expect(input).toHaveAttribute('aria-label', 'Message');
  await expect(composer).toHaveAttribute('data-shell', 'false');

  await input.fill('echo !');
  await expect(prefix).toBeHidden();
  await expect(input).toHaveValue('echo !');
});

test('keeps the mobile effort step open across live model metadata refreshes', async ({ page }) => {
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = class ModelPickerWebSocket {
      static CONNECTING = NativeWebSocket.CONNECTING;
      static OPEN = NativeWebSocket.OPEN;
      static CLOSING = NativeWebSocket.CLOSING;
      static CLOSED = NativeWebSocket.CLOSED;

      constructor(url) {
        if (!String(url).includes('/conversation-ws')) return new NativeWebSocket(url);
        this.url = String(url);
        this.readyState = NativeWebSocket.CONNECTING;
        this.listeners = new Map();
        window.__modelPickerSocket = this;
        queueMicrotask(() => {
          this.readyState = NativeWebSocket.OPEN;
          this.dispatch('open', {});
        });
      }

      addEventListener(type, listener) {
        const listeners = this.listeners.get(type) || [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
      }

      dispatch(type, event) {
        for (const listener of this.listeners.get(type) || []) listener(event);
      }

      emit(conversation) {
        this.dispatch('message', { data: JSON.stringify({ type: 'conversation', conversation }) });
      }

      close(code = 1000, reason = '') {
        if (this.readyState === NativeWebSocket.CLOSED) return;
        this.readyState = NativeWebSocket.CLOSED;
        this.dispatch('close', { code, reason });
      }
    };
  });
  await page.reload();
  const project = await createProject(page, { name: 'Model picker', marker: '__MODEL_PICKER__' });
  const sessionName = await project.locator('.session-row').getAttribute('data-session');
  const conversation = {
    provider: { id: 'grok', label: 'Grok' },
    thread: { id: 'picker-root', title: 'Model picker', agentName: 'grok', model: 'qwen-local', status: 'idle' },
    parent: null,
    rootThreadId: 'picker-root',
    items: [],
    children: [],
    queue: [],
    activity: { active: false },
    controls: { model: {
      currentId: 'qwen-local',
      options: [
        { id: 'qwen-local', label: 'Qwen', provider: { id: 'local', label: 'Local' } },
        { id: 'grok-4.6', label: 'Grok 4.6', provider: { id: 'xai', label: 'xAI' },
          description: 'Frontier model', currentEffortId: 'high', efforts: [
            { id: 'high', value: 'high', label: 'High Effort' },
            { id: 'low', value: 'low', label: 'Low Effort' },
          ] },
      ],
    } },
    capabilities: { send: true, children: false },
  };
  await page.route(`**/api/conversations/${sessionName}**`, (route) => route.fulfill({
    json: { conversation },
  }));
  await page.setViewportSize({ width: 390, height: 844 });

  const mobileConversation = page.locator('#mobile-conversation');
  await expect(mobileConversation).toBeVisible();
  const input = mobileConversation.locator('#mobile-conversation-input');
  await input.click();
  const modelButton = mobileConversation.locator('#mobile-conversation-model');
  const modelList = mobileConversation.locator('#mobile-conversation-model-list');
  await modelButton.click();
  await modelList.getByRole('option', { name: /Grok 4\.6/ }).click();
  await expect(modelList).toHaveAttribute('aria-label', 'Choose effort for Grok 4.6');

  const refreshedConversation = structuredClone(conversation);
  refreshedConversation.controls.model.options[1].description = 'Live metadata refresh';
  await page.evaluate((nextConversation) => {
    window.__modelPickerSocket.emit(nextConversation);
  }, refreshedConversation);

  await expect(modelList).toBeVisible();
  await expect(modelButton).toHaveAttribute('aria-expanded', 'true');
  await expect(modelList).toHaveAttribute('aria-label', 'Choose effort for Grok 4.6');
  await expect(modelList.getByRole('option')).toHaveCount(2);
});

test('dismisses every native modal only from its outside backdrop', async ({ page }) => {
  const dialogIds = ['create-dialog', 'remote-dialog', 'cloudflare-token-guide-dialog'];
  for (const id of dialogIds) {
    await expect.poll(() => page.locator(`#${id}`).getAttribute('data-backdrop-dismiss')).toBe('true');
    await page.locator(`#${id}`).evaluate((dialog) => dialog.showModal());
    await expect(page.locator(`#${id}`)).toBeVisible();

    const bounds = await page.locator(`#${id}`).boundingBox();
    await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + 24);
    await expect(page.locator(`#${id}`)).toBeVisible();

    await page.locator(`#${id}`).evaluate((nativeDialog) => {
      nativeDialog.dataset.closeEvent = 'pending';
      nativeDialog.addEventListener('close', () => {
        nativeDialog.dataset.closeEvent = 'done';
      }, { once: true });
    });
    await page.mouse.click(1, 1);
    await expect(page.locator(`#${id}`)).toBeHidden();
    await expect(page.locator(`#${id}`)).toHaveAttribute('data-close-event', 'done');
  }
});

test('keeps Remote configuration separate from the header Start and Stop control', async ({ page }) => {
  let tunnel = { mode: 'none', state: 'stopped' };
  let named = { zoneName: 'example.com', hostname: 'terminal.example.com', desiredState: 'stopped' };
  let quickCalls = 0;
  let namedCalls = 0;
  let signalStopStarted;
  let releaseStop;
  let signalNamedStarted;
  let releaseNamed;
  let signalQuickStarted;
  let releaseQuick;
  const stopStarted = new Promise((resolve) => { signalStopStarted = resolve; });
  const stopReleased = new Promise((resolve) => { releaseStop = resolve; });
  const namedStarted = new Promise((resolve) => { signalNamedStarted = resolve; });
  const namedReleased = new Promise((resolve) => { releaseNamed = resolve; });
  const quickStarted = new Promise((resolve) => { signalQuickStarted = resolve; });
  const quickReleased = new Promise((resolve) => { releaseQuick = resolve; });
  let pairedDevices = [{
    id: 'device-auto', name: 'Mac · Chrome', createdAt: Date.now(), lastUsedAt: null, revokedAt: null,
  }, {
    id: 'device-phone', name: 'iPhone · Safari', createdAt: Date.now() - 1_000, lastUsedAt: null, revokedAt: null,
  }];
  await page.route('**/api/runtime', (route) => route.fulfill({ json: {
    product: 'agent-remote', version: 1, surface: 'local', desktopMode: false,
  } }));
  await page.route('**/api/remote/status', (route) => route.fulfill({ json: {
    supported: true,
    cloudflared: { available: true, version: '2026.8.2', source: 'path' },
    tokenConfigured: true,
    tunnel,
    named,
  } }));
  await page.route('**/api/remote/tunnel-status', (route) => route.fulfill({ json: { tunnel } }));
  await page.route('**/api/remote/zones', (route) => route.fulfill({ json: { zones: [
    { id: 'zone-example', name: 'example.com' },
    { id: 'zone-work', name: 'work.example' },
  ] } }));
  await page.route('**/api/remote/hostname-availability**', (route) => {
    const requested = new URL(route.request().url()).searchParams.get('subdomain');
    return route.fulfill({ json: requested === 'taken' ? {
      hostname: 'taken.example.com', status: 'conflict', suggestions: ['taken-2', 'taken-3'],
    } : {
      hostname: `${requested}.example.com`, status: 'available', suggestions: [],
    } });
  });
  await page.route('**/api/remote/devices', (route) => {
    if (route.request().method() === 'DELETE') {
      const removed = pairedDevices.length;
      pairedDevices = [];
      return route.fulfill({ json: { removed } });
    }
    return route.fulfill({ json: { devices: pairedDevices } });
  });
  await page.route('**/api/remote/devices/device-auto', (route) => {
    pairedDevices = pairedDevices.filter(({ id }) => id !== 'device-auto');
    // The mutation can race with another local controller and report a stale
    // 404 even though the authoritative device list already reflects removal.
    return route.fulfill({ status: 404, json: { error: 'Not found' } });
  });
  await page.route('**/api/remote/tunnels/quick', async (route) => {
    quickCalls += 1;
    signalQuickStarted();
    await quickReleased;
    tunnel = { mode: 'quick', state: 'running', publicUrl: 'https://example.trycloudflare.com' };
    named = { ...named, desiredState: 'stopped' };
    return route.fulfill({ status: 201, json: tunnel });
  });
  await page.route('**/api/remote/tunnels/named', async (route) => {
    namedCalls += 1;
    signalNamedStarted();
    await namedReleased;
    const { zoneId, subdomain: requestedSubdomain } = route.request().postDataJSON();
    const zoneName = zoneId === 'zone-work' ? 'work.example' : 'example.com';
    const hostname = `${requestedSubdomain}.${zoneName}`;
    tunnel = { mode: 'named', state: 'running', hostname, publicUrl: `https://${hostname}` };
    named = { zoneName, hostname, desiredState: 'running' };
    await route.fulfill({ status: 201, json: tunnel });
  });
  await page.route('**/api/remote/tunnels/stop', async (route) => {
    tunnel = { mode: 'quick', state: 'stopping', publicUrl: 'https://example.trycloudflare.com' };
    signalStopStarted();
    await stopReleased;
    tunnel = { mode: 'none', state: 'stopped' };
    named = { ...named, desiredState: 'stopped' };
    await route.fulfill({ json: { tunnel } });
  });
  await page.route('**/api/remote/pairing-sessions', (route) => route.fulfill({ status: 201, json: {
    qrDataUrl: 'data:image/png;base64,iVBORw0KGgo=', expiresAt: Date.now() + 120_000,
  } }));
  await page.reload();
  const remoteButton = page.locator('#remote-button');
  await expect(remoteButton).toBeVisible();
  const remoteButtonLabel = remoteButton.locator('.remote-fab-label');
  await expect(remoteButtonLabel).toHaveText('Remote Off');
  await expect(remoteButton.locator('svg')).toBeVisible();
  await expect(remoteButton).toHaveAttribute('title', 'Remote Off');
  await expect(page.locator('.sidebar-footer #remote-button')).toHaveCount(1);
  const remoteFooterAlignment = await page.locator('.sidebar').evaluate((sidebar) => {
    const footer = sidebar.querySelector('.sidebar-footer').getBoundingClientRect();
    const button = sidebar.querySelector('#remote-button').getBoundingClientRect();
    const list = sidebar.querySelector('#project-list').getBoundingClientRect();
    return {
      footerHeight: footer.height,
      rightInset: Math.round(footer.right - button.right),
      buttonWidth: button.width,
      listEndsBeforeFooter: list.bottom <= footer.top,
    };
  });
  expect(remoteFooterAlignment).toEqual({
    footerHeight: 48,
    rightInset: 9,
    buttonWidth: 34,
    listEndsBeforeFooter: true,
  });
  await expect(page.locator('.sidebar-footer')).toHaveCSS('border-top-width', '0px');
  await expect(remoteButtonLabel).toHaveCSS('opacity', '0');
  const remoteButtonMotion = await remoteButton.evaluate((button) => ({
    button: getComputedStyle(button).transitionDuration,
    label: getComputedStyle(button.querySelector('.remote-fab-label')).transitionDuration,
  }));
  expect(remoteButtonMotion).toEqual({
    button: '0.22s, 0.22s, 0.22s, 0.22s',
    label: '0.28s, 0.28s, 0.22s, 0.28s',
  });
  await remoteButton.hover();
  await expect(remoteButtonLabel).toHaveCSS('opacity', '1');
  await expect.poll(() => remoteButton.evaluate((button) => button.getBoundingClientRect().width))
    .toBeGreaterThan(80);
  await expect(remoteButton).toHaveAttribute('data-state', 'stopped');
  await remoteButton.click();
  const remoteDialog = page.locator('#remote-dialog');
  await expect(remoteDialog).toBeVisible();
  const primaryAction = remoteDialog.locator('#remote-next');
  await expect.poll(() => primaryAction.evaluate((button) => {
    const style = getComputedStyle(button);
    const root = getComputedStyle(document.documentElement);
    return {
      background: style.backgroundColor,
      border: style.borderTopColor,
      text: style.color,
      surfaceToken: root.getPropertyValue('--color-button-surface').trim(),
      borderToken: root.getPropertyValue('--color-button-primary-border').trim(),
    };
  })).toEqual({
    background: 'rgba(0, 0, 0, 0)',
    border: 'rgb(86, 143, 132)',
    text: 'rgb(222, 222, 224)',
    surfaceToken: 'transparent',
    borderToken: '#568f84',
  });
  await primaryAction.hover();
  await expect(primaryAction).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(primaryAction).toHaveCSS('border-color', 'rgb(100, 190, 172)');
  await expect(remoteDialog.getByRole('heading', { name: 'Choose one connection type' })).toBeVisible();
  await expect(remoteDialog.getByRole('heading', { name: 'Custom Domain' })).toBeHidden();
  await expect(remoteDialog.getByRole('heading', { name: 'Scan devices locally' })).toBeHidden();
  await expect(remoteDialog.getByRole('heading', { name: 'Paired devices' })).toBeHidden();
  await expect(remoteDialog.locator('[data-remote-step-target]')).toHaveCount(3);
  await expect(remoteDialog.getByRole('button', { name: 'Back' })).toHaveCount(0);
  const power = remoteDialog.locator('#remote-power');
  await expect(power).toHaveText('Start Remote');
  await expect(power).toBeEnabled();
  await expect(remoteDialog.locator('#remote-runtime-status')).toHaveAttribute('data-state', 'stopped');
  await expect(remoteDialog.locator('#remote-state')).toHaveText('Remote is off');
  await expect(power.locator('xpath=..').locator('xpath=following-sibling::button[1]')).toHaveText('Manage devices');
  const closeRemote = remoteDialog.getByRole('button', { name: 'Close Remote access' });
  await expect(closeRemote).toHaveCSS('border-top-width', '0px');
  await expect(closeRemote).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await closeRemote.hover();
  await expect(closeRemote).toHaveCSS('color', 'rgb(100, 190, 172)');
  for (const target of [1, 2, 3]) {
    const step = remoteDialog.locator(`[data-remote-step-target="${target}"]`);
    await expect(step).toHaveAttribute('data-complete', 'true');
    await expect.poll(() => step.locator('span').evaluate((node) => getComputedStyle(node, '::before').content)).toBe(target === 3 ? '"✓+"' : '"✓"');
  }
  await expect(remoteDialog.locator('[data-remote-step-target="3"]')).toHaveAttribute('data-repeatable', 'true');
  await expect(remoteDialog.locator('[data-remote-step-target="3"]')).toBeDisabled();
  await expect(remoteDialog.locator('#remote-devices-step-hint'))
    .toHaveAttribute('title', 'Start Remote before continuing to Devices.');
  await expect(remoteDialog.getByRole('radio', { name: /Custom Domain/ })).toBeChecked();
  await remoteDialog.locator('[data-remote-step-target="2"]').click();
  await expect(remoteDialog.getByRole('heading', { name: 'Custom Domain' })).toBeVisible();
  await expect(remoteDialog.getByRole('button', { name: 'Next: Pair devices' })).toBeDisabled();
  await expect(remoteDialog.locator('#remote-next-hint'))
    .toHaveAttribute('title', 'Start Remote before continuing to Devices.');
  const tokenGuideButton = remoteDialog.getByRole('button', { name: 'See the step-by-step setup guide' });
  await tokenGuideButton.click();
  const tokenGuide = page.getByRole('dialog', { name: 'Create a Cloudflare API token' });
  await expect(tokenGuide).toBeVisible();
  await expect(tokenGuide.getByRole('row')).toHaveCount(4);
  await expect(tokenGuide.getByRole('row').nth(1).getByRole('cell')).toHaveText(['Account', 'Cloudflare Tunnel', 'Edit / Write']);
  await expect(tokenGuide.getByRole('row').nth(2).getByRole('cell')).toHaveText(['Zone', 'DNS', 'Edit / Write']);
  await expect(tokenGuide.getByRole('row').nth(3).getByRole('cell')).toHaveText(['Zone', 'Zone', 'Read']);
  await expect(tokenGuide.getByText('Seeing “Write” instead of “Edit”?')).toBeVisible();
  await expect(tokenGuide.getByText(/Avoid “All accounts” and “All zones”/)).toBeVisible();
  await expect.poll(() => tokenGuide.locator('.cloudflare-token-guide-scroll').evaluate((element) => ({
    overflowY: getComputedStyle(element).overflowY,
    scrollable: element.scrollHeight > element.clientHeight,
  }))).toEqual({ overflowY: 'auto', scrollable: true });
  await tokenGuide.getByRole('button', { name: 'Done' }).click();
  await expect(tokenGuide).toBeHidden();
  await expect(tokenGuideButton).toBeFocused();
  await expect(remoteDialog.locator('#remote-zone')).toHaveValue('example.com');
  await expect(remoteDialog.locator('#remote-subdomain')).toHaveValue('terminal');
  await expect(remoteDialog.locator('#remote-zone-options option')).toHaveCount(2);
  await remoteDialog.locator('#remote-subdomain').fill('taken');
  await expect(remoteDialog.locator('#remote-subdomain-options option').first()).toHaveAttribute('value', 'taken-2');
  await remoteDialog.locator('#remote-subdomain').fill('available');
  await expect(remoteDialog.locator('#remote-hostname-availability')).toContainText('available.example.com is available');
  await expect(power).toBeEnabled();
  await expect(power).toHaveAttribute('data-action', 'start');
  await power.click();
  await namedStarted;
  expect(namedCalls).toBe(1);
  await expect(remoteDialog.locator('#remote-loading-title')).toHaveText('Opening Remote access…');
  await expect(remoteDialog.locator('#remote-loading-copy')).toHaveText('Starting the public tunnel. Keep this window open.');
  await expect(remoteDialog.locator('#remote-loading')).toBeVisible();
  await expect(power).toHaveAttribute('data-action', 'starting');
  await expect(remoteDialog.locator('[data-remote-step-target="2"]')).toHaveAttribute('aria-current', 'step');
  releaseNamed();
  await expect(remoteDialog.locator('#remote-loading')).toBeHidden();
  await expect(remoteDialog.locator('[data-remote-step-target="3"]')).toHaveAttribute('aria-current', 'step');
  await expect(remoteDialog.getByRole('heading', { name: 'Scan devices locally' })).toBeVisible();
  await expect(power).toHaveText('Stop Remote');
  await expect(power).toHaveAttribute('data-action', 'stop');
  await page.mouse.move(0, 0);
  await expect(power).toHaveCSS('border-color', 'rgb(80, 56, 61)');
  await expect(power).toHaveCSS('color', 'rgb(201, 135, 142)');
  await power.hover();
  await expect(power).toHaveCSS('border-color', 'rgb(201, 135, 142)');
  await expect(power).toHaveCSS('color', 'rgb(219, 141, 148)');
  await expect(remoteDialog.locator('#remote-runtime-status')).toHaveAttribute('data-state', 'running');
  await expect(remoteDialog.locator('#remote-state')).toHaveText('Remote connected');
  await expect(remoteDialog.locator('#remote-state-detail')).toContainText('Custom Domain');

  await remoteDialog.locator('[data-remote-step-target="2"]').click();
  await expect(remoteDialog.locator('#remote-remove')).toHaveCount(0);
  await remoteDialog.locator('#remote-subdomain').fill('draft-only');
  await expect(remoteDialog.locator('#remote-hostname-availability')).toContainText('draft-only.example.com is available');
  await expect(power).toHaveText('Update & Restart');
  await expect(power).toHaveAttribute('data-action', 'update');

  // Closing without updating discards the draft and restores the active setup.
  await closeRemote.click();
  await remoteButton.click();
  await remoteDialog.locator('[data-remote-step-target="2"]').click();
  await expect(remoteDialog.locator('#remote-subdomain')).toHaveValue('available');
  await expect(power).toHaveText('Stop Remote');

  await remoteDialog.locator('#remote-subdomain').fill('replacement');
  await expect(remoteDialog.locator('#remote-hostname-availability')).toContainText('replacement.example.com is available');
  await expect(power).toHaveText('Update & Restart');
  await power.click();
  await expect.poll(() => namedCalls).toBe(2);
  await expect(remoteDialog.getByLabel('Remote public URL')).toHaveValue('https://replacement.example.com');
  await expect(power).toHaveText('Stop Remote');
  await expect(remoteDialog.locator('#remote-alert')).toHaveText('Remote configuration updated and restarted.');

  await power.click();
  await stopStarted;
  await expect(remoteDialog).toHaveAttribute('aria-busy', 'true');
  await expect(remoteDialog.locator('#remote-loading-title')).toHaveText('Stopping Remote access…');
  await expect(remoteDialog.locator('#remote-loading-copy')).toHaveText('Closing the public tunnel. Your selected setup will be kept.');
  await expect(power).toHaveAttribute('data-action', 'stopping');
  await expect(power).toHaveCSS('color', 'rgb(232, 164, 101)');
  releaseStop();
  await expect(remoteDialog.locator('#remote-loading')).toBeHidden();
  await expect(power).toHaveText('Start Remote');
  await expect(power).toHaveAttribute('data-action', 'start');
  await expect(remoteDialog.getByRole('heading', { name: 'Custom Domain' })).toBeVisible();

  await remoteDialog.locator('[data-remote-step-target="1"]').click();
  await remoteDialog.getByRole('radio', { name: /Random URL/ }).check();
  await expect(remoteDialog.locator('[data-remote-step-target="2"]')).toBeHidden();
  await expect(remoteDialog.locator('[data-remote-step-target="3"] span')).toHaveText('2');
  await expect(remoteDialog.locator('#remote-step-caption')).toHaveText('Step 1 of 2');
  const nextToPair = remoteDialog.getByRole('button', { name: 'Next: Pair devices' });
  await expect(nextToPair).toBeDisabled();
  await expect(remoteDialog.locator('#remote-next-hint'))
    .toHaveAttribute('title', 'Start Remote before continuing to Devices.');
  await expect(remoteDialog.getByRole('heading', { name: 'Choose one connection type' })).toBeVisible();
  expect(quickCalls).toBe(0);
  await power.click();
  await quickStarted;
  expect(quickCalls).toBe(1);
  await expect(remoteDialog.locator('#remote-loading-title')).toHaveText('Opening Remote access…');
  await expect(remoteDialog.locator('#remote-loading')).toBeVisible();
  await expect(remoteDialog.locator('[data-remote-step-target="1"]')).toHaveAttribute('aria-current', 'step');
  releaseQuick();
  await expect(remoteDialog.getByLabel('Remote public URL')).toHaveValue('https://example.trycloudflare.com');
  await expect(remoteButton).toHaveAttribute('data-state', 'running');
  await expect(remoteButton).toHaveAttribute('title', 'Remote On');
  await expect(remoteButtonLabel).toHaveText('Remote On');
  await expect(remoteDialog.getByRole('heading', { name: 'Scan devices locally' })).toBeVisible();
  await expect(remoteDialog.locator('#remote-next')).toBeHidden();
  await expect(remoteDialog.getByText(/pair as many browser profiles as you need/i)).toBeVisible();
  const pairAction = remoteDialog.getByRole('button', { name: 'Create QR for another device' });
  const pairActionBeforeQr = await pairAction.boundingBox();
  const pairingBeforeQr = await remoteDialog.locator('.remote-pairing').boundingBox();
  await expect(remoteDialog.getByText('QR appears here')).toBeVisible();
  await pairAction.click();
  await expect(remoteDialog.locator('#remote-qr')).toBeVisible();
  await expect(remoteDialog.getByText('QR appears here')).toBeHidden();
  const pairActionAfterQr = await pairAction.boundingBox();
  const pairingAfterQr = await remoteDialog.locator('.remote-pairing').boundingBox();
  expect(Math.abs((pairActionAfterQr.x - pairingAfterQr.x) - (pairActionBeforeQr.x - pairingBeforeQr.x))).toBeLessThan(1);
  expect(Math.abs((pairActionAfterQr.y - pairingAfterQr.y) - (pairActionBeforeQr.y - pairingBeforeQr.y))).toBeLessThan(1);
  expect(pairingAfterQr.width).toBe(pairingBeforeQr.width);
  expect(pairingAfterQr.height).toBe(pairingBeforeQr.height);
  expect((await remoteDialog.locator('#remote-qr').boundingBox()).x).toBeGreaterThan(pairActionAfterQr.x + pairActionAfterQr.width);
  await expect(remoteDialog.getByText(/QR code expires in/)).toBeVisible();
  await remoteDialog.getByRole('button', { name: 'Manage devices' }).click();
  await expect(remoteDialog.getByRole('heading', { name: 'Paired devices' })).toBeVisible();
  await expect(remoteDialog.locator('.remote-stepper')).toBeHidden();
  await expect(remoteDialog.getByRole('button', { name: 'Setup' })).toBeVisible();
  await expect(remoteDialog.locator('#remote-next')).toBeHidden();
  await expect(remoteDialog.getByText('Mac · Chrome')).toBeVisible();
  page.once('dialog', (prompt) => prompt.accept());
  await remoteDialog.locator('.remote-device').filter({ hasText: 'Mac · Chrome' }).getByRole('button', { name: 'Revoke' }).click();
  await expect(remoteDialog.locator('.remote-device').filter({ hasText: 'Mac · Chrome' })).toHaveCount(0);
  await expect(remoteDialog.getByText('iPhone · Safari')).toBeVisible();
  page.once('dialog', (prompt) => prompt.accept());
  await remoteDialog.getByRole('button', { name: 'Clear all' }).click();
  await expect(remoteDialog.getByText('No paired devices yet.')).toBeVisible();
  await expect(remoteDialog.getByRole('button', { name: 'Clear all' })).toBeHidden();
  // The header control remains available from device management and keeps the
  // selected setup intact for the next Start.
  await power.click();
  await expect(power).toHaveText('Start Remote');
  await expect(remoteDialog.locator('#remote-alert')).toHaveText('Remote access stopped. Your setup is ready to start again.');
  await expect(remoteDialog.locator('#remote-alert')).toHaveAttribute('data-kind', 'success');
  await expect(remoteDialog.getByRole('heading', { name: 'Paired devices' })).toBeVisible();
  await expect(remoteDialog.getByRole('button', { name: 'Setup' })).toBeVisible();
  await expect(remoteDialog.locator('#remote-qr')).toBeHidden();
  await closeRemote.click();
  await expect(remoteDialog).toBeHidden();
  await expect(remoteButton).toBeFocused();
  tunnel = { mode: 'named', state: 'error', hostname: 'terminal.example.com' };
  await expect(remoteButton).toHaveAttribute('data-state', 'error', { timeout: 5_000 });
  await expect(remoteButton).toHaveAttribute('title', 'Remote Error');
});

test('does not show Remote controls on the remote surface', async ({ page }) => {
  await page.route('**/api/runtime', (route) => route.fulfill({ json: {
    product: 'agent-remote', version: 1, surface: 'remote', desktopMode: false,
  } }));
  await page.reload();
  await expect(page.locator('#remote-button')).toHaveCount(0);
  await expect(page.locator('#remote-dialog')).toHaveCount(0);
  await expect(page.locator('#cloudflare-token-guide-dialog')).toHaveCount(0);
  await expect(page.locator('.sidebar-footer')).toHaveCount(0);
});

test('starts loading Remote setup on refresh and reuses the in-flight request when opened', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let releaseRemoteState;
  let statusRequests = 0;
  let deviceRequests = 0;
  const remoteStateReady = new Promise((resolve) => { releaseRemoteState = resolve; });
  await page.goto('about:blank');
  await page.route('**/api/runtime', (route) => route.fulfill({ json: {
    product: 'agent-remote', version: 1, surface: 'local', desktopMode: false,
  } }));
  await page.route('**/api/remote/status', async (route) => {
    statusRequests += 1;
    await remoteStateReady;
    await route.fulfill({ json: {
      supported: true, cloudflared: { available: true, version: '2026.8.2' }, tokenConfigured: false,
      tunnel: { mode: 'named', state: 'running', publicUrl: 'https://agent.example.com' },
      named: { zoneName: 'example.com', hostname: 'agent.example.com', desiredState: 'running' },
    } });
  });
  await page.route('**/api/remote/devices', async (route) => {
    deviceRequests += 1;
    await remoteStateReady;
    await route.fulfill({ json: { devices: [{
      id: 'phone', name: 'iPhone · Safari', createdAt: Date.now(), lastUsedAt: null,
    }] } });
  });
  await page.goto('/');
  await expect.poll(() => statusRequests).toBe(1);
  await expect.poll(() => deviceRequests).toBe(1);
  await page.locator('#open-sidebar').click();
  const remoteButton = page.locator('#remote-button');
  await expect(remoteButton).toBeVisible();
  await expect(remoteButton.locator('svg')).toBeVisible();
  await expect(remoteButton).toHaveAttribute('data-state', 'loading');
  await expect(remoteButton).toHaveAttribute('aria-busy', 'true');
  await expect(remoteButton).toHaveAttribute('title', 'Remote');
  await expect(remoteButton.locator('.remote-fab-label')).toHaveText('Remote');
  await expect.poll(() => remoteButton.locator('svg').evaluate((icon) => getComputedStyle(icon).animationName))
    .toBe('remote-loading-signal');
  expect(await remoteButton.evaluate((button) => getComputedStyle(button, '::after').content)).toBe('none');
  await remoteButton.click();
  expect(statusRequests).toBe(1);
  expect(deviceRequests).toBe(1);
  const dialog = page.locator('#remote-dialog');
  await expect(dialog.locator('#remote-loading')).toBeVisible();
  await expect(dialog.locator('.remote-stepper')).toBeHidden();
  await expect(dialog.getByRole('radio', { name: /Random URL/ })).not.toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Manage devices' })).toBeHidden();
  await expect(dialog.locator('#remote-power')).toBeHidden();
  await expect(dialog.locator('#remote-power-hint')).toBeHidden();
  await expect(dialog.locator('#remote-power-hint')).toHaveAttribute('title', 'Remote setup is still loading.');
  const loadingBounds = await dialog.locator('#remote-loading').boundingBox();
  const dialogBounds = await dialog.boundingBox();
  expect(Math.abs((loadingBounds.x + loadingBounds.width / 2) -
    (dialogBounds.x + dialogBounds.width / 2))).toBeLessThan(2);
  expect((await dialog.getByRole('heading', { name: 'Remote access' }).boundingBox()).height).toBeLessThan(30);
  releaseRemoteState();
  await expect(dialog.locator('#remote-loading')).toBeHidden();
  await expect(remoteButton).toHaveAttribute('data-state', 'running');
  await expect(remoteButton).not.toHaveAttribute('aria-busy', 'true');
  await expect(remoteButton.locator('.remote-fab-label')).toHaveText('Remote On');
  await expect(dialog.locator('#remote-power')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Manage devices' })).toBeVisible();
  await expect(dialog.locator('.remote-stepper')).toBeVisible();
  await expect(dialog.locator('.remote-stepper')).toHaveCSS('border-top-width', '1px');
  await expect(dialog.locator('input[name="remote-connection-type"][value="named"]')).toBeChecked();
  await expect(dialog.locator('.remote-connection-choice').filter({ hasText: 'Custom Domain' }))
    .toHaveAttribute('data-active', 'true');
  await expect(dialog.locator('.remote-connection-choice').filter({ hasText: 'Custom Domain' }))
    .toContainText('Custom Domain');
  await expect(dialog.locator('[data-remote-step-target="3"]')).toHaveAttribute('data-complete', 'true');
  await expect(dialog.locator('[data-remote-step-target="3"]')).toHaveAttribute('aria-current', 'step');
  await expect(dialog.getByRole('heading', { name: 'Scan devices locally' })).toBeVisible();
  await expect(dialog.locator('#remote-next')).toBeHidden();
  await dialog.locator('[data-remote-step-target="1"]').click();
  await dialog.getByRole('radio', { name: /Random URL/ }).check();
  await expect(dialog.locator('[data-remote-step-target="2"]')).toBeHidden();
  await expect(dialog.locator('[data-remote-step-target="3"] span')).toHaveText('2');
  await expect(dialog.locator('#remote-power')).toHaveText('Stop Remote');
  await expect(dialog.getByRole('button', { name: 'Next: Pair devices' })).toBeVisible();
});

test('uses a safe-area aware near-edge Remote modal on a 390x844 viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let compactTunnel = { mode: 'none', state: 'stopped' };
  await page.route('**/api/runtime', (route) => route.fulfill({ json: {
    product: 'agent-remote', version: 1, surface: 'local', desktopMode: false,
  } }));
  await page.route('**/api/remote/status', (route) => route.fulfill({ json: {
    supported: true, cloudflared: { available: true }, tokenConfigured: false,
    tunnel: compactTunnel,
  } }));
  await page.route('**/api/remote/devices', (route) => route.fulfill({ json: { devices: [] } }));
  await page.reload();
  await page.locator('#open-sidebar').click();
  await page.locator('#remote-button').click();
  await page.waitForTimeout(250);
  const bounds = await page.locator('#remote-dialog').boundingBox();
  expect(bounds.x).toBe(8);
  expect(bounds.y).toBe(8);
  expect(bounds.width).toBe(374);
  expect(bounds.height).toBe(828);
  await expect(page.locator('#remote-dialog')).toHaveCSS('border-radius', '16px');
  const compactRemote = page.locator('#remote-dialog');
  await expect(compactRemote.locator('[data-remote-step-target="3"]')).toBeDisabled();
  await expect(compactRemote.locator('#remote-devices-step-hint'))
    .toHaveAttribute('title', 'Start Remote before continuing to Devices.');
  await expect(compactRemote.getByRole('heading', { name: 'Choose one connection type' })).toBeVisible();
  compactTunnel = { mode: 'quick', state: 'running', publicUrl: 'https://compact.trycloudflare.com' };
  await compactRemote.getByRole('button', { name: 'Close Remote access' }).click();
  await page.locator('#remote-button').click();
  await expect(compactRemote.locator('[data-remote-step-target="3"]')).toBeEnabled();
  await compactRemote.locator('[data-remote-step-target="3"]').click();
  await expect(compactRemote.getByRole('heading', { name: 'Scan devices locally' })).toBeVisible();
  await expect.poll(() => compactRemote.locator('.remote-pairing').evaluate((panel) => {
    const action = panel.querySelector('#remote-pair').getBoundingClientRect();
    const slot = panel.querySelector('.remote-qr-slot').getBoundingClientRect();
    return {
      horizontalOverflow: panel.scrollWidth > panel.clientWidth,
      qrIsRightOfAction: slot.left >= action.right,
    };
  })).toEqual({ horizontalOverflow: false, qrIsRightOfAction: true });
  await compactRemote.locator('[data-remote-step-target="1"]').click();
  await compactRemote.getByRole('radio', { name: /Custom Domain/ }).check();
  await expect(compactRemote.locator('#remote-power')).toBeDisabled();
  await expect(compactRemote.locator('#remote-power-hint'))
    .toHaveAttribute('title', 'Validate a Cloudflare API token in Domain first.');
  const remoteTypography = await page.locator('#remote-dialog').evaluate((element) => ({
    button: Number.parseFloat(getComputedStyle(element.querySelector('button')).fontSize),
    heading: Number.parseFloat(getComputedStyle(element.querySelector('h2')).fontSize),
    note: Number.parseFloat(getComputedStyle(element.querySelector('.remote-note')).fontSize),
  }));
  expect(remoteTypography.button).toBeGreaterThanOrEqual(13);
  expect(remoteTypography.heading).toBeGreaterThanOrEqual(18);
  expect(remoteTypography.note).toBeGreaterThanOrEqual(13);
  await page.locator('#remote-dialog [data-remote-step-target="2"]').click();
  await page.locator('#remote-token-guide-open').click();
  await page.waitForTimeout(250);
  const guide = page.locator('#cloudflare-token-guide-dialog');
  const guideBounds = await guide.boundingBox();
  expect(guideBounds.x).toBe(8);
  expect(guideBounds.y).toBe(8);
  expect(guideBounds.width).toBe(374);
  expect(guideBounds.height).toBe(828);
  await expect.poll(() => guide.locator('.cloudflare-token-guide-scroll').evaluate((element) => ({
    overflowY: getComputedStyle(element).overflowY,
    scrollable: element.scrollHeight > element.clientHeight,
  }))).toEqual({ overflowY: 'auto', scrollable: true });
});

test('shows image and video attachments in a scrollable mobile media gallery', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/__media_preview__/**', (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/valid.svg')) {
      return route.fulfill({
        status: 200,
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="#5c8cff"/></svg>',
      });
    }
    if (pathname.endsWith('/tall.svg')) {
      return route.fulfill({
        status: 200,
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="720"><rect width="120" height="720" fill="#64beac"/></svg>',
      });
    }
    if (pathname.endsWith('/wide.svg')) {
      return route.fulfill({
        status: 200,
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="120"><rect width="1200" height="120" fill="#e8a465"/></svg>',
      });
    }
    if (pathname.endsWith('/broken.mp4')) {
      return route.fulfill({ status: 200, contentType: 'video/mp4', body: 'broken-video' });
    }
    return route.fulfill({ status: 200, contentType: 'image/png', body: 'broken-image' });
  });
  await page.reload();
  await page.evaluate(async () => {
    const { createMobileFileSurface } = await import('/mobile-file-surface.js?media-gallery-test');
    const root = document.createElement('main');
    root.style.cssText = 'position:fixed;inset:0;background:#0c0c0d';
    document.body.replaceChildren(root);
    const element = (tagName, className = '', text = '') => {
      const node = document.createElement(tagName);
      if (className) node.className = className;
      if (text) node.textContent = text;
      return node;
    };
    const surface = createMobileFileSurface({
      root,
      element,
      readFile: async () => undefined,
      getSessionName: () => '',
      getConversation: () => ({ items: [] }),
      animateContent: () => {},
      metric: (value) => String(value),
    });
    const valid = (id, name) => ({
      id, name, mimeType: 'image/png', url: `/__media_preview__/valid.svg?item=${id}`,
    });
    surface.openMedia({
      selectedId: 'valid-1',
      items: [
        valid('valid-1', 'one.png'),
        { id: 'broken-image', name: 'broken.png', mimeType: 'image/png', url: '/__media_preview__/broken.png' },
        { id: 'broken-video', name: 'clip.mp4', mimeType: 'video/mp4', url: '/__media_preview__/broken.mp4' },
        valid('valid-2', 'two.png'), valid('valid-3', 'three.png'),
        valid('valid-4', 'four.png'), valid('valid-5', 'five.png'),
        { id: 'tall', name: 'tall.png', mimeType: 'image/png', url: '/__media_preview__/tall.svg' },
        { id: 'wide', name: 'wide.png', mimeType: 'image/png', url: '/__media_preview__/wide.svg' },
      ],
    });
  });

  const sheet = page.locator('.mobile-file-sheet');
  const strip = sheet.locator('.mobile-file-media-strip');
  await expect(sheet).toBeVisible();
  await expect(sheet).toHaveClass(/\bmobile-sheet\b/);
  await expect(sheet.locator('.mobile-file-sheet-panel')).toHaveClass(/\bmobile-sheet-panel\b/);
  await expect(sheet.locator('.mobile-file-sheet-body')).toHaveClass(/\bmobile-sheet-body\b/);
  await expect(sheet).toHaveAttribute('aria-label', 'Media preview');
  await expect(strip.getByRole('button')).toHaveCount(9);
  await expect.poll(() => strip.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
  await expect.poll(() => sheet.locator('.mobile-file-media-stage img').evaluate((image) => image.naturalWidth)).toBeGreaterThan(0);

  await strip.getByRole('button', { name: 'View broken.png' }).click();
  await expect(sheet.locator('.mobile-file-media-fallback')).toHaveText('broken.png');
  const videoConfiguration = await page.evaluate(() => {
    document.querySelector('[aria-label="View clip.mp4"]').click();
    const video = document.querySelector('.mobile-file-media-stage video');
    return {
      controls: video?.controls,
      controlsAttribute: video?.hasAttribute('controls'),
      playsInline: video?.playsInline,
      preload: video?.preload,
      visibility: video ? getComputedStyle(video).visibility : undefined,
    };
  });
  expect(videoConfiguration).toEqual({
    controls: true,
    controlsAttribute: true,
    playsInline: true,
    preload: 'metadata',
    visibility: 'hidden',
  });
  await expect(sheet.locator('.mobile-file-media-fallback')).toHaveText('clip.mp4');
  await strip.getByRole('button', { name: 'View five.png' }).click();
  await expect(sheet.locator('.mobile-file-sheet-header strong')).toHaveText('five.png');
  await expect.poll(() => sheet.locator('.mobile-file-media-stage img').evaluate((image) => image.naturalWidth)).toBeGreaterThan(0);

  for (const attachment of ['tall.png', 'wide.png']) {
    await strip.getByRole('button', { name: `View ${attachment}` }).click();
    await expect.poll(() => sheet.locator('.mobile-file-media-stage img').evaluate((image) => image.naturalWidth)).toBeGreaterThan(0);
    const geometry = await sheet.evaluate((node) => {
      const panel = node.querySelector('.mobile-file-sheet-panel').getBoundingClientRect();
      const body = node.querySelector('.mobile-file-sheet-body').getBoundingClientRect();
      const stage = node.querySelector('.mobile-file-media-stage').getBoundingClientRect();
      const media = node.querySelector('.mobile-file-media').getBoundingClientRect();
      const titleColor = getComputedStyle(node.querySelector('.mobile-file-sheet-header strong')).color;
      return {
        panelBottom: panel.bottom,
        panelTop: panel.top,
        bodyTop: body.top,
        bodyBottom: body.bottom,
        stageHeight: stage.height,
        mediaHeight: media.height,
        mediaTop: media.top,
        mediaBottom: media.bottom,
        titleColor,
        viewportHeight: innerHeight,
      };
    });
    expect(geometry.panelTop).toBeGreaterThanOrEqual(0);
    expect(geometry.panelBottom).toBeLessThanOrEqual(geometry.viewportHeight + 1);
    expect(geometry.mediaTop).toBeGreaterThanOrEqual(geometry.bodyTop);
    expect(geometry.mediaBottom).toBeLessThanOrEqual(geometry.bodyBottom);
    expect(Math.abs(geometry.stageHeight - geometry.mediaHeight)).toBeLessThanOrEqual(1);
    expect(geometry.titleColor).toBe('rgb(222, 222, 224)');
  }
});

test('provides shared mobile sheet slots and drag behavior', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(async () => {
    const { createMobileSheetFrame, installMobileSheetDrag } = await import('/mobile-sheet.js?sheet-frame-test');
    const root = document.createElement('main');
    root.style.cssText = 'position:fixed;inset:0;background:#0c0c0d';
    document.body.replaceChildren(root);
    const element = (tagName, className = '', text = '') => {
      const node = document.createElement(tagName);
      if (className) node.className = className;
      if (text) node.textContent = text;
      return node;
    };
    const frame = createMobileSheetFrame({
      root,
      element,
      label: 'Shared sheet test',
      handleLabel: 'Drag shared sheet down',
      footer: true,
    });
    frame.slots.header.append(element('strong', '', 'Header slot'));
    frame.slots.body.append(element('p', '', 'Body slot'));
    frame.slots.footer.append(element('button', '', 'Footer slot'));
    frame.sheet.hidden = false;
    installMobileSheetDrag({
      panel: frame.panel,
      handle: frame.handle,
      threshold: 48,
      onClose: () => { frame.sheet.hidden = true; },
    });
  });

  const sheet = page.getByRole('dialog', { name: 'Shared sheet test' });
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('.mobile-sheet-header')).toContainText('Header slot');
  await expect(sheet.locator('.mobile-sheet-body')).toContainText('Body slot');
  await expect(sheet.locator('.mobile-sheet-footer')).toContainText('Footer slot');
  const handle = sheet.getByRole('button', { name: 'Drag shared sheet down' });
  await handle.dispatchEvent('pointerdown', { pointerId: 7, clientY: 100 });
  await page.evaluate(() => {
    window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 7, clientY: 172 }));
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 7, clientY: 172 }));
  });
  await expect(sheet).toBeHidden();
});

test('auto-reveals tool details only when none of the panel is visible', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const result = await page.evaluate(async () => {
    const { disclosureNeedsReveal } = await import('/mobile-conversation.js?disclosure-visibility-test');
    const messages = document.createElement('main');
    const group = document.createElement('section');
    const panel = document.createElement('div');
    group.className = 'mobile-tool-group-panel';
    messages.className = 'mobile-conversation-messages';
    group.append(panel);
    messages.append(group);
    document.body.replaceChildren(messages);
    messages.getBoundingClientRect = () => ({ top: 80, bottom: 700 });
    group.getBoundingClientRect = () => ({ top: 120, bottom: 620 });
    let panelTop = 180;
    let panelBottom = 560;
    panel.getBoundingClientRect = () => ({ top: panelTop, bottom: panelBottom });
    const anchoring = {
      messages: getComputedStyle(messages).overflowAnchor,
      group: getComputedStyle(group).overflowAnchor,
    };
    const alreadyVisible = disclosureNeedsReveal(panel, messages);
    panelBottom = 660;
    const partiallyVisibleInGroup = disclosureNeedsReveal(panel, messages);
    panelTop = 621;
    panelBottom = 760;
    const belowGroup = disclosureNeedsReveal(panel, messages);
    group.removeAttribute('class');
    panelTop = 180;
    panelBottom = 690;
    const visibleInMessages = disclosureNeedsReveal(panel, messages);
    panelTop = 690;
    panelBottom = 820;
    const partiallyVisibleInMessages = disclosureNeedsReveal(panel, messages);
    panelTop = 701;
    panelBottom = 840;
    const belowMessages = disclosureNeedsReveal(panel, messages);
    panelTop = 20;
    panelBottom = 79;
    const aboveMessages = disclosureNeedsReveal(panel, messages);
    return {
      anchoring,
      alreadyVisible,
      partiallyVisibleInGroup,
      belowGroup,
      visibleInMessages,
      partiallyVisibleInMessages,
      belowMessages,
      aboveMessages,
    };
  });
  expect(result).toEqual({
    anchoring: { messages: 'none', group: 'none' },
    alreadyVisible: false,
    partiallyVisibleInGroup: false,
    belowGroup: true,
    visibleInMessages: false,
    partiallyVisibleInMessages: false,
    belowMessages: true,
    aboveMessages: true,
  });
});

test('uses semantic tool summaries while keeping complete calls in details', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(async () => {
    const { createMobileEventRenderer } = await import('/mobile-event-renderer.js?tool-summary-test');
    const emptyNode = () => document.createElement('div');
    window.__toolRevealCalls = [];
    const renderer = createMobileEventRenderer({
      fileSurface: {
        open: async () => {}, filePreviewNode: emptyNode, searchMatchesNode: emptyNode,
        changeNode: emptyNode, changeStatsNode: emptyNode,
      },
      expandedItems: new Set(), autoExpandedItems: new Set(),
      initializeDisclosure(toggle, panel, open) {
        toggle.setAttribute('aria-expanded', String(open));
        panel.hidden = !open;
      },
      animateDisclosure(toggle, panel, open) {
        toggle.setAttribute('aria-expanded', String(open));
        panel.hidden = !open;
      },
      revealDisclosure(toggle) {
        window.__toolRevealCalls.push(toggle.closest('[data-event-id]')?.dataset.eventId);
      },
      getSessionName: () => '', respondPermission: async () => {}, refresh: async () => {},
    });
    const root = document.createElement('main');
    root.id = 'tool-summary-fixture';
    root.append(renderer.toolGroupNode({
      id: 'summary-group', type: 'tool_group', title: 'Ran 2 commands, Listed 1 dir', status: 'completed',
      tools: [
        {
          id: 'summary-command', type: 'tool', kind: 'execute', status: 'completed',
          title: 'Execute `terminal-browser action -- snapshot`', summary: 'Snapshot the match page',
          command: 'terminal-browser action -- snapshot', output: 'Page snapshot',
        },
        {
          id: 'summary-list', type: 'tool', kind: 'list', status: 'completed', title: 'List Files',
          summary: 'Inspect source files', input: '{"target_directory":"src","depth":2}',
          output: ['app.js', ...Array.from({ length: 80 }, (_, index) => `nested/result-${index}.js`)].join('\n'),
        },
        {
          id: 'fallback-command', type: 'tool', kind: 'execute', status: 'completed', title: 'Shell',
          command: 'printf fallback', output: 'fallback',
        },
      ],
    }));
    root.append(renderer.eventNode({
      id: 'standalone-tool', type: 'tool', kind: 'read', status: 'completed',
      summary: 'Inspect the standalone file', input: '{"path":"README.md"}', output: 'Loaded',
    }));
    document.body.replaceChildren(root);
  });

  const groupToggle = page.locator('[data-event-id="summary-group"] > .mobile-tool-group-toggle');
  await expect(groupToggle).toHaveAttribute('aria-expanded', 'false');
  await groupToggle.click();
  await expect(groupToggle).toHaveAttribute('aria-expanded', 'true');
  await expect.poll(() => page.evaluate(() => window.__toolRevealCalls)).toContain('summary-group');

  const commandCard = page.locator('[data-event-id="summary-command"]');
  const commandToggle = commandCard.locator(':scope > .mobile-event-toggle');
  await expect(commandToggle).toContainText('Run Snapshot the match page');
  await expect(commandToggle).not.toContainText('terminal-browser action');
  await commandToggle.click();
  await expect(commandCard.locator('.mobile-tool-command-line code'))
    .toHaveText('terminal-browser action -- snapshot');
  await expect(commandCard.locator('.mobile-tool-detail')).toHaveCount(2);
  await expect(commandCard.locator('.mobile-tool-detail').nth(0)).toContainText('Input');
  await expect(commandCard.locator('.mobile-tool-detail').nth(1)).toContainText('Output');
  await expect.poll(() => commandCard.locator('.mobile-tool-command-line').evaluate((line) => ({
    overflowX: getComputedStyle(line).overflowX,
    whiteSpace: getComputedStyle(line.querySelector('code')).whiteSpace,
  }))).toEqual({ overflowX: 'visible', whiteSpace: 'pre-wrap' });
  await expect.poll(() => page.evaluate(() => window.__toolRevealCalls)).toContain('summary-command');

  const listCard = page.locator('[data-event-id="summary-list"]');
  await expect(listCard.locator(':scope > .mobile-event-toggle')).toContainText('List Inspect source files');
  await listCard.locator(':scope > .mobile-event-toggle').click();
  await expect(listCard.locator('.mobile-tool-detail').filter({ hasText: 'Input' }))
    .toContainText('{"target_directory":"src","depth":2}');
  await expect(listCard.locator('.mobile-tool-detail').filter({ hasText: 'Output' })).toContainText('app.js');
  await expect.poll(() => listCard.locator('.mobile-tool-detail').evaluateAll((details) => details.map((detail) => {
    const content = detail.querySelector('pre');
    return {
      maxHeight: getComputedStyle(content).maxHeight,
      overflowX: getComputedStyle(content).overflowX,
      overflowY: getComputedStyle(content).overflowY,
      ownsHorizontalScroll: content.scrollWidth > content.clientWidth,
      ownsVerticalScroll: content.scrollHeight > content.clientHeight,
      whiteSpace: getComputedStyle(content).whiteSpace,
    };
  }))).toEqual([
    {
      maxHeight: 'none', overflowX: 'visible', overflowY: 'visible',
      ownsHorizontalScroll: false, ownsVerticalScroll: false, whiteSpace: 'pre-wrap',
    },
    {
      maxHeight: 'none', overflowX: 'visible', overflowY: 'visible',
      ownsHorizontalScroll: false, ownsVerticalScroll: false, whiteSpace: 'pre-wrap',
    },
  ]);
  await expect.poll(() => listCard.locator(':scope > .mobile-event-panel').evaluate((panel) => ({
    background: getComputedStyle(panel).backgroundColor,
    padding: [getComputedStyle(panel).paddingLeft, getComputedStyle(panel).paddingRight],
  }))).toEqual({ background: 'rgb(32, 32, 35)', padding: ['12px', '12px'] });

  await expect(page.locator('[data-event-id="fallback-command"] > .mobile-event-toggle'))
    .toContainText('Run printf fallback');

  const standalone = page.locator('[data-event-id="standalone-tool"]');
  await standalone.locator(':scope > .mobile-event-toggle').click();
  await expect(standalone.locator('.mobile-tool-detail[data-variant="default"]')).toHaveCount(2);
  await expect.poll(() => page.evaluate(() => window.__toolRevealCalls)).toContain('standalone-tool');
});

test('distinguishes a mobile terminal tap from a scroll gesture', async ({ page }) => {
  test.setTimeout(30_000);
  await createProject(page, { name: 'Mobile keyboard', marker: '__MOBILE_KEYBOARD__' });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await cdp.send('Emulation.setEmulatedMedia', { features: [
    { name: 'pointer', value: 'coarse' },
    { name: 'hover', value: 'none' },
  ] });
  await page.setViewportSize({ width: 390, height: 844 });
  const textarea = page.locator('#terminal .xterm-helper-textarea');
  await expect(page.locator('#mobile-terminal-controls')).toHaveCount(0);

  await textarea.evaluate((element) => element.blur());
  await page.locator('#terminal').click({ position: { x: 40, y: 80 } });
  await expect(textarea).toBeFocused();
  await expect(textarea).toHaveAttribute('inputmode', 'text');

  await page.locator('#terminal').evaluate((element) => {
    const pointer = (type, clientY) => element.dispatchEvent(new PointerEvent(type, {
      bubbles: true, pointerType: 'touch', pointerId: 8, isPrimary: true, clientX: 40, clientY,
    }));
    pointer('pointerdown', 180);
    pointer('pointermove', 110);
    pointer('pointerup', 110);
  });
  await expect(textarea).not.toBeFocused();
  await expect(page.locator('#terminal .xterm-rows')).not.toContainText('Unsupported message');
});

test('uses native mobile conversation history, input, and subagent navigation', async ({ page }) => {
  test.setTimeout(50_000);
  await page.addInitScript(() => {
    window.__conversationStreams = [];
    window.__mobileConversationScrollCalls = [];
    const visualViewportState = { width: 390, height: 844, offsetTop: 0, offsetLeft: 0, scale: 1 };
    const visualViewport = new EventTarget();
    for (const property of Object.keys(visualViewportState)) {
      Object.defineProperty(visualViewport, property, { get: () => visualViewportState[property] });
    }
    window.__setVisualViewport = (next) => {
      Object.assign(visualViewportState, next);
      visualViewport.dispatchEvent(new Event('resize'));
      visualViewport.dispatchEvent(new Event('scroll'));
    };
    let standaloneLayoutHeight = 844;
    Object.defineProperty(window, 'innerHeight', {
      configurable: true, get: () => standaloneLayoutHeight,
    });
    window.__setStandaloneViewport = (next) => {
      standaloneLayoutHeight = next.height;
      Object.assign(visualViewportState, next);
      visualViewport.dispatchEvent(new Event('resize'));
      visualViewport.dispatchEvent(new Event('scroll'));
      window.dispatchEvent(new Event('resize'));
    };
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: visualViewport });
    let pageVisibility = 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => pageVisibility });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => pageVisibility === 'hidden' });
    window.__setPageVisibility = (next) => {
      pageVisibility = next;
      document.dispatchEvent(new Event('visibilitychange'));
    };
    window.__mobileComposerFocusOptions = [];
    const nativeFocus = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function focus(options) {
      if (this.id === 'mobile-conversation-input') {
        window.__mobileComposerFocusOptions.push(options || null);
      }
      return nativeFocus.call(this, options);
    };
    const nativeScrollTo = Element.prototype.scrollTo;
    Element.prototype.scrollTo = function scrollTo(...args) {
      if (this.id === 'mobile-conversation-messages') {
        window.__mobileConversationScrollCalls.push(args[0]);
      }
      return nativeScrollTo.apply(this, args);
    };
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = class MockConversationWebSocket {
      static CONNECTING = NativeWebSocket.CONNECTING;
      static OPEN = NativeWebSocket.OPEN;
      static CLOSING = NativeWebSocket.CLOSING;
      static CLOSED = NativeWebSocket.CLOSED;

      constructor(url) {
        if (!String(url).includes('/conversation-ws')) return new NativeWebSocket(url);
        this.url = String(url);
        this.listeners = new Map();
        this.readyState = NativeWebSocket.CONNECTING;
        window.__conversationStreams.push(this);
        this.heartbeat = setInterval(() => this.emit('heartbeat', {}), 1_000);
        queueMicrotask(() => {
          if (this.closed) return;
          this.readyState = NativeWebSocket.OPEN;
          this.dispatch('open', {});
        });
      }
      addEventListener(type, listener) {
        const listeners = this.listeners.get(type) || [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
      }
      dispatch(type, event) {
        for (const listener of this.listeners.get(type) || []) listener(event);
      }
      emit(type, event) {
        if (type === 'conversation') {
          this.dispatch('message', {
            data: JSON.stringify({ type: 'conversation', ...JSON.parse(event.data) }),
          });
          return;
        }
        if (type === 'control') {
          this.dispatch('message', { data: event.data });
          return;
        }
        if (type === 'heartbeat') {
          this.dispatch('message', { data: JSON.stringify({ type: 'heartbeat', at: Date.now() }) });
          return;
        }
        if (type === 'error') {
          this.dispatch('error', event);
          this.readyState = NativeWebSocket.CLOSED;
          this.closed = true;
          clearInterval(this.heartbeat);
          this.dispatch('close', { code: 1006, reason: '' });
          return;
        }
        this.dispatch(type, event);
      }
      close(code = 1000, reason = '') {
        if (this.closed) return;
        this.closed = true;
        this.readyState = NativeWebSocket.CLOSED;
        clearInterval(this.heartbeat);
        this.dispatch('close', { code, reason });
      }
    };
  });
  await page.reload();
  const project = await createProject(page, {
    name: 'Mobile conversation', marker: '__MOBILE_CONVERSATION__',
  });
  const sessionName = await project.locator('.session-row').getAttribute('data-session');
  const sidebarSession = project.locator(`.session-row[data-session="${sessionName}"]`);
  const rootItems = Array.from({ length: 18 }, (_, index) => ({
    id: `assistant-${index}`, type: 'message', role: index % 2 ? 'user' : 'assistant',
    text: index === 0 ? [
      '# Markdown response',
      '',
      'This is **bold**, this is `inlineCode()`, and this is a [safe link](https://example.com).',
      'The type is `class None implements Option<number>`.',
      'Review `public/app.js:1-2` before applying the plan.',
      '',
      '**Standalone section:**',
      '',
      '- First item',
      '- Second item',
      '',
      '| Name | State |',
      '| --- | --- |',
      '| Renderer | Ready |',
      '',
      '```js',
      'const ready = true;',
      '```',
      '',
      '```python',
      'def greet(name):',
      '    return f"Hello {name}"',
      '```',
      '',
      '[Unsafe link](javascript:alert(1))',
      '<img src="javascript:alert(2)" onerror="window.__markdownXss = true" alt="Unsafe image">',
      '<script>window.__markdownXss = true</script>',
    ].join('\n') : index === 2
      ? 'พิมพ์\nมาแบบนั้นอีกแล้ว....'
      : `History message ${index + 1}`,
  }));
  rootItems.push(
    { id: 'thought-1', type: 'thought', title: 'Thought', text: 'I should inspect the provider.', status: 'working' },
    { id: 'tool-group-1', type: 'tool_group', title: 'Listed 1 dir, Read 2 files, Searched 1 time, Edited 1 file, Ran 1 command', status: 'completed', tools: [
      { id: 'tool-list', type: 'tool', title: 'List Files', summary: 'Inspect source files', subject: 'src', kind: 'list', status: 'completed', input: '{"target_directory":"src"}', output: 'Found files' },
      { id: 'tool-read-agents', type: 'tool', title: 'Read', subject: 'AGENTS.md', kind: 'read', status: 'completed', input: '{"path":"AGENTS.md"}', output: 'Provider instructions loaded', locations: ['AGENTS.md'], file: {
        path: 'AGENTS.md', content: '# Agent guide\n**Provider instructions** loaded\n_Keep tests focused._\n', startLine: 1, totalLines: 3,
      } },
      { id: 'tool-read-package', type: 'tool', title: 'Read', subject: 'package.json', kind: 'read', status: 'completed', output: 'Package loaded' },
      { id: 'tool-search-app', type: 'tool', title: 'Search', subject: 'render', kind: 'search', status: 'completed', input: '{"pattern":"render","target_file":"public/app.js"}', output: 'Found 1 match', matches: [
        { path: 'public/app.js', line: 2, text: 'render(status);' },
      ] },
      { id: 'tool-edit-app', type: 'tool', title: 'Edited', subject: 'app.js', kind: 'edit', status: 'completed', diffs: [{
        path: 'public/app.js', oldText: 'const status = "old";\nrender(status);\n',
        newText: 'const status = "ready";\nrender(status);\n',
        oldLine: 1, newLine: 1,
      }] },
      { id: 'tool-shell', type: 'tool', title: 'Shell', kind: 'execute', status: 'completed',
        summary: 'Verify the focused test suite',
        command: `node --test ${'a-very-long-path/'.repeat(12)}test.js`,
        output: Array.from({ length: 80 }, (_, line) => `test output line ${line + 1}`).join('\n') },
    ] },
    { id: 'plan-1', type: 'plan', title: 'Plan', status: 'working', entries: [{ id: 'p1', content: 'Inspect events', status: 'completed' }, { id: 'p2', content: 'Render cards', status: 'working' }] },
    { id: 'goal-1', type: 'goal', title: 'Goal', objective: 'Render all Grok events', phase: 'executing', status: 'working', progress: { completed: 1, total: 2 }, metrics: { elapsedMs: 8_000, tokensUsed: 120 }, lastEvent: 'goal_created' },
    { id: 'task-1', type: 'task', title: 'Run tests', command: 'npm test', output: 'all green', exitCode: 0, status: 'completed' },
    { id: 'event-1', type: 'event', kind: 'future_event', title: 'future_event', text: '{"kept":true}', status: 'completed' },
    { id: 'recap-1', type: 'recap', title: 'Recap', text: 'Work completed so far, with the remaining verification still pending.', auto: true, status: 'completed' },
  );
  const subagentItem = {
    id: 'subagent-call-spawn-1', type: 'subagent',
    title: 'Inspect mobile behavior', role: 'explore', capabilityMode: 'read-only',
    phase: 'calling', status: 'working',
  };
  const secondSubagentItem = {
    id: 'subagent-call-spawn-2', type: 'subagent',
    title: 'Review the test coverage', role: 'review', model: 'tera', phase: 'running', status: 'working',
    threadId: 'child-thread-2',
  };
  const completedSubagentItem = {
    id: 'subagent-call-spawn-3', type: 'subagent',
    title: 'Summarize the findings', role: 'summary', phase: 'done', status: 'completed',
  };
  rootItems.push({
    id: 'user-image-attachment', type: 'message', role: 'user',
    text: 'Please inspect this\n\n![IMG_6024.png](/tmp/agent-remote-uploads-test/11111111-1111-4111-8111-111111111111.png)',
  }, subagentItem, secondSubagentItem, completedSubagentItem);
  let currentModelId = 'qwen-local';
  let currentEffortId = 'high';
  let currentModeId = 'normal';
  let currentActivity = { active: false };
  const queuedInputs = [];
  const rootConversation = () => ({
    provider: { id: 'grok', label: 'Grok' },
    thread: {
      id: 'root-thread', title: 'Mobile root', agentName: 'grok-build-plan', model: currentModelId,
      status: currentActivity.active ? 'working' : 'idle',
    },
    parent: null, rootThreadId: 'root-thread', items: rootItems,
    children: [
      ...(subagentItem.threadId
        ? [{ id: 'child-thread', title: 'Inspect mobile behavior', agentName: 'explore', status: subagentItem.status }]
        : []),
      { id: 'child-thread-2', title: 'Review the test coverage', agentName: 'review', model: 'tera', status: secondSubagentItem.status },
    ],
    queue: queuedInputs,
    activity: currentActivity,
    controls: { model: {
      currentId: currentModelId,
      options: [
        { id: 'qwen-local', label: 'Qwen 3.8 27B', provider: { id: 'local', label: 'Local' }, description: 'Local model', contextWindowTokens: 190_000 },
        { id: 'grok-4.6', label: 'Grok 4.6', provider: { id: 'xai', label: 'xAI' }, description: 'Frontier model', contextWindowTokens: 500_000,
          currentEffortId, efforts: [
            { id: 'high', value: 'high', label: 'High Effort', description: 'Deep work', default: true },
            { id: 'low', value: 'low', label: 'Low Effort', description: 'Quick work', default: false },
          ] },
      ],
    }, mode: {
      currentId: currentModeId,
      options: [
        { id: 'normal', label: 'Normal', description: 'Work normally and ask first' },
        { id: 'plan', label: 'Plan', description: 'Plan before changing files' },
        { id: 'auto', label: 'Auto', description: 'Approve lower-risk calls' },
        { id: 'alwaysApprove', label: 'Always approve', description: 'Skip ordinary prompts' },
      ],
    }, commands: { options: [
      { name: 'always-approve', description: 'Toggle always-approve mode' },
      { name: 'reload-plugins', description: 'Reload plugins from disk' },
      { name: 'goal', description: 'Set, manage, or check an autonomous goal' },
      { name: 'find-skills', description: 'Discover and install agent skills' },
      { name: 'terminal-browser', description: 'Open a browser in the terminal' },
      { name: 'compact', description: 'Compress conversation history', inputHint: 'optional focus' },
      { name: 'deep-research', description: 'Research a topic', inputHint: 'topic' },
    ] } },
    context: { usedTokens: 5_979, windowTokens: currentModelId === 'grok-4.6' ? 500_000 : 190_000, usagePercent: currentModelId === 'grok-4.6' ? 1 : 3 },
    capabilities: { send: true, children: true },
  });
  const childConversation = (text = 'Subagent findings') => ({
    provider: { id: 'grok', label: 'Grok' },
    // The child transport can expose the root tmux title/status. The mobile
    // sheet must keep using the authoritative root lifecycle card instead.
    thread: { id: 'child-thread', title: 'build', agentName: 'qwen-local', status: 'working' },
    parent: { id: 'root-thread', title: 'Mobile root' }, rootThreadId: 'root-thread',
    items: [
      { id: 'child-thought', type: 'thought', title: 'Thought', text: 'Inspecting child files', status: 'completed' },
      { id: 'child-tool', type: 'tool', title: 'Search files', kind: 'search', status: 'completed', output: 'Found the adapter' },
      { id: 'child-answer', type: 'message', role: 'assistant', text },
    ],
    children: [], capabilities: { send: false, children: false },
  });
  const mobileInputs = [];
  const cancellations = [];
  const modelChanges = [];
  const modeChanges = [];
  const goalActions = [];
  const queueActions = [];
  const uploads = [];
  const permissionResponses = [];
  const questionResponses = [];
  const planReviewResponses = [];
  let releaseFirstQuestion;
  let releaseHelloInput;
  let releaseQueuedInput;
  let releaseAfterStopInput;
  let releaseStreamingUpload;
  let releaseFirstChildRead;
  let releaseCancellation;
  let holdNextCancellation = false;
  let holdFirstChildRead = true;
  let firstQuestion = true;
  let conversationReads = 0;
  await page.route('**/api/conversations/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/completions/files')) {
      return route.fulfill({ json: { files: [
        { path: 'public/mobile-conversation.js', name: 'mobile-conversation.js', directory: 'public' },
      ] } });
    }
    if (pathname.endsWith('/permission')) {
      permissionResponses.push(route.request().postDataJSON());
      return route.fulfill({ status: 202, json: { accepted: true } });
    }
    if (pathname.endsWith('/cancel')) {
      cancellations.push(route.request().postDataJSON());
      if (holdNextCancellation) {
        holdNextCancellation = false;
        await new Promise((resolve) => { releaseCancellation = resolve; });
        releaseCancellation = undefined;
      }
      return route.fulfill({ status: 202, json: { accepted: true, active: true } });
    }
    if (pathname.endsWith('/goal')) {
      const submitted = route.request().postDataJSON();
      goalActions.push(submitted.action);
      const goalIndex = rootItems.findIndex((item) => item.id === 'goal-1');
      if (goalIndex >= 0) {
        if (submitted.action === 'clear') rootItems.splice(goalIndex, 1);
        else rootItems[goalIndex].status = submitted.action === 'pause' ? 'user_paused' : 'working';
      }
      return route.fulfill({ status: 202, json: { accepted: true, action: submitted.action } });
    }
    if (pathname.endsWith('/input')) {
      const submitted = route.request().postDataJSON();
      mobileInputs.push(submitted);
      if (currentActivity.active) {
        const queueId = submitted.text === 'queued follow up' ? 'queue-mobile-1' : `queue-mobile-${queuedInputs.length + 1}`;
        queuedInputs.push({ id: queueId, text: submitted.text, createdAt: Date.now(), attachments: [] });
        if (submitted.text === 'queued follow up') {
          await new Promise((resolve) => { releaseQueuedInput = resolve; });
        }
        if (submitted.text === 'message after accepted stop') {
          await new Promise((resolve) => {
            releaseAfterStopInput = () => {
              releaseAfterStopInput = undefined;
              resolve();
            };
          });
        }
        return route.fulfill({ status: 202, json: { accepted: true, queued: true, queueId } });
      }
      if (submitted.text === 'hello from phone') {
        rootItems.push({
          id: 'user-fast-start', type: 'message', role: 'user', text: submitted.text,
        });
        await new Promise((resolve) => { releaseHelloInput = resolve; });
      }
      return route.fulfill({ status: 202, json: { accepted: true, queued: false } });
    }
    if (pathname.endsWith('/model')) {
      const submitted = route.request().postDataJSON();
      modelChanges.push(submitted);
      currentModelId = submitted.modelId;
      if (submitted.effortId) currentEffortId = submitted.effortId;
      await new Promise((resolve) => setTimeout(resolve, 180));
      return route.fulfill({ status: 202, json: {
        accepted: true, modelId: currentModelId, ...(submitted.effortId ? { effortId: submitted.effortId } : {}),
      } });
    }
    if (pathname.endsWith('/mode')) {
      const submitted = route.request().postDataJSON();
      modeChanges.push(submitted);
      currentModeId = submitted.modeId;
      await new Promise((resolve) => setTimeout(resolve, 180));
      return route.fulfill({ status: 202, json: { accepted: true, modeId: currentModeId } });
    }
    if (pathname.endsWith('/attachments') && route.request().method() === 'POST') {
      const fileName = route.request().headers()['x-file-name'];
      if (fileName === encodeURIComponent('rejected.mov')) {
        return route.fulfill({
          status: 413,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Fixture rejected this upload' }),
        });
      }
      if (fileName === encodeURIComponent('streaming.png')) {
        await new Promise((resolve) => { releaseStreamingUpload = resolve; });
      }
      uploads.push({
        name: fileName,
        bytes: route.request().postDataBuffer()?.toString('utf8'),
      });
      return route.fulfill({ status: 201, json: { attachment: {
        id: '11111111-1111-4111-8111-111111111111', name: 'phone.png', mimeType: 'image/png', size: 8,
        previewUrl: `/api/conversations/${sessionName}/attachments/11111111-1111-4111-8111-111111111111`,
      } } });
    }
    if (pathname.includes('/attachments/')) {
      return route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('fake-image') });
    }
    if (pathname.includes('/queue/')) {
      if (pathname.endsWith('/queue/reorder')) {
        const { queueIds } = route.request().postDataJSON();
        const byId = new Map(queuedInputs.map((entry) => [entry.id, entry]));
        queuedInputs.splice(0, queuedInputs.length, ...queueIds.map((id) => byId.get(id)));
        queueActions.push({ action: 'reorder', queueIds });
        return route.fulfill({ status: 202, json: { accepted: true, queueIds } });
      }
      const action = pathname.endsWith('/steer') ? 'steer' : 'delete';
      queueActions.push({ action });
      queuedInputs.splice(0);
      return route.fulfill({ status: 202, json: { accepted: true } });
    }
    if (pathname.endsWith('/question')) {
      questionResponses.push(route.request().postDataJSON());
      if (firstQuestion) {
        firstQuestion = false;
        await new Promise((resolve) => { releaseFirstQuestion = resolve; });
        return route.fulfill({ status: 500, json: { error: 'Question transport unavailable' } });
      }
      return route.fulfill({ status: 202, json: { accepted: true } });
    }
    if (pathname.endsWith('/plan-review')) {
      planReviewResponses.push(route.request().postDataJSON());
      return route.fulfill({ status: 202, json: { accepted: true } });
    }
    conversationReads += 1;
    if (conversationReads === 1) {
      return route.fulfill({ status: 503, json: {
        error: 'Connecting to Grok', code: 'CONVERSATION_INITIALIZING',
      } });
    }
    const selectedThread = new URL(route.request().url()).searchParams.get('thread');
    const child = selectedThread === 'child-thread';
    const secondChild = selectedThread === 'child-thread-2';
    if (child && holdFirstChildRead) {
      holdFirstChildRead = false;
      await new Promise((resolve) => { releaseFirstChildRead = resolve; });
    }
    return route.fulfill({ json: { conversation: child ? childConversation() : secondChild ? {
      provider: { id: 'grok', label: 'Grok' },
      thread: { id: 'child-thread-2', title: 'Review the test coverage', agentName: 'review', model: 'tera', status: 'working' },
      parent: { id: 'root-thread', title: 'Mobile root' }, rootThreadId: 'root-thread',
      items: [{ id: 'child-two-answer', type: 'message', role: 'assistant', text: 'Second subagent findings' }],
      children: [], capabilities: { send: false, children: false },
    } : rootConversation() } });
  });
  await page.setViewportSize({ width: 390, height: 844 });

  const conversation = page.locator('#mobile-conversation');
  const messages = conversation.locator('#mobile-conversation-messages');
  await expect(conversation).toBeVisible();
  await expect.poll(() => messages.evaluate((node) =>
    getComputedStyle(node, '::before').content)).toBe('none');
  await expect(page.locator('.topbar')).toBeHidden();
  await expect(page.locator('#sidebar-edge-trigger')).toBeHidden();
  await page.locator('#sidebar-edge-trigger').dispatchEvent('pointerenter');
  await expect(page.locator('.workspace')).not.toHaveAttribute('data-sidebar-peek', 'true');
  await expect.poll(() => conversation.locator('#mobile-conversation-menu').evaluate((button) => ({
    border: getComputedStyle(button).borderTopStyle,
    radius: getComputedStyle(button).borderRadius,
    background: getComputedStyle(button).backgroundColor,
  }))).toEqual({ border: 'none', radius: '0px', background: 'rgba(0, 0, 0, 0)' });
  await expect(conversation.locator('#mobile-conversation-menu')).toHaveAttribute('aria-expanded', 'false');
  await expect(conversation.locator('#mobile-conversation-menu')).toHaveClass(/ui-icon-button/);
  await expect(conversation.locator('#mobile-conversation-menu')).toHaveAttribute('data-ui-variant', 'bare');
  await expect(conversation.locator('#mobile-conversation-menu .sidebar-nav-icon')).toHaveCount(1);
  await expect(conversation.locator('#mobile-conversation-menu .sidebar-nav-icon')).toHaveCSS('width', '24px');
  await expect(conversation.locator('#mobile-conversation-menu .sidebar-nav-icon')).toHaveCSS('height', '24px');
  await expect(conversation.locator('#mobile-conversation-menu .sidebar-nav-icon')).toHaveCSS('fill', 'none');
  await expect(conversation.locator('#mobile-conversation-menu .sidebar-nav-icon')).toHaveCSS('stroke', 'rgb(170, 170, 176)');
  await expect(conversation.locator('#mobile-conversation-menu .sidebar-nav-icon path')).toHaveCount(2);
  await conversation.locator('#mobile-conversation-menu').hover();
  await expect(conversation.locator('#mobile-conversation-menu')).toHaveCSS('cursor', 'pointer');
  await expect(conversation.locator('#mobile-conversation-menu')).toHaveCSS('color', 'rgb(222, 222, 224)');
  await expect(conversation.locator('#mobile-conversation-menu .sidebar-nav-icon')).toHaveCSS('stroke', 'rgb(222, 222, 224)');
  await expect(page.locator('#open-sidebar .sidebar-nav-icon')).toHaveCSS('width', '24px');
  await expect(page.locator('#open-sidebar .sidebar-nav-icon')).toHaveCSS('height', '24px');
  await expect(page.locator('#open-sidebar .sidebar-nav-icon path')).toHaveCount(2);
  await expect(conversation.locator('#mobile-conversation-menu')).not.toContainText('☰');
  const mobileStageBox = await page.locator('#terminal-stage').boundingBox();
  const mobileShellBox = await page.locator('.terminal-shell').boundingBox();
  expect(mobileStageBox.y).toBe(mobileShellBox.y);
  expect(mobileStageBox.height).toBe(mobileShellBox.height);
  // Let the initial 503 retry commit the first chat to the client cache before
  // measuring a switch away and back. Workspace SSE intentionally makes the
  // second chat appear faster than the old polling-only path did.
  await expect(conversation.getByRole('heading', { name: 'Markdown response' })).toBeVisible({ timeout: 8_000 });
  // The first HTTP snapshot already contains the agent lifecycle. The dock
  // must commit with that snapshot instead of waiting for a later WebSocket
  // replay, and its late layout slot must keep a tail-following reader pinned.
  await expect(conversation.locator('.mobile-subagent-pill')).toBeVisible();
  await expect.poll(() => messages.evaluate((node) =>
    Math.max(0, node.scrollHeight - node.scrollTop - node.clientHeight))).toBeLessThanOrEqual(1);
  await expect.poll(() => conversation.evaluate((node) => {
    const messages = node.querySelector('#mobile-conversation-messages');
    const pill = node.querySelector('.mobile-activity-pill-cluster').getBoundingClientRect();
    const lastItem = [...messages.children].reverse()
      .find((item) => item.getBoundingClientRect().height > 0)?.getBoundingClientRect();
    return {
      layout: getComputedStyle(messages).display,
      topGap: Math.round(pill.top - lastItem.bottom),
    };
  })).toEqual({ layout: 'flex', topGap: 20 });
  const projectId = await project.getAttribute('data-project');
  const secondSessionName = await page.evaluate(async (id) => {
    const response = await fetch(`/api/projects/${encodeURIComponent(id)}/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    return (await response.json()).session.name;
  }, projectId);
  await expect(project.locator('.session-row')).toHaveCount(2, { timeout: 6_000 });

  await conversation.locator('#mobile-conversation-menu').click();
  await expect(page.locator('.workspace')).toHaveAttribute('data-sidebar', 'expanded');
  await expect(conversation.locator('#mobile-conversation-menu')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#new-project')).toHaveCSS('font-size', '26px');
  await expect(project.locator('.project-new-chat svg')).toHaveCSS('width', '22px');
  await expect(project.locator('.project-new-chat svg')).toHaveCSS('height', '22px');
  await expect(project.locator('.project-action').nth(1)).toHaveCSS('font-size', '23px');
  await expect(project.locator('.project-action')).toHaveCount(3);
  await expect(project.locator('.project-action').first()).toHaveClass(/ui-icon-button/);
  await expect(project.locator('.project-delete')).toHaveAttribute('data-ui-variant', 'danger');
  await expect(project.locator('.project-delete')).toHaveCSS('font-size', '26px');
  await expect(project.locator('.session-close').first()).toHaveCSS('font-size', '26px');
  await expect(page.locator('#sidebar-backdrop')).toBeVisible();
  await page.locator('#sidebar-backdrop').click({ position: { x: 380, y: 420 } });
  await expect(page.locator('.workspace')).toHaveAttribute('data-sidebar', 'collapsed');
  await expect(conversation.locator('#mobile-conversation-menu')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#sidebar-backdrop')).toBeHidden();
  await conversation.locator('#mobile-conversation-menu').click();
  await expect(page.locator('.workspace')).toHaveAttribute('data-sidebar', 'expanded');
  await project.locator(`.session-row[data-session="${secondSessionName}"] .session-button`).click();
  await expect(project.locator(`.session-row[data-session="${secondSessionName}"]`)).toHaveClass(/active/);
  await expect(page.locator('.workspace')).toHaveAttribute('data-sidebar', 'collapsed');
  await conversation.locator('#mobile-conversation-menu').click();
  const readsBeforeCachedReturn = conversationReads;
  await project.locator(`.session-row[data-session="${sessionName}"] .session-button`).click();
  await expect(project.locator(`.session-row[data-session="${sessionName}"]`)).toHaveClass(/active/);
  await expect(page.locator('.workspace')).toHaveAttribute('data-sidebar', 'collapsed');
  await expect(page.locator('#terminal')).toBeHidden();
  const boot = conversation.locator('#mobile-conversation-boot');
  await expect(boot).toBeHidden();
  await expect(conversation.getByRole('heading', { name: 'Markdown response' })).toBeVisible();
  await page.waitForTimeout(100);
  expect(conversationReads).toBe(readsBeforeCachedReturn);
  await expect(conversation.locator('.mobile-conversation-header')).toBeVisible();
  const pwaNavbarChrome = await conversation.locator('.mobile-conversation-header').evaluate((header) => {
    const root = document.documentElement;
    const property = '--visual-viewport-inset-top';
    const previousInset = root.style.getPropertyValue(property);
    root.style.setProperty(property, '20px');
    const conversationStyle = getComputedStyle(header.closest('.mobile-conversation'));
    const headerStyle = getComputedStyle(header);
    const homeHeaderStyle = getComputedStyle(document.querySelector('.topbar'));
    const menuStyle = getComputedStyle(header.querySelector('#mobile-conversation-menu'));
    const homeMenuStyle = getComputedStyle(document.querySelector('#open-sidebar'));
    const safeAreaStyle = getComputedStyle(header, '::before');
    const homeCanvasStyle = getComputedStyle(document.querySelector('.empty-state'));
    const sidebarStyle = getComputedStyle(document.querySelector('.sidebar'));
    const sidebarHeaderStyle = getComputedStyle(document.querySelector('.sidebar-header'));
    const workspace = document.querySelector('.workspace');
    const hadMobileConversation = workspace.dataset.mobileConversation;
    delete workspace.dataset.mobileConversation;
    const homeWorkspaceStyle = getComputedStyle(workspace);
    const homeShellStyle = getComputedStyle(document.querySelector('.terminal-shell'));
    const result = {
      statusBarStyle: document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')?.content,
      themeColor: document.querySelector('meta[name="theme-color"]')?.content,
      navbarBackground: headerStyle.backgroundColor,
      navbarHeight: headerStyle.height,
      navbarBorder: headerStyle.borderBottomWidth,
      navbarShadow: headerStyle.boxShadow,
      matchesHomeNavbar: headerStyle.height === homeHeaderStyle.height
        && headerStyle.backgroundColor === homeHeaderStyle.backgroundColor,
      matchesHomeMenu: menuStyle.width === homeMenuStyle.width
        && menuStyle.height === homeMenuStyle.height,
      safeAreaBackground: safeAreaStyle.backgroundColor,
      homeCanvasBackground: homeCanvasStyle.backgroundColor,
      chatCanvasBackground: conversationStyle.backgroundColor,
      safeAreaPadding: conversationStyle.paddingTop,
      safeAreaHeight: safeAreaStyle.height,
      homeSafeAreaPadding: homeWorkspaceStyle.paddingTop,
      homeShellSafeAreaPadding: homeShellStyle.paddingTop,
      homeSafeAreaBackground: homeWorkspaceStyle.backgroundColor,
      sidebarSafeAreaPadding: sidebarStyle.paddingTop,
      sidebarHeaderHeight: sidebarHeaderStyle.height,
    };
    if (hadMobileConversation !== undefined) workspace.dataset.mobileConversation = hadMobileConversation;
    if (previousInset) root.style.setProperty(property, previousInset);
    else root.style.removeProperty(property);
    return result;
  });
  expect(pwaNavbarChrome).toEqual({
    statusBarStyle: 'black-translucent',
    themeColor: '#0c0c0d',
    navbarBackground: 'rgb(12, 12, 13)',
    navbarHeight: '44px',
    navbarBorder: '0px',
    navbarShadow: 'none',
    matchesHomeNavbar: true,
    matchesHomeMenu: true,
    safeAreaBackground: 'rgba(0, 0, 0, 0)',
    homeCanvasBackground: 'rgb(12, 12, 13)',
    chatCanvasBackground: 'rgb(12, 12, 13)',
    safeAreaPadding: '0px',
    safeAreaHeight: 'auto',
    homeSafeAreaPadding: '0px',
    homeShellSafeAreaPadding: '0px',
    homeSafeAreaBackground: 'rgb(12, 12, 13)',
    sidebarSafeAreaPadding: '0px',
    sidebarHeaderHeight: '44px',
  });
  // Standalone Safari can report a small non-keyboard bottom inset for browser
  // chrome/home indicator. Idle surfaces must keep filling the layout viewport.
  await page.evaluate(() => window.__setVisualViewport({ height: 810, offsetTop: 0 }));
  await expect(page.locator('html')).toHaveAttribute('data-visual-keyboard', 'false');
  await expect.poll(() => page.evaluate(() => {
    const root = document.querySelector('#mobile-conversation').getBoundingClientRect();
    const sidebar = document.querySelector('.sidebar').getBoundingClientRect();
    const composer = document.querySelector('#mobile-conversation-composer').getBoundingClientRect();
    return {
      root: [Math.round(root.top), Math.round(root.height)],
      sidebar: [Math.round(sidebar.top), Math.round(sidebar.height)],
      composerGap: Math.round(window.innerHeight - composer.bottom),
    };
  })).toEqual({ root: [0, 844], sidebar: [0, 844], composerGap: 4 });
  await page.evaluate(() => window.__setVisualViewport({ height: 844, offsetTop: 0 }));
  await expect(conversation.locator('#mobile-conversation-composer')).toBeVisible();
  await expect(conversation.locator('#mobile-conversation-title')).toBeHidden();
  await expect(conversation.locator('#mobile-conversation-meta')).toBeHidden();
  await expect(conversation.locator('#mobile-conversation-state')).toBeHidden();
  await expect(page.locator('#terminal')).toBeHidden();
  await expect.poll(() => page.evaluate(async (name) => {
    const payload = await (await fetch('/api/sessions')).json();
    return payload.sessions.find((session) => session.name === name)?.attached;
  }, sessionName)).toBeLessThanOrEqual(1);
  await expect(conversation.locator('#mobile-conversation-state')).toHaveText('Ready', { timeout: 8_000 });
  await expect(conversation.locator('#mobile-conversation-boot')).toBeHidden();
  await expect(conversation.locator('.mobile-conversation-loading')).toHaveCount(0, { timeout: 8_000 });
  await expect(conversation.locator('.mobile-message')).toHaveCount(19);
  await expect(conversation.locator('.mobile-message-assistant .mobile-message-author')).toHaveCount(0);
  await expect(conversation.locator('.mobile-message-user .mobile-message-author').first()).toHaveText('You');
  const imageMessage = conversation.locator('[data-message-id="user-image-attachment"]');
  const imageAttachment = imageMessage.locator('.mobile-message-user-attachment');
  await expect(imageAttachment).toHaveAttribute('aria-label', 'View IMG_6024.png');
  await expect(imageAttachment).toHaveAttribute('data-preview', 'fallback');
  await expect(imageAttachment.locator('img')).toHaveCount(0);
  await expect(imageAttachment.locator('small')).toHaveText('IMG_6024.png');
  await expect(imageMessage.locator('.mobile-message-user-text')).toHaveText('Please inspect this');
  await expect(imageMessage).not.toContainText('![IMG_6024.png]');
  await expect(messages).toHaveCSS('scroll-behavior', 'auto');
  await expect.poll(() => messages.evaluate((element) =>
    element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => window.__mobileConversationScrollCalls
    .filter((call) => call?.behavior === 'smooth'))).toEqual([]);
  // Safari can resume without having delivered the matching hidden/pagehide
  // event. A foreground signal must still replace the possibly half-open
  // socket and reconcile an authoritative snapshot.
  const missedBackgroundStreamCount = await page.evaluate(() => window.__conversationStreams.length);
  const missedBackgroundReads = conversationReads;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => page.evaluate(() => window.__conversationStreams.length))
    .toBeGreaterThan(missedBackgroundStreamCount);
  expect(conversationReads).toBeGreaterThan(missedBackgroundReads);
  const backgroundStreamCount = await page.evaluate(() => window.__conversationStreams.length);
  const backgroundReads = conversationReads;
  await page.evaluate(() => window.__setPageVisibility('hidden'));
  await expect.poll(() => page.evaluate(() => window.__conversationStreams.at(-1).closed)).toBe(true);
  rootItems.push({
    id: 'assistant-after-background', type: 'message', role: 'assistant',
    text: 'Streaming resumed after returning to Safari.',
  });
  await page.evaluate(() => window.__setPageVisibility('visible'));
  await expect(conversation.getByText('Streaming resumed after returning to Safari.')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__conversationStreams.length)).toBeGreaterThan(backgroundStreamCount);
  expect(conversationReads).toBeGreaterThan(backgroundReads);
  const failedStreamCount = await page.evaluate(() => window.__conversationStreams.length);
  const failedStreamReads = conversationReads;
  const failedStream = await page.evaluateHandle(() => window.__conversationStreams.at(-1));
  await failedStream.evaluate((stream) => stream.emit('error', {}));
  await expect.poll(() => failedStream.evaluate((stream) => stream.closed)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__conversationStreams.length)).toBeGreaterThan(failedStreamCount);
  await expect.poll(() => conversationReads).toBeGreaterThan(failedStreamReads);
  const markdownMessage = conversation.locator('[data-message-id="assistant-0"] .mobile-markdown');
  await expect(markdownMessage.locator('h1')).toHaveText('Markdown response');
  await expect(markdownMessage.locator('h1')).toHaveCSS('color', 'rgb(210, 210, 212)');
  const inlineBold = markdownMessage.locator('strong').filter({ hasText: /^bold$/ });
  await expect(inlineBold).toHaveCSS('color', 'rgb(210, 210, 212)');
  await expect(inlineBold).toHaveCSS('font-weight', '700');
  const standaloneHeading = markdownMessage.locator('p > strong').filter({ hasText: /^Standalone section:$/ });
  await expect(standaloneHeading).toHaveCSS('color', 'rgb(210, 210, 212)');
  await expect(markdownMessage.locator('li')).toHaveCount(2);
  await expect.poll(() => markdownMessage.locator('li').first().evaluate(
    (node) => getComputedStyle(node, '::marker').color,
  )).toBe('rgb(100, 190, 172)');
  await expect(markdownMessage.locator('table')).toContainText('Renderer');
  const codeBlocks = markdownMessage.locator('.mobile-markdown-code');
  await expect(codeBlocks).toHaveCount(2);
  await expect(codeBlocks.nth(0).locator('.mobile-markdown-code-toolbar')).toContainText('js');
  await expect(codeBlocks.nth(0).locator('.mobile-markdown-code-toolbar > span')).toHaveCSS('color', 'rgb(232, 164, 101)');
  await expect(codeBlocks.nth(0).getByRole('button', { name: 'Copy code' })).toBeVisible();
  await expect(codeBlocks.nth(0).locator('code')).toHaveAttribute('data-language', 'javascript');
  await expect(codeBlocks.nth(0).locator('.hljs-keyword')).toHaveText('const');
  await expect(codeBlocks.nth(0).locator('.hljs-literal')).toHaveText('true');
  await expect(codeBlocks.nth(1).locator('.mobile-markdown-code-toolbar')).toContainText('python');
  await expect(codeBlocks.nth(1).locator('code')).toHaveAttribute('data-language', 'python');
  await expect(codeBlocks.nth(1).locator('.hljs-keyword')).toHaveText(['def', 'return']);
  await expect(codeBlocks.nth(1).locator('.hljs-title.function_')).toHaveText('greet');
  const inlineType = markdownMessage.locator('code.hljs', { hasText: 'class None implements Option' });
  await expect(inlineType).toBeVisible();
  await expect(inlineType).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(inlineType).toHaveCSS('border-top-width', '0px');
  await expect(inlineType).toHaveCSS('padding-left', '0px');
  await expect(inlineType.locator('.hljs-keyword')).toHaveText(['class', 'implements']);
  await expect(inlineType.locator('.hljs-title.class_')).toHaveText(['None', 'Option']);
  await expect(markdownMessage.getByRole('link', { name: 'safe link' })).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(markdownMessage.locator('script, [onerror]')).toHaveCount(0);
  await expect(markdownMessage.locator('a', { hasText: 'Unsafe link' })).not.toHaveAttribute('href', /.+/);
  await expect(markdownMessage).toContainText('Unsafe image');
  expect(await page.evaluate(() => window.__markdownXss)).toBeUndefined();
  const softBreakHistory = conversation.locator('[data-message-id="assistant-2"] .mobile-markdown');
  await expect(softBreakHistory).toHaveText('พิมพ์ มาแบบนั้นอีกแล้ว....');
  await expect(softBreakHistory.locator('br')).toHaveCount(0);
  // Narrow iPhone layouts legitimately wrap Thai prose, but wrapped lines
  // should read as one sentence rather than looking like separate paragraphs.
  await expect.poll(() => softBreakHistory.evaluate((node) => parseFloat(getComputedStyle(node).lineHeight)))
    .toBeGreaterThanOrEqual(22);
  const fileReference = markdownMessage.getByRole('button', { name: 'Open public/app.js at line 1' });
  await expect(fileReference).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(fileReference).toHaveCSS('color', 'rgb(100, 190, 172)');
  await expect(fileReference).toHaveCSS('border-top-width', '0px');
  await expect(fileReference).toHaveCSS('padding-left', '0px');
  await expect(fileReference).toBeVisible();
  await fileReference.click();
  const fileSheet = conversation.locator('.mobile-file-sheet');
  await expect(fileSheet).toBeVisible();
  await expect(fileSheet.locator('.mobile-file-sheet-header')).toContainText('public/app.js · Lines 1–2');
  await expect(fileSheet.locator('.mobile-file-line[data-highlighted="true"]')).toHaveCount(2);
  await expect(fileSheet.locator('.mobile-file-lines')).toContainText('const status = "ready";');
  await expect(fileSheet.locator('.mobile-file-line .hljs-keyword').first()).toHaveText('const');
  await expect(fileSheet.locator('.mobile-file-line .hljs-string').first()).toHaveText('"ready"');
  const fileSheetPanel = fileSheet.locator('.mobile-file-sheet-panel');
  await expect.poll(() => fileSheet.evaluate((sheet) => ({
    body: getComputedStyle(sheet.querySelector('.mobile-file-sheet-body'), '::-webkit-scrollbar').display,
    lines: getComputedStyle(sheet.querySelector('.mobile-file-lines'), '::-webkit-scrollbar').display,
  }))).toEqual({ body: 'none', lines: 'none' });
  expect((await fileSheetPanel.boundingBox()).height).toBeLessThan(400);
  await fileSheet.locator('.mobile-file-lines').evaluate((lines) => {
    const row = lines.querySelector('.mobile-file-line');
    for (let index = 0; index < 120; index += 1) lines.append(row.cloneNode(true));
  });
  await expect.poll(() => fileSheetPanel.evaluate((panel) => panel.getBoundingClientRect().height))
    .toBeLessThanOrEqual(844 * .8 + 1);
  await expect.poll(() => fileSheet.locator('.mobile-file-lines').evaluate((lines) =>
    lines.scrollHeight > lines.clientHeight)).toBe(true);
  const fileSheetHandle = fileSheet.getByRole('button', { name: 'Drag down to close file preview' });
  await fileSheetHandle.evaluate((node) => Promise.all(node.closest('.mobile-file-sheet-panel')
    .getAnimations().map((animation) => animation.finished)));
  const fileSheetHandleBox = await fileSheetHandle.boundingBox();
  await page.mouse.move(fileSheetHandleBox.x + fileSheetHandleBox.width / 2,
    fileSheetHandleBox.y + fileSheetHandleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(fileSheetHandleBox.x + fileSheetHandleBox.width / 2,
    fileSheetHandleBox.y + fileSheetHandleBox.height / 2 + 120, { steps: 4 });
  await page.mouse.up();
  await expect(fileSheet).toBeHidden();
  await expect(conversation.locator('.mobile-event-card')).toHaveCount(10);
  await expect(conversation.locator('[data-event-id="goal-1"]')).toHaveCount(0);
  const goalRow = conversation.locator('.mobile-conversation-goal');
  await expect(goalRow).toContainText('Pursuing goal');
  await expect(goalRow).toContainText('Render all Grok events');
  await expect(goalRow).toContainText('• 8s');
  await goalRow.getByRole('button', { name: 'Show goal details' }).click();
  await expect(goalRow.locator('.mobile-conversation-goal-details')).toContainText('1 / 2 deliverables');
  await goalRow.getByRole('button', { name: 'Pause goal' }).click();
  await expect.poll(() => goalActions).toContain('pause');
  await expect(goalRow.getByRole('button', { name: 'Resume goal' })).toBeVisible();
  await goalRow.getByRole('button', { name: 'Resume goal' }).click();
  await expect.poll(() => goalActions).toContain('resume');
  await expect(goalRow.getByRole('button', { name: 'Pause goal' })).toBeVisible();
  await goalRow.getByRole('button', { name: 'Delete goal' }).click();
  await expect.poll(() => goalActions).toContain('clear');
  await expect(goalRow).toHaveCount(0);
  const contextWindow = conversation.locator('#mobile-conversation-context');
  await expect(contextWindow).toContainText('6K / 190K');
  await expect(contextWindow.locator('progress')).toBeVisible();
  await expect.poll(() => contextWindow.locator('progress').evaluate((progress) => progress.value))
    .toBeCloseTo((5_979 / 190_000) * 100, 4);
  const emptyConversationWithContext = rootConversation();
  emptyConversationWithContext.items = [];
  await page.evaluate((nextConversation) => {
    window.__conversationStreams.at(-1).emit('conversation', {
      data: JSON.stringify({ conversation: nextConversation }),
    });
  }, emptyConversationWithContext);
  await expect(contextWindow).toBeHidden();
  await page.evaluate((nextConversation) => {
    window.__conversationStreams.at(-1).emit('conversation', {
      data: JSON.stringify({ conversation: nextConversation }),
    });
  }, rootConversation());
  await expect(contextWindow).toBeVisible();
  const conversationWithoutUsage = rootConversation();
  delete conversationWithoutUsage.context;
  await page.evaluate((nextConversation) => {
    window.__conversationStreams.at(-1).emit('conversation', {
      data: JSON.stringify({ conversation: nextConversation }),
    });
  }, conversationWithoutUsage);
  await expect(contextWindow).toBeVisible();
  await expect(contextWindow).toContainText('0 / 190K');
  await expect(contextWindow.locator('progress')).toBeVisible();
  const conversationWithoutModelControl = rootConversation();
  delete conversationWithoutModelControl.controls.model;
  await page.evaluate((nextConversation) => {
    window.__conversationStreams.at(-1).emit('conversation', {
      data: JSON.stringify({ conversation: nextConversation }),
    });
  }, conversationWithoutModelControl);
  await expect(conversation.locator('#mobile-conversation-model')).toBeHidden();
  await expect(contextWindow).toBeVisible();
  await expect(contextWindow).toContainText('6K / 190K');
  await expect(contextWindow.locator('progress')).toBeVisible();
  await page.evaluate((nextConversation) => {
    window.__conversationStreams.at(-1).emit('conversation', {
      data: JSON.stringify({ conversation: nextConversation }),
    });
  }, rootConversation());
  const input = conversation.locator('#mobile-conversation-input');
  await input.click();
  await expect(conversation.locator('#mobile-conversation-composer')).toHaveAttribute('data-expanded', 'true');
  await expect(conversation.locator('#mobile-conversation-model')).toBeVisible();
  await expect.poll(() => conversation.evaluate((node) => {
    const composer = node.querySelector('#mobile-conversation-composer').getBoundingClientRect();
    const progress = node.querySelector('#mobile-conversation-context-progress').getBoundingClientRect();
    const value = node.querySelector('#mobile-conversation-context-value').getBoundingClientRect();
    const send = node.querySelector('#mobile-conversation-send').getBoundingClientRect();
    const borderWidth = Number.parseFloat(getComputedStyle(node.querySelector('#mobile-conversation-composer')).borderBottomWidth);
    return {
      progressOnBottomBorder: Math.abs(progress.bottom - composer.bottom) <= 2,
      progressMatchesBorderThickness: Math.abs(progress.height - borderWidth) < 0.1,
      valueSeparatedFromSend: send.left - value.right >= 12,
    };
  })).toEqual({
    progressOnBottomBorder: true,
    progressMatchesBorderThickness: true,
    valueSeparatedFromSend: true,
  });
  const modelButton = conversation.locator('#mobile-conversation-model');
  const modeButton = conversation.locator('#mobile-conversation-mode');
  await expect(modelButton).toContainText('Qwen 3.8 27B');
  const normalModeWidth = (await modeButton.boundingBox()).width;
  await expect.poll(() => modelButton.evaluate((button) => ({
    flexGrow: getComputedStyle(button).flexGrow,
    maxWidth: getComputedStyle(button).maxWidth,
    labelFits: button.querySelector('span').scrollWidth <= button.querySelector('span').clientWidth,
    borderLeft: getComputedStyle(button).borderLeftWidth,
    arrowUsesStrongText: getComputedStyle(button.querySelector('i')).color === (() => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--color-text-strong)';
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    })(),
    arrowAligned: Math.abs(
      (button.querySelector('span').getBoundingClientRect().top +
        button.querySelector('span').getBoundingClientRect().bottom) / 2 -
      (button.querySelector('i').getBoundingClientRect().top +
        button.querySelector('i').getBoundingClientRect().bottom) / 2,
    ) <= 1,
  }))).toEqual({
    flexGrow: '0', maxWidth: '100%', labelFits: true, borderLeft: '0px', arrowUsesStrongText: true,
    arrowAligned: true,
  });
  await modelButton.click();
  await expect(input).toBeFocused();
  const modelList = conversation.locator('#mobile-conversation-model-list');
  await expect(modelList).toBeVisible();
  await expect(modelList.getByRole('group', { name: 'Local' })).toContainText('Qwen 3.8 27B');
  await expect(modelList.getByRole('group', { name: 'xAI' })).toContainText('Grok 4.6');
  await expect(modelList.getByRole('option')).toHaveCount(2);
  await modelList.getByRole('option', { name: /Grok 4\.6/ }).click();
  await expect(input).toBeFocused();
  await expect(modelList).toContainText('Choose effort');
  await expect(modelList.getByRole('option')).toHaveCount(2);
  await modelList.getByRole('option', { name: /Low Effort/ }).click();
  await expect(modelButton).toContainText('Switching…');
  await expect(modelButton).toHaveAttribute('aria-busy', 'true');
  await expect(modeButton).toBeDisabled();
  const switchingSend = conversation.locator('#mobile-conversation-send');
  await expect(switchingSend).toHaveAttribute('data-action', 'send');
  await expect(switchingSend).toHaveText('↑');
  await expect(switchingSend).toHaveAttribute('aria-label', 'Send message');
  await expect(switchingSend).toBeDisabled();
  await expect.poll(() => switchingSend.evaluate((button) =>
    getComputedStyle(button, '::before').content)).toBe('none');
  const inputsBeforeBlockedSubmit = mobileInputs.length;
  await input.fill('must wait for model switching');
  await conversation.locator('#mobile-conversation-composer').evaluate((form) => form.requestSubmit());
  expect(mobileInputs).toHaveLength(inputsBeforeBlockedSubmit);
  await input.fill('');
  await expect(input).toBeFocused();
  await expect.poll(() => modelChanges).toContainEqual({ modelId: 'grok-4.6', effortId: 'low' });
  await expect(modelButton).toContainText('Grok 4.6');
  await input.click();
  await expect.poll(() => modelButton.evaluate((button) => {
    const style = getComputedStyle(button);
    const label = button.querySelector('span').getBoundingClientRect();
    const arrow = button.querySelector('i').getBoundingClientRect();
    const contentWidth = label.width + arrow.width + Number.parseFloat(style.columnGap || style.gap) +
      Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
    return Math.abs(button.getBoundingClientRect().width - contentWidth);
  })).toBeLessThanOrEqual(1);
  await expect(conversation.locator('#mobile-conversation-context')).toContainText('6K / 500K');
  await modeButton.click();
  await expect(input).toBeFocused();
  await conversation.locator('#mobile-conversation-mode-list').getByRole('option', { name: /Plan/ }).click();
  await expect(modeButton).toContainText('Switching…');
  await expect(modeButton).toHaveAttribute('aria-busy', 'true');
  await expect(modelButton).toBeDisabled();
  await expect(switchingSend).toHaveAttribute('data-action', 'send');
  await expect(switchingSend).toHaveText('↑');
  await expect(switchingSend).toHaveAttribute('aria-label', 'Send message');
  await expect(switchingSend).toBeDisabled();
  await expect.poll(() => switchingSend.evaluate((button) =>
    getComputedStyle(button, '::before').content)).toBe('none');
  await expect(input).toBeFocused();
  await expect.poll(() => modeChanges).toContainEqual({ modeId: 'plan' });
  await expect(modeButton).toContainText('Plan');
  await input.click();
  await modeButton.click();
  await expect(input).toBeFocused();
  await conversation.locator('#mobile-conversation-mode-list')
    .getByRole('option', { name: /Always approve/ }).click();
  await expect(input).toBeFocused();
  await expect.poll(() => modeChanges).toContainEqual({ modeId: 'alwaysApprove' });
  await expect(modeButton).toContainText('Always approve');
  await input.click();
  expect((await modeButton.boundingBox()).width).toBeGreaterThan(normalModeWidth);
  await expect.poll(() => modeButton.evaluate((button) => button.querySelector('span').scrollWidth <=
    button.querySelector('span').clientWidth)).toBe(true);
  await expect(conversation.locator('#mobile-conversation-permission-mode')).toHaveCount(0);
  const sendButton = conversation.locator('#mobile-conversation-send');
  const scrollbarStyles = await conversation.locator(
    '#mobile-conversation-messages, #mobile-conversation-input',
  ).evaluateAll((nodes) => nodes.map((node) => ({
    width: getComputedStyle(node).scrollbarWidth,
    color: getComputedStyle(node).scrollbarColor,
    webkitWidth: getComputedStyle(node, '::-webkit-scrollbar').width,
    trackBorder: getComputedStyle(node, '::-webkit-scrollbar-track').borderTopWidth,
    trackBackground: getComputedStyle(node, '::-webkit-scrollbar-track').backgroundColor,
  })));
  expect(scrollbarStyles).toHaveLength(2);
  for (const style of scrollbarStyles) {
    expect(style.width).toBe('thin');
    expect(style.color).not.toContain('auto');
    expect(style.webkitWidth).toBe('6px');
    expect(style.trackBorder).toBe('0px');
    expect(style.trackBackground).toBe('rgba(0, 0, 0, 0)');
  }
  await input.evaluate((element) => element.blur());
  await page.evaluate(() => document.activeElement?.blur());
  await expect(conversation.locator('#mobile-conversation-composer'))
    .toHaveAttribute('data-expanded', 'false');
  await expect.poll(() => conversation.locator('#mobile-conversation-composer').evaluate(
    (node) => node.getBoundingClientRect().height,
  )).toBeLessThanOrEqual(62);
  const collapsedComposer = await conversation.locator('#mobile-conversation-composer').evaluate((composer) => {
    const row = composer.querySelector('.mobile-conversation-compose-row');
    const textarea = composer.querySelector('#mobile-conversation-input');
    const attach = composer.querySelector('#mobile-conversation-attach');
    const send = composer.querySelector('#mobile-conversation-send');
    const mode = composer.querySelector('#mobile-conversation-mode');
    const contextLabel = composer.querySelector('.mobile-conversation-context > span');
    const contextValue = composer.querySelector('#mobile-conversation-context-value');
    const rect = (node) => node.getBoundingClientRect();
    return {
      expanded: composer.dataset.expanded,
      height: rect(composer).height,
      oneRow: attach.parentElement === row && textarea.parentElement === row && send.parentElement === row,
      centerDelta: Math.max(
        Math.abs((rect(attach).top + rect(attach).bottom) / 2 - (rect(textarea).top + rect(textarea).bottom) / 2),
        Math.abs((rect(send).top + rect(send).bottom) / 2 - (rect(textarea).top + rect(textarea).bottom) / 2),
      ),
      modeDisplay: getComputedStyle(mode).display,
      contextLabelDisplay: getComputedStyle(contextLabel).display,
      contextValueDisplay: getComputedStyle(contextValue).display,
      contextValueFontSize: parseFloat(getComputedStyle(contextValue).fontSize),
      contextSendGap: rect(send).left - rect(contextValue).right,
    };
  });
  expect(collapsedComposer.expanded).toBe('false');
  expect(collapsedComposer.height).toBeLessThanOrEqual(62);
  expect(collapsedComposer.oneRow).toBe(true);
  expect(collapsedComposer.centerDelta).toBeLessThanOrEqual(1);
  expect(collapsedComposer.modeDisplay).toBe('none');
  expect(collapsedComposer.contextLabelDisplay).toBe('none');
  expect(collapsedComposer.contextValueDisplay).toBe('block');
  expect(collapsedComposer.contextValueFontSize).toBeLessThanOrEqual(8);
  expect(collapsedComposer.contextSendGap).toBeGreaterThanOrEqual(4);
  expect(collapsedComposer.contextSendGap).toBeLessThanOrEqual(16);
  const attachButton = conversation.locator('#mobile-conversation-attach');
  await attachButton.focus();
  await expect(conversation.locator('#mobile-conversation-composer')).toHaveAttribute('data-expanded', 'false');
  const collapsedFileChooserPromise = page.waitForEvent('filechooser');
  await attachButton.click();
  const collapsedFileChooser = await collapsedFileChooserPromise;
  await expect(conversation.locator('#mobile-conversation-composer')).toHaveAttribute('data-expanded', 'false');
  await expect.poll(() => input.evaluate((node) => document.activeElement === node)).toBe(false);
  await collapsedFileChooser.setFiles([]);
  await expect(conversation.locator('#mobile-conversation-composer')).toHaveAttribute('data-expanded', 'false');
  await expect.poll(() => input.evaluate((node) => document.activeElement === node)).toBe(false);
  await page.evaluate(() => { window.__mobileComposerFocusOptions.length = 0; });
  await messages.evaluate((node) => { node.scrollTop = node.scrollHeight; });
  await expect.poll(() => messages.evaluate((node) =>
    node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThanOrEqual(1);
  await page.evaluate(() => {
    window.__mainScrollStabilitySamples = [];
    const messages = document.querySelector('#mobile-conversation-messages');
    const startedAt = performance.now();
    const sample = () => {
      window.__mainScrollStabilitySamples.push(
        Math.max(0, messages.scrollHeight - messages.scrollTop - messages.clientHeight),
      );
      if (performance.now() - startedAt < 420) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await input.click();
  await expect(conversation.locator('#mobile-conversation-composer')).toHaveAttribute('data-expanded', 'true');
  await expect(modeButton).toBeVisible();
  await expect.poll(() => conversation.locator('#mobile-conversation-composer').evaluate(
    (node) => node.getBoundingClientRect().height,
  )).toBeGreaterThan(collapsedComposer.height + 20);
  await page.waitForTimeout(440);
  expect(await page.evaluate(() => Math.max(...window.__mainScrollStabilitySamples))).toBeLessThanOrEqual(1);
  await page.evaluate(() => {
    window.__mainScrollStabilitySamples = [];
    const messages = document.querySelector('#mobile-conversation-messages');
    const startedAt = performance.now();
    const sample = () => {
      window.__mainScrollStabilitySamples.push(
        Math.max(0, messages.scrollHeight - messages.scrollTop - messages.clientHeight),
      );
      if (performance.now() - startedAt < 420) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await input.evaluate((node) => node.blur());
  await expect(conversation.locator('#mobile-conversation-composer')).toHaveAttribute('data-expanded', 'false');
  await page.waitForTimeout(440);
  expect(await page.evaluate(() => Math.max(...window.__mainScrollStabilitySamples))).toBeLessThanOrEqual(1);
  await input.click();
  await expect(conversation.locator('#mobile-conversation-composer')).toHaveAttribute('data-expanded', 'true');
  await expect.poll(() => page.evaluate(() => window.__mobileComposerFocusOptions))
    .not.toContainEqual({ preventScroll: true });
  await expect.poll(() => conversation.evaluate((node) => ({
    position: getComputedStyle(node).position,
    documentScrollTop: document.scrollingElement.scrollTop,
  }))).toEqual({ position: 'fixed', documentScrollTop: 0 });
  const stableConversationSurface = await conversation.boundingBox();
  expect(stableConversationSurface).toMatchObject({ x: 0, y: 0, width: 390, height: 844 });
  await page.evaluate(() => window.__setVisualViewport({ height: 700, offsetTop: 12 }));
  await expect.poll(() => conversation.evaluate((node) => {
    const bounds = node.getBoundingClientRect();
    const composer = node.querySelector('#mobile-conversation-composer').getBoundingClientRect();
    const composerGap = Math.round(12 + 700 - composer.bottom);
    return {
      root: [Math.round(bounds.left), Math.round(bounds.top), Math.round(bounds.width), Math.round(bounds.height)],
      composerAligned: composerGap >= 0 && composerGap <= 12,
    };
  })).toEqual({ root: [0, 12, 390, 700], composerAligned: true });
  await page.evaluate(() => window.__setVisualViewport({ height: 510, offsetTop: 24 }));
  await expect(page.locator('html')).toHaveAttribute('data-visual-keyboard', 'true');
  await expect.poll(() => conversation.evaluate((node) => {
    const bounds = node.getBoundingClientRect();
    const root = document.documentElement;
    return {
      top: Math.round(bounds.top),
      height: Math.round(bounds.height),
      layoutInset: root.style.getPropertyValue('--visual-viewport-layout-inset-bottom'),
      contentInset: root.style.getPropertyValue('--visual-viewport-inset-bottom'),
      bodyPosition: getComputedStyle(document.body).position,
    };
  })).toEqual({
    top: 24,
    height: 510,
    layoutInset: '0px',
    contentInset: '0px',
    bodyPosition: 'fixed',
  });
  await expect.poll(() => conversation.evaluate((node) => {
    const canvas = getComputedStyle(document.documentElement).getPropertyValue('--color-canvas').trim();
    const workspace = node.closest('.workspace');
    const terminalShell = workspace.querySelector('.terminal-shell');
    const terminalStage = workspace.querySelector('.terminal-stage');
    return {
      canvas,
      conversation: getComputedStyle(node).backgroundColor,
      composer: getComputedStyle(node.querySelector('#mobile-conversation-composer')).backgroundColor,
      workspace: getComputedStyle(workspace).backgroundColor,
      terminalShell: getComputedStyle(terminalShell).backgroundColor,
      terminalStage: getComputedStyle(terminalStage).backgroundColor,
    };
  })).toEqual({
    canvas: '#0c0c0d',
    conversation: 'rgb(12, 12, 13)',
    composer: 'rgb(12, 12, 13)',
    workspace: 'rgb(12, 12, 13)',
    terminalShell: 'rgb(12, 12, 13)',
    terminalStage: 'rgb(12, 12, 13)',
  });
  await expect.poll(() => page.evaluate(() => {
    const root = document.querySelector('#mobile-conversation').getBoundingClientRect();
    const composer = document.querySelector('#mobile-conversation-composer').getBoundingClientRect();
    const messages = document.querySelector('#mobile-conversation-messages').getBoundingClientRect();
    return {
      rootTop: Math.round(root.top),
      rootHeight: Math.round(root.height),
      composerBottom: Math.round(composer.bottom),
      composerTop: Math.round(composer.top),
      messagesHeight: Math.round(messages.height),
    };
  })).toEqual({
    rootTop: 24,
    rootHeight: 510,
    composerBottom: expect.any(Number),
    composerTop: expect.any(Number),
    messagesHeight: expect.any(Number),
  });
  const keyboardLayout = await page.evaluate(() => {
    const root = document.querySelector('#mobile-conversation').getBoundingClientRect();
    const composer = document.querySelector('#mobile-conversation-composer').getBoundingClientRect();
    const messages = document.querySelector('#mobile-conversation-messages').getBoundingClientRect();
    return {
      composerTop: composer.top, composerBottom: composer.bottom,
      messagesHeight: messages.height, rootTop: root.top, rootBottom: root.bottom,
      visualBottom: window.visualViewport.offsetTop + window.visualViewport.height,
    };
  });
  expect(keyboardLayout.visualBottom - keyboardLayout.composerBottom).toBeGreaterThanOrEqual(0);
  expect(keyboardLayout.visualBottom - keyboardLayout.composerBottom).toBeLessThanOrEqual(12);
  expect(keyboardLayout.composerTop).toBeGreaterThan(keyboardLayout.rootTop + 160);
  expect(keyboardLayout.messagesHeight).toBeGreaterThan(120);
  await expect.poll(() => messages.evaluate((node) => ({
    overflow: node.scrollHeight - node.clientHeight,
    documentScrollTop: document.scrollingElement.scrollTop,
  }))).toEqual({ overflow: expect.any(Number), documentScrollTop: 0 });
  await messages.evaluate((node) => { node.scrollTop = node.scrollHeight; });
  await input.evaluate((element) => element.blur());
  await expect(conversation.locator('#mobile-conversation-composer'))
    .toHaveAttribute('data-expanded', 'false');
  // Until Safari reports a larger visual viewport, keep the application box
  // and composer attached to the actual keyboard edge without creating a
  // hidden layout-viewport scroll range below it.
  await expect.poll(() => page.evaluate(() => ({
    inset: getComputedStyle(document.documentElement)
      .getPropertyValue('--visual-viewport-inset-bottom').trim(),
    composerAligned: (() => {
      const bottom = document.querySelector('#mobile-conversation-composer').getBoundingClientRect().bottom;
      const gap = window.visualViewport.offsetTop + window.visualViewport.height - bottom;
      return gap >= 0 && gap <= 16;
    })(),
  }))).toEqual({ inset: '0px', composerAligned: true });
  await page.evaluate(() => window.__setVisualViewport({ height: 844, offsetTop: 0 }));
  await expect(page.locator('html')).toHaveAttribute('data-visual-keyboard', 'false');
  await expect(conversation.locator('#mobile-conversation-composer'))
    .toHaveAttribute('data-expanded', 'false');
  await expect.poll(() => conversation.locator('#mobile-conversation-composer').evaluate(
    (node) => node.getBoundingClientRect().height,
  )).toBeLessThanOrEqual(62);
  await expect.poll(() => messages.evaluate((node) =>
    node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThanOrEqual(1);
  // Installed iOS web apps can shrink innerHeight together with visualViewport,
  // so inset-based keyboard detection remains false for the whole interaction.
  // The composer lifecycle must still preserve the chat's bottom anchor.
  await input.click();
  await page.evaluate(() => window.__setStandaloneViewport({ height: 510, offsetTop: 0 }));
  await expect(page.locator('html')).toHaveAttribute('data-visual-keyboard', 'false');
  await messages.evaluate((node) => { node.scrollTop = node.scrollHeight; });
  await input.evaluate((element) => element.blur());
  await page.evaluate(() => window.__setStandaloneViewport({ height: 844, offsetTop: 0 }));
  await expect(page.locator('html')).toHaveAttribute('data-visual-keyboard', 'false');
  await expect.poll(() => messages.evaluate((node) =>
    node.scrollHeight - node.scrollTop - node.clientHeight), { timeout: 1_500 }).toBeLessThanOrEqual(1);
  await conversation.locator('#mobile-conversation-composer').evaluate((node) => Promise.all(
    node.getAnimations({ subtree: true }).map((animation) => animation.finished),
  ));
  const idleComposerHeight = await conversation.locator('#mobile-conversation-composer').evaluate(
    (node) => node.getBoundingClientRect().height,
  );
  await expect(conversation.locator('#mobile-conversation-activity')).toHaveCount(0);
  currentActivity = {
    active: true, phase: 'waiting', label: 'Waiting for response…',
    canCancel: true, cancelRequested: false,
  };
  await page.evaluate((nextConversation) => {
    window.__conversationStreams.at(-1).emit('conversation', {
      data: JSON.stringify({ conversation: nextConversation }),
    });
  }, rootConversation());
  await expect.poll(() => conversation.locator('#mobile-conversation-composer').evaluate(
    (node) => node.getBoundingClientRect().height,
  )).toBe(idleComposerHeight);
  await expect(sendButton).toHaveAttribute('data-action', 'stop');
  await expect(sendButton).toHaveAttribute('aria-label', 'Stop response');
  await expect(sendButton).toHaveText('');
  await expect.poll(() => sendButton.evaluate(
    (node) => getComputedStyle(node, '::before').animationName,
  )).toBe('mobile-activity-spin');
  await expect(sidebarSession).toHaveClass(/working/);
  await expect(modelButton).toBeEnabled();
  await expect(conversation.locator('#mobile-conversation-mode')).toBeEnabled();
  await input.click();
  await expect(conversation.locator('#mobile-conversation-composer')).toHaveAttribute('data-expanded', 'true');
  await modelButton.click();
  await modelList.getByRole('option', { name: /Qwen 3\.8 27B/ }).click();
  await expect.poll(() => modelChanges).toContainEqual({ modelId: 'qwen-local' });
  await expect(modelButton).toContainText('Qwen 3.8 27B');
  await input.click();
  await conversation.locator('#mobile-conversation-mode').click();
  await conversation.locator('#mobile-conversation-mode-list').getByRole('option', { name: /Auto/ }).click();
  await expect.poll(() => modeChanges).toContainEqual({ modeId: 'auto' });
  await expect(conversation.locator('#mobile-conversation-mode')).toContainText('Auto');
  await input.click();
  const focusedFileChooserPromise = page.waitForEvent('filechooser');
  await attachButton.click();
  const focusedFileChooser = await focusedFileChooserPromise;
  await expect(conversation.locator('#mobile-conversation-composer')).toHaveAttribute('data-expanded', 'true');
  await expect.poll(() => input.evaluate((node) => document.activeElement === node)).toBe(true);
  await focusedFileChooser.setFiles({
    name: 'streaming.png', mimeType: 'image/png', buffer: Buffer.from('streaming-image'),
  });
  await expect(conversation.locator('#mobile-conversation-composer')).toHaveAttribute('data-expanded', 'true');
  await expect(conversation.locator('.mobile-conversation-uploading[data-state="uploading"]')).toBeVisible();
  await expect.poll(() => conversation.locator('#mobile-conversation-input').evaluate(
    (node) => document.activeElement === node,
  )).toBe(true);
  await expect.poll(() => typeof releaseStreamingUpload).toBe('function');
  releaseStreamingUpload();
  await expect.poll(() => uploads).toContainEqual({
    name: encodeURIComponent('streaming.png'), bytes: 'streaming-image',
  });
  await expect(conversation.getByRole('button', { name: 'Remove phone.png' })).toBeVisible();
  await conversation.getByRole('button', { name: 'Remove phone.png' }).click();

  currentActivity = {
    active: true, phase: 'tool', label: 'Preparing read_file…',
    canCancel: true, cancelRequested: false, turnId: 100,
  };
  await page.evaluate((nextConversation) => {
    window.__conversationStreams.at(-1).emit('conversation', {
      data: JSON.stringify({ conversation: nextConversation }),
    });
  }, rootConversation());
  await expect(sendButton).toHaveAttribute('data-action', 'stop');
  const activeSendIndicator = await sendButton.evaluate((node) => {
    const button = getComputedStyle(node);
    const ring = getComputedStyle(node, '::before');
    const stop = getComputedStyle(node, '::after');
    return {
      ringAnimation: ring.animationName,
      ringAroundButton: Math.abs(Number.parseFloat(ring.width) - Number.parseFloat(button.width)) < 0.1 &&
        Math.abs(Number.parseFloat(ring.height) - Number.parseFloat(button.height)) < 0.1,
      stopContent: stop.content,
      stopWidth: stop.width,
      stopHeight: stop.height,
      stopRadius: stop.borderRadius,
    };
  });
  await expect.poll(() => sendButton.evaluate((node) => {
    const dangerProbe = document.createElement('span');
    dangerProbe.style.color = 'var(--color-button-danger-text)';
    document.body.append(dangerProbe);
    const dangerColor = getComputedStyle(dangerProbe).color;
    dangerProbe.remove();
    return getComputedStyle(node).color === dangerColor &&
      getComputedStyle(node, '::before').borderTopColor === dangerColor;
  })).toBe(true);
  expect(activeSendIndicator).toEqual({
    ringAnimation: 'mobile-activity-spin',
    ringAroundButton: true,
    stopContent: '""',
    stopWidth: '10px',
    stopHeight: '10px',
    stopRadius: '2px',
  });
  await input.fill('queue this while Grok works');
  await expect(sendButton).toHaveAttribute('data-action', 'send');
  await expect(sendButton).toHaveAttribute('aria-label', 'Send message');
  await input.fill('');
  await expect(sendButton).toHaveAttribute('data-action', 'stop');
  holdNextCancellation = true;
  await sendButton.click();
  await expect.poll(() => cancellations).toEqual([{}]);
  await expect(sendButton).toHaveAttribute('data-action', 'stopping');
  await expect(sendButton).toHaveAttribute('aria-label', 'Stopping response');
  await expect.poll(() => sendButton.evaluate(
    (node) => getComputedStyle(node, '::after').animationName,
  )).toBe('mobile-stop-pulse');
  await expect.poll(() => sendButton.evaluate((node) => ({
    ringWidth: getComputedStyle(node, '::before').width,
    ringHeight: getComputedStyle(node, '::before').height,
    stopWidth: getComputedStyle(node, '::after').width,
    stopHeight: getComputedStyle(node, '::after').height,
  }))).toEqual({ ringWidth: '40px', ringHeight: '40px', stopWidth: '10px', stopHeight: '10px' });
  await expect(sendButton).toBeDisabled();

  releaseCancellation();
  await expect(sendButton).toHaveAttribute('data-action', 'send');
  currentActivity = { active: false };
  rootItems.push({
    id: 'turn-cancelled-100', type: 'turn', title: 'Turn cancelled by user',
    status: 'cancelled', stopReason: 'cancelled', durationMs: 13_000,
  });
  await page.evaluate((nextConversation) => {
    window.__conversationStreams.at(-1).emit('conversation', {
      data: JSON.stringify({ conversation: nextConversation, stream: { kind: 'turn_completed' } }),
    });
  }, rootConversation());
  const cancelledTurn = conversation.locator('.mobile-turn-cancelled');
  await expect(cancelledTurn).toHaveText('Turn cancelled by user in 13s.');
  await expect(cancelledTurn.locator('.mobile-event-toggle')).toHaveCount(0);
  await input.fill('message after accepted stop');
  await expect(sendButton).toBeEnabled();
  await sendButton.click();
  await expect.poll(() => typeof releaseAfterStopInput).toBe('function');
  await expect(sendButton).toHaveAttribute('data-action', 'sending');

  queuedInputs.splice(queuedInputs.findIndex((entry) => entry.text === 'message after accepted stop'), 1);
  rootItems.push({
    id: 'user-after-stop', type: 'message', role: 'user', text: 'message after accepted stop',
  }, {
    id: 'assistant-after-stop', type: 'message', role: 'assistant', text: 'Second turn is streaming.',
  });
  currentActivity = {
    active: true, phase: 'writing', label: 'Writing response…',
    canCancel: true, cancelRequested: false, turnId: 200,
  };
  await page.evaluate((nextConversation) => {
    window.__conversationStreams.at(-1).emit('conversation', {
      data: JSON.stringify({ conversation: nextConversation }),
    });
  }, rootConversation());
  await expect(sendButton).toHaveAttribute('data-action', 'stop');
  await expect(sendButton).toHaveAttribute('aria-label', 'Stop response');
  await expect(sendButton).toBeEnabled();
  await sendButton.click();
  await expect.poll(() => cancellations).toHaveLength(2);
  await expect(sendButton).toHaveAttribute('data-action', 'send');

  currentActivity = {
    active: true, phase: 'stopping', label: 'Stopping…',
    canCancel: true, cancelRequested: true, turnId: 200,
  };
  await page.evaluate((nextConversation) => {
    window.__conversationStreams.at(-1).emit('conversation', {
      data: JSON.stringify({ conversation: nextConversation }),
    });
  }, rootConversation());
  await expect(sendButton).toHaveAttribute('data-action', 'send');

  currentActivity = { active: false };
  await page.evaluate((nextConversation) => {
    window.__conversationStreams.at(-1).emit('conversation', {
      data: JSON.stringify({ conversation: nextConversation }),
    });
  }, rootConversation());
  await expect(sendButton).toHaveAttribute('data-action', 'send');
  await expect(sendButton).toBeDisabled();
  await expect(sendButton).toHaveText('↑');
  releaseAfterStopInput();
  await expect.poll(() => sendButton.evaluate((node) => ({
    ringContent: getComputedStyle(node, '::before').content,
    stopContent: getComputedStyle(node, '::after').content,
  }))).toEqual({ ringContent: 'none', stopContent: 'none' });
  await expect(sidebarSession).not.toHaveClass(/working/);

  await input.fill('/goal');
  const suggestions = conversation.locator('#mobile-conversation-suggestions');
  await expect(suggestions).toBeVisible();
  await expect(suggestions.getByRole('option')).toHaveCount(1);
  await expect(suggestions.getByRole('option', { name: /^\/goal/ })).toHaveAttribute('aria-selected', 'true');
  await input.fill('/co');
  await expect(suggestions).toBeVisible();
  await expect(suggestions.getByRole('option', { name: /compact/ })).toBeVisible();
  await suggestions.getByRole('option', { name: /compact/ }).click();
  await expect(input).toHaveValue('/compact ');
  await input.fill('Review @mob');
  await expect(suggestions.getByRole('option', { name: /mobile-conversation\.js/ })).toBeVisible();
  await suggestions.getByRole('option', { name: /mobile-conversation\.js/ }).click();
  await expect(input).toHaveValue('Review @public/mobile-conversation.js ');
  await conversation.locator('#mobile-conversation-messages').evaluate((node) => { node.scrollTop = 0; });
  await conversation.locator('#mobile-conversation-send').click();
  await expect.poll(() => conversation.locator('#mobile-conversation-messages').evaluate(
    (node) => Math.max(0, node.scrollHeight - node.scrollTop - node.clientHeight),
  )).toBeLessThanOrEqual(48);
  await expect.poll(() => mobileInputs).toContainEqual(expect.objectContaining({
    text: 'Review @public/mobile-conversation.js', fileMentions: ['public/mobile-conversation.js'],
  }));
  // A 202 delivery receipt is not a turn lifecycle. If the replay does not
  // echo the exact user text, mobile must still keep Send/Ready instead of
  // inventing an endless Responding + Stop state from its optimistic message.
  await expect(sendButton).toHaveAttribute('data-action', 'send');
  const thoughtCard = conversation.locator('.mobile-event-thought').first();
  await expect(thoughtCard.getByRole('button')).toContainText('Thinking…');
  await expect(thoughtCard.locator('.mobile-thinking-indicator')).toHaveCount(1);
  await thoughtCard.getByRole('button').click();
  await expect(thoughtCard.getByText('I should inspect the provider.')).toBeVisible();
  rootItems[rootItems.findIndex((item) => item.id === 'thought-1')] = {
    id: 'thought-1', type: 'thought', title: 'Thought',
    text: 'I should inspect the provider. The streamed reasoning is now visible.', status: 'working',
  };
  await page.evaluate((nextConversation) => {
    window.__conversationStreams.at(-1).emit('conversation', {
      data: JSON.stringify({ conversation: nextConversation }),
    });
  }, rootConversation());
  await expect(thoughtCard.getByText('The streamed reasoning is now visible.')).toBeVisible();
  rootItems[rootItems.findIndex((item) => item.id === 'thought-1')].status = 'completed';
  await page.evaluate((nextConversation) => {
    window.__conversationStreams.at(-1).emit('conversation', {
      data: JSON.stringify({ conversation: nextConversation }),
    });
  }, rootConversation());
  await expect(thoughtCard.getByRole('button')).toContainText('Thought');
  await expect(thoughtCard.locator('.mobile-thinking-indicator')).toHaveCount(0);
  rootItems[rootItems.findIndex((item) => item.id === 'thought-1')].text += ' Interaction remains available.';
  const interactionDuringStream = await page.evaluate((nextConversation) => {
    const button = document.querySelector('.mobile-event-thought .mobile-event-toggle');
    button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
    window.__conversationStreams.at(-1).emit('conversation', {
      data: JSON.stringify({ conversation: nextConversation }),
    });
    const connected = button.isConnected;
    button.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch' }));
    button.click();
    return { connected, expanded: button.getAttribute('aria-expanded') };
  }, rootConversation());
  expect(interactionDuringStream).toEqual({ connected: true, expanded: 'false' });
  await expect(thoughtCard.locator('.mobile-event-panel')).toBeHidden();
  await thoughtCard.getByRole('button').click();
  await expect(thoughtCard.getByText('Interaction remains available.')).toBeVisible();
  await expect(conversation.locator('.mobile-tool-group')).toContainText('Listed 1 dir, Read 2 files, Searched 1 time, Edited 1 file, Ran 1 command');
  await expect(conversation.locator('[data-event-id="tool-group-1"] > .mobile-tool-group-toggle')).toHaveAttribute('aria-expanded', 'true');
  await expect(conversation.locator('[data-event-id="tool-edit-app"] > .mobile-event-toggle')).toHaveAttribute('aria-expanded', 'true');
  await expect(conversation.locator('[data-event-id="tool-edit-app"] > .mobile-event-panel')).toBeVisible();
  await expect(conversation.locator('[data-event-id="tool-group-1"] > .mobile-tool-group-toggle > i')).toHaveText('');
  await expect.poll(() => conversation.locator('[data-event-id="tool-shell"] > .mobile-event-toggle')
    .evaluate((toggle) => {
      const icon = getComputedStyle(toggle, '::before');
      return {
        content: icon.content,
        size: [icon.width, icon.height],
        border: icon.borderTopStyle,
        radius: icon.borderRadius,
      };
    })).toEqual({ content: '">_"', size: ['16px', '14px'], border: 'solid', radius: '3px' });
  await expect.poll(() => conversation.locator('[data-event-id="tool-shell"] > .mobile-event-toggle')
    .evaluate((toggle) => {
      const row = toggle.getBoundingClientRect();
      const copy = toggle.querySelector(':scope > span:first-child').getBoundingClientRect();
      const title = toggle.querySelector('.mobile-event-heading > strong');
      const status = toggle.querySelector('.mobile-event-status').getBoundingClientRect();
      return {
        pastOldLimit: copy.width / row.width > 0.45,
        statusGap: Math.round(status.left - copy.right),
        trimmed: title.scrollWidth > title.clientWidth,
      };
    })).toEqual({ pastOldLimit: true, statusGap: 12, trimmed: false });
  await expect.poll(() => conversation.evaluate((node) => {
    const selectors = [
      '[data-event-id="tool-shell"] .mobile-tool-command',
      '[data-event-id="tool-edit-app"] .mobile-event-change-line',
      '[data-event-id="tool-edit-app"] .mobile-event-change > header strong',
      '[data-event-id="tool-read-agents"] .mobile-file-line',
      '[data-event-id="tool-read-agents"] .mobile-event-file > header strong',
      '[data-event-id="tool-search-app"] .mobile-event-matches button code',
      '[data-event-id="tool-search-app"] .mobile-event-matches button strong',
    ];
    const detailSizes = selectors.map((selector) => Number.parseFloat(getComputedStyle(node.querySelector(selector)).fontSize));
    const chatSize = Number.parseFloat(getComputedStyle(node.querySelector('.mobile-message-content')).fontSize);
    return {
      detailSizeCount: new Set(detailSizes).size,
      ratio: Number((detailSizes[0] / chatSize).toFixed(2)),
    };
  })).toEqual({ detailSizeCount: 1, ratio: 0.72 });
  await expect.poll(() => conversation.locator('[data-event-id="tool-read-agents"]').evaluate((tool) => {
    const codeLines = [...tool.querySelectorAll('.mobile-file-line > code')];
    const syntaxNodes = codeLines.flatMap((code) => [code, ...code.querySelectorAll('*')]);
    return {
      languages: [...new Set(codeLines.map((code) => code.dataset.language))],
      fontSizes: [...new Set(syntaxNodes.map((node) => getComputedStyle(node).fontSize))],
      lineHeights: [...new Set(syntaxNodes.map((node) => getComputedStyle(node).lineHeight))],
      fontStyles: [...new Set(syntaxNodes.map((node) => getComputedStyle(node).fontStyle))],
      fontWeights: [...new Set(syntaxNodes.map((node) => getComputedStyle(node).fontWeight))],
      textSizeAdjust: getComputedStyle(document.documentElement).getPropertyValue('-webkit-text-size-adjust'),
    };
  })).toEqual({
    languages: ['markdown'],
    fontSizes: ['11.232px'],
    lineHeights: ['16.848px'],
    fontStyles: ['normal'],
    fontWeights: ['400'],
    textSizeAdjust: '100%',
  });
  await expect.poll(() => conversation.locator('[data-event-id="tool-group-1"]').evaluate((node) => ({
    groupBorder: getComputedStyle(node).borderTopStyle,
    groupBackground: getComputedStyle(node).backgroundColor,
    arrow: getComputedStyle(node.querySelector(':scope > .mobile-tool-group-toggle'), '::after').content,
    arrowFontSize: getComputedStyle(node.querySelector(':scope > .mobile-tool-group-toggle'), '::after').fontSize,
    iconTextGap: Math.round(
      node.querySelector(':scope > .mobile-tool-group-toggle strong').getBoundingClientRect().left -
      node.querySelector(':scope > .mobile-tool-group-toggle > i').getBoundingClientRect().right,
    ),
    mutedHeading: getComputedStyle(node.querySelector(':scope > .mobile-tool-group-toggle strong')).color === (() => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--color-text-muted)';
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    })(),
  }))).toEqual({
    groupBorder: 'none', groupBackground: 'rgba(0, 0, 0, 0)',
    arrow: '"›"', arrowFontSize: '17px', iconTextGap: 7, mutedHeading: true,
  });
  const streamedToolGroup = rootItems.find((item) => item.id === 'tool-group-1');
  await conversation.locator('[data-event-id="tool-group-1"] > .mobile-tool-group-toggle').click();
  await expect(conversation.locator('[data-event-id="tool-group-1"] > .mobile-tool-group-toggle')).toHaveAttribute('aria-expanded', 'false');
  streamedToolGroup.status = 'working';
  streamedToolGroup.tools.find((tool) => tool.id === 'tool-shell').status = 'working';
  await page.evaluate((nextConversation) => {
    window.__conversationStreams.at(-1).emit('conversation', {
      data: JSON.stringify({ conversation: nextConversation }),
    });
  }, rootConversation());
  await expect.poll(() => conversation.locator('[data-event-id="tool-group-1"]').evaluate((group) => {
    const groupToggle = group.querySelector(':scope > .mobile-tool-group-toggle');
    const groupTitle = groupToggle.querySelector('strong').getBoundingClientRect();
    const groupStatus = group.querySelector(':scope > .mobile-tool-group-toggle small');
    const groupStatusBox = groupStatus.getBoundingClientRect();
    const toolToggle = group.querySelector('[data-event-id="tool-shell"] .mobile-event-toggle');
    const toolCopy = toolToggle.querySelector(':scope > span:first-child').getBoundingClientRect();
    const toolStatus = group.querySelector('[data-event-id="tool-shell"] .mobile-event-status');
    const toolStatusBox = toolStatus.getBoundingClientRect();
    return {
      groupText: groupStatus.textContent,
      groupAnimation: getComputedStyle(groupStatus).animationName,
      groupPastOldLimit: groupTitle.width / groupToggle.getBoundingClientRect().width > 0.45,
      groupStatusGap: Math.round(groupStatusBox.left - groupTitle.right),
      toolText: toolStatus.textContent,
      toolAnimation: getComputedStyle(toolStatus, '::before').animationName,
      toolStatusGap: Math.round(toolStatusBox.left - toolCopy.right),
    };
  })).toEqual({
    groupText: 'Running', groupAnimation: 'mobile-activity-spin', groupPastOldLimit: true, groupStatusGap: 12,
    toolText: 'Running', toolAnimation: 'mobile-activity-spin', toolStatusGap: 12,
  });
  await expect(conversation.locator('[data-event-id="tool-group-1"] > .mobile-tool-group-toggle')).toHaveAttribute('aria-expanded', 'false');
  const stableToolGroup = await page.evaluate(async (nextConversation) => {
    const button = document.querySelector('[data-event-id="tool-group-1"] > .mobile-tool-group-toggle');
    const detail = document.querySelector('[data-event-id="tool-group-1"] .mobile-event-card .mobile-event-panel > *');
    button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
    for (let index = 0; index < 24; index += 1) {
      const snapshot = structuredClone(nextConversation);
      const group = snapshot.items.find((item) => item.id === 'tool-group-1');
      group.status = index === 23 ? 'completed' : 'working';
      group.tools.find((tool) => tool.id === 'tool-shell').status = index === 23 ? 'completed' : 'working';
      window.__conversationStreams.at(-1).emit('conversation', {
        data: JSON.stringify({ conversation: snapshot }),
      });
    }
    button.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch' }));
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 50));
    return {
      connected: button.isConnected,
      sameNode: button === document.querySelector('[data-event-id="tool-group-1"] > .mobile-tool-group-toggle'),
      stableDetail: detail === document.querySelector('[data-event-id="tool-group-1"] .mobile-event-card .mobile-event-panel > *'),
      expanded: button.getAttribute('aria-expanded'),
    };
  }, rootConversation());
  expect(stableToolGroup).toEqual({ connected: true, sameNode: true, stableDetail: true, expanded: 'true' });
  streamedToolGroup.status = 'completed';
  streamedToolGroup.tools.find((tool) => tool.id === 'tool-shell').status = 'completed';
  await expect(conversation.locator('[data-event-id="tool-shell"] .mobile-event-status')).toHaveText('Done');
  await expect(conversation.locator('[data-event-id="tool-shell"] .mobile-event-status')).toBeVisible();
  await expect.poll(() => conversation.locator('[data-event-id="tool-read-agents"] > .mobile-event-toggle').evaluate((toggle) => {
    const icon = getComputedStyle(toggle, '::before');
    const status = toggle.querySelector('.mobile-event-status').getBoundingClientRect();
    const arrow = toggle.querySelector(':scope > i').getBoundingClientRect();
    return {
      iconWidth: icon.width,
      iconHeight: icon.height,
      iconPlaceSelf: icon.placeSelf,
      statusHeight: Math.round(status.height),
      arrowHeight: Math.round(arrow.height),
      trailingCenterDelta: Math.abs((status.top + status.height / 2) - (arrow.top + arrow.height / 2)),
    };
  })).toEqual({
    iconWidth: '7px',
    iconHeight: '7px',
    iconPlaceSelf: 'center',
    statusHeight: 20,
    arrowHeight: 20,
    trailingCenterDelta: 0,
  });
  await conversation.getByRole('button', { name: /Listed 1 dir, Read 2 files/ }).click();
  await expect(conversation.getByText('Turn completed')).toHaveCount(0);
  const recap = conversation.locator('[data-event-id="recap-1"]');
  await expect(recap.getByRole('button', { name: /Recap/ })).toHaveAttribute('aria-expanded', 'true');
  await expect(recap.getByText('Work completed so far, with the remaining verification still pending.')).toBeVisible();
  await expect.poll(() => recap.evaluate((node) => ({
    opacity: Number(getComputedStyle(node).opacity),
    background: getComputedStyle(node).backgroundColor,
  }))).toEqual({ opacity: 0.58, background: 'rgba(0, 0, 0, 0)' });
  await recap.getByRole('button', { name: /Recap/ }).click();
  await expect(recap.getByRole('button', { name: /Recap/ })).toHaveAttribute('aria-expanded', 'false');
  await expect(recap.locator('.mobile-event-panel')).toBeHidden();
  await expect(conversation.locator('.mobile-event-plan')).toHaveCount(0);
  const planPill = conversation.locator('.mobile-plan-pill');
  await expect(planPill).toContainText('Plan 1 / 2');
  await planPill.click();
  const activitySheet = conversation.locator('.mobile-subagent-sheet');
  await expect(activitySheet).toBeVisible();
  await expect(activitySheet.locator('.mobile-subagent-sheet-header strong')).toHaveText('Plan');
  await expect(activitySheet.locator('.mobile-subagent-sheet-header small')).toHaveText('1 of 2 tasks complete');
  await expect(activitySheet.getByText('Inspect events')).toBeVisible();
  await expect(activitySheet.getByText('Render cards')).toBeVisible();
  await expect.poll(() => activitySheet.locator('.mobile-subagent-sheet-panel').evaluate((panel) => ({
    height: Math.round(panel.getBoundingClientRect().height),
    scrollHeight: panel.scrollHeight,
  }))).toEqual(expect.objectContaining({ scrollHeight: expect.any(Number) }));
  expect((await activitySheet.locator('.mobile-subagent-sheet-panel').boundingBox()).height).toBeLessThan(360);
  const streamedPlan = rootItems.find((item) => item.id === 'plan-1');
  streamedPlan.entries[1].status = 'completed';
  streamedPlan.status = 'completed';
  await page.evaluate((nextConversation) => {
    window.__conversationStreams.at(-1).emit('conversation', {
      data: JSON.stringify({ conversation: nextConversation }),
    });
  }, rootConversation());
  await expect(planPill).toContainText('Plan 2 / 2');
  await expect(activitySheet.locator('.mobile-subagent-sheet-header small')).toHaveText('2 of 2 tasks complete');
  await expect(activitySheet.locator('.mobile-subagent-sheet-state')).toHaveText('Done');
  await activitySheet.getByRole('button', { name: 'Close activity', exact: true }).click();
  await expect(planPill).toHaveCount(0);
  await expect.poll(() => page.evaluate((name) => (
    localStorage.getItem(`agent-remote:mobile-plan-dismissed:${encodeURIComponent(name)}`)
  ), sessionName)).toBeTruthy();
  streamedPlan.entries.push({ id: 'p3', content: 'Verify update', status: 'working' });
  streamedPlan.status = 'working';
  await page.evaluate((nextConversation) => {
    window.__conversationStreams.at(-1).emit('conversation', {
      data: JSON.stringify({ conversation: nextConversation }),
    });
  }, rootConversation());
  await expect(planPill).toContainText('Plan 2 / 3');
  const subagentPill = conversation.locator('.mobile-subagent-pill');
  await expect(subagentPill).toHaveCount(1);
  await expect(subagentPill).toContainText('Agents');
  const subagentPillHost = conversation.locator('.mobile-subagent-pill-host');
  await expect(subagentPillHost).toHaveCSS('border-top-width', '0px');
  await expect(subagentPillHost).toHaveCSS('border-bottom-width', '0px');
  await expect.poll(() => conversation.evaluate((node) => {
    const pill = node.querySelector('.mobile-subagent-pill').getBoundingClientRect();
    const composer = node.querySelector('#mobile-conversation-composer').getBoundingClientRect();
    const scrollShell = node.querySelector('.mobile-conversation-scroll-shell').getBoundingClientRect();
    return {
      clearsComposer: pill.bottom <= composer.top - 8,
      followsHistory: pill.top >= scrollShell.bottom,
    };
  })).toEqual({ clearsComposer: true, followsHistory: true });
  await expect(conversation.locator('.mobile-subagent-card')).toHaveCount(0);
  await page.evaluate(() => {
    const ConversationWebSocket = window.WebSocket;
    class MockGraphicsSocket extends EventTarget {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      constructor() {
        super();
        this.readyState = MockGraphicsSocket.OPEN;
        queueMicrotask(() => this.dispatchEvent(new Event('open')));
      }
      send() {}
      close() {
        this.readyState = MockGraphicsSocket.CLOSED;
        this.dispatchEvent(new CloseEvent('close'));
      }
    }
    window.WebSocket = class MockRoutedSocket {
      static CONNECTING = MockGraphicsSocket.CONNECTING;
      static OPEN = MockGraphicsSocket.OPEN;
      static CLOSING = MockGraphicsSocket.CLOSING;
      static CLOSED = MockGraphicsSocket.CLOSED;
      constructor(url) {
        return String(url).includes('/conversation-ws')
          ? new ConversationWebSocket(url)
          : new MockGraphicsSocket(url);
      }
    };
    window.__conversationStreams.at(-1).emit('control', {
      data: JSON.stringify({
        type: 'control', action: 'open-graphics',
        argv: ['terminal-browser', 'open', 'https://example.test'],
      }),
    });
  });
  await expect(conversation.locator('.mobile-browser-pill')).toBeVisible();
  await expect(conversation.locator('.mobile-activity-pill-cluster > button')).toHaveCount(4);
  await page.locator('.graphics-terminal-instance').evaluate((host) => {
    host.dataset.reuseMarker = 'original-browser-pane';
  });
  await page.evaluate(() => {
    window.__conversationStreams.at(-1).emit('control', {
      data: JSON.stringify({
        type: 'control', action: 'open-graphics', reuseExisting: true,
        argv: ['terminal-browser', 'open', 'https://example.test'],
      }),
    });
  });
  await expect(page.locator('.graphics-terminal-instance')).toHaveCount(1);
  await expect(page.locator('.graphics-terminal-instance'))
    .toHaveAttribute('data-reuse-marker', 'original-browser-pane');
  await expect.poll(() => conversation.locator('.mobile-activity-pill-cluster').evaluate((cluster) => {
    const pill = cluster.querySelector('.mobile-browser-pill');
    const dismiss = cluster.querySelector('.mobile-activity-pill-dismiss');
    const icon = dismiss.querySelector('.mobile-panel-collapse-icon');
    const dismissBox = dismiss.getBoundingClientRect();
    const iconBox = icon.getBoundingClientRect();
    return {
      height: Math.round(cluster.getBoundingClientRect().height),
      fontSize: getComputedStyle(pill).fontSize,
      horizontalPadding: getComputedStyle(pill).paddingLeft,
      dismissWidth: Math.round(dismiss.getBoundingClientRect().width),
      collapseIconCount: dismiss.querySelectorAll('.mobile-panel-collapse-icon').length,
      collapseIconCentered: Math.abs((iconBox.left + iconBox.right - dismissBox.left - dismissBox.right) / 2) <= 1 &&
        Math.abs((iconBox.top + iconBox.bottom - dismissBox.top - dismissBox.bottom) / 2) <= 1,
    };
  })).toEqual({
    height: 38,
    fontSize: '12px',
    horizontalPadding: '9px',
    dismissWidth: 34,
    collapseIconCount: 1,
    collapseIconCentered: true,
  });
  await expect(conversation.getByRole('button', { name: 'Hide activity' })).toHaveText('');
  await page.locator('#graphics-sheet-backdrop').click({ position: { x: 8, y: 8 } });
  await expect(page.locator('#graphics-split')).toBeHidden();
  await messages.evaluate((node) => {
    node.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -120 }));
    node.scrollTop = Math.max(0, node.scrollTop - 120);
  });
  await expect.poll(() => messages.evaluate((node) =>
    Math.max(0, node.scrollHeight - node.scrollTop - node.clientHeight))).toBeGreaterThan(48);
  let activityScrollAnchor = await messages.evaluate((node) => node.scrollTop);
  // A spawn can be dismissed before its thread id arrives. The later binding
  // is the same lifecycle and must not resurrect the activity pill on reload.
  const persistedSubagentThreadId = subagentItem.threadId;
  delete subagentItem.threadId;
  await page.evaluate((nextConversation) => {
    window.__conversationStreams.at(-1).emit('conversation', {
      data: JSON.stringify({ conversation: nextConversation }),
    });
  }, rootConversation());
  await conversation.getByRole('button', { name: 'Hide activity' }).click();
  await expect(conversation.locator('.mobile-subagent-pill-host')).toBeHidden();
  await expect.poll(() => page.evaluate((name) => Boolean(
    localStorage.getItem(`agent-remote:mobile-activity-dismissed:${encodeURIComponent(name)}`),
  ), sessionName)).toBe(true);
  await expect.poll(() => messages.evaluate((node, anchor) =>
    Math.abs(node.scrollTop - anchor), activityScrollAnchor)).toBeLessThanOrEqual(1);
  subagentItem.threadId = persistedSubagentThreadId;
  await page.reload();
  await expect(conversation).toBeVisible();
  await expect(conversation.locator('.mobile-subagent-pill-host')).toBeHidden();
  activityScrollAnchor = await messages.evaluate((node) => node.scrollTop);
  const activityToggle = conversation.getByRole('button', { name: 'Show activity' });
  await expect(activityToggle).toBeVisible();
  await expect(activityToggle.locator('.mobile-panel-collapse-icon')).toHaveCount(1);
  await expect(activityToggle.locator('.mobile-panel-collapse-icon')).toHaveCSS('width', '17px');
  await expect.poll(() => conversation.evaluate((node) => {
    const showIcon = node.querySelector('#mobile-conversation-activity-toggle svg');
    const hideIcon = node.querySelector('.mobile-activity-pill-dismiss svg');
    return showIcon?.innerHTML === hideIcon?.innerHTML;
  })).toBe(true);
  await activityToggle.click();
  await expect(conversation.locator('.mobile-subagent-pill-host')).toBeVisible();
  await expect.poll(() => page.evaluate((name) => (
    localStorage.getItem(`agent-remote:mobile-activity-dismissed:${encodeURIComponent(name)}`)
  ), sessionName)).toBeNull();
  await expect.poll(() => messages.evaluate((node, anchor) =>
    Math.abs(node.scrollTop - anchor), activityScrollAnchor)).toBeLessThanOrEqual(1);
  await expect(activityToggle).toBeHidden();
  await page.setViewportSize({ width: 320, height: 568 });
  await expect.poll(() => conversation.evaluate((node) => {
    const jump = node.querySelector('#mobile-conversation-jump').getBoundingClientRect();
    const cluster = node.querySelector('.mobile-activity-pill-cluster').getBoundingClientRect();
    return jump.bottom <= cluster.top || jump.top >= cluster.bottom
      || jump.right <= cluster.left || jump.left >= cluster.right;
  })).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await conversation.locator('.mobile-browser-pill').click();
  await expect(page.locator('#graphics-split')).toBeVisible();
  await expect(page.locator('#graphics-mobile-agents')).toBeVisible();
  await page.locator('#graphics-mobile-agents').click();
  await expect(page.locator('#graphics-split')).toBeHidden();
  await expect(conversation.locator('.mobile-subagent-sheet')).toBeVisible();
  await expect.poll(() => conversation.locator('.mobile-subagent-sheet-panel').evaluate((panel) => {
    const box = panel.getBoundingClientRect();
    const keyframes = [...document.styleSheets].flatMap((sheet) => [...sheet.cssRules])
      .find((rule) => rule.type === CSSRule.KEYFRAMES_RULE && rule.name === 'mobile-sheet-in');
    const firstFrame = keyframes && [...keyframes.cssRules].find((rule) =>
      rule.keyText === 'from' || rule.keyText === '0%');
    return {
      height: Math.round(box.height),
      bottom: Math.round(innerHeight - box.bottom),
      slidesFromBelow: Boolean(firstFrame?.style.transform && firstFrame.style.transform !== 'none'),
    };
  })).toEqual(expect.objectContaining({ bottom: 0, slidesFromBelow: true }));
  expect((await conversation.locator('.mobile-subagent-sheet-panel').boundingBox()).height).toBeLessThan(420);
  await expect(conversation.locator('.mobile-subagent-group').first()).toContainText('In progress');
  await expect(conversation.locator('.mobile-subagent-group').last()).toContainText('Done');
  await conversation.locator('.mobile-subagent-sheet-browser').click();
  await expect(conversation.locator('.mobile-subagent-sheet')).toBeHidden();
  await expect(page.locator('#graphics-split')).toBeVisible();
  await page.locator('#close-graphics-split').click();
  await expect(page.locator('#graphics-split')).toBeHidden();
  await expect(conversation.locator('.mobile-browser-pill')).toHaveCount(0);
  await page.evaluate(() => {
    window.__conversationStreams.at(-1).emit('control', {
      data: JSON.stringify({
        type: 'control', action: 'open-graphics',
        argv: ['terminal-browser', 'open', 'https://updated.example.test'],
      }),
    });
  });
  await expect(conversation.locator('.mobile-browser-pill')).toBeVisible();
  await page.locator('#close-graphics-split').click();
  await expect(conversation.locator('.mobile-browser-pill')).toHaveCount(0);
  Object.assign(subagentItem, { threadId: 'child-thread', phase: 'running', status: 'working' });
  await page.evaluate((nextConversation) => {
    window.__conversationStreams.at(-1).emit('conversation', {
      data: JSON.stringify({ conversation: nextConversation }),
    });
  }, rootConversation());
  await expect(subagentPill).toHaveCount(1);
  await expect(subagentPill).toContainText('Agents');
  Object.assign(subagentItem, { phase: 'done', status: 'completed' });
  await page.evaluate((nextConversation) => {
    window.__conversationStreams.at(-1).emit('conversation', {
      data: JSON.stringify({ conversation: nextConversation }),
    });
  }, rootConversation());
  await expect(subagentPill).toHaveCount(1);
  await expect(subagentPill).toContainText('Agents');
  const streamPrefix = 'This reply arrived as a real provider chunk.';
  const streamText = `${streamPrefix} The next provider chunk appends without a simulated delay.`;
  rootItems.push({ id: 'assistant-stream', type: 'message', role: 'assistant', text: streamPrefix });
  await page.evaluate((nextConversation) => {
    window.__conversationStreams.at(-1).emit('conversation', {
      data: JSON.stringify({ conversation: nextConversation }),
    });
  }, rootConversation());
  const streamedMessage = conversation.locator('[data-message-id="assistant-stream"]');
  await expect(streamedMessage.locator('.mobile-message-content')).toHaveText(streamPrefix);
  rootItems[rootItems.findIndex((item) => item.id === 'assistant-stream')] = {
    id: 'assistant-stream', type: 'message', role: 'assistant', text: streamText,
  };
  await page.evaluate((nextConversation) => {
    window.__conversationStreams.at(-1).emit('conversation', {
      data: JSON.stringify({ conversation: nextConversation }),
    });
  }, rootConversation());
  await expect(streamedMessage.locator('.mobile-message-content')).toHaveText(streamText);
  await expect(streamedMessage).not.toHaveAttribute('data-streaming', 'true');

  currentActivity = { active: true, phase: 'responding', label: 'Responding…' };
  rootItems.push({ id: 'assistant-live-token', type: 'message', role: 'assistant', text: 'Token' });
  await page.evaluate((nextConversation) => {
    window.__conversationStreams.at(-1).emit('conversation', {
      data: JSON.stringify({ conversation: nextConversation, stream: {
        kind: 'agent_message_chunk', delta: 'Token',
      } }),
    });
  }, rootConversation());
  const liveTokenMessage = conversation.locator('[data-message-id="assistant-live-token"]');
  await expect(liveTokenMessage).toHaveAttribute('data-streaming', 'true');
  await page.evaluate(() => {
    window.__liveTokenContent = document.querySelector(
      '[data-message-id="assistant-live-token"] > .mobile-message-content',
    );
  });
  for (const [index, delta] of [' by', ' token'].entries()) {
    const item = rootItems.find((entry) => entry.id === 'assistant-live-token');
    item.text += delta;
    await page.evaluate(({ nextConversation, delta: nextDelta, compact }) => {
      window.__conversationStreams.at(-1).emit('conversation', {
        data: JSON.stringify({ ...(compact ? {} : { conversation: nextConversation }), stream: {
          kind: 'agent_message_chunk', delta: nextDelta,
          threadId: 'root-thread', messageId: 'assistant-live-token',
        } }),
      });
    }, { nextConversation: rootConversation(), delta, compact: index > 0 });
  }
  await expect(liveTokenMessage.locator('.mobile-message-content')).toHaveText('Token by token');
  expect(await page.evaluate(() => window.__liveTokenContent.isSameNode(document.querySelector(
    '[data-message-id="assistant-live-token"] > .mobile-message-content',
  )))).toBe(true);

  // iOS can retain pointer capture while native scrolling and never deliver a
  // matching pointerup. Stream/lifecycle snapshots must not wait for that
  // gesture or the phone stays on Responding until another action flushes it.
  await liveTokenMessage.dispatchEvent('pointerdown', { pointerType: 'touch', pointerId: 41 });
  rootItems.find((entry) => entry.id === 'assistant-live-token').text += ' final';
  await page.evaluate(() => {
    window.__conversationStreams.at(-1).emit('conversation', {
      data: JSON.stringify({ stream: {
        kind: 'agent_message_chunk', delta: ' final', threadId: 'root-thread',
        messageId: 'assistant-live-token',
      } }),
    });
  });
  await expect(liveTokenMessage.locator('.mobile-message-content')).toHaveText('Token by token final');

  currentActivity = { active: false };
  await page.evaluate((nextConversation) => {
    window.__conversationStreams.at(-1).emit('conversation', {
      data: JSON.stringify({ conversation: nextConversation, stream: { kind: 'turn_completed' } }),
    });
  }, rootConversation());
  await expect(liveTokenMessage).not.toHaveAttribute('data-streaming', 'true');
  await expect(liveTokenMessage.locator('.mobile-markdown')).toHaveText('Token by token final');
  await expect(conversation.locator('#mobile-conversation-send')).toHaveAttribute('data-action', 'send');

  // The Markdown fragment has serializer whitespace after its paragraph.
  // Compact chunks must append inside that paragraph, not to a root text node
  // that puts "'m" on a new line until refresh/turn completion.
  currentActivity = { active: true, phase: 'responding', label: 'Responding…' };
  const liveContractionItem = {
    id: 'assistant-live-contraction', type: 'message', role: 'assistant', text: 'I',
  };
  rootItems.push(liveContractionItem);
  await page.evaluate((nextConversation) => {
    window.__conversationStreams.at(-1).emit('conversation', {
      data: JSON.stringify({ conversation: nextConversation, stream: {
        kind: 'agent_message_chunk', delta: 'I',
        threadId: 'root-thread', messageId: 'assistant-live-contraction',
      } }),
    });
  }, rootConversation());
  liveContractionItem.text += "'m ready to help — what would you like to work on?";
  await page.evaluate(() => {
    window.__conversationStreams.at(-1).emit('conversation', {
      data: JSON.stringify({ stream: {
        kind: 'agent_message_chunk', delta: "'m ready to help — what would you like to work on?",
        threadId: 'root-thread', messageId: 'assistant-live-contraction',
      } }),
    });
  });
  const liveContraction = conversation.locator(
    '[data-message-id="assistant-live-contraction"] .mobile-markdown',
  );
  await expect(liveContraction).toHaveText("I'm ready to help — what would you like to work on?");
  await expect(liveContraction.locator('p')).toHaveCount(1);
  await expect(liveContraction.locator('br')).toHaveCount(0);
  expect(await page.evaluate(() => {
    const markdown = document.querySelector(
      '[data-message-id="assistant-live-contraction"] .mobile-markdown',
    );
    const paragraph = markdown?.querySelector(':scope > p');
    const nonWhitespaceRootText = [...(markdown?.childNodes || [])].some(
      (node) => node.nodeType === Node.TEXT_NODE && node.data.trim(),
    );
    return paragraph?.textContent === "I'm ready to help — what would you like to work on?" &&
      !nonWhitespaceRootText;
  })).toBe(true);

  // ACP can split prose on a soft newline even though Grok's terminal renders
  // the result as one sentence. Streaming and restored history must agree and
  // must not turn that soft break into a visible <br>.
  currentActivity = { active: true, phase: 'responding', label: 'Responding…' };
  const liveSoftBreakItem = {
    id: 'assistant-live-soft-break', type: 'message', role: 'assistant', text: 'พิมพ์',
  };
  rootItems.push(liveSoftBreakItem);
  await page.evaluate((nextConversation) => {
    window.__conversationStreams.at(-1).emit('conversation', {
      data: JSON.stringify({ conversation: nextConversation, stream: {
        kind: 'agent_message_chunk', delta: nextConversation.items.at(-1).text,
        threadId: 'root-thread', messageId: 'assistant-live-soft-break',
      } }),
    });
  }, rootConversation());
  liveSoftBreakItem.text += '\nมาแบบนั้นอีกแล้ว....';
  await page.evaluate(() => {
    window.__conversationStreams.at(-1).emit('conversation', {
      data: JSON.stringify({ stream: {
        kind: 'agent_message_chunk', delta: '\nมาแบบนั้นอีกแล้ว....',
        threadId: 'root-thread', messageId: 'assistant-live-soft-break',
      } }),
    });
  });
  const liveSoftBreak = conversation.locator('[data-message-id="assistant-live-soft-break"] .mobile-markdown');
  await expect(liveSoftBreak).toHaveText('พิมพ์ มาแบบนั้นอีกแล้ว....');
  await expect(liveSoftBreak.locator('br')).toHaveCount(0);

  // A provider chunk can end on a soft newline. marked trims that trailing
  // newline from the current DOM, so the next compact delta must restore its
  // collapsed space without replacing the paragraph or waiting for refresh.
  const trailingSoftBreakItem = {
    id: 'assistant-trailing-soft-break', type: 'message', role: 'assistant', text: 'ดูเหมือน\n',
  };
  rootItems.push(trailingSoftBreakItem);
  await page.evaluate((nextConversation) => {
    window.__conversationStreams.at(-1).emit('conversation', {
      data: JSON.stringify({ conversation: nextConversation, stream: {
        kind: 'agent_message_chunk', delta: nextConversation.items.at(-1).text,
        threadId: 'root-thread', messageId: 'assistant-trailing-soft-break',
      } }),
    });
  }, rootConversation());
  const trailingSoftBreak = conversation.locator(
    '[data-message-id="assistant-trailing-soft-break"] .mobile-markdown',
  );
  await page.evaluate(() => {
    window.__stableStreamingParagraph = document.querySelector(
      '[data-message-id="assistant-trailing-soft-break"] .mobile-markdown p',
    );
  });
  trailingSoftBreakItem.text += 'จะเป็นการพิมพ์ทดสอบ';
  await page.evaluate(() => {
    window.__conversationStreams.at(-1).emit('conversation', {
      data: JSON.stringify({ stream: {
        kind: 'agent_message_chunk', delta: 'จะเป็นการพิมพ์ทดสอบ',
        threadId: 'root-thread', messageId: 'assistant-trailing-soft-break',
      } }),
    });
  });
  await expect(trailingSoftBreak).toHaveText('ดูเหมือน จะเป็นการพิมพ์ทดสอบ');
  expect(await page.evaluate(() => window.__stableStreamingParagraph.isSameNode(document.querySelector(
    '[data-message-id="assistant-trailing-soft-break"] .mobile-markdown p',
  )))).toBe(true);
  trailingSoftBreakItem.text += ' (หรือพิมพ์พลาด)';
  await page.evaluate(() => {
    window.__conversationStreams.at(-1).emit('conversation', {
      data: JSON.stringify({ stream: {
        kind: 'agent_message_chunk', delta: ' (หรือพิมพ์พลาด)',
        threadId: 'root-thread', messageId: 'assistant-trailing-soft-break',
      } }),
    });
  });
  await expect(trailingSoftBreak).toHaveText('ดูเหมือน จะเป็นการพิมพ์ทดสอบ (หรือพิมพ์พลาด)');
  await expect(trailingSoftBreak.locator('p')).toHaveCount(1);
  expect(await page.evaluate(() => window.__stableStreamingParagraph.isSameNode(document.querySelector(
    '[data-message-id="assistant-trailing-soft-break"] .mobile-markdown p',
  )))).toBe(true);
  currentActivity = { active: false };
  await page.evaluate((nextConversation) => {
    window.__conversationStreams.at(-1).emit('conversation', {
      data: JSON.stringify({ conversation: nextConversation, stream: { kind: 'turn_completed' } }),
    });
  }, rootConversation());
  await expect(trailingSoftBreak).not.toHaveAttribute('data-streaming', 'true');
  expect(await page.evaluate(() => window.__stableStreamingParagraph.isSameNode(document.querySelector(
    '[data-message-id="assistant-trailing-soft-break"] .mobile-markdown p',
  )))).toBe(true);

  currentActivity = { active: true, phase: 'responding', label: 'Responding…' };
  const liveMarkdownItem = {
    id: 'assistant-live-markdown', type: 'message', role: 'assistant',
    text: 'หลายเรื่องให้เลือกเลย เช่น',
  };
  rootItems.push(liveMarkdownItem);
  await page.evaluate((nextConversation) => {
    window.__conversationStreams.at(-1).emit('conversation', {
      data: JSON.stringify({ conversation: nextConversation, stream: {
        kind: 'agent_message_chunk', delta: nextConversation.items.at(-1).text,
        threadId: 'root-thread', messageId: 'assistant-live-markdown',
      } }),
    });
  }, rootConversation());
  const markdownDelta = [
    '',
    '- **เรื่องเทค** — AI และ LLM',
    '- **เรื่องงาน** — สิ่งที่กำลังติดขัด',
    '- **เรื่องทั่วไป** — หนัง เพลง และเกม',
  ].join('\n');
  liveMarkdownItem.text += markdownDelta;
  await page.evaluate((delta) => {
    window.__conversationStreams.at(-1).emit('conversation', {
      data: JSON.stringify({ stream: {
        kind: 'agent_message_chunk', delta, threadId: 'root-thread',
        messageId: 'assistant-live-markdown',
      } }),
    });
  }, markdownDelta);
  const liveMarkdownMessage = conversation.locator('[data-message-id="assistant-live-markdown"]');
  await expect(liveMarkdownMessage.locator('li')).toHaveCount(3);
  await expect(liveMarkdownMessage.locator('strong')).toHaveCount(3);
  await expect(sendButton).toHaveAttribute('data-action', 'stop');
  currentActivity = { active: false };
  await page.evaluate((nextConversation) => {
    window.__conversationStreams.at(-1).emit('conversation', {
      data: JSON.stringify({ conversation: nextConversation, stream: { kind: 'turn_completed' } }),
    });
  }, rootConversation());

  // Grok ACP can omit newline-only chunks while a numbered answer is live,
  // then restore those line breaks in the completed replay. The streaming
  // renderer must recover the ordered-list boundaries before completion.
  currentActivity = { active: true, phase: 'responding', label: 'Responding…' };
  const collapsedNumberedItem = {
    id: 'assistant-collapsed-numbered', type: 'message', role: 'assistant',
    text: 'Here are 100 numbered sentences:',
  };
  rootItems.push(collapsedNumberedItem);
  await page.evaluate((nextConversation) => {
    window.__conversationStreams.at(-1).emit('conversation', {
      data: JSON.stringify({ conversation: nextConversation, stream: {
        kind: 'agent_message_chunk', delta: nextConversation.items.at(-1).text,
        threadId: 'root-thread', messageId: 'assistant-collapsed-numbered',
      } }),
    });
  }, rootConversation());
  const collapsedNumberedMessage = conversation.locator(
    '[data-message-id="assistant-collapsed-numbered"]',
  );
  for (const [delta, count] of [
    ['1', 0],
    ['. First sentence.', 1],
    ['2', 1],
    ['. Second sentence.', 2],
    ['3. Third sentence.', 3],
  ]) {
    collapsedNumberedItem.text += delta;
    await page.evaluate((nextDelta) => {
      window.__conversationStreams.at(-1).emit('conversation', {
        data: JSON.stringify({ stream: {
          kind: 'agent_message_chunk', delta: nextDelta, threadId: 'root-thread',
          messageId: 'assistant-collapsed-numbered',
        } }),
      });
    }, delta);
    await expect(collapsedNumberedMessage.locator('li')).toHaveCount(count);
  }
  await expect(collapsedNumberedMessage.locator('p')).toHaveText('Here are 100 numbered sentences:');
  await expect(sendButton).toHaveAttribute('data-action', 'stop');
  collapsedNumberedItem.text = [
    'Here are 100 numbered sentences:', '',
    '1. First sentence.', '2. Second sentence.', '3. Third sentence.',
  ].join('\n');
  currentActivity = { active: false };
  await page.evaluate((nextConversation) => {
    window.__conversationStreams.at(-1).emit('conversation', {
      data: JSON.stringify({ conversation: nextConversation, stream: { kind: 'turn_completed' } }),
    });
  }, rootConversation());
  await expect(collapsedNumberedMessage.locator('li')).toHaveCount(3);
  await expect(collapsedNumberedMessage).not.toHaveAttribute('data-streaming', 'true');

  currentActivity = { active: true, phase: 'responding', label: 'Responding…' };
  const liveCodeItem = {
    id: 'assistant-live-code', type: 'message', role: 'assistant',
    text: `\`\`\`js\nconst value = "${'wide '.repeat(40)}";`,
  };
  rootItems.push(liveCodeItem);
  await page.evaluate((nextConversation) => {
    window.__conversationStreams.at(-1).emit('conversation', {
      data: JSON.stringify({ conversation: nextConversation, stream: {
        kind: 'agent_message_chunk', delta: nextConversation.items.at(-1).text,
      } }),
    });
  }, rootConversation());
  const liveCodeMessage = conversation.locator('[data-message-id="assistant-live-code"]');
  const liveCodePre = liveCodeMessage.locator('pre');
  await liveCodePre.evaluate((node) => {
    node.scrollLeft = 72;
    window.__liveCodePre = node;
  });
  liveCodeItem.text += '\nconsole.log(value);';
  await page.evaluate((nextConversation) => {
    window.__conversationStreams.at(-1).emit('conversation', {
      data: JSON.stringify({ conversation: nextConversation, stream: {
        kind: 'agent_message_chunk', delta: '\nconsole.log(value);',
      } }),
    });
  }, rootConversation());
  expect(await page.evaluate(() => window.__liveCodePre.isSameNode(document.querySelector(
    '[data-message-id="assistant-live-code"] pre',
  )))).toBe(true);
  expect(await liveCodePre.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
  await expect(liveCodePre).toContainText('console.log(value);');

  liveCodeItem.text += '\n```';
  currentActivity = { active: false };
  await page.evaluate((nextConversation) => {
    window.__conversationStreams.at(-1).emit('conversation', {
      data: JSON.stringify({ conversation: nextConversation, stream: { kind: 'turn_completed' } }),
    });
  }, rootConversation());
  await expect(liveCodeMessage).not.toHaveAttribute('data-streaming', 'true');

  const streamedCode = {
    id: 'assistant-code-stream', type: 'message', role: 'assistant',
    text: `\`\`\`js\n${Array.from({ length: 50 }, (_, index) =>
      `line ${index + 1}: ${'long-code-value '.repeat(12)}`).join('\n')}\n\`\`\``,
  };
  rootItems.push(streamedCode);
  await page.evaluate((nextConversation) => {
    window.__conversationStreams.at(-1).emit('conversation', {
      data: JSON.stringify({ conversation: nextConversation }),
    });
  }, rootConversation());
  const streamedCodeViewport = conversation.locator(
    '[data-message-id="assistant-code-stream"] [data-markdown-scroll^="code:"]',
  );
  await expect.poll(() => streamedCodeViewport.evaluate((node) => ({
    vertical: node.scrollHeight > node.clientHeight,
    horizontal: node.scrollWidth > node.clientWidth,
  }))).toEqual({ vertical: true, horizontal: true });
  const readingPosition = await streamedCodeViewport.evaluate((node) => {
    node.scrollTop = 80;
    node.scrollLeft = 70;
    return { top: node.scrollTop, left: node.scrollLeft };
  });
  streamedCode.text = streamedCode.text.replace('\n```',
    `\n${Array.from({ length: 8 }, (_, index) => `appended ${index + 1}`).join('\n')}\n\`\`\``);
  await page.evaluate((nextConversation) => {
    window.__conversationStreams.at(-1).emit('conversation', {
      data: JSON.stringify({ conversation: nextConversation }),
    });
  }, rootConversation());
  await expect(streamedCodeViewport).toContainText('appended 8');
  await expect.poll(() => streamedCodeViewport.evaluate((node) => ({
    top: node.scrollTop, left: node.scrollLeft,
  }))).toEqual(readingPosition);
  await streamedCodeViewport.evaluate((node) => { node.scrollTop = node.scrollHeight; });
  streamedCode.text = streamedCode.text.replace('\n```', '\nfinal streamed line\n```');
  await page.evaluate((nextConversation) => {
    window.__conversationStreams.at(-1).emit('conversation', {
      data: JSON.stringify({ conversation: nextConversation }),
    });
  }, rootConversation());
  await expect.poll(() => streamedCodeViewport.evaluate((node) =>
    node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThanOrEqual(1);

  rootItems.push({
    id: 'tool-single-root', type: 'tool', title: 'Wrote standalone.js', kind: 'write', status: 'completed',
    diffs: [{ path: 'standalone.js', oldText: 'const state = "old";\n', newText: 'const state = "ready";\n' }],
  });
  await page.evaluate((nextConversation) => {
    window.__conversationStreams.at(-1).emit('conversation', {
      data: JSON.stringify({ conversation: nextConversation }),
    });
  }, rootConversation());
  const standaloneTool = conversation.locator('[data-event-id="tool-single-root"]');
  await expect.poll(() => standaloneTool.evaluate((node) => ({
    border: getComputedStyle(node).borderTopStyle,
    background: getComputedStyle(node).backgroundColor,
    columns: getComputedStyle(node.querySelector(':scope > .mobile-event-toggle')).gridTemplateColumns.split(' ').length,
  }))).toEqual({ border: 'none', background: 'rgba(0, 0, 0, 0)', columns: 4 });
  await standaloneTool.getByRole('button').click();
  await expect(standaloneTool.locator(':scope > .mobile-event-panel')).toBeVisible();
  await expect.poll(() => standaloneTool.evaluate((tool) => {
    const outer = tool.getBoundingClientRect();
    const detail = tool.querySelector(':scope > .mobile-event-panel').getBoundingClientRect();
    return {
      detailLeft: Math.round(detail.left - outer.left),
      detailRight: Math.round(outer.right - detail.right),
    };
  })).toEqual({ detailLeft: 0, detailRight: 0 });
  await expect.poll(() => standaloneTool.getByRole('button').evaluate((button) => ({
    pointerFocusReleased: document.activeElement !== button,
    mutedHeading: getComputedStyle(button.querySelector('strong')).color === (() => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--color-text-muted)';
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    })(),
    outline: getComputedStyle(button).outlineStyle,
  }))).toEqual({ pointerFocusReleased: true, mutedHeading: true, outline: 'none' });
  expect(await standaloneTool.getByRole('button').evaluate((button) => {
    button.focus();
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    return document.activeElement === button;
  })).toBe(true);

  rootItems.push({
    id: 'tool-group-short', type: 'tool_group', title: 'Read 2 short files', status: 'completed', tools: [
      { id: 'tool-short-a', type: 'tool', title: 'Read', subject: 'a.js', kind: 'read', status: 'completed' },
      { id: 'tool-short-b', type: 'tool', title: 'Read', subject: 'b.js', kind: 'read', status: 'completed' },
    ],
  });
  await page.evaluate((nextConversation) => {
    window.__conversationStreams.at(-1).emit('conversation', {
      data: JSON.stringify({ conversation: nextConversation }),
    });
  }, rootConversation());
  const shortToolPanel = conversation.locator('[data-event-id="tool-group-short"] > .mobile-tool-group-panel');
  const groupDisclosureMotion = await conversation.locator('[data-event-id="tool-group-short"]').evaluate(async (group) => {
    const toggle = group.querySelector(':scope > .mobile-tool-group-toggle');
    const panel = group.querySelector(':scope > .mobile-tool-group-panel');
    toggle.click();
    const opening = panel.dataset.disclosureMotion;
    const start = panel.getBoundingClientRect().height;
    await new Promise((resolve) => setTimeout(resolve, 80));
    const middle = panel.getBoundingClientRect().height;
    await new Promise((resolve) => setTimeout(resolve, 220));
    const end = panel.getBoundingClientRect().height;
    return { opening, start, middle, end, hidden: panel.hidden };
  });
  expect(groupDisclosureMotion.opening).toBe('opening');
  expect(groupDisclosureMotion.start).toBeLessThan(groupDisclosureMotion.middle);
  expect(groupDisclosureMotion.start).toBeLessThan(groupDisclosureMotion.end);
  expect(groupDisclosureMotion.hidden).toBe(false);
  await expect(shortToolPanel).toBeVisible();
  const shortToolPanelSize = await shortToolPanel.evaluate((panel) => ({
    height: panel.clientHeight,
    contentHeight: panel.scrollHeight,
  }));
  expect(shortToolPanelSize.height).toBe(shortToolPanelSize.contentHeight);
  expect(shortToolPanelSize.height).toBeLessThan(200);
  const shortToolPanelGeometry = await shortToolPanel.evaluate((panel) => {
    const item = panel.querySelector('.mobile-event-card');
    const panelBox = panel.getBoundingClientRect();
    const itemBox = item.getBoundingClientRect();
    const style = getComputedStyle(panel);
    return {
      leftGap: itemBox.left - panelBox.left,
      rightGap: panelBox.right - itemBox.right,
      itemWidth: itemBox.width,
      contentWidth: panel.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
      paddingLeft: style.paddingLeft,
      paddingRight: style.paddingRight,
    };
  });
  expect(shortToolPanelGeometry.paddingLeft).toBe(shortToolPanelGeometry.paddingRight);
  expect(Math.abs(shortToolPanelGeometry.leftGap - shortToolPanelGeometry.rightGap)).toBeLessThanOrEqual(1);
  expect(Math.abs(shortToolPanelGeometry.itemWidth - shortToolPanelGeometry.contentWidth)).toBeLessThanOrEqual(1);

  await conversation.getByRole('button', { name: /Listed 1 dir, Read 2 files/ }).click();
  const toolPanel = conversation.locator('[data-event-id="tool-group-1"] > .mobile-tool-group-panel');
  await expect.poll(() => toolPanel.evaluate((panel) => panel.clientHeight)).toBeGreaterThan(200);
  await expect.poll(() => toolPanel.evaluate((panel) => {
    const rows = [...panel.querySelectorAll(':scope > .mobile-event-card > .mobile-event-toggle')].slice(0, 2)
      .map((row) => row.getBoundingClientRect());
    return {
      firstHeight: Math.round(rows[0].height),
      secondHeight: Math.round(rows[1].height),
      gap: Math.round(rows[1].top - rows[0].bottom),
      gutter: getComputedStyle(panel).scrollbarGutter,
    };
  })).toEqual({ firstHeight: 36, secondHeight: 36, gap: 0, gutter: 'stable' });
  await expect.poll(() => messages.evaluate((panel) => getComputedStyle(panel).scrollbarGutter)).toBe('stable');
  await expect.poll(() => toolPanel.evaluate((panel) => {
    const group = panel.parentElement.getBoundingClientRect();
    const panelBox = panel.getBoundingClientRect();
    const child = panel.querySelector(':scope > .mobile-event-card').getBoundingClientRect();
    return {
      panelLeft: Math.round(panelBox.left - group.left),
      panelRight: Math.round(group.right - panelBox.right),
      childLeft: Math.round(child.left - group.left),
      childRight: Math.round(group.right - child.right),
    };
  })).toEqual({ panelLeft: 0, panelRight: 0, childLeft: 0, childRight: 0 });
  await expect.poll(() => toolPanel.locator(':scope > .mobile-event-card').first().evaluate((node) => ({
    border: getComputedStyle(node).borderTopStyle,
    background: getComputedStyle(node).backgroundColor,
  }))).toEqual({ border: 'none', background: 'rgba(0, 0, 0, 0)' });
  const editCard = conversation.locator('[data-event-id="tool-edit-app"]');
  await editCard.locator(':scope > .mobile-event-toggle').click();
  await expect(editCard.locator(':scope > .mobile-event-panel')).toBeHidden();
  const childDisclosureMotion = await editCard.evaluate(async (card) => {
    const toggle = card.querySelector(':scope > .mobile-event-toggle');
    const panel = card.querySelector(':scope > .mobile-event-panel');
    toggle.click();
    const opening = panel.dataset.disclosureMotion;
    const start = panel.getBoundingClientRect().height;
    await new Promise((resolve) => setTimeout(resolve, 80));
    const middle = panel.getBoundingClientRect().height;
    await new Promise((resolve) => setTimeout(resolve, 220));
    const end = panel.getBoundingClientRect().height;
    toggle.click();
    const closing = panel.dataset.disclosureMotion;
    const closingAnimation = panel.getAnimations()[0];
    const closingDuration = closingAnimation.effect.getTiming().duration;
    closingAnimation.currentTime = closingDuration - 0.01;
    const group = card.closest('.mobile-tool-group');
    const lastAnimatedGroupHeight = group.getBoundingClientRect().height;
    await closingAnimation.finished;
    const closedGroupHeight = group.getBoundingClientRect().height;
    return {
      opening, start, middle, end, closing, closed: panel.hidden,
      closingEndSnap: Math.abs(lastAnimatedGroupHeight - closedGroupHeight),
    };
  });
  expect(childDisclosureMotion.opening).toBe('opening');
  expect(childDisclosureMotion.start).toBeLessThan(childDisclosureMotion.middle);
  expect(childDisclosureMotion.start).toBeLessThan(childDisclosureMotion.end);
  expect(childDisclosureMotion.closing).toBe('closing');
  expect(childDisclosureMotion.closed).toBe(true);
  expect(childDisclosureMotion.closingEndSnap).toBeLessThan(1);
  const editStatusRight = await editCard.locator('.mobile-event-status').evaluate((status) => status.getBoundingClientRect().right);
  await conversation.getByRole('button', { name: /Edited app\.js/ }).click();
  await expect(editCard.locator('.mobile-event-panel')).toBeVisible();
  await expect.poll(() => editCard.evaluate((card) => {
    const group = card.closest('.mobile-tool-group').getBoundingClientRect();
    const detail = card.querySelector(':scope > .mobile-event-panel').getBoundingClientRect();
    return {
      detailLeft: Math.round(detail.left - group.left),
      detailRight: Math.round(group.right - detail.right),
    };
  })).toEqual({ detailLeft: 0, detailRight: 0 });
  await expect(editCard.locator('.mobile-event-change > header strong')).toHaveCSS('color', 'rgb(232, 164, 101)');
  await expect.poll(() => editCard.evaluate((card, before) => {
    const toggle = card.querySelector(':scope > .mobile-event-toggle');
    const panel = card.querySelector(':scope > .mobile-event-panel');
    const diff = panel.querySelector('.mobile-event-change-scroll');
    return {
      active: document.activeElement === toggle,
      outline: getComputedStyle(toggle).outlineStyle,
      statusShift: Math.round(Math.abs(card.querySelector('.mobile-event-status').getBoundingClientRect().right - before)),
      panelOverflow: getComputedStyle(panel).overflowY,
      diffOverflow: getComputedStyle(diff).overflowY,
      nestedVerticalScroll: diff.scrollHeight > diff.clientHeight,
    };
  }, editStatusRight)).toEqual({
    active: false,
    outline: 'none',
    statusShift: 0,
    panelOverflow: 'visible',
    diffOverflow: 'hidden',
    nestedVerticalScroll: false,
  });
  await expect(editCard.locator('.mobile-tool-detail')).toHaveCount(3);
  await expect(editCard.locator('.mobile-tool-detail').nth(0)).toContainText('Input');
  await expect(editCard.locator('.mobile-tool-detail').nth(1)).toContainText('Output');
  await expect(editCard.locator('.mobile-tool-detail').nth(2)).toHaveAttribute('data-variant', 'change');
  await expect(editCard.locator('.mobile-event-change')).toContainText('public/app.js');
  await expect(editCard.locator('.mobile-event-toggle .mobile-event-change-stats [data-kind="add"]')).toHaveText('+1');
  await expect(editCard.locator('.mobile-event-toggle .mobile-event-change-stats [data-kind="remove"]')).toHaveText('-1');
  await expect(editCard.locator('.mobile-event-change-line[data-kind="remove"]')).toContainText('const status = "old";');
  await expect(editCard.locator('.mobile-event-change-line[data-kind="add"]')).toContainText('const status = "ready";');
  await expect(editCard.locator('.mobile-event-change-line[data-kind="add"] .hljs-keyword')).toHaveText('const');
  await expect(editCard.locator('.mobile-event-change-line[data-kind="add"] .hljs-string')).toHaveText('"ready"');
  await expect.poll(() => editCard.locator('.mobile-event-change-line[data-kind="add"]').evaluate((row) => ({
    columns: row.children.length,
    lineNumber: row.children[0].textContent,
    marker: row.children[1].textContent,
    whiteSpace: getComputedStyle(row.children[2]).whiteSpace,
  }))).toEqual({ columns: 3, lineNumber: '1', marker: '+', whiteSpace: 'pre' });
  await expect.poll(() => editCard.locator('.mobile-event-change-line[data-kind="remove"]').evaluate((row) => ({
    columns: row.children.length,
    lineNumber: row.children[0].textContent,
    marker: row.children[1].textContent,
  }))).toEqual({ columns: 3, lineNumber: '1', marker: '−' });
  await expect.poll(() => editCard.locator('.mobile-event-change').evaluate((node) => {
    const added = node.querySelector('[data-kind="add"]');
    const removed = node.querySelector('[data-kind="remove"]');
    const tokenColor = (name) => {
      const probe = document.createElement('i');
      probe.style.color = `var(${name})`;
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    };
    return {
      addColor: getComputedStyle(node.querySelector(':scope > header .mobile-event-change-stats [data-kind="add"]')).color,
      removeColor: getComputedStyle(node.querySelector(':scope > header .mobile-event-change-stats [data-kind="remove"]')).color,
      addBackground: getComputedStyle(added).backgroundColor,
      removeBackground: getComputedStyle(removed).backgroundColor,
      addToken: tokenColor('--color-diff-add'),
      removeToken: tokenColor('--color-diff-remove'),
    };
  })).toEqual(expect.objectContaining({
    addColor: 'rgb(112, 200, 162)',
    removeColor: 'rgb(220, 127, 134)',
    addToken: 'rgb(112, 200, 162)',
    removeToken: 'rgb(220, 127, 134)',
  }));
  await conversation.locator('[data-event-id="tool-search-app"] > .mobile-event-toggle').click();
  await expect(conversation.locator('[data-event-id="tool-search-app"] > .mobile-event-toggle .mobile-event-heading'))
    .toHaveText('Search render in public/app.js (1 match)');
  const searchMatch = conversation.locator('.mobile-event-matches button');
  await expect(searchMatch).toContainText('render(status);');
  await expect.poll(() => conversation.locator('[data-event-id="tool-search-app"] > .mobile-event-panel')
    .evaluate((panel) => ({
      panelBorder: getComputedStyle(panel).borderTopWidth,
      rowBorderLeft: getComputedStyle(panel.querySelector('.mobile-event-matches button')).borderLeftWidth,
      rowPaddingTop: parseFloat(getComputedStyle(panel.querySelector('.mobile-event-matches button')).paddingTop),
    }))).toEqual({ panelBorder: '1px', rowBorderLeft: '0px', rowPaddingTop: 9 });
  await searchMatch.click();
  await expect(fileSheet).toBeVisible();
  await expect(fileSheet.locator('.mobile-file-line[data-highlighted="true"]')).toHaveCount(1);
  const closeFilePreview = fileSheet.getByRole('button', { name: 'Close file preview', exact: true });
  const closeRestingStyle = await closeFilePreview.evaluate((button) => ({
    background: getComputedStyle(button).backgroundColor,
    border: getComputedStyle(button).borderTopWidth,
  }));
  await closeFilePreview.hover();
  const closeHoverStyle = await closeFilePreview.evaluate((button) => ({
    background: getComputedStyle(button).backgroundColor,
    border: getComputedStyle(button).borderTopWidth,
  }));
  expect(closeRestingStyle.background).toBe('rgba(0, 0, 0, 0)');
  expect(closeHoverStyle.background).toBe(closeRestingStyle.background);
  expect(closeRestingStyle.border).toBe('0px');
  expect(closeHoverStyle.border).toBe('0px');
  const closeAnimation = await closeFilePreview.evaluate((button) => {
    button.click();
    const sheet = button.closest('.mobile-file-sheet');
    return {
      hidden: sheet.hidden,
      closing: sheet.dataset.closing,
      animations: sheet.querySelector('.mobile-file-sheet-panel').getAnimations().length,
    };
  });
  expect(closeAnimation).toEqual({ hidden: false, closing: 'true', animations: 1 });
  await expect(fileSheet).toBeHidden();
  const shellToolToggle = conversation.getByRole('button', { name: /Run Verify the focused test suite/ });
  await expect(shellToolToggle).not.toContainText('a-very-long-path');
  await shellToolToggle.click();
  const shellDetail = conversation.locator('[data-event-id="tool-shell"] .mobile-tool-command');
  await expect(shellDetail.locator('.mobile-tool-command-icon')).toHaveCount(1);
  await expect(shellDetail.locator('.mobile-tool-command-line')).not.toContainText('$');
  await expect(shellDetail.locator('.mobile-tool-command-line > code')).toContainText('node --test');
  await expect(conversation.locator('[data-event-id="tool-shell"] .mobile-tool-command-output')).toContainText('test output line 1');
  await expect(conversation.locator('[data-event-id="tool-shell"] .mobile-tool-detail')).toHaveCount(2);
  await expect.poll(() => shellDetail.locator('.mobile-tool-command-line')
    .evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
  await expect.poll(() => toolPanel.evaluate((panel) => panel.scrollHeight > panel.clientHeight)).toBe(true);
  const shellPanel = conversation.locator('[data-event-id="tool-shell"] > .mobile-event-panel');
  await expect.poll(() => shellPanel.evaluate((panel) => panel.scrollHeight <= panel.clientHeight)).toBe(true);
  await expect.poll(() => shellPanel.evaluate((panel) => getComputedStyle(panel).overflowY)).toBe('visible');
  await expect.poll(() => toolPanel.evaluate((panel) => getComputedStyle(panel).overscrollBehaviorY)).toBe('auto');
  await expect.poll(() => messages.evaluate((panel) => getComputedStyle(panel).overscrollBehaviorY)).toBe('contain');

  await conversation.getByRole('button', { name: /List Inspect source files/ }).click();
  const listDetail = conversation.locator('[data-event-id="tool-list"] .mobile-tool-detail');
  await expect(listDetail).toHaveCount(2);
  await expect(listDetail.filter({ hasText: 'Input' })).toContainText('"target_directory":"src"');
  await expect(listDetail.filter({ hasText: 'Output' })).toContainText('Found files');
  await conversation.getByRole('button', { name: /Read package\.json/ }).click();
  const genericReadDetail = conversation.locator('[data-event-id="tool-read-package"] .mobile-tool-command');
  await expect(genericReadDetail.locator('.mobile-tool-command-line > code')).toHaveText('Read package.json');
  await expect(conversation.locator('[data-event-id="tool-read-package"] .mobile-tool-command-output')).toHaveText('Package loaded');
  await expect(conversation.locator('[data-event-id="tool-read-package"] .mobile-tool-detail')).toHaveCount(2);

  await shellPanel.scrollIntoViewIfNeeded();
  const nestedScrollStart = await page.evaluate(() => {
    const detail = document.querySelector('[data-event-id="tool-shell"] > .mobile-event-panel');
    const group = document.querySelector('[data-event-id="tool-group-1"] > .mobile-tool-group-panel');
    detail.scrollTop = detail.scrollHeight;
    group.scrollTop = Math.max(0, group.scrollHeight - group.clientHeight - 90);
    return group.scrollTop;
  });
  await shellPanel.hover();
  await page.mouse.wheel(0, 240);
  await expect.poll(() => toolPanel.evaluate((panel) => panel.scrollTop)).toBeGreaterThan(nestedScrollStart);

  await shellPanel.scrollIntoViewIfNeeded();
  const mainScrollStart = await page.evaluate(() => {
    const detail = document.querySelector('[data-event-id="tool-shell"] > .mobile-event-panel');
    const group = document.querySelector('[data-event-id="tool-group-1"] > .mobile-tool-group-panel');
    const main = document.querySelector('.mobile-conversation-messages');
    detail.scrollTop = detail.scrollHeight;
    group.scrollTop = group.scrollHeight;
    main.scrollTop = Math.max(0, main.scrollTop - 120);
    return main.scrollTop;
  });
  await shellPanel.hover();
  await page.mouse.wheel(0, 320);
  await expect.poll(() => messages.evaluate((panel) => panel.scrollTop)).toBeGreaterThan(mainScrollStart);
  const toolReadingPosition = await toolPanel.evaluate((panel) => {
    panel.scrollTop = Math.min(60, panel.scrollHeight - panel.clientHeight - 1);
    return panel.scrollTop;
  });
  rootItems[rootItems.findIndex((item) => item.id === 'tool-group-1')].tools
    .find((tool) => tool.id === 'tool-shell').output += '\nstreamed tool output';
  await page.evaluate((nextConversation) => {
    window.__conversationStreams.at(-1).emit('conversation', {
      data: JSON.stringify({ conversation: nextConversation }),
    });
  }, rootConversation());
  await expect.poll(() => toolPanel.evaluate((panel) => panel.scrollTop)).toBe(toolReadingPosition);
  await conversation.getByRole('button', { name: /Read AGENTS\.md/ }).click();
  await expect(conversation.locator('[data-event-id="tool-read-agents"] .mobile-event-file'))
    .toContainText(/Provider instructions.*loaded/);
  await expect(conversation.locator('.mobile-subagent-pill')).toHaveText('Agents');
  await messages.evaluate((element) => { element.scrollTop = 0; });
  await expect.poll(() => messages.evaluate((element) => element.scrollTop)).toBe(0);
  const jumpToLatest = conversation.locator('#mobile-conversation-jump');
  await expect(jumpToLatest).toBeVisible();
  await jumpToLatest.click();
  await expect.poll(() => messages.evaluate((element) =>
    element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThanOrEqual(1);
  await expect(jumpToLatest).toBeHidden();
  expect(await page.evaluate(() => window.__mobileConversationScrollCalls.at(-1))).toEqual(expect.objectContaining({
    behavior: 'smooth',
  }));

  const streamCountBeforeSend = await page.evaluate(() => window.__conversationStreams.length);
  const streamBeforeSend = await page.evaluateHandle(() => window.__conversationStreams.at(-1));
  const readsBeforeSend = conversationReads;
  await input.fill('hello from phone');
  await conversation.locator('#mobile-conversation-send').click();
  await expect(sendButton).toHaveAttribute('data-action', 'sending');
  await expect(sendButton).toHaveAttribute('aria-label', 'Sending message');
  await expect(sendButton).toBeDisabled();
  await expect.poll(() => sendButton.evaluate((node) => ({
    ringAnimation: getComputedStyle(node, '::before').animationName,
    ringWidth: getComputedStyle(node, '::before').width,
    ringHeight: getComputedStyle(node, '::before').height,
    stopContent: getComputedStyle(node, '::after').content,
  }))).toEqual({
    ringAnimation: 'mobile-activity-spin', ringWidth: '14px', ringHeight: '14px', stopContent: 'none',
  });
  await expect(conversation.locator('.mobile-message[data-pending="true"]')).toContainText('hello from phone');
  await expect(conversation.locator('.mobile-message[data-pending="true"] .mobile-message-author'))
    .toHaveText('You');
  await expect(sendButton).toHaveAttribute('data-action', 'sending');
  await expect(sendButton).toHaveAttribute('aria-label', 'Sending message');
  await expect.poll(() => mobileInputs).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ text: 'hello from phone' }),
    ]),
  );
  expect(queuedInputs).toHaveLength(0);
  await expect.poll(() => typeof releaseHelloInput).toBe('function');
  await page.evaluate((nextConversation) => {
    window.__conversationStreams.at(-1).emit('conversation', {
      data: JSON.stringify({ conversation: nextConversation }),
    });
  }, rootConversation());
  await expect(conversation.locator('.mobile-message[data-pending="true"]')).toHaveCount(0);
  await messages.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event('scroll'));
  });
  currentActivity = {
    active: true, phase: 'writing', label: 'Writing response…',
    canCancel: true, cancelRequested: false,
  };
  rootItems.push({
    id: 'assistant-fast-start', type: 'message', role: 'assistant',
    text: 'First Grok token arrived before the phone resumed its stream.',
  });
  await page.evaluate((nextConversation) => {
    window.__conversationStreams.at(-1).emit('conversation', {
      data: JSON.stringify({ conversation: nextConversation }),
    });
  }, rootConversation());
  await expect(conversation.getByText('First Grok token arrived before the phone resumed its stream.')).toBeVisible();
  await expect(sendButton).toHaveAttribute('data-action', 'stop');
  await expect(sendButton).toHaveAttribute('aria-label', 'Stop response');
  await expect.poll(() => messages.evaluate((element) =>
    element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThanOrEqual(1);
  expect(await streamBeforeSend.evaluate((stream) => Boolean(stream.closed))).toBe(false);
  expect(await page.evaluate(() => window.__conversationStreams.length)).toBe(streamCountBeforeSend);
  releaseHelloInput();
  await expect.poll(() => conversationReads).toBeGreaterThan(readsBeforeSend);
  expect(await streamBeforeSend.evaluate((stream) => Boolean(stream.closed))).toBe(false);
  expect(await page.evaluate(() => window.__conversationStreams.length)).toBe(streamCountBeforeSend);
  currentActivity = { active: false };
  await page.evaluate((nextConversation) => {
    window.__conversationStreams.at(-1).emit('conversation', {
      data: JSON.stringify({ conversation: nextConversation }),
    });
  }, rootConversation());

  await input.fill('accepted without terminal focus');
  await conversation.locator('#mobile-conversation-send').click();
  await expect(input).toHaveValue('');
  await expect(conversation.locator('#mobile-conversation-state')).not.toHaveText(/waiting for interaction|send failed/i);
  await expect.poll(() => mobileInputs).toEqual(expect.arrayContaining([
    expect.objectContaining({ text: 'accepted without terminal focus' }),
  ]));

  currentActivity = {
    active: true, phase: 'writing', label: 'Writing response…',
    canCancel: true, cancelRequested: false,
  };
  await page.evaluate((nextConversation) => {
    window.__conversationStreams.at(-1).emit('conversation', { data: JSON.stringify({ conversation: nextConversation }) });
  }, rootConversation());
  await expect(sendButton).toHaveAttribute('data-action', 'stop');
  await input.fill('queued follow up');
  await conversation.locator('#mobile-conversation-send').click();
  const optimisticQueuedRow = conversation.locator('.mobile-conversation-queue-item', { hasText: 'queued follow up' });
  await expect(optimisticQueuedRow).toBeVisible();
  await expect(optimisticQueuedRow).toHaveAttribute('data-pending', 'true');
  await expect.poll(() => typeof releaseQueuedInput).toBe('function');
  releaseQueuedInput();
  queuedInputs.push({ id: 'queue-mobile-2', text: 'second queued message', createdAt: Date.now(), attachments: [] });
  await page.evaluate((nextConversation) => {
    window.__conversationStreams.at(-1).emit('conversation', { data: JSON.stringify({ conversation: nextConversation }) });
  }, rootConversation());
  const queuedRows = conversation.locator('.mobile-conversation-queue-item');
  await expect(queuedRows).toHaveCount(2);
  await expect(conversation.locator('.mobile-conversation-queue-title')).toHaveCount(0);
  expect((await queuedRows.first().boundingBox()).height).toBeLessThanOrEqual(52);
  const compactQueueChrome = await conversation.locator('#mobile-conversation-queue').evaluate((panel) => {
    const first = panel.querySelector('.mobile-conversation-queue-item');
    const second = first?.nextElementSibling;
    const composer = document.querySelector('#mobile-conversation-composer');
    const textarea = composer.querySelector('textarea');
    const mode = composer.querySelector('#mobile-conversation-mode');
    const model = composer.querySelector('#mobile-conversation-model');
    const panelRect = panel.getBoundingClientRect();
    const composerRect = composer.getBoundingClientRect();
    return {
      panelRadius: parseFloat(getComputedStyle(panel).borderTopLeftRadius),
      firstBorder: getComputedStyle(first).borderTopWidth,
      secondDivider: getComputedStyle(second).borderTopWidth,
      textareaBorder: getComputedStyle(textarea).borderTopWidth,
      textareaMinHeight: parseFloat(getComputedStyle(textarea).minHeight),
      composerTopRadius: parseFloat(getComputedStyle(composer).borderTopLeftRadius),
      composerBottomRadius: parseFloat(getComputedStyle(composer).borderBottomLeftRadius),
      composerHeight: composerRect.height,
      joinedGap: composerRect.top - panelRect.bottom,
      leftAlignment: composerRect.left - panelRect.left,
      rightAlignment: composerRect.right - panelRect.right,
      modeLeftBorder: getComputedStyle(mode).borderLeftWidth,
      modeTopBorder: getComputedStyle(mode).borderTopWidth,
      modelBackground: getComputedStyle(model).backgroundColor,
    };
  });
  expect(compactQueueChrome.firstBorder).toBe('0px');
  expect(compactQueueChrome.secondDivider).toBe('1px');
  expect(compactQueueChrome.textareaBorder).toBe('0px');
  expect(compactQueueChrome.panelRadius).toBeGreaterThanOrEqual(20);
  expect(compactQueueChrome.composerTopRadius).toBe(0);
  expect(compactQueueChrome.composerBottomRadius).toBeGreaterThanOrEqual(20);
  expect(compactQueueChrome.composerHeight).toBeGreaterThanOrEqual(50);
  expect(compactQueueChrome.composerHeight).toBeLessThanOrEqual(105);
  expect(compactQueueChrome.textareaMinHeight).toBeGreaterThanOrEqual(36);
  expect(compactQueueChrome.textareaMinHeight).toBeLessThanOrEqual(40);
  expect(Math.abs(compactQueueChrome.joinedGap)).toBeLessThanOrEqual(1);
  expect(Math.abs(compactQueueChrome.leftAlignment)).toBeLessThanOrEqual(1);
  expect(Math.abs(compactQueueChrome.rightAlignment)).toBeLessThanOrEqual(1);
  expect(compactQueueChrome.modeLeftBorder).toBe('0px');
  expect(compactQueueChrome.modeTopBorder).toBe('0px');
  expect(compactQueueChrome.modelBackground).toBe('rgba(0, 0, 0, 0)');

  const twoQueuedInputs = queuedInputs.map((entry) => ({ ...entry }));
  for (let index = 3; index <= 7; index += 1) {
    queuedInputs.push({
      id: `queue-mobile-${index}`,
      text: `queued message ${index}`,
      createdAt: Date.now() + index,
      attachments: [],
    });
  }
  await page.evaluate((nextConversation) => {
    window.__conversationStreams.at(-1).emit('conversation', {
      data: JSON.stringify({ conversation: nextConversation }),
    });
  }, rootConversation());
  await expect(queuedRows).toHaveCount(7);
  const overflowingQueue = await conversation.locator('#mobile-conversation-queue').evaluate((panel) => {
    const row = panel.querySelector('.mobile-conversation-queue-item');
    const scrollShell = document.querySelector('.mobile-conversation-scroll-shell');
    const composer = document.querySelector('#mobile-conversation-composer');
    const panelRect = panel.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    return {
      scrollable: panel.dataset.scrollable,
      overflowY: getComputedStyle(panel).overflowY,
      hasOverflow: panel.scrollHeight > panel.clientHeight,
      panelHeight: panelRect.height,
      rowHeight: rowRect.height,
      chatGap: panelRect.top - scrollShell.getBoundingClientRect().bottom,
      composerGap: composer.getBoundingClientRect().top - panelRect.bottom,
    };
  });
  expect(overflowingQueue.scrollable).toBe('true');
  expect(overflowingQueue.overflowY).toBe('auto');
  expect(overflowingQueue.hasOverflow).toBe(true);
  expect(overflowingQueue.panelHeight).toBeLessThanOrEqual(overflowingQueue.rowHeight * 5 + 8);
  expect(overflowingQueue.chatGap).toBeGreaterThanOrEqual(-1);
  expect(Math.abs(overflowingQueue.composerGap)).toBeLessThanOrEqual(1);
  await conversation.locator('#mobile-conversation-queue').evaluate((panel) => {
    panel.scrollTop = panel.scrollHeight;
  });
  await expect.poll(() => conversation.locator('#mobile-conversation-queue').evaluate((panel) => panel.scrollTop)).toBeGreaterThan(0);

  queuedInputs.splice(0, queuedInputs.length, ...twoQueuedInputs);
  await page.evaluate((nextConversation) => {
    window.__conversationStreams.at(-1).emit('conversation', {
      data: JSON.stringify({ conversation: nextConversation }),
    });
  }, rootConversation());
  await expect(queuedRows).toHaveCount(2);
  await expect(conversation.locator('#mobile-conversation-queue')).toHaveAttribute('data-scrollable', 'false');
  const firstQueuedRow = queuedRows.filter({ hasText: 'queued follow up' });
  await firstQueuedRow.evaluate((row) => { row.dataset.renderIdentity = 'preserved'; });
  currentActivity = { ...currentActivity, label: 'Streaming while a message is queued' };
  await page.evaluate((nextConversation) => {
    window.__conversationStreams.at(-1).emit('conversation', {
      data: JSON.stringify({ conversation: nextConversation }),
    });
  }, rootConversation());
  await expect(firstQueuedRow).toHaveAttribute('data-render-identity', 'preserved');
  await expect(firstQueuedRow).toHaveCSS('opacity', '1');
  const steerButton = firstQueuedRow.getByRole('button', { name: /Steer/ });
  const deleteButton = firstQueuedRow.getByRole('button', { name: 'Delete queued message' });
  expect((await steerButton.boundingBox()).height).toBeGreaterThanOrEqual(40);
  expect((await deleteButton.boundingBox()).height).toBeGreaterThanOrEqual(40);
  await expect(deleteButton).toHaveAccessibleName('Delete queued message');

  const dragHandle = firstQueuedRow.getByRole('button', { name: /Reorder queued message/ });
  const handleBox = await dragHandle.boundingBox();
  const secondBox = await queuedRows.filter({ hasText: 'second queued message' }).boundingBox();
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + handleBox.width / 2, secondBox.y + secondBox.height + 4, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => queueActions.find((entry) => entry.action === 'reorder')).toEqual({
    action: 'reorder', queueIds: ['queue-mobile-2', 'queue-mobile-1'],
  });
  await expect(queuedRows.first()).toContainText('second queued message');

  await messages.evaluate((node) => { node.scrollTop = 0; });
  await expect(conversation.locator('#mobile-conversation-jump')).toBeVisible();
  await firstQueuedRow.getByRole('button', { name: /Steer/ }).click();
  await expect.poll(() => queueActions.some((entry) => entry.action === 'steer')).toBe(true);
  const pendingSteer = conversation.locator('.mobile-message[data-pending="true"]');
  await expect(pendingSteer).toContainText('queued follow up');
  await expect(pendingSteer.locator('.mobile-message-author')).toHaveText('You');
  await expect.poll(() => messages.evaluate((node) =>
    node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThanOrEqual(1);
  await expect(conversation.locator('#mobile-conversation-jump')).toBeHidden();
  await expect(sendButton).toHaveAttribute('data-action', 'stop');
  await sendButton.click();
  await expect.poll(() => cancellations).toHaveLength(3);
  await expect(sendButton).toHaveAttribute('data-action', 'send');

  currentActivity = { active: false };
  await page.evaluate((nextConversation) => {
    window.__conversationStreams.at(-1).emit('conversation', { data: JSON.stringify({ conversation: nextConversation }) });
  }, rootConversation());
  await expect(sendButton).toHaveAttribute('data-action', 'send');

  await conversation.locator('#mobile-conversation-file').setInputFiles({
    name: 'phone.png', mimeType: 'image/png', buffer: Buffer.from('fake-image'),
  });
  await expect.poll(() => uploads).toContainEqual({
    name: encodeURIComponent('phone.png'), bytes: 'fake-image',
  });
  const uploadedAttachment = conversation.locator('.mobile-conversation-attachment');
  await expect(uploadedAttachment).toHaveAttribute('data-preview', 'fallback');
  await expect(uploadedAttachment.locator('.mobile-conversation-attachment-media')).toHaveCount(0);
  await expect(uploadedAttachment.locator('.mobile-conversation-attachment-name')).toHaveText('phone.png');
  await uploadedAttachment.getByRole('button', { name: 'View phone.png' }).click();
  const mediaSheet = conversation.locator('.mobile-file-sheet');
  await expect(mediaSheet).toBeVisible();
  await expect(mediaSheet).toHaveAttribute('aria-label', 'Media preview');
  await expect(mediaSheet.locator('.mobile-file-media-fallback')).toHaveText('phone.png');
  await mediaSheet.getByRole('button', { name: 'Close file preview' }).click();
  await expect(mediaSheet).toBeHidden();
  await conversation.locator('#mobile-conversation-file').setInputFiles({
    name: 'rejected.mov', mimeType: 'video/quicktime', buffer: Buffer.from('rejected-video'),
  });
  const uploadError = conversation.locator('.mobile-conversation-uploading[data-state="error"]');
  await expect(uploadError).toContainText('Upload failed');
  await expect(uploadError).toContainText('Fixture rejected this upload');
  await expect(conversation.locator('#mobile-conversation-send')).toBeDisabled();
  await expect(uploadError.getByRole('button', { name: 'Retry upload rejected.mov' })).toBeVisible();
  await input.click();
  await uploadError.getByRole('button', { name: 'Dismiss upload error' }).click();
  await expect(uploadError).toHaveCount(0);
  await input.fill('inspect screenshot');
  await conversation.locator('#mobile-conversation-send').click();
  await expect.poll(() => mobileInputs).toContainEqual(expect.objectContaining({
    text: 'inspect screenshot', attachmentIds: ['11111111-1111-4111-8111-111111111111'],
  }));

  // Match the 576x1024 CSS viewport of a 2x 1152x2048 phone capture. A tall
  // viewport previously let the flexing interaction dock create a huge blank
  // area above permission and question cards.
  await page.setViewportSize({ width: 576, height: 1024 });
  const permissionItem = {
    id: 'permission-77', type: 'permission', permissionId: '77',
    title: 'Extract frames from recording',
    text: JSON.stringify({
      variant: 'Bash',
      command: `mkdir -p /tmp/mov-frames && ffmpeg -y -i /tmp/recording.mov -vf "fps=1" /tmp/mov-frames/frame-%02d.png 2>&1 | tail -20 && ls -la /tmp/mov-frames/${' output'.repeat(18)}`,
      description: 'Extract 1fps frames from recording',
    }, null, 2),
    status: 'pending',
    options: [
      { id: 'allow_once', label: 'Allow once', kind: 'allow_once' },
      { id: 'reject_once', label: 'Reject', kind: 'reject_once' },
      { id: 'allow_always', label: 'Always allow', kind: 'allow_always' },
    ],
  };
  rootItems.push(permissionItem);
  await expect.poll(() => page.evaluate(() => window.__conversationStreams.length)).toBeGreaterThan(0);
  await page.evaluate((nextConversation) => {
    window.__conversationStreams.at(-1).emit('conversation', {
      data: JSON.stringify({ conversation: nextConversation }),
    });
  }, rootConversation());
  const interactionDock = conversation.locator('#mobile-conversation-interaction');
  await expect(interactionDock).toBeVisible();
  await expect(interactionDock).toHaveAttribute('data-kind', 'permission');
  await expect.poll(() => interactionDock.evaluate((node) => node.scrollHeight <= node.clientHeight + 1)).toBe(true);
  await expect.poll(() => interactionDock.evaluate((node) => {
    const card = node.firstElementChild;
    return card ? Math.round(node.getBoundingClientRect().height - card.getBoundingClientRect().height) : Infinity;
  })).toBeLessThanOrEqual(22);
  const permissionDetails = interactionDock.locator('.mobile-permission-details');
  await expect(permissionDetails).toHaveAttribute('open', '');
  await expect(permissionDetails.getByText('Command details')).toBeVisible();
  await expect.poll(() => permissionDetails.locator('pre').evaluate(
    (node) => node.scrollHeight > node.clientHeight,
  )).toBe(true);
  const permissionButtons = interactionDock.locator('.mobile-permission-actions button');
  await expect(permissionButtons).toHaveCount(3);
  const permissionDensity = await interactionDock.locator('.mobile-interaction-card').evaluate((card) => {
    const styles = getComputedStyle(card);
    const button = card.querySelector('.mobile-permission-actions button').getBoundingClientRect();
    return {
      padding: parseFloat(styles.paddingTop),
      gap: parseFloat(styles.rowGap),
      buttonHeight: button.height,
    };
  });
  expect(permissionDensity.padding).toBeLessThanOrEqual(12);
  expect(permissionDensity.gap).toBeLessThanOrEqual(10);
  expect(permissionDensity.buttonHeight).toBeLessThanOrEqual(40);
  const permissionHierarchy = await interactionDock.locator('.mobile-interaction-card').evaluate((card) => {
    const cardStyle = getComputedStyle(card);
    const detailsStyle = getComputedStyle(card.querySelector('.mobile-permission-details'));
    const firstActionStyle = getComputedStyle(card.querySelector('.mobile-permission-actions button'));
    return {
      cardBorder: cardStyle.borderTopWidth,
      cardBackground: cardStyle.backgroundColor,
      detailsBorderLeft: detailsStyle.borderLeftWidth,
      detailsBorderTop: detailsStyle.borderTopWidth,
      detailsBorderRadius: detailsStyle.borderRadius,
      actionBorderLeft: firstActionStyle.borderLeftWidth,
      actionBorderTop: firstActionStyle.borderTopWidth,
      actionBorderBottom: firstActionStyle.borderBottomWidth,
      actionBorderRadius: firstActionStyle.borderRadius,
      actionBackground: firstActionStyle.backgroundColor,
    };
  });
  expect(permissionHierarchy).toEqual({
    cardBorder: '0px',
    cardBackground: 'rgba(0, 0, 0, 0)',
    detailsBorderLeft: '0px',
    detailsBorderTop: '1px',
    detailsBorderRadius: '0px',
    actionBorderLeft: '0px',
    actionBorderTop: '0px',
    actionBorderBottom: '1px',
    actionBorderRadius: '0px',
    actionBackground: 'rgba(0, 0, 0, 0)',
  });
  await expect(interactionDock.locator('.mobile-question-header small')).toHaveCount(0);
  const permissionTypography = await interactionDock.locator('.mobile-interaction-card').evaluate((card) => ({
    title: getComputedStyle(card.querySelector('.mobile-question-header strong')).fontSize,
    status: getComputedStyle(card.querySelector('.mobile-question-status')).fontSize,
    control: getComputedStyle(card.querySelector('.mobile-permission-actions strong')).fontSize,
    caption: getComputedStyle(card.querySelector('.mobile-permission-actions small')).fontSize,
  }));
  expect(permissionTypography).toEqual({
    title: '14px', status: '10px', control: '12.5px', caption: '9.5px',
  });
  const permissionButtonBoxes = await permissionButtons.evaluateAll((buttons) => buttons.map((button) => {
    const box = button.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width };
  }));
  expect(permissionButtonBoxes[0].y).toBeLessThan(permissionButtonBoxes[1].y);
  expect(permissionButtonBoxes[1].y).toBeLessThan(permissionButtonBoxes[2].y);
  expect(Math.max(...permissionButtonBoxes.map(({ width }) => width)) -
    Math.min(...permissionButtonBoxes.map(({ width }) => width))).toBeLessThan(1);
  expect(Math.max(...permissionButtonBoxes.map(({ x }) => x)) -
    Math.min(...permissionButtonBoxes.map(({ x }) => x))).toBeLessThan(1);
  await page.mouse.move(1, 1);
  await page.waitForTimeout(220);
  const permissionColors = await permissionButtons.evaluateAll((buttons) => buttons.map((button) => ({
    background: getComputedStyle(button).backgroundColor,
    color: getComputedStyle(button).color,
  })));
  expect(new Set(permissionColors.map(({ background }) => background)).size).toBe(1);
  expect(new Set(permissionColors.map(({ color }) => color)).size).toBe(1);
  const permissionRestStyle = await permissionButtons.first().evaluate((button) => ({
    background: getComputedStyle(button).backgroundColor,
    border: getComputedStyle(button).borderColor,
    color: getComputedStyle(button).color,
  }));
  await permissionButtons.first().hover();
  expect(await permissionButtons.first().evaluate((button) =>
    getComputedStyle(button).borderColor)).toBe(permissionRestStyle.border);
  await expect.poll(() => permissionButtons.first().evaluate((button) =>
    getComputedStyle(button).color)).not.toBe(permissionRestStyle.color);
  expect(await permissionButtons.first().evaluate((button) =>
    getComputedStyle(button).backgroundColor)).toBe(permissionRestStyle.background);
  await expect(conversation.locator('#mobile-conversation-composer')).toBeHidden();
  await expect(conversation.locator('.mobile-subagent-pill-host')).toBeHidden();
  await expect(conversation.locator('#mobile-conversation-messages [data-permission-id="77"]')).toHaveCount(0);
  await conversation.getByRole('button', { name: 'Allow once' }).click();
  await expect.poll(() => permissionResponses).toContainEqual({ permissionId: '77', optionId: 'allow_once' });
  permissionItem.status = 'completed';
  permissionItem.selectedLabel = 'Approved in Grok';
  permissionItem.resolvedBy = 'grok';
  await page.evaluate((nextConversation) => {
    window.__conversationStreams.at(-1).emit('conversation', {
      data: JSON.stringify({ conversation: nextConversation }),
    });
  }, rootConversation());
  await expect(conversation.getByRole('button', { name: 'Allow once' })).toHaveCount(0);
  await expect(conversation.locator('#mobile-conversation-messages [data-permission-id="77"]')).toHaveCount(0);
  await expect(conversation.locator('.mobile-permission-result')).toHaveCount(0);
  await expect(interactionDock).toBeHidden();
  await expect(conversation.locator('#mobile-conversation-composer')).toBeVisible();

  const questionItem = {
    id: 'question-tool-99', type: 'question', questionId: 'question-99', threadId: 'root-thread',
    title: 'A few choices before I continue', status: 'pending', questions: [
      { question: 'Which release should I prepare?', multiSelect: false, options: [
        { label: 'Preview deployment', description: 'Ship to the preview environment.', preview: 'preview.example.test' },
        { label: 'Production deployment', description: 'Release directly to customers.' },
      ] },
      { question: 'Which checks should run?', multiSelect: true, options: [
        { label: 'Unit tests', description: 'Fast local verification.' },
        { label: 'End-to-end tests', description: 'Exercise the browser flow.' },
      ] },
    ],
  };
  rootItems.push(questionItem);
  await page.evaluate((nextConversation) => {
    window.__conversationStreams.at(-1).emit('conversation', {
      data: JSON.stringify({ conversation: nextConversation }),
    });
  }, rootConversation());
  const questionCard = conversation.locator('[data-question-id="question-99"]');
  await expect(questionCard).toHaveCount(1);
  await expect(interactionDock).toHaveAttribute('data-kind', 'question');
  await expect.poll(() => interactionDock.evaluate((node) => node.scrollHeight <= node.clientHeight + 1)).toBe(true);
  await expect.poll(() => interactionDock.evaluate((node) => {
    const card = node.firstElementChild;
    return card ? Math.round(node.getBoundingClientRect().height - card.getBoundingClientRect().height) : Infinity;
  })).toBeLessThanOrEqual(22);
  await expect.poll(() => questionCard.evaluate((node) => node.scrollHeight <= node.clientHeight + 1)).toBe(true);
  await expect(interactionDock.locator('[data-question-id="question-99"]')).toHaveCount(1);
  await expect(conversation.locator('#mobile-conversation-composer')).toBeHidden();
  await expect(conversation.locator('#mobile-conversation-messages [data-question-id="question-99"]')).toHaveCount(0);
  await expect(questionCard.getByText('Question 1 of 2')).toBeVisible();
  const questionDensity = await questionCard.evaluate((card) => {
    const styles = getComputedStyle(card);
    const optionStyles = getComputedStyle(card.querySelector('.mobile-question-option'));
    const action = card.querySelector('.mobile-question-actions button').getBoundingClientRect();
    const live = card.querySelector('.mobile-question-live');
    return {
      padding: parseFloat(styles.paddingTop),
      gap: parseFloat(styles.rowGap),
      optionPadding: parseFloat(optionStyles.paddingTop),
      optionMinHeight: parseFloat(optionStyles.minHeight),
      actionHeight: action.height,
      emptyLiveDisplay: getComputedStyle(live).display,
    };
  });
  expect(questionDensity.padding).toBeLessThanOrEqual(12);
  expect(questionDensity.gap).toBeLessThanOrEqual(10);
  expect(questionDensity.optionPadding).toBeLessThanOrEqual(8);
  expect(questionDensity.optionMinHeight).toBeLessThanOrEqual(44);
  expect(questionDensity.actionHeight).toBeLessThanOrEqual(34);
  expect(questionDensity.emptyLiveDisplay).toBe('none');
  const questionHierarchy = await questionCard.evaluate((card) => {
    const cardStyle = getComputedStyle(card);
    const options = card.querySelector('.mobile-question-options');
    const optionStyles = [...card.querySelectorAll('.mobile-question-option')]
      .map((option) => getComputedStyle(option));
    return {
      cardBorder: cardStyle.borderTopWidth,
      cardRadius: cardStyle.borderRadius,
      cardBackground: cardStyle.backgroundColor,
      optionsBorderTop: getComputedStyle(options).borderTopWidth,
      optionsMarginTop: parseFloat(getComputedStyle(options).marginTop),
      optionBorders: optionStyles.map((style) => ({
        left: style.borderLeftWidth,
        top: style.borderTopWidth,
        bottom: style.borderBottomWidth,
      })),
      optionRadius: optionStyles[0].borderRadius,
      optionBackground: optionStyles[0].backgroundColor,
    };
  });
  expect(questionHierarchy).toEqual({
    cardBorder: '0px',
    cardRadius: '0px',
    cardBackground: 'rgba(0, 0, 0, 0)',
    optionsBorderTop: '0px',
    optionsMarginTop: 8,
    optionBorders: [
      { left: '0px', top: '0px', bottom: '0px' },
      { left: '0px', top: '1px', bottom: '0px' },
      { left: '0px', top: '1px', bottom: '0px' },
    ],
    optionRadius: '0px',
    optionBackground: 'rgba(0, 0, 0, 0)',
  });
  await expect(questionCard.locator('.mobile-question-header small')).toHaveCount(0);
  const questionTypography = await questionCard.evaluate((card) => ({
    title: getComputedStyle(card.querySelector('.mobile-question-header strong')).fontSize,
    status: getComputedStyle(card.querySelector('.mobile-question-status')).fontSize,
    control: getComputedStyle(card.querySelector('.mobile-question-option strong')).fontSize,
    caption: getComputedStyle(card.querySelector('.mobile-question-option small')).fontSize,
  }));
  expect(questionTypography).toEqual({ title: '14px', status: '10px', control: '13px', caption: '11px' });
  await expect(questionCard.getByRole('group')).toHaveCount(1);
  const nextButton = questionCard.getByRole('button', { name: 'Next' });
  await expect(nextButton).toBeDisabled();
  await expect(questionCard.getByRole('button', { name: 'Back' })).toBeHidden();
  const previewOption = questionCard.getByRole('radio', { name: /Preview deployment/ });
  const previewLabel = previewOption.locator('xpath=ancestor::label');
  const previewBackground = await previewLabel.evaluate((label) => getComputedStyle(label).backgroundColor);
  await previewLabel.hover();
  expect(await previewLabel.evaluate((label) => getComputedStyle(label).backgroundColor)).toBe(previewBackground);
  await previewOption.check();
  expect(await previewLabel.evaluate((label) => getComputedStyle(label).backgroundColor)).toBe(previewBackground);
  const questionActionBackgrounds = await questionCard.locator('.mobile-question-actions button').evaluateAll(
    (buttons) => buttons.map((button) => getComputedStyle(button).backgroundColor),
  );
  expect(new Set(questionActionBackgrounds)).toEqual(new Set(['rgba(0, 0, 0, 0)']));
  await expect.poll(() => questionCard.locator('.mobile-question-actions button').evaluateAll(
    (buttons) => buttons.every((button) => getComputedStyle(button).borderTopWidth === '0px'),
  )).toBe(true);
  await expect(nextButton).toBeEnabled();
  await expect(input).not.toBeFocused();
  await nextButton.click();
  await expect(questionCard.getByText('Question 2 of 2')).toBeVisible();
  await expect(questionCard.getByRole('group')).toHaveCount(1);
  await expect(questionCard.getByRole('radio', { name: /Preview deployment/ })).toHaveCount(0);
  await expect(questionCard.getByRole('button', { name: 'Back' })).toBeVisible();
  const continueButton = questionCard.getByRole('button', { name: 'Continue' });
  await expect(continueButton).toBeDisabled();
  await questionCard.getByRole('checkbox', { name: /Unit tests/ }).check();
  const otherAnswer = questionCard.getByRole('textbox', { name: /Other answer/ });
  expect(await otherAnswer.evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      borderLeft: style.borderLeftWidth,
      borderTop: style.borderTopWidth,
      borderRight: style.borderRightWidth,
      borderBottom: style.borderBottomWidth,
      borderRadius: style.borderRadius,
      background: style.backgroundColor,
    };
  })).toEqual({
    borderLeft: '0px',
    borderTop: '0px',
    borderRight: '0px',
    borderBottom: '1px',
    borderRadius: '0px',
    background: 'rgba(0, 0, 0, 0)',
  });
  await otherAnswer.click();
  await expect.poll(() => questionCard.locator('.mobile-question-other').evaluate((label) => {
    const control = label.querySelector('input[type="checkbox"]')?.getBoundingClientRect();
    const copy = label.querySelector(':scope > span')?.getBoundingClientRect();
    return control && copy ? Math.abs(control.top - copy.top) <= 3 : false;
  })).toBe(true);
  await otherAnswer.pressSequentially('Custom');
  await otherAnswer.evaluate((node) => { node.dataset.focusProbe = 'stable'; });
  await page.evaluate((nextConversation) => {
    window.__conversationStreams.at(-1).emit('conversation', {
      data: JSON.stringify({ conversation: nextConversation }),
    });
  }, rootConversation());
  await expect(otherAnswer).toBeFocused();
  await expect(otherAnswer).toHaveAttribute('data-focus-probe', 'stable');
  await otherAnswer.pressSequentially(' integration check');
  await expect(continueButton).toBeEnabled();
  await page.evaluate((nextConversation) => {
    window.__conversationStreams.at(-1).emit('conversation', {
      data: JSON.stringify({ conversation: nextConversation }),
    });
  }, rootConversation());
  await expect(questionCard.getByRole('checkbox', { name: /Unit tests/ })).toBeChecked();
  await expect(questionCard.locator('.mobile-question-other input[type="checkbox"]')).toBeChecked();
  await expect(questionCard.getByRole('textbox', { name: /Other answer/ })).toHaveValue('Custom integration check');
  await questionCard.getByRole('button', { name: 'Back' }).click();
  await expect(questionCard.getByText('Question 1 of 2')).toBeVisible();
  await expect(questionCard.getByRole('radio', { name: /Preview deployment/ })).toBeChecked();
  await questionCard.getByRole('button', { name: 'Next' }).click();
  await expect(questionCard.getByText('Question 2 of 2')).toBeVisible();
  await expect(questionCard.getByRole('checkbox', { name: /Unit tests/ })).toBeChecked();
  await expect(questionCard.locator('.mobile-question-other input[type="checkbox"]')).toBeChecked();
  await expect(questionCard.getByRole('textbox', { name: /Other answer/ })).toHaveValue('Custom integration check');
  await continueButton.click();
  await expect(questionCard.getByRole('button', { name: 'Continue' })).toBeDisabled();
  await expect(questionCard.getByRole('button', { name: 'Back' })).toBeDisabled();
  await expect.poll(() => questionResponses).toEqual([{
    threadId: 'root-thread', questionId: 'question-99', outcome: 'accepted',
    answers: {
      'Which release should I prepare?': 'Preview deployment',
      'Which checks should run?': 'Unit tests, Custom integration check',
    },
  }]);
  await expect(page.locator('#terminal')).toBeHidden();
  expect(await page.evaluate(() => Boolean(document.activeElement?.closest('#terminal')))).toBe(false);
  releaseFirstQuestion();
  await expect(questionCard.getByText(/Question transport unavailable/)).toBeVisible();
  await expect(questionCard.getByText('Question 2 of 2')).toBeVisible();
  await expect(questionCard.getByRole('checkbox', { name: /Unit tests/ })).toBeChecked();
  await expect(questionCard.getByRole('textbox', { name: /Other answer/ })).toHaveValue('Custom integration check');
  await expect(questionCard.getByRole('button', { name: 'Try again' })).toBeEnabled();
  await questionCard.getByRole('button', { name: 'Try again' }).click();
  await expect.poll(() => questionResponses).toHaveLength(2);
  await expect(questionCard.getByRole('button', { name: 'Continue' })).toBeDisabled();
  questionItem.status = 'completed';
  questionItem.answers = {
    'Which release should I prepare?': 'Preview deployment',
    'Which checks should run?': 'Unit tests, Custom integration check',
  };
  await page.evaluate((nextConversation) => {
    window.__conversationStreams.at(-1).emit('conversation', {
      data: JSON.stringify({ conversation: nextConversation }),
    });
  }, rootConversation());
  await expect(interactionDock).toBeHidden();
  await expect(conversation.locator('#mobile-conversation-messages [data-question-id="question-99"]')).toHaveCount(0);
  await expect(conversation.locator('#mobile-conversation-composer')).toBeVisible();

  const skipQuestionItem = {
    id: 'question-tool-skip', type: 'question', questionId: 'question-skip', threadId: 'root-thread',
    title: 'One last question', status: 'pending', questions: [{
      question: 'Continue without changing defaults?', multiSelect: false,
      options: [{ label: 'Keep defaults', description: 'Use the current settings.' }],
    }],
  };
  rootItems.push(skipQuestionItem);
  await page.evaluate((nextConversation) => {
    window.__conversationStreams.at(-1).emit('conversation', {
      data: JSON.stringify({ conversation: nextConversation }),
    });
  }, rootConversation());
  const skipCard = conversation.locator('[data-question-id="question-skip"]');
  await expect(skipCard.getByText('Question 1 of 1')).toBeVisible();
  await expect(skipCard.getByRole('button', { name: 'Back' })).toBeHidden();
  await expect(skipCard.getByRole('button', { name: 'Continue' })).toBeDisabled();
  await skipCard.getByRole('radio', { name: /Keep defaults/ }).check();
  await expect(skipCard.getByRole('button', { name: 'Continue' })).toBeEnabled();
  await skipCard.getByRole('button', { name: 'Skip' }).click();
  await expect.poll(() => questionResponses.at(-1)).toEqual({
    threadId: 'root-thread', questionId: 'question-skip', outcome: 'skip_interview',
  });
  skipQuestionItem.status = 'completed';
  skipQuestionItem.outcome = 'skip_interview';
  await page.evaluate((nextConversation) => {
    window.__conversationStreams.at(-1).emit('conversation', {
      data: JSON.stringify({ conversation: nextConversation }),
    });
  }, rootConversation());
  await expect(interactionDock).toBeHidden();
  await expect(conversation.locator('#mobile-conversation-messages [data-question-id="question-skip"]')).toHaveCount(0);
  await expect(conversation.locator('#mobile-conversation-composer')).toBeVisible();

  const planReviewItem = {
    id: 'plan-review-exit-plan-1', type: 'plan_review', reviewId: 'exit-plan-1',
    threadId: 'root-thread', status: 'pending',
    planContent: '# Implementation plan\n\n1. Inspect the current provider\n2. Add the plan review flow\n3. Verify it on mobile',
  };
  rootItems.push(planReviewItem);
  await page.evaluate((nextConversation) => {
    window.__conversationStreams.at(-1).emit('conversation', {
      data: JSON.stringify({ conversation: nextConversation }),
    });
  }, rootConversation());
  await expect(interactionDock).toHaveAttribute('data-kind', 'plan_review');
  await expect(conversation.locator('#mobile-conversation-composer')).toBeHidden();
  const review = interactionDock.locator('[data-review-id="exit-plan-1"]');
  await expect(review.getByText('Review plan.md')).toBeVisible();
  await expect(review.locator('.mobile-plan-line')).toHaveCount(5);
  await review.locator('.mobile-plan-line[data-line="3"]').click();
  await review.locator('.mobile-plan-line[data-line="4"]').click();
  await expect(review.locator('.mobile-plan-line[aria-selected="true"]')).toHaveCount(2);
  await review.getByRole('textbox', { name: 'Comment on line 3–4' }).fill('Keep these steps explicit and explain the order.');
  await review.getByRole('button', { name: 'Add comment' }).click();
  await expect(review.getByText('Lines 3–4')).toBeVisible();
  await review.getByRole('textbox', { name: 'Additional plan feedback' }).fill('Add a rollback check.');
  await review.getByRole('button', { name: /Request changes/ }).click();
  await expect.poll(() => planReviewResponses.at(-1)).toEqual({
    threadId: 'root-thread', reviewId: 'exit-plan-1', outcome: 'cancelled',
    feedback: [
      'The user wants to revise the plan. The user said:',
      '@plan.md:3-4',
      'Keep these steps explicit and explain the order.',
      '',
      'Add a rollback check.',
    ].join('\n'),
  });
  planReviewItem.status = 'completed';
  planReviewItem.outcome = 'cancelled';
  await page.evaluate((nextConversation) => {
    window.__conversationStreams.at(-1).emit('conversation', {
      data: JSON.stringify({ conversation: nextConversation }),
    });
  }, rootConversation());
  await expect(interactionDock).toBeHidden();

  const revisedPlan = {
    ...planReviewItem, id: 'plan-review-exit-plan-2', reviewId: 'exit-plan-2',
    status: 'pending', outcome: undefined, planContent: '# Revised plan\n\n1. Implement\n2. Verify\n3. Roll back if needed',
  };
  rootItems.push(revisedPlan);
  await page.evaluate((nextConversation) => {
    window.__conversationStreams.at(-1).emit('conversation', {
      data: JSON.stringify({ conversation: nextConversation }),
    });
  }, rootConversation());
  await interactionDock.getByRole('button', { name: /Approve plan/ }).click();
  await expect.poll(() => planReviewResponses.at(-1)).toEqual({
    threadId: 'root-thread', reviewId: 'exit-plan-2', outcome: 'approved',
  });
  revisedPlan.status = 'completed';
  revisedPlan.outcome = 'approved';
  await page.evaluate((nextConversation) => {
    window.__conversationStreams.at(-1).emit('conversation', {
      data: JSON.stringify({ conversation: nextConversation }),
    });
  }, rootConversation());
  await expect(interactionDock).toBeHidden();
  await expect(conversation.locator('#mobile-conversation-composer')).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await conversation.locator('.mobile-subagent-pill').click();
  const sheet = conversation.locator('.mobile-subagent-sheet');
  const sheetPanel = sheet.locator('.mobile-subagent-sheet-panel');
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Close activity', exact: true })).toHaveClass(/ui-icon-button/);
  await expect(sheet.getByRole('button', { name: 'Close activity', exact: true })).toHaveAttribute('data-ui-variant', 'bare');
  await expect.poll(() => sheet.evaluate((node) => ({
    list: getComputedStyle(node.querySelector('.mobile-subagent-list'), '::-webkit-scrollbar').display,
    messages: getComputedStyle(node.querySelector('.mobile-subagent-sheet-messages'), '::-webkit-scrollbar').display,
  }))).toEqual({ list: 'none', messages: 'none' });
  await expect(sheet.locator('.mobile-subagent-list-loading')).toHaveCount(0);
  await expect(sheetPanel).toHaveCSS('transition-property', /height/);
  await expect(sheetPanel).not.toHaveAttribute('data-expanding', 'true');
  const openingSheetHeight = (await sheetPanel.boundingBox()).height;
  await sheetPanel.evaluate((node) => Promise.all(node.getAnimations().map((animation) => animation.finished)));
  await expect.poll(() => sheetPanel.evaluate((node) => node.getBoundingClientRect().height))
    .toBeCloseTo(openingSheetHeight, 0);
  await expect(sheet.getByRole('button', { name: /Inspect mobile behavior/ })).toContainText('Done');
  await expect(sheet.getByRole('button', { name: /Review the test coverage/ })).toContainText('In progress');
  const listSheetHeight = (await sheetPanel.boundingBox()).height;
  await sheet.getByRole('button', { name: /Inspect mobile behavior/ }).click();
  await expect(sheet.locator('.mobile-subagent-child-loading')).toHaveCount(0);
  await expect(sheet.locator('.mobile-subagent-sheet-messages')).toBeEmpty();
  await expect(sheetPanel).toHaveAttribute('data-navigating', 'true');
  await expect.poll(() => sheetPanel.evaluate((panel) => panel.getBoundingClientRect().height))
    .toBeGreaterThan(listSheetHeight + 20);
  await expect.poll(() => Boolean(releaseFirstChildRead)).toBe(true);
  releaseFirstChildRead();
  await expect(sheet.locator('.mobile-subagent-sheet-header strong')).toHaveText('Inspect mobile behavior');
  await expect(sheet.locator('.mobile-subagent-sheet-header small')).toHaveText('explore · read-only');
  await expect(sheet.locator('.mobile-subagent-sheet-state')).toHaveText('Done');
  await expect(sheet.locator('.mobile-subagent-list')).toBeHidden();
  await expect.poll(() => sheetPanel.evaluate((panel) =>
    Math.abs(panel.getBoundingClientRect().height - innerHeight * 0.9))).toBeLessThanOrEqual(2);
  await expect(sheet.getByText('Subagent findings')).toBeVisible();
  await page.evaluate((nextConversation) => {
    window.__conversationStreams.at(-1).emit('conversation', {
      data: JSON.stringify({ conversation: nextConversation }),
    });
  }, childConversation('Subagent findings, streamed live'));
  await expect(sheet.getByText('Subagent findings, streamed live')).toBeVisible();
  await expect(sheet.locator('.mobile-event-thought')).toHaveCount(1);
  await expect(sheet.locator('.mobile-event-tool')).toHaveCount(1);
  await expect(conversation.locator('#mobile-conversation-composer')).toBeVisible();
  const childSheetHeight = (await sheetPanel.boundingBox()).height;
  await sheet.getByRole('button', { name: 'Back to subagent list' }).click();
  await expect(sheetPanel).toHaveAttribute('data-navigating', 'true');
  await expect.poll(() => sheetPanel.evaluate((panel) => panel.getBoundingClientRect().height))
    .toBeLessThan(childSheetHeight - 20);
  await expect(sheet.getByRole('button', { name: /Review the test coverage/ })).toBeVisible();
  await sheet.getByRole('button', { name: /Review the test coverage/ }).click();
  await expect(sheet.getByText('Second subagent findings')).toBeVisible();
  await sheet.getByRole('button', { name: 'Close activity', exact: true }).click();
  await expect(sheet).toBeHidden();
  await expect(conversation.locator('.mobile-subagent-pill-host')).toBeHidden();
  await expect.poll(() => page.evaluate((name) => Boolean(
    localStorage.getItem(`agent-remote:mobile-activity-dismissed:${encodeURIComponent(name)}`),
  ), sessionName)).toBe(true);
  await expect.poll(() => page.evaluate(() => (
    new URL(window.__conversationStreams.at(-1).url).searchParams.get('thread')
  ))).toBe('root-thread');
  rootItems.push({
    id: 'subagent-call-spawn-new', type: 'subagent', title: 'New persisted event',
    role: 'explore', phase: 'calling', status: 'working',
  });
  await page.evaluate((nextConversation) => {
    window.__conversationStreams.at(-1).emit('conversation', {
      data: JSON.stringify({ conversation: nextConversation }),
    });
  }, rootConversation());
  await expect(conversation.locator('.mobile-subagent-pill-host')).toBeVisible();
  await expect.poll(() => page.evaluate((name) => (
    localStorage.getItem(`agent-remote:mobile-activity-dismissed:${encodeURIComponent(name)}`)
  ), sessionName)).toBeNull();
  await conversation.locator('.mobile-subagent-pill').click();
  await expect(sheet.getByText('New persisted event')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(conversation.locator('#mobile-conversation-composer')).toBeVisible();
  await conversation.locator('.mobile-subagent-pill').click();
  await page.mouse.click(195, 120);
  await expect(sheet).toBeHidden();
  await conversation.locator('.mobile-subagent-pill').click();
  const handle = sheet.getByRole('button', { name: 'Drag down to close activity' });
  await handle.evaluate((node) => Promise.all(node.closest('.mobile-subagent-sheet-panel')
    .getAnimations().map((animation) => animation.finished)));
  const box = await handle.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 120, { steps: 4 });
  await page.mouse.up();
  await expect(sheet).toBeHidden();

  await expect(page.locator('#terminal')).toBeHidden();
  expect(sessionName).toMatch(/^ar-/);
});

test('owns the mobile surface from the first frame of a new Grok chat', async ({ page, request }) => {
  const created = await request.post('/api/projects', { data: {
    name: 'Mobile ACP startup', cwd: process.cwd(), agentId: 'fixture-grok-gate',
  } });
  expect(created.ok()).toBeTruthy();
  const { project } = await created.json();
  const session = {
    name: 'ar-mobile-acp-startup', label: 'New chat', command: 'grok --leader --session-id 01a015a9-61df-7052-a5d0-17de77a201fa',
    cwd: process.cwd(), projectId: project.id, autoTitle: true, managed: true,
  };
  // Model the real startup race: persisted session data already contains the
  // Grok command, while the agent catalog and ACP thread id have not hydrated.
  // The command itself must reserve the native surface before a terminal can
  // ever paint.
  await page.route('**/api/agents', (route) => route.fulfill({ json: { agents: [] } }));
  let createdSession = false;
  await page.route('**/api/sessions', (route) => route.fulfill({ json: {
    sessions: createdSession ? [session] : [],
  } }));
  await page.route(`**/api/projects/${project.id}/sessions`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 350));
    createdSession = true;
    return route.fulfill({ status: 201, json: { session } });
  });
  let conversationRequests = 0;
  await page.route('**/api/conversations/ar-mobile-acp-startup**', (route) => {
    conversationRequests += 1;
    if (conversationRequests === 1) return route.fulfill({ status: 404, json: {
      error: 'Provider is still attaching', code: 'CONVERSATION_UNAVAILABLE',
    } });
    return route.fulfill({ json: { conversation: {
      provider: { id: 'grok', label: 'Grok' },
      thread: { id: '01a015a9-61df-7052-a5d0-17de77a201fa', title: 'New Grok chat', agentName: 'build', status: 'idle' },
      items: [], children: [], parent: null, rootThreadId: '01a015a9-61df-7052-a5d0-17de77a201fa',
      capabilities: { send: true, children: false },
    } } });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    const state = { width: 390, height: 844, offsetTop: 0, offsetLeft: 0, scale: 1 };
    const visualViewport = new EventTarget();
    for (const property of Object.keys(state)) {
      Object.defineProperty(visualViewport, property, { get: () => state[property] });
    }
    window.__setStartupVisualViewport = (next) => {
      Object.assign(state, next);
      visualViewport.dispatchEvent(new Event('resize'));
      visualViewport.dispatchEvent(new Event('scroll'));
    };
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: visualViewport });
  });
  await page.reload();
  await page.evaluate(() => {
    window.__terminalVisibility = [];
    window.__terminalVisibilityTimer = setInterval(() => {
      const terminal = document.querySelector('#terminal');
      window.__terminalVisibility.push(!terminal.hidden && getComputedStyle(terminal).display !== 'none');
    }, 4);
  });
  await page.locator('#open-sidebar').click();
  const group = page.locator('.project-group').filter({ hasText: 'Mobile ACP startup' });
  await group.locator('.project-select').click();
  await group.getByRole('button', { name: 'New chat in Mobile ACP startup' }).click();
  await expect(page.locator('#mobile-conversation')).toBeVisible();
  const mobileLoading = page.locator('#mobile-conversation-boot');
  await expect(mobileLoading).toHaveAttribute('aria-label', 'Preparing chat');
  await expect(mobileLoading).toHaveText('');
  await expect(mobileLoading.locator('.chat-state-stack > *')).toHaveCount(1);
  const mobileLoadingIndicator = mobileLoading.locator('.chat-loading-indicator');
  await expect(mobileLoadingIndicator).toBeVisible();
  const [mobileScrollShellBox, mobileLoadingBox, mobileLoadingIndicatorBox] = await Promise.all([
    page.locator('.mobile-conversation-scroll-shell').boundingBox(),
    mobileLoading.boundingBox(),
    mobileLoadingIndicator.boundingBox(),
  ]);
  expect(Math.abs(
    (mobileLoadingBox.y + mobileLoadingBox.height / 2)
      - (mobileScrollShellBox.y + mobileScrollShellBox.height / 2),
  )).toBeLessThan(2);
  expect(Math.abs(mobileLoadingBox.height - mobileScrollShellBox.height)).toBeLessThan(2);
  expect(Math.abs(
    (mobileLoadingIndicatorBox.y + mobileLoadingIndicatorBox.height / 2)
      - (mobileLoadingBox.y + mobileLoadingBox.height / 2),
  )).toBeLessThan(2);
  await expect.poll(() => mobileLoadingIndicator.evaluate((indicator) => {
    const style = getComputedStyle(indicator);
    return {
      size: [style.width, style.height],
      animation: style.animationName,
      contrastingEdge: style.borderLeftColor !== style.borderTopColor,
    };
  })).toEqual({
    size: ['24px', '24px'],
    animation: 'session-spin',
    contrastingEdge: true,
  });
  await expect(page.locator('.mobile-conversation-header')).toBeVisible();
  await expect(page.locator('#mobile-conversation-menu')).toBeVisible();
  await expect(page.locator('#mobile-conversation-menu')).toHaveCSS('pointer-events', 'auto');
  await expect(page.locator('#mobile-conversation-composer')).toBeHidden();
  await expect(page.locator('#terminal')).toBeHidden();
  await expect(page.locator('#mobile-conversation-title')).toHaveText('New Grok chat');
  const emptyConversation = page.locator('.mobile-conversation-empty');
  await expect(emptyConversation.locator('.empty-orbit')).toBeVisible();
  await expect(emptyConversation.getByRole('heading', { name: 'What should we build next?' })).toBeVisible();
  await expect(emptyConversation).toContainText('Send a message below to start this chat.');
  await expect(emptyConversation).not.toContainText('No messages yet');
  const [messageViewportBox, emptyConversationBox] = await Promise.all([
    page.locator('#mobile-conversation-messages').boundingBox(),
    emptyConversation.boundingBox(),
  ]);
  expect(Math.abs(
    (emptyConversationBox.y + emptyConversationBox.height / 2)
      - (messageViewportBox.y + messageViewportBox.height / 2),
  )).toBeLessThan(5);
  expect(emptyConversationBox.height).toBeGreaterThan(messageViewportBox.height * .9);
  await expect.poll(() => page.locator('#mobile-conversation-messages').evaluate((node) => ({
    overflowY: getComputedStyle(node).overflowY,
    overflow: node.scrollHeight - node.clientHeight,
  }))).toEqual({ overflowY: 'hidden', overflow: 0 });
  const startupInput = page.locator('#mobile-conversation-input');
  await startupInput.click();
  await page.evaluate(() => window.__setStartupVisualViewport({ height: 510, offsetTop: 24 }));
  await expect.poll(() => page.locator('#mobile-conversation').evaluate((node) => {
    const bounds = node.getBoundingClientRect();
    const messages = node.querySelector('#mobile-conversation-messages');
    window.scrollTo(0, 80);
    return {
      root: [Math.round(bounds.top), Math.round(bounds.height)],
      documentScroll: document.scrollingElement.scrollTop,
      messageScroll: messages.scrollTop,
      messageOverflow: messages.scrollHeight - messages.clientHeight,
    };
  })).toEqual({
    root: [24, 510],
    documentScroll: 0,
    messageScroll: 0,
    messageOverflow: 0,
  });
  await expect(page.locator('#terminal')).toBeHidden();
  const terminalWasVisible = await page.evaluate(() => {
    clearInterval(window.__terminalVisibilityTimer);
    return window.__terminalVisibility.some(Boolean);
  });
  expect(terminalWasVisible).toBe(false);
});

test('organizes chats by project, titles the first prompt, and clears projects independently', async ({ page }) => {
  test.setTimeout(45_000);
  await expect(page.locator('#empty-title')).toHaveText('What should we build next?');
  const sidebarHeaderBox = await page.locator('.sidebar-header').boundingBox();
  const topbarBox = await page.locator('.topbar').boundingBox();
  const workspaceBox = await page.locator('.workspace').boundingBox();
  expect(workspaceBox.y + workspaceBox.height).toBe(page.viewportSize().height);
  expect(sidebarHeaderBox.height).toBe(topbarBox.height);
  expect(sidebarHeaderBox.y + sidebarHeaderBox.height).toBe(topbarBox.y + topbarBox.height);
  expect(sidebarHeaderBox.height).toBeGreaterThanOrEqual(32);
  expect(sidebarHeaderBox.height).toBeLessThanOrEqual(34);
  await expect(page.locator('.sidebar-header')).toHaveCSS('border-bottom-width', '0px');
  await expect(page.locator('.topbar')).toHaveCSS('border-bottom-width', '0px');
  const sidebarCollapse = page.locator('.sidebar-header #toggle-sidebar');
  await expect(sidebarCollapse).toBeVisible();
  await expect(sidebarCollapse).toHaveCSS('border-width', '0px');
  await expect(sidebarCollapse).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await sidebarCollapse.hover();
  await expect(sidebarCollapse).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(sidebarCollapse).toHaveCSS('color', 'rgb(192, 192, 196)');
  await expect(sidebarCollapse).toHaveCSS('transform', 'none');
  await expect(page.locator('.sidebar-section-header #home-button')).toHaveText('Projects');
  await expect(page.locator('#open-sidebar')).toBeHidden();

  await page.evaluate(() => {
    document.documentElement.dataset.desktopShell = 'tauri';
  });
  await sidebarCollapse.click();
  await expect(page.locator('.workspace')).toHaveAttribute('data-sidebar', 'collapsed');
  await expect(page.locator('#open-sidebar')).toBeVisible();
  const collapsedTauriHeader = await page.locator('.topbar').evaluate((topbar) => {
    const toggle = topbar.querySelector('#open-sidebar').getBoundingClientRect();
    return {
      paddingLeft: getComputedStyle(topbar).paddingLeft,
      toggleLeft: toggle.left,
    };
  });
  expect(collapsedTauriHeader.paddingLeft).toBe('70px');
  expect(collapsedTauriHeader.toggleLeft).toBeGreaterThanOrEqual(70);
  await page.locator('#open-sidebar').click();
  await expect(page.locator('.workspace')).toHaveAttribute('data-sidebar', 'expanded');
  await page.evaluate(() => {
    delete document.documentElement.dataset.desktopShell;
  });

  await page.locator('#new-project').hover();
  await expect(page.locator('#new-project')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(page.locator('#new-project')).toHaveCSS('color', 'rgb(222, 222, 224)');

  const fallbackProject = await createProject(page, { marker: '__FIRST_PROJECT__' });
  await expect(fallbackProject.locator('.project-name')).toHaveText(fallbackProjectName);
  await expect.poll(() => fallbackProject.locator('.session-row.active').evaluate((row) => ({
    backgroundFades: getComputedStyle(row, '::after').backgroundImage.includes('linear-gradient'),
    backgroundTransition: getComputedStyle(row, '::after').transitionProperty.includes('opacity'),
    outlineRemoved: getComputedStyle(row).boxShadow === 'none',
    accentFades: getComputedStyle(row.querySelector('.session-button'), '::before')
      .backgroundImage.includes('linear-gradient'),
    accentTransition: getComputedStyle(row.querySelector('.session-button'), '::before')
      .transitionProperty.includes('opacity'),
    accentWidth: getComputedStyle(row.querySelector('.session-button'), '::before').width,
  }))).toEqual({
    backgroundFades: true,
    backgroundTransition: true,
    outlineRemoved: true,
    accentFades: true,
    accentTransition: true,
    accentWidth: '2px',
  });
  const terminalTokens = await page.locator('#terminal').evaluate((terminal) => ({
    declaredBackground: getComputedStyle(document.documentElement)
      .getPropertyValue('--color-terminal-background').trim(),
    renderedBackground: getComputedStyle(terminal).backgroundColor,
    renderedFontSize: getComputedStyle(terminal.querySelector('.xterm-rows')).fontSize,
  }));
  expect(terminalTokens.declaredBackground).toBe('#141416');
  expect(terminalTokens.renderedBackground).toBe('rgb(20, 20, 22)');
  expect(terminalTokens.renderedFontSize).toBe('14px');
  await expect(page.locator('#terminal-title')).toBeHidden();
  await expect(page.locator('#status')).toBeHidden();

  // The startup cover intentionally keeps xterm unfocusable until the shell
  // has finished its initial paint and resize cycle.
  await expect(page.locator('#session-loading')).toBeHidden({ timeout: 3_000 });
  await page.locator('#terminal .xterm-helper-textarea').focus();
  await page.keyboard.type('Build a polished project dashboard');
  await page.keyboard.press('Enter');
  await expect(fallbackProject.locator('.session-name')).toHaveText('Build a polished project dashboard');
  await expect(page.locator('#terminal-title')).toBeHidden();

  const secondProject = await createProject(page, { name: 'Second project', marker: '__SECOND_PROJECT__' });
  await expect(secondProject.locator('.project-name')).toHaveText('Second project');
  const firstProject = page.locator('.project-group').filter({ hasText: fallbackProjectName });
  await expect(firstProject.locator('.session-row')).toHaveCount(1);
  await expect(secondProject.locator('.session-row')).toHaveCount(1);

  const firstChatList = firstProject.locator(':scope > .chat-list');
  const firstActions = firstProject.locator('.project-actions');
  const firstSessionRow = firstProject.locator('.session-row');
  const firstSessionClose = firstSessionRow.locator('.session-close');
  await firstSessionRow.hover();
  await expect(firstSessionRow).toHaveCSS('background-color', 'rgb(32, 32, 35)');
  await firstSessionClose.hover();
  await expect(firstSessionClose).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(firstSessionClose).toHaveCSS('color', 'rgb(219, 141, 148)');
  expect((await firstChatList.boundingBox()).height).toBeGreaterThan(25);
  await expect(firstActions).toHaveCSS('opacity', '0');
  await firstProject.locator('.project-header').hover();
  await page.waitForTimeout(350);
  expect((await firstChatList.boundingBox()).height).toBeGreaterThan(25);
  await expect(firstActions).toHaveCSS('opacity', '1');
  const firstNewChatAction = firstProject.getByRole('button', { name: `New chat in ${fallbackProjectName}` });
  await expect(firstNewChatAction.locator('svg')).toHaveCount(1);
  const firstActionGroupBox = await firstActions.boundingBox();
  expect(firstActionGroupBox.width).toBeLessThanOrEqual(94);
  await firstNewChatAction.hover();
  await expect(firstNewChatAction).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(firstNewChatAction).toHaveCSS('color', 'rgb(222, 222, 224)');
  await expect(firstProject.locator('.project-header')).toHaveCSS('background-color', 'rgb(36, 36, 39)');
  await firstProject.locator('.project-select').click();
  await page.waitForTimeout(350);
  expect((await firstChatList.boundingBox()).height).toBeLessThan(2);
  await firstProject.locator('.project-header').hover();
  await firstProject.locator('.project-select').click();
  await page.waitForTimeout(350);
  expect((await firstChatList.boundingBox()).height).toBeGreaterThan(25);
  await page.mouse.move(900, 500);
  await page.waitForTimeout(220);
  await expect(firstActions).toHaveCSS('opacity', '0');
  await firstProject.locator('.project-header').hover();
  await firstProject.locator('.project-select').click();
  await page.waitForTimeout(350);
  expect((await firstChatList.boundingBox()).height).toBeLessThan(2);
  await secondProject.locator('.project-header').hover();
  await secondProject.getByRole('button', { name: 'Edit Second project' }).click();
  await expect(page.locator('#create-dialog')).toBeVisible();
  await expect(page.locator('#clear-project-chats')).toHaveCount(0);
  await expect(page.locator('#delete-project')).toHaveCount(0);
  await page.locator('#create-dialog').getByRole('button', { name: 'Close' }).click();
  await secondProject.locator('.session-row').hover();
  await secondProject.locator('.session-close').click();
  await expect(secondProject.locator('.session-row')).toHaveCount(0);
  await expect(page.locator('#empty-state')).toBeVisible();
  await expect(page.locator('.project-group').filter({ hasText: fallbackProjectName }).locator('.session-row')).toHaveCount(1);

  await firstProject.locator('.project-select').click();
  await page.waitForTimeout(300);
  await firstProject.locator('.session-row').hover();
  const firstClose = page.locator('.project-group').filter({ hasText: fallbackProjectName }).locator('.session-close');
  await firstClose.click();
  await expect(page.locator('.project-group').locator('.session-row')).toHaveCount(0);
});

test('keeps expanded projects open while switching chats', async ({ page }) => {
  test.setTimeout(30_000);
  const firstProject = await createProject(page, { name: 'Pinned open A', marker: '__PINNED_A__' });
  const secondProject = await createProject(page, { name: 'Pinned open B', marker: '__PINNED_B__' });

  await expect(firstProject).toHaveClass(/\bexpanded\b/);
  await expect(secondProject).toHaveClass(/\bexpanded\b/);

  await firstProject.locator('.session-button').click();
  await expect(firstProject.locator('.session-row')).toHaveClass(/\bactive\b/);
  await expect(firstProject).toHaveClass(/\bexpanded\b/);
  await expect(secondProject).toHaveClass(/\bexpanded\b/);

  await secondProject.locator('.session-button').click();
  await expect(secondProject.locator('.session-row')).toHaveClass(/\bactive\b/);
  await expect(firstProject).toHaveClass(/\bexpanded\b/);
  await expect(secondProject).toHaveClass(/\bexpanded\b/);
});

test('keeps the current view and chat selected while editing another project', async ({ page }) => {
  test.setTimeout(30_000);
  const firstProject = await createProject(page, { name: 'Preserve A', marker: '__PRESERVE_A__' });
  const firstSession = await firstProject.locator('.session-row').getAttribute('data-session');
  const secondProject = await createProject(page, { name: 'Preserve B', marker: '__PRESERVE_B__' });
  const secondProjectId = await secondProject.getAttribute('data-project');

  await firstProject.locator('.session-button').click();
  await expect(firstProject.locator('.session-row')).toHaveClass(/\bactive\b/);
  await secondProject.locator('.project-header').hover();
  await secondProject.getByRole('button', { name: 'Edit Preserve B' }).click();
  await page.locator('#project-name').fill('Renamed B');
  await page.locator('#save-project').click();

  const renamedProject = page.locator(`.project-group[data-project="${secondProjectId}"]`);
  await expect(renamedProject.locator('.project-name')).toHaveText('Renamed B');
  await expect(page.locator(`.session-row[data-session="${firstSession}"]`)).toHaveClass(/\bactive\b/);
  await expect(page.locator('#terminal')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('agent-remote-session'))).toBe(firstSession);

  await page.locator('#home-button').click();
  await expect(page.locator('#empty-state')).toBeVisible();
  await renamedProject.locator('.project-header').hover();
  await renamedProject.getByRole('button', { name: 'Edit Renamed B' }).click();
  await page.locator('#project-name').fill('Renamed from home');
  await page.locator('#save-project').click();

  await expect(page.locator(`.project-group[data-project="${secondProjectId}"] .project-name`))
    .toHaveText('Renamed from home');
  await expect(page.locator('#empty-state')).toBeVisible();
  await expect(page.locator('#terminal')).toBeHidden();
  expect(await page.evaluate(() => ({
    project: localStorage.getItem('agent-remote-project'),
    session: localStorage.getItem('agent-remote-session'),
  }))).toEqual({ project: null, session: null });
});

test('keeps the terminal row remainder seamless while the window height changes', async ({ page }) => {
  test.setTimeout(30_000);
  await createProject(page, { name: 'Responsive', marker: '__HEIGHT_RESIZE__' });
  await expect(page.locator('#session-loading')).toBeHidden({ timeout: 8_000 });

  const desktopFrame = await page.evaluate(() => {
    const workspace = document.querySelector('.workspace').getBoundingClientRect();
    const shell = document.querySelector('.terminal-shell').getBoundingClientRect();
    const sidebar = document.querySelector('.sidebar').getBoundingClientRect();
    const sidebarHeader = document.querySelector('.sidebar-header').getBoundingClientRect();
    const topbar = document.querySelector('.topbar').getBoundingClientRect();
    const resizer = document.querySelector('.sidebar-resizer').getBoundingClientRect();
    const stage = document.querySelector('.terminal-stage').getBoundingClientRect();
    return {
      bodyPadding: getComputedStyle(document.body).padding,
      workspace: { top: workspace.top, right: workspace.right, bottom: workspace.bottom, left: workspace.left },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      shellBottom: shell.bottom,
      sidebarRight: sidebar.right,
      sidebarHeaderHeight: sidebarHeader.height,
      shellLeft: shell.left,
      resizer: { left: resizer.left, width: resizer.width },
      topbarHeight: topbar.height,
      stageHeight: stage.height,
      expectedStageHeight: shell.height - topbar.height,
    };
  });
  expect(desktopFrame.bodyPadding).toBe('0px');
  expect(desktopFrame.workspace).toEqual({
    top: 0,
    right: desktopFrame.viewport.width,
    bottom: desktopFrame.viewport.height,
    left: 0,
  });
  expect(desktopFrame.shellBottom).toBe(desktopFrame.viewport.height);
  expect(desktopFrame.shellLeft).toBe(desktopFrame.sidebarRight);
  expect(desktopFrame.resizer).toEqual({ left: desktopFrame.sidebarRight, width: 5 });
  expect(desktopFrame.topbarHeight).toBeLessThanOrEqual(34);
  expect(desktopFrame.sidebarHeaderHeight).toBe(desktopFrame.topbarHeight);
  expect(Math.abs(desktopFrame.stageHeight - desktopFrame.expectedStageHeight)).toBeLessThanOrEqual(1);

  const measureTerminal = async () => page.locator('#terminal').evaluate((terminal) => {
    const xterm = terminal.querySelector('.xterm');
    const viewport = terminal.querySelector('.xterm-viewport');
    const screen = terminal.querySelector('.xterm-screen');
    const rows = terminal.querySelector('.xterm-rows');
    const box = (node) => {
      const bounds = node.getBoundingClientRect();
      return { top: bounds.top, bottom: bounds.bottom, height: bounds.height };
    };
    return {
      terminal: box(terminal),
      xterm: box(xterm),
      viewport: box(viewport),
      screen: box(screen),
      viewportBackground: getComputedStyle(viewport).backgroundColor,
      terminalBackground: getComputedStyle(terminal).backgroundColor,
      rowFontSize: getComputedStyle(rows).fontSize,
    };
  });

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForTimeout(100);
  const tall = await measureTerminal();
  await page.setViewportSize({ width: 1280, height: 487 });
  await page.waitForTimeout(100);
  const short = await measureTerminal();

  expect(short.xterm.height).toBeLessThan(tall.xterm.height);
  expect(short.rowFontSize).toBe(tall.rowFontSize);
  expect(tall.viewportBackground).toBe(tall.terminalBackground);
  expect(short.viewportBackground).toBe(short.terminalBackground);
  expect(tall.viewport.bottom - tall.screen.bottom).toBeGreaterThanOrEqual(0);
  expect(short.viewport.bottom - short.screen.bottom).toBeGreaterThanOrEqual(0);
  expect(tall.terminal.bottom - tall.xterm.bottom).toBeLessThanOrEqual(13);
  expect(short.terminal.bottom - short.xterm.bottom).toBeLessThanOrEqual(13);
});

test('keeps empty projects lean, aligned, and responsive', async ({ page }) => {
  test.setTimeout(30_000);
  const project = await createProject(page, { name: 'Responsive', marker: '__RESPONSIVE__' });
  await project.locator('.session-row').hover();
  await project.locator('.session-close').click();
  const empty = project.locator('.project-empty');
  await expect(empty).toHaveText('No chats');
  await expect(empty).toBeVisible();

  const desktopMetrics = await project.evaluate((element) => {
    const name = element.querySelector('.project-name').getBoundingClientRect();
    const emptyState = element.querySelector('.project-empty').getBoundingClientRect();
    const iconElement = element.querySelector('.project-icon');
    const icon = iconElement.getBoundingClientRect();
    const iconTabTop = Number.parseFloat(getComputedStyle(iconElement, '::before').top);
    const select = element.querySelector('.project-select').getBoundingClientRect();
    return {
      emptyLeft: emptyState.left,
      emptyFont: Number.parseFloat(getComputedStyle(element.querySelector('.project-empty')).fontSize),
      iconHeight: icon.height,
      iconTextCenterDelta: Math.abs(((icon.top + iconTabTop + icon.bottom) / 2) - ((name.top + name.bottom) / 2)),
      iconWidth: icon.width,
      nameLeft: name.left,
      projectHeight: select.height,
    };
  });
  expect(Math.abs(desktopMetrics.emptyLeft - desktopMetrics.nameLeft)).toBeLessThanOrEqual(1);
  expect(desktopMetrics.emptyFont).toBeGreaterThanOrEqual(13.5);
  expect(desktopMetrics.iconWidth).toBeLessThanOrEqual(18);
  expect(desktopMetrics.iconHeight).toBeLessThanOrEqual(14);
  expect(desktopMetrics.iconTextCenterDelta).toBeLessThanOrEqual(1);
  expect(desktopMetrics.projectHeight).toBeLessThanOrEqual(44);

  await page.setViewportSize({ width: 740, height: 620 });
  await page.waitForTimeout(350);
  await expect(page.locator('.workspace')).toHaveAttribute('data-sidebar', 'collapsed');
  await expect(page.locator('#empty-state')).toBeVisible();
  const compactMainBeforeSidebar = await page.evaluate(() => {
    const shell = document.querySelector('.terminal-shell').getBoundingClientRect();
    const title = document.querySelector('#empty-title').getBoundingClientRect();
    return {
      shellWidth: shell.width,
      titleCenterDelta: Math.abs((title.left + title.width / 2) - (shell.left + shell.width / 2)),
    };
  });
  expect(compactMainBeforeSidebar.shellWidth).toBe(740);
  expect(compactMainBeforeSidebar.titleCenterDelta).toBeLessThanOrEqual(1);
  await page.locator('#open-sidebar').click();
  await expect(page.locator('.workspace')).toHaveAttribute('data-sidebar', 'expanded');
  await page.waitForTimeout(300);
  const compactMetrics = await project.evaluate((element) => {
    const name = element.querySelector('.project-name').getBoundingClientRect();
    const emptyState = element.querySelector('.project-empty').getBoundingClientRect();
    const sidebar = document.querySelector('.sidebar').getBoundingClientRect();
    return {
      emptyLeft: emptyState.left,
      emptyFont: Number.parseFloat(getComputedStyle(element.querySelector('.project-empty')).fontSize),
      headerHeight: document.querySelector('.topbar').getBoundingClientRect().height,
      nameLeft: name.left,
      projectHeight: element.querySelector('.project-select').getBoundingClientRect().height,
      sidebarWidth: sidebar.width,
      shellWidth: document.querySelector('.terminal-shell').getBoundingClientRect().width,
    };
  });
  expect(Math.abs(compactMetrics.emptyLeft - compactMetrics.nameLeft)).toBeLessThanOrEqual(1);
  expect(compactMetrics.emptyFont).toBeGreaterThanOrEqual(13.5);
  expect(compactMetrics.emptyFont).toBeGreaterThanOrEqual(desktopMetrics.emptyFont);
  expect(compactMetrics.emptyFont).toBeLessThanOrEqual(15);
  expect(compactMetrics.headerHeight).toBe(40);
  expect(compactMetrics.projectHeight).toBeLessThanOrEqual(40);
  expect(compactMetrics.sidebarWidth).toBeLessThanOrEqual(336);
  expect(compactMetrics.shellWidth).toBe(compactMainBeforeSidebar.shellWidth);
  await expect(page.locator('#empty-state')).toBeVisible();

  await page.setViewportSize({ width: 500, height: 700 });
  await page.waitForTimeout(350);
  await page.locator('#new-project').click();
  await expect(page.locator('#create-dialog')).toBeVisible();
  await page.waitForTimeout(500);
  const dialogBox = await page.locator('#create-dialog').boundingBox();
  expect(dialogBox.x).toBe(0);
  expect(dialogBox.width).toBe(500);
  expect(Math.abs(dialogBox.y - 140)).toBeLessThanOrEqual(1);
  expect(Math.abs(dialogBox.height - 560)).toBeLessThanOrEqual(1);
  expect(Math.abs(dialogBox.y + dialogBox.height - 700)).toBeLessThanOrEqual(1);
  await expect(page.locator('#create-dialog')).toHaveCSS('border-radius', '20px 20px 0px 0px');
  await expect(page.locator('#create-dialog')).toHaveClass(/\bmobile-sheet\b/);
  await expect(page.locator('#project-form')).toHaveClass(/\bmobile-sheet-panel\b/);
  await expect(page.locator('.project-sheet-header')).toHaveClass(/\bmobile-sheet-header\b/);
  await expect(page.locator('.project-sheet-body')).toHaveClass(/\bmobile-sheet-body\b/);
  await expect(page.locator('.project-sheet-footer')).toHaveClass(/\bmobile-sheet-footer\b/);
  await expect(page.locator('#project-sheet-handle')).toBeVisible();
  const projectSheetLayout = await page.locator('#create-dialog').evaluate((element) => {
    const body = element.querySelector('.project-sheet-body');
    const footer = element.querySelector('.project-sheet-footer');
    const bounds = element.getBoundingClientRect();
    const bodyBounds = body.getBoundingClientRect();
    const footerBounds = footer.getBoundingClientRect();
    const folderList = element.querySelector('.folder-list');
    return {
      background: getComputedStyle(element).backgroundColor,
      borderTopWidth: getComputedStyle(element).borderTopWidth,
      outlineStyle: getComputedStyle(element).outlineStyle,
      bodyOverflow: getComputedStyle(body).overflowY,
      bodyNeedsScroll: body.scrollHeight > body.clientHeight,
      bodyInside: bodyBounds.top >= bounds.top && bodyBounds.bottom <= bounds.bottom,
      folderListMinHeight: Number.parseFloat(getComputedStyle(folderList).minHeight),
      folderListUsesFlexibleRow: getComputedStyle(folderList).gridRowStart === '6',
      footerAtBottom: Math.abs(footerBounds.bottom - bounds.bottom) <= 1,
      saveHeight: element.querySelector('#save-project').getBoundingClientRect().height,
    };
  });
  expect(projectSheetLayout).toEqual({
    background: 'rgb(12, 12, 13)', borderTopWidth: '0px', outlineStyle: 'none', bodyOverflow: 'hidden',
    bodyNeedsScroll: false, bodyInside: true, folderListMinHeight: 120,
    folderListUsesFlexibleRow: true, footerAtBottom: true, saveHeight: 40,
  });
  const dialogTypography = await page.locator('#create-dialog').evaluate((element) => ({
    input: Number.parseFloat(getComputedStyle(element.querySelector('input')).fontSize),
    label: Number.parseFloat(getComputedStyle(element.querySelector('label')).fontSize),
    title: Number.parseFloat(getComputedStyle(element.querySelector('h2')).fontSize),
  }));
  expect(dialogTypography.input).toBeGreaterThanOrEqual(12);
  expect(dialogTypography.label).toBeGreaterThanOrEqual(12);
  expect(dialogTypography.title).toBeGreaterThanOrEqual(17);
  const projectSheetHandle = await page.locator('#project-sheet-handle').boundingBox();
  await page.mouse.move(projectSheetHandle.x + projectSheetHandle.width / 2, projectSheetHandle.y + 8);
  await page.mouse.down();
  await page.mouse.move(projectSheetHandle.x + projectSheetHandle.width / 2, projectSheetHandle.y + 90, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator('#create-dialog')).toBeHidden();
  await project.locator('.project-header').hover();
  await project.getByRole('button', { name: 'Edit Responsive' }).click();
  await expect(page.locator('#create-dialog')).toBeVisible();
  await expect(page.locator('#dialog-title')).toHaveText('Edit Responsive');
  const editSheetBox = await page.locator('#create-dialog').boundingBox();
  expect(Math.abs(editSheetBox.height - 560)).toBeLessThanOrEqual(1);
  await page.locator('#create-dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.waitForTimeout(350);
  await expect(page.locator('.workspace')).toHaveAttribute('data-sidebar', 'expanded');
});

test('restores persisted sidebar geometry before the first painted frame', async ({ page }) => {
  await page.evaluate(() => {
    localStorage.setItem('agent-remote-sidebar-width', '384');
    localStorage.setItem('agent-remote-sidebar-collapsed', 'false');
  });
  await page.addInitScript(() => {
    window.__expandedSidebarBootSamples = [];
    const sample = () => {
      const workspace = document.querySelector('.workspace');
      const sidebar = document.querySelector('.sidebar');
      const shell = document.querySelector('.terminal-shell');
      if (!workspace || !sidebar || !shell) return;
      const sidebarBounds = sidebar.getBoundingClientRect();
      const shellBounds = shell.getBoundingClientRect();
      window.__expandedSidebarBootSamples.push({
        state: workspace.dataset.sidebar,
        sidebarWidth: Math.round(sidebarBounds.width * 10) / 10,
        shellX: Math.round(shellBounds.x * 10) / 10,
      });
    };
    new MutationObserver(sample).observe(document, {
      attributes: true,
      childList: true,
      subtree: true,
      attributeFilter: ['data-sidebar', 'style'],
    });
    addEventListener('DOMContentLoaded', () => {
      const startedAt = performance.now();
      const sampleFrame = () => {
        sample();
        if (performance.now() - startedAt < 350) requestAnimationFrame(sampleFrame);
      };
      requestAnimationFrame(sampleFrame);
    }, { once: true });
  });

  await page.reload();
  await page.waitForTimeout(450);
  const samples = await page.evaluate(() => window.__expandedSidebarBootSamples);
  expect(samples.length).toBeGreaterThan(2);
  expect(samples.every((sample) => sample.state === 'expanded')).toBe(true);
  expect(samples.every((sample) => Math.abs(sample.sidebarWidth - 384) < 1)).toBe(true);
  expect(Math.max(...samples.map((sample) => sample.shellX)) -
    Math.min(...samples.map((sample) => sample.shellX))).toBeLessThan(1);
  await expect(page.locator('html')).not.toHaveAttribute('data-sidebar-booting', 'true');
});

test('keeps a persisted collapsed sidebar hidden while its workspace bootstrap is delayed', async ({ page }) => {
  await page.evaluate(() => {
    localStorage.setItem('agent-remote-sidebar-width', '384');
    localStorage.setItem('agent-remote-sidebar-collapsed', 'true');
  });
  await page.addInitScript(() => {
    window.__collapsedSidebarBootSamples = [];
    let sampleFrame;
    const sample = () => {
      if (sampleFrame) return;
      sampleFrame = requestAnimationFrame(() => {
        sampleFrame = undefined;
        const workspace = document.querySelector('.workspace');
        const sidebar = document.querySelector('.sidebar');
        const shell = document.querySelector('.terminal-shell');
        if (!workspace || !sidebar || !shell) return;
        const sidebarBounds = sidebar.getBoundingClientRect();
        const shellBounds = shell.getBoundingClientRect();
        window.__collapsedSidebarBootSamples.push({
          sidebarWidth: Math.round(sidebarBounds.width * 10) / 10,
          sidebarVisibility: getComputedStyle(sidebar).visibility,
          shellX: Math.round(shellBounds.x * 10) / 10,
        });
      });
    };
    new MutationObserver(sample).observe(document, {
      attributes: true,
      childList: true,
      subtree: true,
      attributeFilter: ['data-sidebar', 'style'],
    });
  });
  await page.route('**/workspace-boot.js', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.continue();
  });

  await page.reload();
  await page.waitForTimeout(450);
  const samples = await page.evaluate(() => window.__collapsedSidebarBootSamples);
  expect(samples.length).toBeGreaterThan(1);
  // The hidden sidebar keeps its one-pixel border box, but never exposes its
  // persisted width or moves the terminal shell in a paintable frame.
  expect(samples.every((sample) => sample.sidebarWidth <= 1), JSON.stringify(samples)).toBe(true);
  expect(samples.every((sample) => sample.sidebarVisibility === 'hidden')).toBe(true);
  expect(Math.max(...samples.map((sample) => sample.shellX)) -
    Math.min(...samples.map((sample) => sample.shellX))).toBeLessThan(1);
  await expect(page.locator('.workspace')).toHaveAttribute('data-sidebar', 'collapsed');
  await expect(page.locator('html')).not.toHaveAttribute('data-sidebar-booting', 'true');
});

test('persists sidebar and per-chat browser split while both panes resize', async ({ page }) => {
  test.setTimeout(60_000);
  await page.evaluate(() => {
    window.__sidebarResizeMessages = [];
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function trackedSidebarResize(payload) {
      try {
        const message = JSON.parse(payload);
        if (message.type === 'resize') window.__sidebarResizeMessages.push(message);
      } catch {
        // Ignore terminal input and non-JSON WebSocket frames.
      }
      return send.call(this, payload);
    };
  });
  await createProject(page, { name: 'Resizable', marker: '__RESIZE_PROJECT__' });

  const beforeSidebar = await page.locator('.sidebar').boundingBox();
  const sidebarHandle = await page.locator('#sidebar-resizer').boundingBox();
  await page.mouse.move(sidebarHandle.x + 2, sidebarHandle.y + 100);
  await page.mouse.down();
  await page.mouse.move(sidebarHandle.x + 70, sidebarHandle.y + 100, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const afterSidebar = await page.locator('.sidebar').boundingBox();
  expect(afterSidebar.width).toBeGreaterThan(beforeSidebar.width + 40);

  await page.evaluate(() => { window.__sidebarResizeMessages.length = 0; });
  await page.locator('#toggle-sidebar').click();
  await expect(page.locator('.workspace')).toHaveAttribute('data-sidebar', 'collapsed');
  await expect(page.locator('#open-sidebar')).toBeVisible();
  await expect(page.locator('#open-sidebar')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#open-sidebar')).toHaveCSS('border-width', '0px');
  await expect(page.locator('#open-sidebar')).toHaveCSS('border-radius', '0px');
  await page.locator('#open-sidebar').hover();
  await expect(page.locator('#open-sidebar')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(page.locator('#open-sidebar')).toHaveCSS('color', 'rgb(192, 192, 196)');
  await expect(page.locator('#open-sidebar .sidebar-nav-icon')).toHaveCount(1);
  await expect(page.locator('#open-sidebar')).not.toContainText('☰');
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__sidebarResizeMessages)).toHaveLength(1);
  const collapsedTerminal = await page.locator('.terminal-shell').boundingBox();
  const edgeTrigger = await page.locator('#sidebar-edge-trigger').boundingBox();
  expect(edgeTrigger.x).toBe(0);
  expect(edgeTrigger.width).toBeLessThanOrEqual(20);
  await page.locator('#sidebar-edge-trigger').hover({ position: { x: 1, y: 120 } });
  await expect(page.locator('.workspace')).toHaveAttribute('data-sidebar-peek', 'true');
  await expect(page.locator('.sidebar')).toBeVisible();
  const peekedSidebar = await page.locator('.sidebar').boundingBox();
  const peekedTerminal = await page.locator('.terminal-shell').boundingBox();
  expect(peekedTerminal.x).toBe(collapsedTerminal.x);
  expect(peekedTerminal.width).toBe(collapsedTerminal.width);
  await page.mouse.move(peekedSidebar.x + peekedSidebar.width / 2, 120);
  await page.waitForTimeout(180);
  await expect(page.locator('.workspace')).toHaveAttribute('data-sidebar-peek', 'true');
  await page.mouse.move(peekedSidebar.x + peekedSidebar.width + 60, 120);
  await expect(page.locator('.workspace')).not.toHaveAttribute('data-sidebar-peek', 'true');
  await expect(page.locator('.sidebar')).not.toBeVisible();
  await page.locator('#open-sidebar').click();
  await expect(page.locator('.workspace')).toHaveAttribute('data-sidebar', 'expanded');
  await expect(page.locator('#toggle-sidebar')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#toggle-sidebar .sidebar-nav-icon')).toHaveCount(1);
  await expect(page.locator('#toggle-sidebar')).not.toContainText('←');
  await page.locator('#toggle-sidebar').click();
  await expect(page.locator('.workspace')).toHaveAttribute('data-sidebar', 'collapsed');
  await page.keyboard.press('ControlOrMeta+b');
  await expect(page.locator('.workspace')).toHaveAttribute('data-sidebar', 'expanded');

  await page.locator('#terminal .xterm-helper-textarea').focus();
  await page.keyboard.insertText(`node ${process.cwd()}/test/fixtures/split-request.js __PROJECT_SPLIT__`);
  await page.keyboard.press('Enter');
  await expect(page.locator('#terminal .xterm-rows')).toContainText('__PROJECT_SPLIT__', { timeout: 5000 });
  await expect(page.locator('#graphics-split')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('#graphics-resizer')).toBeVisible();
  await expect(page.locator('.graphics-terminal-instance:not([hidden]) .xterm-rows'))
    .toContainText('__PROJECT_SPLIT__', { timeout: 5000 });

  const graphicsToggle = page.locator('#toggle-graphics-pane');
  await expect(graphicsToggle).toBeVisible();
  await expect(graphicsToggle).toHaveAttribute('aria-expanded', 'true');
  await graphicsToggle.click();
  await expect(page.locator('#graphics-split')).toBeHidden();
  await expect(page.locator('#graphics-resizer')).toBeHidden();
  await expect(graphicsToggle).toHaveAttribute('aria-expanded', 'false');
  await graphicsToggle.click();
  await expect(page.locator('#graphics-split')).toBeVisible();
  await expect(page.locator('.graphics-terminal-instance:not([hidden]) .xterm-rows'))
    .toContainText('__PROJECT_SPLIT__');

  const beforeSplit = await page.locator('#graphics-split').boundingBox();
  const splitHandle = await page.locator('#graphics-resizer').boundingBox();
  await page.mouse.move(splitHandle.x + 2, splitHandle.y + 120);
  await page.mouse.down();
  await page.mouse.move(splitHandle.x - 80, splitHandle.y + 120, { steps: 8 });
  await page.mouse.up();
  const afterSplit = await page.locator('#graphics-split').boundingBox();
  expect(afterSplit.width).toBeGreaterThan(beforeSplit.width + 50);

  await page.locator('#toggle-sidebar').click();
  await expect(page.locator('.workspace')).toHaveAttribute('data-sidebar', 'collapsed');
  await page.route('**/api/renderers', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await route.continue();
  });
  await page.addInitScript(() => {
    window.__sidebarBootSamples = [];
    const sample = () => {
      const workspace = document.querySelector('.workspace');
      const shell = document.querySelector('.terminal-shell');
      if (!workspace || !shell) return;
      const bounds = shell.getBoundingClientRect();
      window.__sidebarBootSamples.push({
        state: workspace.dataset.sidebar,
        x: Math.round(bounds.x * 10) / 10,
        width: Math.round(bounds.width * 10) / 10,
      });
    };
    new MutationObserver(sample).observe(document, {
      attributes: true,
      childList: true,
      subtree: true,
      attributeFilter: ['data-sidebar', 'style'],
    });
    addEventListener('DOMContentLoaded', () => {
      const startedAt = performance.now();
      const sampleFrame = () => {
        sample();
        if (performance.now() - startedAt < 450) requestAnimationFrame(sampleFrame);
      };
      requestAnimationFrame(sampleFrame);
    }, { once: true });
  });
  const reloadStartedAt = Date.now();
  await page.reload();
  await expect(page.locator('.workspace')).toHaveAttribute('data-sidebar', 'collapsed');
  await expect(page.locator('#terminal')).toBeVisible({ timeout: 1_200 });
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'connected');
  expect(Date.now() - reloadStartedAt).toBeLessThan(1_500);
  await page.waitForTimeout(500);
  const sidebarBootSamples = await page.evaluate(() => window.__sidebarBootSamples);
  expect(sidebarBootSamples.length).toBeGreaterThan(2);
  expect(sidebarBootSamples.every((sample) => sample.state === 'collapsed')).toBe(true);
  expect(Math.max(...sidebarBootSamples.map((sample) => sample.x)) -
    Math.min(...sidebarBootSamples.map((sample) => sample.x))).toBeLessThan(1);
  await expect(page.locator('#graphics-split')).toBeVisible({ timeout: 5000 });
  await expect(graphicsToggle).toBeVisible();
  await expect(graphicsToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.graphics-terminal-instance:not([hidden]) .xterm-rows'))
    .toContainText('__PROJECT_SPLIT__');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.locator('#graphics-split')).toBeHidden({ timeout: 5000 });
  await expect(page.locator('#toggle-graphics-pane')).toBeHidden();
  const mobileBrowserTab = page.locator('#graphics-mobile-reopen');
  await expect(mobileBrowserTab).toBeVisible();
  await expect(mobileBrowserTab).toHaveText('Browser');
  await mobileBrowserTab.click();
  await expect(page.locator('#graphics-split')).toBeVisible();
  await page.locator('#graphics-sheet-backdrop').click({ position: { x: 8, y: 8 } });
  await expect(page.locator('#graphics-split')).toBeHidden();
  await expect(mobileBrowserTab).toBeVisible();
  await mobileBrowserTab.click();
  await page.locator('#close-graphics-split').click();
  await expect(page.locator('#graphics-split')).toBeHidden();
  await expect(page.locator('#graphics-resizer')).toBeHidden();
});

test('folds projects, limits previews to five chats, and keeps polling visually stable', async ({ page }) => {
  test.setTimeout(60_000);
  const project = await createProject(page, { name: 'Session limit', marker: '__SESSION_LIMIT__' });
  const addChat = () => project.getByRole('button', { name: 'New chat in Session limit' });

  for (const expectedCount of [2, 3, 4, 5]) {
    await project.locator('.project-header').hover();
    await addChat().click();
    await expect(project.locator('.session-row')).toHaveCount(expectedCount, { timeout: 8_000 });
  }
  await project.locator('.project-header').hover();
  await addChat().click();
  await expect(project.getByRole('button', { name: 'Show 1 more' })).toBeVisible({ timeout: 8_000 });
  await expect(project.locator('.session-row')).toHaveCount(5);

  await project.getByRole('button', { name: 'Show 1 more' }).click();
  await expect(project.locator('.session-row')).toHaveCount(6);
  await project.getByRole('button', { name: 'Show less' }).click();
  await expect(project.locator('.session-row')).toHaveCount(5);

  await project.locator('.project-select').click();
  await page.mouse.move(900, 500);
  await page.waitForTimeout(350);
  expect((await project.locator(':scope > .chat-list').boundingBox()).height).toBeLessThan(2);
  await expect(project.locator('.project-header')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');

  await project.locator('.project-select').click();
  await page.mouse.move(900, 500);
  await page.waitForTimeout(350);
  expect((await project.locator(':scope > .chat-list').boundingBox()).height).toBeGreaterThan(25);

  await project.evaluate((element) => { window.__agentRemoteStableProject = element; });
  await page.waitForTimeout(3_300);
  expect(await project.evaluate((element) => element === window.__agentRemoteStableProject)).toBe(true);
});

test('creates and deletes chats optimistically without late responses stealing selection', async ({ page, request }) => {
  test.setTimeout(45_000);
  const project = await createProject(page, { name: 'Optimistic', marker: '__OPTIMISTIC__' });
  const originalSession = await project.locator('.session-row').getAttribute('data-session');

  await page.route('**/api/projects/*/sessions', async (route) => {
    if (route.request().method() === 'POST') await new Promise((resolve) => setTimeout(resolve, 900));
    await route.continue();
  });
  const addChat = project.getByRole('button', { name: 'New chat in Optimistic' });
  await project.locator('.project-header').hover();
  await addChat.click();
  await expect(project.locator('.session-row[data-state="pending"]')).toHaveCount(1, { timeout: 500 });
  await expect(page.locator('#session-loading')).toBeVisible();

  await addChat.click({ force: true });
  await expect(project.locator('.session-row[data-state="pending"]')).toHaveCount(2, { timeout: 500 });
  await project.locator(`.session-row[data-session="${originalSession}"] .session-button`).click();
  await expect(page.locator('#terminal')).toBeVisible();
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'connected');

  await expect(project.locator('.session-row[data-state="pending"]')).toHaveCount(0, { timeout: 10_000 });
  await expect(project.locator('.session-row')).toHaveCount(3);
  await expect(project.locator(`.session-row[data-session="${originalSession}"]`)).toHaveClass(/active/);

  await page.route('**/api/sessions/*', async (route) => {
    if (route.request().method() === 'DELETE') await new Promise((resolve) => setTimeout(resolve, 900));
    await route.continue();
  });
  const deleteTarget = project.locator(`.session-row:not([data-session="${originalSession}"])`).first();
  const deleteTargetName = await deleteTarget.getAttribute('data-session');
  const stableDeleteTarget = project.locator(`.session-row[data-session="${deleteTargetName}"]`);
  await stableDeleteTarget.hover();
  await stableDeleteTarget.locator('.session-close').click();
  await expect(project.locator(`.session-row[data-session="${deleteTargetName}"]`)).toHaveCount(0, { timeout: 500 });

  const projectId = await project.getAttribute('data-project');
  await page.route(`**/api/projects/${projectId}`, async (route) => {
    if (route.request().method() === 'DELETE') await new Promise((resolve) => setTimeout(resolve, 900));
    await route.continue();
  });
  await project.locator('.project-header').hover();
  page.once('dialog', (prompt) => prompt.accept());
  await project.getByRole('button', { name: 'Delete project Optimistic' }).click();
  await expect(page.locator(`.project-group[data-project="${projectId}"]`)).toHaveCount(0, { timeout: 500 });
  await expect(page.locator('#empty-state')).toBeVisible();
  await expect.poll(async () => {
    const response = await request.get('/api/projects');
    const payload = await response.json();
    return payload.projects.some((item) => item.id === projectId);
  }, { timeout: 8_000 }).toBe(false);
});

test('syncs remote chat deletion immediately and never reuses the deleted client runtime', async ({ page, browser }) => {
  test.setTimeout(40_000);
  const project = await createProject(page, { name: 'Cross device sync', marker: '__CROSS_DEVICE_OLD__' });
  const oldSession = await project.locator('.session-row').getAttribute('data-session');

  const phoneContext = await browser.newContext({
    baseURL: 'http://127.0.0.1:3100',
    viewport: { width: 390, height: 844 },
  });
  const phone = await phoneContext.newPage();
  await phone.addInitScript((sessionName) => {
    localStorage.setItem('agent-remote-session', sessionName);
  }, oldSession);
  await phone.goto('/');
  await expect(phone.locator('#terminal')).toHaveAttribute('data-session', oldSession, { timeout: 8_000 });
  const oldRuntime = await phone.locator(`.terminal-instance[data-session="${oldSession}"]`).elementHandle();

  const oldRow = project.locator(`.session-row[data-session="${oldSession}"]`);
  await oldRow.hover();
  await oldRow.locator('.session-close').click();
  await expect(phone.locator('#empty-state')).toBeVisible({ timeout: 2_000 });
  await expect(phone.locator(`.session-row[data-session="${oldSession}"]`)).toHaveCount(0);
  expect(await oldRuntime.evaluate((node) => node.isConnected)).toBe(false);
  expect(await phone.evaluate(() => localStorage.getItem('agent-remote-session'))).toBeNull();

  const openSidebar = phone.locator('#open-sidebar');
  if (await openSidebar.isVisible()) await openSidebar.click();
  const phoneProject = phone.locator('.project-group').filter({
    has: phone.locator('.project-name', { hasText: 'Cross device sync' }),
  });
  await phoneProject.locator('.project-header').hover();
  await phoneProject.getByRole('button', { name: 'New chat in Cross device sync' }).click({ force: true });
  await expect(phoneProject.locator('.session-row[data-state="pending"]')).toHaveCount(0, { timeout: 8_000 });
  const newSession = await phoneProject.locator('.session-row.active').getAttribute('data-session');
  // tmux deliberately reuses the now-free base name. The client must still
  // treat this as a new incarnation rather than resurrecting the removed DOM,
  // PTY socket, browser pane, or conversation cache under that same key.
  expect(newSession).toBe(oldSession);
  await expect(phone.locator('#terminal')).toHaveAttribute('data-session', newSession, { timeout: 8_000 });
  const newRuntime = await phone.locator(`.terminal-instance[data-session="${newSession}"]`).elementHandle();
  expect(await newRuntime.evaluate((node, previous) => node !== previous, oldRuntime)).toBe(true);

  await phoneContext.close();
});

test('keeps loaded terminal runtimes mounted in memory for instant session switching', async ({ page }) => {
  test.setTimeout(35_000);
  let project = await createProject(page, { name: 'Cache switching', marker: '__CACHE_READY__' });
  const firstSession = await project.locator('.session-row').getAttribute('data-session');
  const projectNode = await project.elementHandle();
  const firstRowNode = await project.locator(`.session-row[data-session="${firstSession}"]`).elementHandle();
  await expect(page.locator('#session-loading')).toBeHidden();
  const firstRuntime = await page.locator('#terminal .terminal-instance').elementHandle();

  await project.locator('.project-header').hover();
  await project.getByRole('button', { name: 'New chat in Cache switching' }).click();
  project = page.locator('.project-group').filter({
    has: page.locator('.project-name', { hasText: 'Cache switching' }),
  });
  await expect(project.locator('.session-row')).toHaveCount(2, { timeout: 8_000 });
  await expect(project.locator('.session-row[data-state="pending"]')).toHaveCount(0, { timeout: 8_000 });
  expect(await project.evaluate((node, previous) => node === previous, projectNode)).toBe(true);
  expect(await project.locator(`.session-row[data-session="${firstSession}"]`)
    .evaluate((node, previous) => node === previous, firstRowNode)).toBe(true);
  await page.waitForTimeout(3_200);
  expect(await project.evaluate((node, previous) => node === previous, projectNode)).toBe(true);
  expect(await project.locator(`.session-row[data-session="${firstSession}"]`)
    .evaluate((node, previous) => node === previous, firstRowNode)).toBe(true);
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'connected');
  const secondSession = await project.locator('.session-row.active').getAttribute('data-session');
  expect(secondSession).not.toBe(firstSession);
  await expect(page.locator('#terminal')).toHaveAttribute('data-session', secondSession);
  await expect(page.locator('#terminal .xterm-rows')).toContainText('__CACHE_READY__');
  await expect(page.locator('#session-loading')).toBeHidden();
  const secondRuntime = await page.locator('#terminal .terminal-instance').elementHandle();

  await page.evaluate(() => {
    window.__sessionLoadingWasShown = false;
    window.__sessionLoadingObserver = new MutationObserver(() => {
      const loading = document.querySelector('#session-loading');
      if (loading && !loading.hidden) window.__sessionLoadingWasShown = true;
    });
    window.__sessionLoadingObserver.observe(document.querySelector('#session-loading'), {
      attributes: true,
      attributeFilter: ['hidden'],
    });
  });
  const startedAt = Date.now();
  await project.locator(`.session-row[data-session="${firstSession}"] .session-button`).click();
  await expect(page.locator('#terminal')).toHaveAttribute('data-session', firstSession);
  await expect(page.locator('#terminal .xterm-rows')).toContainText('__CACHE_READY__');
  expect(await page.locator('#terminal .terminal-instance').evaluate((node, previous) => node === previous, firstRuntime)).toBe(true);
  expect(Date.now() - startedAt).toBeLessThan(700);
  await expect(page.locator('#session-loading')).toBeHidden();
  expect(await page.evaluate(() => window.__sessionLoadingWasShown)).toBe(false);

  await project.locator(`.session-row[data-session="${secondSession}"] .session-button`).click();
  await expect(page.locator('#terminal')).toHaveAttribute('data-session', secondSession);
  await expect(page.locator('#terminal .xterm-rows')).toContainText('__CACHE_READY__');
  expect(await page.locator('#terminal .terminal-instance').evaluate((node, previous) => node === previous, secondRuntime)).toBe(true);
  expect(await page.evaluate(() => window.__sessionLoadingWasShown)).toBe(false);
});

test('hydrates the active terminal from its viewport cache after refresh', async ({ page }) => {
  test.setTimeout(25_000);
  const marker = '__REFRESH_CACHE_READY__';
  const project = await createProject(page, {
    name: 'Refresh cache',
    marker,
    agentId: 'fixture-ansi',
  });
  const sessionName = await project.locator('.session-row').getAttribute('data-session');
  await expect(page.locator('#terminal .xterm-rows')).toContainText(marker);
  await page.waitForFunction(({ key, session, text }) => {
    const cache = JSON.parse(sessionStorage.getItem(key) || '{}');
    return cache[session]?.format === 2 && cache[session]?.ansiLines?.some((line) =>
      line.includes(text) && line.includes('\u001b[0;31m'));
  }, { key: 'agent-remote-terminal-snapshots-v1', session: sessionName, text: marker });

  await page.addInitScript(() => {
    sessionStorage.setItem('__agentRemoteEmptyFlash', 'false');
    sessionStorage.setItem('__agentRemotePartialSnapshot', 'false');
    const inspect = () => {
      const empty = document.querySelector('#empty-state');
      if (empty && !empty.hidden && getComputedStyle(empty).visibility !== 'hidden') {
        sessionStorage.setItem('__agentRemoteEmptyFlash', 'true');
      }
      const restoring = document.querySelector('.terminal-instance[data-restoring-snapshot="true"]');
      if (restoring && getComputedStyle(restoring).visibility !== 'hidden') {
        sessionStorage.setItem('__agentRemotePartialSnapshot', 'true');
      }
    };
    new MutationObserver(() => requestAnimationFrame(inspect)).observe(document, {
      attributes: true,
      childList: true,
      subtree: true,
      attributeFilter: ['data-view', 'data-restoring-session', 'style', 'hidden'],
    });
    addEventListener('DOMContentLoaded', () => requestAnimationFrame(inspect), { once: true });
  });
  await page.reload();
  const restoredRuntime = page.locator(`#terminal .terminal-instance[data-session="${sessionName}"]`);
  await expect(restoredRuntime).toHaveAttribute('data-restored-cache', 'true', { timeout: 3_000 });
  await expect(page.locator('#terminal .xterm-rows')).toContainText(marker);
  const restoredColors = await page.locator('#terminal .xterm-rows').evaluate((rows, text) => {
    return [...rows.querySelectorAll('span')]
      .filter((element) => element.textContent?.includes(text))
      .map((element) => getComputedStyle(element).color);
  }, marker);
  expect(restoredColors).toContain('rgb(215, 139, 134)');
  await expect(page.locator('#session-loading')).toBeHidden();
  expect(await page.evaluate(() => sessionStorage.getItem('__agentRemoteEmptyFlash'))).toBe('false');
  expect(await page.evaluate(() => sessionStorage.getItem('__agentRemotePartialSnapshot'))).toBe('false');
});

test('keeps agent launch chatter covered until the startup output settles', async ({ page }) => {
  test.setTimeout(20_000);
  await createProject(page, {
    name: 'Agent loading',
    marker: '__GROK_READY__',
    agentId: 'fixture-loading',
  });
  await expect(page.locator('#terminal .xterm-rows')).toContainText('__GROK_READY__');
  const loading = page.locator('#session-loading');
  const launchingTerminal = page.locator('#terminal .terminal-instance[data-launching="true"]');
  await expect(loading).toBeVisible();
  await expect(loading).toHaveCSS('opacity', '1');
  await expect(loading).toContainText('The command is starting');
  await expect(launchingTerminal).toHaveCSS('visibility', 'hidden');
  await expect(loading).toBeHidden({ timeout: 3_000 });
  await expect(page.locator('#terminal .terminal-instance')).not.toHaveAttribute('data-launching', 'true');
});

test('keeps one loading cover until Grok conversation readiness succeeds', async ({ page }) => {
  test.setTimeout(25_000);
  let acpReady = false;
  let readinessRequests = 0;
  await page.route('**/api/conversations/**', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    readinessRequests += 1;
    if (!acpReady) {
      return route.fulfill({ status: 503, json: {
        error: 'Connecting to Grok', code: 'CONVERSATION_INITIALIZING',
      } });
    }
    return route.fulfill({ json: { conversation: { provider: { id: 'grok' } } } });
  });
  await createProject(page, {
    name: 'Grok ACP gate', marker: 'Starting session',
    agentId: 'fixture-grok-gate',
  });

  const loading = page.locator('#session-loading');
  const terminal = page.locator('#terminal .terminal-instance');
  await expect.poll(() => readinessRequests).toBeGreaterThan(0);
  await expect(loading).toBeVisible();
  await expect(loading).toHaveAttribute('aria-label', 'Preparing chat');
  await expect(loading.locator('.session-loading-orbit')).toBeHidden();
  await expect(loading.locator('#session-loading-kicker')).toBeHidden();
  await expect(loading.locator('#session-loading-title')).toBeHidden();
  await expect(loading.locator('#session-loading-copy')).toBeHidden();
  await expect(loading.locator('.chat-state-stack > :visible')).toHaveCount(1);
  await expect(loading.locator('.chat-loading-indicator')).toBeVisible();
  await expect.poll(() => loading.locator('.chat-loading-indicator').evaluate((indicator) =>
    getComputedStyle(indicator).animationName)).toBe('session-spin');
  await expect(loading).not.toContainText('Connecting');
  await expect(terminal).toHaveAttribute('data-launching', 'true');
  await expect(terminal).toHaveCSS('visibility', 'hidden');
  await expect(page.locator('#terminal .xterm-rows')).toContainText('Starting session');

  // The legacy 2.4-second terminal timer must never reveal Grok's raw launch
  // buffer while ACP is still initializing.
  await page.waitForTimeout(3_000);
  await expect(loading).toBeVisible();
  await expect(terminal).toHaveAttribute('data-launching', 'true');
  acpReady = true;
  await expect(loading).toBeHidden({ timeout: 5_000 });
  await expect(terminal).not.toHaveAttribute('data-launching', 'true');
  // Startup text belongs to Grok; readiness controls only the atomic cover.
  await expect(page.locator('#terminal .xterm-rows')).toContainText('Starting session');
});

test('reveals an agent that continuously repaints instead of connecting forever', async ({ page }) => {
  test.setTimeout(30_000);
  await page.evaluate(() => {
    window.__continuousLoadingWasShown = false;
    window.__continuousLoadingObserver = new MutationObserver(() => {
      const loading = document.querySelector('#session-loading');
      if (loading && !loading.hidden) window.__continuousLoadingWasShown = true;
    });
    window.__continuousLoadingObserver.observe(document.querySelector('#session-loading'), {
      attributes: true,
      attributeFilter: ['hidden'],
    });
  });
  await createProject(page, {
    name: 'Agent loading',
    marker: '__GROK_FRAME_0__',
    agentId: 'fixture-continuous',
  });

  expect(await page.evaluate(() => window.__continuousLoadingWasShown)).toBe(true);
  await expect(page.locator('#terminal .xterm-rows')).toContainText('__GROK_FRAME_0__');
  await expect(page.locator('#session-loading')).toBeHidden({ timeout: 3_500 });
  // The producer is deliberately still repainting when the loading cover is
  // removed; this is the regression that used to reset the debounce forever.
  await expect(page.locator('#terminal .xterm-rows')).not.toContainText('__GROK_FRAME_44__');
  await expect(page.locator('#terminal .xterm-rows')).toContainText('__GROK_FRAME_44__', { timeout: 8_000 });

  await page.reload();
  await expect(page.locator('#terminal .xterm-rows')).toContainText('__GROK_FRAME_44__', { timeout: 3_000 });
  await expect(page.locator('#session-loading')).toBeHidden({ timeout: 3_500 });
});

test('restores the active chat, orders chats by recent input, and has one workspace home', async ({ page }) => {
  test.setTimeout(35_000);
  let project = await createProject(page, { name: 'Recent activity', marker: '__RECENT_READY__' });
  const firstSession = await project.locator('.session-row').getAttribute('data-session');

  await project.locator('.project-header').hover();
  await project.getByRole('button', { name: 'New chat in Recent activity' }).click();
  project = page.locator('.project-group').filter({
    has: page.locator('.project-name', { hasText: 'Recent activity' }),
  });
  await expect(project.locator('.session-row')).toHaveCount(2, { timeout: 8_000 });
  await expect(project.locator('.session-row[data-state="pending"]')).toHaveCount(0, { timeout: 8_000 });

  const firstRow = project.locator(`.session-row[data-session="${firstSession}"]`);
  await firstRow.locator('.session-button').click();
  await page.locator('#terminal .xterm-helper-textarea').focus();
  await page.keyboard.type('s');
  await expect(project.locator('.session-row').first()).toHaveAttribute('data-session', firstSession);
  await page.waitForTimeout(650);

  await page.keyboard.insertText('leep 1');
  await page.keyboard.press('Enter');
  await expect(firstRow).toHaveClass(/working/);
  await expect(firstRow.locator('.session-activity')).toHaveCSS('opacity', '1');

  await page.reload();
  project = page.locator('.project-group').filter({
    has: page.locator('.project-name', { hasText: 'Recent activity' }),
  });
  await expect(project).toHaveClass(/expanded/);
  await expect(project.locator('.session-row').first()).toHaveAttribute('data-session', firstSession);
  await expect(project.locator(`.session-row[data-session="${firstSession}"]`)).toHaveClass(/active/);
  await expect(page.locator('#terminal')).toHaveAttribute('data-session', firstSession);

  await page.locator('#home-button').click();
  await expect(page.locator('#empty-state')).toBeVisible();
  await expect(page.locator('#empty-title')).toHaveText('What should we build next?');
  await expect(page.locator('.session-row.active')).toHaveCount(0);
  await expect(page.locator('#empty-state button')).toHaveCount(0);

  await project.locator('.project-select').click();
  await expect(page.locator('#empty-title')).toHaveText('What should we build next?');
  await expect(page.locator('#empty-state button')).toHaveCount(0);
});

test('uses conversation turn lifecycle for sidebar activity', async ({ page }) => {
  test.setTimeout(25_000);
  const project = await createProject(page, {
    name: 'Lifecycle status',
    marker: '__LIFECYCLE_READY__',
  });
  const sessionName = await project.locator('.session-row').getAttribute('data-session');
  const row = project.locator(`.session-row[data-session="${sessionName}"]`);
  let conversationStatus = 'idle';
  let sessionRequests = 0;

  await page.route('**/api/sessions', async (route) => {
    sessionRequests += 1;
    const response = await route.fetch();
    const payload = await response.json();
    const session = payload.sessions.find((item) => item.name === sessionName);
    if (session) {
      session.conversationThreadId = '01234567-89ab-4def-8123-456789abcdef';
      session.conversationStatus = conversationStatus;
    }
    await route.fulfill({ response, json: payload });
  });

  conversationStatus = 'working';
  await expect.poll(() => sessionRequests, { timeout: 5_000 }).toBeGreaterThan(0);
  await expect(row).toHaveClass(/working/, { timeout: 5_000 });
  await expect(row).toHaveAttribute('aria-busy', '');

  // Terminal output becoming quiet must not clear an authoritative Grok turn.
  await page.locator('#terminal').click({ position: { x: 200, y: 200 } });
  await page.keyboard.type("echo __LIFECYCLE_OUTPUT__");
  await page.keyboard.press('Enter');
  await expect(page.locator('#terminal .xterm-rows')).toContainText('__LIFECYCLE_OUTPUT__');
  await page.waitForTimeout(2_300);
  await expect(row).toHaveClass(/working/);

  conversationStatus = 'idle';
  await expect(row).not.toHaveClass(/working/, { timeout: 5_000 });
  await expect(row).not.toHaveAttribute('aria-busy', 'true');
});
