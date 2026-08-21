const credentialId = 'current';
const credentialCheck = new TextEncoder().encode('agent-remote:credential-check:v1');
const encoder = new TextEncoder();

function requireCrypto(value) {
  if (!value?.subtle) throw new Error('This browser cannot create a secure device key.');
  return value;
}

function requestValue(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

export function openCredentialStore({ indexedDB = globalThis.indexedDB } = {}) {
  if (!indexedDB?.open) return Promise.reject(new Error('This browser cannot store a device key.'));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('agent-remote', 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('credentials')) request.result.createObjectStore('credentials', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open device key storage.'));
  });
}

async function putCredential(store, credential) {
  const transaction = store.transaction('credentials', 'readwrite');
  await requestValue(transaction.objectStore('credentials').put(credential));
}

async function getCredential(store) {
  const transaction = store.transaction('credentials', 'readonly');
  return requestValue(transaction.objectStore('credentials').get(credentialId));
}

export async function restoreCredential({ indexedDB = globalThis.indexedDB } = {}) {
  const store = await openCredentialStore({ indexedDB });
  return getCredential(store);
}

export async function storedDevice(options = {}) {
  const credential = await restoreCredential(options);
  return credential?.deviceId ? credential : undefined;
}

export function base64url(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export function challengePayload({ challengeId, challenge }, origin) {
  return encoder.encode(`agent-remote:v1:${challengeId}:${challenge}:${origin}`);
}

async function assertCredentialWorks(credential, crypto) {
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, credential.privateKey, credentialCheck);
  const publicKey = await crypto.subtle.importKey(
    'jwk', credential.publicKeyJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'],
  );
  if (!await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, signature, credentialCheck)) {
    throw new Error('The stored device key could not be verified.');
  }
}

export async function createPersistedCredential({ crypto = globalThis.crypto, indexedDB = globalThis.indexedDB } = {}) {
  const secureCrypto = requireCrypto(crypto);
  const generated = await secureCrypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'],
  );
  const publicKeyJwk = await secureCrypto.subtle.exportKey('jwk', generated.publicKey);
  const credential = { id: credentialId, deviceId: undefined, privateKey: generated.privateKey, publicKeyJwk };
  const store = await openCredentialStore({ indexedDB });
  await putCredential(store, credential);
  const persisted = await getCredential(store);
  if (!persisted?.privateKey || persisted.privateKey.extractable !== false) {
    throw new Error('This browser could not persist a non-extractable device key.');
  }
  await assertCredentialWorks(persisted, secureCrypto);
  return persisted;
}

export async function getOrCreatePersistedCredential({ crypto = globalThis.crypto, indexedDB = globalThis.indexedDB } = {}) {
  const secureCrypto = requireCrypto(crypto);
  try {
    const credential = await restoreCredential({ indexedDB });
    if (credential?.privateKey && credential?.publicKeyJwk) {
      await assertCredentialWorks(credential, secureCrypto);
      return credential;
    }
  } catch {
    // Replace missing or unusable browser storage with a fresh device key.
  }
  return createPersistedCredential({ crypto: secureCrypto, indexedDB });
}

async function saveCredential(credential, { indexedDB = globalThis.indexedDB } = {}) {
  const store = await openCredentialStore({ indexedDB });
  await putCredential(store, credential);
}

export function extractPairingSecret({ location = globalThis.location, history = globalThis.history } = {}) {
  const url = new URL(location.href);
  const rawSecret = url.hash.slice(1);
  if (!rawSecret) return undefined;
  url.hash = '';
  history.replaceState(null, '', `${url.pathname}${url.search}`);
  try {
    const secret = decodeURIComponent(rawSecret);
    return /^[A-Za-z0-9_-]+$/.test(secret) ? secret : undefined;
  } catch {
    return undefined;
  }
}

function errorMessage(error) {
  if (error?.code === 'PAIRING_EXPIRED') return 'This pairing link has expired or was already used. Create a new QR on the Mac.';
  if (error?.code === 'DEVICE_REVOKED') return 'This device has been revoked. Create a new QR on the Mac.';
  return error?.message || 'This device is not paired. Create a new QR on the Mac.';
}

export function inferBrowserDeviceName({
  userAgent = globalThis.navigator?.userAgent || '',
  platform = globalThis.navigator?.userAgentData?.platform || globalThis.navigator?.platform || '',
} = {}) {
  let device = 'Paired device';
  if (/iPhone/i.test(userAgent)) device = 'iPhone';
  else if (/iPad/i.test(userAgent) || (/Macintosh/i.test(userAgent) && /Mobile/i.test(userAgent))) device = 'iPad';
  else if (/Android/i.test(userAgent)) device = 'Android device';
  else if (/Mac/i.test(platform) || /Macintosh|Mac OS X/i.test(userAgent)) device = 'Mac';
  else if (/Windows/i.test(platform) || /Windows/i.test(userAgent)) device = 'Windows PC';
  else if (/CrOS|Chrome OS/i.test(userAgent) || /Chrome OS/i.test(platform)) device = 'Chromebook';
  else if (/Linux/i.test(platform) || /Linux/i.test(userAgent)) device = 'Linux device';

  let browser;
  if (/EdgiOS|EdgA|Edg\//i.test(userAgent)) browser = 'Edge';
  else if (/CriOS|Chrome\//i.test(userAgent)) browser = 'Chrome';
  else if (/FxiOS|Firefox\//i.test(userAgent)) browser = 'Firefox';
  else if (/Safari\//i.test(userAgent)) browser = 'Safari';
  return browser ? `${device} · ${browser}` : device;
}

async function requestJson(fetchFn, path, method, body) {
  const response = await fetchFn(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || 'Remote authentication failed.');
    error.code = payload.code;
    throw error;
  }
  return payload;
}

export async function pairDevice({ secret, deviceName, credential, fetchFn = globalThis.fetch, location = globalThis.location, indexedDB = globalThis.indexedDB } = {}) {
  const resolvedDeviceName = typeof deviceName === 'string' ? deviceName : inferBrowserDeviceName();
  const result = await requestJson(fetchFn, '/remote-auth/pair', 'POST', {
    secret,
    deviceName: resolvedDeviceName,
    publicKeyJwk: credential.publicKeyJwk,
  });
  await saveCredential({ ...credential, deviceId: result.device.id }, { indexedDB });
  location.replace('/');
  return result;
}

export async function reauthenticateDevice({
  credential,
  crypto = globalThis.crypto,
  fetchFn = globalThis.fetch,
  origin = globalThis.location.origin,
} = {}) {
  if (!credential?.deviceId || !credential.privateKey) {
    const error = new Error('This device is not paired.');
    error.code = 'REMOTE_UNAUTHORIZED';
    throw error;
  }
  const secureCrypto = requireCrypto(crypto);
  const challenge = await requestJson(fetchFn, '/remote-auth/challenge', 'POST', { deviceId: credential.deviceId });
  const signature = base64url(await secureCrypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, credential.privateKey, challengePayload(challenge, origin),
  ));
  return requestJson(fetchFn, '/remote-auth/verify', 'POST', {
    deviceId: credential.deviceId,
    challengeId: challenge.challengeId,
    signature,
  });
}

export async function logout({ fetchFn = globalThis.fetch } = {}) {
  return requestJson(fetchFn, '/remote-auth/session', 'DELETE');
}

function ui() {
  const status = document.querySelector('#entry-title');
  const detail = document.querySelector('#entry-detail');
  const show = (statusText, detailText = '') => {
    status.textContent = statusText;
    detail.textContent = detailText;
    detail.hidden = !detailText;
  };
  const lock = (text) => {
    show('Remote access is locked', text || 'This browser is not paired. Scan a new QR code from your Mac.');
  };
  const connecting = () => show('Connecting securely…');
  return { lock, connecting };
}

export async function boot({ fetchFn = globalThis.fetch, location = globalThis.location, history = globalThis.history, indexedDB = globalThis.indexedDB } = {}) {
  const view = ui();
  const secret = location.pathname === '/pair' ? extractPairingSecret({ location, history }) : undefined;
  if (location.pathname === '/pair') {
    if (!secret) return view.lock('This pairing link has expired or was already used. Create a new QR on the Mac.');
    view.connecting();
    try {
      const credential = await getOrCreatePersistedCredential({ indexedDB });
      await pairDevice({ secret, credential, fetchFn, location, indexedDB });
    } catch (error) {
      view.lock(errorMessage(error));
    }
    return;
  }

  try {
    const status = await requestJson(fetchFn, '/remote-auth/status', 'GET');
    if (status.authenticated) return location.replace('/');
    const credential = await storedDevice({ indexedDB });
    if (!credential) return view.lock();
    view.connecting();
    await reauthenticateDevice({ credential, fetchFn, origin: location.origin });
    location.replace('/');
  } catch (error) {
    view.lock(errorMessage(error));
  }
}

if (typeof document !== 'undefined') void boot();
