import { WebSocket } from 'ws';
import { json } from './http.js';

export function createDevtoolsProxy({
  createHttpRequest, devtoolsClients, remoteDeviceSockets, remoteGateway,
}) {
  function proxyDevtoolsAsset(request, response, renderer, assetPath, search) {
    if (!renderer.cdpPort) {
      json(response, 409, { error: 'Chrome DevTools is not ready' });
      return;
    }
    const upstream = createHttpRequest({
      hostname: '127.0.0.1',
      port: renderer.cdpPort,
      method: request.method,
      path: `/devtools/${assetPath}${search}`,
      headers: {
        accept: request.headers.accept || '*/*',
        'accept-encoding': assetPath === 'inspector.html' ? 'identity' : request.headers['accept-encoding'] || 'identity',
        'user-agent': request.headers['user-agent'] || 'agent-remote',
      },
    }, (upstreamResponse) => {
      const headers = { ...upstreamResponse.headers };
      delete headers.connection;
      delete headers['x-frame-options'];
      headers['cache-control'] = assetPath === 'inspector.html' ? 'no-cache' : 'public, max-age=86400';
      if (assetPath !== 'inspector.html' || request.method === 'HEAD') {
        response.writeHead(upstreamResponse.statusCode || 502, headers);
        if (request.method === 'HEAD') {
          upstreamResponse.resume();
          response.end();
        } else {
          upstreamResponse.pipe(response);
        }
        return;
      }

      const chunks = [];
      let size = 0;
      let failed = false;
      upstreamResponse.once('error', (error) => {
        failed = true;
        if (!response.headersSent) json(response, 502, { error: `DevTools asset proxy failed: ${error.message}` });
        else response.destroy(error);
      });
      upstreamResponse.on('data', (chunk) => {
        size += chunk.length;
        if (size <= 1024 * 1024) chunks.push(chunk);
        else upstreamResponse.destroy(new Error('DevTools inspector HTML is too large'));
      });
      upstreamResponse.once('end', () => {
        if (failed) return;
        const html = Buffer.concat(chunks).toString('utf8').replace(
          '<body',
          '<script type="module" src="./agent-remote.js"></script>\n<body',
        );
        const body = Buffer.from(html);
        delete headers['content-encoding'];
        delete headers['transfer-encoding'];
        headers['content-length'] = String(body.length);
        response.writeHead(upstreamResponse.statusCode || 502, headers);
        response.end(body);
      });
    });
    upstream.once('error', (error) => {
      if (!response.headersSent) json(response, 502, { error: `DevTools asset proxy failed: ${error.message}` });
      else response.destroy(error);
    });
    request.once('aborted', () => upstream.destroy());
    upstream.end();
  }

  function bridgeDevtoolsSocket(downstream, renderer, targetId, request, releaseTransport = () => {}) {
    let transportReleased = false;
    const release = () => {
      if (transportReleased) return;
      transportReleased = true;
      releaseTransport();
    };
    const upstream = new WebSocket(
      `ws://127.0.0.1:${renderer.cdpPort}/devtools/page/${encodeURIComponent(targetId)}`,
      { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 },
    );
    const pending = [];
    devtoolsClients.add(downstream);
    if (request?.remoteDeviceId) {
      let sockets = remoteDeviceSockets.get(request.remoteDeviceId);
      if (!sockets) {
        sockets = new Set();
        remoteDeviceSockets.set(request.remoteDeviceId, sockets);
      }
      sockets.add(downstream);
      const removeRemoteSocket = () => {
        sockets.delete(downstream);
        if (sockets.size === 0) remoteDeviceSockets.delete(request.remoteDeviceId);
      };
      downstream.once('close', removeRemoteSocket);
      downstream.once('error', removeRemoteSocket);
      remoteGateway.trackSocket(downstream, request);
    }

    downstream.on('message', (data, isBinary) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
      else if (upstream.readyState === WebSocket.CONNECTING) pending.push([data, isBinary]);
    });
    upstream.once('open', () => {
      for (const [data, isBinary] of pending.splice(0)) upstream.send(data, { binary: isBinary });
    });
    upstream.on('message', (data, isBinary) => {
      if (downstream.readyState === WebSocket.OPEN) downstream.send(data, { binary: isBinary });
    });
    upstream.once('error', () => {
      if (downstream.readyState < WebSocket.CLOSING) downstream.close(1011, 'Chrome DevTools connection failed');
    });
    upstream.once('close', (code, reason) => {
      if (downstream.readyState < WebSocket.CLOSING) {
        const safeCode = code >= 1000 && code <= 4999 && code !== 1005 && code !== 1006 ? code : 1001;
        downstream.close(safeCode, reason);
      }
    });
    downstream.once('close', (code, reason) => {
      devtoolsClients.delete(downstream);
      release();
      if (upstream.readyState < WebSocket.CLOSING) {
        const safeCode = code >= 1000 && code <= 4999 && code !== 1005 && code !== 1006 ? code : 1001;
        upstream.close(safeCode, reason);
      }
    });
    downstream.once('error', () => {
      release();
      if (upstream.readyState < WebSocket.CLOSING) upstream.close(1011, 'DevTools client disconnected');
    });
  }

  return { bridgeDevtoolsSocket, proxyDevtoolsAsset };
}
