import { WebSocket } from 'ws';
import { browserVirtualKeyCode, rendererScale, rendererViewport } from './renderer-protocol.js';

function sendJson(socket, payload) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

export function createRendererSocketBridge({
  renderers, createRenderer, launchRenderer, clients, clientContexts, rendererSurface,
  controlRendererTab, closeRendererTabs, closeRenderer,
}) {
  const {
    broadcastCursor, configureRendererViewport, rendererFrameMessage, requestRendererViewport,
    scheduleCursorProbe, sendCdp, sendRendererFrame, setRendererState,
  } = rendererSurface;
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
          renderer.launchGeneration += 1;
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
        socket.rendererScale = rendererScale(message.scale);
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
        if (message.type === 'tab-switch') {
          void controlRendererTab(renderer, { cmd: 'activate-tab', tab: message.tab })
            .catch((error) => sendJson(socket, { type: 'error', message: error.message }));
        } else {
          void closeRendererTabs(renderer, [message.tab], {
            // Older cached web clients do not send this field. Their original
            // contract was to close the renderer when the final tab closes,
            // so only an explicit false may preserve the last tab during a
            // queued multi-close race.
            closeRendererOnLast: message.closeRendererOnLast !== false,
          }).then((closed) => {
            if (closed.rendererClosed) closeRenderer(key, 'Last browser tab closed', false, renderer);
          }).catch((error) => sendJson(socket, { type: 'error', message: error.message }));
        }
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

  return attachRenderer;
}
