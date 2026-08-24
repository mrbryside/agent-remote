import { randomBytes } from 'node:crypto';
import * as pty from 'node-pty';
import { WebSocket } from 'ws';
import { listManagedSessions } from '../sessions.js';

function sendJson(socket, payload) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

export function createRendererLifecycle({
  options, config, agentRemoteBin, renderers, browserAgentCleanups, rendererCleanups,
  closeBrowserAutomationSession, listTerminalBrowsers, recoverTerminalBrowser,
  terminalBrowserEnvironment,
  rendererSurface, shellQuote,
  getLocalPort, isServerClosing, rendererCloseGraceMs, rendererCloseMinimumMs,
  rendererClosePollMs, rendererDiscoveryAttempts, rendererDiscoveryIntervalMs,
  sessionRendererSweepIntervalMs,
}) {
  const {
    connectRendererSurface, refreshRendererSurface, setRendererState,
  } = rendererSurface;
  let sessionRendererSweepTimer;
  let sessionRendererSweepRunning = false;
  const rendererClosingTasks = new Map();
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
    while (!isServerClosing() && Date.now() < deadline) {
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
    // A replacement renderer may be requested immediately after its pane is
    // closed. Serialize cleanup by renderer key so the new terminal-browser
    // cannot reuse the private profile/socket while the old process is still
    // unregistering it.
    const previous = rendererClosingTasks.get(renderer.key);
    const task = (previous ? previous.catch(() => {}) : Promise.resolve())
      .then(() => finishRendererClose(renderer))
      .catch(() => killRendererTerminal(renderer))
      .finally(() => {
        rendererCleanups.delete(task);
        if (rendererClosingTasks.get(renderer.key) === task) rendererClosingTasks.delete(renderer.key);
      });
    rendererClosingTasks.set(renderer.key, task);
    rendererCleanups.add(task);
    return task;
  }

  async function sweepSessionRenderers() {
    if (sessionRendererSweepRunning || isServerClosing()) return;
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
    if (isServerClosing() || sessionRendererSweepIntervalMs === 0 || sessionRendererSweepTimer) return;
    if (![...renderers.keys()].some((key) => key.startsWith('session:'))) return;
    sessionRendererSweepTimer = setTimeout(async () => {
      sessionRendererSweepTimer = undefined;
      await sweepSessionRenderers();
      scheduleSessionRendererSweep();
    }, sessionRendererSweepIntervalMs);
    sessionRendererSweepTimer.unref?.();
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
    const previousClose = rendererClosingTasks.get(renderer.key);
    if (previousClose) {
      if (discoversBrowser) setRendererState(renderer, 'starting', 'Finishing the previous browser shutdown…');
      await previousClose.catch(() => {});
      if (renderer.closing) return undefined;
    }
    const command = argv.map(shellQuote).join(' ');
    const launch = async (message) => {
      const previous = discoversBrowser
        ? new Set((await listTerminalBrowsers()).map((browser) => browser.key))
        : null;
      renderer.previousBrowserKeys = previous || new Set();
      if (renderer.closing) return undefined;
      setRendererState(renderer, discoversBrowser ? 'starting' : 'terminal', message);
      renderer.terminal.write(`${discoversBrowser ? 'TERMINAL_BROWSER_SKIP_GRAPHICS_CHECK=1 ' : ''}${command}\r`);
      return previous ? discoverRendererSurface(renderer, previous) : undefined;
    };
    try {
      return await launch();
    } catch (error) {
      if (!discoversBrowser || renderer.closing || renderer.browserRecoveryAttempted) throw error;
      renderer.browserRecoveryAttempted = true;
      // Discovery is deliberately longer than terminal-browser's own bounded
      // open timeout. By this point its foreground client has returned to the
      // renderer shell, so a retry cannot be typed into the first process's
      // stdin. Sending Ctrl-C here is unsafe: if the client already exited it
      // would kill the profile-free renderer shell itself.
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (!await recoverTerminalBrowser()) throw error;
      try {
        return await launch('Restarting an unresponsive browser service…');
      } catch (retryError) {
        throw new Error(`${retryError.message || 'terminal-browser failed'} after automatic service recovery`);
      }
    }
  }

  function rendererEnvironment() {
    const environment = {
      ...terminalBrowserEnvironment,
      PATH: `${agentRemoteBin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
      AGENT_REMOTE_WEB: '1',
      AGENT_REMOTE_URL: `http://127.0.0.1:${getLocalPort()}`,
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
      launchGeneration: 0,
      browserLaunchStarted: false,
      previousBrowserKeys: new Set(),
      browserRecoveryAttempted: false,
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
      scale: undefined,
      viewportGeneration: 0,
      pendingViewport: undefined,
      pendingScale: undefined,
      forceViewportConfiguration: false,
      configuringViewport: false,
      screencastStarted: false,
      cursor: 'default',
      cursorProbePoint: undefined,
      cursorProbeTimer: undefined,
      cursorProbeRunning: false,
      sharpFrameTimer: undefined,
      sharpFrameRunning: false,
      refreshing: false,
      refreshPromise: undefined,
      pendingBrowserState: undefined,
      tabControlQueue: undefined,
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
      clearTimeout(renderer.sharpFrameTimer);
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
    clearTimeout(renderer.sharpFrameTimer);
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

  return {
    closeRenderer,
    createRenderer,
    launchRenderer,
    stopSweep: () => clearTimeout(sessionRendererSweepTimer),
  };
}
