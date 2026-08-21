function viewportGeometry(windowObject) {
  const viewport = windowObject.visualViewport;
  const height = Math.max(1, viewport.height);
  const width = Math.max(1, viewport.width);
  const offsetTop = Math.max(0, viewport.offsetTop);
  const offsetLeft = Math.max(0, viewport.offsetLeft);
  const insetBottom = Math.max(0, windowObject.innerHeight - height - offsetTop);
  const insetRight = Math.max(0, windowObject.innerWidth - width - offsetLeft);
  return {
    height,
    width,
    offsetTop,
    offsetLeft,
    insetBottom,
    insetRight,
    keyboard: insetBottom > 120,
  };
}

function applyViewportGeometry(root, geometry) {
  const { height, width, offsetTop, offsetLeft, insetBottom, insetRight, keyboard } = geometry;
  // Preserve Safari's fractional animation frames. Rounding each sample makes
  // the fixed mobile surface move in visible one-pixel steps.
  root.style.setProperty('--visual-viewport-height', `${height}px`);
  root.style.setProperty('--visual-viewport-width', `${width}px`);
  root.style.setProperty('--visual-viewport-offset-top', `${offsetTop}px`);
  root.style.setProperty('--visual-viewport-offset-left', `${offsetLeft}px`);
  root.style.setProperty('--visual-viewport-inset-top', `${offsetTop}px`);
  root.style.setProperty('--visual-viewport-inset-right', `${insetRight}px`);
  root.style.setProperty('--visual-viewport-layout-inset-bottom', `${insetBottom}px`);
  // Small bottom insets are Safari/home-indicator chrome. They belong to the
  // opaque canvas, while controls move only for an actual keyboard.
  root.style.setProperty('--visual-viewport-inset-bottom', `${keyboard ? insetBottom : 0}px`);
  root.style.setProperty('--visual-viewport-inset-left', `${offsetLeft}px`);
  root.dataset.visualKeyboard = String(keyboard);
}

export function installVisualViewportSync({
  windowObject = window,
  documentObject = document,
  root = documentObject.documentElement,
  onChange = () => {},
} = {}) {
  if (!windowObject.visualViewport) return { sync() {}, destroy() {} };
  let frame;

  function sync() {
    const geometry = viewportGeometry(windowObject);
    applyViewportGeometry(root, geometry);
    documentObject.dispatchEvent(new CustomEvent('agent-remote:visual-viewport', { detail: geometry }));
    onChange(geometry);
  }

  function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = undefined;
      sync();
    });
  }

  windowObject.visualViewport.addEventListener('resize', schedule);
  windowObject.visualViewport.addEventListener('scroll', schedule);
  // Rotation and browser chrome changes may update the layout viewport without
  // a matching visualViewport notification.
  windowObject.addEventListener('resize', schedule);
  sync();

  return {
    sync,
    destroy() {
      windowObject.visualViewport.removeEventListener('resize', schedule);
      windowObject.visualViewport.removeEventListener('scroll', schedule);
      windowObject.removeEventListener('resize', schedule);
      cancelAnimationFrame(frame);
    },
  };
}
