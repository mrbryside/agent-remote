import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer as createHttpServer, request as createHttpRequest } from 'node:http';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, extname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import * as pty from 'node-pty';
import { WebSocket, WebSocketServer } from 'ws';
import { loadConfig } from './config.js';
import { browseDirectories, resolveAllowedDirectory } from './directories.js';
import { createAgentCatalog } from './agents.js';
import {
  closeTerminalBrowserAgentSession,
  reapStaleTerminalBrowserAgentSessions,
} from './browser-automation.js';
import { createGrokConversationProvider } from './conversations/grok.js';
import { createGrokAcpClient } from './conversations/acp-client.js';
import { createConversationRegistry } from './conversations/registry.js';
import {
  createConversationAttachmentStore,
  maxAttachmentBytes,
  maxAttachmentChunkBytes,
} from './conversations/attachments.js';
import { readProjectFile, resolveProjectFiles, searchProjectFiles } from './conversations/files.js';
import { createProjectStore } from './projects.js';
import { createRemoteAuth } from './remote/auth.js';
import { createCloudflareClient } from './remote/cloudflare.js';
import { createRemoteController } from './remote/controller.js';
import { createRemoteGateway } from './remote/gateway.js';
import { createCloudflareTokenStore } from './remote/keychain.js';
import { createRemoteProvisioner } from './remote/provisioner.js';
import { createRemoteStore } from './remote/store.js';
import { createTunnelManager, inspectCloudflared } from './remote/tunnel.js';
import {
  listManagedSessions,
  managedSessionProcessId,
  renameManagedSession,
  stabilizeManagedSessionSize,
  startManagedSession,
  stopManagedSession,
} from './sessions.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = join(root, 'public');
const agentRemoteBin = join(root, 'bin');
const execFileAsync = promisify(execFile);
const rendererFrameHeaderBytes = 28;
const rendererFrameMagic = 'OTF1';
const browserCursorValues = new Set([
  'default', 'none', 'context-menu', 'help', 'pointer', 'progress', 'wait', 'cell', 'crosshair',
  'text', 'vertical-text', 'alias', 'copy', 'move', 'no-drop', 'not-allowed', 'grab', 'grabbing',
  'all-scroll', 'col-resize', 'row-resize', 'n-resize', 'e-resize', 's-resize', 'w-resize', 'ne-resize',
  'nw-resize', 'se-resize', 'sw-resize', 'ew-resize', 'ns-resize', 'nesw-resize', 'nwse-resize',
  'zoom-in', 'zoom-out',
]);
const browserVirtualKeyCodes = new Map(Object.entries({
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  NumpadEnter: 13,
  ShiftLeft: 16,
  ShiftRight: 16,
  ControlLeft: 17,
  ControlRight: 17,
  AltLeft: 18,
  AltRight: 18,
  Pause: 19,
  CapsLock: 20,
  Escape: 27,
  Space: 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  PrintScreen: 44,
  Insert: 45,
  Delete: 46,
  MetaLeft: 91,
  MetaRight: 92,
  ContextMenu: 93,
  NumpadMultiply: 106,
  NumpadAdd: 107,
  NumpadSubtract: 109,
  NumpadDecimal: 110,
  NumpadDivide: 111,
  NumLock: 144,
  ScrollLock: 145,
  Semicolon: 186,
  Equal: 187,
  Comma: 188,
  Minus: 189,
  Period: 190,
  Slash: 191,
  Backquote: 192,
  BracketLeft: 219,
  Backslash: 220,
  BracketRight: 221,
  Quote: 222,
}));
const cursorProbeFunction = `function(x, y) {
  const element = document.elementFromPoint(x, y);
  if (!element) return 'default';
  const configured = getComputedStyle(element).cursor;
  if (configured && configured !== 'auto') return configured;
  if (element.closest?.('a[href], area[href]')) return 'pointer';
  const editable = element.closest?.('input, textarea, [contenteditable]');
  if (editable) {
    if (editable instanceof HTMLInputElement &&
        ['button', 'checkbox', 'color', 'file', 'image', 'radio', 'range', 'reset', 'submit'].includes(editable.type)) {
      return 'default';
    }
    return 'text';
  }
  return 'default';
}`;

function configuredGrokPermissionMode() {
  const grokHome = process.env.GROK_HOME?.trim() || join(homedir(), '.grok');
  try {
    const source = readFileSync(join(grokHome, 'config.toml'), 'utf8');
    const ui = source.match(/(?:^|\n)\s*\[ui\]\s*\n([\s\S]*?)(?=\n\s*\[|$)/)?.[1] || '';
    const value = ui.match(/(?:^|\n)\s*permission_mode\s*=\s*["']([^"']+)["']/)?.[1];
    if (value === 'auto') return 'auto';
    if (value === 'always-approve' || value === 'bypassPermissions') return 'bypassPermissions';
  } catch {}
  return 'default';
}
const devtoolsBootstrap = `
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const style = document.createElement('style');
style.dataset.agentRemote = 'hide-duplicate-screencast';
style.textContent = '.screencast { display: none !important; }';
document.documentElement.append(style);

async function disableDuplicateScreencast() {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const module = await import('./panels/screencast/screencast.js');
      const app = module.ScreencastApp.ScreencastApp.instance();
      app.enabledSetting.set(false);
      app.onScreencastEnabledChanged();
      app.toggleButton?.setToggled(false);
      document.documentElement.dataset.agentRemoteScreencast = 'disabled';
      return;
    } catch {
      await wait(25);
    }
  }
}

void disableDuplicateScreencast();
`;

function normalizeBrowserCursor(value) {
  if (typeof value !== 'string') return 'default';
  const fallback = value.split(',').at(-1)?.trim().toLowerCase();
  return browserCursorValues.has(fallback) ? fallback : 'default';
}

function browserVirtualKeyCode(message) {
  const code = typeof message.code === 'string' ? message.code : '';
  const mapped = browserVirtualKeyCodes.get(code);
  if (mapped) return mapped;
  if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3);
  if (/^Digit[0-9]$/.test(code)) return code.charCodeAt(5);
  const numpad = code.match(/^Numpad([0-9])$/);
  if (numpad) return 96 + Number(numpad[1]);
  const functionKey = code.match(/^F([1-9]|1[0-9]|2[0-4])$/);
  if (functionKey) return 111 + Number(functionKey[1]);

  const key = typeof message.key === 'string' ? message.key : '';
  const keyMapped = browserVirtualKeyCodes.get(key) || {
    ' ': 32,
    Spacebar: 32,
    Esc: 27,
    Del: 46,
  }[key];
  if (keyMapped) return keyMapped;
  if (/^[a-z]$/i.test(key)) return key.toUpperCase().charCodeAt(0);
  if (/^[0-9]$/.test(key)) return key.charCodeAt(0);
  return Number.isInteger(message.keyCode) && message.keyCode > 0 && message.keyCode <= 255
    ? message.keyCode
    : 0;
}

function rendererViewport(width, height) {
  const cssWidth = Math.max(160, Math.min(4096, Math.floor(width)));
  const cssHeight = Math.max(120, Math.min(4096, Math.floor(height)));
  return {
    width: cssWidth,
    height: cssHeight,
  };
}

export function selectRendererViewport(requests, fallback) {
  const candidates = [...(requests || [])].filter((viewport) =>
    Number.isInteger(viewport?.width) && viewport.width >= 160 && viewport.width <= 4096 &&
    Number.isInteger(viewport?.height) && viewport.height >= 120 && viewport.height <= 4096);
  if (candidates.length === 0) return fallback ? rendererViewport(fallback.width, fallback.height) : undefined;
  return candidates.reduce((largest, candidate) => {
    const area = candidate.width * candidate.height;
    const largestArea = largest.width * largest.height;
    if (area !== largestArea) return area > largestArea ? candidate : largest;
    return candidate.width > largest.width ? candidate : largest;
  });
}

function jpegDimensions(data) {
  let buffer;
  try {
    // JPEG dimensions live in the header. Decoding an entire multi-megabyte
    // Retina frame just to read its SOF marker wastes a full-frame allocation
    // on every animation tick.
    if (Buffer.isBuffer(data)) {
      buffer = data.subarray(0, Math.min(data.length, 48 * 1024));
    } else {
      const prefixLength = Math.min(data.length, 64 * 1024);
      const alignedLength = prefixLength - (prefixLength % 4);
      buffer = Buffer.from(data.slice(0, alignedLength || prefixLength), 'base64');
    }
  } catch { return undefined; }
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return undefined;
  for (let offset = 2; offset + 8 < buffer.length;) {
    if (buffer[offset] !== 0xff) { offset += 1; continue; }
    const marker = buffer[offset + 1];
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) break;
    offset += 2 + length;
  }
  return undefined;
}

const staticRoutes = new Map([
  ['/', join(publicDir, 'index.html')],
  ['/manifest.webmanifest', join(publicDir, 'manifest.webmanifest')],
  ['/document-boot.js', join(publicDir, 'document-boot.js')],
  ['/workspace-boot.js', join(publicDir, 'workspace-boot.js')],
  ['/app.js', join(publicDir, 'app.js')],
  ['/api-client.js', join(publicDir, 'api-client.js')],
  ['/prompt-title.js', join(publicDir, 'prompt-title.js')],
  ['/ui-components.js', join(publicDir, 'ui-components.js')],
  ['/remote-control.js', join(publicDir, 'remote-control.js')],
  ['/mobile-conversation.js', join(publicDir, 'mobile-conversation.js')],
  ['/markdown.js', join(publicDir, 'markdown.js')],
  ['/syntax.js', join(publicDir, 'syntax.js')],
  ['/tokens.css', join(publicDir, 'tokens.css')],
  ['/styles.css', join(publicDir, 'styles.css')],
  ['/vendor/xterm.js', join(root, 'node_modules/@xterm/xterm/lib/xterm.js')],
  ['/vendor/xterm.css', join(root, 'node_modules/@xterm/xterm/css/xterm.css')],
  ['/vendor/addon-fit.js', join(root, 'node_modules/@xterm/addon-fit/lib/addon-fit.js')],
  ['/vendor/addon-image.js', join(root, 'node_modules/@xterm/addon-image/lib/addon-image.js')],
  ['/vendor/marked.js', join(root, 'node_modules/marked/lib/marked.esm.js')],
  ['/vendor/dompurify.js', join(root, 'node_modules/dompurify/dist/purify.es.mjs')],
  ['/vendor/highlight.js', join(root, 'node_modules/@highlightjs/cdn-assets/es/highlight.min.js')],
]);

const localControlBlockStart = '<!-- local-control:start -->';
const localControlBlockEnd = '<!-- local-control:end -->';

function stripLocalControlBlocks(source) {
  let stripped = '';
  let remainder = source;
  while (remainder.includes(localControlBlockStart)) {
    const start = remainder.indexOf(localControlBlockStart);
    const end = remainder.indexOf(localControlBlockEnd, start + localControlBlockStart.length);
    if (end < 0) return undefined;
    stripped += remainder.slice(0, start);
    remainder = remainder.slice(end + localControlBlockEnd.length);
  }
  stripped += remainder;
  if (stripped.includes(localControlBlockEnd)) return undefined;
  if (/id="(?:remote-button|remote-dialog|cloudflare-token-guide-dialog)"/.test(stripped)) return undefined;
  return stripped;
}

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

const remoteWorkspaceDocumentHeaders = Object.freeze({
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https: http:; connect-src 'self'; worker-src 'self' blob:; font-src 'self' data:",
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
});

function sendJson(socket, payload) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function authorized(request, config) {
  if (!config.token) return true;
  const url = new URL(request.url, 'http://localhost');
  const bearer = request.headers.authorization?.replace(/^Bearer\s+/i, '');
  return url.searchParams.get('token') === config.token || bearer === config.token;
}

function json(response, status, payload) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error('Request body is too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('Invalid JSON body');
  }
}

async function readBytes(request, maximum = maxAttachmentBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximum) throw requestError(413, 'Attachment is too large', 'ATTACHMENT_TOO_LARGE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function requestError(status, message, code) {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
}

async function readRemoteJson(request) {
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
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw requestError(400, 'Invalid JSON body');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw requestError(400, 'JSON body must be an object');
  }
  return body;
}

function remoteApiError(response, error) {
  const status = Number.isInteger(error?.status) ? error.status : 400;
  const payload = { error: error?.message || 'Invalid Remote request' };
  if (typeof error?.code === 'string') payload.code = error.code;
  return json(response, status, payload);
}

function safeRemoteDevice(device) {
  return {
    id: device.id,
    name: device.name,
    createdAt: device.createdAt,
    lastUsedAt: device.lastUsedAt,
    revokedAt: device.revokedAt,
  };
}

function sameOrigin(request) {
  if (typeof request.headers.origin !== 'string' || !request.headers.origin) return false;
  try {
    return new URL(request.headers.origin).host === request.headers.host;
  } catch {
    return false;
  }
}

function namedTunnelInput(settings) {
  if (settings?.desiredState !== 'running' || typeof settings.zoneId !== 'string'
    || typeof settings.zoneName !== 'string' || typeof settings.hostname !== 'string') return undefined;
  const suffix = `.${settings.zoneName}`;
  if (!settings.hostname.endsWith(suffix)) return undefined;
  const subdomain = settings.hostname.slice(0, -suffix.length);
  if (!subdomain || subdomain.includes('.')) return undefined;
  return { zoneId: settings.zoneId, subdomain };
}

function originAllowed(request, config) {
  const origin = request.headers.origin;
  if (!origin) return true;
  if (config.allowedOrigins.includes(origin)) return true;

  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

function canonicalBrowserUrl(value) {
  const trimmed = value?.trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`);
    parsed.hash = '';
    if ((parsed.protocol === 'https:' && parsed.port === '443') ||
        (parsed.protocol === 'http:' && parsed.port === '80')) parsed.port = '';
    if (parsed.pathname === '/') parsed.pathname = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return trimmed;
  }
}

export function createTerminalServer(options = {}) {
  const config = loadConfig(options);
  const agentCatalog = createAgentCatalog(options.agentDefinitions);
  const clients = new Set();
  const conversationStreams = new Set();
  const workspaceStreams = new Set();
  let workspaceRevision = 0;
  const conversationInputQueues = new Map();
  const conversationInputRequests = new Map();
  const clientContexts = new Map();
  const renderers = new Map();
  const browserAgentCleanups = new Set();
  const rendererCleanups = new Set();
  const rendererDiscoveryAttempts = Number.isInteger(options.rendererDiscoveryAttempts)
    ? Math.max(1, options.rendererDiscoveryAttempts)
    : 50;
  const rendererDiscoveryIntervalMs = Number.isInteger(options.rendererDiscoveryIntervalMs)
    ? Math.max(0, options.rendererDiscoveryIntervalMs)
    : 200;
  const rendererCloseMinimumMs = Number.isInteger(options.rendererCloseMinimumMs)
    ? Math.max(0, options.rendererCloseMinimumMs)
    : 2_500;
  const rendererCloseGraceMs = Number.isInteger(options.rendererCloseGraceMs)
    ? Math.max(rendererCloseMinimumMs, options.rendererCloseGraceMs)
    : Math.max(rendererCloseMinimumMs, 5_000);
  const rendererClosePollMs = Number.isInteger(options.rendererClosePollMs)
    ? Math.max(5, options.rendererClosePollMs)
    : 100;
  const sessionRendererSweepIntervalMs = Number.isInteger(options.sessionRendererSweepIntervalMs)
    ? Math.max(0, options.sessionRendererSweepIntervalMs)
    : 10_000;
  const closeBrowserAutomationSession = options.closeBrowserAutomationSession
    ?? closeTerminalBrowserAgentSession;
  const reapBrowserAutomationSessions = options.reapBrowserAutomationSessions
    ?? reapStaleTerminalBrowserAgentSessions;
  const projectStore = createProjectStore(config.databaseFile);
  let localControlUrl = '';
  let sessionRendererSweepTimer;
  let sessionRendererSweepRunning = false;
  let serverClosing = false;

  function publishWorkspaceChange({ type = 'workspace-changed', deleted = [] } = {}) {
    const event = {
      revision: ++workspaceRevision,
      type,
      deleted: [...new Set(deleted.filter((name) => typeof name === 'string' && name))],
    };
    for (const stream of [...workspaceStreams]) stream.send?.(event);
    return event;
  }

  function openWorkspaceStream(request, response, surface) {
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-content-type-options': 'nosniff',
    });
    response.flushHeaders?.();
    response.socket?.setNoDelay?.(true);
    response.write(`:${' '.repeat(2_048)}\nretry: 1000\n\n`);
    let closed = false;
    let untrackRemoteStream = () => {};
    const close = async () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      workspaceStreams.delete(close);
      untrackRemoteStream();
      if (!response.writableEnded) response.end();
    };
    close.send = (event) => {
      if (closed || response.writableEnded) return;
      response.write(`id: ${event.revision}\nevent: workspace\ndata: ${JSON.stringify(event)}\n\n`);
      response.flush?.();
    };
    const heartbeat = setInterval(() => {
      if (!closed && !response.writableEnded) {
        response.write(`event: heartbeat\ndata: ${Date.now()}\n\n`);
        response.flush?.();
      }
    }, 15_000);
    heartbeat.unref?.();
    workspaceStreams.add(close);
    if (surface === 'remote') untrackRemoteStream = remoteGateway.trackStream(close, request);
    response.once('close', () => void close());
    response.write(`event: ready\ndata: ${JSON.stringify({ revision: workspaceRevision })}\n\n`);
  }
  const grokAcpClient = options.grokAcpClient ?? createGrokAcpClient({
    command: options.grokCommand ?? 'grok',
    spawn: options.grokAcpSpawn,
    logger: options.grokAcpLogger,
    leaderSocket: config.grokLeaderSocket,
    environment: () => ({
      AGENT_REMOTE_WEB: '1',
      AGENT_REMOTE_ACP: '1',
      ...(localControlUrl ? { AGENT_REMOTE_URL: localControlUrl } : {}),
      PATH: `${agentRemoteBin}${delimiter}${process.env.PATH ?? ''}`,
    }),
    defaultPermissionMode: options.grokDefaultPermissionMode ?? configuredGrokPermissionMode(),
  });
  const conversationRegistry = options.conversationRegistry ?? createConversationRegistry({
    providers: [createGrokConversationProvider({ acpClient: grokAcpClient })],
  });
  const conversationAttachments = options.conversationAttachments ?? createConversationAttachmentStore();
  const remoteStore = options.remoteStore ?? createRemoteStore(config.databaseFile);
  const remoteDeviceSockets = new Map();
  let remoteGateway;
  const closeRemoteDeviceSockets = (deviceId) => {
    const sockets = remoteDeviceSockets.get(deviceId);
    if (sockets) {
      for (const socket of [...sockets]) {
        if (socket.readyState < WebSocket.CLOSING) socket.close(4003, 'Device revoked');
      }
    }
    remoteGateway?.closeDeviceConnections(deviceId);
  };
  const remoteAuth = options.remoteAuth ?? createRemoteAuth({
    store: remoteStore,
    now: options.remoteAuthNow,
    randomBytes: options.remoteAuthRandomBytes,
    secureCookies: options.remoteSecureCookies ?? true,
    allowInsecurePublicOrigin: options.remoteAllowInsecurePublicOrigin === true,
    onRevoke: closeRemoteDeviceSockets,
  });
  const remoteTokenStore = options.remoteTokenStore ?? createCloudflareTokenStore({
    execFile: options.remoteKeychainExecFile,
    platform: options.remotePlatform ?? process.platform,
  });
  const remoteProvisioner = options.remoteProvisioner ?? createRemoteProvisioner({
    store: remoteStore,
    tokenStore: remoteTokenStore,
    createClient: options.remoteCreateClient ?? ((input) => createCloudflareClient({
      fetch: options.remoteFetch ?? globalThis.fetch,
      ...input,
    })),
    remoteOrigin: `http://${config.remoteHost}:${config.remotePort}`,
  });
  const tunnelManager = options.tunnelManager ?? createTunnelManager({
    command: config.cloudflaredBin,
    store: remoteStore,
    remoteOrigin: `http://${config.remoteHost}:${config.remotePort}`,
  });
  const remoteController = options.remoteController ?? createRemoteController({
    auth: remoteAuth,
    provisioner: remoteProvisioner,
    tokenStore: remoteTokenStore,
    tunnelManager,
    inspectCloudflared: options.remoteInspectCloudflared ??
      (() => inspectCloudflared({ command: config.cloudflaredBin, execFile: options.remoteCloudflaredExecFile })),
    getNamedSettings: () => remoteStore.getSettings(),
    toDataURL: options.remoteToDataURL,
    platform: options.remotePlatform ?? process.platform,
    allowInsecurePublicOrigin: options.remoteAllowInsecurePublicOrigin === true,
  });
  remoteGateway = createRemoteGateway({
    auth: remoteAuth,
    getPublicUrl: options.getRemotePublicUrl ?? (() => options.remotePublicUrl ?? tunnelManager.status().publicUrl),
    allowInsecurePublicOrigin: options.remoteAllowInsecurePublicOrigin === true,
    now: options.remoteAuthNow ?? Date.now,
  });
  let remoteRestore = Promise.resolve();

  async function restoreNamedTunnel() {
    const input = namedTunnelInput(remoteStore.getSettings?.());
    if (!input) return;
    await remoteController.startNamed(input);
  }
  const rendererKeyPattern = /^(?:builtin:(?:shell|graphics)|session:[A-Za-z0-9_.-]{1,64})$/;

  async function listWorkspaceSessions() {
    const sessions = options.listWorkspaceSessions
      ? await options.listWorkspaceSessions()
      : await listManagedSessions(config.tmuxCommand);
    const chats = new Map(projectStore.listChats().map((chat) => [chat.name, chat]));
    const workspaceSessions = options.listWorkspaceSessions ? sessions : sessions.map((session) => {
      let chat = chats.get(session.name);
      if (!chat && session.projectId && projectStore.get(session.projectId)) {
        chat = projectStore.saveChat({
          name: session.name,
          projectId: session.projectId,
          title: session.label,
          autoTitle: session.autoTitle,
          createdAt: session.createdAt,
        });
      }
      return chat
        ? {
            ...session,
            label: chat.title,
            projectId: chat.projectId,
            autoTitle: chat.autoTitle,
            lastActiveAt: chat.lastActiveAt,
          }
        : { ...session, lastActiveAt: session.createdAt };
    });
    return Promise.all(workspaceSessions.map(async (session) => {
      if (typeof conversationRegistry.status !== 'function') return session;
      try {
        const conversationStatus = await conversationRegistry.status(session);
        return conversationStatus === 'working' || conversationStatus === 'idle'
          ? { ...session, conversationStatus }
          : session;
      } catch {
        // Session discovery and terminal access remain available while an
        // optional conversation provider reconnects.
        return session;
      }
    }));
  }

  async function conversationSession(name) {
    const session = (await listWorkspaceSessions()).find((item) => item.name === name);
    if (!session) return undefined;
    const processId = options.managedSessionProcessId
      ? await options.managedSessionProcessId(session)
      : await managedSessionProcessId(config.tmuxCommand, session.name);
    return { ...session, processId };
  }

  async function resolveControlSession({ session, cwd } = {}) {
    if (session) return { session };
    if (!cwd) return { session: undefined };
    const requestedCwd = resolvePath(cwd);
    const workspaceSessions = (await listWorkspaceSessions()).filter((item) =>
      typeof item.cwd === 'string' && resolvePath(item.cwd) === requestedCwd);
    const connectedNames = new Set([
      ...[...clientContexts.values()]
        .filter((context) => context.mode !== 'graphics' && context.session)
        .map((context) => context.session),
      ...[...conversationStreams]
        .map((stream) => stream.sessionName)
        .filter(Boolean),
    ]);
    const connected = workspaceSessions.filter((item) => connectedNames.has(item.name));
    if (connected.length === 1) return { session: connected[0].name };
    const working = connected.filter((item) => item.conversationStatus === 'working');
    if (working.length === 1) return { session: working[0].name };
    if (connected.length > 1) return { error: 'More than one active chat uses that project folder' };
    return { error: 'No active chat uses that project folder' };
  }

  async function deliverConversationInput(session, text, inputOptions = {}) {
    const previous = conversationInputQueues.get(session.name) ?? Promise.resolve();
    const delivery = previous.catch(() => {}).then(() =>
      conversationRegistry.sendSessionInput(session, text, inputOptions));
    conversationInputQueues.set(session.name, delivery);
    try {
      return await delivery;
    } finally {
      if (conversationInputQueues.get(session.name) === delivery) conversationInputQueues.delete(session.name);
    }
  }

  function conversationFailure(response, error) {
    if (error?.code?.startsWith?.('GROK_ACP') || /Grok ACP/i.test(error?.message || '')) {
      return json(response, 503, {
        error: 'Connecting to Grok', code: 'CONVERSATION_INITIALIZING',
      });
    }
    throw error;
  }

  async function stopProjectSessions(projectId) {
    const sessions = (await listWorkspaceSessions())
      .filter((session) => session.projectId === projectId);
    for (const session of sessions) {
      await stopManagedSession(config.tmuxCommand, session.name);
      closeRenderer(`session:${session.name}`);
    }
    projectStore.removeProjectChats(projectId);
    if (sessions.length) {
      publishWorkspaceChange({
        type: 'sessions-deleted',
        deleted: sessions.map((session) => session.name),
      });
    }
    return sessions.length;
  }

  function shellQuote(value) {
    if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
    return `'${value.replaceAll("'", `'"'"'`)}'`;
  }

  async function readTerminalBrowsers() {
    try {
      const { stdout } = await execFileAsync(join(agentRemoteBin, 'terminal-browser'), ['ls', '--all', '--json'], {
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
        // This is the renderer owner's global discovery pass. The public shim
        // normally narrows `ls` to one chat, which would recurse through this
        // server before renderer.browserKey has been assigned.
        env: { ...process.env, AGENT_REMOTE_GRAPHICS: '1' },
      });
      const parsed = JSON.parse(stdout);
      return Array.isArray(parsed.browsers) ? parsed.browsers : [];
    } catch {
      return [];
    }
  }
  const listTerminalBrowsers = options.listTerminalBrowsers ?? readTerminalBrowsers;

  function rendererBrowserCandidate(renderer, browsers, previousKeys = new Set()) {
    const claimed = new Set([...renderers.values()]
      .filter((item) => item !== renderer)
      .map((item) => item.browserKey)
      .filter(Boolean));
    const candidates = browsers.filter((browser) =>
      browser?.key && !previousKeys.has(browser.key) && !claimed.has(browser.key));
    const rendererTty = renderer.terminal?._pty;
    const exact = rendererTty && candidates.find((browser) => browser.tty === rendererTty);
    if (exact) return exact;
    // terminal-browser v0.5.8 and newer publishes the owning PTY. Retain a
    // narrow fallback for older builds only when there is exactly one
    // candidate without ownership metadata; guessing among multiple browsers
    // risks attaching to or closing another chat.
    const legacy = candidates.filter((browser) => !browser.tty);
    return legacy.length === 1 ? legacy[0] : undefined;
  }

  function rememberRendererBrowser(renderer, browser) {
    if (!browser?.key || (renderer.browserKey && renderer.browserKey !== browser.key)) return false;
    renderer.browserKey = browser.key;
    renderer.browserSocket = browser.socket;
    if (renderer.closing) cleanUpRendererBrowserAgent(renderer);
    return true;
  }

  function cleanUpRendererBrowserAgent(renderer) {
    if (renderer.agentCleanupStarted || !renderer.browserKey) return;
    renderer.agentCleanupStarted = true;
    const task = (async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (await closeBrowserAutomationSession(renderer.browserKey)) return;
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 100));
      }
    })()
      .catch(() => {})
      .finally(() => browserAgentCleanups.delete(task));
    browserAgentCleanups.add(task);
  }

  function killRendererTerminal(renderer) {
    if (renderer.terminalKilled) return;
    renderer.terminalKilled = true;
    renderer.output?.dispose();
    renderer.exit?.dispose();
    try { renderer.terminal.kill(); } catch {}
  }

  async function finishRendererClose(renderer) {
    const startedAt = Date.now();
    const deadline = startedAt + rendererCloseGraceMs;
    let observedBrowser = Boolean(renderer.browserKey);
    while (!serverClosing && Date.now() < deadline) {
      if (renderer.browserLaunchStarted) {
        let browsers = [];
        try { browsers = await listTerminalBrowsers(); } catch {}
        const owned = renderer.browserKey
          ? browsers.find((browser) => browser.key === renderer.browserKey)
          : rendererBrowserCandidate(renderer, browsers, renderer.previousBrowserKeys);
        if (owned) {
          observedBrowser = true;
          rememberRendererBrowser(renderer, owned);
          cleanUpRendererBrowserAgent(renderer);
        }
        const minimumElapsed = Date.now() - startedAt >= rendererCloseMinimumMs;
        if (minimumElapsed && observedBrowser && !owned) break;
        if (minimumElapsed && !observedBrowser) break;
      } else if (Date.now() - startedAt >= Math.min(100, rendererCloseMinimumMs)) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, rendererClosePollMs));
    }
    killRendererTerminal(renderer);
  }

  function trackRendererClose(renderer) {
    const task = finishRendererClose(renderer)
      .catch(() => killRendererTerminal(renderer))
      .finally(() => rendererCleanups.delete(task));
    rendererCleanups.add(task);
  }

  async function sweepSessionRenderers() {
    if (sessionRendererSweepRunning || serverClosing) return;
    sessionRendererSweepRunning = true;
    try {
      const sessions = options.listWorkspaceSessions
        ? await options.listWorkspaceSessions()
        : await listManagedSessions(config.tmuxCommand);
      const live = new Set(sessions.map((session) => session.name));
      for (const [key] of renderers) {
        if (key.startsWith('session:') && !live.has(key.slice('session:'.length))) {
          closeRenderer(key, 'Owning chat ended');
        }
      }
    } catch {
      // A transient tmux/provider discovery failure must not close a browser
      // whose owner may still be alive. The next sweep retries.
    } finally {
      sessionRendererSweepRunning = false;
    }
  }

  function scheduleSessionRendererSweep() {
    if (serverClosing || sessionRendererSweepIntervalMs === 0 || sessionRendererSweepTimer) return;
    if (![...renderers.keys()].some((key) => key.startsWith('session:'))) return;
    sessionRendererSweepTimer = setTimeout(async () => {
      sessionRendererSweepTimer = undefined;
      await sweepSessionRenderers();
      scheduleSessionRendererSweep();
    }, sessionRendererSweepIntervalMs);
    sessionRendererSweepTimer.unref?.();
  }

  function controlTerminalBrowser(socketPath, request) {
    return new Promise((resolve, reject) => {
      const connection = createConnection(socketPath);
      let buffer = '';
      const timer = setTimeout(() => {
        connection.destroy();
        reject(new Error('terminal-browser control timed out'));
      }, 5000);
      const finish = (error, value) => {
        clearTimeout(timer);
        connection.destroy();
        if (error) reject(error);
        else resolve(value);
      };
      connection.setEncoding('utf8');
      connection.once('connect', () => connection.write(`${JSON.stringify(request)}\n`));
      connection.on('data', (chunk) => {
        buffer += chunk;
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        try {
          const reply = JSON.parse(buffer.slice(0, newline));
          if (!reply.ok) finish(new Error(reply.error || 'terminal-browser control failed'));
          else finish(null, reply.data);
        } catch (error) {
          finish(error);
        }
      });
      connection.once('error', (error) => finish(error));
    });
  }

  function browserSurface(browser, activeTab, renderer) {
    return {
      browserKey: browser.key,
      targetId: activeTab.targetId,
      url: activeTab.url || '',
      title: activeTab.title || '',
      tabs: (browser.tabs || []).map(({ id, url, title, active }) => ({ id, url, title, active })),
      devtoolsPath: `/devtools/${renderer.devtoolsAccess}/inspector.html`,
      devtoolsAccess: renderer.devtoolsAccess,
    };
  }

  function browserListing(browser) {
    const tabs = (browser?.tabs || []).map(({ id, url, title, active }) => ({
      id, url: url || '', title: title || '', active: Boolean(active),
    }));
    const active = tabs.find((tab) => tab.active) || tabs[0];
    return {
      key: browser?.key,
      url: active?.url || '',
      title: active?.title || '',
      tabs,
    };
  }

  function sendCdp(renderer, method, params = {}) {
    if (!renderer.cdp || renderer.cdp.readyState !== WebSocket.OPEN) return Promise.reject(new Error('CDP is not connected'));
    const id = ++renderer.cdpSequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        renderer.cdpPending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 5000);
      renderer.cdpPending.set(id, { resolve, reject, timer });
      renderer.cdp.send(JSON.stringify({ id, method, params }));
    });
  }

  function rendererFrameMessage(renderer) {
    if (!renderer.lastFrame) return undefined;
    const frame = renderer.lastFrame;
    const message = Buffer.allocUnsafe(rendererFrameHeaderBytes + frame.data.length);
    message.write(rendererFrameMagic, 0, 4, 'ascii');
    message.writeUInt32BE(frame.sequence >>> 0, 4);
    message.writeUInt32BE(frame.viewportGeneration >>> 0, 8);
    message.writeUInt32BE(frame.width >>> 0, 12);
    message.writeUInt32BE(frame.height >>> 0, 16);
    message.writeUInt32BE(frame.pixelWidth >>> 0, 20);
    message.writeUInt32BE(frame.pixelHeight >>> 0, 24);
    frame.data.copy(message, rendererFrameHeaderBytes);
    return message;
  }

  function sendRendererFrame(client, message) {
    if (!message || client.readyState !== WebSocket.OPEN || client.rendererVisible === false) return;
    if (client.rendererFrameSending) {
      // Keep only the newest frame while the previous WebSocket write is in
      // flight. This bounds memory and latency during fast animations.
      client.pendingRendererFrame = message;
      return;
    }
    client.rendererFrameSending = true;
    client.send(message, { binary: true, compress: false }, (error) => {
      client.rendererFrameSending = false;
      const pending = client.pendingRendererFrame;
      client.pendingRendererFrame = undefined;
      if (!error && pending) sendRendererFrame(client, pending);
    });
  }

  function setRendererState(renderer, state, message) {
    if (renderer.state === state && renderer.stateMessage === message) return;
    renderer.state = state;
    renderer.stateMessage = message;
    const payload = { type: 'renderer-state', state };
    if (message) payload.message = message;
    for (const client of renderer.clients) sendJson(client, payload);
  }

  function requestRendererViewport(renderer) {
    const requested = selectRendererViewport(
      [...renderer.clients]
        .filter((client) => client.readyState === WebSocket.OPEN && client.rendererVisible !== false)
        .map((client) => client.rendererViewport)
        .filter(Boolean),
      renderer.pendingViewport || renderer.viewport,
    );
    if (!requested) return;
    const pending = renderer.pendingViewport;
    const current = renderer.viewport;
    if ((pending && pending.width === requested.width && pending.height === requested.height) ||
        (!pending && current && current.width === requested.width && current.height === requested.height)) return;
    renderer.pendingViewport = requested;
    if (renderer.cdp) void configureRendererViewport(renderer).catch((error) => {
      setRendererState(renderer, 'failed', error.message || 'Browser viewport configuration failed');
    });
  }

  function publishRendererFrame(renderer, data, viewport = renderer.viewport) {
    if (!data || !viewport) return;
    let frameData;
    try {
      frameData = Buffer.isBuffer(data) ? data : Buffer.from(data, 'base64');
    } catch { return; }
    const dimensions = jpegDimensions(frameData);
    if (dimensions) {
      const frameRatio = dimensions.width / dimensions.height;
      const viewportRatio = viewport.width / viewport.height;
      if (Math.abs(frameRatio - viewportRatio) > 0.025) return;
    }
    renderer.lastFrame = {
      data: frameData,
      width: viewport.width,
      height: viewport.height,
      pixelWidth: dimensions?.width || viewport.width,
      pixelHeight: dimensions?.height || viewport.height,
      viewportGeneration: renderer.viewportGeneration,
      sequence: ++renderer.frameSequence,
    };
    const message = rendererFrameMessage(renderer);
    for (const client of renderer.clients) {
      sendRendererFrame(client, message);
    }
  }

  function rendererHasVisibleClient(renderer) {
    return [...renderer.clients].some((client) =>
      client.readyState === WebSocket.OPEN && client.rendererVisible !== false);
  }

  function broadcastCursor(renderer, value) {
    const cursor = normalizeBrowserCursor(value);
    if (renderer.cursor === cursor) return;
    renderer.cursor = cursor;
    for (const client of renderer.clients) sendJson(client, { type: 'cursor', value: cursor });
  }

  function scheduleCursorProbe(renderer, x, y) {
    renderer.cursorProbePoint = { x, y };
    if (renderer.cursorProbeTimer || renderer.cursorProbeRunning) return;
    renderer.cursorProbeTimer = setTimeout(async () => {
      renderer.cursorProbeTimer = undefined;
      const point = renderer.cursorProbePoint;
      renderer.cursorProbePoint = undefined;
      if (!point || !renderer.cdp || renderer.closing) return;
      renderer.cursorProbeRunning = true;
      try {
        const result = await sendCdp(renderer, 'Runtime.evaluate', {
          expression: `(${cursorProbeFunction})(${Math.max(0, point.x)}, ${Math.max(0, point.y)})`,
          returnByValue: true,
          silent: true,
        });
        broadcastCursor(renderer, result?.result?.value);
      } catch {
        broadcastCursor(renderer, 'default');
      } finally {
        renderer.cursorProbeRunning = false;
        if (renderer.cursorProbePoint) scheduleCursorProbe(renderer, renderer.cursorProbePoint.x, renderer.cursorProbePoint.y);
      }
    }, 50);
    renderer.cursorProbeTimer.unref?.();
  }

  async function configureRendererViewport(renderer) {
    if (!renderer.cdp || renderer.configuringViewport || renderer.closing) return;
    const configuration = {};
    renderer.configuringViewport = configuration;
    const active = () => renderer.configuringViewport === configuration && renderer.cdp && !renderer.closing;
    try {
      while (renderer.pendingViewport && active()) {
        const viewport = renderer.pendingViewport;
        renderer.pendingViewport = undefined;
        const force = renderer.forceViewportConfiguration === true;
        renderer.forceViewportConfiguration = false;
        const unchanged = !force && renderer.viewport &&
          renderer.viewport.width === viewport.width &&
          renderer.viewport.height === viewport.height;
        if (!unchanged) {
          // Page.startScreencast owns the displayed stream directly. Layout,
          // input, and raster share one CSS-pixel coordinate space, avoiding
          // scale artifacts and a second screenshot pass for every frame.
          await sendCdp(renderer, 'Page.stopScreencast').catch(() => {});
          renderer.screencastStarted = false;
          await sendCdp(renderer, 'Emulation.setDeviceMetricsOverride', {
            width: viewport.width,
            height: viewport.height,
            deviceScaleFactor: 1,
            mobile: false,
            screenWidth: viewport.width,
            screenHeight: viewport.height,
          });
          if (!active()) return;
          renderer.viewport = viewport;
          renderer.viewportGeneration += 1;
          renderer.lastFrame = undefined;
        }
        if (!rendererHasVisibleClient(renderer)) {
          if (renderer.screencastStarted) {
            await sendCdp(renderer, 'Page.stopScreencast').catch(() => {});
            renderer.screencastStarted = false;
          }
          continue;
        }
        if (renderer.screencastStarted) continue;
        // A target can retain a screencast across CDP connections. Clear it
        // before attaching our direct live stream.
        await sendCdp(renderer, 'Page.stopScreencast').catch(() => {});
        if (!active()) return;
        await sendCdp(renderer, 'Page.startScreencast', {
          format: 'jpeg',
          quality: 90,
          everyNthFrame: 1,
        });
        if (!active()) return;
        renderer.screencastStarted = true;
        // Chrome occasionally waits for a compositor invalidation before the
        // first screencast frame (especially on an idle page). Capture one
        // exact-viewport fallback so the loading cover never depends on the
        // user resizing the pane. A live frame always wins if it arrives.
        const sequenceBeforeCapture = renderer.frameSequence;
        const screenshot = await sendCdp(renderer, 'Page.captureScreenshot', {
          format: 'jpeg', quality: 90, fromSurface: true,
        }).catch(() => undefined);
        if (active() && screenshot?.data && renderer.frameSequence === sequenceBeforeCapture) {
          publishRendererFrame(renderer, screenshot.data, renderer.viewport);
        }
      }
    } finally {
      if (renderer.configuringViewport !== configuration) return;
      renderer.configuringViewport = undefined;
      if (renderer.pendingViewport && renderer.cdp && !renderer.closing) {
        void configureRendererViewport(renderer).catch(() => {});
      }
    }
  }

  function broadcastSurface(renderer) {
    if (!renderer.surface) return;
    for (const client of renderer.clients) {
      sendJson(client, { type: 'surface', ...renderer.surface });
      const frame = rendererFrameMessage(renderer);
      if (frame) sendRendererFrame(client, frame);
      sendJson(client, { type: 'cursor', value: renderer.cursor || 'default' });
    }
  }

  function broadcastSurfaceInfo(renderer) {
    if (!renderer.surface) return;
    for (const client of renderer.clients) sendJson(client, { type: 'surface', ...renderer.surface });
  }

  async function connectRendererSurface(renderer, browser) {
    const activeTab = browser.tabs?.find((tab) => tab.active) || browser.tabs?.[0];
    if (!activeTab?.targetId || !browser.cdpPort) return;
    // A tab switch replaces the CDP target, not the pane. Preserve the pane's
    // last requested viewport so the new target never emits an intermediate
    // 1280x720 frame or waits for the frontend to resize it again.
    const desiredViewport = renderer.pendingViewport || renderer.viewport || rendererViewport(
      browser.viewport?.width || 1280,
      browser.viewport?.height || 720,
    );
    const targets = await (await fetch(`http://127.0.0.1:${browser.cdpPort}/json/list`)).json();
    const target = targets.find((item) => item.id === activeTab.targetId) || targets.find((item) => item.type === 'page');
    if (!target?.webSocketDebuggerUrl) return;
    // Invalidate any async viewport work that belongs to the previous target.
    // Its finally block must not clear or resize the replacement connection.
    renderer.configuringViewport = undefined;
    if (renderer.cdp && renderer.cdp.readyState < WebSocket.CLOSING) renderer.cdp.close();
    const cdp = new WebSocket(target.webSocketDebuggerUrl);
    const cdpPending = new Map();
    renderer.cdp = cdp;
    renderer.cdpSequence = 0;
    renderer.cdpPending = cdpPending;
    renderer.browserSocket = browser.socket;
    renderer.cdpPort = browser.cdpPort;
    renderer.surface = browserSurface(browser, {
      ...activeTab,
      targetId: target.id,
      url: activeTab.url || target.url || '',
      title: activeTab.title || target.title || '',
    }, renderer);
    renderer.lastFrame = undefined;
    renderer.screencastStarted = false;
    renderer.viewport = undefined;
    renderer.pendingViewport = desiredViewport;
    broadcastCursor(renderer, 'default');

    cdp.on('message', (raw) => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      if (message.id) {
        const pending = renderer.cdpPending.get(message.id);
        if (!pending) return;
        renderer.cdpPending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        return;
      }
      if (message.method === 'Page.screencastFrame') {
        cdp.send(JSON.stringify({
          id: ++renderer.cdpSequence,
          method: 'Page.screencastFrameAck',
          params: { sessionId: message.params.sessionId },
        }));
        // Chromium supplies the final compositor frame. The server and
        // browser client retain only the newest pending frame, so slow clients
        // cannot turn motion into an ever-growing delayed queue.
        if (renderer.screencastStarted && rendererHasVisibleClient(renderer)) {
          publishRendererFrame(renderer, message.params.data, renderer.viewport);
        }
      } else if (message.method === 'Page.frameNavigated' && !message.params?.frame?.parentId) {
        // Cross-document navigation can silently end Chrome's screencast and
        // reset page metrics while leaving the CDP target unchanged. Reapply
        // the exact client viewport and restart capture without waiting for a
        // ResizeObserver event from the frontend.
        renderer.forceViewportConfiguration = true;
        renderer.pendingViewport ||= renderer.viewport;
        if (renderer.pendingViewport) void configureRendererViewport(renderer).catch(() => {});
      }
    });
    cdp.once('close', () => {
      for (const pending of cdpPending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('CDP disconnected'));
      }
      cdpPending.clear();
      if (renderer.cdp === cdp) {
        renderer.cdp = undefined;
        renderer.cdpPending = new Map();
      }
    });
    await new Promise((resolve, reject) => {
      cdp.once('open', resolve);
      cdp.once('error', reject);
    });
    await sendCdp(renderer, 'Page.enable');
    await sendCdp(renderer, 'DOM.enable');
    // Tell the frontend that the target changed before any frame can arrive.
    // Sending this after configureRendererViewport lets an idle page's only
    // frame paint first and then get covered by the new-target loading state,
    // leaving the cover stuck until a manual resize produces another frame.
    broadcastSurfaceInfo(renderer);
    await configureRendererViewport(renderer);
    if (!renderer.lastFrame) throw new Error('Browser surface did not produce a first frame');
    renderer.outputChunks = [];
    renderer.outputBytes = 0;
    setRendererState(renderer, 'ready');
    broadcastSurface(renderer);
  }

  async function refreshRendererSurface(renderer, browserState) {
    if (renderer.refreshing || renderer.closing || !renderer.browserSocket) return;
    renderer.refreshing = true;
    try {
      const browser = browserState || await controlTerminalBrowser(renderer.browserSocket, { cmd: 'targets' });
      if (!browser?.tabs?.length) return;
      const activeTab = browser.tabs.find((tab) => tab.active) || browser.tabs[0];
      if (!activeTab?.targetId) return;
      browser.key ||= renderer.browserKey;
      browser.socket ||= renderer.browserSocket;
      if (!renderer.surface || renderer.surface.targetId !== activeTab.targetId || !renderer.cdp) {
        await connectRendererSurface(renderer, browser);
      } else {
        renderer.surface = browserSurface(browser, activeTab, renderer);
        broadcastSurfaceInfo(renderer);
      }
    } catch {
      // The daemon may briefly be unavailable while creating or closing a tab.
    } finally {
      renderer.refreshing = false;
    }
  }

  async function controlRendererTab(renderer, request) {
    if (!renderer.browserSocket) throw new Error('Browser tabs are not ready');
    const browser = await controlTerminalBrowser(renderer.browserSocket, request);
    await refreshRendererSurface(renderer, browser);
  }

  function rendererForSession(session) {
    if (session) {
      const direct = renderers.get(`session:${session}`);
      if (direct?.browserSocket) return direct;
    }
    const owner = [...clientContexts.values()].find((context) =>
      context.mode !== 'graphics' &&
      (!session || context.session === session) &&
      context.rendererKey && renderers.get(context.rendererKey)?.browserSocket,
    );
    return owner ? renderers.get(owner.rendererKey) : undefined;
  }

  function rendererForDevtoolsAccess(access) {
    if (!access || access.length > 128) return undefined;
    return [...renderers.values()].find((renderer) => renderer.devtoolsAccess === access);
  }

  function proxyDevtoolsAsset(request, response, renderer, assetPath, search) {
    if (!renderer.cdpPort) {
      json(response, 409, { error: 'Chrome DevTools is not ready' });
      return;
    }
    const upstream = createHttpRequest({
      hostname: '127.0.0.1',
      port: renderer.cdpPort,
      method: request.method,
      path: `/devtools/${assetPath}${search}`,
      headers: {
        accept: request.headers.accept || '*/*',
        'accept-encoding': assetPath === 'inspector.html' ? 'identity' : request.headers['accept-encoding'] || 'identity',
        'user-agent': request.headers['user-agent'] || 'agent-remote',
      },
    }, (upstreamResponse) => {
      const headers = { ...upstreamResponse.headers };
      delete headers.connection;
      delete headers['x-frame-options'];
      headers['cache-control'] = assetPath === 'inspector.html' ? 'no-cache' : 'public, max-age=86400';
      if (assetPath !== 'inspector.html' || request.method === 'HEAD') {
        response.writeHead(upstreamResponse.statusCode || 502, headers);
        if (request.method === 'HEAD') {
          upstreamResponse.resume();
          response.end();
        } else {
          upstreamResponse.pipe(response);
        }
        return;
      }

      const chunks = [];
      let size = 0;
      let failed = false;
      upstreamResponse.once('error', (error) => {
        failed = true;
        if (!response.headersSent) json(response, 502, { error: `DevTools asset proxy failed: ${error.message}` });
        else response.destroy(error);
      });
      upstreamResponse.on('data', (chunk) => {
        size += chunk.length;
        if (size <= 1024 * 1024) chunks.push(chunk);
        else upstreamResponse.destroy(new Error('DevTools inspector HTML is too large'));
      });
      upstreamResponse.once('end', () => {
        if (failed) return;
        const html = Buffer.concat(chunks).toString('utf8').replace(
          '<body',
          '<script type="module" src="./agent-remote.js"></script>\n<body',
        );
        const body = Buffer.from(html);
        delete headers['content-encoding'];
        delete headers['transfer-encoding'];
        headers['content-length'] = String(body.length);
        response.writeHead(upstreamResponse.statusCode || 502, headers);
        response.end(body);
      });
    });
    upstream.once('error', (error) => {
      if (!response.headersSent) json(response, 502, { error: `DevTools asset proxy failed: ${error.message}` });
      else response.destroy(error);
    });
    request.once('aborted', () => upstream.destroy());
    upstream.end();
  }

  async function discoverRendererSurface(renderer, previousKeys) {
    for (let attempt = 0; attempt < rendererDiscoveryAttempts && !renderer.closing; attempt += 1) {
      const browsers = await listTerminalBrowsers();
      const browser = rendererBrowserCandidate(renderer, browsers, previousKeys);
      if (browser) {
        rememberRendererBrowser(renderer, browser);
        if (renderer.closing) return browser;
        try {
          await connectRendererSurface(renderer, browser);
        } catch (error) {
          throw new Error(`Could not connect to terminal-browser: ${error.message}`);
        }
        renderer.tabPoll = setInterval(() => void refreshRendererSurface(renderer), 1000);
        renderer.tabPoll.unref?.();
        return browser;
      }
      await new Promise((resolve) => setTimeout(resolve, rendererDiscoveryIntervalMs));
    }
    if (!renderer.closing) throw new Error('terminal-browser did not register a browser surface');
    return undefined;
  }

  async function launchRenderer(renderer, argv) {
    const commandName = argv[0].split('/').at(-1);
    const discoversBrowser = commandName === 'terminal-browser';
    renderer.browserLaunchStarted = discoversBrowser;
    const previous = discoversBrowser
      ? new Set((await listTerminalBrowsers()).map((browser) => browser.key))
      : null;
    renderer.previousBrowserKeys = previous || new Set();
    if (renderer.closing) return;
    setRendererState(renderer, discoversBrowser ? 'starting' : 'terminal');
    const command = argv.map(shellQuote).join(' ');
    renderer.terminal.write(`${discoversBrowser ? 'TERMINAL_BROWSER_SKIP_GRAPHICS_CHECK=1 ' : ''}${command}\r`);
    if (previous) await discoverRendererSurface(renderer, previous);
  }

  function rendererEnvironment() {
    const environment = {
      ...process.env,
      PATH: `${agentRemoteBin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
      AGENT_REMOTE_WEB: '1',
      AGENT_REMOTE_URL: `http://127.0.0.1:${server.address().port}`,
      AGENT_REMOTE_SESSION: '',
      AGENT_REMOTE_TOKEN: config.token,
      AGENT_REMOTE_GRAPHICS: '1',
      AGENT_REMOTE_RENDERER: '1',
      TERMINAL_BROWSER_DISPLAY_SCALE: '1',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'agent-remote',
      TERM_PROGRAM_VERSION: '1.0.0',
    };
    delete environment.TMUX;
    delete environment.TMUX_PANE;
    // The renderer PTY never paints terminal-browser's Kitty image stream;
    // agent-remote consumes its registered Chrome/CDP surface instead. Assign
    // this after normalizing inherited terminal metadata so an inherited
    // empty value can never win over the renderer contract.
    environment.TERMINAL_BROWSER_SKIP_GRAPHICS_CHECK = '1';
    return environment;
  }

  function createRenderer(key, cols, rows) {
    // A graphics renderer is an internal command transport, not the user's
    // interactive shell. Starting it through the configured login shell lets
    // zsh/bash profiles race the first launch write (and can consume or delay
    // it), which is why a first terminal-browser open could hang while a retry
    // succeeded. A profile-free POSIX shell gives the renderer a deterministic
    // ready stdin while preserving its PTY for terminal-browser key input.
    const rendererShell = process.platform === 'win32' ? config.shell : '/bin/sh';
    const rendererShellArgs = process.platform === 'win32' ? config.shellArgs : [];
    const terminal = pty.spawn(rendererShell, rendererShellArgs, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: config.cwd,
      env: rendererEnvironment(),
    });
    const renderer = {
      key,
      terminal,
      clients: new Set(),
      outputChunks: [],
      outputBytes: 0,
      closing: false,
      output: undefined,
      exit: undefined,
      terminalClient: undefined,
      state: 'idle',
      stateMessage: undefined,
      browserKey: undefined,
      launchSignature: undefined,
      browserLaunchStarted: false,
      previousBrowserKeys: new Set(),
      agentCleanupStarted: false,
      terminalKilled: false,
      browserSocket: undefined,
      cdp: undefined,
      cdpSequence: 0,
      cdpPending: new Map(),
      cdpPort: undefined,
      surface: undefined,
      lastFrame: undefined,
      frameSequence: 0,
      viewport: undefined,
      viewportGeneration: 0,
      pendingViewport: undefined,
      forceViewportConfiguration: false,
      configuringViewport: false,
      screencastStarted: false,
      cursor: 'default',
      cursorProbePoint: undefined,
      cursorProbeTimer: undefined,
      cursorProbeRunning: false,
      refreshing: false,
      tabPoll: undefined,
      devtoolsAccess: randomBytes(24).toString('base64url'),
    };
    renderers.set(key, renderer);
    if (key.startsWith('session:')) scheduleSessionRendererSweep();

    renderer.output = terminal.onData((data) => {
      if (renderer.surface) return;
      const bytes = Buffer.byteLength(data);
      renderer.outputChunks.push(data);
      renderer.outputBytes += bytes;
      while (renderer.outputBytes > 16 * 1024 * 1024 && renderer.outputChunks.length > 1) {
        renderer.outputBytes -= Buffer.byteLength(renderer.outputChunks.shift());
      }
      if (renderer.terminalClient) sendJson(renderer.terminalClient, { type: 'output', data });
    });
    renderer.exit = terminal.onExit(({ exitCode, signal }) => {
      renderer.terminalKilled = true;
      if (renderers.get(key) === renderer) renderers.delete(key);
      cleanUpRendererBrowserAgent(renderer);
      renderer.output?.dispose();
      renderer.exit?.dispose();
      clearInterval(renderer.tabPoll);
      clearTimeout(renderer.cursorProbeTimer);
      for (const client of renderer.clients) {
        sendJson(client, renderer.surface
          ? { type: 'closed', reason: 'Browser process exited' }
          : { type: 'exit', exitCode, signal });
        client.close(1000, 'Renderer exited');
      }
      renderer.clients.clear();
    });
    return renderer;
  }

  function closeRenderer(key, reason = 'Browser pane closed', immediate = false, expectedRenderer) {
    const renderer = renderers.get(key);
    if (!renderer || renderer.closing || (expectedRenderer && renderer !== expectedRenderer)) return false;
    renderers.delete(key);
    renderer.closing = true;
    cleanUpRendererBrowserAgent(renderer);
    clearInterval(renderer.tabPoll);
    clearTimeout(renderer.cursorProbeTimer);
    if (renderer.cdp && renderer.cdp.readyState < WebSocket.CLOSING) renderer.cdp.close();
    for (const client of renderer.clients) {
      sendJson(client, { type: 'closed', reason });
      client.close(1000, reason);
    }
    renderer.clients.clear();

    if (immediate) killRendererTerminal(renderer);
    else {
      try { renderer.terminal.write('\x03'); } catch {}
      // The terminal-browser client itself uses a two-second close timeout.
      // Racing that same deadline can kill it between daemon unregister and
      // profile/socket cleanup, which makes a later invocation report signal
      // 9. Track the exact PTY-owned browser until its registry entry is gone,
      // then tear down only this renderer. A bounded grace still handles a
      // wedged client by closing its owning connection without touching the
      // shared daemon or any other session.
      trackRendererClose(renderer);
    }
    return true;
  }

  function attachRenderer(socket, key, cols, rows) {
    let renderer = renderers.get(key);
    const restored = Boolean(renderer);
    try {
      renderer ||= createRenderer(key, cols, rows);
      renderer.terminal.resize(cols, rows);
    } catch (error) {
      sendJson(socket, { type: 'error', message: error.message });
      socket.close(1011, 'Renderer failed to start');
      clients.delete(socket);
      clientContexts.delete(socket);
      return;
    }

    renderer.clients.add(socket);
    socket.rendererVisible = true;
    // The newest attachment is the visible owner. This avoids a reload/session
    // switch race where the old socket is still OPEN server-side for a moment.
    renderer.terminalClient = socket;
    sendJson(socket, { type: 'ready', mode: 'graphics', label: 'graphics', renderer: key, restored });
    sendJson(socket, {
      type: 'renderer-state',
      state: renderer.state,
      ...(renderer.stateMessage ? { message: renderer.stateMessage } : {}),
    });
    if (renderer.terminalClient === socket && !renderer.surface) {
      for (const data of renderer.outputChunks) sendJson(socket, { type: 'output', data });
    }
    if (renderer.surface) {
      sendJson(socket, { type: 'surface', ...renderer.surface });
      const frame = rendererFrameMessage(renderer);
      if (frame) sendRendererFrame(socket, frame);
      sendJson(socket, { type: 'cursor', value: renderer.cursor || 'default' });
    }

    socket.on('message', (raw, isBinary) => {
      if (isBinary || raw.length > 1024 * 1024) {
        socket.close(1009, 'Invalid message');
        return;
      }
      let message;
      try { message = JSON.parse(raw.toString()); }
      catch { return sendJson(socket, { type: 'error', message: 'Invalid JSON' }); }

      if (message.type === 'launch' && Array.isArray(message.argv) && message.argv.length > 0 && message.argv.length <= 100 &&
          message.argv.every((argument) => typeof argument === 'string' && argument.length <= 4096)) {
        const signature = JSON.stringify(message.argv);
        // The same split control is intentionally delivered to every active
        // view of a chat (desktop terminal and remote mobile conversation).
        // They attach to one keyed renderer, so only the first launch may
        // write into its PTY; duplicate writes can otherwise corrupt the
        // foreground terminal-browser process and strand the phone on its
        // opening cover.
        if (!renderer.launchSignature) {
          renderer.launchSignature = signature;
          void launchRenderer(renderer, message.argv).catch((error) => {
            if (renderer.launchSignature === signature && !renderer.surface) {
              renderer.launchSignature = undefined;
            }
            const failure = error.message || 'Browser launch failed';
            setRendererState(renderer, 'failed', failure);
            for (const client of renderer.clients) sendJson(client, { type: 'error', message: failure });
          });
        }
      } else if (message.type === 'input' && typeof message.data === 'string') {
        renderer.terminal.write(message.data);
      } else if (message.type === 'visibility' && typeof message.visible === 'boolean') {
        socket.rendererVisible = message.visible;
        if (!message.visible) socket.pendingRendererFrame = undefined;
        if (message.visible) {
          if (renderer.surface) sendJson(socket, { type: 'surface', ...renderer.surface });
          const frame = rendererFrameMessage(renderer);
          if (frame) sendRendererFrame(socket, frame);
          sendJson(socket, { type: 'cursor', value: renderer.cursor || 'default' });
        }
        requestRendererViewport(renderer);
        if (renderer.cdp) void configureRendererViewport(renderer).catch((error) => {
          setRendererState(renderer, 'failed', error.message || 'Browser viewport configuration failed');
        });
      } else if (message.type === 'frame-request') {
        const frame = rendererFrameMessage(renderer);
        if (frame) sendRendererFrame(socket, frame);
        else if (renderer.cdp && renderer.viewport) {
          void sendCdp(renderer, 'Page.captureScreenshot', {
            format: 'jpeg', quality: 90, fromSurface: true,
          }).then((result) => {
            if (result?.data) publishRendererFrame(renderer, result.data, renderer.viewport);
          }).catch((error) => setRendererState(
            renderer, 'failed', error.message || 'Browser frame capture failed',
          ));
        }
      } else if (message.type === 'viewport' &&
          Number.isInteger(message.width) && message.width >= 160 && message.width <= 4096 &&
          Number.isInteger(message.height) && message.height >= 120 && message.height <= 4096) {
        socket.rendererViewport = rendererViewport(message.width, message.height);
        requestRendererViewport(renderer);
      } else if (message.type === 'pointer' && renderer.cdp &&
          ['mousePressed', 'mouseReleased', 'mouseMoved', 'mouseWheel'].includes(message.event) &&
          Number.isFinite(message.x) && Number.isFinite(message.y)) {
        void sendCdp(renderer, 'Input.dispatchMouseEvent', {
          type: message.event,
          x: message.x,
          y: message.y,
          button: message.button || 'none',
          buttons: Number.isInteger(message.buttons) ? message.buttons : 0,
          clickCount: Number.isInteger(message.clickCount) ? message.clickCount : 0,
          deltaX: Number.isFinite(message.deltaX) ? message.deltaX : 0,
          deltaY: Number.isFinite(message.deltaY) ? message.deltaY : 0,
        }).catch(() => {});
        if (message.event === 'mouseMoved') scheduleCursorProbe(renderer, message.x, message.y);
      } else if (message.type === 'pointer-leave') {
        renderer.cursorProbePoint = undefined;
        broadcastCursor(renderer, 'default');
      } else if (message.type === 'key' && renderer.cdp && ['keyDown', 'keyUp', 'rawKeyDown'].includes(message.event)) {
        const key = typeof message.key === 'string' ? message.key.slice(0, 64) : '';
        const code = typeof message.code === 'string' ? message.code.slice(0, 64) : '';
        const modifiers = Number.isInteger(message.modifiers) ? message.modifiers & 15 : 0;
        let text = message.event === 'keyDown' && typeof message.text === 'string'
          ? message.text.slice(0, 64)
          : '';
        if (message.event === 'keyDown' && !(modifiers & 7) && !text) {
          if (key === 'Enter' || code === 'Enter' || code === 'NumpadEnter') text = '\r';
          else if (key === ' ' || key === 'Spacebar' || code === 'Space') text = ' ';
        }
        const unmodifiedText = message.event === 'keyDown' && typeof message.unmodifiedText === 'string'
          ? message.unmodifiedText.slice(0, 64)
          : text;
        const location = Number.isInteger(message.location) && message.location >= 0 && message.location <= 3
          ? message.location
          : 0;
        const windowsVirtualKeyCode = browserVirtualKeyCode(message);
        void sendCdp(renderer, 'Input.dispatchKeyEvent', {
          type: message.event === 'keyDown' && !text ? 'rawKeyDown' : message.event,
          key,
          code,
          text,
          unmodifiedText,
          windowsVirtualKeyCode,
          modifiers,
          autoRepeat: Boolean(message.repeat),
          isKeypad: location === 3,
          isSystemKey: Boolean(modifiers & 1),
          location,
        }).catch(() => {});
      } else if (message.type === 'tab-new') {
        void controlRendererTab(renderer, { cmd: 'open-tab', url: 'about:blank' })
          .catch((error) => sendJson(socket, { type: 'error', message: error.message }));
      } else if ((message.type === 'tab-switch' || message.type === 'tab-close') &&
          Number.isInteger(message.tab) && message.tab > 0 && message.tab <= Number.MAX_SAFE_INTEGER) {
        if (message.type === 'tab-close' && (renderer.surface?.tabs?.length || 0) <= 1) {
          closeRenderer(key, 'Last browser tab closed', false, renderer);
          return;
        }
        const cmd = message.type === 'tab-switch' ? 'activate-tab' : 'close-tab';
        void controlRendererTab(renderer, { cmd, tab: message.tab })
          .catch((error) => sendJson(socket, { type: 'error', message: error.message }));
      } else if (message.type === 'browser-action' && renderer.cdp &&
          ['back', 'forward', 'reload'].includes(message.action)) {
        const action = message.action;
        const command = action === 'reload'
          ? sendCdp(renderer, 'Page.reload', { ignoreCache: false })
          : sendCdp(renderer, 'Runtime.evaluate', { expression: action === 'back' ? 'history.back()' : 'history.forward()' });
        void command.catch(() => {});
      } else if (message.type === 'close') {
        closeRenderer(key, 'Browser pane closed', false, renderer);
      } else if (
        message.type === 'resize' &&
        Number.isInteger(message.cols) && message.cols >= 2 && message.cols <= 500 &&
        Number.isInteger(message.rows) && message.rows >= 1 && message.rows <= 300
      ) {
        renderer.terminal.resize(message.cols, message.rows);
      } else {
        sendJson(socket, { type: 'error', message: 'Unsupported message' });
      }
    });

    const detach = () => {
      clients.delete(socket);
      clientContexts.delete(socket);
      renderer.clients.delete(socket);
      requestRendererViewport(renderer);
      if (renderer.terminalClient === socket) {
        renderer.terminalClient = renderer.clients.values().next().value;
        if (renderer.terminalClient && !renderer.surface) {
          for (const data of renderer.outputChunks) sendJson(renderer.terminalClient, { type: 'output', data });
        }
      }
    };
    socket.once('close', detach);
    socket.once('error', detach);
  }

  async function handleWorkspaceRequest(request, response, surface = 'local') {
    const url = new URL(request.url, 'http://localhost');
    const { pathname } = url;

    if ((request.method === 'GET' || request.method === 'HEAD') && pathname.startsWith('/devtools/')) {
      const parts = pathname.split('/');
      let access;
      try { access = decodeURIComponent(parts[2] || ''); }
      catch { return json(response, 400, { error: 'Invalid DevTools access key' }); }
      const assetPath = parts.slice(3).join('/') || 'inspector.html';
      if (!/^[A-Za-z0-9_./-]+$/.test(assetPath) || assetPath.includes('..')) {
        return json(response, 400, { error: 'Invalid DevTools asset path' });
      }
      const renderer = rendererForDevtoolsAccess(access);
      if (!renderer) return json(response, 404, { error: 'DevTools session not found' });
      if (assetPath === 'agent-remote.js') {
        response.writeHead(200, {
          'content-type': 'text/javascript; charset=utf-8',
          'cache-control': 'no-store',
          'content-length': String(Buffer.byteLength(devtoolsBootstrap)),
          'x-content-type-options': 'nosniff',
        });
        response.end(request.method === 'HEAD' ? undefined : devtoolsBootstrap);
        return;
      }
      proxyDevtoolsAsset(request, response, renderer, assetPath, url.search);
      return;
    }

    if (pathname === '/health') {
      json(response, 200, { ok: true, mode: config.tmuxBacked ? 'tmux' : 'shell' });
      return;
    }

    if (surface === 'local' && pathname === '/api/runtime') {
      json(response, 200, { product: 'agent-remote', version: 1, surface: 'local', desktopMode: config.desktopMode });
      return;
    }

    if (pathname.startsWith('/api/remote/')) {
      if (surface !== 'local') return json(response, 404, { error: 'Not found' });
      if (!originAllowed(request, config)) return json(response, 403, { error: 'Origin is not allowed' });
      if (!authorized(request, config)) return json(response, 401, { error: 'Unauthorized' });
      if (request.method !== 'GET' && request.method !== 'HEAD' && !sameOrigin(request)) {
        return json(response, 403, { error: 'Origin is not allowed' });
      }

      try {
        if (request.method === 'GET' && pathname === '/api/remote/status') {
          return json(response, 200, await remoteController.status());
        }
        if (request.method === 'GET' && pathname === '/api/remote/tunnel-status') {
          return json(response, 200, { tunnel: remoteController.tunnelStatus() });
        }
        if (request.method === 'PUT' && pathname === '/api/remote/cloudflare-token') {
          const body = await readRemoteJson(request);
          return json(response, 200, await remoteController.setCloudflareToken(body.token));
        }
        if (request.method === 'DELETE' && pathname === '/api/remote/cloudflare-token') {
          return json(response, 200, await remoteController.removeCloudflareToken());
        }
        if (request.method === 'GET' && pathname === '/api/remote/zones') {
          return json(response, 200, await remoteController.listZones());
        }
        if (request.method === 'GET' && pathname === '/api/remote/hostname-availability') {
          return json(response, 200, await remoteController.checkHostnameAvailability({
            zoneId: url.searchParams.get('zoneId'),
            subdomain: url.searchParams.get('subdomain'),
          }));
        }
        if (request.method === 'POST' && pathname === '/api/remote/tunnels/quick') {
          return json(response, 201, await remoteController.startQuick());
        }
        if (request.method === 'POST' && pathname === '/api/remote/tunnels/named') {
          return json(response, 201, await remoteController.startNamed(await readRemoteJson(request)));
        }
        if (request.method === 'POST' && pathname === '/api/remote/tunnels/stop') {
          return json(response, 200, await remoteController.stop());
        }
        if (request.method === 'DELETE' && pathname === '/api/remote/tunnels/named') {
          return json(response, 200, await remoteController.removeNamed());
        }
        if (request.method === 'POST' && pathname === '/api/remote/pairing-sessions') {
          return json(response, 201, await remoteController.createPairing());
        }
        if (request.method === 'GET' && pathname === '/api/remote/devices') {
          return json(response, 200, { devices: remoteStore.listDevices().map(safeRemoteDevice) });
        }
        if (request.method === 'DELETE' && pathname === '/api/remote/devices') {
          return json(response, 200, { removed: remoteAuth.revokeAllDevices() });
        }
        const deviceMatch = pathname.match(/^\/api\/remote\/devices\/([^/]+)$/);
        if (request.method === 'DELETE' && deviceMatch) {
          const deviceId = decodeURIComponent(deviceMatch[1]);
          const removed = await remoteAuth.revokeDevice(deviceId);
          return removed
            ? json(response, 200, { removed: true })
            : json(response, 404, { error: 'Remote device not found' });
        }
        return json(response, 404, { error: 'Not found' });
      } catch (error) {
        return remoteApiError(response, error);
      }
    }

    if (pathname.startsWith('/api/')) {
      if (surface === 'local') {
        if (!originAllowed(request, config)) return json(response, 403, { error: 'Origin is not allowed' });
        if (!authorized(request, config)) return json(response, 401, { error: 'Unauthorized' });
      }

      try {
        if (request.method === 'POST' && pathname === '/api/control/split') {
          const body = await readJson(request);
          if (!Array.isArray(body.argv) || body.argv.length === 0 || body.argv.length > 100 ||
              body.argv.some((argument) => typeof argument !== 'string' || argument.length > 4096)) {
            return json(response, 400, { error: 'argv must contain 1-100 strings under 4096 characters' });
          }
          if (body.session !== undefined &&
              (typeof body.session !== 'string' || body.session.length > 64)) {
            return json(response, 400, { error: 'session must be a string under 64 characters' });
          }
          if (body.cwd !== undefined &&
              (typeof body.cwd !== 'string' || body.cwd.length === 0 || body.cwd.length > 4096)) {
            return json(response, 400, { error: 'cwd must be a non-empty string under 4096 characters' });
          }
          const resolved = await resolveControlSession(body);
          if (resolved.error) return json(response, 409, { error: resolved.error });

          const targets = [...clients].filter((client) => {
            const context = clientContexts.get(client);
            return client.readyState === WebSocket.OPEN &&
              context?.mode !== 'graphics' &&
              (!resolved.session || context?.session === resolved.session);
          });
          const streams = [...conversationStreams].filter((stream) =>
            !resolved.session || stream.sessionName === resolved.session);
          if (targets.length === 0 && streams.length === 0) {
            return json(response, 409, { error: 'No browser is connected to that session' });
          }
          const control = { type: 'control', action: 'open-graphics', argv: body.argv };
          for (const client of targets) {
            sendJson(client, control);
          }
          for (const stream of streams) stream.sendControl?.(control);
          return json(response, 202, {
            delivered: targets.length + streams.length,
            session: resolved.session,
          });
        }
        if (request.method === 'POST' && pathname === '/api/control/browser-tab') {
          const body = await readJson(request);
          if (body.action !== 'new-tab') {
            return json(response, 400, { error: 'Unsupported browser tab action' });
          }
          if (body.url !== undefined && (typeof body.url !== 'string' || body.url.length > 4096)) {
            return json(response, 400, { error: 'url must be a string under 4096 characters' });
          }
          if (body.session !== undefined &&
              (typeof body.session !== 'string' || body.session.length > 64)) {
            return json(response, 400, { error: 'session must be a string under 64 characters' });
          }
          if (body.cwd !== undefined &&
              (typeof body.cwd !== 'string' || body.cwd.length === 0 || body.cwd.length > 4096)) {
            return json(response, 400, { error: 'cwd must be a non-empty string under 4096 characters' });
          }
          const resolved = await resolveControlSession(body);
          if (resolved.error) return json(response, 409, { error: resolved.error });

          const renderer = rendererForSession(resolved.session);
          if (!renderer) {
            return json(response, 409, { error: 'No terminal-browser is open for that session' });
          }
          const command = { cmd: 'open-tab' };
          if (body.url?.trim()) {
            command.url = body.url.trim();
            const requested = canonicalBrowserUrl(command.url);
            const existing = renderer.surface?.tabs?.find((tab) => canonicalBrowserUrl(tab.url) === requested);
            if (existing) {
              if (!existing.active) await controlRendererTab(renderer, { cmd: 'activate-tab', tab: existing.id });
              return json(response, 200, { opened: false, reused: true, renderer: renderer.key, tab: existing.id });
            }
          }
          await controlRendererTab(renderer, command);
          return json(response, 200, { opened: true, renderer: renderer.key });
        }
        if (request.method === 'GET' && pathname === '/api/control/browser-target') {
          const session = url.searchParams.get('session') || undefined;
          const cwd = url.searchParams.get('cwd') || undefined;
          if (session && session.length > 64) {
            return json(response, 400, { error: 'session must be under 64 characters' });
          }
          if (cwd && cwd.length > 4096) return json(response, 400, { error: 'cwd must be under 4096 characters' });
          const resolved = await resolveControlSession({ session, cwd });
          if (resolved.error) return json(response, 409, { error: resolved.error });
          const renderer = rendererForSession(resolved.session);
          if (!renderer?.browserKey) {
            return json(response, 409, { error: 'No terminal-browser is open for that session' });
          }
          return json(response, 200, {
            browserKey: renderer.browserKey,
            activeTab: renderer.surface?.tabs?.find((tab) => tab.active)?.id,
          });
        }
        if (request.method === 'GET' && pathname === '/api/control/browser-state') {
          const session = url.searchParams.get('session') || undefined;
          const cwd = url.searchParams.get('cwd') || undefined;
          if (session && session.length > 64) {
            return json(response, 400, { error: 'session must be under 64 characters' });
          }
          if (cwd && cwd.length > 4096) return json(response, 400, { error: 'cwd must be under 4096 characters' });
          const resolved = await resolveControlSession({ session, cwd });
          if (resolved.error) return json(response, 409, { error: resolved.error });
          const renderer = rendererForSession(resolved.session);
          if (!renderer?.browserKey || !renderer.browserSocket) {
            return json(response, 200, { self: null, browsers: [] });
          }
          try {
            const browser = await controlTerminalBrowser(renderer.browserSocket, { cmd: 'targets' });
            browser.key ||= renderer.browserKey;
            return json(response, 200, { self: renderer.browserKey, browsers: [browserListing(browser)] });
          } catch {
            return json(response, 200, { self: null, browsers: [] });
          }
        }
        if (request.method === 'GET' && pathname === '/api/sessions') {
          return json(response, 200, { sessions: await listWorkspaceSessions() });
        }
        if (request.method === 'GET' && pathname === '/api/workspace/stream') {
          openWorkspaceStream(request, response, surface);
          return;
        }
        if (request.method === 'GET' && pathname === '/api/projects') {
          return json(response, 200, { projects: await projectStore.list() });
        }
        if (request.method === 'GET' && pathname === '/api/agents') {
          return json(response, 200, { agents: agentCatalog.list() });
        }
        if (request.method === 'GET' && pathname === '/api/renderers') {
          return json(response, 200, {
            renderers: [...renderers.values()].map((renderer) => ({ key: renderer.key })),
          });
        }
        if (request.method === 'GET' && pathname === '/api/directories') {
          const directory = await browseDirectories(url.searchParams.get('path'), config.allowedCwdRoots);
          return json(response, 200, directory);
        }
        const conversationFileCompletionMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/completions\/files$/);
        if (request.method === 'GET' && conversationFileCompletionMatch) {
          const name = decodeURIComponent(conversationFileCompletionMatch[1]);
          const query = url.searchParams.get('q') || '';
          if (query.length > 160) return json(response, 400, { error: 'q must be under 160 characters' });
          const session = await conversationSession(name);
          if (!session) return json(response, 404, { error: 'Managed session not found' });
          return json(response, 200, { files: await searchProjectFiles(session.cwd, query) });
        }
        const conversationFilePreviewMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/files$/);
        if (request.method === 'GET' && conversationFilePreviewMatch) {
          const name = decodeURIComponent(conversationFilePreviewMatch[1]);
          const path = url.searchParams.get('path') || '';
          const session = await conversationSession(name);
          if (!session) return json(response, 404, { error: 'Managed session not found' });
          try {
            return json(response, 200, { file: await readProjectFile(session.cwd, path) });
          } catch (error) {
            if (error?.code === 'FILE_MENTION_INVALID') {
              return json(response, 400, { error: 'File path must stay inside the project' });
            }
            if (error?.code === 'ENOENT') return json(response, 404, { error: 'File not found' });
            if (error?.code === 'FILE_PREVIEW_TOO_LARGE') return json(response, 413, { error: error.message });
            if (error?.code === 'FILE_PREVIEW_BINARY') return json(response, 415, { error: error.message });
            throw error;
          }
        }
        const conversationModelMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/model$/);
        if (request.method === 'POST' && conversationModelMatch) {
          const name = decodeURIComponent(conversationModelMatch[1]);
          const body = await readJson(request);
          if (typeof body.modelId !== 'string' ||
              !/^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,79}$/.test(body.modelId)) {
            return json(response, 400, { error: 'modelId must be a valid model identifier under 80 characters' });
          }
          if (body.effortId !== undefined && (typeof body.effortId !== 'string' ||
              !/^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,79}$/.test(body.effortId))) {
            return json(response, 400, { error: 'effortId must be a valid effort identifier under 80 characters' });
          }
          const session = await conversationSession(name);
          if (!session) return json(response, 404, { error: 'Managed session not found' });
          try {
            const result = await conversationRegistry.setModel(session, body.modelId, body.effortId);
            return json(response, 202, {
              accepted: true,
              modelId: result?.modelId || body.modelId,
              ...((result?.effortId || body.effortId) ? { effortId: result?.effortId || body.effortId } : {}),
              ...(result?.pending === true ? { pending: true } : {}),
            });
          } catch (error) {
            if (error?.code === 'GROK_ACP_MODEL_INVALID') {
              return json(response, 400, { error: error.message, code: error.code });
            }
            return conversationFailure(response, error);
          }
        }
        const conversationModeMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/mode$/);
        if (request.method === 'POST' && conversationModeMatch) {
          const name = decodeURIComponent(conversationModeMatch[1]);
          const body = await readJson(request);
          if (!['normal', 'plan', 'auto', 'alwaysApprove'].includes(body.modeId)) {
            return json(response, 400, { error: 'modeId must be normal, plan, auto, or alwaysApprove' });
          }
          const session = await conversationSession(name);
          if (!session) return json(response, 404, { error: 'Managed session not found' });
          try {
            const result = await conversationRegistry.setMode(session, body.modeId);
            return json(response, 202, result);
          } catch (error) {
            if (error?.code === 'GROK_ACP_MODE_INVALID') return json(response, 400, { error: error.message, code: error.code });
            if (error?.code === 'GROK_ACP_SESSION_BUSY') return json(response, 409, { error: error.message, code: error.code });
            return conversationFailure(response, error);
          }
        }
        const conversationGoalMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/goal$/);
        if (request.method === 'POST' && conversationGoalMatch) {
          const name = decodeURIComponent(conversationGoalMatch[1]);
          const body = await readJson(request);
          if (!['pause', 'resume', 'clear'].includes(body.action)) {
            return json(response, 400, { error: 'action must be pause, resume, or clear' });
          }
          const session = await conversationSession(name);
          if (!session) return json(response, 404, { error: 'Managed session not found' });
          try {
            return json(response, 202, {
              accepted: true,
              action: body.action,
              ...(await conversationRegistry.controlGoal(session, body.action)),
            });
          } catch (error) {
            return conversationFailure(response, error);
          }
        }
        const conversationQuestionMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/question$/);
        if (request.method === 'POST' && conversationQuestionMatch) {
          const name = decodeURIComponent(conversationQuestionMatch[1]);
          const body = await readJson(request);
          if (typeof body.threadId !== 'string' || !body.threadId || body.threadId.length > 160 ||
              typeof body.questionId !== 'string' || !body.questionId || body.questionId.length > 160 ||
              (body.outcome !== undefined && !['accepted', 'skip_interview'].includes(body.outcome))) {
            return json(response, 400, {
              error: 'threadId and questionId must be non-empty strings; outcome must be accepted or skip_interview',
            });
          }
          const accepted = body.outcome === undefined || body.outcome === 'accepted';
          if (accepted && (!body.answers || typeof body.answers !== 'object' || Array.isArray(body.answers) ||
              Object.keys(body.answers).length === 0 || Object.keys(body.answers).length > 20 ||
              Object.entries(body.answers).some(([prompt, answer]) =>
                !prompt || prompt.length > 4_000 || typeof answer !== 'string' || !answer || answer.length > 4_000))) {
            return json(response, 400, { error: 'accepted questions require bounded string answers' });
          }
          if (!accepted && body.answers !== undefined &&
              (!body.answers || typeof body.answers !== 'object' || Array.isArray(body.answers) ||
                Object.keys(body.answers).length > 20 || Object.entries(body.answers).some(([prompt, answer]) =>
                  !prompt || prompt.length > 4_000 || typeof answer !== 'string' || answer.length > 4_000))) {
            return json(response, 400, { error: 'answers must be a bounded string map' });
          }
          const session = await conversationSession(name);
          if (!session) return json(response, 404, { error: 'Managed session not found' });
          try {
            await conversationRegistry.respondQuestion(session, {
              threadId: body.threadId, questionId: body.questionId, answers: body.answers,
              ...(body.outcome === undefined ? {} : { outcome: body.outcome }),
            });
          } catch (error) {
            if (error?.code === 'GROK_ACP_QUESTION_EXPIRED') {
              return json(response, 409, { error: error.message, code: error.code });
            }
            return conversationFailure(response, error);
          }
          return json(response, 202, { accepted: true });
        }
        const conversationPermissionMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/permission$/);
        const conversationPlanReviewMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/plan-review$/);
        if (request.method === 'POST' && conversationPlanReviewMatch) {
          const name = decodeURIComponent(conversationPlanReviewMatch[1]);
          const body = await readJson(request);
          if (typeof body.threadId !== 'string' || !body.threadId || body.threadId.length > 160 ||
              typeof body.reviewId !== 'string' || !body.reviewId || body.reviewId.length > 160 ||
              !['approved', 'cancelled', 'abandoned'].includes(body.outcome) ||
              (body.feedback !== undefined && (typeof body.feedback !== 'string' || body.feedback.length > 32 * 1024)) ||
              (body.outcome === 'abandoned' && body.feedback?.trim())) {
            return json(response, 400, {
              error: 'threadId/reviewId, a valid outcome, and optional bounded feedback are required',
            });
          }
          const session = await conversationSession(name);
          if (!session) return json(response, 404, { error: 'Managed session not found' });
          try {
            await conversationRegistry.respondPlanReview(session, {
              threadId: body.threadId, reviewId: body.reviewId, outcome: body.outcome,
              ...(body.feedback === undefined ? {} : { feedback: body.feedback }),
            });
          } catch (error) {
            if (error?.code === 'GROK_ACP_PLAN_EXPIRED') {
              return json(response, 409, { error: error.message, code: error.code });
            }
            return conversationFailure(response, error);
          }
          return json(response, 202, { accepted: true, outcome: body.outcome });
        }
        if (request.method === 'POST' && conversationPermissionMatch) {
          const name = decodeURIComponent(conversationPermissionMatch[1]);
          const body = await readJson(request);
          if (typeof body.permissionId !== 'string' || !body.permissionId || body.permissionId.length > 160 ||
              typeof body.optionId !== 'string' || !body.optionId || body.optionId.length > 160) {
            return json(response, 400, { error: 'permissionId and optionId must be non-empty strings' });
          }
          const session = await conversationSession(name);
          if (!session) return json(response, 404, { error: 'Managed session not found' });
          try {
            await conversationRegistry.respondPermission(session, body);
          } catch (error) {
            if (error?.code === 'GROK_ACP_PERMISSION_EXPIRED') {
              return json(response, 409, { error: error.message, code: error.code });
            }
            return conversationFailure(response, error);
          }
          return json(response, 202, { accepted: true });
        }
        const conversationCancelMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/cancel$/);
        if (request.method === 'POST' && conversationCancelMatch) {
          const name = decodeURIComponent(conversationCancelMatch[1]);
          await readJson(request);
          const session = await conversationSession(name);
          if (!session) return json(response, 404, { error: 'Managed session not found' });
          try {
            return json(response, 202, await conversationRegistry.cancel(session));
          } catch (error) {
            return conversationFailure(response, error);
          }
        }
        const conversationInputMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/input$/);
        if (request.method === 'POST' && conversationInputMatch) {
          const name = decodeURIComponent(conversationInputMatch[1]);
          const body = await readJson(request);
          if (typeof body.text !== 'string' || Buffer.byteLength(body.text, 'utf8') > 64 * 1024) {
            return json(response, 400, { error: 'text must be a string under 64 KiB' });
          }
          if (body.id !== undefined && (typeof body.id !== 'string' || body.id.length > 80)) {
            return json(response, 400, { error: 'id must be a string under 80 characters' });
          }
          const session = await conversationSession(name);
          if (!session) return json(response, 404, { error: 'Managed session not found' });
          if (body.attachmentIds !== undefined && (!Array.isArray(body.attachmentIds) ||
              body.attachmentIds.length > 8 || body.attachmentIds.some((id) =>
                typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)))) {
            return json(response, 400, { error: 'attachmentIds must contain at most 8 attachment ids' });
          }
          const attachmentIds = body.attachmentIds || [];
          const attachments = conversationAttachments.resolve(session.name, attachmentIds);
          if (attachments.length !== attachmentIds.length) {
            return json(response, 404, { error: 'Attachment not found for this session' });
          }
          if (!body.text.trim() && attachments.length === 0) {
            return json(response, 400, { error: 'Message or attachment is required' });
          }
          if (body.fileMentions !== undefined && (!Array.isArray(body.fileMentions) ||
              body.fileMentions.length > 16 || body.fileMentions.some((path) =>
                typeof path !== 'string' || !path || path.length > 1024))) {
            return json(response, 400, { error: 'fileMentions must contain at most 16 project-relative paths' });
          }
          let mentionedFiles;
          try { mentionedFiles = await resolveProjectFiles(session.cwd, body.fileMentions || []); }
          catch (error) {
            if (error?.code === 'FILE_MENTION_INVALID' || error?.code === 'ENOENT') {
              return json(response, 400, { error: 'A mentioned file is outside the project or no longer exists' });
            }
            throw error;
          }
          const attachmentText = attachments.map((attachment) =>
            `${attachment.mimeType.startsWith('image/') ? '!' : ''}[${attachment.name}](${attachment.path})`).join('\n');
          const mentionedText = mentionedFiles.map((file) => `[${file.path}](${file.absolutePath})`).join('\n');
          const promptText = [body.text.trim(), attachmentText, mentionedText].filter(Boolean).join('\n\n');
          const displayText = body.text.trim() || attachments.map((attachment) => attachment.name).join(', ');
          const attachmentView = attachments.map((attachment) => ({
            id: attachment.id, name: attachment.name, mimeType: attachment.mimeType, size: attachment.size,
            previewUrl: `/api/conversations/${encodeURIComponent(session.name)}/attachments/${attachment.id}`,
          }));
          const requestKey = body.id ? `${session.name}:${body.id}` : undefined;
          const existing = requestKey ? conversationInputRequests.get(requestKey) : undefined;
          const requestSignature = JSON.stringify({ text: body.text, attachmentIds, fileMentions: body.fileMentions || [] });
          if (existing && existing.signature !== requestSignature) {
            return json(response, 409, { error: 'Input id was already used for different text' });
          }
          let delivery = existing?.delivery;
          if (!delivery) {
            delivery = deliverConversationInput(session, promptText, {
              id: body.id, displayText, attachments: attachmentView,
            });
            if (requestKey) {
              conversationInputRequests.set(requestKey, { signature: requestSignature, delivery });
              const forget = setTimeout(() => conversationInputRequests.delete(requestKey), 60_000);
              forget.unref?.();
              delivery.catch(() => {
                clearTimeout(forget);
                if (conversationInputRequests.get(requestKey)?.delivery === delivery) {
                  conversationInputRequests.delete(requestKey);
                }
              });
            }
          }
          let result;
          try { result = await delivery; }
          catch (error) { return conversationFailure(response, error); }
          return json(response, 202, { accepted: true, id: body.id, ...result });
        }
        const conversationAttachmentMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/attachments$/);
        if (request.method === 'POST' && conversationAttachmentMatch) {
          const name = decodeURIComponent(conversationAttachmentMatch[1]);
          const session = await conversationSession(name);
          if (!session) return json(response, 404, { error: 'Managed session not found' });
          const encodedName = request.headers['x-file-name'];
          if (typeof encodedName !== 'string' || encodedName.length > 720) {
            return json(response, 400, { error: 'x-file-name header is required' });
          }
          let fileName;
          try { fileName = decodeURIComponent(encodedName); }
          catch { return json(response, 400, { error: 'x-file-name must be URI encoded' }); }
          const uploadId = request.headers['x-upload-id'];
          if (uploadId !== undefined) {
            const offsetValue = request.headers['x-upload-offset'];
            const totalValue = request.headers['x-upload-total'];
            if (typeof uploadId !== 'string' || typeof offsetValue !== 'string' ||
                typeof totalValue !== 'string' || !/^\d+$/.test(offsetValue) || !/^\d+$/.test(totalValue)) {
              return json(response, 400, { error: 'Chunk upload headers are invalid', code: 'ATTACHMENT_UPLOAD_INVALID' });
            }
            const offset = Number(offsetValue);
            const totalBytes = Number(totalValue);
            if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(totalBytes)) {
              return json(response, 400, { error: 'Chunk upload sizes are invalid', code: 'ATTACHMENT_UPLOAD_INVALID' });
            }
            try {
              const data = await readBytes(request, maxAttachmentChunkBytes);
              const result = await conversationAttachments.appendUploadChunk(session.name, {
                uploadId, name: fileName, mimeType: request.headers['content-type'],
                offset, totalBytes, data,
              });
              if (!result.complete) return json(response, 202, { nextOffset: result.nextOffset });
              const attachment = result.attachment;
              return json(response, 201, { nextOffset: result.nextOffset, attachment: {
                id: attachment.id, name: attachment.name, mimeType: attachment.mimeType, size: attachment.size,
                previewUrl: `/api/conversations/${encodeURIComponent(session.name)}/attachments/${attachment.id}`,
              } });
            } catch (error) {
              const status = error?.status || (error?.code === 'ATTACHMENT_UPLOAD_OFFSET' ||
                error?.code === 'ATTACHMENT_UPLOAD_MISMATCH' ? 409 : 400);
              return json(response, status, {
                error: error.message, ...(error?.code ? { code: error.code } : {}),
                ...(Number.isSafeInteger(error?.nextOffset) ? { nextOffset: error.nextOffset } : {}),
              });
            }
          }
          try {
            const data = await readBytes(request);
            const attachment = await conversationAttachments.save(session.name, {
              name: fileName, mimeType: request.headers['content-type'], data,
            });
            return json(response, 201, { attachment: {
              id: attachment.id, name: attachment.name, mimeType: attachment.mimeType, size: attachment.size,
              previewUrl: `/api/conversations/${encodeURIComponent(session.name)}/attachments/${attachment.id}`,
            } });
          } catch (error) {
            return json(response, error?.status || 400, {
              error: error.message, ...(error?.code ? { code: error.code } : {}),
            });
          }
        }
        const conversationAttachmentAbortMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/attachments\/([0-9a-f-]{36})\/upload$/i);
        if (request.method === 'DELETE' && conversationAttachmentAbortMatch) {
          const name = decodeURIComponent(conversationAttachmentAbortMatch[1]);
          const session = await conversationSession(name);
          if (!session) return json(response, 404, { error: 'Managed session not found' });
          const aborted = await conversationAttachments.abortUpload(session.name, conversationAttachmentAbortMatch[2]);
          return json(response, aborted ? 200 : 404, { aborted });
        }
        const conversationAttachmentViewMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/attachments\/([0-9a-f-]{36})$/i);
        if (request.method === 'GET' && conversationAttachmentViewMatch) {
          const name = decodeURIComponent(conversationAttachmentViewMatch[1]);
          const attachment = conversationAttachments.get(name, conversationAttachmentViewMatch[2]);
          if (!attachment) return json(response, 404, { error: 'Attachment not found' });
          response.writeHead(200, {
            'content-type': attachment.mimeType,
            'content-length': attachment.size,
            'cache-control': 'private, no-store',
            'x-content-type-options': 'nosniff',
            'content-security-policy': "default-src 'none'; sandbox",
            'content-disposition': `${/^image\/(?:png|jpeg|webp|gif)$/.test(attachment.mimeType) ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(attachment.name)}`,
          });
          createReadStream(attachment.path).pipe(response);
          return;
        }
        const conversationQueueReorderMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/queue\/reorder$/);
        if (request.method === 'POST' && conversationQueueReorderMatch) {
          const name = decodeURIComponent(conversationQueueReorderMatch[1]);
          const body = await readJson(request);
          if (!Array.isArray(body.queueIds) || body.queueIds.length > 100 ||
              body.queueIds.some((id) => typeof id !== 'string' || !id || id.length > 80)) {
            return json(response, 400, { error: 'queueIds must contain at most 100 queue ids' });
          }
          const session = await conversationSession(name);
          if (!session) return json(response, 404, { error: 'Managed session not found' });
          try {
            const result = await conversationRegistry.reorderQueuedInputs(session, body.queueIds);
            return json(response, 202, result);
          } catch (error) {
            if (error?.code === 'GROK_ACP_QUEUE_INVALID') {
              return json(response, 409, { error: error.message, code: error.code });
            }
            return conversationFailure(response, error);
          }
        }
        const conversationQueueMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/queue\/([^/]+)(?:\/(steer))?$/);
        if (conversationQueueMatch && (request.method === 'DELETE' ||
            (request.method === 'POST' && conversationQueueMatch[3] === 'steer'))) {
          const name = decodeURIComponent(conversationQueueMatch[1]);
          const queueId = decodeURIComponent(conversationQueueMatch[2]);
          if (!queueId || queueId.length > 80) return json(response, 400, { error: 'queue id is invalid' });
          const session = await conversationSession(name);
          if (!session) return json(response, 404, { error: 'Managed session not found' });
          try {
            const result = conversationQueueMatch[3] === 'steer'
              ? await conversationRegistry.steerQueuedInput(session, queueId)
              : await conversationRegistry.removeQueuedInput(session, queueId);
            return json(response, 202, result);
          } catch (error) {
            if (error?.code === 'GROK_ACP_QUEUE_EXPIRED') return json(response, 409, { error: error.message, code: error.code });
            if (error?.code === 'GROK_ACP_SESSION_IDLE') return json(response, 409, { error: error.message, code: error.code });
            return conversationFailure(response, error);
          }
        }
        const conversationStreamMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/stream$/);
        if (request.method === 'GET' && conversationStreamMatch) {
          const name = decodeURIComponent(conversationStreamMatch[1]);
          const session = await conversationSession(name);
          if (!session) return json(response, 404, { error: 'Managed session not found' });
          const threadId = url.searchParams.get('thread') || undefined;
          const historyLimitValue = url.searchParams.get('historyLimit');
          const requestedHistoryLimit = Number(historyLimitValue);
          const historyLimit = historyLimitValue !== null && Number.isInteger(requestedHistoryLimit)
            ? Math.max(20, Math.min(5_000, requestedHistoryLimit)) : undefined;
          const conversationOptions = { threadId, ...(historyLimit ? { historyLimit } : {}) };
          let initial;
          try { initial = await conversationRegistry.read(session, conversationOptions); }
          catch (error) { return conversationFailure(response, error); }
          if (!initial) return json(response, 404, {
            error: 'No mobile conversation provider is available for this session',
            code: 'CONVERSATION_UNAVAILABLE',
          });
          response.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache, no-store, no-transform',
            connection: 'keep-alive',
            'x-accel-buffering': 'no',
            'x-content-type-options': 'nosniff',
          });
          response.flushHeaders?.();
          response.socket?.setNoDelay?.(true);
          // Prime Safari and intermediary HTTP stacks with enough body bytes
          // to enter streaming mode immediately instead of buffering the first
          // model chunks. The comment is ignored by EventSource consumers.
          response.write(`:${' '.repeat(2_048)}\nretry: 1000\n\n`);
          let stopWatching = async () => {};
          let untrackRemoteStream = () => {};
          let closed = false;
          let streamedMessageId;
          const close = async () => {
            if (closed) return;
            closed = true;
            clearInterval(heartbeat);
            conversationStreams.delete(close);
            untrackRemoteStream();
            await stopWatching();
            if (!response.writableEnded) response.end();
          };
          close.sessionName = name;
          close.sendControl = (control) => {
            if (!closed && !response.writableEnded) {
              response.write(`event: control\ndata: ${JSON.stringify(control)}\n\n`);
            }
          };
          const heartbeat = setInterval(() => {
            if (!response.writableEnded) {
              response.write(`event: heartbeat\ndata: ${Date.now()}\n\n`);
              response.flush?.();
            }
          }, 3_000);
          heartbeat.unref?.();
          conversationStreams.add(close);
          if (surface === 'remote') untrackRemoteStream = remoteGateway.trackStream(close, request);
          response.once('close', () => void close());
          try {
            stopWatching = await conversationRegistry.watch(session, conversationOptions, (event) => {
              if (!closed && !response.writableEnded) {
                let outgoing = event;
                if (event.stream?.kind === 'agent_message_chunk') {
                  const message = [...(event.conversation?.items || [])].reverse().find(
                    (item) => item.type === 'message' && item.role === 'assistant',
                  );
                  const stream = {
                    ...event.stream,
                    threadId: event.conversation?.thread?.id,
                    messageId: message?.id,
                  };
                  outgoing = message?.id && streamedMessageId === message.id
                    ? { stream }
                    : { ...event, stream };
                  streamedMessageId = message?.id;
                } else {
                  streamedMessageId = undefined;
                }
                response.write(`event: conversation\ndata: ${JSON.stringify(outgoing)}\n\n`);
                response.flush?.();
              }
            });
            if (closed) await stopWatching();
          } catch (error) {
            if (!closed) response.write(`event: error\ndata: ${JSON.stringify({ error: error.message })}\n\n`);
            await close();
          }
          return;
        }
        const conversationMatch = pathname.match(/^\/api\/conversations\/([^/]+)$/);
        if (request.method === 'GET' && conversationMatch) {
          const name = decodeURIComponent(conversationMatch[1]);
          const session = await conversationSession(name);
          if (!session) return json(response, 404, { error: 'Managed session not found' });
          const threadId = url.searchParams.get('thread') || undefined;
          const historyLimitValue = url.searchParams.get('historyLimit');
          const requestedHistoryLimit = Number(historyLimitValue);
          const historyLimit = historyLimitValue !== null && Number.isInteger(requestedHistoryLimit)
            ? Math.max(20, Math.min(5_000, requestedHistoryLimit)) : undefined;
          const conversationOptions = { threadId, ...(historyLimit ? { historyLimit } : {}) };
          let conversation;
          try { conversation = await conversationRegistry.read(session, conversationOptions); }
          catch (error) { return conversationFailure(response, error); }
          return conversation
            ? json(response, 200, { conversation })
            : json(response, 404, {
                error: 'No mobile conversation provider is available for this session',
                code: 'CONVERSATION_UNAVAILABLE',
              });
        }
        if (request.method === 'POST' && pathname === '/api/sessions') {
          const body = await readJson(request);
          if (typeof body.commandLine !== 'string' || body.commandLine.trim().length > 4096) {
            return json(response, 400, { error: 'commandLine must be a non-empty string under 4096 characters' });
          }
          if (body.name !== undefined && (typeof body.name !== 'string' || body.name.length > 64)) {
            return json(response, 400, { error: 'name must be a string under 64 characters' });
          }
          const selected = await resolveAllowedDirectory(body.cwd, config.allowedCwdRoots);
          const session = await startManagedSession({
            tmuxCommand: config.tmuxCommand,
            rawCommand: body.commandLine,
            requestedName: body.name?.trim() || undefined,
            cwd: selected.path,
            agentRemoteUrl: `http://127.0.0.1:${server.address().port}`,
            agentRemoteToken: config.token,
            grokLeaderSocket: config.grokLeaderSocket,
          });
          publishWorkspaceChange({ type: 'session-created' });
          return json(response, 201, { session });
        }
        if (request.method === 'POST' && pathname === '/api/projects') {
          const body = await readJson(request);
          if (typeof body.agentId !== 'string' || !agentCatalog.get(body.agentId)) {
            return json(response, 400, { error: 'agentId must identify an available agent' });
          }
          if (body.name !== undefined && (typeof body.name !== 'string' || body.name.length > 80 || /[\x00-\x1f\x7f]/.test(body.name))) {
            return json(response, 400, { error: 'name must be a string under 80 characters' });
          }
          const selected = await resolveAllowedDirectory(body.cwd, config.allowedCwdRoots);
          const name = body.name?.trim() || basename(selected.path) || 'Project';
          const project = await projectStore.create({
            name,
            cwd: selected.path,
            agentId: body.agentId,
          });
          publishWorkspaceChange({ type: 'project-created' });
          return json(response, 201, { project });
        }
        const projectSessionsMatch = pathname.match(/^\/api\/projects\/([^/]+)\/sessions$/);
        if (projectSessionsMatch) {
          const projectId = decodeURIComponent(projectSessionsMatch[1]);
          const project = await projectStore.get(projectId);
          if (!project) return json(response, 404, { error: 'Project not found' });
          if (request.method === 'POST') {
            const agent = agentCatalog.get(project.agentId);
            if (!agent) return json(response, 409, { error: 'The project agent is no longer available' });
            const session = await startManagedSession({
              tmuxCommand: config.tmuxCommand,
              rawCommand: agent.command,
              requestedName: 'New chat',
              cwd: project.cwd,
              agentRemoteUrl: `http://127.0.0.1:${server.address().port}`,
              agentRemoteToken: config.token,
              grokLeaderSocket: config.grokLeaderSocket,
              projectId: project.id,
              autoTitle: true,
            });
            try {
              projectStore.saveChat({
                name: session.name,
                projectId: project.id,
                title: session.label,
                autoTitle: true,
              });
            } catch (error) {
              await stopManagedSession(config.tmuxCommand, session.name).catch(() => {});
              throw error;
            }
            publishWorkspaceChange({ type: 'session-created' });
            return json(response, 201, { session });
          }
          if (request.method === 'DELETE') {
            return json(response, 200, { cleared: await stopProjectSessions(project.id) });
          }
        }
        const projectMatch = pathname.match(/^\/api\/projects\/([^/]+)$/);
        if (projectMatch) {
          const projectId = decodeURIComponent(projectMatch[1]);
          const current = await projectStore.get(projectId);
          if (!current) return json(response, 404, { error: 'Project not found' });
          if (request.method === 'PATCH') {
            const body = await readJson(request);
            const changes = {};
            if (body.name !== undefined) {
              if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 80 || /[\x00-\x1f\x7f]/.test(body.name)) {
                return json(response, 400, { error: 'name must be a non-empty string under 80 characters' });
              }
              changes.name = body.name.trim();
            }
            if (body.agentId !== undefined) {
              if (typeof body.agentId !== 'string' || !agentCatalog.get(body.agentId)) {
                return json(response, 400, { error: 'agentId must identify an available agent' });
              }
              changes.agentId = body.agentId;
            }
            if (body.cwd !== undefined) {
              changes.cwd = (await resolveAllowedDirectory(body.cwd, config.allowedCwdRoots)).path;
            }
            const project = await projectStore.update(projectId, changes);
            publishWorkspaceChange({ type: 'project-updated' });
            return json(response, 200, { project });
          }
          if (request.method === 'DELETE') {
            const cleared = await stopProjectSessions(projectId);
            await projectStore.remove(projectId);
            publishWorkspaceChange({ type: 'project-deleted' });
            return json(response, 200, { deleted: true, cleared });
          }
        }
        const renameSessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
        const activitySessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/activity$/);
        if (request.method === 'POST' && activitySessionMatch) {
          const name = decodeURIComponent(activitySessionMatch[1]);
          const lastActiveAt = Date.now();
          return projectStore.touchChat(name, lastActiveAt)
            ? json(response, 200, { lastActiveAt })
            : json(response, 404, { error: 'Project chat not found' });
        }
        if (request.method === 'PATCH' && renameSessionMatch) {
          const name = decodeURIComponent(renameSessionMatch[1]);
          const body = await readJson(request);
          if (typeof body.label !== 'string' || !body.label.trim() || body.label.length > 200) {
            return json(response, 400, { error: 'label must be a non-empty string' });
          }
          const label = await renameManagedSession(config.tmuxCommand, name, body.label);
          if (label) projectStore.renameChat(name, label);
          if (label) publishWorkspaceChange({ type: 'session-updated' });
          return label
            ? json(response, 200, { label })
            : json(response, 404, { error: 'Managed session not found' });
        }
        if (request.method === 'DELETE' && pathname.startsWith('/api/sessions/')) {
          const name = decodeURIComponent(pathname.slice('/api/sessions/'.length));
          const stopped = await stopManagedSession(config.tmuxCommand, name);
          // Renderer ownership is exact by session key, so cleanup remains
          // safe even if tmux disappeared between discovery and this request.
          // This closes stale PTYs/workers without affecting another chat.
          closeRenderer(`session:${name}`);
          if (stopped) {
            projectStore.removeChat(name);
            await Promise.all([...conversationStreams]
              .filter((stream) => stream.sessionName === name)
              .map((stream) => stream(true)));
            publishWorkspaceChange({ type: 'sessions-deleted', deleted: [name] });
          }
          return stopped
            ? json(response, 200, { stopped: true })
            : json(response, 404, { error: 'Managed session not found' });
        }
        return json(response, 404, { error: 'Not found' });
      } catch (error) {
        return json(response, 400, { error: error.message });
      }
    }

    if (surface === 'remote' && pathname === '/remote-control.js') {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      response.end('Not found');
      return;
    }

    const file = staticRoutes.get(pathname);
    if (!file || !existsSync(file)) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }

    const staticHeaders = {
      'content-type': contentTypes[extname(file)] ?? 'application/octet-stream',
      // First-party assets change together and iOS standalone web apps are
      // particularly sticky about reusing an old CSS/manifest response. Never
      // let a PWA or a Cloudflare hop retain a mixed-version application shell.
      'cache-control': pathname.startsWith('/vendor/') ? 'public, max-age=86400' : 'no-store',
      'x-content-type-options': 'nosniff',
      ...(surface === 'remote' && pathname === '/' ? remoteWorkspaceDocumentHeaders : {}),
    };
    if (surface === 'remote' && pathname === '/') {
      let document;
      try { document = stripLocalControlBlocks(readFileSync(file, 'utf8')); }
      catch { document = undefined; }
      if (document === undefined) {
        response.writeHead(500, {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        });
        response.end('Remote workspace is unavailable');
        return;
      }
      response.writeHead(200, { ...staticHeaders, 'content-length': String(Buffer.byteLength(document)) });
      response.end(request.method === 'HEAD' ? undefined : document);
      return;
    }
    response.writeHead(200, staticHeaders);
    createReadStream(file).pipe(response);
  }

  const server = createHttpServer((request, response) => handleWorkspaceRequest(request, response, 'local'));
  const remoteServer = createHttpServer((request, response) =>
    remoteGateway.handleRequest(request, response, handleWorkspaceRequest));

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const conversationWss = new WebSocketServer({
    noServer: true,
    maxPayload: 64 * 1024,
    perMessageDeflate: false,
  });
  const devtoolsWss = new WebSocketServer({
    noServer: true,
    maxPayload: 64 * 1024 * 1024,
    perMessageDeflate: false,
  });
  const devtoolsClients = new Set();

  function bridgeDevtoolsSocket(downstream, renderer, targetId, request) {
    const upstream = new WebSocket(
      `ws://127.0.0.1:${renderer.cdpPort}/devtools/page/${encodeURIComponent(targetId)}`,
      { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 },
    );
    const pending = [];
    devtoolsClients.add(downstream);
    if (request?.remoteDeviceId) {
      let sockets = remoteDeviceSockets.get(request.remoteDeviceId);
      if (!sockets) {
        sockets = new Set();
        remoteDeviceSockets.set(request.remoteDeviceId, sockets);
      }
      sockets.add(downstream);
      const removeRemoteSocket = () => {
        sockets.delete(downstream);
        if (sockets.size === 0) remoteDeviceSockets.delete(request.remoteDeviceId);
      };
      downstream.once('close', removeRemoteSocket);
      downstream.once('error', removeRemoteSocket);
      remoteGateway.trackSocket(downstream, request);
    }

    downstream.on('message', (data, isBinary) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
      else if (upstream.readyState === WebSocket.CONNECTING) pending.push([data, isBinary]);
    });
    upstream.once('open', () => {
      for (const [data, isBinary] of pending.splice(0)) upstream.send(data, { binary: isBinary });
    });
    upstream.on('message', (data, isBinary) => {
      if (downstream.readyState === WebSocket.OPEN) downstream.send(data, { binary: isBinary });
    });
    upstream.once('error', () => {
      if (downstream.readyState < WebSocket.CLOSING) downstream.close(1011, 'Chrome DevTools connection failed');
    });
    upstream.once('close', (code, reason) => {
      if (downstream.readyState < WebSocket.CLOSING) {
        const safeCode = code >= 1000 && code <= 4999 && code !== 1005 && code !== 1006 ? code : 1001;
        downstream.close(safeCode, reason);
      }
    });
    downstream.once('close', (code, reason) => {
      devtoolsClients.delete(downstream);
      if (upstream.readyState < WebSocket.CLOSING) {
        const safeCode = code >= 1000 && code <= 4999 && code !== 1005 && code !== 1006 ? code : 1001;
        upstream.close(safeCode, reason);
      }
    });
    downstream.once('error', () => {
      if (upstream.readyState < WebSocket.CLOSING) upstream.close(1011, 'DevTools client disconnected');
    });
  }

  function handleWorkspaceUpgrade(request, socket, head, surface = 'local') {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/devtools-ws') {
      if (surface === 'local' && !originAllowed(request, config)) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      if (surface === 'local' && !authorized(request, config)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      const renderer = rendererForDevtoolsAccess(url.searchParams.get('access'));
      const targetId = url.searchParams.get('target');
      if (!renderer?.cdpPort || !targetId || renderer.surface?.targetId !== targetId) {
        socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      devtoolsWss.handleUpgrade(request, socket, head, (ws) => bridgeDevtoolsSocket(ws, renderer, targetId, request));
      return;
    }
    if (url.pathname === '/conversation-ws') {
      if (surface === 'local' && !originAllowed(request, config)) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      if (surface === 'local' && !authorized(request, config)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      if (conversationStreams.size >= config.maxConnections) {
        socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      conversationWss.handleUpgrade(request, socket, head, (ws) =>
        conversationWss.emit('connection', ws, request));
      return;
    }
    if (url.pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    if (surface === 'local' && !originAllowed(request, config)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    if (surface === 'local' && !authorized(request, config)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    if (clients.size >= config.maxConnections) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
  }

  server.on('upgrade', (request, socket, head) => handleWorkspaceUpgrade(request, socket, head, 'local'));
  remoteServer.on('upgrade', (request, socket, head) =>
    remoteGateway.handleUpgrade(request, socket, head, handleWorkspaceUpgrade));

  conversationWss.on('connection', async (socket, request) => {
    const requestUrl = new URL(request.url, 'http://localhost');
    const name = requestUrl.searchParams.get('session');
    const threadId = requestUrl.searchParams.get('thread') || undefined;
    const historyLimitValue = requestUrl.searchParams.get('historyLimit');
    const requestedHistoryLimit = Number(historyLimitValue);
    const historyLimit = historyLimitValue !== null && Number.isInteger(requestedHistoryLimit)
      ? Math.max(20, Math.min(5_000, requestedHistoryLimit)) : undefined;
    const conversationOptions = { threadId, ...(historyLimit ? { historyLimit } : {}) };
    if (!name || name.length > 64 || !threadId || threadId.length > 128) {
      socket.close(1008, 'Invalid conversation stream');
      return;
    }
    if (request.remoteDeviceId) {
      let sockets = remoteDeviceSockets.get(request.remoteDeviceId);
      if (!sockets) {
        sockets = new Set();
        remoteDeviceSockets.set(request.remoteDeviceId, sockets);
      }
      sockets.add(socket);
      const removeRemoteSocket = () => {
        sockets.delete(socket);
        if (sockets.size === 0) remoteDeviceSockets.delete(request.remoteDeviceId);
      };
      socket.once('close', removeRemoteSocket);
      socket.once('error', removeRemoteSocket);
      remoteGateway.trackSocket(socket, request);
    }

    let stopWatching = async () => {};
    let closed = false;
    let streamedMessageId;
    const send = (message) => {
      if (!closed && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    };
    const close = async (force = false) => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      conversationStreams.delete(close);
      await stopWatching();
      if (force && socket.readyState < WebSocket.CLOSING) socket.terminate();
    };
    close.sessionName = name;
    close.sendControl = send;
    const heartbeat = setInterval(() => send({ type: 'heartbeat', at: Date.now() }), 3_000);
    heartbeat.unref?.();
    conversationStreams.add(close);
    socket.once('close', () => void close());
    socket.once('error', () => void close());

    try {
      const session = await conversationSession(name);
      if (!session) {
        socket.close(1008, 'Managed session not found');
        await close();
        return;
      }
      // Provider watch publishes an authoritative initial snapshot before it
      // resolves. Avoid a separate read here: mobile already paints its LRU
      // snapshot immediately, and an uncached first visit performed the HTTP
      // readiness read before opening this socket.
      stopWatching = await conversationRegistry.watch(session, conversationOptions, (event) => {
        let outgoing = event;
        if (event.stream?.kind === 'agent_message_chunk') {
          const message = [...(event.conversation?.items || [])].reverse().find(
            (item) => item.type === 'message' && item.role === 'assistant',
          );
          const stream = {
            ...event.stream,
            threadId: event.conversation?.thread?.id,
            messageId: message?.id,
          };
          outgoing = message?.id && streamedMessageId === message.id
            ? { stream }
            : { ...event, stream };
          streamedMessageId = message?.id;
        } else {
          streamedMessageId = undefined;
        }
        send({ type: 'conversation', ...outgoing });
      });
      if (closed) await stopWatching();
    } catch (error) {
      send({ type: 'error', error: error.message || 'Conversation stream failed' });
      if (socket.readyState < WebSocket.CLOSING) socket.close(1011, 'Conversation stream failed');
      await close();
    }
  });

  wss.on('connection', async (socket, request) => {
    clients.add(socket);
    if (request.remoteDeviceId) {
      let sockets = remoteDeviceSockets.get(request.remoteDeviceId);
      if (!sockets) {
        sockets = new Set();
        remoteDeviceSockets.set(request.remoteDeviceId, sockets);
      }
      sockets.add(socket);
      const removeRemoteSocket = () => {
        sockets.delete(socket);
        if (sockets.size === 0) remoteDeviceSockets.delete(request.remoteDeviceId);
      };
      socket.once('close', removeRemoteSocket);
      socket.once('error', removeRemoteSocket);
      remoteGateway.trackSocket(socket, request);
    }
    const requestUrl = new URL(request.url, 'http://localhost');
    const requestedSession = requestUrl.searchParams.get('session');
    const graphicsShell = requestUrl.searchParams.get('mode') === 'graphics';
    const graphicsRenderer = graphicsShell && requestUrl.searchParams.get('purpose') === 'renderer';
    const rendererKey = requestUrl.searchParams.get('renderer');
    const requestedCols = Number(requestUrl.searchParams.get('cols'));
    const requestedRows = Number(requestUrl.searchParams.get('rows'));
    const initialCols = Number.isInteger(requestedCols) && requestedCols >= 2 && requestedCols <= 500
      ? requestedCols
      : 80;
    const initialRows = Number.isInteger(requestedRows) && requestedRows >= 1 && requestedRows <= 300
      ? requestedRows
      : 24;
    if (graphicsRenderer && rendererKey) {
      if (!rendererKeyPattern.test(rendererKey)) {
        sendJson(socket, { type: 'error', message: 'Invalid renderer key' });
        socket.close(1008, 'Invalid renderer key');
        clients.delete(socket);
        return;
      }
      clientContexts.set(socket, { session: null, mode: 'graphics', renderer: rendererKey, rendererKey });
      attachRenderer(socket, rendererKey, initialCols, initialRows);
      return;
    }
    let launch = {
      command: config.command,
      args: config.args,
      cwd: config.cwd,
      mode: config.tmuxBacked ? 'tmux' : 'shell',
      session: config.useTmux
        ? config.tmuxSession
        : config.useTmuxShell ? config.tmuxShellSession : undefined,
      label: config.useTmux
        ? config.tmuxSession
        : config.useTmuxShell ? config.tmuxShellSession : 'shell',
    };

    if (graphicsShell) {
      launch = {
        command: config.shell,
        args: config.shellArgs,
        cwd: config.cwd,
        mode: 'graphics',
        session: undefined,
        label: 'graphics',
      };
    } else if (requestedSession) {
      const sessions = await listWorkspaceSessions();
      const selected = sessions.find((session) => session.name === requestedSession);
      if (!selected) {
        sendJson(socket, { type: 'error', message: 'Managed session not found' });
        socket.close(1008, 'Managed session not found');
        clients.delete(socket);
        return;
      }
      launch = {
        command: config.tmuxCommand,
        args: ['attach-session', '-t', selected.name],
        cwd: selected.cwd || config.cwd,
        mode: 'tmux',
        session: selected.name,
        label: selected.label,
      };
    }

    if (socket.readyState !== WebSocket.OPEN) {
      clients.delete(socket);
      return;
    }

    clientContexts.set(socket, {
      session: launch.session ?? null,
      mode: launch.mode,
      rendererKey: graphicsShell
        ? 'builtin:graphics'
        : requestedSession ? `session:${requestedSession}` : 'builtin:shell',
    });

    let terminal;
    try {
      if (launch.session && (requestedSession || config.useTmuxShell)) {
        await execFileAsync(config.tmuxCommand, ['set-option', '-t', launch.session, 'status', 'off']).catch(() => {});
        // Also migrate sessions created by older agent-remote versions when
        // their first browser reconnects.
        await stabilizeManagedSessionSize(config.tmuxCommand, launch.session).catch(() => {});
      }
      const terminalEnv = {
        ...process.env,
        PATH: `${agentRemoteBin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
        AGENT_REMOTE_WEB: '1',
        AGENT_REMOTE_URL: `http://127.0.0.1:${server.address().port}`,
        AGENT_REMOTE_SESSION: launch.session ?? '',
        AGENT_REMOTE_TOKEN: config.token,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        TERM_PROGRAM: 'agent-remote',
        TERM_PROGRAM_VERSION: '1.0.0',
      };
      if (launch.mode === 'graphics') {
        delete terminalEnv.TMUX;
        delete terminalEnv.TMUX_PANE;
        terminalEnv.AGENT_REMOTE_GRAPHICS = '1';
        terminalEnv.TERMINAL_BROWSER_DISPLAY_SCALE = '1';
        if (graphicsRenderer) terminalEnv.AGENT_REMOTE_RENDERER = '1';
      } else {
        delete terminalEnv.AGENT_REMOTE_GRAPHICS;
        delete terminalEnv.AGENT_REMOTE_RENDERER;
      }
      terminal = pty.spawn(launch.command, launch.args, {
        name: 'xterm-256color',
        cols: initialCols,
        rows: initialRows,
        cwd: launch.cwd,
        env: terminalEnv,
      });
      if (launch.session && (requestedSession || config.useTmuxShell)) {
        const hideStatus = setTimeout(() => {
          void execFileAsync(config.tmuxCommand, ['set-option', '-t', launch.session, 'status', 'off']).catch(() => {});
        }, 50);
        hideStatus.unref?.();
      }
    } catch (error) {
      sendJson(socket, { type: 'error', message: error.message });
      socket.close(1011, 'PTY failed to start');
      clients.delete(socket);
      clientContexts.delete(socket);
      return;
    }

    sendJson(socket, {
      type: 'ready',
      mode: launch.mode,
      session: launch.session,
      label: launch.label,
    });
    const output = terminal.onData((data) => {
      if (socket.bufferedAmount > 8 * 1024 * 1024) {
        socket.close(1013, 'Client is too slow');
        return;
      }
      sendJson(socket, { type: 'output', data });
    });
    const exit = terminal.onExit(({ exitCode, signal }) => {
      sendJson(socket, { type: 'exit', exitCode, signal });
      socket.close(1000, 'PTY exited');
    });

    socket.on('message', (raw, isBinary) => {
      if (isBinary || raw.length > 1024 * 1024) {
        socket.close(1009, 'Invalid message');
        return;
      }

      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        sendJson(socket, { type: 'error', message: 'Invalid JSON' });
        return;
      }

      if (message.type === 'input' && typeof message.data === 'string') {
        terminal.write(message.data);
      } else if (message.type === 'close' && graphicsRenderer) {
        // Let terminal-browser close its registered browser session before the
        // PTY is torn down. The subsequent socket close still force-kills the
        // process group if the client does not exit promptly.
        terminal.write('\x03');
        setTimeout(() => socket.close(1000, 'Browser pane closed'), 200);
      } else if (
        message.type === 'resize' &&
        Number.isInteger(message.cols) &&
        Number.isInteger(message.rows) &&
        message.cols >= 2 && message.cols <= 500 &&
        message.rows >= 1 && message.rows <= 300
      ) {
        terminal.resize(message.cols, message.rows);
      } else if (
        message.type === 'viewport' &&
        launch.mode === 'tmux' &&
        ['up', 'down', 'left', 'right', 'cursor'].includes(message.direction)
      ) {
        const viewportFlag = {
          up: '-U', down: '-D', left: '-L', right: '-R', cursor: '-c',
        }[message.direction];
        const amount = Number.isInteger(message.amount)
          ? Math.max(1, Math.min(100, message.amount))
          : 1;
        const args = ['refresh-client', '-t', terminal._pty, viewportFlag];
        if (message.direction !== 'cursor') args.push(String(amount));
        void execFileAsync(config.tmuxCommand, args).catch(() => {
          sendJson(socket, { type: 'error', message: 'The shared terminal viewport could not be moved.' });
        });
      } else {
        sendJson(socket, { type: 'error', message: 'Unsupported message' });
      }
    });

    let cleanedUp = false;
    const cleanUp = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      clients.delete(socket);
      clientContexts.delete(socket);
      output.dispose();
      exit.dispose();
      const killTerminal = () => {
        try {
          terminal.kill();
        } catch {
          // The PTY already exited.
        }
      };
      if (graphicsRenderer) {
        // SIGINT asks terminal-browser to unregister/close its browser session.
        // Keep the PTY alive briefly for that handshake, then force cleanup.
        try { terminal.write('\x03'); } catch {}
        const timer = setTimeout(killTerminal, 2_000);
        timer.unref?.();
      } else {
        killTerminal();
      }
    };
    socket.once('close', cleanUp);
    socket.once('error', cleanUp);
  });

  return {
    config,
    server,
    remoteServer,
    wss,
    devtoolsWss,
    projectStore,
    remoteStore,
    remoteAuth,
    remoteTokenStore,
    remoteProvisioner,
    remoteController,
    tunnelManager,
    remoteGateway,
    get remoteRestore() { return remoteRestore; },
    async listen() {
      const listen = (listener, port, host) => new Promise((resolve, reject) => {
        listener.once('error', reject);
        listener.listen(port, host, resolve);
      });
      await listen(server, config.port, config.host);
      try {
        await listen(remoteServer, config.remotePort, config.remoteHost);
      } catch (error) {
        await new Promise((resolve) => server.close(resolve));
        throw error;
      }
      const localAddress = server.address();
      const remoteAddress = remoteServer.address();
      const localUrl = `http://${config.host}:${localAddress.port}`;
      localControlUrl = localUrl;
      const remoteUrl = `http://${config.remoteHost}:${remoteAddress.port}`;
      // Reconnect an explicitly desired named tunnel as soon as both listeners
      // can accept traffic. Terminal-browser discovery is unrelated startup
      // housekeeping and must not gate Remote access or make it depend on a
      // user opening the local UI.
      remoteRestore = restoreNamedTunnel().catch(() => {});
      const activeBrowserKeys = new Set((await listTerminalBrowsers()).map((browser) => browser.key).filter(Boolean));
      await reapBrowserAutomationSessions(activeBrowserKeys).catch(() => {});
      return { url: localUrl, localUrl, remoteUrl };
    },
    async close() {
      serverClosing = true;
      clearTimeout(sessionRendererSweepTimer);
      for (const key of [...renderers.keys()]) closeRenderer(key, 'Server stopping', true);
      await Promise.allSettled([...rendererCleanups]);
      // A renderer closing concurrently can discover its browser key and add
      // the exact worker cleanup while the first wait is in flight.
      await Promise.allSettled([...browserAgentCleanups]);
      // A browser that has gone to sleep (common on phones) may never answer a
      // WebSocket close handshake. Terminate server-owned sockets during full
      // shutdown so both loopback listeners release their ports deterministically.
      for (const client of clients) client.terminate();
      for (const client of devtoolsClients) client.terminate();
      remoteGateway.close();
      await Promise.all([...workspaceStreams].map((close) => close(true)));
      await Promise.all([...conversationStreams].map((close) => close(true)));
      await conversationRegistry.close?.();
      await conversationAttachments.close?.();
      await Promise.all([
        new Promise((resolve) => wss.close(resolve)),
        new Promise((resolve) => conversationWss.close(resolve)),
        new Promise((resolve) => devtoolsWss.close(resolve)),
      ]);
      if (server.listening) await new Promise((resolve) => server.close(resolve));
      if (remoteServer.listening) await new Promise((resolve) => remoteServer.close(resolve));
      await tunnelManager.close();
      remoteAuth.close();
      remoteStore.close();
      projectStore.close();
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = createTerminalServer();
  app.listen().then(({ url }) => {
    console.log(JSON.stringify({ type: 'ready', localUrl: url }));
    console.log(`Agent Remote listening on ${url}`);
    console.log(app.config.useTmux
      ? `Attached to tmux session: ${app.config.tmuxSession}`
      : 'Session manager ready. Create one with: agent-remote <command>');
  });

  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
