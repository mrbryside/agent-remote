export const REMOTE_ERROR_CODES = Object.freeze([
  'REMOTE_UNSUPPORTED',
  'CLOUDFLARED_MISSING',
  'CLOUDFLARED_OUTDATED',
  'TOKEN_INVALID',
  'ZONE_FORBIDDEN',
  'HOSTNAME_CONFLICT',
  'TUNNEL_START_TIMEOUT',
  'PAIRING_EXPIRED',
  'DEVICE_REVOKED',
  'REMOTE_UNAUTHORIZED',
]);

export class RemoteError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'RemoteError';
    this.code = code;
    this.status = status;
  }
}

export function remoteError(code, message, status) {
  return new RemoteError(code, message, status);
}
