/** Build a token-free same-origin API URL. Local bootstrap exchanges a legacy
 * `/?token=…` navigation for an HttpOnly session cookie before this runs. */
export function apiUrl(path) {
  const url = new URL(path, location.origin);
  url.searchParams.delete('token');
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
