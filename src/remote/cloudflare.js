import { remoteError } from './errors.js';

const OFFICIAL_API_BASE = 'https://api.cloudflare.com/client/v4';
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_ZONE_PAGES = 1_000;

/**
 * Create the small, deliberately scoped portion of the Cloudflare v4 API used
 * by named Remote tunnels.  Keeping the token here means callers never need
 * to place it in a URL, payload, or diagnostic message.
 */
export function createCloudflareClient({ fetch, token, apiBase = OFFICIAL_API_BASE }) {
  if (typeof fetch !== 'function') {
    throw new TypeError('A fetch implementation is required.');
  }
  if (typeof token !== 'string' || token.length === 0) {
    throw remoteError('TOKEN_INVALID', 'A Cloudflare API token is required.', 401);
  }
  const base = normalizeApiBase(apiBase);

  async function verifyToken() {
    await request('/user/tokens/verify', { tokenRequest: true, operation: 'verify token' });
  }

  async function listZones() {
    const zones = [];
    for (let page = 1; page <= MAX_ZONE_PAGES; page += 1) {
      const response = await request('/zones', { query: { page, per_page: 50 }, operation: 'list zones' });
      zones.push(...asArray(response.result));
      const totalPages = positiveInteger(response.result_info?.total_pages, page);
      if (page >= totalPages) return zones;
    }
    throw cloudflareError(502, 'Cloudflare returned too many pages of zones.');
  }

  async function checkHostname(zoneId, hostname) {
    const response = await request(`/zones/${pathSegment(zoneId)}/dns_records`, {
      query: { name: hostname, per_page: 100 },
      operation: 'check DNS hostname',
    });
    return { hostname, records: asArray(response.result) };
  }

  async function createTunnel(accountId, name) {
    const response = await request(`/accounts/${pathSegment(accountId)}/cfd_tunnel`, {
      method: 'POST',
      body: { name, config_src: 'cloudflare' },
      operation: 'create tunnel',
    });
    return response.result;
  }

  async function configureTunnel(accountId, tunnelId, hostname, service) {
    await request(`/accounts/${pathSegment(accountId)}/cfd_tunnel/${pathSegment(tunnelId)}/configurations`, {
      method: 'PUT',
      operation: 'configure tunnel',
      body: {
        config: {
          ingress: [
            { hostname, service },
            { service: 'http_status:404' },
          ],
        },
      },
    });
  }

  async function getTunnelToken(accountId, tunnelId) {
    const response = await request(`/accounts/${pathSegment(accountId)}/cfd_tunnel/${pathSegment(tunnelId)}/token`, {
      operation: 'read tunnel token',
    });
    if (typeof response.result !== 'string' || response.result.length === 0) {
      throw cloudflareError(502, 'Cloudflare returned an invalid tunnel token response.');
    }
    return response.result;
  }

  async function createDnsRoute(zoneId, hostname, tunnelId) {
    const response = await request(`/zones/${pathSegment(zoneId)}/dns_records`, {
      method: 'POST',
      operation: 'create DNS record',
      body: {
        type: 'CNAME',
        name: hostname,
        content: `${tunnelId}.cfargotunnel.com`,
        proxied: true,
        ttl: 1,
      },
    });
    return response.result;
  }

  async function getTunnel(accountId, tunnelId) {
    return getOptional(`/accounts/${pathSegment(accountId)}/cfd_tunnel/${pathSegment(tunnelId)}`, 'read tunnel');
  }

  async function getDnsRecord(zoneId, recordId) {
    return getOptional(`/zones/${pathSegment(zoneId)}/dns_records/${pathSegment(recordId)}`, 'read DNS record');
  }

  async function cleanupTunnelConnections(accountId, tunnelId) {
    await request(`/accounts/${pathSegment(accountId)}/cfd_tunnel/${pathSegment(tunnelId)}/connections`, {
      method: 'DELETE',
      allowNotFound: true,
      operation: 'clean up tunnel connections',
    });
  }

  async function deleteDnsRoute(zoneId, recordId) {
    await request(`/zones/${pathSegment(zoneId)}/dns_records/${pathSegment(recordId)}`, {
      method: 'DELETE',
      operation: 'delete DNS record',
    });
  }

  async function deleteTunnel(accountId, tunnelId) {
    await request(`/accounts/${pathSegment(accountId)}/cfd_tunnel/${pathSegment(tunnelId)}`, {
      method: 'DELETE',
      allowNotFound: true,
      operation: 'delete tunnel',
    });
  }

  async function getOptional(path, operation) {
    const response = await request(path, { allowNotFound: true, operation });
    return response ? response.result : undefined;
  }

  async function request(path, {
    method = 'GET', body, query, tokenRequest = false, allowNotFound = false, operation = 'API request',
  } = {}) {
    const url = new URL(`${base}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }

    let response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw cloudflareError(502, `Unable to reach the Cloudflare API while trying to ${operation}.`, { operation });
    }

    const payload = await readResponse(response, operation);
    if (allowNotFound && response.status === 404) return undefined;
    if (!response.ok || payload?.success !== true) {
      if (tokenRequest) {
        throw remoteError('TOKEN_INVALID', 'Cloudflare rejected the API token.', response.status || 401);
      }
      const status = response.status || 502;
      const cloudflareCode = firstCloudflareCode(payload);
      throw cloudflareError(status, failureMessage(operation, status, cloudflareCode), { operation, cloudflareCode });
    }
    return payload;
  }

  return {
    verifyToken,
    listZones,
    checkHostname,
    createTunnel,
    configureTunnel,
    getTunnelToken,
    createDnsRoute,
    getTunnel,
    getDnsRecord,
    cleanupTunnelConnections,
    deleteDnsRoute,
    deleteTunnel,
  };
}

function normalizeApiBase(apiBase) {
  if (apiBase === OFFICIAL_API_BASE) return apiBase;
  let url;
  try {
    url = new URL(apiBase);
  } catch {
    throw new TypeError('Cloudflare API base must be the official API base or an injected test API base.');
  }
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.test')) {
    throw new TypeError('Cloudflare API base must be the official API base or an injected test API base.');
  }
  return url.href.replace(/\/$/, '');
}

function pathSegment(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('Cloudflare resource IDs must be non-empty strings.');
  }
  return encodeURIComponent(value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

async function readResponse(response, operation) {
  if (!response || typeof response.status !== 'number') {
    throw cloudflareError(502, `Cloudflare returned an invalid response while trying to ${operation}.`, { operation });
  }
  const contentLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    throw cloudflareError(response.status || 502, `Cloudflare returned an oversized response while trying to ${operation}.`, { operation });
  }
  let text;
  try {
    text = typeof response.text === 'function' ? await response.text() : JSON.stringify(await response.json());
  } catch {
    throw cloudflareError(response.status || 502, `Cloudflare returned an invalid response while trying to ${operation}.`, { operation });
  }
  if (typeof text !== 'string' || text.length > MAX_RESPONSE_BYTES) {
    throw cloudflareError(response.status || 502, `Cloudflare returned an oversized response while trying to ${operation}.`, { operation });
  }
  try {
    return JSON.parse(text);
  } catch {
    throw cloudflareError(response.status || 502, `Cloudflare returned an invalid response while trying to ${operation}.`, { operation });
  }
}

function firstCloudflareCode(payload) {
  const value = Array.isArray(payload?.errors) ? payload.errors.find((candidate) => candidate?.code !== undefined)?.code : undefined;
  if (Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^\d{1,12}$/.test(value)) {
    const numeric = Number(value);
    if (Number.isSafeInteger(numeric)) return numeric;
  }
  return undefined;
}

function failureMessage(operation, status, cloudflareCode) {
  const code = cloudflareCode === undefined ? '' : `, Cloudflare code ${cloudflareCode}`;
  let hint = '';
  if (status === 401 || status === 403) {
    if (/DNS/i.test(operation)) hint = ' Check Zone / DNS / Edit and the selected zone.';
    else if (/tunnel/i.test(operation)) hint = ' Check Account / Cloudflare Tunnel / Edit and the selected account.';
    else if (/zone/i.test(operation)) hint = ' Check Zone / Zone / Read and the selected zone.';
  }
  return `Cloudflare could not ${operation} (HTTP ${status}${code}).${hint}`;
}

function cloudflareError(status, message, { operation, cloudflareCode } = {}) {
  const error = remoteError('CLOUDFLARE_API_ERROR', message, status);
  if (typeof operation === 'string') error.operation = operation;
  if (cloudflareCode !== undefined) error.cloudflareCode = cloudflareCode;
  return error;
}
