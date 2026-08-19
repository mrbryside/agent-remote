import { toDataURL as defaultToDataURL } from 'qrcode';

import { remoteError } from './errors.js';

const MAX_TOKEN_BYTES = 4 * 1024;

function publicCloudflared(result) {
  const cloudflared = {
    available: Boolean(result?.available),
  };
  if (typeof result?.version === 'string') cloudflared.version = result.version;
  if (typeof result?.source === 'string') cloudflared.source = result.source;
  if (result?.error) {
    const message = typeof result.error === 'string' ? result.error : result.error.message;
    if (typeof message === 'string' && message) cloudflared.error = message;
  }
  return cloudflared;
}

function publicTunnel(status) {
  const tunnel = {
    mode: typeof status?.mode === 'string' ? status.mode : 'none',
    state: typeof status?.state === 'string' ? status.state : 'stopped',
  };
  if (typeof status?.publicUrl === 'string') tunnel.publicUrl = status.publicUrl;
  if (typeof status?.hostname === 'string') tunnel.hostname = status.hostname;
  if (status?.error) {
    const error = status.error;
    const message = typeof error === 'string' ? error : error.message;
    const code = typeof error === 'object' ? error.code : undefined;
    tunnel.error = Object.fromEntries([
      ...(typeof code === 'string' ? [['code', code]] : []),
      ...(typeof message === 'string' ? [['message', message]] : []),
    ]);
  }
  return tunnel;
}

function publicNamedSettings(settings) {
  if (typeof settings?.zoneName !== 'string' || !settings.zoneName
    || typeof settings.hostname !== 'string' || !settings.hostname
    || (settings.desiredState !== 'stopped' && settings.desiredState !== 'running')) {
    return undefined;
  }
  return {
    zoneName: settings.zoneName,
    hostname: settings.hostname,
    desiredState: settings.desiredState,
  };
}

function validateToken(value) {
  if (typeof value !== 'string') {
    throw remoteError('TOKEN_INVALID', 'A Cloudflare API token is required.', 400);
  }
  const token = value.trim();
  if (!token || Buffer.byteLength(token, 'utf8') > MAX_TOKEN_BYTES) {
    throw remoteError('TOKEN_INVALID', 'A Cloudflare API token is required.', 400);
  }
  return token;
}

function assertPublicRunningTunnel(status, allowInsecurePublicOrigin) {
  if (status?.state !== 'running' || typeof status.publicUrl !== 'string'
    || !(status.publicUrl.startsWith('https://') || (allowInsecurePublicOrigin && status.publicUrl.startsWith('http://')))) {
    throw remoteError('REMOTE_UNAUTHORIZED', 'Pairing requires a running public tunnel.', 409);
  }
  return status.publicUrl;
}

/**
 * Local-only Remote administration.  HTTP concerns (same-origin checks,
 * content types, bounded bodies, and no-store headers) stay in server.js;
 * this module owns only the serialized lifecycle and safe public data shape.
 */
export function createRemoteController({
  auth,
  provisioner,
  tokenStore,
  tunnelManager,
  inspectCloudflared,
  getNamedSettings = () => undefined,
  toDataURL = defaultToDataURL,
  platform = process.platform,
  allowInsecurePublicOrigin = false,
} = {}) {
  if (!auth || typeof auth.createPairing !== 'function') throw new TypeError('A remote auth service is required.');
  if (!provisioner || typeof provisioner.validateToken !== 'function'
    || typeof provisioner.listZones !== 'function'
    || typeof provisioner.checkAvailability !== 'function'
    || typeof provisioner.prepareNamed !== 'function'
    || typeof provisioner.removeNamed !== 'function') {
    throw new TypeError('A remote provisioner is required.');
  }
  if (!tokenStore || typeof tokenStore.has !== 'function'
    || typeof tokenStore.write !== 'function' || typeof tokenStore.remove !== 'function') {
    throw new TypeError('A Cloudflare token store is required.');
  }
  if (!tunnelManager || typeof tunnelManager.status !== 'function'
    || typeof tunnelManager.startQuick !== 'function' || typeof tunnelManager.startNamed !== 'function'
    || typeof tunnelManager.stop !== 'function') {
    throw new TypeError('A tunnel manager is required.');
  }
  if (typeof inspectCloudflared !== 'function') throw new TypeError('A cloudflared inspector is required.');
  if (typeof getNamedSettings !== 'function') throw new TypeError('A named settings reader is required.');
  if (typeof toDataURL !== 'function') throw new TypeError('A QR encoder is required.');

  let queue = Promise.resolve();
  let activeTarget;
  let activeTargetPromise;
  let namedTarget;

  function enqueue(action) {
    const result = queue.then(action, action);
    queue = result.catch(() => {});
    return result;
  }

  function runTarget(target, action) {
    if (activeTarget === target && activeTargetPromise) return activeTargetPromise;
    const result = enqueue(action);
    activeTarget = target;
    activeTargetPromise = result;
    void result.then(
      () => {
        if (activeTargetPromise === result) {
          activeTarget = undefined;
          activeTargetPromise = undefined;
        }
      },
      () => {
        if (activeTargetPromise === result) {
          activeTarget = undefined;
          activeTargetPromise = undefined;
        }
      },
    );
    return result;
  }

  async function status() {
    const tunnel = publicTunnel(tunnelManager.status());
    if (platform !== 'darwin') {
      return {
        supported: false,
        cloudflared: { available: false, error: 'Remote access is supported only on macOS.' },
        tokenConfigured: false,
        tunnel,
      };
    }
    const [cloudflaredResult, tokenConfigured, namedSettings] = await Promise.all([
      inspectCloudflared(),
      tokenStore.has(),
      getNamedSettings(),
    ]);
    const result = {
      supported: true,
      cloudflared: publicCloudflared(cloudflaredResult),
      tokenConfigured: Boolean(tokenConfigured),
      tunnel,
    };
    const named = publicNamedSettings(namedSettings);
    if (named) {
      result.named = named;
    } else if (tunnel.mode === 'named' && typeof tunnel.hostname === 'string') {
      result.named = { hostname: tunnel.hostname, desiredState: tunnel.state === 'stopped' ? 'stopped' : 'running' };
    }
    return result;
  }

  return {
    status,

    async setCloudflareToken(value) {
      const token = validateToken(value);
      const zones = await provisioner.validateToken(token);
      await tokenStore.write(token);
      return { configured: true, zones };
    },

    async removeCloudflareToken() {
      await tokenStore.remove();
      return { configured: false };
    },

    async listZones() {
      return { zones: await provisioner.listZones() };
    },

    checkHostnameAvailability({ zoneId, subdomain } = {}) {
      return provisioner.checkAvailability(zoneId, subdomain);
    },

    startQuick() {
      return runTarget('quick', async () => {
        const current = tunnelManager.status();
        if (current.mode === 'quick' && (current.state === 'starting' || current.state === 'running')) return current;
        if (current.mode !== 'none' || current.state !== 'stopped') await tunnelManager.stop();
        namedTarget = undefined;
        return tunnelManager.startQuick();
      });
    },

    startNamed({ zoneId, subdomain } = {}) {
      const target = `named:${zoneId ?? ''}:${subdomain ?? ''}`;
      const current = tunnelManager.status();
      if (namedTarget === target && current.mode === 'named'
        && (current.state === 'starting' || current.state === 'running')) {
        return Promise.resolve(current);
      }
      return runTarget(target, async () => {
        const prepared = await provisioner.prepareNamed({ zoneId, subdomain });
        const latest = tunnelManager.status();
        if (latest.mode === 'named' && latest.hostname === prepared.hostname
          && (latest.state === 'starting' || latest.state === 'running')) {
          namedTarget = target;
          return latest;
        }
        if (latest.mode !== 'none' || latest.state !== 'stopped') await tunnelManager.stop();
        const started = await tunnelManager.startNamed({ hostname: prepared.hostname, tunnelToken: prepared.tunnelToken });
        namedTarget = target;
        return started;
      });
    },

    stop() {
      return runTarget('stop', async () => {
        const current = tunnelManager.status();
        if (current.mode === 'none' && current.state === 'stopped') return current;
        const stopped = await tunnelManager.stop();
        namedTarget = undefined;
        return stopped;
      });
    },

    removeNamed() {
      return runTarget('remove', async () => {
        const current = tunnelManager.status();
        if (current.mode !== 'none' || current.state !== 'stopped') await tunnelManager.stop();
        const removed = await provisioner.removeNamed();
        if (removed.removed) namedTarget = undefined;
        return removed;
      });
    },

    async createPairing() {
      const publicUrl = assertPublicRunningTunnel(tunnelManager.status(), allowInsecurePublicOrigin);
      const pairing = await auth.createPairing(publicUrl);
      const qrDataUrl = await toDataURL(pairing.pairUrl, { errorCorrectionLevel: 'M', type: 'image/png' });
      return { pairUrl: pairing.pairUrl, qrDataUrl, expiresAt: pairing.expiresAt };
    },
  };
}
