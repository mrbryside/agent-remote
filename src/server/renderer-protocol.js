const browserCursorValues = new Set([
  'default', 'none', 'context-menu', 'help', 'pointer', 'progress', 'wait', 'cell', 'crosshair',
  'text', 'vertical-text', 'alias', 'copy', 'move', 'no-drop', 'not-allowed', 'grab', 'grabbing',
  'all-scroll', 'col-resize', 'row-resize', 'n-resize', 'e-resize', 's-resize', 'w-resize', 'ne-resize',
  'nw-resize', 'se-resize', 'sw-resize', 'ew-resize', 'ns-resize', 'nesw-resize', 'nwse-resize',
  'zoom-in', 'zoom-out',
]);

const browserVirtualKeyCodes = new Map(Object.entries({
  Backspace: 8, Tab: 9, Enter: 13, NumpadEnter: 13, ShiftLeft: 16, ShiftRight: 16,
  ControlLeft: 17, ControlRight: 17, AltLeft: 18, AltRight: 18, Pause: 19, CapsLock: 20,
  Escape: 27, Space: 32, PageUp: 33, PageDown: 34, End: 35, Home: 36, ArrowLeft: 37,
  ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, PrintScreen: 44, Insert: 45, Delete: 46,
  MetaLeft: 91, MetaRight: 92, ContextMenu: 93, NumpadMultiply: 106, NumpadAdd: 107,
  NumpadSubtract: 109, NumpadDecimal: 110, NumpadDivide: 111, NumLock: 144, ScrollLock: 145,
  Semicolon: 186, Equal: 187, Comma: 188, Minus: 189, Period: 190, Slash: 191,
  Backquote: 192, BracketLeft: 219, Backslash: 220, BracketRight: 221, Quote: 222,
}));

export const rendererFrameHeaderBytes = 28;
export const rendererFrameMagic = 'OTF1';

export const cursorProbeFunction = `function(x, y) {
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

export const devtoolsBootstrap = `
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

export function normalizeBrowserCursor(value) {
  if (typeof value !== 'string') return 'default';
  const fallback = value.split(',').at(-1)?.trim().toLowerCase();
  return browserCursorValues.has(fallback) ? fallback : 'default';
}

export function browserVirtualKeyCode(message) {
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
  const keyMapped = browserVirtualKeyCodes.get(key) || { ' ': 32, Spacebar: 32, Esc: 27, Del: 46 }[key];
  if (keyMapped) return keyMapped;
  if (/^[a-z]$/i.test(key)) return key.toUpperCase().charCodeAt(0);
  if (/^[0-9]$/.test(key)) return key.charCodeAt(0);
  return Number.isInteger(message.keyCode) && message.keyCode > 0 && message.keyCode <= 255
    ? message.keyCode
    : 0;
}

export function rendererViewport(width, height) {
  return {
    width: Math.max(160, Math.min(4096, Math.floor(width))),
    height: Math.max(120, Math.min(4096, Math.floor(height))),
  };
}

export function rendererScale(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 1;
  // Quarter-step buckets keep ResizeObserver/client reconnect noise from
  // repeatedly restarting Chrome's screencast while still giving Retina
  // phones enough source pixels for a sharp canvas.
  return Math.max(1, Math.min(3, Math.round(numeric * 4) / 4));
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

export function jpegDimensions(data) {
  let buffer;
  try {
    if (Buffer.isBuffer(data)) buffer = data.subarray(0, Math.min(data.length, 48 * 1024));
    else {
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

export function canonicalBrowserUrl(value) {
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
