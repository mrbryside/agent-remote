import { resolveProjectFiles } from '../conversations/files.js';
import { compactConversationStreamEvent } from './conversation-stream.js';
import { json, readJson } from './http.js';

const inputRequestRetentionMs = 15 * 60_000;
const maxRememberedInputRequests = 1_000;

function conversationOptions(url) {
  const threadId = url.searchParams.get('thread') || undefined;
  const historyLimitValue = url.searchParams.get('historyLimit');
  const requested = Number(historyLimitValue);
  const historyLimit = historyLimitValue !== null && Number.isInteger(requested)
    ? Math.max(20, Math.min(5_000, requested))
    : undefined;
  return { threadId, ...(historyLimit ? { historyLimit } : {}) };
}

function attachmentView(sessionName, attachment) {
  return {
    id: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    size: attachment.size,
    previewUrl: `/api/conversations/${encodeURIComponent(sessionName)}/attachments/${attachment.id}`,
  };
}

export function createConversationMessageRouteHandler({
  conversationSession,
  registry,
  attachments,
  deliverInput,
  inputRequests,
  streams,
  remoteGateway,
  conversationFailure,
  reserveTransport,
}) {
  async function handleInput(request, response, encodedName) {
    const body = await readJson(request);
    if (typeof body.text !== 'string' || Buffer.byteLength(body.text, 'utf8') > 64 * 1024) {
      json(response, 400, { error: 'text must be a string under 64 KiB' });
      return;
    }
    if (body.id !== undefined && (typeof body.id !== 'string' || body.id.length > 80)) {
      json(response, 400, { error: 'id must be a string under 80 characters' });
      return;
    }
    const session = await conversationSession(decodeURIComponent(encodedName));
    if (!session) {
      json(response, 404, { error: 'Managed session not found' });
      return;
    }
    if (body.attachmentIds !== undefined && (!Array.isArray(body.attachmentIds) ||
        body.attachmentIds.length > 8 || body.attachmentIds.some((id) =>
          typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)))) {
      json(response, 400, { error: 'attachmentIds must contain at most 8 attachment ids' });
      return;
    }
    const attachmentIds = body.attachmentIds || [];
    const resolvedAttachments = attachments.resolve(session.name, attachmentIds);
    if (resolvedAttachments.length !== attachmentIds.length) {
      json(response, 404, { error: 'Attachment not found for this session' });
      return;
    }
    if (!body.text.trim() && resolvedAttachments.length === 0) {
      json(response, 400, { error: 'Message or attachment is required' });
      return;
    }
    if (body.fileMentions !== undefined && (!Array.isArray(body.fileMentions) ||
        body.fileMentions.length > 16 || body.fileMentions.some((path) =>
          typeof path !== 'string' || !path || path.length > 1024))) {
      json(response, 400, { error: 'fileMentions must contain at most 16 project-relative paths' });
      return;
    }
    let mentionedFiles;
    try { mentionedFiles = await resolveProjectFiles(session.cwd, body.fileMentions || []); }
    catch (error) {
      if (error?.code === 'FILE_MENTION_INVALID' || error?.code === 'ENOENT') {
        json(response, 400, { error: 'A mentioned file is outside the project or no longer exists' });
        return;
      }
      throw error;
    }
    const attachmentText = resolvedAttachments.map((attachment) =>
      `${attachment.mimeType.startsWith('image/') ? '!' : ''}[${attachment.name}](${attachment.path})`).join('\n');
    const mentionedText = mentionedFiles.map((file) => `[${file.path}](${file.absolutePath})`).join('\n');
    const promptText = [body.text.trim(), attachmentText, mentionedText].filter(Boolean).join('\n\n');
    const displayText = body.text.trim() || resolvedAttachments.map((attachment) => attachment.name).join(', ');
    const requestKey = body.id ? `${session.name}:${body.id}` : undefined;
    const existing = requestKey ? inputRequests.get(requestKey) : undefined;
    const signature = JSON.stringify({
      text: body.text,
      attachmentIds,
      fileMentions: body.fileMentions || [],
    });
    if (existing && existing.signature !== signature) {
      json(response, 409, { error: 'Input id was already used for different text' });
      return;
    }
    let delivery = existing?.delivery;
    if (!delivery) {
      delivery = deliverInput(session, promptText, {
        id: body.id,
        displayText,
        attachments: resolvedAttachments.map((attachment) => attachmentView(session.name, attachment)),
      });
      if (requestKey) {
        while (inputRequests.size >= maxRememberedInputRequests) {
          inputRequests.delete(inputRequests.keys().next().value);
        }
        inputRequests.set(requestKey, { signature, delivery });
        // Mobile browsers can suspend a tab long enough to miss the delivery
        // reconciliation window. Retain the original promise so retrying the
        // same request id remains idempotent after a background/foreground cycle.
        const forget = setTimeout(() => inputRequests.delete(requestKey), inputRequestRetentionMs);
        forget.unref?.();
        delivery.catch(() => {
          clearTimeout(forget);
          if (inputRequests.get(requestKey)?.delivery === delivery) inputRequests.delete(requestKey);
        });
      }
    }
    try { json(response, 202, { accepted: true, id: body.id, ...(await delivery) }); }
    catch (error) { conversationFailure(response, error); }
  }

  async function handleStream({ request, response, url, surface, encodedName }) {
    const name = decodeURIComponent(encodedName);
    const session = await conversationSession(name);
    if (!session) {
      json(response, 404, { error: 'Managed session not found' });
      return;
    }
    const options = conversationOptions(url);
    let initial;
    try { initial = await registry.read(session, options); }
    catch (error) {
      conversationFailure(response, error);
      return;
    }
    if (!initial) {
      json(response, 404, {
        error: 'No mobile conversation provider is available for this session',
        code: 'CONVERSATION_UNAVAILABLE',
      });
      return;
    }
    const releaseTransport = reserveTransport?.();
    if (!releaseTransport) {
      json(response, 503, { error: 'Too many live streams' });
      return;
    }
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-content-type-options': 'nosniff',
    });
    response.flushHeaders?.();
    response.socket?.setNoDelay?.(true);
    response.write(`:${' '.repeat(2_048)}\nretry: 1000\n\n`);
    let stopWatching = async () => {};
    let untrackRemoteStream = () => {};
    let closed = false;
    let streamedItemKey;
    const close = async () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      streams.delete(close);
      releaseTransport();
      untrackRemoteStream();
      await stopWatching();
      if (!response.writableEnded) response.end();
    };
    close.sessionName = name;
    close.sendControl = (control) => {
      if (!closed && !response.writableEnded) {
        response.write(`event: control\ndata: ${JSON.stringify(control)}\n\n`);
      }
    };
    const heartbeat = setInterval(() => {
      if (!response.writableEnded) {
        response.write(`event: heartbeat\ndata: ${Date.now()}\n\n`);
        response.flush?.();
      }
    }, 3_000);
    heartbeat.unref?.();
    streams.add(close);
    if (surface === 'remote') untrackRemoteStream = remoteGateway.trackStream(close, request);
    response.once('close', () => void close());
    try {
      stopWatching = await registry.watch(session, options, (event) => {
        if (closed || response.writableEnded) return;
        const compacted = compactConversationStreamEvent(event, streamedItemKey);
        streamedItemKey = compacted.streamKey;
        const outgoing = compacted.outgoing;
        response.write(`event: conversation\ndata: ${JSON.stringify(outgoing)}\n\n`);
        response.flush?.();
      });
      if (closed) await stopWatching();
    } catch (error) {
      if (!closed) response.write(`event: error\ndata: ${JSON.stringify({ error: error.message })}\n\n`);
      await close();
    }
  }

  return async function handleConversationMessageRoute({ request, response, url, surface, pathname }) {
    const inputMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/input$/);
    if (request.method === 'POST' && inputMatch) {
      await handleInput(request, response, inputMatch[1]);
      return true;
    }
    const streamMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/stream$/);
    if (request.method === 'GET' && streamMatch) {
      await handleStream({ request, response, url, surface, encodedName: streamMatch[1] });
      return true;
    }
    const readMatch = pathname.match(/^\/api\/conversations\/([^/]+)$/);
    if (request.method === 'GET' && readMatch) {
      const session = await conversationSession(decodeURIComponent(readMatch[1]));
      if (!session) json(response, 404, { error: 'Managed session not found' });
      else {
        let conversation;
        try { conversation = await registry.read(session, conversationOptions(url)); }
        catch (error) {
          conversationFailure(response, error);
          return true;
        }
        json(response, conversation ? 200 : 404, conversation
          ? { conversation }
          : {
              error: 'No mobile conversation provider is available for this session',
              code: 'CONVERSATION_UNAVAILABLE',
            });
      }
      return true;
    }
    return false;
  };
}
