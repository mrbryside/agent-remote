const ESC = '\x1b';
const probeId = 94207;
const imageId = 94208;
const unicodeProbeId = 94209;
let buffer = '';
let stage = 'unicode-probe';

function passthrough(sequence) {
  return process.env.TMUX
    ? `${ESC}Ptmux;${sequence.replaceAll(ESC, ESC + ESC)}${ESC}\\`
    : sequence;
}

function kitty(control, payload) {
  return `${ESC}_G${control};${payload}${ESC}\\`;
}

function finish(code, marker) {
  clearTimeout(timeout);
  process.stdin.off('data', onData);
  process.stdin.setRawMode(false);
  process.stdin.pause();
  process.stdout.write(`\r\n${marker}\r\n`);
  process.exit(code);
}

function onData(chunk) {
  buffer += chunk.toString('binary');
  if (stage === 'unicode-probe' && buffer.includes(`Gi=${unicodeProbeId};EINVAL`)) {
    process.stdout.write('\r\n__KITTY_UNICODE_PLACEMENT_REJECTED__\r\n');
    stage = 'probe';
    buffer = '';
    const query = kitty(`i=${probeId},a=q,t=d,f=24,s=1,v=1`, 'AAAA');
    process.stdout.write(passthrough(query));
    return;
  }
  if (stage === 'probe' && buffer.includes(`Gi=${probeId};OK`)) {
    stage = 'display';
    buffer = '';
    const display = kitty(`i=${imageId},a=T,t=d,f=24,s=1,v=1,c=1,r=1`, 'AP8A');
    process.stdout.write(passthrough(display));
    return;
  }
  if (stage === 'display' && buffer.includes(`Gi=${imageId};OK`)) {
    finish(0, '__KITTY_GRAPHICS_AND_RENDER_OK__');
  }
}

if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) {
  process.stdout.write('__KITTY_NO_TTY__\n');
  process.exit(1);
}

process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', onData);
const timeout = setTimeout(() => finish(1, '__KITTY_GRAPHICS_TIMEOUT__'), 3000);
const unicodeQuery = kitty(`i=${unicodeProbeId},a=q,t=d,f=24,s=1,v=1,U=1`, 'AAAA');
process.stdout.write(`${passthrough(unicodeQuery)}${ESC}[c`);
