import { remoteError } from './errors.js';

const LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Validate the only hostname input Remote accepts: one lower-case ASCII DNS
 * label.  Keeping this separate makes it impossible for callers to smuggle a
 * zone, root hostname, or wildcard through the provisioning boundary.
 */
export function validateSubdomain(label) {
  if (typeof label !== 'string' || Buffer.byteLength(label, 'utf8') > 63 || !LABEL_PATTERN.test(label)) {
    throw new TypeError('Remote subdomain must be one lowercase ASCII DNS label.');
  }
  return label;
}

/**
 * Coordinates the Keychain, persisted ownership metadata, and narrowly scoped
 * Cloudflare client.  It never derives ownership from a friendly resource name:
 * every destructive or reuse action requires exact stored IDs and live values.
 */
export function createRemoteProvisioner({ store, tokenStore, createClient, remoteOrigin } = {}) {
  if (!store || typeof store.getSettings !== 'function' || typeof store.saveNamedTunnel !== 'function'
    || typeof store.clearNamedTunnel !== 'function') {
    throw new TypeError('A remote metadata store is required.');
  }
  if (!tokenStore || typeof tokenStore.read !== 'function') throw new TypeError('A Cloudflare token store is required.');
  if (typeof createClient !== 'function') throw new TypeError('A Cloudflare client factory is required.');
  if (typeof remoteOrigin !== 'string' || !/^http:\/\/127\.0\.0\.1(?::\d+)?$/.test(remoteOrigin)) {
    throw new TypeError('remoteOrigin must be a loopback HTTP origin.');
  }

  async function clientForToken(value) {
    const token = typeof value === 'string' ? value.trim() : undefined;
    if (typeof token !== 'string' || token.trim() === '') {
      throw remoteError('TOKEN_INVALID', 'A Cloudflare API token is required.', 401);
    }
    const client = await createClient({ token: token.trim() });
    if (!client || typeof client.verifyToken !== 'function' || typeof client.listZones !== 'function') {
      throw new TypeError('Cloudflare client is missing required methods.');
    }
    return client;
  }

  async function openClient() {
    return clientForToken(await tokenStore.read());
  }

  async function authorizeAndResolve(client, zoneId) {
    await client.verifyToken();
    const zones = await client.listZones();
    const zone = Array.isArray(zones) ? zones.find((candidate) => candidate?.id === zoneId) : undefined;
    const accountId = zone?.account?.id ?? zone?.accountId;
    if (!zone || typeof zone.name !== 'string' || zone.name.length === 0 || typeof accountId !== 'string' || accountId.length === 0) {
      throw remoteError('ZONE_FORBIDDEN', 'The selected Cloudflare zone is unavailable.', 403);
    }
    return { zone, accountId };
  }

  async function inspectAvailability(client, zone, accountId, label) {
    const hostname = `${label}.${zone.name}`;
    const check = await client.checkHostname(zone.id, hostname);
    const records = Array.isArray(check?.records) ? check.records : [];
    if (records.length === 0) return { hostname, status: 'available', suggestions: [], record: undefined };

    const settings = store.getSettings();
    const ownedRecord = records.find((record) => recordMatches(settings, record, hostname));
    if (ownedRecord && records.length === 1 && settingsMatchLocation(settings, { zone, accountId, hostname })
      && await liveTunnelMatches(client, settings)) {
      return { hostname, status: 'reusable', suggestions: [], record: ownedRecord };
    }

    return {
      hostname,
      status: 'conflict',
      suggestions: await findSuggestions(client, zone, label),
      record: undefined,
    };
  }

  async function checkAvailability(zoneId, label) {
    const subdomain = validateSubdomain(label);
    const client = await openClient();
    const { zone, accountId } = await authorizeAndResolve(client, zoneId);
    const availability = await inspectAvailability(client, zone, accountId, subdomain);
    return publicAvailability(availability);
  }

  async function listZones() {
    const client = await openClient();
    await client.verifyToken();
    const zones = await client.listZones();
    return Array.isArray(zones) ? zones : [];
  }

  // Candidate tokens are checked against Cloudflare before callers persist
  // them. This keeps rejected credentials out of the Keychain entirely.
  async function validateToken(token) {
    const client = await clientForToken(token);
    await client.verifyToken();
    const zones = await client.listZones();
    return Array.isArray(zones) ? zones : [];
  }

  async function prepareNamed({ zoneId, subdomain } = {}) {
    const label = validateSubdomain(subdomain);
    const client = await openClient();
    const { zone, accountId } = await authorizeAndResolve(client, zoneId);
    const availability = await inspectAvailability(client, zone, accountId, label);
    if (availability.status === 'conflict') {
      throw remoteError('HOSTNAME_CONFLICT', 'That hostname is already in use.', 409);
    }

    const settings = store.getSettings();
    let tunnel;
    let record = availability.record;
    if (availability.status === 'reusable') {
      tunnel = { id: settings.tunnelId, name: settings.tunnelName };
    } else if (hasNamedTunnel(settings)) {
      if (!settingsMatchLocation(settings, { zone, accountId, hostname: availability.hostname })) {
        throw remoteError('HOSTNAME_CONFLICT', 'Remove the existing named hostname before creating another.', 409);
      }
      tunnel = await client.getTunnel(accountId, settings.tunnelId);
      if (!tunnel || !tunnelMatches(settings, tunnel)) {
        // A locally recorded but no-longer-live partial create can safely be
        // replaced only because no DNS record exists at this hostname.
        tunnel = undefined;
      }
    }

    if (!tunnel) {
      const tunnelName = tunnelNameFor(settings.installationId);
      tunnel = await client.createTunnel(accountId, tunnelName);
      assertTunnel(tunnel);
      // Persist as soon as Cloudflare creates the tunnel.  If ingress or DNS
      // creation fails, this is the ownership evidence needed for a safe retry.
      persist(store, {
        accountId,
        zoneId: zone.id,
        zoneName: zone.name,
        hostname: availability.hostname,
        tunnelId: tunnel.id,
        tunnelName: tunnel.name,
        dnsRecordId: null,
        dnsTarget: null,
      });
    }

    await client.configureTunnel(accountId, tunnel.id, availability.hostname, remoteOrigin);
    if (!record) {
      record = await client.createDnsRoute(zone.id, availability.hostname, tunnel.id);
      assertDnsRecord(record, availability.hostname, tunnel.id);
    }
    // DNS may have been created even if token retrieval subsequently fails.
    // Record it first so the next attempt revalidates and reuses it instead of
    // treating our own CNAME as a foreign collision.
    persist(store, {
      accountId,
      zoneId: zone.id,
      zoneName: zone.name,
      hostname: availability.hostname,
      tunnelId: tunnel.id,
      tunnelName: tunnel.name,
      dnsRecordId: record.id,
      dnsTarget: `${tunnel.id}.cfargotunnel.com`,
    });
    const tunnelToken = await client.getTunnelToken(accountId, tunnel.id);
    if (typeof tunnelToken !== 'string' || tunnelToken.length === 0) {
      throw remoteError('CLOUDFLARE_API_ERROR', 'Cloudflare returned an invalid tunnel token.', 502);
    }
    return { hostname: availability.hostname, tunnelToken, record };
  }

  async function removeNamed() {
    const settings = store.getSettings();
    if (!hasNamedTunnel(settings)) return { removed: true, warnings: [] };
    if (!completeNamedSettings(settings)) {
      return { removed: false, warnings: ['Named tunnel metadata is incomplete; no Cloudflare resource was deleted.'] };
    }

    const client = await openClient();
    await client.verifyToken();
    const zones = await client.listZones();
    const zone = Array.isArray(zones) ? zones.find((candidate) => candidate?.id === settings.zoneId) : undefined;
    const currentAccountId = zone?.account?.id ?? zone?.accountId;
    if (!zone || zone.name !== settings.zoneName || currentAccountId !== settings.accountId) {
      return { removed: false, warnings: ['Zone ownership could not be verified; no Cloudflare resource was deleted.'] };
    }
    let record;
    try {
      record = await client.getDnsRecord(settings.zoneId, settings.dnsRecordId);
    } catch (error) {
      throw error;
    }
    // A missing record can be the harmless result of a prior removal attempt
    // whose tunnel deletion failed.  A present-but-different record is never
    // removed, even if it retains the original record ID.
    if (record !== undefined && !recordMatches(settings, record, settings.hostname)) {
      return { removed: false, warnings: ['DNS changed outside agent-remote; it was left untouched.'] };
    }
    const tunnel = await client.getTunnel(settings.accountId, settings.tunnelId);
    if (!tunnelMatches(settings, tunnel)) {
      return { removed: false, warnings: ['Tunnel ownership could not be verified; no Cloudflare resource was deleted.'] };
    }

    if (record !== undefined) await client.deleteDnsRoute(settings.zoneId, settings.dnsRecordId);
    await client.deleteTunnel(settings.accountId, settings.tunnelId);
    store.clearNamedTunnel();
    return { removed: true, warnings: [] };
  }

  return { validateToken, checkAvailability, listZones, prepareNamed, removeNamed };
}

function publicAvailability({ hostname, status, suggestions }) {
  return { hostname, status, suggestions };
}

function hasNamedTunnel(settings) {
  return typeof settings?.tunnelId === 'string' && settings.tunnelId.length > 0;
}

function completeNamedSettings(settings) {
  return hasNamedTunnel(settings) && [
    settings.accountId, settings.zoneId, settings.zoneName, settings.hostname,
    settings.tunnelName, settings.dnsRecordId, settings.dnsTarget,
  ].every((value) => typeof value === 'string' && value.length > 0);
}

function settingsMatchLocation(settings, { zone, accountId, hostname }) {
  return settings?.accountId === accountId
    && settings.zoneId === zone.id
    && settings.zoneName === zone.name
    && settings.hostname === hostname;
}

function recordMatches(settings, record, hostname) {
  return Boolean(record)
    && typeof settings?.dnsRecordId === 'string'
    && record.id === settings.dnsRecordId
    && record.type === 'CNAME'
    && record.name === hostname
    && record.content === settings.dnsTarget
    && record.content === `${settings.tunnelId}.cfargotunnel.com`;
}

function tunnelMatches(settings, tunnel) {
  return Boolean(tunnel)
    && tunnel.id === settings?.tunnelId
    && tunnel.name === settings?.tunnelName;
}

async function liveTunnelMatches(client, settings) {
  const tunnel = await client.getTunnel(settings.accountId, settings.tunnelId);
  return tunnelMatches(settings, tunnel);
}

async function findSuggestions(client, zone, label) {
  const suggestions = [];
  for (let suffix = 2; suffix <= 5; suffix += 1) {
    const candidate = `${label}-${suffix}`;
    if (Buffer.byteLength(candidate, 'utf8') > 63) continue;
    const hostname = `${candidate}.${zone.name}`;
    const check = await client.checkHostname(zone.id, hostname);
    if (Array.isArray(check?.records) && check.records.length === 0) suggestions.push(candidate);
  }
  return suggestions;
}

function tunnelNameFor(installationId) {
  if (typeof installationId !== 'string' || installationId.length < 12) {
    throw new TypeError('Remote installation ID is invalid.');
  }
  return `agent-remote-${installationId.slice(0, 12)}`;
}

function assertTunnel(tunnel) {
  if (!tunnel || typeof tunnel.id !== 'string' || tunnel.id.length === 0 || typeof tunnel.name !== 'string' || tunnel.name.length === 0) {
    throw remoteError('CLOUDFLARE_API_ERROR', 'Cloudflare returned an invalid tunnel.', 502);
  }
}

function assertDnsRecord(record, hostname, tunnelId) {
  if (!record || typeof record.id !== 'string' || record.id.length === 0
    || record.type !== 'CNAME' || record.name !== hostname || record.content !== `${tunnelId}.cfargotunnel.com`) {
    throw remoteError('CLOUDFLARE_API_ERROR', 'Cloudflare returned an invalid DNS record.', 502);
  }
}

function persist(store, input) {
  store.saveNamedTunnel(input);
}
