import { createConnection } from 'node:net';

export function createTerminalBrowserLister({ override, execFile, command }) {
  if (override) return override;
  return async function listTerminalBrowsers() {
    try {
      const { stdout } = await execFile(command, ['ls', '--all', '--json'], {
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, AGENT_REMOTE_GRAPHICS: '1' },
      });
      const parsed = JSON.parse(stdout);
      return Array.isArray(parsed.browsers) ? parsed.browsers : [];
    } catch {
      return [];
    }
  };
}

export function controlTerminalBrowser(socketPath, request) {
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
