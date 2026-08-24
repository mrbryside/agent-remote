export function createCompactStreamBatcher({
  requestFrame, cancelFrame, onFlush, onIdle = () => {}, maxBreaks = 4, maxChars = 1024,
}) {
  let frame;
  let pending;

  function flush() {
    if (frame !== undefined) cancelFrame(frame);
    frame = undefined;
    if (!pending) return;
    let length = Math.min(pending.delta.length, maxChars);
    let breaks = 0;
    for (let index = 0; index < length; index += 1) {
      if (pending.delta[index] !== '\n') continue;
      breaks += 1;
      if (breaks >= maxBreaks) {
        length = index + 1;
        break;
      }
    }
    const stream = { ...pending, delta: pending.delta.slice(0, length) };
    pending.delta = pending.delta.slice(length);
    onFlush(stream);
    if (pending.delta) frame = requestFrame(flush);
    else {
      pending = undefined;
      onIdle();
    }
  }

  function push(stream) {
    if (!stream) return;
    if (pending && pending.threadId === stream.threadId && pending.messageId === stream.messageId) {
      pending.delta += stream.delta || '';
    } else {
      if (pending) {
        if (frame !== undefined) cancelFrame(frame);
        frame = undefined;
        onFlush(pending);
        pending = undefined;
      }
      pending = { ...stream, delta: stream.delta || '' };
    }
    if (frame === undefined) frame = requestFrame(flush);
  }

  function discard() {
    if (frame !== undefined) cancelFrame(frame);
    frame = undefined;
    pending = undefined;
  }

  return { discard, flush, hasPending: () => Boolean(pending), push };
}

function activeAssistant(conversation) {
  if (conversation?.activity?.active !== true) return undefined;
  return [...(conversation.items || [])].reverse().find(
    (item) => item.type === 'message' && item.role === 'assistant',
  );
}

export function preserveNewerStreamingText(previous, incoming, compactMessageId) {
  if (previous?.thread?.id !== incoming?.thread?.id) return incoming;
  const current = activeAssistant(previous);
  const next = activeAssistant(incoming);
  if (!current || !next || current.id !== next.id || typeof current.text !== 'string' ||
      typeof next.text !== 'string' ||
      (current.id !== compactMessageId && next.text.startsWith(current.text))) return incoming;
  return {
    ...incoming,
    items: incoming.items.map((item) => item.id === next.id ? { ...item, text: current.text } : item),
  };
}
