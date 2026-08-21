import {
  authorized,
  json,
  originAllowed,
  readRemoteJson,
  remoteApiError,
  sameOrigin,
} from './http.js';

function safeDevice(device) {
  return {
    id: device.id,
    name: device.name,
    createdAt: device.createdAt,
    lastUsedAt: device.lastUsedAt,
    revokedAt: device.revokedAt,
  };
}

export function createRemoteRouteHandler({ config, controller, store, auth }) {
  return async function handleRemoteRoute({ request, response, url, surface }) {
    const { pathname } = url;
    if (!pathname.startsWith('/api/remote/')) return false;
    if (surface !== 'local') {
      json(response, 404, { error: 'Not found' });
      return true;
    }
    if (!originAllowed(request, config)) {
      json(response, 403, { error: 'Origin is not allowed' });
      return true;
    }
    if (!authorized(request, config)) {
      json(response, 401, { error: 'Unauthorized' });
      return true;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD' && !sameOrigin(request, config)) {
      json(response, 403, { error: 'Origin is not allowed' });
      return true;
    }

    try {
      if (request.method === 'GET' && pathname === '/api/remote/status') {
        json(response, 200, await controller.status());
      } else if (request.method === 'GET' && pathname === '/api/remote/tunnel-status') {
        json(response, 200, { tunnel: controller.tunnelStatus() });
      } else if (request.method === 'PUT' && pathname === '/api/remote/cloudflare-token') {
        json(response, 200, await controller.setCloudflareToken((await readRemoteJson(request)).token));
      } else if (request.method === 'DELETE' && pathname === '/api/remote/cloudflare-token') {
        json(response, 200, await controller.removeCloudflareToken());
      } else if (request.method === 'GET' && pathname === '/api/remote/zones') {
        json(response, 200, await controller.listZones());
      } else if (request.method === 'GET' && pathname === '/api/remote/hostname-availability') {
        json(response, 200, await controller.checkHostnameAvailability({
          zoneId: url.searchParams.get('zoneId'),
          subdomain: url.searchParams.get('subdomain'),
        }));
      } else if (request.method === 'POST' && pathname === '/api/remote/tunnels/quick') {
        json(response, 201, await controller.startQuick());
      } else if (request.method === 'POST' && pathname === '/api/remote/tunnels/named') {
        json(response, 201, await controller.startNamed(await readRemoteJson(request)));
      } else if (request.method === 'POST' && pathname === '/api/remote/tunnels/stop') {
        json(response, 200, await controller.stop());
      } else if (request.method === 'DELETE' && pathname === '/api/remote/tunnels/named') {
        json(response, 200, await controller.removeNamed());
      } else if (request.method === 'POST' && pathname === '/api/remote/pairing-sessions') {
        json(response, 201, await controller.createPairing());
      } else if (request.method === 'GET' && pathname === '/api/remote/devices') {
        json(response, 200, { devices: store.listDevices().map(safeDevice) });
      } else if (request.method === 'DELETE' && pathname === '/api/remote/devices') {
        json(response, 200, { removed: auth.revokeAllDevices() });
      } else {
        const match = pathname.match(/^\/api\/remote\/devices\/([^/]+)$/);
        if (request.method === 'DELETE' && match) {
          const removed = await auth.revokeDevice(decodeURIComponent(match[1]));
          json(response, removed ? 200 : 404, removed
            ? { removed: true }
            : { error: 'Remote device not found' });
        } else {
          json(response, 404, { error: 'Not found' });
        }
      }
    } catch (error) {
      remoteApiError(response, error);
    }
    return true;
  };
}
