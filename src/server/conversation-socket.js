import { WebSocket } from 'ws';

export function installConversationSocket({
  conversationWss, conversationStreams, remoteDeviceSockets, remoteGateway,
  conversationSession, conversationRegistry,
}) {
  conversationWss.on('connection', async (socket, request) => {
    const requestUrl = new URL(request.url, 'http://localhost');
    const name = requestUrl.searchParams.get('session');
    const threadId = requestUrl.searchParams.get('thread') || undefined;
    const historyLimitValue = requestUrl.searchParams.get('historyLimit');
    const requestedHistoryLimit = Number(historyLimitValue);
    const historyLimit = historyLimitValue !== null && Number.isInteger(requestedHistoryLimit)
      ? Math.max(20, Math.min(5_000, requestedHistoryLimit)) : undefined;
    const conversationOptions = { threadId, ...(historyLimit ? { historyLimit } : {}) };
    if (!name || name.length > 64 || !threadId || threadId.length > 128) {
      socket.close(1008, 'Invalid conversation stream');
      return;
    }
    if (request.remoteDeviceId) {
      let sockets = remoteDeviceSockets.get(request.remoteDeviceId);
      if (!sockets) {
        sockets = new Set();
        remoteDeviceSockets.set(request.remoteDeviceId, sockets);
      }
      sockets.add(socket);
      const removeRemoteSocket = () => {
        sockets.delete(socket);
        if (sockets.size === 0) remoteDeviceSockets.delete(request.remoteDeviceId);
      };
      socket.once('close', removeRemoteSocket);
      socket.once('error', removeRemoteSocket);
      remoteGateway.trackSocket(socket, request);
    }

    let stopWatching = async () => {};
    let closed = false;
    let streamedMessageId;
    const send = (message) => {
      if (!closed && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    };
    const close = async (force = false) => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      conversationStreams.delete(close);
      await stopWatching();
      if (force && socket.readyState < WebSocket.CLOSING) socket.terminate();
    };
    close.sessionName = name;
    close.sendControl = send;
    const heartbeat = setInterval(() => send({ type: 'heartbeat', at: Date.now() }), 3_000);
    heartbeat.unref?.();
    conversationStreams.add(close);
    socket.once('close', () => void close());
    socket.once('error', () => void close());

    try {
      const session = await conversationSession(name);
      if (!session) {
        socket.close(1008, 'Managed session not found');
        await close();
        return;
      }
      // Provider watch publishes an authoritative initial snapshot before it
      // resolves. Avoid a separate read here: mobile already paints its LRU
      // snapshot immediately, and an uncached first visit performed the HTTP
      // readiness read before opening this socket.
      stopWatching = await conversationRegistry.watch(session, conversationOptions, (event) => {
        let outgoing = event;
        if (event.stream?.kind === 'agent_message_chunk') {
          const message = [...(event.conversation?.items || [])].reverse().find(
            (item) => item.type === 'message' && item.role === 'assistant',
          );
          const stream = {
            ...event.stream,
            threadId: event.conversation?.thread?.id,
            messageId: message?.id,
          };
          outgoing = message?.id && streamedMessageId === message.id
            ? { stream }
            : { ...event, stream };
          streamedMessageId = message?.id;
        } else {
          streamedMessageId = undefined;
        }
        send({ type: 'conversation', ...outgoing });
      });
      if (closed) await stopWatching();
    } catch (error) {
      send({ type: 'error', error: error.message || 'Conversation stream failed' });
      if (socket.readyState < WebSocket.CLOSING) socket.close(1011, 'Conversation stream failed');
      await close();
    }
  });

}

