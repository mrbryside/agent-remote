import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer as createHttpServer, request as createHttpRequest } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { WebSocket, WebSocketServer } from 'ws';
import { loadConfig } from './config.js';
import { createAgentCatalog } from './agents.js';
import {
  closeTerminalBrowserAgentSession,
  reapStaleTerminalBrowserAgentSessions,
  terminalBrowserAgentPaths,
} from './browser-automation.js';
import { createGrokConversationProvider } from './conversations/grok.js';
import { createGrokAcpClient } from './conversations/acp-client.js';
import { createConversationRegistry } from './conversations/registry.js';
import {
  createConversationAttachmentStore,
} from './conversations/attachments.js';
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
  stopManagedSession,
} from './sessions.js';
import {
  authorized,
  json,
  originAllowed,
  trustedRequestAuthority,
} from './server/http.js';
import { createStaticAssetHandler } from './server/static-assets.js';
import { createRemoteRouteHandler } from './server/remote-routes.js';
import { createProjectRouteHandler } from './server/project-routes.js';
import { createConversationControlRouteHandler } from './server/conversation-control-routes.js';
import { createConversationFileRouteHandler } from './server/conversation-file-routes.js';
import { createConversationMessageRouteHandler } from './server/conversation-message-routes.js';
import { createBrowserControlRouteHandler } from './server/browser-control-routes.js';
import { createRendererSurfaceController } from './server/renderer-surface.js';
import { createRendererSocketBridge } from './server/renderer-socket.js';
import { createRendererLifecycle } from './server/renderer-lifecycle.js';
import {
  controlTerminalBrowser,
  createTerminalBrowserLister,
} from './server/terminal-browser-client.js';
import {
  createTerminalBrowserSupervisor,
  terminalBrowserOwnedListing,
  terminalBrowserServerEnvironment,
} from './server/terminal-browser-supervisor.js';
import { createDevtoolsProxy } from './server/devtools-proxy.js';
import { createWorkspaceHttpHandler } from './server/workspace-http.js';
import { installConversationSocket } from './server/conversation-socket.js';
import { installTerminalSocket } from './server/terminal-socket.js';
import { createLocalAuth } from './server/local-auth.js';
import {
  parseRequestUrl,
  rejectInvalidRequestTarget,
  rejectInvalidUpgrade,
} from './server/request-target.js';

export { selectRendererViewport } from './server/renderer-protocol.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = join(root, 'public');
const agentRemoteBin = join(root, 'bin');
const serveStaticAsset = createStaticAssetHandler({ root, publicDir });
const execFileAsync = promisify(execFile);
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
function sendJson(socket, payload) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

const DEFAULT_MAX_CONNECTIONS = 20;
const MAX_CONNECTIONS_LIMIT = 1_000;

function normalizedMaxConnections(value) {
  const requested = Number(value);
  if (!Number.isSafeInteger(requested) || requested < 1) return DEFAULT_MAX_CONNECTIONS;
  return Math.min(requested, MAX_CONNECTIONS_LIMIT);
}

function configureHttpTransport(server) {
  // Request timeouts only govern receiving a request body. Keep the general
  // socket timeout disabled so SSE and upgraded WebSockets can remain open.
  server.requestTimeout = 120_000;
  server.headersTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  if ('keepAliveTimeoutBuffer' in server) server.keepAliveTimeoutBuffer = 1_000;
  server.timeout = 0;
  server.maxHeadersCount = 100;
  server.maxRequestsPerSocket = 100;
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
export function createTerminalServer(options = {}) {
  const loadedConfig = loadConfig(options);
  const config = {
    ...loadedConfig,
    maxConnections: normalizedMaxConnections(loadedConfig.maxConnections),
  };
  const localAuth = createLocalAuth(config);
  const agentCatalog = createAgentCatalog(options.agentDefinitions);
  const clients = new Set();
  const conversationStreams = new Set();
  const workspaceStreams = new Set();
  const longLivedTransports = new Set();
  let workspaceRevision = 0;
  const conversationInputQueues = new Map();
  const conversationInputRequests = new Map();
  const clientContexts = new Map();
  const renderers = new Map();
  const browserAgentCleanups = new Set();
  const rendererCleanups = new Set();
  const rendererDiscoveryAttempts = Number.isInteger(options.rendererDiscoveryAttempts)
    ? Math.max(1, options.rendererDiscoveryAttempts)
    : 110;
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
  const closeBrowserAutomationSessionImpl = options.closeBrowserAutomationSession
    ?? closeTerminalBrowserAgentSession;
  const reapBrowserAutomationSessionsImpl = options.reapBrowserAutomationSessions
    ?? reapStaleTerminalBrowserAgentSessions;
  const projectStore = createProjectStore(config.databaseFile);
  let localControlUrl = '';
  let serverClosing = false;

  function reserveLongLivedTransport() {
    if (longLivedTransports.size >= config.maxConnections) return undefined;
    const reservation = {};
    longLivedTransports.add(reservation);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      longLivedTransports.delete(reservation);
    };
  }

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
    const releaseTransport = reserveLongLivedTransport();
    if (!releaseTransport) {
      json(response, 503, { error: 'Too many live streams' });
      return;
    }
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
      releaseTransport();
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
    // Ephemeral test/preview databases must reap their detached Grok leader;
    // production keeps the shared leader alive for the managed TUI session.
    terminateLeaderOnClose: options.grokTerminateLeaderOnClose === true ||
      resolvePath(config.databaseFile).startsWith(resolvePath(tmpdir()) + '/') ||
      resolvePath(config.databaseFile).includes('/test-results/'),
    environment: () => ({
      AGENT_REMOTE_WEB: '1',
      AGENT_REMOTE_ACP: '1',
      ...(localControlUrl ? { AGENT_REMOTE_URL: localControlUrl } : {}),
      AGENT_REMOTE_TOKEN: config.token,
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
  const handleRemoteRoute = createRemoteRouteHandler({
    config,
    controller: remoteController,
    store: remoteStore,
    auth: remoteAuth,
  });
  let remoteRestore = Promise.resolve();

  async function restoreNamedTunnel() {
    const input = namedTunnelInput(remoteStore.getSettings?.());
    if (!input) return;
    await remoteController.startNamed(input);
  }
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

  async function resolveControlSession({ threadId, session, cwd } = {}) {
    if (threadId) {
      const owners = (await listWorkspaceSessions()).filter((item) =>
        item.conversationThreadId === threadId);
      if (owners.length === 1) return { session: owners[0].name };
      if (owners.length > 1) return { error: 'More than one chat owns that Grok session' };
      // Never fall through to a stale tmux identity inherited from the shared
      // leader. A per-tool Grok thread id is authoritative and fails closed.
      return { error: 'No active chat owns that Grok session' };
    }
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

  const terminalBrowserEnvironment = terminalBrowserServerEnvironment({
    environment: process.env,
    databaseFile: config.databaseFile,
  });
  const terminalBrowserPaths = terminalBrowserAgentPaths({ environment: terminalBrowserEnvironment });
  const hostTerminalBrowserPaths = terminalBrowserAgentPaths({ environment: process.env });
  const listAllTerminalBrowsers = createTerminalBrowserLister({
    execFile: execFileAsync,
    command: join(agentRemoteBin, 'terminal-browser'),
    environment: terminalBrowserEnvironment,
  });
  const listTerminalBrowsers = options.listTerminalBrowsers ?? terminalBrowserOwnedListing(
    listAllTerminalBrowsers,
    terminalBrowserPaths,
  );
  const closeBrowserAutomationSession = options.closeBrowserAutomationSession
    ? closeBrowserAutomationSessionImpl
    : async (browserKey) => {
        const privateClosed = await closeBrowserAutomationSessionImpl(browserKey, {
          environment: terminalBrowserEnvironment,
          paths: terminalBrowserPaths,
        });
        const hostClosed = terminalBrowserPaths.socketDir === hostTerminalBrowserPaths.socketDir
          ? false
          : await closeBrowserAutomationSessionImpl(browserKey, {
              environment: process.env,
              paths: hostTerminalBrowserPaths,
            });
        return privateClosed || hostClosed;
      };
  const reapBrowserAutomationSessions = options.reapBrowserAutomationSessions
    ? reapBrowserAutomationSessionsImpl
    : (activeBrowserKeys, cleanupOptions = {}) => reapBrowserAutomationSessionsImpl(activeBrowserKeys, {
        ...cleanupOptions,
        environment: terminalBrowserEnvironment,
        paths: terminalBrowserPaths,
      });
  const terminalBrowserSupervisor = createTerminalBrowserSupervisor({
    override: options.terminalBrowserSupervisor,
    environment: terminalBrowserEnvironment,
    command: join(agentRemoteBin, 'terminal-browser'),
    execFile: execFileAsync,
    listBrowsers: listTerminalBrowsers,
    reapAgentSessions: reapBrowserAutomationSessions,
    paths: terminalBrowserPaths,
    sweepIntervalMs: options.terminalBrowserSweepIntervalMs,
  });
  const recoverTerminalBrowser = options.recoverTerminalBrowser
    ?? (() => terminalBrowserSupervisor.recover());
  const executeBrowserAction = options.executeBrowserAction ?? (async (browserKey, actionArgs) => {
    const { stdout, stderr } = await execFileAsync(
      join(agentRemoteBin, 'terminal-browser'),
      ['action', '--browser', browserKey, ...actionArgs],
      {
        encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, AGENT_REMOTE_GRAPHICS: '1' },
      },
    );
    return { stdout, stderr };
  });

  const rendererSurface = createRendererSurfaceController({
    renderers,
    clientContexts,
    controlTerminalBrowser,
  });
  const {
    broadcastCursor,
    closeRendererTabs,
    configureRendererViewport,
    connectRendererSurface,
    controlRendererTab,
    rendererForDevtoolsAccess,
    rendererForSession,
    rendererStateForSession,
    rendererFrameMessage,
    refreshRendererSurface,
    requestRendererViewport,
    restoreRendererViewport,
    scheduleCursorProbe,
    sendCdp,
    sendRendererFrame,
    setRendererState,
    browserListing,
  } = rendererSurface;

  const rendererLifecycle = createRendererLifecycle({
    options,
    config,
    agentRemoteBin,
    renderers,
    browserAgentCleanups,
    rendererCleanups,
    closeBrowserAutomationSession,
    listTerminalBrowsers,
    recoverTerminalBrowser,
    terminalBrowserEnvironment,
    rendererSurface,
    shellQuote,
    getLocalPort: () => server.address().port,
    isServerClosing: () => serverClosing,
    rendererCloseGraceMs,
    rendererCloseMinimumMs,
    rendererClosePollMs,
    rendererDiscoveryAttempts,
    rendererDiscoveryIntervalMs,
    sessionRendererSweepIntervalMs,
  });
  const { createRenderer, closeRenderer, launchRenderer } = rendererLifecycle;

  const attachRenderer = createRendererSocketBridge({
    renderers,
    createRenderer,
    launchRenderer,
    clients,
    clientContexts,
    rendererSurface,
    controlRendererTab,
    closeRendererTabs,
    closeRenderer,
  });

  const handleProjectRoute = createProjectRouteHandler({
    config,
    agentCatalog,
    projectStore,
    getLocalPort: () => server.address().port,
    publishWorkspaceChange,
    stopProjectSessions,
    closeRenderer,
    conversationStreams,
  });
  const handleConversationControlRoute = createConversationControlRouteHandler({
    conversationSession,
    registry: conversationRegistry,
    conversationFailure,
  });
  const handleConversationFileRoute = createConversationFileRouteHandler({
    conversationSession,
    attachments: conversationAttachments,
  });
  const handleConversationMessageRoute = createConversationMessageRouteHandler({
    conversationSession,
    registry: conversationRegistry,
    attachments: conversationAttachments,
    deliverInput: deliverConversationInput,
    inputRequests: conversationInputRequests,
    streams: conversationStreams,
    remoteGateway,
    conversationFailure,
    reserveTransport: reserveLongLivedTransport,
  });
  const handleBrowserControlRoute = createBrowserControlRouteHandler({
    resolveControlSession,
    clients,
    clientContexts,
    conversationStreams,
    rendererForSession,
    rendererStateForSession,
    controlRendererTab,
    closeRendererTabs,
    closeRenderer,
    restoreRendererViewport,
    controlTerminalBrowser,
    browserListing,
    executeBrowserAction,
    browserOpenReadyTimeoutMs: Number.isInteger(options.browserOpenReadyTimeoutMs)
      ? Math.max(100, options.browserOpenReadyTimeoutMs)
      : 55_000,
  });

  const devtoolsClients = new Set();
  const { bridgeDevtoolsSocket, proxyDevtoolsAsset } = createDevtoolsProxy({
    createHttpRequest,
    devtoolsClients,
    remoteDeviceSockets,
    remoteGateway,
  });

  const handleWorkspaceRequest = createWorkspaceHttpHandler({
    config,
    handleRemoteRoute,
    handleBrowserControlRoute,
    listWorkspaceSessions,
    openWorkspaceStream,
    projectStore,
    agentCatalog,
    renderers,
    handleConversationFileRoute,
    handleConversationControlRoute,
    handleConversationMessageRoute,
    handleProjectRoute,
    serveStaticAsset,
    rendererForDevtoolsAccess,
    proxyDevtoolsAsset,
    closeRenderer,
    remoteReady: () => remoteServer.listening,
  });

  const handleHttpFailure = (response) => {
    if (response.headersSent) response.destroy();
    else json(response, 500, { error: 'Internal server error' });
  };
  const server = createHttpServer((request, response) => {
    try {
      if (!parseRequestUrl(request)) return rejectInvalidRequestTarget(response);
      if (!trustedRequestAuthority(request, config)) {
        return json(response, 403, { error: 'Host is not allowed' });
      }
      if (localAuth.gateHttp(request, response)) return;
      void Promise.resolve(handleWorkspaceRequest(request, response, 'local'))
        .catch(() => handleHttpFailure(response));
    } catch {
      handleHttpFailure(response);
    }
  });
  const remoteServer = createHttpServer((request, response) => {
    try {
      void Promise.resolve(remoteGateway.handleRequest(request, response, handleWorkspaceRequest))
        .catch(() => handleHttpFailure(response));
    } catch {
      handleHttpFailure(response);
    }
  });
  configureHttpTransport(server);
  configureHttpTransport(remoteServer);

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
  function handleWorkspaceUpgrade(request, socket, head, surface = 'local') {
    const url = parseRequestUrl(request);
    if (!url) return rejectInvalidUpgrade(socket);
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
      const releaseTransport = reserveLongLivedTransport();
      if (!releaseTransport) {
        socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      try {
        devtoolsWss.handleUpgrade(request, socket, head, (ws) => {
          try {
            bridgeDevtoolsSocket(ws, renderer, targetId, request, releaseTransport);
          } catch {
            releaseTransport();
            ws.close(1011, 'DevTools bridge failed');
          }
        });
      } catch {
        releaseTransport();
        socket.destroy();
      }
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

  server.on('upgrade', (request, socket, head) => {
    try {
      if (!parseRequestUrl(request)) return rejectInvalidUpgrade(socket);
      if (!trustedRequestAuthority(request, config)) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      if (!localAuth.gateUpgrade(request, socket)) handleWorkspaceUpgrade(request, socket, head, 'local');
    } catch {
      if (!socket.destroyed) socket.destroy();
    }
  });
  remoteServer.on('upgrade', (request, socket, head) => {
    try {
      remoteGateway.handleUpgrade(request, socket, head, handleWorkspaceUpgrade);
    } catch {
      if (!socket.destroyed) socket.destroy();
    }
  });

  installConversationSocket({
    conversationWss,
    conversationStreams,
    remoteDeviceSockets,
    remoteGateway,
    conversationSession,
    conversationRegistry,
  });
  installTerminalSocket({
    wss,
    clients,
    remoteDeviceSockets,
    remoteGateway,
    clientContexts,
    attachRenderer,
    config,
    listWorkspaceSessions,
    execFileAsync,
    agentRemoteBin,
    getLocalPort: () => server.address().port,
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
      await terminalBrowserSupervisor.start().catch(() => {});
      const activeBrowserKeys = new Set((await listTerminalBrowsers()).map((browser) => browser.key).filter(Boolean));
      await terminalBrowserSupervisor.sweep(activeBrowserKeys).catch(() => {});
      const allBrowserKeys = new Set((await listAllTerminalBrowsers()).map((browser) => browser.key).filter(Boolean));
      await reapStaleTerminalBrowserAgentSessions(allBrowserKeys, {
        environment: process.env, paths: hostTerminalBrowserPaths,
      }).catch(() => {});
      return { url: localUrl, localUrl, remoteUrl };
    },
    async close() {
      serverClosing = true;
      rendererLifecycle.stopSweep();
      for (const key of [...renderers.keys()]) closeRenderer(key, 'Server stopping', true);
      await Promise.allSettled([...rendererCleanups]);
      // A renderer closing concurrently can discover its browser key and add
      // the exact worker cleanup while the first wait is in flight.
      await Promise.allSettled([...browserAgentCleanups]);
      await terminalBrowserSupervisor.stop().catch(() => {});
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

export function desktopParentIsAlive(parentPid, {
  ppid = process.ppid,
  signal = process.kill,
} = {}) {
  if (!Number.isSafeInteger(parentPid) || parentPid <= 1) return true;
  if (ppid !== parentPid) return false;
  try {
    signal(parentPid, 0);
    return true;
  } catch {
    return false;
  }
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

  let shuttingDown = false;
  let parentWatch;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(parentWatch);
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  const desktopParentPid = Number.parseInt(process.env.AGENT_REMOTE_PARENT_PID || '', 10);
  if (Number.isSafeInteger(desktopParentPid) && desktopParentPid > 1) {
    parentWatch = setInterval(() => {
      if (!desktopParentIsAlive(desktopParentPid)) void shutdown();
    }, 1_000);
  }
}
