import { execFileSync } from 'node:child_process';

const ESC = '\x1b';
const marker = process.argv[2] || '__WEB_SPLIT_READY__';
const payload = Buffer.from(JSON.stringify({
  argv: ['printf', `${marker}\\r\\n`],
})).toString('base64url');
const sequence = `${ESC}]777;agent-remote-split:${payload}${ESC}\\`;

if (process.env.TMUX) {
  try { execFileSync('tmux', ['set-option', '-p', 'allow-passthrough', 'on']); } catch {}
  process.stdout.write(`${ESC}Ptmux;${sequence.replaceAll(ESC, ESC + ESC)}${ESC}\\`);
} else {
  process.stdout.write(sequence);
}
