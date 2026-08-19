const token = new URLSearchParams(location.search).get('token');

/** Build a same-origin API URL while retaining the optional local API token. */
export function apiUrl(path) {
  const url = new URL(path, location.origin);
  if (token) url.searchParams.set('token', token);
  return url;
}

/**
 * Fetch JSON from the workspace API. Keeping this small shared boundary means
 * the terminal and the local-only Remote controls authenticate identically.
 */
export async function api(path, options = {}) {
  const response = await fetch(apiUrl(path), {
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
