import { reauthenticateDevice, restoreCredential } from './remote-entry.js';

/** Build a token-free same-origin API URL. Local bootstrap exchanges a legacy
 * `/?token=…` navigation for an HttpOnly session cookie before this runs. */
export function apiUrl(path) {
  const url = new URL(path, location.origin);
  url.searchParams.delete('token');
  return url;
}

async function isRemoteUnauthorized(response) {
  if (response?.status !== 401 || typeof response.clone !== 'function') return false;
  try {
    const payload = await response.clone().json();
    return payload?.code === 'REMOTE_UNAUTHORIZED';
  } catch {
    return false;
  }
}

/** Reissue the process-memory Remote session cookie from the non-extractable
 * device key that survives backend restarts in this browser origin. */
export async function recoverRemoteSession({
  fetchFn = globalThis.fetch,
  indexedDB = globalThis.indexedDB,
  crypto = globalThis.crypto,
  origin = globalThis.location?.origin,
} = {}) {
  const credential = await restoreCredential({ indexedDB });
  return reauthenticateDevice({ credential, crypto, fetchFn, origin });
}

/** Wrap same-origin requests with one transparent Remote re-authentication and
 * one retry. Concurrent 401s share the same challenge/sign/verify operation. */
export function createAuthenticatedFetch({
  fetchFn = globalThis.fetch,
  recoverSession = recoverRemoteSession,
} = {}) {
  let sessionGeneration = 0;
  let recovery;

  return async function authenticatedRequest(input, options = {}) {
    const observedGeneration = sessionGeneration;
    const requestOptions = { credentials: 'same-origin', ...options };
    let response = await fetchFn(input, requestOptions);
    if (!await isRemoteUnauthorized(response)) return response;

    if (sessionGeneration === observedGeneration) {
      if (!recovery) {
        recovery = Promise.resolve()
          .then(() => recoverSession())
          .then(() => { sessionGeneration += 1; });
      }
      const activeRecovery = recovery;
      try {
        await activeRecovery;
      } finally {
        if (recovery === activeRecovery) recovery = undefined;
      }
    }

    response = await fetchFn(input, requestOptions);
    return response;
  };
}

export const authenticatedFetch = createAuthenticatedFetch();

/**
 * Fetch JSON from the workspace API. Keeping this small shared boundary means
 * the terminal and the local-only Remote controls authenticate identically.
 */
export async function api(path, options = {}) {
  const response = await authenticatedFetch(apiUrl(path), {
    ...options,
    headers: { 'content-type': 'application/json', ...options.headers },
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }
  if (!response.ok) {
    const error = new Error(payload.error || `Request failed (${response.status})`);
    if (payload.code) error.code = payload.code;
    throw error;
  }
  return payload;
}
