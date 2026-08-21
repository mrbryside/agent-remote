import { maxAttachmentBytes } from '../conversations/attachments.js';

export function authorized(request, config) {
  if (!config.token) return true;
  const bearer = request.headers.authorization?.replace(/^Bearer\s+/i, '');
  return bearer === config.token;
}

export function json(response, status, payload) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(payload));
}

export async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error('Request body is too large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('Invalid JSON body'); }
}

export function requestError(status, message, code) {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
}

export async function readBytes(request, maximum = maxAttachmentBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximum) throw requestError(413, 'Attachment is too large', 'ATTACHMENT_TOO_LARGE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readRemoteJson(request) {
  const contentType = request.headers['content-type'];
  if (typeof contentType !== 'string' || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)) {
    throw requestError(415, 'Content-Type must be application/json');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw requestError(413, 'Request body is too large');
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw requestError(400, 'Invalid JSON body'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw requestError(400, 'JSON body must be an object');
  }
  return body;
}

export function remoteApiError(response, error) {
  const status = Number.isInteger(error?.status) ? error.status : 400;
  const payload = { error: error?.message || 'Invalid Remote request' };
  if (typeof error?.code === 'string') payload.code = error.code;
  return json(response, status, payload);
}

function parseAuthority(value, protocol = 'http:') {
  if (typeof value !== 'string' || !value) return undefined;
  try {
    const url = new URL(`${protocol}//${value}`);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return undefined;
    return {
      host: url.host,
      hostname: url.hostname.toLowerCase(),
      port: Number(url.port || (protocol === 'https:' ? 443 : 80)),
    };
  } catch {
    return undefined;
  }
}

function parseOrigin(value) {
  if (typeof value !== 'string' || !value) return undefined;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      return undefined;
    }
    return {
      value: url.origin,
      protocol: url.protocol,
      authority: parseAuthority(url.host, url.protocol),
    };
  } catch {
    return undefined;
  }
}

function isLoopbackHost(hostname) {
  const value = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (value === 'localhost' || value === '::1') return true;
  const octets = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  return Boolean(octets) && octets.slice(1).every((octet) => Number(octet) <= 255);
}

function normalizedHost(value) {
  return typeof value === 'string' ? value.replace(/^\[|\]$/g, '').toLowerCase() : '';
}

function listenerProtocol(request) {
  return request.socket?.encrypted ? 'https:' : 'http:';
}

function listenerPort(request) {
  return Number(request.socket?.localPort);
}

function configuredOrigins(config) {
  return (config?.allowedOrigins ?? []).map(parseOrigin).filter(Boolean);
}

function authorityMatchesConfiguredOrigin(authority, config) {
  return configuredOrigins(config).some((origin) =>
    origin.authority?.hostname === authority.hostname && origin.authority.port === authority.port);
}

/**
 * The Host header is attacker-controlled. Only accept a host that identifies
 * this listener, a configured bind name, or an explicitly configured origin.
 * This prevents a rebinding page from making its own Host and Origin agree.
 */
export function trustedRequestAuthority(request, config) {
  const authority = parseAuthority(request.headers.host, listenerProtocol(request));
  const port = listenerPort(request);
  if (!authority || !Number.isInteger(port) || authority.port !== port) return undefined;

  const configuredHost = normalizedHost(config?.host);
  const localAddress = normalizedHost(request.socket?.localAddress);
  const isLoopbackListener = isLoopbackHost(configuredHost) || isLoopbackHost(localAddress);
  if (isLoopbackListener && isLoopbackHost(authority.hostname)) return authority;

  if (authority.hostname === configuredHost || authority.hostname === localAddress) return authority;
  if (authorityMatchesConfiguredOrigin(authority, config)) return authority;
  return undefined;
}

export function sameOrigin(request, config) {
  const authority = trustedRequestAuthority(request, config);
  const origin = parseOrigin(request.headers.origin);
  return Boolean(
    authority
      && origin?.protocol === listenerProtocol(request)
      && origin.authority?.hostname === authority.hostname
      && origin.authority.port === authority.port,
  );
}

export function originAllowed(request, config) {
  if (!trustedRequestAuthority(request, config)) return false;
  const origin = request.headers.origin;
  if (!origin) return true;
  const parsedOrigin = parseOrigin(origin);
  if (!parsedOrigin) return false;
  if (configuredOrigins(config).some((allowed) => allowed.value === parsedOrigin.value)) return true;
  return sameOrigin(request, config);
}
