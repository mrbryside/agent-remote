import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyViewportGeometry,
  installVisualViewportSync,
  viewportGeometry,
} from '../public/visual-viewport.js';

function styleRecorder() {
  const values = new Map();
  return {
    values,
    style: {
      setProperty(name, value) { values.set(name, value); },
    },
  };
}

test('keyboard geometry ends the application surface at the visual viewport', () => {
  const windowObject = {
    innerHeight: 844,
    innerWidth: 390,
    visualViewport: { height: 510, width: 390, offsetTop: 24, offsetLeft: 0 },
  };
  const geometry = viewportGeometry(windowObject);
  assert.equal(geometry.keyboard, true);

  const root = { ...styleRecorder(), dataset: {} };
  applyViewportGeometry(root, geometry);
  assert.equal(root.values.get('--visual-viewport-height'), '510px');
  assert.equal(root.values.get('--visual-viewport-layout-inset-bottom'), '0px');
  assert.equal(root.values.get('--visual-viewport-inset-bottom'), '0px');
  assert.equal(root.dataset.visualKeyboard, 'true');
});

test('small browser chrome inset still fills the idle layout viewport', () => {
  const geometry = viewportGeometry({
    innerHeight: 844,
    innerWidth: 390,
    visualViewport: { height: 810, width: 390, offsetTop: 0, offsetLeft: 0 },
  });
  assert.equal(geometry.keyboard, false);

  const root = { ...styleRecorder(), dataset: {} };
  applyViewportGeometry(root, geometry);
  assert.equal(root.values.get('--visual-viewport-layout-inset-bottom'), '34px');
  assert.equal(root.dataset.visualKeyboard, 'false');
});

test('visual viewport synchronization resets accidental document scrolling', () => {
  const visualViewport = new EventTarget();
  Object.assign(visualViewport, { height: 510, width: 390, offsetTop: 24, offsetLeft: 0 });
  const windowObject = new EventTarget();
  Object.assign(windowObject, {
    innerHeight: 844,
    innerWidth: 390,
    visualViewport,
    scrollX: 0,
    scrollY: 48,
    scrollTo(x, y) { this.scrollX = x; this.scrollY = y; },
  });
  const scrollingElement = { scrollLeft: 0, scrollTop: 48 };
  const documentObject = new EventTarget();
  documentObject.documentElement = { ...styleRecorder(), dataset: {} };
  documentObject.scrollingElement = scrollingElement;
  const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
  const previousCancelAnimationFrame = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  globalThis.cancelAnimationFrame = clearTimeout;
  try {
    const sync = installVisualViewportSync({ windowObject, documentObject });
    assert.equal(windowObject.scrollY, 0);
    assert.equal(scrollingElement.scrollTop, 0);
    sync.destroy();
  } finally {
    globalThis.requestAnimationFrame = previousRequestAnimationFrame;
    globalThis.cancelAnimationFrame = previousCancelAnimationFrame;
  }
});

test('visual viewport synchronization marks only viewport expansion for smooth dismissal', async () => {
  const visualViewportState = { height: 510, width: 390, offsetTop: 24, offsetLeft: 0 };
  const visualViewport = new EventTarget();
  for (const property of Object.keys(visualViewportState)) {
    Object.defineProperty(visualViewport, property, { get: () => visualViewportState[property] });
  }
  const windowObject = new EventTarget();
  Object.assign(windowObject, {
    innerHeight: 844,
    innerWidth: 390,
    visualViewport,
    scrollX: 0,
    scrollY: 0,
  });
  const documentObject = new EventTarget();
  documentObject.documentElement = { ...styleRecorder(), dataset: {} };
  documentObject.scrollingElement = { scrollLeft: 0, scrollTop: 0 };
  const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
  const previousCancelAnimationFrame = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  globalThis.cancelAnimationFrame = clearTimeout;
  const sync = installVisualViewportSync({
    windowObject,
    documentObject,
    root: documentObject.documentElement,
  });
  try {
    Object.assign(visualViewportState, { height: 844, offsetTop: 0 });
    visualViewport.dispatchEvent(new Event('resize'));
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(documentObject.documentElement.dataset.visualViewportMotion, 'expanding');
    assert.equal(documentObject.documentElement.values.get('--visual-viewport-height'), '844px');

    Object.assign(visualViewportState, { height: 510, offsetTop: 24 });
    visualViewport.dispatchEvent(new Event('resize'));
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(documentObject.documentElement.dataset.visualViewportMotion, undefined);
  } finally {
    sync.destroy();
    globalThis.requestAnimationFrame = previousRequestAnimationFrame;
    globalThis.cancelAnimationFrame = previousCancelAnimationFrame;
  }
});
