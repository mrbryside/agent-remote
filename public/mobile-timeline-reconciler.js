function timelineNodeKey(node) {
  if (node.nodeType !== Node.ELEMENT_NODE) return undefined;
  if (node.matches('.mobile-tool-group')) return `group:${node.dataset.eventId}`;
  if (node.matches('.mobile-event-card')) return `event:${node.dataset.eventId}`;
  if (node.matches('.mobile-message')) return node.dataset.pending ? undefined : `message:${node.dataset.messageId}`;
  if (node.matches('.mobile-question-card')) return `question:${node.dataset.questionId}`;
  if (node.matches('.mobile-conversation-empty')) return 'conversation:empty';
  if (node.matches('.mobile-conversation-loading')) return 'loading';
  if (node.matches('.mobile-history-earlier')) return 'history:earlier';
  return undefined;
}

function syncAttributes(current, fresh) {
  const preserve = current.hasAttribute('data-disclosure-motion')
    ? new Set(['hidden', 'inert', 'aria-hidden', 'data-disclosure-motion'])
    : undefined;
  for (const attribute of [...current.attributes]) {
    if (!preserve?.has(attribute.name) && !fresh.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
  }
  for (const attribute of [...fresh.attributes]) {
    if (!preserve?.has(attribute.name) && current.getAttribute(attribute.name) !== attribute.value) {
      current.setAttribute(attribute.name, attribute.value);
    }
  }
}

function syncEventCard(current, fresh) {
  syncAttributes(current, fresh);
  const currentToggle = current.querySelector(':scope > .mobile-event-toggle');
  const freshToggle = fresh.querySelector(':scope > .mobile-event-toggle');
  const currentPanel = current.querySelector(':scope > .mobile-event-panel');
  const freshPanel = fresh.querySelector(':scope > .mobile-event-panel');
  if (!currentToggle || !freshToggle || !currentPanel || !freshPanel) {
    current.replaceChildren(...fresh.childNodes);
    return current;
  }
  const freshExtras = [...fresh.children].filter((child) => child !== freshToggle && child !== freshPanel);
  syncAttributes(currentToggle, freshToggle);
  currentToggle.replaceChildren(...freshToggle.childNodes);
  syncAttributes(currentPanel, freshPanel);
  currentPanel.replaceChildren(...freshPanel.childNodes);
  for (const child of [...current.children]) {
    if (child !== currentToggle && child !== currentPanel) child.remove();
  }
  for (const child of freshExtras) current.append(child);
  return current;
}

export function createTimelineReconciler({ appendStreamingMarkdown, morphStreamingMarkdown }) {
  function reconcile(container, freshNodes) {
    const currentByKey = new Map();
    for (const node of [...container.children]) {
      const key = timelineNodeKey(node);
      if (key) currentByKey.set(key, node);
    }
    const kept = new Set();
    let cursor = container.firstChild;
    for (const fresh of freshNodes) {
      const key = timelineNodeKey(fresh);
      const current = key ? currentByKey.get(key) : undefined;
      let node = fresh;
      if (current && fresh.__mobileItemSignature !== undefined &&
          current.__mobileItemSignature === fresh.__mobileItemSignature) {
        node = current;
      } else if (current?.matches('.mobile-tool-group') && fresh.matches('.mobile-tool-group')) {
        syncAttributes(current, fresh);
        const currentToggle = current.querySelector(':scope > .mobile-tool-group-toggle');
        const freshToggle = fresh.querySelector(':scope > .mobile-tool-group-toggle');
        const currentPanel = current.querySelector(':scope > .mobile-tool-group-panel');
        const freshPanel = fresh.querySelector(':scope > .mobile-tool-group-panel');
        if (currentToggle && freshToggle && currentPanel && freshPanel) {
          syncAttributes(currentToggle, freshToggle);
          if (currentToggle.textContent !== freshToggle.textContent) {
            currentToggle.replaceChildren(...freshToggle.childNodes);
          }
          syncAttributes(currentPanel, freshPanel);
          reconcile(currentPanel, [...freshPanel.children]);
          node = current;
        }
      } else if (current?.matches('.mobile-event-card') && fresh.matches('.mobile-event-card')) {
        node = syncEventCard(current, fresh);
      } else if (current?.matches('.mobile-message') && fresh.matches('.mobile-message')) {
        syncAttributes(current, fresh);
        const currentContent = current.querySelector(':scope > .mobile-message-content[data-streaming="true"]');
        const freshContent = fresh.querySelector(':scope > .mobile-message-content[data-streaming="true"]');
        const settledContent = fresh.querySelector(':scope > .mobile-message-content:not([data-streaming="true"])');
        const previousText = currentContent?.__mobileRawText;
        const nextText = freshContent?.__mobileRawText;
        if (currentContent && freshContent && typeof previousText === 'string' &&
            typeof nextText === 'string' && nextText.startsWith(previousText)) {
          appendStreamingMarkdown(currentContent, nextText);
        } else if (currentContent && settledContent) {
          morphStreamingMarkdown(currentContent, settledContent, { streaming: false });
        } else {
          current.replaceChildren(...fresh.childNodes);
        }
        node = current;
      }
      if (node === current) node.__mobileItemSignature = fresh.__mobileItemSignature;
      kept.add(node);
      if (node === cursor) cursor = cursor.nextSibling;
      else container.insertBefore(node, cursor);
    }
    for (const child of [...container.childNodes]) {
      if (!kept.has(child)) child.remove();
    }
  }

  return reconcile;
}
