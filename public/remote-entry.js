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
  const result = await requestJson(fetchFn, '/remote-auth/pair', 'POST', { secret, deviceName, publicKeyJwk: credential.publicKeyJwk });
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
  const form = document.querySelector('#pair-form');
  const message = document.querySelector('#entry-message');
  const detail = document.querySelector('#entry-detail');
  const connecting = document.querySelector('#connecting');
  const button = document.querySelector('#pair-button');
  const name = document.querySelector('#device-name');
  const lock = (text) => {
    form.hidden = true;
    connecting.hidden = true;
    message.textContent = 'This device is not paired.';
    detail.textContent = text || 'Create a new QR on the Mac and open it in this browser.';
    detail.hidden = false;
  };
  return { form, message, detail, connecting, button, name, lock };
}

export async function boot({ fetchFn = globalThis.fetch, location = globalThis.location, history = globalThis.history, indexedDB = globalThis.indexedDB } = {}) {
  const view = ui();
  const secret = location.pathname === '/pair' ? extractPairingSecret({ location, history }) : undefined;
  if (location.pathname === '/pair') {
    if (!secret) return view.lock('This pairing link has expired or was already used. Create a new QR on the Mac.');
    view.form.hidden = false;
    view.message.textContent = 'Name this device, then pair it securely.';
    view.name.value = navigator.userAgent.includes('Mobile') ? 'Phone' : 'This device';
    view.form.addEventListener('submit', async (event) => {
      event.preventDefault();
      view.button.disabled = true;
      view.button.textContent = 'Pairing…';
      try {
        const credential = await createPersistedCredential({ indexedDB });
        await pairDevice({ secret, deviceName: view.name.value, credential, fetchFn, location, indexedDB });
      } catch (error) {
        view.button.disabled = false;
        view.button.textContent = 'Pair this device';
        view.lock(errorMessage(error));
      }
    });
    return;
  }

  try {
    const status = await requestJson(fetchFn, '/remote-auth/status', 'GET');
    if (status.authenticated) return location.replace('/');
    const credential = await storedDevice({ indexedDB });
    if (!credential) return view.lock();
    view.message.hidden = true;
    view.connecting.hidden = false;
    await reauthenticateDevice({ credential, fetchFn, origin: location.origin });
    location.replace('/');
  } catch (error) {
    view.lock(errorMessage(error));
  }
}

if (typeof document !== 'undefined') void boot();
