import { createReadStream } from 'node:fs';
import { readProjectFile, searchProjectFiles } from '../conversations/files.js';
import { maxAttachmentChunkBytes } from '../conversations/attachments.js';
import { json, readBytes } from './http.js';

function attachmentView(sessionName, attachment) {
  return {
    id: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    size: attachment.size,
    previewUrl: `/api/conversations/${encodeURIComponent(sessionName)}/attachments/${attachment.id}`,
  };
}

export function createConversationFileRouteHandler({ conversationSession, attachments }) {
  return async function handleConversationFileRoute({ request, response, url, pathname }) {
    const completionMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/completions\/files$/);
    if (request.method === 'GET' && completionMatch) {
      const query = url.searchParams.get('q') || '';
      if (query.length > 160) {
        json(response, 400, { error: 'q must be under 160 characters' });
        return true;
      }
      const session = await conversationSession(decodeURIComponent(completionMatch[1]));
      if (!session) json(response, 404, { error: 'Managed session not found' });
      else json(response, 200, { files: await searchProjectFiles(session.cwd, query) });
      return true;
    }

    const previewMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/files$/);
    if (request.method === 'GET' && previewMatch) {
      const session = await conversationSession(decodeURIComponent(previewMatch[1]));
      if (!session) {
        json(response, 404, { error: 'Managed session not found' });
        return true;
      }
      try { json(response, 200, { file: await readProjectFile(session.cwd, url.searchParams.get('path') || '') }); }
      catch (error) {
        if (error?.code === 'FILE_MENTION_INVALID') json(response, 400, { error: 'File path must stay inside the project' });
        else if (error?.code === 'ENOENT') json(response, 404, { error: 'File not found' });
        else if (error?.code === 'FILE_PREVIEW_TOO_LARGE') json(response, 413, { error: error.message });
        else if (error?.code === 'FILE_PREVIEW_BINARY') json(response, 415, { error: error.message });
        else throw error;
      }
      return true;
    }

    const uploadMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/attachments$/);
    if (request.method === 'POST' && uploadMatch) {
      const session = await conversationSession(decodeURIComponent(uploadMatch[1]));
      if (!session) {
        json(response, 404, { error: 'Managed session not found' });
        return true;
      }
      const encodedName = request.headers['x-file-name'];
      if (typeof encodedName !== 'string' || encodedName.length > 720) {
        json(response, 400, { error: 'x-file-name header is required' });
        return true;
      }
      let fileName;
      try { fileName = decodeURIComponent(encodedName); }
      catch {
        json(response, 400, { error: 'x-file-name must be URI encoded' });
        return true;
      }
      const uploadId = request.headers['x-upload-id'];
      if (uploadId !== undefined) {
        const offsetValue = request.headers['x-upload-offset'];
        const totalValue = request.headers['x-upload-total'];
        if (typeof uploadId !== 'string' || typeof offsetValue !== 'string' ||
            typeof totalValue !== 'string' || !/^\d+$/.test(offsetValue) || !/^\d+$/.test(totalValue)) {
          json(response, 400, { error: 'Chunk upload headers are invalid', code: 'ATTACHMENT_UPLOAD_INVALID' });
          return true;
        }
        const offset = Number(offsetValue);
        const totalBytes = Number(totalValue);
        if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(totalBytes)) {
          json(response, 400, { error: 'Chunk upload sizes are invalid', code: 'ATTACHMENT_UPLOAD_INVALID' });
          return true;
        }
        try {
          const data = await readBytes(request, maxAttachmentChunkBytes);
          const result = await attachments.appendUploadChunk(session.name, {
            uploadId,
            name: fileName,
            mimeType: request.headers['content-type'],
            offset,
            totalBytes,
            data,
          });
          if (!result.complete) json(response, 202, { nextOffset: result.nextOffset });
          else json(response, 201, {
            nextOffset: result.nextOffset,
            attachment: attachmentView(session.name, result.attachment),
          });
        } catch (error) {
          const status = error?.status || (['ATTACHMENT_UPLOAD_OFFSET', 'ATTACHMENT_UPLOAD_MISMATCH'].includes(error?.code)
            ? 409
            : 400);
          json(response, status, {
            error: error.message,
            ...(error?.code ? { code: error.code } : {}),
            ...(Number.isSafeInteger(error?.nextOffset) ? { nextOffset: error.nextOffset } : {}),
          });
        }
        return true;
      }
      try {
        const attachment = await attachments.save(session.name, {
          name: fileName,
          mimeType: request.headers['content-type'],
          data: await readBytes(request),
        });
        json(response, 201, { attachment: attachmentView(session.name, attachment) });
      } catch (error) {
        json(response, error?.status || 400, {
          error: error.message,
          ...(error?.code ? { code: error.code } : {}),
        });
      }
      return true;
    }

    const abortMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/attachments\/([0-9a-f-]{36})\/upload$/i);
    if (request.method === 'DELETE' && abortMatch) {
      const session = await conversationSession(decodeURIComponent(abortMatch[1]));
      if (!session) json(response, 404, { error: 'Managed session not found' });
      else {
        const aborted = await attachments.abortUpload(session.name, abortMatch[2]);
        json(response, aborted ? 200 : 404, { aborted });
      }
      return true;
    }

    const viewMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/attachments\/([0-9a-f-]{36})$/i);
    if (request.method === 'GET' && viewMatch) {
      const attachment = attachments.get(decodeURIComponent(viewMatch[1]), viewMatch[2]);
      if (!attachment) json(response, 404, { error: 'Attachment not found' });
      else {
        response.writeHead(200, {
          'content-type': attachment.mimeType,
          'content-length': attachment.size,
          'cache-control': 'private, no-store',
          'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'none'; sandbox",
          'content-disposition': `${/^image\/(?:png|jpeg|webp|gif)$/.test(attachment.mimeType) ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(attachment.name)}`,
        });
        createReadStream(attachment.path).pipe(response);
      }
      return true;
    }
    return false;
  };
}
