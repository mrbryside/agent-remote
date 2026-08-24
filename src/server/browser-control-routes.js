import { WebSocket } from 'ws';
import { canonicalBrowserUrl } from './renderer-protocol.js';
import { json, readJson } from './http.js';

function controlTargetError(body) {
  if (body.threadId !== undefined &&
      (typeof body.threadId !== 'string' || !body.threadId || body.threadId.length > 160)) {
    return 'threadId must be a non-empty string under 160 characters';
  }
  if (body.session !== undefined && (typeof body.session !== 'string' || body.session.length > 64)) {
    return 'session must be a string under 64 characters';
  }
  if (body.cwd !== undefined && (typeof body.cwd !== 'string' || !body.cwd || body.cwd.length > 4096)) {
    return 'cwd must be a non-empty string under 4096 characters';
  }
  return undefined;
}

function closeRequestFromAction(argv) {
  const separator = argv.indexOf('--');
  const command = separator >= 0 ? argv.slice(separator + 1) : argv;
  if (command.length !== 2 || command[0] !== 'eval' ||
      !/^(?:window\.)?close\(\);?$/.test(command[1].trim())) return undefined;
  const selectors = separator >= 0 ? argv.slice(0, separator) : [];
  let tab;
  for (let index = 0; index < selectors.length; index += 1) {
    if (selectors[index] === '--tab') tab = Number(selectors[++index]);
    else if (selectors[index].startsWith('--tab=')) tab = Number(selectors[index].slice(6));
  }
  return Number.isInteger(tab) && tab > 0 ? [tab] : [];
}

async function waitForRendererReady({
  rendererStateForSession, session, previousRenderer, previousGeneration, acceptPrevious, timeoutMs,
}) {
  const deadline = Date.now() + timeoutMs;
  let observedLaunch = Boolean(acceptPrevious);
  while (Date.now() < deadline) {
    const renderer = rendererStateForSession(session);
    if (renderer && (renderer !== previousRenderer || renderer.launchGeneration > previousGeneration)) {
      observedLaunch = true;
    }
    if (observedLaunch && renderer?.state === 'failed') {
      throw new Error(renderer.stateMessage || 'terminal-browser failed to open');
    }
    if (observedLaunch && renderer?.state === 'ready' && renderer.browserKey && renderer.surface) {
      return renderer;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const error = new Error('terminal-browser did not become ready before the launch deadline');
  error.code = 'BROWSER_READY_TIMEOUT';
  throw error;
}

export function createBrowserControlRouteHandler({
  resolveControlSession,
  clients,
  clientContexts,
  conversationStreams,
  rendererForSession,
  rendererStateForSession,
  controlRendererTab,
  closeRendererTabs,
  closeRenderer,
  restoreRendererViewport,
  controlTerminalBrowser,
  browserListing,
  executeBrowserAction,
  browserOpenReadyTimeoutMs = 55_000,
}) {
  return async function handleBrowserControlRoute({ request, response, url, pathname }) {
    if (request.method === 'POST' && pathname === '/api/control/split') {
      const body = await readJson(request);
      if (!Array.isArray(body.argv) || body.argv.length === 0 || body.argv.length > 100 ||
          body.argv.some((argument) => typeof argument !== 'string' || argument.length > 4096)) {
        json(response, 400, { error: 'argv must contain 1-100 strings under 4096 characters' });
        return true;
      }
      if (body.waitForReady !== undefined && typeof body.waitForReady !== 'boolean') {
        json(response, 400, { error: 'waitForReady must be a boolean' });
        return true;
      }
      const targetError = controlTargetError(body);
      if (targetError) {
        json(response, 400, { error: targetError });
        return true;
      }
      const resolved = await resolveControlSession(body);
      if (resolved.error) {
        json(response, 409, { error: resolved.error });
        return true;
      }
      const targets = [...clients].filter((client) => {
        const context = clientContexts.get(client);
        return client.readyState === WebSocket.OPEN && context?.mode !== 'graphics' &&
          (!resolved.session || context?.session === resolved.session);
      });
      const streams = [...conversationStreams].filter((stream) =>
        !resolved.session || stream.sessionName === resolved.session);
      const previousRenderer = rendererStateForSession(resolved.session);
      const previousGeneration = previousRenderer?.launchGeneration || 0;
      const reusable = Boolean(previousRenderer?.launchSignature &&
        ['starting', 'ready'].includes(previousRenderer.state));
      const alreadyReady = Boolean(reusable && previousRenderer.state === 'ready' &&
        previousRenderer.browserKey && previousRenderer.surface && previousRenderer.browserSocket);
      const control = {
        type: 'control', action: 'open-graphics', argv: body.argv,
        ...(reusable ? { reuseExisting: true } : {}),
      };
      // Reusing a healthy renderer does not require the main chat socket to be
      // online at this exact millisecond. Mobile Safari can briefly reconnect
      // that socket while the dedicated renderer socket remains healthy; the
      // old ordering rejected the command before noticing the live browser.
      if (targets.length === 0 && streams.length === 0 && !alreadyReady) {
        json(response, 409, {
          error: resolved.session
            ? `No browser is connected to session ${resolved.session}`
            : 'No browser is connected to that session',
        });
        return true;
      }
      for (const client of targets) client.send(JSON.stringify(control));
      for (const stream of streams) stream.sendControl?.(control);
      const delivered = targets.length + streams.length;
      if (alreadyReady) {
        json(response, body.waitForReady ? 200 : 202, {
          delivered, session: resolved.session, opened: false, reused: true,
          renderer: previousRenderer.key, browserKey: previousRenderer.browserKey,
        });
        return true;
      }
      if (!body.waitForReady) {
        json(response, 202, { delivered, session: resolved.session });
        return true;
      }
      try {
        const renderer = await waitForRendererReady({
          rendererStateForSession,
          session: resolved.session,
          previousRenderer,
          previousGeneration,
          acceptPrevious: reusable,
          timeoutMs: browserOpenReadyTimeoutMs,
        });
        json(response, 200, {
          delivered, session: resolved.session, opened: true,
          renderer: renderer.key, browserKey: renderer.browserKey,
        });
      } catch (error) {
        json(response, error.code === 'BROWSER_READY_TIMEOUT' ? 504 : 502, {
          error: error.message || 'terminal-browser failed to open',
        });
      }
      return true;
    }

    if (request.method === 'POST' && pathname === '/api/control/browser-action') {
      const body = await readJson(request);
      if (!Array.isArray(body.argv) || body.argv.length === 0 || body.argv.length > 100 ||
          body.argv.some((argument) => typeof argument !== 'string' || argument.length > 4096)) {
        json(response, 400, { error: 'argv must contain 1-100 strings under 4096 characters' });
        return true;
      }
      const targetError = controlTargetError(body);
      if (targetError) {
        json(response, 400, { error: targetError });
        return true;
      }
      const resolved = await resolveControlSession(body);
      if (resolved.error) {
        json(response, 409, { error: resolved.error });
        return true;
      }
      const renderer = rendererForSession(resolved.session);
      if (!renderer) {
        json(response, 409, { error: 'No terminal-browser is open for that session' });
        return true;
      }
      try {
        const closeTabs = closeRequestFromAction(body.argv);
        if (closeTabs) {
          const closed = await closeRendererTabs(renderer, closeTabs);
          if (closed.rendererClosed) closeRenderer(renderer.key, 'Last browser tab closed', false, renderer);
          const label = closed.closed.length === 1 ? `tab ${closed.closed[0]}` : `${closed.closed.length} tabs`;
          json(response, 200, {
            stdout: `Closed browser ${label}.\n`, stderr: '', ...closed,
          });
          return true;
        }
        const result = await executeBrowserAction(renderer.browserKey, body.argv);
        await restoreRendererViewport(renderer);
        json(response, 200, {
          stdout: String(result?.stdout || '').slice(0, 8 * 1024 * 1024),
          stderr: String(result?.stderr || '').slice(0, 64 * 1024),
        });
      } catch (error) {
        const detail = String(error?.stderr || error?.message || 'terminal-browser action failed').trim();
        json(response, 502, { error: detail.slice(0, 4_096) || 'terminal-browser action failed' });
      }
      return true;
    }

    if (request.method === 'POST' && pathname === '/api/control/browser-tab') {
      const body = await readJson(request);
      if (!['new-tab', 'close-tab'].includes(body.action)) {
        json(response, 400, { error: 'Unsupported browser tab action' });
        return true;
      }
      if (body.action === 'new-tab' && body.url !== undefined &&
          (typeof body.url !== 'string' || body.url.length > 4096)) {
        json(response, 400, { error: 'url must be a string under 4096 characters' });
        return true;
      }
      if (body.action === 'close-tab' && body.tabs !== undefined &&
          (!Array.isArray(body.tabs) || body.tabs.length > 100 ||
            body.tabs.some((tab) => !Number.isInteger(tab) || tab <= 0 || tab > Number.MAX_SAFE_INTEGER))) {
        json(response, 400, { error: 'tabs must contain up to 100 positive integer tab ids' });
        return true;
      }
      const targetError = controlTargetError(body);
      if (targetError) {
        json(response, 400, { error: targetError });
        return true;
      }
      const resolved = await resolveControlSession(body);
      if (resolved.error) {
        json(response, 409, { error: resolved.error });
        return true;
      }
      const renderer = rendererForSession(resolved.session);
      if (!renderer) {
        json(response, 409, { error: 'No terminal-browser is open for that session' });
        return true;
      }
      if (body.action === 'close-tab') {
        try {
          const closed = await closeRendererTabs(renderer, body.tabs || []);
          if (closed.rendererClosed) closeRenderer(renderer.key, 'Last browser tab closed', false, renderer);
          json(response, 200, closed);
        } catch (error) {
          json(response, 409, { error: error.message || 'Browser tab could not be closed' });
        }
        return true;
      }
      const command = { cmd: 'open-tab' };
      if (body.url?.trim()) {
        command.url = body.url.trim();
        const requested = canonicalBrowserUrl(command.url);
        const existing = renderer.surface?.tabs?.find((tab) => canonicalBrowserUrl(tab.url) === requested);
        if (existing) {
          if (!existing.active) await controlRendererTab(renderer, { cmd: 'activate-tab', tab: existing.id });
          json(response, 200, { opened: false, reused: true, renderer: renderer.key, tab: existing.id });
          return true;
        }
      }
      await controlRendererTab(renderer, command);
      json(response, 200, { opened: true, renderer: renderer.key });
      return true;
    }

    if (request.method === 'GET' && ['/api/control/browser-target', '/api/control/browser-state'].includes(pathname)) {
      const target = {
        threadId: url.searchParams.get('threadId') || undefined,
        session: url.searchParams.get('session') || undefined,
        cwd: url.searchParams.get('cwd') || undefined,
      };
      if (target.threadId && target.threadId.length > 160) {
        json(response, 400, { error: 'threadId must be under 160 characters' });
        return true;
      }
      if (target.session && target.session.length > 64) {
        json(response, 400, { error: 'session must be under 64 characters' });
        return true;
      }
      if (target.cwd && target.cwd.length > 4096) {
        json(response, 400, { error: 'cwd must be under 4096 characters' });
        return true;
      }
      const resolved = await resolveControlSession(target);
      if (resolved.error) {
        json(response, 409, { error: resolved.error });
        return true;
      }
      const renderer = rendererForSession(resolved.session);
      if (pathname.endsWith('browser-target')) {
        if (!renderer?.browserKey) json(response, 409, { error: 'No terminal-browser is open for that session' });
        else json(response, 200, {
          browserKey: renderer.browserKey,
          activeTab: renderer.surface?.tabs?.find((tab) => tab.active)?.id,
        });
        return true;
      }
      if (!renderer?.browserKey || !renderer.browserSocket) {
        json(response, 200, { self: null, browsers: [] });
        return true;
      }
      try {
        const browser = await controlTerminalBrowser(renderer.browserSocket, { cmd: 'targets' });
        browser.key ||= renderer.browserKey;
        json(response, 200, { self: renderer.browserKey, browsers: [browserListing(browser)] });
      } catch {
        json(response, 200, { self: null, browsers: [] });
      }
      return true;
    }
    return false;
  };
}
