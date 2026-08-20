import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';

const terminalBrowserInstalled = spawnSync('terminal-browser', ['--version'], {
  encoding: 'utf8',
  timeout: 5_000,
}).status === 0;
const hostShim = join(homedir(), '.local', 'bin', 'terminal-browser');
const terminalBrowserCommand = existsSync(hostShim) ? hostShim : 'terminal-browser';
const playwrightTmux = join(process.cwd(), 'test', 'fixtures', 'tmux-playwright');

function terminalBrowsers() {
  const result = spawnSync(terminalBrowserCommand, ['ls', '--all', '--json'], {
    encoding: 'utf8',
    timeout: 5_000,
  });
  if (result.status !== 0) return [];
  try { return JSON.parse(result.stdout).browsers || []; }
  catch { return []; }
}

function terminalBrowserAction(browserKey, ...args) {
  return spawnSync(terminalBrowserCommand, ['action', '--browser', browserKey, '--', ...args], {
    encoding: 'utf8',
    timeout: 10_000,
  });
}

function tmuxPaneCount(session) {
  const result = spawnSync(playwrightTmux, ['list-panes', '-t', session, '-F', '#{pane_id}'], {
    encoding: 'utf8',
    timeout: 5_000,
  });
  return result.status === 0 ? result.stdout.trim().split('\n').filter(Boolean).length : 0;
}

function tmuxStatus(session) {
  const result = spawnSync(playwrightTmux, ['show-options', '-v', '-t', session, 'status'], {
    encoding: 'utf8',
    timeout: 5_000,
  });
  return result.status === 0 ? result.stdout.trim() : '';
}

test('agent terminal-browser command opens a rendered web split on the right', async ({ page }) => {
  test.setTimeout(75_000);
  test.skip(!terminalBrowserInstalled, 'terminal-browser is not installed');

  await page.goto('/');
  const origin = new URL(page.url()).origin;
  const sessionName = `browser-agent-${Date.now()}`;
  let managedName;
  try {
    managedName = await page.evaluate(async ({ sessionName, cwd }) => {
      const response = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ commandLine: "printf '__AGENT_READY__\\r\\n'", name: sessionName, cwd }),
      });
      if (!response.ok) throw new Error(await response.text());
      return (await response.json()).session.name;
    }, { sessionName, cwd: process.cwd() });
    await page.reload();
    await page.locator('.session-row').filter({ hasText: sessionName }).locator('.session-button').click();
    await expect(page.locator('#terminal-title')).toHaveText(sessionName);
    await expect(page.locator('#status')).toHaveAttribute('data-state', 'connected');
    await expect(page.locator('#terminal .xterm-rows')).toContainText('__AGENT_READY__');
    await expect.poll(() => tmuxStatus(managedName)).toBe('off');
    await page.waitForTimeout(1_000);

    await page.locator('#terminal').click();
    await page.keyboard.type(
      `env -u AGENT_REMOTE_WEB -u AGENT_REMOTE_SESSION -u TMUX -u TMUX_PANE ` +
      `TERM=dumb TMUX_COMMAND=/usr/bin/false AGENT_REMOTE_URL=${origin} ` +
      `${terminalBrowserCommand} open ${origin}/health --split right`,
    );
    await page.keyboard.press('Enter');

    await expect(page.locator('#graphics-split')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#graphics-split')).toHaveAttribute('data-control-transport', 'backend');
    const loading = page.locator('.graphics-terminal-instance:not([hidden]) .graphics-loading');
    await expect(loading).toBeVisible();
    await expect(loading).toContainText('Opening terminal-browser');
    await expect.poll(() => page.locator('.graphics-terminal-instance:not([hidden]) .browser-viewport')
      .evaluate((viewport) => viewport.clientWidth > 300 && viewport.clientHeight > 200),
    { timeout: 5_000 }).toBe(true);
    await expect(page.locator('.graphics-terminal-instance:not([hidden]) .graphics-terminal-transport'))
      .toHaveCSS('visibility', 'hidden');
    await expect(page.locator('.graphics-terminal-instance:not([hidden])'))
      .toHaveAttribute('data-render-mode', 'direct', { timeout: 60_000 });
    await expect.poll(() => page.locator('.graphics-terminal-instance:not([hidden]) .browser-frame')
      .evaluate((canvas) => canvas.width > 0 && canvas.height > 0), { timeout: 15_000 }).toBe(true);
    await expect(page.locator('.graphics-terminal-instance:not([hidden]) .graphics-terminal-transport'))
      .toHaveCSS('visibility', 'hidden');
    await expect(loading).toBeHidden();
    await expect(page.locator('.graphics-terminal-instance:not([hidden]) .browser-toolbar')).toBeVisible();
    await expect(page.locator('.graphics-terminal-instance:not([hidden]) .browser-tab')).toHaveCount(1);
    await expect(page.locator('#graphics-terminal .xterm-rows')).not.toContainText('\u{10EEEE}');
    // tmux may repaint cursor-addressed cells while the browser pane starts,
    // so the DOM text is not guaranteed to stay contiguous. The two stable
    // fragment plus the live pane assertions above verify the command path.
    await expect(page.locator('#terminal .xterm-rows')).toContainText('Opened terminal-browser');

    const pane = await page.locator('#graphics-terminal').boundingBox();
    expect(pane).not.toBeNull();
    let observedBrowser;
    await expect.poll(() => {
      observedBrowser = terminalBrowsers().find((item) =>
        item.tabs?.some((tab) => tab.url.startsWith(`${origin}/health`)),
      );
      return Boolean(observedBrowser);
    }, { timeout: 10_000 }).toBe(true);
    await expect.poll(() => page.locator('.graphics-terminal-instance:not([hidden]) .browser-frame')
      .evaluate((canvas, minimum) => canvas.width >= minimum.width && canvas.height >= minimum.height, {
        width: pane.width * 0.75,
        height: pane.height * 0.75,
      }),
    { timeout: 20_000 }).toBe(true);
    await expect.poll(() => page.locator('.graphics-terminal-instance:not([hidden])')
      .evaluate((host) => Number(host.dataset.frameScale || 0)), { timeout: 20_000 }).toBeGreaterThanOrEqual(0.95);

    const browserFrame = page.locator('.graphics-terminal-instance:not([hidden]) .browser-frame');
    const graphicsHost = page.locator('.graphics-terminal-instance:not([hidden])');
    const keyboardFixture = terminalBrowserAction(
      observedBrowser.key,
      'eval',
      `document.body.innerHTML='<form id="keyboard-form"><input id="keyboard-input"><button id="keyboard-next">Next</button><output id="keyboard-output"></output></form>'; ` +
        `window.__keyboardKeys=[]; ` +
        `document.querySelector('#keyboard-input').addEventListener('keydown',event=>window.__keyboardKeys.push(event.key)); ` +
        `document.querySelector('#keyboard-form').addEventListener('submit',event=>{event.preventDefault();document.querySelector('#keyboard-output').textContent=document.querySelector('#keyboard-input').value}); ` +
        `document.querySelector('#keyboard-input').focus(); 'keyboard-ready'`,
    );
    expect(keyboardFixture.status, keyboardFixture.stderr).toBe(0);
    await page.locator('.graphics-terminal-instance:not([hidden]) .browser-surface').focus();
    await page.keyboard.type('ab cd');
    await page.keyboard.press('Home');
    await page.keyboard.press('Delete');
    await page.keyboard.press('End');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Space');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    await expect.poll(() => {
      const result = terminalBrowserAction(
        observedBrowser.key,
        'eval',
        `JSON.stringify({value:document.querySelector('#keyboard-input').value,` +
          `submitted:document.querySelector('#keyboard-output').textContent,` +
          `active:document.activeElement.id,keys:window.__keyboardKeys})`,
      );
      return result.stdout;
    }, { timeout: 10_000 }).toContain('\\"value\\":\\"b c \\"');
    const keyboardResult = terminalBrowserAction(
      observedBrowser.key,
      'eval',
      `JSON.stringify({submitted:document.querySelector('#keyboard-output').textContent,` +
        `active:document.activeElement.id,keys:window.__keyboardKeys})`,
    );
    expect(keyboardResult.stdout).toContain('\\"submitted\\":\\"b c \\"');
    expect(keyboardResult.stdout).toContain('\\"active\\":\\"keyboard-next\\"');
    for (const key of ['Home', 'Delete', 'End', 'Backspace', ' ', 'Enter', 'Tab']) {
      expect(keyboardResult.stdout).toContain(`\\"${key}\\"`);
    }
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await page.keyboard.type('z');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Escape');
    await expect.poll(() => {
      const result = terminalBrowserAction(
        observedBrowser.key,
        'eval',
        `JSON.stringify({value:document.querySelector('#keyboard-input').value,` +
          `active:document.activeElement.id,keys:window.__keyboardKeys})`,
      );
      return result.stdout;
    }, { timeout: 10_000 }).toContain('\\"value\\":\\"z\\"');

    const frameBeforeNavigationFixture = Number(await graphicsHost.getAttribute('data-frame-version') || 0);
    const navigationFixture = terminalBrowserAction(
      observedBrowser.key,
      'eval',
      `document.body.innerHTML='<a id="navigate-test" href="${origin}/health" ` +
        `style="position:fixed;inset:0;display:block;background:#17221b;color:white">Navigate</a>'; ` +
        `'navigation-ready'`,
    );
    expect(navigationFixture.status, navigationFixture.stderr).toBe(0);
    await expect.poll(() => graphicsHost.evaluate((host, before) =>
      Number(host.dataset.frameVersion || 0) - before, frameBeforeNavigationFixture),
    { timeout: 10_000 }).toBeGreaterThan(0);
    const viewportGenerationBeforeNavigation = Number(
      await graphicsHost.getAttribute('data-frame-viewport-generation') || 0,
    );
    const frameBeforeNavigation = Number(await graphicsHost.getAttribute('data-frame-version') || 0);
    await browserFrame.click({ position: { x: 40, y: 40 } });
    await expect.poll(() => {
      const result = terminalBrowserAction(observedBrowser.key, 'eval', 'location.pathname');
      return result.stdout;
    }, { timeout: 10_000 }).toContain('/health');
    await expect.poll(() => graphicsHost.evaluate((host, before) =>
      Number(host.dataset.frameVersion || 0) - before, frameBeforeNavigation),
    { timeout: 10_000 }).toBeGreaterThan(0);
    await expect.poll(() => graphicsHost.evaluate((host) =>
      Number(host.dataset.frameViewportGeneration || 0)), { timeout: 10_000 })
      .toBeGreaterThan(viewportGenerationBeforeNavigation);
    const requestedViewport = await graphicsHost.getAttribute('data-requested-viewport');
    const navigatedViewport = terminalBrowserAction(
      observedBrowser.key, 'eval', '`${innerWidth}x${innerHeight}`',
    );
    expect(navigatedViewport.status, navigatedViewport.stderr).toBe(0);
    expect(navigatedViewport.stdout).toContain(requestedViewport);
    await expect.poll(() => browserFrame.evaluate((canvas) => {
      const viewport = canvas.parentElement;
      if (!canvas.width || !canvas.height || !viewport?.clientWidth || !viewport.clientHeight) return false;
      return Math.abs((canvas.width / canvas.height) -
        (viewport.clientWidth / viewport.clientHeight)) < 0.02;
    }), { timeout: 10_000 }).toBe(true);

    const frameBeforeCursorFixture = Number(await graphicsHost.getAttribute('data-frame-version') || 0);
    const cursorFixture = terminalBrowserAction(
      observedBrowser.key,
      'eval',
      "document.body.innerHTML='<button id=\"cursor-test\" style=\"cursor:pointer;width:180px;height:90px\">Hover target</button><input id=\"cursor-text\" style=\"display:block;width:180px;height:60px\">'; 'cursor-ready'",
    );
    expect(cursorFixture.status, cursorFixture.stderr).toBe(0);
    expect(cursorFixture.stdout).toContain('cursor-ready');
    const cursorHitTest = terminalBrowserAction(
      observedBrowser.key,
      'eval',
      "JSON.stringify([document.elementFromPoint(30,30)?.id, getComputedStyle(document.elementFromPoint(30,30)).cursor])",
    );
    expect(cursorHitTest.status, cursorHitTest.stderr).toBe(0);
    expect(cursorHitTest.stdout).toContain('[\\"cursor-test\\",\\"pointer\\"]');
    await expect.poll(() => graphicsHost.evaluate((host) => Number(host.dataset.frameVersion || 0)), {
      timeout: 10_000,
    }).toBeGreaterThan(frameBeforeCursorFixture);
    await page.mouse.move(0, 0);
    await browserFrame.hover({ position: { x: 30, y: 30 } });
    await expect(browserFrame).toHaveCSS('cursor', 'pointer', { timeout: 10_000 });
    await browserFrame.hover({ position: { x: 30, y: 110 } });
    await expect(browserFrame).toHaveCSS('cursor', 'text', { timeout: 10_000 });
    await browserFrame.hover({ position: { x: 300, y: 200 } });
    await expect(browserFrame).toHaveCSS('cursor', 'default', { timeout: 10_000 });

    const frameBeforeMotion = Number(await graphicsHost.getAttribute('data-frame-version') || 0);
    await graphicsHost.evaluate((host) => {
      window.__agentRemoteFrameQualitySamples = [];
      new MutationObserver(() => {
        window.__agentRemoteFrameQualitySamples.push({
          version: Number(host.dataset.frameVersion || 0),
          scale: Number(host.dataset.frameScale || 0),
          at: performance.now(),
        });
      }).observe(host, { attributes: true, attributeFilter: ['data-frame-version'] });
    });
    const motionFixture = terminalBrowserAction(
      observedBrowser.key,
      'eval',
      "(() => { const end = performance.now() + 1600; let hue = 0; function tick() { " +
        "document.body.style.backgroundColor = `hsl(${hue++ % 360} 20% 12%)`; " +
        "if (performance.now() < end) requestAnimationFrame(tick); } tick(); return 'motion-started'; })()",
    );
    expect(motionFixture.status, motionFixture.stderr).toBe(0);
    expect(motionFixture.stdout).toContain('motion-started');
    await expect.poll(() => graphicsHost.evaluate((host, before) =>
      Number(host.dataset.frameVersion || 0) - before, frameBeforeMotion),
    { timeout: 1_300, intervals: [100] }).toBeGreaterThanOrEqual(16);
    await expect.poll(() => graphicsHost.evaluate((host) => Number(host.dataset.frameScale || 0)), {
      timeout: 5_000,
    }).toBeGreaterThanOrEqual(0.95);
    const qualitySamples = await graphicsHost.evaluate(() => window.__agentRemoteFrameQualitySamples);
    expect(qualitySamples.length).toBeGreaterThanOrEqual(16);
    expect(Math.min(...qualitySamples.map((sample) => sample.scale))).toBeGreaterThanOrEqual(0.95);
    expect(Math.max(...qualitySamples.map((sample) => sample.scale))).toBeLessThanOrEqual(1.05);
    await page.waitForTimeout(600);
    await expect.poll(() => graphicsHost.evaluate((host) => Number(host.dataset.frameScale || 0)), {
      timeout: 5_000,
    }).toBeGreaterThanOrEqual(0.95);

    const toolbar = page.locator('.graphics-terminal-instance:not([hidden]) .browser-toolbar');
    const inspect = toolbar.locator('.browser-inspect');
    await expect(inspect).toBeVisible();
    await inspect.click();
    await expect(inspect).toHaveAttribute('aria-pressed', 'true');
    const devtoolsPane = page.locator('.graphics-terminal-instance:not([hidden]) .browser-inspector');
    const devtoolsFrame = page.locator('.graphics-terminal-instance:not([hidden]) .browser-devtools-frame');
    await expect(devtoolsPane).toBeVisible({ timeout: 10_000 });
    await expect(devtoolsFrame).toHaveAttribute('src', /\/devtools\/.*\/inspector\.html\?.*ws=/);
    const devtools = page.frameLocator('.graphics-terminal-instance:not([hidden]) .browser-devtools-frame');
    await expect(devtools.getByText('Elements', { exact: true }).first()).toBeVisible({ timeout: 20_000 });
    await expect(devtools.getByText('Console', { exact: true }).first()).toBeVisible();
    await expect(devtools.locator('html')).toHaveAttribute('data-agent-remote-screencast', 'disabled');
    await expect(devtools.locator('[aria-label="Screencast view of debug target"]')).toBeHidden();
    await expect(devtools.getByRole('button', { name: 'Toggle screencast' })).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => browserFrame.evaluate((canvas) => {
      const viewport = canvas.parentElement;
      if (!canvas.width || !canvas.height || !viewport?.clientWidth || !viewport.clientHeight) return false;
      return Math.abs((canvas.width / canvas.height) -
        (viewport.clientWidth / viewport.clientHeight)) < 0.02;
    }), { timeout: 10_000 }).toBe(true);
    const elementPicker = devtools.getByRole('button', { name: /Select an element in the page to inspect it/ });
    await expect(elementPicker).toBeVisible();
    await elementPicker.click();
    await browserFrame.click({ position: { x: 30, y: 30 } });
    await expect(devtools.locator('.elements-tree-outline .selected'))
      .toContainText(/cursor-test/, { timeout: 10_000 });
    await page.locator('.graphics-terminal-instance:not([hidden]) .browser-inspector-header button').click();
    await expect(devtoolsPane).toBeHidden();
    await expect(inspect).toHaveAttribute('aria-pressed', 'false');

    await expect.poll(() => browserFrame.evaluate((canvas) => {
      const viewport = canvas.parentElement;
      if (!canvas.width || !canvas.height || !viewport?.clientWidth || !viewport.clientHeight) return 'not-ready';
      const frameRatio = canvas.width / canvas.height;
      const viewportRatio = viewport.clientWidth / viewport.clientHeight;
      if (Math.abs(frameRatio - viewportRatio) < 0.02) return 'matched';
      const host = canvas.closest('.graphics-terminal-instance');
      return `${canvas.width}x${canvas.height}/${viewport.clientWidth}x${viewport.clientHeight}` +
        ` requested=${host?.dataset.requestedViewport} frame=${host?.dataset.frameViewport}`;
    }), { timeout: 10_000 }).toBe('matched');

    const frameBeforeScrollFixture = Number(await graphicsHost.getAttribute('data-frame-version') || 0);
    const scrollFixture = terminalBrowserAction(
      observedBrowser.key,
      'eval',
      "document.documentElement.style.background='#143c28'; document.body.style='margin:0;background:#143c28'; " +
        "document.body.innerHTML='<main style=\"height:100vh;background:#782828\"></main>' + " +
        "'<main style=\"height:100vh;background:#149646\"></main>'; scrollTo(0,0); 'scroll-ready'",
    );
    expect(scrollFixture.status, scrollFixture.stderr).toBe(0);
    expect(scrollFixture.stdout).toContain('scroll-ready');
    await expect.poll(() => graphicsHost.evaluate((host, before) =>
      Number(host.dataset.frameVersion || 0) - before, frameBeforeScrollFixture), { timeout: 10_000 }).toBeGreaterThan(0);
    await browserFrame.hover();
    await page.mouse.wheel(0, 10_000);
    await expect.poll(() => {
      const result = terminalBrowserAction(observedBrowser.key, 'eval', 'Math.round(scrollY)');
      return Number(result.stdout.match(/\d+/)?.[0] || 0);
    }, { timeout: 10_000 }).toBeGreaterThan(300);
    await expect.poll(() => graphicsHost.evaluate((host) => Number(host.dataset.frameScale || 0)), {
      timeout: 5_000,
    }).toBeGreaterThanOrEqual(0.95);
    await expect.poll(() => browserFrame.evaluate((canvas) => {
      const context = canvas.getContext('2d');
      const pixel = context.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height * 0.1), 1, 1).data;
      if (pixel[1] > 80 && pixel[1] > pixel[0] * 2) return 'green';
      const host = canvas.closest('.graphics-terminal-instance');
      return `rgba(${[...pixel].join(',')}) scale=${host?.dataset.frameScale} ` +
        `viewport=${host?.dataset.frameViewport}`;
    }), { timeout: 5_000 }).toBe('green');

    const record = toolbar.locator('.browser-record');
    const recordingDownload = page.waitForEvent('download');
    await record.click();
    await expect(record).toHaveAttribute('aria-pressed', 'true');
    await page.waitForTimeout(1_000);
    await record.click();
    const download = await recordingDownload;
    expect(download.suggestedFilename()).toMatch(/\.webm$/);
    const recordingPath = await download.path();
    expect(recordingPath && statSync(recordingPath).size).toBeGreaterThan(0);
    await expect(record).toHaveAttribute('aria-pressed', 'false');

    const panesBeforeNewTab = tmuxPaneCount(managedName);
    await page.locator('#terminal').click();
    await page.keyboard.type(`${terminalBrowserCommand} action -- eval '424200+42'`);
    await page.keyboard.press('Enter');
    await expect(page.locator('#terminal .xterm-rows')).toContainText('424242', { timeout: 10_000 });

    await page.locator('#terminal').click();
    await page.keyboard.type(`${terminalBrowserCommand} new-tab ${origin}/health`);
    await page.keyboard.press('Enter');
    await expect(page.locator('#terminal .xterm-rows'))
      .toContainText('Focused the existing agent-remote browser tab.', { timeout: 10_000 });
    await expect(toolbar.locator('.browser-tab')).toHaveCount(1);
    await expect.poll(() => terminalBrowsers().find((item) => item.key === observedBrowser.key)?.tabs?.length)
      .toBe(1);

    await page.locator('#terminal').click();
    await page.keyboard.type(`${terminalBrowserCommand} new-tab about:blank`);
    await page.keyboard.press('Enter');
    await expect(page.locator('#terminal .xterm-rows'))
      .toContainText('Opened a new tab in the existing agent-remote browser pane.', { timeout: 10_000 });
    await expect(toolbar.locator('.browser-tab')).toHaveCount(2, { timeout: 10_000 });
    await expect.poll(() => terminalBrowsers().find((item) => item.key === observedBrowser.key)?.tabs?.length)
      .toBe(2);
    expect(tmuxPaneCount(managedName)).toBe(panesBeforeNewTab);
    await toolbar.locator('.browser-tab').nth(1).locator('.browser-tab-close').click();
    await expect(toolbar.locator('.browser-tab')).toHaveCount(1, { timeout: 10_000 });

    await toolbar.locator('.browser-new-tab').click();
    await expect(toolbar.locator('.browser-tab')).toHaveCount(2, { timeout: 10_000 });
    await expect(toolbar.locator('.browser-tab').nth(1)).toHaveAttribute('data-active', 'true');
    await toolbar.locator('.browser-tab').first().locator('.browser-tab-select').click();
    await expect(toolbar.locator('.browser-tab').first()).toHaveAttribute('data-active', 'true');
    await toolbar.locator('.browser-tab').nth(1).locator('.browser-tab-select').click();
    await expect(toolbar.locator('.browser-tab').nth(1)).toHaveAttribute('data-active', 'true');
    await toolbar.locator('.browser-tab').nth(1).locator('.browser-tab-close').click();
    await expect(toolbar.locator('.browser-tab')).toHaveCount(1, { timeout: 10_000 });
    await expect(toolbar.locator('.browser-tab').first()).toHaveAttribute('data-active', 'true');
    await expect.poll(() => terminalBrowsers().find((item) => item.key === observedBrowser.key)?.tabs?.length)
      .toBe(1);

    const firstHost = await graphicsHost.elementHandle();
    await page.locator('#terminal').click();
    await page.keyboard.type(`${terminalBrowserCommand} open ${origin}/health --split right`);
    await page.keyboard.press('Enter');
    await expect.poll(async () => {
      const current = await page.locator('.graphics-terminal-instance:not([hidden])').elementHandle();
      return Boolean(current && firstHost && !(await current.evaluate((node, previous) => node === previous, firstHost)));
    }, { timeout: 15_000 }).toBe(true);
    await expect(page.locator('.graphics-terminal-instance:not([hidden]) .graphics-loading')).toBeHidden({ timeout: 60_000 });
    await expect.poll(() => page.locator('.graphics-terminal-instance:not([hidden]) .browser-frame')
      .evaluate((canvas) => {
        const viewport = canvas.parentElement;
        if (!canvas.width || !canvas.height || !viewport?.clientWidth || !viewport.clientHeight) return false;
        return Math.abs((canvas.width / canvas.height) -
          (viewport.clientWidth / viewport.clientHeight)) < 0.02;
      }), { timeout: 20_000 }).toBe(true);
    await expect.poll(() => page.locator('.graphics-terminal-instance:not([hidden])')
      .evaluate((host) => Number(host.dataset.frameScale || 0)), { timeout: 20_000 }).toBeGreaterThanOrEqual(0.95);
    await expect.poll(() => {
      const matching = terminalBrowsers().filter((item) =>
        item.tabs?.some((tab) => tab.url.startsWith(`${origin}/health`)),
      );
      [observedBrowser] = matching;
      return matching.length;
    }, { timeout: 15_000 }).toBe(1);
    await expect.poll(async () => {
      const payload = await (await page.request.get('/api/renderers')).json();
      return payload.renderers.filter((renderer) => renderer.key === `session:${managedName}`).length;
    }).toBe(1);

    await page.reload();
    await expect(page.locator('#terminal')).toBeVisible({ timeout: 2_000 });
    await expect(page.locator('#status')).toHaveAttribute('data-state', 'connected', { timeout: 2_000 });
    await expect(page.locator('#session-loading')).toBeHidden({ timeout: 2_000 });
    await expect(page.locator('#terminal .xterm-rows')).toContainText('Opened terminal-browser', { timeout: 2_000 });
    await expect(page.locator('#graphics-split')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.graphics-terminal-instance:not([hidden])'))
      .toHaveAttribute('data-render-mode', 'direct', { timeout: 10_000 });
    await expect.poll(() => page.locator('.graphics-terminal-instance:not([hidden]) .browser-frame')
      .evaluate((canvas) => canvas.width > 0 && canvas.height > 0), { timeout: 10_000 }).toBe(true);
    await expect(page.locator('.graphics-terminal-instance:not([hidden]) .browser-tab')).toHaveCount(1);

    await page.setViewportSize({ width: 390, height: 844 });
    const mobileSheet = page.locator('#graphics-split');
    await expect(mobileSheet).toBeVisible();
    await expect(page.locator('#graphics-sheet-handle')).toBeVisible();
    await expect(page.locator('#graphics-sheet-backdrop')).toBeVisible();
    await expect.poll(async () => {
      const box = await mobileSheet.boundingBox();
      if (!box) return undefined;
      const animation = await mobileSheet.evaluate((sheet) => {
        const keyframes = [...document.styleSheets].flatMap((styleSheet) => [...styleSheet.cssRules])
          .find((rule) => rule.type === CSSRule.KEYFRAMES_RULE && rule.name === 'mobile-sheet-in');
        const firstFrame = keyframes && [...keyframes.cssRules].find((rule) =>
          rule.keyText === 'from' || rule.keyText === '0%');
        return Boolean(firstFrame?.style.transform && firstFrame.style.transform !== 'none');
      });
      return {
        height: Math.round(box.height),
        bottom: Math.round(844 - box.y - box.height),
        slidesFromBelow: animation,
      };
    }).toEqual({ height: 591, bottom: 0, slidesFromBelow: true });
    const handle = await page.locator('#graphics-sheet-handle').boundingBox();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + 140, { steps: 4 });
    await page.mouse.up();
    await expect(mobileSheet).toBeHidden();
    await expect(page.locator('#graphics-mobile-reopen')).toBeVisible();
    await expect.poll(async () => {
      const payload = await (await page.request.get('/api/renderers')).json();
      return payload.renderers.some((renderer) => renderer.key === `session:${managedName}`);
    }).toBe(true);
    await page.locator('#graphics-mobile-reopen').click();
    await expect(mobileSheet).toBeVisible();
    await page.locator('#close-graphics-split').click();
    await expect(page.locator('#graphics-split')).toBeHidden();
    await expect(page.locator('#graphics-mobile-reopen')).toBeHidden();
    await expect.poll(async () => {
      const payload = await (await page.request.get('/api/renderers')).json();
      return payload.renderers.some((renderer) => renderer.key === `session:${managedName}`);
    }, { timeout: 10_000 }).toBe(false);
    await expect.poll(() => terminalBrowsers().some((item) =>
      item.tabs?.some((tab) => tab.url.startsWith(`${origin}/health`)),
    ), { timeout: 10_000 }).toBe(false);
  } finally {
    if (managedName) await page.request.delete(`/api/sessions/${encodeURIComponent(managedName)}`).catch(() => {});
  }
});
