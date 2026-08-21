const localRequestBase = 'http://localhost';
const invalidTargetCharacters = /[\u0000-\u001F\u007F\s#]/;
const invalidPercentEscape = /%(?![0-9A-Fa-f]{2})/;
const encodedPathSeparator = /%(?:2f|5c)/i;

/**
 * Parses the origin-form request target accepted by the local HTTP servers.
 *
 * Node exposes the raw request target as `request.url`. Do not pass an
 * absolute-form target through `new URL()` with a local base: doing so would
 * silently change the authority used by routing and authentication checks.
 * Invalid or non-canonical targets return undefined instead of throwing so a
 * request cannot turn into an unhandled rejection at an HTTP boundary.
 */
export function parseRequestTarget(target) {
  if (typeof target !== 'string' || target.length === 0 || target[0] !== '/') return undefined;
  if (target.startsWith('//') || invalidTargetCharacters.test(target)) return undefined;

  const queryIndex = target.indexOf('?');
  const rawPathname = queryIndex === -1 ? target : target.slice(0, queryIndex);
  if (invalidPercentEscape.test(rawPathname) || encodedPathSeparator.test(rawPathname)) return undefined;

  try {
    const url = new URL(target, localRequestBase);
    // URL parsing removes literal and encoded dot segments. Reject rather than
    // route a normalised path, keeping every route decision on one spelling.
    if (url.origin !== localRequestBase || url.pathname !== rawPathname) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

export function parseRequestUrl(request) {
  return parseRequestTarget(request?.url);
}

export function rejectInvalidRequestTarget(response) {
  if (response.writableEnded || response.destroyed) return;
  const payload = JSON.stringify({ error: 'Invalid request target' });
  response.writeHead(400, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(payload)),
    'x-content-type-options': 'nosniff',
  });
  response.end(payload);
}

export function rejectInvalidUpgrade(socket) {
  if (!socket || socket.destroyed) return;
  socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  socket.destroy();
}
