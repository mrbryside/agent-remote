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

test('shows local-only Remote controls and manages the four-step wizard', async ({ page }) => {
  let tunnel = { mode: 'none', state: 'stopped' };
  await page.route('**/api/runtime', (route) => route.fulfill({ json: {
    product: 'agent-remote', version: 1, surface: 'local', desktopMode: false,
  } }));
  await page.route('**/api/remote/status', (route) => route.fulfill({ json: {
    supported: true,
    cloudflared: { available: true, version: '2026.8.2', source: 'path' },
    tokenConfigured: true,
    tunnel,
    named: { zoneName: 'example.com', hostname: 'terminal.example.com', desiredState: 'stopped' },
  } }));
  await page.route('**/api/remote/zones', (route) => route.fulfill({ json: { zones: [
    { id: 'zone-example', name: 'example.com' },
    { id: 'zone-work', name: 'work.example' },
  ] } }));
  await page.route('**/api/remote/hostname-availability**', (route) => route.fulfill({ json: {
    hostname: 'taken.example.com', status: 'conflict', suggestions: ['taken-2', 'taken-3'],
  } }));
  await page.route('**/api/remote/devices', (route) => route.fulfill({ json: { devices: [] } }));
  await page.route('**/api/remote/tunnels/quick', (route) => {
    tunnel = { mode: 'quick', state: 'running', publicUrl: 'https://example.trycloudflare.com' };
    return route.fulfill({ status: 201, json: tunnel });
  });
  await page.route('**/api/remote/pairing-sessions', (route) => route.fulfill({ status: 201, json: {
    qrDataUrl: 'data:image/png;base64,iVBORw0KGgo=', expiresAt: Date.now() + 120_000,
  } }));
  await page.reload();
  const remoteButton = page.locator('#remote-button');
  await expect(remoteButton).toBeVisible();
  await remoteButton.click();
  const remoteDialog = page.locator('#remote-dialog');
  await expect(remoteDialog).toBeVisible();
  await expect(remoteDialog.getByRole('heading', { name: 'Choose one connection type' })).toBeVisible();
  await expect(remoteDialog.getByRole('heading', { name: 'Custom Domain' })).toBeHidden();
  await expect(remoteDialog.getByRole('heading', { name: 'Scan locally' })).toBeHidden();
  await expect(remoteDialog.getByRole('heading', { name: 'Paired devices' })).toBeHidden();
  await expect(remoteDialog.locator('[data-remote-step-target]')).toHaveCount(4);
  await expect(remoteDialog.getByRole('radio', { name: /Custom Domain/ })).toBeChecked();
  await remoteDialog.locator('[data-remote-step-target="2"]').click();
  await expect(remoteDialog.getByRole('heading', { name: 'Custom Domain' })).toBeVisible();
  await expect(remoteDialog.locator('#remote-zone')).toHaveValue('example.com');
  await expect(remoteDialog.locator('#remote-subdomain')).toHaveValue('terminal');
  await expect(remoteDialog.locator('#remote-zone-options option')).toHaveCount(2);
  await remoteDialog.locator('#remote-subdomain').fill('taken');
  await expect(remoteDialog.locator('#remote-subdomain-options option').first()).toHaveAttribute('value', 'taken-2');
  await remoteDialog.locator('[data-remote-step-target="1"]').click();
  await remoteDialog.getByRole('radio', { name: /Random URL/ }).check();
  await remoteDialog.getByRole('button', { name: 'Connect Random URL' }).click();
  await expect(remoteDialog.getByLabel('Remote public URL')).toHaveValue('https://example.trycloudflare.com');
  await expect(remoteButton).toHaveAttribute('data-state', 'running');
  await expect(remoteDialog.getByRole('heading', { name: 'Scan locally' })).toBeVisible();
  await remoteDialog.getByRole('button', { name: 'Create QR code' }).click();
  await expect(remoteDialog.locator('#remote-qr')).toBeVisible();
  await expect(remoteDialog.getByText(/QR code expires in/)).toBeVisible();
  await remoteDialog.getByRole('button', { name: 'Next: Devices' }).click();
  await expect(remoteDialog.getByRole('heading', { name: 'Paired devices' })).toBeVisible();
  await remoteDialog.getByRole('button', { name: 'Done' }).click();
  await expect(remoteDialog).toBeHidden();
  await expect(remoteButton).toBeFocused();
});

test('does not show Remote controls on the remote surface', async ({ page }) => {
  await page.route('**/api/runtime', (route) => route.fulfill({ json: {
    product: 'agent-remote', version: 1, surface: 'remote', desktopMode: false,
  } }));
  await page.reload();
  await expect(page.locator('#remote-button')).toBeHidden();
});

test('uses a safe-area aware full-screen Remote sheet on a 390x844 viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/runtime', (route) => route.fulfill({ json: {
    product: 'agent-remote', version: 1, surface: 'local', desktopMode: false,
  } }));
  await page.route('**/api/remote/status', (route) => route.fulfill({ json: {
    supported: true, cloudflared: { available: true }, tokenConfigured: false,
    tunnel: { mode: 'none', state: 'stopped' },
  } }));
  await page.route('**/api/remote/devices', (route) => route.fulfill({ json: { devices: [] } }));
  await page.reload();
  await page.locator('#remote-button').click();
  await page.waitForTimeout(250);
  const bounds = await page.locator('#remote-dialog').boundingBox();
  expect(bounds.x).toBe(0);
  expect(bounds.y).toBe(0);
  expect(bounds.width).toBe(390);
  expect(bounds.height).toBe(844);
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
  test.setTimeout(30_000);
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
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: visualViewport });
    const nativeScrollTo = Element.prototype.scrollTo;
    Element.prototype.scrollTo = function scrollTo(...args) {
      if (this.id === 'mobile-conversation-messages') {
        window.__mobileConversationScrollCalls.push(args[0]);
      }
      return nativeScrollTo.apply(this, args);
    };
    window.EventSource = class MockEventSource {
      constructor(url) {
        this.url = url;
        this.listeners = new Map();
        window.__conversationStreams.push(this);
        queueMicrotask(() => this.emit('open', {}));
      }
      addEventListener(type, listener) {
        const listeners = this.listeners.get(type) || [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
      }
      emit(type, event) {
        for (const listener of this.listeners.get(type) || []) listener(event);
      }
      close() {}
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
      'Review `public/app.js:1-2` before applying the plan.',
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
      '[Unsafe link](javascript:alert(1))',
      '<img src="javascript:alert(2)" onerror="window.__markdownXss = true" alt="Unsafe image">',
      '<script>window.__markdownXss = true</script>',
    ].join('\n') : `History message ${index + 1}`,
  }));
  rootItems.push(
    { id: 'thought-1', type: 'thought', title: 'Thought', text: 'I should inspect the provider.', status: 'working' },
    { id: 'tool-group-1', type: 'tool_group', title: 'Listed 1 dir, Read 2 files, Searched 1 time, Edited 1 file, Ran 1 command', status: 'completed', tools: [
      { id: 'tool-list', type: 'tool', title: 'List Files', subject: 'src', kind: 'list', status: 'completed', output: 'Found files' },
      { id: 'tool-read-agents', type: 'tool', title: 'Read', subject: 'AGENTS.md', kind: 'read', status: 'completed', input: '{"path":"AGENTS.md"}', output: 'Provider instructions loaded', locations: ['AGENTS.md'], file: {
        path: 'AGENTS.md', content: '# Agent guide\nProvider instructions loaded\nKeep tests focused.\n', startLine: 1, totalLines: 3,
      } },
      { id: 'tool-read-package', type: 'tool', title: 'Read', subject: 'package.json', kind: 'read', status: 'completed', output: 'Package loaded' },
      { id: 'tool-search-app', type: 'tool', title: 'Search', subject: 'render', kind: 'search', status: 'completed', output: 'Found 1 match', matches: [
        { path: 'public/app.js', line: 2, text: 'render(status);' },
      ] },
      { id: 'tool-edit-app', type: 'tool', title: 'Edited', subject: 'app.js', kind: 'edit', status: 'completed', diffs: [{
        path: 'public/app.js', oldText: 'const status = "old";\nrender(status);\n',
        newText: 'const status = "ready";\nrender(status);\n',
        oldLine: 1, newLine: 1,
      }] },
      { id: 'tool-shell', type: 'tool', title: 'Shell', kind: 'execute', status: 'completed',
        command: `node --test ${'a-very-long-path/'.repeat(12)}test.js`,
        output: Array.from({ length: 80 }, (_, line) => `test output line ${line + 1}`).join('\n') },
    ] },
    { id: 'plan-1', type: 'plan', title: 'Plan', status: 'working', entries: [{ id: 'p1', content: 'Inspect events', status: 'completed' }, { id: 'p2', content: 'Render cards', status: 'working' }] },
    { id: 'goal-1', type: 'goal', title: 'Goal', objective: 'Render all Grok events', phase: 'executing', status: 'working', progress: { completed: 1, total: 2 } },
    { id: 'task-1', type: 'task', title: 'Run tests', command: 'npm test', output: 'all green', exitCode: 0, status: 'completed' },
    { id: 'event-1', type: 'event', kind: 'future_event', title: 'future_event', text: '{"kept":true}', status: 'completed' },
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
  rootItems.push(subagentItem, secondSubagentItem);
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
  const queueActions = [];
  const uploads = [];
  const permissionResponses = [];
  const questionResponses = [];
  const planReviewResponses = [];
  let releaseFirstQuestion;
  let releaseInitialConversation;
  let holdNextInitialConversation = false;
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
      return route.fulfill({ status: 202, json: { accepted: true, active: true } });
    }
    if (pathname.endsWith('/input')) {
      const submitted = route.request().postDataJSON();
      mobileInputs.push(submitted);
      if (currentActivity.active) {
        const queueId = submitted.text === 'queued follow up' ? 'queue-mobile-1' : `queue-mobile-${queuedInputs.length + 1}`;
        queuedInputs.push({ id: queueId, text: submitted.text, createdAt: Date.now(), attachments: [] });
        return route.fulfill({ status: 202, json: { accepted: true, queued: true, queueId } });
      }
      return route.fulfill({ status: 202, json: { accepted: true, queued: false } });
    }
    if (pathname.endsWith('/model')) {
      const submitted = route.request().postDataJSON();
      modelChanges.push(submitted);
      currentModelId = submitted.modelId;
      if (submitted.effortId) currentEffortId = submitted.effortId;
      return route.fulfill({ status: 202, json: {
        accepted: true, modelId: currentModelId, ...(submitted.effortId ? { effortId: submitted.effortId } : {}),
      } });
    }
    if (pathname.endsWith('/mode')) {
      const submitted = route.request().postDataJSON();
      modeChanges.push(submitted);
      currentModeId = submitted.modeId;
      return route.fulfill({ status: 202, json: { accepted: true, modeId: currentModeId } });
    }
    if (pathname.endsWith('/attachments') && route.request().method() === 'POST') {
      uploads.push({
        name: route.request().headers()['x-file-name'],
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
    if (holdNextInitialConversation && pathname === `/api/conversations/${sessionName}`) {
      holdNextInitialConversation = false;
      await new Promise((resolve) => { releaseInitialConversation = resolve; });
    }
    const selectedThread = new URL(route.request().url()).searchParams.get('thread');
    const child = selectedThread === 'child-thread';
    const secondChild = selectedThread === 'child-thread-2';
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
  await expect(page.locator('.topbar')).toBeHidden();
  await expect(page.locator('#sidebar-edge-trigger')).toBeHidden();
  await page.locator('#sidebar-edge-trigger').dispatchEvent('pointerenter');
  await expect(page.locator('.workspace')).not.toHaveAttribute('data-sidebar-peek', 'true');
  await expect.poll(() => conversation.locator('#mobile-conversation-menu').evaluate((button) => ({
    border: getComputedStyle(button).borderTopStyle,
    radius: getComputedStyle(button).borderRadius,
    background: getComputedStyle(button).backgroundColor,
  }))).toEqual({ border: 'none', radius: '0px', background: 'rgba(0, 0, 0, 0)' });
  const mobileStageBox = await page.locator('#terminal-stage').boundingBox();
  const mobileShellBox = await page.locator('.terminal-shell').boundingBox();
  expect(mobileStageBox.y).toBe(mobileShellBox.y);
  expect(mobileStageBox.height).toBe(mobileShellBox.height);
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
  await project.locator(`.session-row[data-session="${secondSessionName}"] .session-button`).click();
  await expect(project.locator(`.session-row[data-session="${secondSessionName}"]`)).toHaveClass(/active/);
  await expect(page.locator('.workspace')).toHaveAttribute('data-sidebar', 'collapsed');
  await conversation.locator('#mobile-conversation-menu').click();
  holdNextInitialConversation = true;
  await project.locator(`.session-row[data-session="${sessionName}"] .session-button`).click();
  await expect(project.locator(`.session-row[data-session="${sessionName}"]`)).toHaveClass(/active/);
  await expect(page.locator('.workspace')).toHaveAttribute('data-sidebar', 'collapsed');
  await expect(page.locator('#terminal')).toBeHidden();
  await expect.poll(() => Boolean(releaseInitialConversation)).toBe(true);
  await expect(conversation.locator('#mobile-conversation-boot')).toBeVisible();
  await expect(conversation.locator('#mobile-conversation-state')).toBeHidden();
  releaseInitialConversation?.();
  await expect(page.locator('#terminal')).toBeHidden();
  await expect.poll(() => page.evaluate(async (name) => {
    const payload = await (await fetch('/api/sessions')).json();
    return payload.sessions.find((session) => session.name === name)?.attached;
  }, sessionName)).toBeLessThanOrEqual(1);
  await expect(conversation.locator('#mobile-conversation-state')).toHaveText('Ready', { timeout: 8_000 });
  await expect(conversation.locator('#mobile-conversation-boot')).toBeHidden();
  await expect(conversation.locator('.mobile-conversation-loading')).toHaveCount(0, { timeout: 8_000 });
  await expect(conversation.locator('.mobile-message')).toHaveCount(18);
  await expect(messages).toHaveCSS('scroll-behavior', 'auto');
  await expect.poll(() => messages.evaluate((element) =>
    element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => window.__mobileConversationScrollCalls
    .filter((call) => call?.behavior === 'smooth'))).toEqual([]);
  const markdownMessage = conversation.locator('[data-message-id="assistant-0"] .mobile-markdown');
  await expect(markdownMessage.locator('h1')).toHaveText('Markdown response');
  await expect(markdownMessage.locator('strong')).toHaveText('bold');
  await expect(markdownMessage.locator('li')).toHaveCount(2);
  await expect(markdownMessage.locator('table')).toContainText('Renderer');
  await expect(markdownMessage.locator('.mobile-markdown-code-toolbar')).toContainText('js');
  await expect(markdownMessage.getByRole('button', { name: 'Copy code' })).toBeVisible();
  await expect(markdownMessage.getByRole('link', { name: 'safe link' })).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(markdownMessage.locator('script, [onerror]')).toHaveCount(0);
  await expect(markdownMessage.locator('a', { hasText: 'Unsafe link' })).not.toHaveAttribute('href', /.+/);
  await expect(markdownMessage).toContainText('Unsafe image');
  expect(await page.evaluate(() => window.__markdownXss)).toBeUndefined();
  const fileReference = markdownMessage.getByRole('button', { name: 'Open public/app.js at line 1' });
  await expect(fileReference).toBeVisible();
  await fileReference.click();
  const fileSheet = conversation.locator('.mobile-file-sheet');
  await expect(fileSheet).toBeVisible();
  await expect(fileSheet.locator('.mobile-file-sheet-header')).toContainText('public/app.js · Lines 1–2');
  await expect(fileSheet.locator('.mobile-file-line[data-highlighted="true"]')).toHaveCount(2);
  await expect(fileSheet.locator('.mobile-file-lines')).toContainText('const status = "ready";');
  await fileSheet.getByRole('button', { name: 'Close file preview' }).click();
  await expect(fileSheet).toBeHidden();
  await expect(conversation.locator('.mobile-event-card')).toHaveCount(10);
  await expect(conversation.locator('#mobile-conversation-context')).toContainText('6K / 190K');
  const modelButton = conversation.locator('#mobile-conversation-model');
  const modeButton = conversation.locator('#mobile-conversation-mode');
  await expect(modelButton).toContainText('Qwen 3.8 27B');
  const normalModeWidth = (await modeButton.boundingBox()).width;
  await expect.poll(() => modelButton.evaluate((button) => ({
    flexGrow: getComputedStyle(button).flexGrow,
    maxWidth: getComputedStyle(button).maxWidth,
    labelFits: button.querySelector('span').scrollWidth <= button.querySelector('span').clientWidth,
  }))).toEqual({ flexGrow: '0', maxWidth: '148px', labelFits: true });
  await modelButton.click();
  const modelList = conversation.locator('#mobile-conversation-model-list');
  await expect(modelList).toBeVisible();
  await expect(modelList.getByRole('group', { name: 'Local' })).toContainText('Qwen 3.8 27B');
  await expect(modelList.getByRole('group', { name: 'xAI' })).toContainText('Grok 4.6');
  await expect(modelList.getByRole('option')).toHaveCount(2);
  await modelList.getByRole('option', { name: /Grok 4\.6/ }).click();
  await expect(modelList).toContainText('Choose effort');
  await expect(modelList.getByRole('option')).toHaveCount(2);
  await modelList.getByRole('option', { name: /Low Effort/ }).click();
  await expect.poll(() => modelChanges).toContainEqual({ modelId: 'grok-4.6', effortId: 'low' });
  await expect(modelButton).toContainText('Grok 4.6');
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
  await conversation.locator('#mobile-conversation-mode-list').getByRole('option', { name: /Plan/ }).click();
  await expect.poll(() => modeChanges).toContainEqual({ modeId: 'plan' });
  await expect(modeButton).toContainText('Plan');
  await modeButton.click();
  await conversation.locator('#mobile-conversation-mode-list')
    .getByRole('option', { name: /Always approve/ }).click();
  await expect.poll(() => modeChanges).toContainEqual({ modeId: 'alwaysApprove' });
  await expect(modeButton).toContainText('Always approve');
  expect((await modeButton.boundingBox()).width).toBeGreaterThan(normalModeWidth);
  await expect.poll(() => modeButton.evaluate((button) => button.querySelector('span').scrollWidth <=
    button.querySelector('span').clientWidth)).toBe(true);
  await expect(conversation.locator('#mobile-conversation-permission-mode')).toHaveCount(0);
  const input = conversation.locator('#mobile-conversation-input');
  const activity = conversation.locator('#mobile-conversation-activity');
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
  await input.focus();
  await page.evaluate(() => window.__setVisualViewport({ height: 510, offsetTop: 24 }));
  await expect(page.locator('html')).toHaveAttribute('data-visual-keyboard', 'true');
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
    };
  });
  expect(keyboardLayout.rootBottom - keyboardLayout.composerBottom).toBeLessThanOrEqual(12);
  expect(keyboardLayout.composerTop).toBeGreaterThan(keyboardLayout.rootTop + 160);
  expect(keyboardLayout.messagesHeight).toBeGreaterThan(120);
  await page.evaluate(() => window.__setVisualViewport({ height: 844, offsetTop: 0 }));
  await expect(page.locator('html')).toHaveAttribute('data-visual-keyboard', 'false');
  await input.evaluate((element) => element.blur());
  currentActivity = {
    active: true, phase: 'waiting', label: 'Waiting for response…',
    canCancel: true, cancelRequested: false,
  };
  await page.evaluate((nextConversation) => {
    window.__conversationStreams.at(-1).emit('conversation', {
      data: JSON.stringify({ conversation: nextConversation }),
    });
  }, rootConversation());
  await expect(activity).toBeVisible();
  await expect(activity).toContainText('Waiting for response…');
  await expect(activity.locator('i')).toHaveCount(1);
  await expect(sendButton).toHaveAttribute('data-action', 'stop');
  await expect(sendButton).toHaveAttribute('aria-label', 'Stop response');
  await expect(sidebarSession).toHaveClass(/working/);
  await expect(modelButton).toBeEnabled();
  await expect(conversation.locator('#mobile-conversation-mode')).toBeEnabled();
  await modelButton.click();
  await modelList.getByRole('option', { name: /Qwen 3\.8 27B/ }).click();
  await expect.poll(() => modelChanges).toContainEqual({ modelId: 'qwen-local' });
  await expect(modelButton).toContainText('Qwen 3.8 27B');
  await conversation.locator('#mobile-conversation-mode').click();
  await conversation.locator('#mobile-conversation-mode-list').getByRole('option', { name: /Auto/ }).click();
  await expect.poll(() => modeChanges).toContainEqual({ modeId: 'auto' });
  await expect(conversation.locator('#mobile-conversation-mode')).toContainText('Auto');
  await conversation.locator('#mobile-conversation-file').setInputFiles({
    name: 'streaming.png', mimeType: 'image/png', buffer: Buffer.from('streaming-image'),
  });
  await expect.poll(() => uploads).toContainEqual({
    name: encodeURIComponent('streaming.png'), bytes: 'streaming-image',
  });
  await expect(conversation.getByRole('button', { name: 'Remove phone.png' })).toBeVisible();
  await conversation.getByRole('button', { name: 'Remove phone.png' }).click();

  currentActivity = {
    active: true, phase: 'tool', label: 'Preparing read_file…',
    canCancel: true, cancelRequested: false,
  };
  await page.evaluate((nextConversation) => {
    window.__conversationStreams.at(-1).emit('conversation', {
      data: JSON.stringify({ conversation: nextConversation }),
    });
  }, rootConversation());
  await expect(activity).toContainText('Preparing read_file…');
  await input.fill('queue this while Grok works');
  await expect(sendButton).toHaveAttribute('data-action', 'send');
  await expect(sendButton).toHaveAttribute('aria-label', 'Send message');
  await input.fill('');
  await expect(sendButton).toHaveAttribute('data-action', 'stop');
  await sendButton.click();
  await expect.poll(() => cancellations).toEqual([{}]);
  await expect(activity).toContainText('Stopping…');
  await expect(sendButton).toBeDisabled();

  currentActivity = { active: false };
  await page.evaluate((nextConversation) => {
    window.__conversationStreams.at(-1).emit('conversation', {
      data: JSON.stringify({ conversation: nextConversation }),
    });
  }, rootConversation());
  await expect(activity).toBeHidden();
  await expect(sendButton).toHaveAttribute('data-action', 'send');
  await expect(sendButton).toBeDisabled();
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
  await conversation.locator('#mobile-conversation-send').click();
  await expect.poll(() => mobileInputs).toContainEqual(expect.objectContaining({
    text: 'Review @public/mobile-conversation.js', fileMentions: ['public/mobile-conversation.js'],
  }));
  // A 202 delivery receipt is not a turn lifecycle. If the replay does not
  // echo the exact user text, mobile must still keep Send/Ready instead of
  // inventing an endless Responding + Stop state from its optimistic message.
  await expect(sendButton).toHaveAttribute('data-action', 'send');
  await expect(activity).toBeHidden();
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
  await expect(conversation.locator('[data-event-id="tool-group-1"] > .mobile-tool-group-toggle > i')).toHaveText('');
  await expect.poll(() => conversation.locator('[data-event-id="tool-group-1"]').evaluate((node) => ({
    groupBorder: getComputedStyle(node).borderTopStyle,
    groupBackground: getComputedStyle(node).backgroundColor,
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
    mutedHeading: true,
  });
  const streamedToolGroup = rootItems.find((item) => item.id === 'tool-group-1');
  streamedToolGroup.status = 'working';
  streamedToolGroup.tools.find((tool) => tool.id === 'tool-shell').status = 'working';
  await page.evaluate((nextConversation) => {
    window.__conversationStreams.at(-1).emit('conversation', {
      data: JSON.stringify({ conversation: nextConversation }),
    });
  }, rootConversation());
  await expect.poll(() => conversation.locator('[data-event-id="tool-group-1"]').evaluate((group) => {
    const groupStatus = group.querySelector(':scope > .mobile-tool-group-toggle small');
    const toolStatus = group.querySelector('[data-event-id="tool-shell"] .mobile-event-status');
    return {
      groupText: groupStatus.textContent,
      groupAnimation: getComputedStyle(groupStatus).animationName,
      toolText: toolStatus.textContent,
      toolAnimation: getComputedStyle(toolStatus, '::before').animationName,
    };
  })).toEqual({
    groupText: 'Running', groupAnimation: 'mobile-activity-spin',
    toolText: 'Running', toolAnimation: 'mobile-activity-spin',
  });
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
  await conversation.getByRole('button', { name: /Listed 1 dir, Read 2 files/ }).click();
  await expect(conversation.getByText('Turn completed')).toHaveCount(0);
  await expect(conversation.getByText('Session recap')).toHaveCount(0);
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
  await expect(subagentPill).toContainText('2 agents running');
  await expect.poll(() => conversation.evaluate((node) => {
    const pill = node.querySelector('.mobile-subagent-pill').getBoundingClientRect();
    const composer = node.querySelector('#mobile-conversation-composer').getBoundingClientRect();
    const scrollShell = node.querySelector('.mobile-conversation-scroll-shell').getBoundingClientRect();
    return {
      clearsComposer: pill.bottom <= composer.top - 8,
      staysInHistory: pill.bottom <= scrollShell.bottom,
    };
  })).toEqual({ clearsComposer: true, staysInHistory: true });
  await expect(conversation.locator('.mobile-subagent-card')).toHaveCount(0);
  await page.evaluate(() => {
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
    window.WebSocket = MockGraphicsSocket;
    window.__conversationStreams.at(-1).emit('control', {
      data: JSON.stringify({
        type: 'control', action: 'open-graphics',
        argv: ['terminal-browser', 'open', 'https://example.test'],
      }),
    });
  });
  await expect(conversation.locator('.mobile-browser-pill')).toBeVisible();
  await expect(conversation.locator('.mobile-activity-pill-cluster > button')).toHaveCount(4);
  await expect.poll(() => conversation.locator('.mobile-activity-pill-cluster').evaluate((cluster) => {
    const pill = cluster.querySelector('.mobile-browser-pill');
    const dismiss = cluster.querySelector('.mobile-activity-pill-dismiss');
    return {
      height: Math.round(cluster.getBoundingClientRect().height),
      fontSize: getComputedStyle(pill).fontSize,
      horizontalPadding: getComputedStyle(pill).paddingLeft,
      dismissWidth: Math.round(dismiss.getBoundingClientRect().width),
    };
  })).toEqual({ height: 38, fontSize: '12px', horizontalPadding: '9px', dismissWidth: 34 });
  await page.locator('#graphics-sheet-backdrop').click();
  await expect(page.locator('#graphics-split')).toBeHidden();
  await conversation.getByRole('button', { name: 'Hide activity' }).click();
  await expect(conversation.locator('.mobile-subagent-pill-host')).toBeHidden();
  const activityToggle = conversation.getByRole('button', { name: 'Show activity' });
  await expect(activityToggle).toBeVisible();
  await activityToggle.click();
  await expect(conversation.locator('.mobile-subagent-pill-host')).toBeVisible();
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
  })).toEqual({ height: 675, bottom: 0, slidesFromBelow: true });
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
  await expect(subagentPill).toContainText('2 agents running');
  Object.assign(subagentItem, { phase: 'done', status: 'completed' });
  await page.evaluate((nextConversation) => {
    window.__conversationStreams.at(-1).emit('conversation', {
      data: JSON.stringify({ conversation: nextConversation }),
    });
  }, rootConversation());
  await expect(subagentPill).toHaveCount(1);
  await expect(subagentPill).toContainText('1 agent running');
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
    id: 'tool-single-root', type: 'tool', title: 'Edited standalone.js', kind: 'edit', status: 'completed',
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
  await expect.poll(() => toolPanel.locator(':scope > .mobile-event-card').first().evaluate((node) => ({
    border: getComputedStyle(node).borderTopStyle,
    background: getComputedStyle(node).backgroundColor,
  }))).toEqual({ border: 'none', background: 'rgba(0, 0, 0, 0)' });
  const editCard = conversation.locator('[data-event-id="tool-edit-app"]');
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
    await new Promise((resolve) => setTimeout(resolve, 260));
    return { opening, start, middle, end, closing, closed: panel.hidden };
  });
  expect(childDisclosureMotion.opening).toBe('opening');
  expect(childDisclosureMotion.start).toBeLessThan(childDisclosureMotion.middle);
  expect(childDisclosureMotion.start).toBeLessThan(childDisclosureMotion.end);
  expect(childDisclosureMotion.closing).toBe('closing');
  expect(childDisclosureMotion.closed).toBe(true);
  await conversation.getByRole('button', { name: /Edited app\.js/ }).click();
  await expect(editCard.locator('.mobile-event-panel')).toBeVisible();
  await expect(editCard.locator('.mobile-event-detail')).toHaveCount(0);
  await expect(editCard.locator('.mobile-event-change')).toContainText('public/app.js');
  await expect(editCard.locator('.mobile-event-toggle .mobile-event-change-stats [data-kind="add"]')).toHaveText('+1');
  await expect(editCard.locator('.mobile-event-toggle .mobile-event-change-stats [data-kind="remove"]')).toHaveText('-1');
  await expect(editCard.locator('.mobile-event-change-line[data-kind="remove"]')).toContainText('const status = "old";');
  await expect(editCard.locator('.mobile-event-change-line[data-kind="add"]')).toContainText('const status = "ready";');
  await expect.poll(() => editCard.locator('.mobile-event-change').evaluate((node) => {
    const added = node.querySelector('[data-kind="add"]');
    const removed = node.querySelector('[data-kind="remove"]');
    return {
      addColor: getComputedStyle(node.querySelector(':scope > header .mobile-event-change-stats [data-kind="add"]')).color,
      removeColor: getComputedStyle(node.querySelector(':scope > header .mobile-event-change-stats [data-kind="remove"]')).color,
      addBackground: getComputedStyle(added).backgroundColor,
      removeBackground: getComputedStyle(removed).backgroundColor,
    };
  })).not.toEqual({
    addColor: 'rgb(0, 0, 0)', removeColor: 'rgb(0, 0, 0)',
    addBackground: 'rgba(0, 0, 0, 0)', removeBackground: 'rgba(0, 0, 0, 0)',
  });
  await conversation.locator('[data-event-id="tool-search-app"] > .mobile-event-toggle').click();
  const searchMatch = conversation.locator('.mobile-event-matches button');
  await expect(searchMatch).toContainText('render(status);');
  await searchMatch.click();
  await expect(fileSheet).toBeVisible();
  await expect(fileSheet.locator('.mobile-file-line[data-highlighted="true"]')).toHaveCount(1);
  await fileSheet.getByRole('button', { name: 'Close file preview' }).click();
  await conversation.getByRole('button', { name: /Ran node --test/ }).click();
  const shellDetail = conversation.locator('[data-event-id="tool-shell"] .mobile-tool-command');
  await expect(shellDetail.locator('.mobile-tool-command-line > i')).toHaveText('$');
  await expect(shellDetail.locator('.mobile-tool-command-line > code')).toContainText('node --test');
  await expect(shellDetail.locator('.mobile-tool-command-output')).toContainText('test output line 1');
  await expect(conversation.locator('[data-event-id="tool-shell"] .mobile-event-detail')).toHaveCount(0);
  await expect.poll(() => shellDetail.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
  await expect.poll(() => toolPanel.evaluate((panel) => panel.scrollHeight > panel.clientHeight)).toBe(true);
  const shellPanel = conversation.locator('[data-event-id="tool-shell"] > .mobile-event-panel');
  await expect.poll(() => shellPanel.evaluate((panel) => panel.scrollHeight > panel.clientHeight)).toBe(true);
  await expect.poll(() => shellPanel.evaluate((panel) => getComputedStyle(panel).overscrollBehaviorY)).toBe('auto');
  await expect.poll(() => toolPanel.evaluate((panel) => getComputedStyle(panel).overscrollBehaviorY)).toBe('auto');
  await expect.poll(() => messages.evaluate((panel) => getComputedStyle(panel).overscrollBehaviorY)).toBe('contain');

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
  await expect(conversation.getByText('Provider instructions loaded')).toBeVisible();
  await expect(conversation.locator('.mobile-subagent-pill')).toContainText('1 agent running');
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

  await input.fill('hello from phone');
  await conversation.locator('#mobile-conversation-send').click();
  await expect(conversation.locator('.mobile-message[data-pending="true"]')).toContainText('hello from phone');
  await expect(conversation.locator('.mobile-message[data-pending="true"] .mobile-message-author'))
    .toHaveText('Waiting for Grok…');
  await expect.poll(() => mobileInputs).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ text: 'hello from phone' }),
    ]),
  );
  expect(queuedInputs).toHaveLength(0);

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
  expect(compactQueueChrome.composerHeight).toBeGreaterThanOrEqual(110);
  expect(compactQueueChrome.composerHeight).toBeLessThanOrEqual(150);
  expect(compactQueueChrome.textareaMinHeight).toBeGreaterThanOrEqual(36);
  expect(compactQueueChrome.textareaMinHeight).toBeLessThanOrEqual(40);
  expect(Math.abs(compactQueueChrome.joinedGap)).toBeLessThanOrEqual(1);
  expect(Math.abs(compactQueueChrome.leftAlignment)).toBeLessThanOrEqual(1);
  expect(Math.abs(compactQueueChrome.rightAlignment)).toBeLessThanOrEqual(1);
  expect(compactQueueChrome.modeLeftBorder).toBe('1px');
  expect(compactQueueChrome.modeTopBorder).toBe('0px');
  expect(compactQueueChrome.modelBackground).toBe('rgba(0, 0, 0, 0)');
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
  expect((await steerButton.boundingBox()).height).toBeGreaterThanOrEqual(44);
  expect((await deleteButton.boundingBox()).height).toBeGreaterThanOrEqual(44);
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
  await expect(pendingSteer.locator('.mobile-message-author')).toHaveText('Waiting for Grok…');
  await expect.poll(() => messages.evaluate((node) =>
    node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThanOrEqual(1);
  await expect(conversation.locator('#mobile-conversation-jump')).toBeHidden();
  await expect(activity).not.toContainText('Stopping…');
  await expect(sendButton).toHaveAttribute('data-action', 'stop');
  await sendButton.click();
  await expect.poll(() => cancellations).toHaveLength(2);
  await expect(activity).toContainText('Stopping…');

  currentActivity = { active: false };
  await page.evaluate((nextConversation) => {
    window.__conversationStreams.at(-1).emit('conversation', { data: JSON.stringify({ conversation: nextConversation }) });
  }, rootConversation());
  await expect(activity).toBeHidden();
  await expect(sendButton).toHaveAttribute('data-action', 'send');

  await conversation.locator('#mobile-conversation-file').setInputFiles({
    name: 'phone.png', mimeType: 'image/png', buffer: Buffer.from('fake-image'),
  });
  await expect.poll(() => uploads).toContainEqual({
    name: encodeURIComponent('phone.png'), bytes: 'fake-image',
  });
  await expect(conversation.locator('.mobile-conversation-attachments img')).toHaveCount(1);
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
  expect(permissionDensity.gap).toBeLessThanOrEqual(9);
  expect(permissionDensity.buttonHeight).toBeLessThanOrEqual(48);
  const permissionTypography = await interactionDock.locator('.mobile-interaction-card').evaluate((card) => ({
    eyebrow: getComputedStyle(card.querySelector('.mobile-question-header small')).fontSize,
    title: getComputedStyle(card.querySelector('.mobile-question-header strong')).fontSize,
    status: getComputedStyle(card.querySelector('.mobile-question-status')).fontSize,
    control: getComputedStyle(card.querySelector('.mobile-permission-actions strong')).fontSize,
    caption: getComputedStyle(card.querySelector('.mobile-permission-actions small')).fontSize,
  }));
  expect(permissionTypography).toEqual({
    eyebrow: '10px', title: '16px', status: '12px', control: '14px', caption: '12px',
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
  const permissionColors = await permissionButtons.evaluateAll((buttons) => buttons.map((button) => ({
    background: getComputedStyle(button).backgroundColor,
    color: getComputedStyle(button).color,
  })));
  expect(new Set(permissionColors.map(({ background }) => background)).size).toBe(1);
  expect(new Set(permissionColors.map(({ color }) => color)).size).toBe(1);
  const permissionRestStyle = await permissionButtons.first().evaluate((button) => ({
    background: getComputedStyle(button).backgroundColor,
    border: getComputedStyle(button).borderColor,
  }));
  await permissionButtons.first().hover();
  await expect.poll(() => permissionButtons.first().evaluate((button) =>
    getComputedStyle(button).borderColor)).not.toBe(permissionRestStyle.border);
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
  await expect(conversation.locator('.mobile-permission-result')).toHaveText('Approved in Grok');
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
  expect(questionDensity.gap).toBeLessThanOrEqual(9);
  expect(questionDensity.optionPadding).toBeLessThanOrEqual(8);
  expect(questionDensity.optionMinHeight).toBeLessThanOrEqual(44);
  expect(questionDensity.actionHeight).toBeLessThanOrEqual(42);
  expect(questionDensity.emptyLiveDisplay).toBe('none');
  const questionTypography = await questionCard.evaluate((card) => ({
    eyebrow: getComputedStyle(card.querySelector('.mobile-question-header small')).fontSize,
    title: getComputedStyle(card.querySelector('.mobile-question-header strong')).fontSize,
    status: getComputedStyle(card.querySelector('.mobile-question-status')).fontSize,
    control: getComputedStyle(card.querySelector('.mobile-question-option strong')).fontSize,
    caption: getComputedStyle(card.querySelector('.mobile-question-option small')).fontSize,
  }));
  expect(questionTypography).toEqual(permissionTypography);
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
  expect(new Set(questionActionBackgrounds).size).toBe(2);
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
  await questionCard.getByRole('textbox', { name: /Other answer/ }).fill('Custom integration check');
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
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('button', { name: /Inspect mobile behavior/ })).toContainText('Done');
  await expect(sheet.getByRole('button', { name: /Review the test coverage/ })).toContainText('Running');
  await sheet.getByRole('button', { name: /Inspect mobile behavior/ }).click();
  await expect(sheet.locator('.mobile-subagent-sheet-header strong')).toHaveText('Inspect mobile behavior');
  await expect(sheet.locator('.mobile-subagent-sheet-header small')).toHaveText('explore · read-only');
  await expect(sheet.locator('.mobile-subagent-sheet-state')).toHaveText('Done');
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
  await sheet.getByRole('button', { name: 'Back to subagent list' }).click();
  await expect(sheet.getByRole('button', { name: /Review the test coverage/ })).toBeVisible();
  await sheet.getByRole('button', { name: /Review the test coverage/ }).click();
  await expect(sheet.getByText('Second subagent findings')).toBeVisible();
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
    cwd: process.cwd(), projectId: project.id, autoTitle: true,
    conversationThreadId: '01a015a9-61df-7052-a5d0-17de77a201fa', managed: true,
  };
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
      thread: { id: session.conversationThreadId, title: 'New Grok chat', agentName: 'build', status: 'idle' },
      items: [], children: [], parent: null, rootThreadId: session.conversationThreadId,
      capabilities: { send: true, children: false },
    } } });
  });
  await page.setViewportSize({ width: 390, height: 844 });
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
  await expect(page.locator('#mobile-conversation')).toContainText('Preparing chat');
  await expect(page.locator('#terminal')).toBeHidden();
  await expect(page.locator('#mobile-conversation-title')).toHaveText('New Grok chat');
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
  expect(sidebarHeaderBox.height).toBe(44);
  await expect(page.locator('.sidebar-header')).toHaveCSS('border-bottom-width', '0px');
  await expect(page.locator('.topbar')).toHaveCSS('border-bottom-width', '0px');
  await expect(page.locator('.sidebar-header #toggle-sidebar')).toBeVisible();
  await expect(page.locator('.sidebar-section-header #home-button')).toHaveText('Projects');
  await expect(page.locator('#open-sidebar')).toBeHidden();
  await page.locator('#new-project').hover();
  await expect(page.locator('#new-project')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(page.locator('#new-project')).toHaveCSS('color', 'rgb(222, 222, 224)');

  const fallbackProject = await createProject(page, { marker: '__FIRST_PROJECT__' });
  await expect(fallbackProject.locator('.project-name')).toHaveText(fallbackProjectName);
  const terminalTokens = await page.locator('#terminal').evaluate((terminal) => ({
    declaredBackground: getComputedStyle(document.documentElement)
      .getPropertyValue('--color-terminal-background').trim(),
    renderedBackground: getComputedStyle(terminal).backgroundColor,
    renderedFontSize: getComputedStyle(terminal.querySelector('.xterm-rows')).fontSize,
  }));
  expect(terminalTokens.declaredBackground).toBe('#141416');
  expect(terminalTokens.renderedBackground).toBe('rgb(20, 20, 22)');
  expect(terminalTokens.renderedFontSize).toBe('14px');
  const activeTitleBox = await page.locator('#terminal-title').boundingBox();
  const activeTopbarBox = await page.locator('.topbar').boundingBox();
  expect(activeTitleBox.x - activeTopbarBox.x).toBeLessThan(25);

  // The startup cover intentionally keeps xterm unfocusable until the shell
  // has finished its initial paint and resize cycle.
  await expect(page.locator('#session-loading')).toBeHidden({ timeout: 3_000 });
  await page.locator('#terminal .xterm-helper-textarea').focus();
  await page.keyboard.type('Build a polished project dashboard');
  await page.keyboard.press('Enter');
  await expect(fallbackProject.locator('.session-name')).toHaveText('Build a polished project dashboard');
  await expect(page.locator('#terminal-title')).toHaveText('Build a polished project dashboard');

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
  await expect(firstSessionClose).toHaveCSS('color', 'rgb(197, 157, 163)');
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
  expect(compactMetrics.emptyFont).toBeLessThanOrEqual(desktopMetrics.emptyFont);
  expect(compactMetrics.headerHeight).toBe(40);
  expect(compactMetrics.projectHeight).toBeLessThanOrEqual(40);
  expect(compactMetrics.sidebarWidth).toBeLessThanOrEqual(320);
  expect(compactMetrics.shellWidth).toBe(compactMainBeforeSidebar.shellWidth);
  await expect(page.locator('#empty-state')).toBeVisible();

  await page.setViewportSize({ width: 500, height: 700 });
  await page.waitForTimeout(350);
  await page.locator('#new-project').click();
  await expect(page.locator('#create-dialog')).toBeVisible();
  await page.waitForTimeout(220);
  const dialogBox = await page.locator('#create-dialog').boundingBox();
  expect(dialogBox.x).toBe(0);
  expect(dialogBox.width).toBe(500);
  await page.locator('#create-dialog').getByRole('button', { name: 'Close' }).click();
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

test('persists sidebar and per-chat browser split while both panes resize', async ({ page }) => {
  test.setTimeout(45_000);
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

  await page.locator('#toggle-sidebar').click();
  await expect(page.locator('.workspace')).toHaveAttribute('data-sidebar', 'collapsed');
  await expect(page.locator('#open-sidebar')).toBeVisible();
  await page.waitForTimeout(300);
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
  await expect(page.locator('.graphics-terminal-instance:not([hidden]) .xterm-rows'))
    .toContainText('__PROJECT_SPLIT__');
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
  await expect(loading).toContainText('Preparing chat');
  await expect(loading.locator('.session-loading-spinner')).toBeVisible();
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
