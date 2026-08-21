import { WebSocket } from 'ws';
import { canonicalBrowserUrl } from './renderer-protocol.js';
import { json, readJson } from './http.js';

function controlTargetError(body) {
  if (body.session !== undefined && (typeof body.session !== 'string' || body.session.length > 64)) {
    return 'session must be a string under 64 characters';
  }
  if (body.cwd !== undefined && (typeof body.cwd !== 'string' || !body.cwd || body.cwd.length > 4096)) {
    return 'cwd must be a non-empty string under 4096 characters';
  }
  return undefined;
}

export function createBrowserControlRouteHandler({
  resolveControlSession,
  clients,
  clientContexts,
  conversationStreams,
  rendererForSession,
  controlRendererTab,
  controlTerminalBrowser,
  browserListing,
}) {
  return async function handleBrowserControlRoute({ request, response, url, pathname }) {
    if (request.method === 'POST' && pathname === '/api/control/split') {
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
      const targets = [...clients].filter((client) => {
        const context = clientContexts.get(client);
        return client.readyState === WebSocket.OPEN && context?.mode !== 'graphics' &&
          (!resolved.session || context?.session === resolved.session);
      });
      const streams = [...conversationStreams].filter((stream) =>
        !resolved.session || stream.sessionName === resolved.session);
      if (targets.length === 0 && streams.length === 0) {
        json(response, 409, { error: 'No browser is connected to that session' });
        return true;
      }
      const control = { type: 'control', action: 'open-graphics', argv: body.argv };
      for (const client of targets) client.send(JSON.stringify(control));
      for (const stream of streams) stream.sendControl?.(control);
      json(response, 202, { delivered: targets.length + streams.length, session: resolved.session });
      return true;
    }

    if (request.method === 'POST' && pathname === '/api/control/browser-tab') {
      const body = await readJson(request);
      if (body.action !== 'new-tab') {
        json(response, 400, { error: 'Unsupported browser tab action' });
        return true;
      }
      if (body.url !== undefined && (typeof body.url !== 'string' || body.url.length > 4096)) {
        json(response, 400, { error: 'url must be a string under 4096 characters' });
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
      const target = { session: url.searchParams.get('session') || undefined, cwd: url.searchParams.get('cwd') || undefined };
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
