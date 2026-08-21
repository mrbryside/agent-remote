import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

const workspaceDocumentHeaders = Object.freeze({
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https: http:; connect-src 'self'; worker-src 'self' blob:; font-src 'self' data:",
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
});

function stripLocalControls(source) {
  const startMarker = '<!-- local-control:start -->';
  const endMarker = '<!-- local-control:end -->';
  let stripped = '';
  let remainder = source;
  while (remainder.includes(startMarker)) {
    const start = remainder.indexOf(startMarker);
    const end = remainder.indexOf(endMarker, start + startMarker.length);
    if (end < 0) return undefined;
    stripped += remainder.slice(0, start);
    remainder = remainder.slice(end + endMarker.length);
  }
  stripped += remainder;
  if (stripped.includes(endMarker)) return undefined;
  if (/id="(?:remote-button|remote-dialog|cloudflare-token-guide-dialog)"/.test(stripped)) return undefined;
  return stripped;
}

function assetRoutes(root, publicDir) {
  const publicAssets = [
    'manifest.webmanifest', 'icon-180.png', 'icon-192.png', 'icon-512.png',
    'document-boot.js', 'workspace-boot.js', 'app.js', 'api-client.js', 'remote-entry.js',
    'prompt-title.js', 'ui-components.js', 'remote-control.js', 'mobile-conversation.js',
    'mobile-activity-state.js', 'mobile-composer-model.js', 'mobile-timeline-reconciler.js',
    'mobile-file-surface.js', 'mobile-event-renderer.js', 'mobile-interaction-renderer.js',
    'terminal-snapshots.js', 'visual-viewport.js', 'browser-media.js',
    'markdown.js', 'syntax.js', 'tokens.css', 'styles.css',
  ];
  const routes = new Map([['/', join(publicDir, 'index.html')]]);
  for (const asset of publicAssets) routes.set(`/${asset}`, join(publicDir, asset));
  const vendorAssets = {
    '/vendor/xterm.js': 'node_modules/@xterm/xterm/lib/xterm.js',
    '/vendor/xterm.css': 'node_modules/@xterm/xterm/css/xterm.css',
    '/vendor/addon-fit.js': 'node_modules/@xterm/addon-fit/lib/addon-fit.js',
    '/vendor/addon-image.js': 'node_modules/@xterm/addon-image/lib/addon-image.js',
    '/vendor/marked.js': 'node_modules/marked/lib/marked.esm.js',
    '/vendor/dompurify.js': 'node_modules/dompurify/dist/purify.es.mjs',
    '/vendor/highlight.js': 'node_modules/@highlightjs/cdn-assets/es/highlight.min.js',
  };
  for (const [route, file] of Object.entries(vendorAssets)) routes.set(route, join(root, file));
  return routes;
}

export function createStaticAssetHandler({ root, publicDir }) {
  const routes = assetRoutes(root, publicDir);

  return function serveStaticAsset({ request, response, surface, pathname }) {
    if (surface === 'remote' && pathname === '/remote-control.js') {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      response.end('Not found');
      return;
    }
    const file = routes.get(pathname);
    if (!file || !existsSync(file)) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }
    const headers = {
      'content-type': contentTypes[extname(file)] ?? 'application/octet-stream',
      'cache-control': pathname.startsWith('/vendor/') ? 'public, max-age=86400' : 'no-store',
      'x-content-type-options': 'nosniff',
      // The local workspace has privileged terminal controls just like the
      // authenticated Remote surface. Do not let another site frame either
      // document and drive those controls through a clickjacking overlay.
      ...(pathname === '/' ? workspaceDocumentHeaders : {}),
    };
    if (surface === 'remote' && pathname === '/') {
      let document;
      try { document = stripLocalControls(readFileSync(file, 'utf8')); }
      catch { document = undefined; }
      if (document === undefined) {
        response.writeHead(500, {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        });
        response.end('Remote workspace is unavailable');
        return;
      }
      response.writeHead(200, { ...headers, 'content-length': String(Buffer.byteLength(document)) });
      response.end(request.method === 'HEAD' ? undefined : document);
      return;
    }
    response.writeHead(200, headers);
    createReadStream(file).pipe(response);
  };
}
