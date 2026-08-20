import { randomUUID } from 'node:crypto';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';

const maxAttachmentBytes = 20 * 1024 * 1024;
const maxAttachmentChunkBytes = 4 * 1024 * 1024;
const safeExtension = /^\.[a-z0-9]{1,10}$/i;
const uploadIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function cleanName(value) {
  const name = String(value || 'attachment').replace(/[\x00-\x1f\x7f/\\:]+/g, '_').trim();
  return (name || 'attachment').slice(0, 180);
}

function cleanMime(value) {
  const mime = String(value || 'application/octet-stream').split(';', 1)[0].trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime)
    ? mime : 'application/octet-stream';
}

export function createConversationAttachmentStore({
  createTempDir = () => mkdtemp(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'agent-remote-uploads-')),
  write = writeFile,
  append = appendFile,
  remove = rm,
  maxBytes = maxAttachmentBytes,
  maxChunkBytes = maxAttachmentChunkBytes,
} = {}) {
  const records = new Map();
  const uploads = new Map();
  let rootPromise;
  let ownedRoot;

  async function root() {
    if (!rootPromise) rootPromise = Promise.resolve(createTempDir()).then((value) => {
      ownedRoot = value;
      return value;
    });
    return rootPromise;
  }

  async function save(sessionName, { name, mimeType, data }) {
    if (!Buffer.isBuffer(data) || data.length === 0 || data.length > maxBytes) {
      const error = new Error(`Attachment must be between 1 byte and ${maxBytes} bytes`);
      error.code = 'ATTACHMENT_SIZE_INVALID';
      throw error;
    }
    const id = randomUUID();
    const displayName = cleanName(name);
    const extension = extname(displayName);
    const path = join(await root(), `${id}${safeExtension.test(extension) ? extension.toLowerCase() : ''}`);
    await write(path, data, { mode: 0o600, flag: 'wx' });
    const record = {
      id, sessionName, name: displayName, mimeType: cleanMime(mimeType),
      size: data.length, path, createdAt: Date.now(),
    };
    records.set(id, record);
    return record;
  }

  async function appendUploadChunk(sessionName, {
    uploadId, name, mimeType, offset, totalBytes, data,
  }) {
    if (!uploadIdPattern.test(uploadId || '')) {
      const error = new Error('Upload id must be a UUID');
      error.code = 'ATTACHMENT_UPLOAD_INVALID';
      throw error;
    }
    if (!Number.isSafeInteger(offset) || offset < 0 ||
        !Number.isSafeInteger(totalBytes) || totalBytes < 1 || offset >= totalBytes ||
        !Buffer.isBuffer(data) || data.length < 1 || data.length > maxChunkBytes ||
        offset + data.length > totalBytes) {
      const error = new Error(`Attachment chunks must be between 1 byte and ${maxChunkBytes} bytes`);
      error.code = 'ATTACHMENT_CHUNK_INVALID';
      throw error;
    }

    const displayName = cleanName(name);
    const cleanedMimeType = cleanMime(mimeType);
    let upload = uploads.get(uploadId);
    if (!upload) {
      const completed = records.get(uploadId);
      if (completed?.sessionName === sessionName && completed.name === displayName &&
          completed.mimeType === cleanedMimeType && completed.size === totalBytes &&
          offset + data.length === completed.size) {
        return { complete: true, nextOffset: completed.size, attachment: completed };
      }
      if (offset !== 0 || records.has(uploadId)) {
        const error = new Error('Upload must begin at offset 0');
        error.code = 'ATTACHMENT_UPLOAD_OFFSET';
        error.nextOffset = completed?.sessionName === sessionName ? completed.size : undefined;
        throw error;
      }
      const extension = extname(displayName);
      const path = join(await root(), `${uploadId}${safeExtension.test(extension) ? extension.toLowerCase() : ''}`);
      await write(path, Buffer.alloc(0), { mode: 0o600, flag: 'wx' });
      upload = {
        id: uploadId, sessionName, name: displayName, mimeType: cleanedMimeType,
        size: 0, totalBytes, path, createdAt: Date.now(),
      };
      uploads.set(uploadId, upload);
    }
    if (upload.sessionName !== sessionName || upload.name !== displayName ||
        upload.mimeType !== cleanedMimeType || upload.totalBytes !== totalBytes) {
      const error = new Error('Upload metadata changed between chunks');
      error.code = 'ATTACHMENT_UPLOAD_MISMATCH';
      throw error;
    }
    if (upload.size !== offset) {
      const error = new Error(`Upload expected offset ${upload.size}`);
      error.code = 'ATTACHMENT_UPLOAD_OFFSET';
      error.nextOffset = upload.size;
      throw error;
    }

    await append(upload.path, data);
    upload.size += data.length;
    if (upload.size !== totalBytes) return { complete: false, nextOffset: upload.size };

    uploads.delete(uploadId);
    const record = { ...upload };
    delete record.totalBytes;
    records.set(record.id, record);
    return { complete: true, nextOffset: record.size, attachment: record };
  }

  async function abortUpload(sessionName, uploadId) {
    const upload = uploads.get(uploadId);
    if (!upload || upload.sessionName !== sessionName) return false;
    uploads.delete(uploadId);
    await remove(upload.path, { force: true });
    return true;
  }

  function get(sessionName, id) {
    const record = records.get(id);
    return record?.sessionName === sessionName ? record : undefined;
  }

  function resolve(sessionName, ids) {
    return ids.map((id) => get(sessionName, id)).filter(Boolean);
  }

  async function close() {
    records.clear();
    uploads.clear();
    if (!ownedRoot) return;
    const target = ownedRoot;
    ownedRoot = undefined;
    rootPromise = undefined;
    await remove(target, { recursive: true, force: true });
  }

  return { save, appendUploadChunk, abortUpload, get, resolve, close, maxBytes, maxChunkBytes };
}

export { maxAttachmentBytes, maxAttachmentChunkBytes };
