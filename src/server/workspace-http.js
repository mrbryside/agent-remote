import { browseDirectories, createDirectory } from '../directories.js';
import { authorized, json, originAllowed, readJson } from './http.js';
import { parseRequestUrl, rejectInvalidRequestTarget } from './request-target.js';
import { devtoolsBootstrap } from './renderer-protocol.js';

export function createWorkspaceHttpHandler({
  config, handleRemoteRoute, handleBrowserControlRoute, listWorkspaceSessions,
  openWorkspaceStream, projectStore, agentCatalog, renderers,
  handleConversationFileRoute, handleConversationControlRoute,
  handleConversationMessageRoute, handleProjectRoute, serveStaticAsset,
  rendererForDevtoolsAccess, proxyDevtoolsAsset, closeRenderer,
}) {
  async function handleWorkspaceRequest(request, response, surface = 'local') {
    const url = parseRequestUrl(request);
    if (!url) return rejectInvalidRequestTarget(response);
    const { pathname } = url;

    // Chrome DevTools exposes a powerful browser-control surface. Keep its
    // access-key lookup behind the same local boundary as `/api/*`; the
    // Remote gateway has already authenticated requests before dispatching
    // them here, so it deliberately remains authoritative for `remote`.
    const localProtectedSurface = surface === 'local' &&
      (pathname.startsWith('/api/') || pathname.startsWith('/devtools/'));
    if (localProtectedSurface) {
      if (!originAllowed(request, config)) return json(response, 403, { error: 'Origin is not allowed' });
      if (!authorized(request, config)) return json(response, 401, { error: 'Unauthorized' });
    }

    if ((request.method === 'GET' || request.method === 'HEAD') && pathname.startsWith('/devtools/')) {
      const parts = pathname.split('/');
      let access;
      try { access = decodeURIComponent(parts[2] || ''); }
      catch { return json(response, 400, { error: 'Invalid DevTools access key' }); }
      const assetPath = parts.slice(3).join('/') || 'inspector.html';
      if (!/^[A-Za-z0-9_./-]+$/.test(assetPath) || assetPath.includes('..')) {
        return json(response, 400, { error: 'Invalid DevTools asset path' });
      }
      const renderer = rendererForDevtoolsAccess(access);
      if (!renderer) return json(response, 404, { error: 'DevTools session not found' });
      if (assetPath === 'agent-remote.js') {
        response.writeHead(200, {
          'content-type': 'text/javascript; charset=utf-8',
          'cache-control': 'no-store',
          'content-length': String(Buffer.byteLength(devtoolsBootstrap)),
          'x-content-type-options': 'nosniff',
        });
        response.end(request.method === 'HEAD' ? undefined : devtoolsBootstrap);
        return;
      }
      proxyDevtoolsAsset(request, response, renderer, assetPath, url.search);
      return;
    }

    if (pathname === '/health') {
      json(response, 200, { ok: true, mode: config.tmuxBacked ? 'tmux' : 'shell' });
      return;
    }

    if (surface === 'local' && pathname === '/api/runtime') {
      json(response, 200, { product: 'agent-remote', version: 1, surface: 'local', desktopMode: config.desktopMode });
      return;
    }

    if (await handleRemoteRoute({ request, response, url, surface })) return;

    if (pathname.startsWith('/api/')) {
      try {
        if (await handleBrowserControlRoute({ request, response, url, pathname })) return;
        if (request.method === 'GET' && pathname === '/api/sessions') {
          return json(response, 200, { sessions: await listWorkspaceSessions() });
        }
        if (request.method === 'GET' && pathname === '/api/workspace/stream') {
          openWorkspaceStream(request, response, surface);
          return;
        }
        if (request.method === 'GET' && pathname === '/api/projects') {
          return json(response, 200, { projects: await projectStore.list() });
        }
        if (request.method === 'GET' && pathname === '/api/agents') {
          return json(response, 200, { agents: agentCatalog.list() });
        }
        if (request.method === 'GET' && pathname === '/api/renderers') {
          return json(response, 200, {
            renderers: [...renderers.values()].map((renderer) => ({ key: renderer.key })),
          });
        }
        if (request.method === 'DELETE' && pathname.startsWith('/api/renderers/')) {
          let key;
          try { key = decodeURIComponent(pathname.slice('/api/renderers/'.length)); }
          catch { return json(response, 400, { error: 'Invalid renderer key' }); }
          if (!key || key.length > 192) return json(response, 400, { error: 'Invalid renderer key' });
          const renderer = renderers.get(key);
          const closed = Boolean(renderer && closeRenderer(
            key, 'Browser pane closed', false, renderer,
          ));
          return json(response, 200, { closed });
        }
        if (request.method === 'GET' && pathname === '/api/directories') {
          const directory = await browseDirectories(url.searchParams.get('path'), config.allowedCwdRoots);
          return json(response, 200, directory);
        }
        if (request.method === 'POST' && pathname === '/api/directories') {
          const body = await readJson(request);
          const directory = await createDirectory(body.path, body.name, config.allowedCwdRoots);
          return json(response, 201, directory);
        }
        if (await handleConversationFileRoute({ request, response, url, pathname })) return;
        if (await handleConversationControlRoute({ request, response, pathname })) return;
        if (await handleConversationMessageRoute({ request, response, url, surface, pathname })) return;
        if (await handleProjectRoute({ request, response, pathname })) return;
        return json(response, 404, { error: 'Not found' });
      } catch (error) {
        return json(response, 400, { error: error.message });
      }
    }

    serveStaticAsset({ request, response, surface, pathname });
  }

  return handleWorkspaceRequest;
}
