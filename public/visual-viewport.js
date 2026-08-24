export function viewportGeometry(windowObject) {
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

export function applyViewportGeometry(root, geometry) {
  const { height, width, offsetTop, offsetLeft, insetBottom, insetRight, keyboard } = geometry;
  // Preserve Safari's fractional animation frames. Rounding each sample makes
  // the fixed mobile surface move in visible one-pixel steps.
  root.style.setProperty('--visual-viewport-height', `${height}px`);
  root.style.setProperty('--visual-viewport-width', `${width}px`);
  root.style.setProperty('--visual-viewport-offset-top', `${offsetTop}px`);
  root.style.setProperty('--visual-viewport-offset-left', `${offsetLeft}px`);
  root.style.setProperty('--visual-viewport-inset-top', `${offsetTop}px`);
  root.style.setProperty('--visual-viewport-inset-right', `${insetRight}px`);
  // A small browser/home-indicator inset is uncovered layout canvas, so fill
  // it. A software keyboard is different: extending the fixed application
  // surface behind it leaves a layout-viewport-sized scroll range that iOS can
  // pan even though html/body declare overflow:hidden. During keyboard use the
  // application box must end at the visual viewport edge instead.
  root.style.setProperty('--visual-viewport-layout-inset-bottom', `${keyboard ? 0 : insetBottom}px`);
  root.style.setProperty('--visual-viewport-inset-bottom', '0px');
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
  let motionTimer;
  let previousGeometry;

  function updateViewportMotion(geometry) {
    const previousBottom = previousGeometry
      ? previousGeometry.offsetTop + previousGeometry.height
      : undefined;
    const nextBottom = geometry.offsetTop + geometry.height;
    const delta = previousBottom === undefined ? 0 : nextBottom - previousBottom;
    previousGeometry = geometry;

    if (delta > 1) {
      // iOS may publish keyboard-dismissal geometry as one large update or a
      // handful of uneven steps. Keep one CSS transition active across the
      // whole expansion so the fixed conversation and its composer travel as
      // one surface instead of jumping before the composer finishes folding.
      root.dataset.visualViewportMotion = 'expanding';
      clearTimeout(motionTimer);
      motionTimer = setTimeout(() => {
        if (root.dataset.visualViewportMotion === 'expanding') {
          delete root.dataset.visualViewportMotion;
        }
        motionTimer = undefined;
      }, 300);
      return;
    }

    if (delta < -1) {
      // Keyboard opening must remain immediate so the application never
      // animates through or temporarily underneath the software keyboard.
      clearTimeout(motionTimer);
      motionTimer = undefined;
      delete root.dataset.visualViewportMotion;
    }
  }

  function resetDocumentScroll() {
    const scrollingElement = documentObject.scrollingElement;
    if (!windowObject.scrollX && !windowObject.scrollY &&
        !scrollingElement?.scrollLeft && !scrollingElement?.scrollTop) return;
    // Focused form controls let iOS pan the layout viewport independently of
    // CSS overflow. Agent Remote has its own explicit scroll surfaces, so any
    // document scroll is always accidental and can be reset safely.
    windowObject.scrollTo?.(0, 0);
    if (scrollingElement) {
      scrollingElement.scrollLeft = 0;
      scrollingElement.scrollTop = 0;
    }
  }

  function sync() {
    const geometry = viewportGeometry(windowObject);
    updateViewportMotion(geometry);
    applyViewportGeometry(root, geometry);
    resetDocumentScroll();
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
  windowObject.addEventListener('scroll', resetDocumentScroll, { passive: true });
  sync();

  return {
    sync,
    destroy() {
      windowObject.visualViewport.removeEventListener('resize', schedule);
      windowObject.visualViewport.removeEventListener('scroll', schedule);
      windowObject.removeEventListener('resize', schedule);
      windowObject.removeEventListener('scroll', resetDocumentScroll);
      cancelAnimationFrame(frame);
      clearTimeout(motionTimer);
      delete root.dataset.visualViewportMotion;
    },
  };
}
