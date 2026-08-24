import * as pty from 'node-pty';
import { WebSocket } from 'ws';
import { followActiveManagedSessionSize } from '../sessions.js';

const rendererKeyPattern = /^(?:builtin:(?:shell|graphics)|session:[A-Za-z0-9_.-]{1,64})$/;

function sendJson(socket, payload) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

export function installTerminalSocket({
  wss, clients, remoteDeviceSockets, remoteGateway, clientContexts, attachRenderer,
  config, listWorkspaceSessions, execFileAsync, agentRemoteBin, getLocalPort,
}) {
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
        await followActiveManagedSessionSize(config.tmuxCommand, launch.session).catch(() => {});
      }
      const terminalEnv = {
        ...process.env,
        PATH: `${agentRemoteBin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
        AGENT_REMOTE_WEB: '1',
        AGENT_REMOTE_URL: `http://127.0.0.1:${getLocalPort()}`,
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
}
