import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';

const maxAttachmentBytes = 20 * 1024 * 1024;
const safeExtension = /^\.[a-z0-9]{1,10}$/i;

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
  createTempDir = () => mkdtemp(join(tmpdir(), 'agent-remote-uploads-')),
  write = writeFile,
  remove = rm,
  maxBytes = maxAttachmentBytes,
} = {}) {
  const records = new Map();
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

  function get(sessionName, id) {
    const record = records.get(id);
    return record?.sessionName === sessionName ? record : undefined;
  }

  function resolve(sessionName, ids) {
    return ids.map((id) => get(sessionName, id)).filter(Boolean);
  }

  async function close() {
    records.clear();
    if (!ownedRoot) return;
    const target = ownedRoot;
    ownedRoot = undefined;
    rootPromise = undefined;
    await remove(target, { recursive: true, force: true });
  }

  return { save, get, resolve, close, maxBytes };
}

export { maxAttachmentBytes };
