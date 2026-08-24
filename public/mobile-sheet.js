function classes(base, extension = '') {
  return [base, extension].filter(Boolean).join(' ');
}

export function createMobileSheetFrame({
  root,
  element,
  label = 'Sheet',
  handleLabel = 'Drag down to close',
  classNames = {},
  footer = false,
} = {}) {
  const sheet = element('section', classes('mobile-sheet mobile-sheet-backdrop', classNames.sheet));
  sheet.hidden = true;
  sheet.tabIndex = -1;
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-label', label);

  const panel = element('div', classes('mobile-sheet-panel', classNames.panel));
  const handle = element('button', classes('mobile-sheet-handle', classNames.handle));
  handle.type = 'button';
  handle.setAttribute('aria-label', handleLabel);
  const header = element('header', classes('mobile-sheet-header', classNames.header));
  const body = element('div', classes('mobile-sheet-body', classNames.body));
  const footerSlot = footer
    ? element('footer', classes('mobile-sheet-footer', classNames.footer))
    : undefined;

  panel.append(handle, header, body);
  if (footerSlot) panel.append(footerSlot);
  sheet.append(panel);
  root?.append(sheet);
  return {
    sheet,
    panel,
    handle,
    slots: { header, body, footer: footerSlot },
  };
}

export function resetMobileSheet(panel) {
  if (!panel) return;
  delete panel.dataset.dragging;
  delete panel.dataset.dragSettled;
  panel.style.removeProperty('--mobile-sheet-drag');
}

export function installMobileSheetDrag({
  panel,
  handle,
  onClose,
  threshold = 64,
  enabled = () => true,
} = {}) {
  let pointer;
  const stopTracking = () => {
    window.removeEventListener('pointermove', pointerMove);
    window.removeEventListener('pointerup', finish);
    window.removeEventListener('pointercancel', finish);
  };
  const pointerDown = (event) => {
    if (!enabled()) return;
    pointer = { id: event.pointerId, startY: event.clientY, distance: 0 };
    try {
      handle.setPointerCapture?.(event.pointerId);
    } catch {
      // Some embedded WebViews expose pointer capture but reject it. Window
      // listeners below keep the gesture working in that case.
    }
    panel.dataset.dragging = 'true';
    window.addEventListener('pointermove', pointerMove);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  };
  const pointerMove = (event) => {
    if (!pointer || event.pointerId !== pointer.id) return;
    pointer.distance = Math.max(0, event.clientY - pointer.startY);
    panel.style.setProperty('--mobile-sheet-drag', `${pointer.distance}px`);
  };
  const finish = (event) => {
    if (!pointer || event.pointerId !== pointer.id) return;
    // Pointer capture can coalesce or skip the last move on mobile Safari.
    // Include the release position so a completed swipe still dismisses.
    pointer.distance = Math.max(pointer.distance, Math.max(0, event.clientY - pointer.startY));
    const shouldClose = pointer.distance > threshold;
    pointer = undefined;
    stopTracking();
    panel.dataset.dragSettled = 'true';
    delete panel.dataset.dragging;
    if (shouldClose) onClose?.();
    else panel.style.removeProperty('--mobile-sheet-drag');
  };
  handle.addEventListener('pointerdown', pointerDown);
  return () => {
    stopTracking();
    handle.removeEventListener('pointerdown', pointerDown);
  };
}
