import { WebSocket } from 'ws';
import {
  cursorProbeFunction, jpegDimensions, normalizeBrowserCursor, rendererFrameHeaderBytes,
  rendererFrameMagic, rendererViewport, selectRendererViewport,
} from './renderer-protocol.js';

function sendJson(socket, payload) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

export function createRendererSurfaceController({ renderers, clientContexts, controlTerminalBrowser }) {
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

  return {
    broadcastCursor, configureRendererViewport, connectRendererSurface, controlRendererTab,
    rendererForDevtoolsAccess, rendererForSession, rendererFrameMessage, refreshRendererSurface,
    requestRendererViewport, scheduleCursorProbe, sendCdp, sendRendererFrame, setRendererState,
    browserListing,
  };
}

