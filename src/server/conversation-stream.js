const compactStreamKinds = new Set(['agent_message_chunk', 'agent_thought_chunk']);

function streamItem(conversation, kind) {
  const items = conversation?.items || [];
  if (kind === 'agent_message_chunk') {
    return [...items].reverse().find((item) => item.type === 'message' && item.role === 'assistant');
  }
  if (kind === 'agent_thought_chunk') {
    return [...items].reverse().find((item) => item.type === 'thought');
  }
  return undefined;
}

export function compactConversationStreamEvent(event, previousStreamKey) {
  const kind = event.stream?.kind;
  if (!compactStreamKinds.has(kind)) return { outgoing: event, streamKey: undefined };
  const item = streamItem(event.conversation, kind);
  const threadId = event.conversation?.thread?.id;
  const itemId = item?.id;
  const stream = {
    ...event.stream,
    threadId,
    itemId,
    ...(kind === 'agent_message_chunk' ? { messageId: itemId } : {}),
  };
  const streamKey = threadId && itemId ? `${kind}:${threadId}:${itemId}` : undefined;
  return {
    outgoing: streamKey && streamKey === previousStreamKey ? { stream } : { ...event, stream },
    streamKey,
  };
}
