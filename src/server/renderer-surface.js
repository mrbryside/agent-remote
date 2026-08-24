import { WebSocket } from 'ws';
import {
  cursorProbeFunction, jpegDimensions, normalizeBrowserCursor, rendererFrameHeaderBytes,
  rendererFrameMagic, rendererScale, rendererViewport, selectRendererViewport,
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
    const visibleClients = [...renderer.clients]
      .filter((client) => client.readyState === WebSocket.OPEN && client.rendererVisible !== false);
    const requested = selectRendererViewport(
      visibleClients.map((client) => client.rendererViewport).filter(Boolean),
      renderer.pendingViewport || renderer.viewport,
    );
    if (!requested) return;
    const matchingClients = visibleClients
      .filter((client) => client.rendererViewport?.width === requested.width &&
        client.rendererViewport?.height === requested.height);
    const requestedScale = rendererScale(matchingClients.length
      ? Math.max(1, ...matchingClients.map((client) => client.rendererScale || 1))
      : renderer.pendingScale ?? renderer.scale ?? 1);
    const pending = renderer.pendingViewport;
    const current = renderer.viewport;
    if ((pending && pending.width === requested.width && pending.height === requested.height &&
          renderer.pendingScale === requestedScale) ||
        (!pending && current && current.width === requested.width && current.height === requested.height &&
          renderer.scale === requestedScale)) return;
    renderer.pendingViewport = requested;
    renderer.pendingScale = requestedScale;
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

  function scheduleSharpRendererFrame(renderer) {
    clearTimeout(renderer.sharpFrameTimer);
    renderer.sharpFrameTimer = undefined;
    if (renderer.scale <= 1 || !renderer.cdp || renderer.closing || !rendererHasVisibleClient(renderer)) return;
    renderer.sharpFrameTimer = setTimeout(async () => {
      renderer.sharpFrameTimer = undefined;
      if (renderer.sharpFrameRunning || !renderer.cdp || renderer.closing ||
          !renderer.viewport || !rendererHasVisibleClient(renderer)) return;
      const cdp = renderer.cdp;
      const viewport = { ...renderer.viewport };
      const viewportGeneration = renderer.viewportGeneration;
      const sequence = renderer.frameSequence;
      renderer.sharpFrameRunning = true;
      try {
        const screenshot = await sendCdp(renderer, 'Page.captureScreenshot', {
          format: 'jpeg',
          quality: 90,
          fromSurface: true,
          captureBeyondViewport: false,
          clip: {
            x: 0,
            y: 0,
            width: viewport.width,
            height: viewport.height,
            scale: renderer.scale,
          },
        });
        if (renderer.cdp === cdp && !renderer.closing &&
            renderer.viewportGeneration === viewportGeneration && renderer.frameSequence === sequence) {
          publishRendererFrame(renderer, screenshot?.data, viewport);
        }
      } catch {
        // A live screencast frame remains usable if the optional sharp settle
        // frame is unavailable or the page navigates during capture.
      } finally {
        renderer.sharpFrameRunning = false;
      }
    }, 140);
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
        const scale = rendererScale(renderer.pendingScale ?? renderer.scale ?? 1);
        renderer.pendingViewport = undefined;
        renderer.pendingScale = undefined;
        const force = renderer.forceViewportConfiguration === true;
        renderer.forceViewportConfiguration = false;
        const metricsChanged = !renderer.viewport ||
          renderer.viewport.width !== viewport.width ||
          renderer.viewport.height !== viewport.height || renderer.scale !== scale;
        const unchanged = !force && !metricsChanged && renderer.viewport &&
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
            deviceScaleFactor: scale,
            // Chrome downsamples Page.startScreencast to roughly 1x when its
            // mobile-emulation bit is combined with a tall Retina viewport.
            // Keep the exact narrow CSS viewport while leaving that bit off;
            // responsive layouts still use the requested width and the live
            // compositor retains the requested DPR.
            mobile: false,
            screenWidth: viewport.width,
            screenHeight: viewport.height,
          });
          if (!active()) return;
          renderer.viewport = viewport;
          renderer.scale = scale;
          renderer.viewportGeneration += 1;
          // Keep the previous bitmap painted when a same-target navigation
          // merely reapplies metrics. The next generation replaces it as soon
          // as Chrome emits a frame, avoiding a visible blank/flicker.
          if (metricsChanged) renderer.lastFrame = undefined;
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
          format: 'jpeg',
          quality: 90,
          fromSurface: true,
          captureBeyondViewport: false,
          clip: {
            x: 0,
            y: 0,
            width: renderer.viewport.width,
            height: renderer.viewport.height,
            scale: renderer.scale,
          },
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
    const desiredScale = renderer.pendingScale ?? renderer.scale ?? 1;
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
    renderer.scale = undefined;
    renderer.pendingViewport = desiredViewport;
    renderer.pendingScale = desiredScale;
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
          scheduleSharpRendererFrame(renderer);
        }
      } else if (message.method === 'Page.frameNavigated' && !message.params?.frame?.parentId) {
        // Cross-document navigation can silently end Chrome's screencast and
        // reset page metrics while leaving the CDP target unchanged. Reapply
        // the exact client viewport and restart capture without waiting for a
        // ResizeObserver event from the frontend.
        renderer.forceViewportConfiguration = true;
        renderer.pendingViewport ||= renderer.viewport;
        renderer.pendingScale ??= renderer.scale;
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
    // A newly navigated/idle tab can miss the first compositor frame. Retry
    // capture briefly on the same renderer instead of failing the whole open
    // and provoking callers to create a second browser pane.
    for (let attempt = 0; attempt < 4 && !renderer.lastFrame; attempt += 1) {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, 125));
      const screenshot = await sendCdp(renderer, 'Page.captureScreenshot', {
        format: 'jpeg', quality: 90, fromSurface: true,
      }).catch(() => undefined);
      if (screenshot?.data) publishRendererFrame(renderer, screenshot.data, renderer.viewport);
    }
    if (!renderer.lastFrame) throw new Error('Browser surface did not produce a first frame');
    renderer.outputChunks = [];
    renderer.outputBytes = 0;
    setRendererState(renderer, 'ready');
    broadcastSurface(renderer);
  }

  async function refreshRendererSurface(renderer, browserState) {
    if (renderer.closing || !renderer.browserSocket) return;
    if (renderer.refreshPromise) {
      if (browserState) renderer.pendingBrowserState = browserState;
      await renderer.refreshPromise;
      return;
    }
    renderer.refreshing = true;
    const refresh = (async () => {
      let nextBrowserState = browserState;
      do {
        const requestedState = nextBrowserState;
        nextBrowserState = undefined;
        try {
          const browser = requestedState || await controlTerminalBrowser(renderer.browserSocket, { cmd: 'targets' });
          if (browser?.tabs?.length) {
            const activeTab = browser.tabs.find((tab) => tab.active) || browser.tabs[0];
            if (activeTab?.targetId) {
              browser.key ||= renderer.browserKey;
              browser.socket ||= renderer.browserSocket;
              if (!renderer.surface || renderer.surface.targetId !== activeTab.targetId || !renderer.cdp) {
                await connectRendererSurface(renderer, browser);
              } else {
                renderer.surface = browserSurface(browser, activeTab, renderer);
                broadcastSurfaceInfo(renderer);
              }
            }
          }
        } catch {
          // The daemon may briefly be unavailable while creating or closing a tab.
        }
        nextBrowserState = renderer.pendingBrowserState;
        renderer.pendingBrowserState = undefined;
      } while (nextBrowserState && !renderer.closing && renderer.browserSocket);
    })();
    renderer.refreshPromise = refresh;
    try {
      await refresh;
    } finally {
      if (renderer.refreshPromise === refresh) renderer.refreshPromise = undefined;
      renderer.refreshing = false;
    }
  }

  async function queueRendererTabControl(renderer, callback) {
    const operation = (renderer.tabControlQueue || Promise.resolve()).catch(() => {}).then(async () => {
      if (!renderer.browserSocket) throw new Error('Browser tabs are not ready');
      return callback();
    });
    renderer.tabControlQueue = operation;
    try {
      return await operation;
    } finally {
      if (renderer.tabControlQueue === operation) renderer.tabControlQueue = undefined;
    }
  }

  async function controlRendererTab(renderer, request) {
    return queueRendererTabControl(renderer, async () => {
      const browser = await controlTerminalBrowser(renderer.browserSocket, request);
      await refreshRendererSurface(renderer, browser);
      return browser;
    });
  }

  async function closeRendererTabs(renderer, requestedTabs = [], options = {}) {
    return queueRendererTabControl(renderer, async () => {
      const browser = await controlTerminalBrowser(renderer.browserSocket, { cmd: 'targets' });
      const tabs = Array.isArray(browser?.tabs) ? browser.tabs : [];
      if (tabs.length === 0) throw new Error('No browser tabs are open');
      const selected = requestedTabs.length > 0
        ? [...new Set(requestedTabs)]
        : [(tabs.find((tab) => tab.active) || tabs[0]).id];
      const available = new Set(tabs.map((tab) => tab.id));
      const missing = selected.find((tab) => !available.has(tab));
      if (missing) throw new Error(`Browser tab ${missing} is no longer open`);
      if (selected.length >= tabs.length) {
        // A UI close carries the tab count that was visible when the user
        // clicked. If another close completed first, a queued request can now
        // appear to target the last tab even though the user never asked to
        // close the pane. Keep that final tab alive and re-broadcast the
        // authoritative state. Explicit CLI/API close requests retain the
        // historical close-the-renderer behavior by default.
        if (options.closeRendererOnLast === false) {
          await refreshRendererSurface(renderer, browser);
          return { closed: [], remaining: tabs.length, rendererClosed: false, preservedLastTab: true };
        }
        return { closed: selected, remaining: 0, rendererClosed: true };
      }
      let state = browser;
      for (const tab of selected) {
        state = await controlTerminalBrowser(renderer.browserSocket, { cmd: 'close-tab', tab });
        if (state?.tabs?.some((item) => item.id === tab)) {
          throw new Error(`terminal-browser did not close tab ${tab}`);
        }
        await refreshRendererSurface(renderer, state);
      }
      return {
        closed: selected,
        remaining: state?.tabs?.length ?? Math.max(0, tabs.length - selected.length),
        rendererClosed: false,
      };
    });
  }

  async function restoreRendererViewport(renderer) {
    if (!renderer.cdp || !renderer.viewport || renderer.closing) return false;
    let metrics;
    try {
      const result = await sendCdp(renderer, 'Runtime.evaluate', {
        expression: 'JSON.stringify([innerWidth, innerHeight, devicePixelRatio])',
        returnByValue: true,
        silent: true,
      });
      metrics = JSON.parse(result?.result?.value || 'null');
    } catch {
      return false;
    }
    const expectedScale = rendererScale(renderer.scale);
    if (Array.isArray(metrics) && metrics[0] === renderer.viewport.width &&
        metrics[1] === renderer.viewport.height && Math.abs(Number(metrics[2]) - expectedScale) < 0.01) {
      return false;
    }
    renderer.forceViewportConfiguration = true;
    renderer.pendingViewport = renderer.viewport;
    renderer.pendingScale = expectedScale;
    await configureRendererViewport(renderer);
    return true;
  }

  function rendererStateForSession(session) {
    if (session) {
      const direct = renderers.get(`session:${session}`);
      if (direct) return direct;
    }
    const owner = [...clientContexts.values()].find((context) =>
      context.mode !== 'graphics' &&
      (!session || context.session === session) &&
      context.rendererKey && renderers.has(context.rendererKey),
    );
    return owner ? renderers.get(owner.rendererKey) : undefined;
  }

  function rendererForSession(session) {
    const renderer = rendererStateForSession(session);
    return renderer?.browserSocket ? renderer : undefined;
  }

  function rendererForDevtoolsAccess(access) {
    if (!access || access.length > 128) return undefined;
    return [...renderers.values()].find((renderer) => renderer.devtoolsAccess === access);
  }

  return {
    broadcastCursor, closeRendererTabs, configureRendererViewport, connectRendererSurface, controlRendererTab,
    rendererForDevtoolsAccess, rendererForSession, rendererStateForSession,
    rendererFrameMessage, refreshRendererSurface,
    requestRendererViewport, restoreRendererViewport, scheduleCursorProbe, sendCdp, sendRendererFrame, setRendererState,
    browserListing,
  };
}
