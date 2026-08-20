import assert from 'node:assert/strict';
import test from 'node:test';
import { createConversationAttachmentStore } from '../src/conversations/attachments.js';

test('conversation attachments are private to one session and removed with the owned temp root', async () => {
  const writes = [];
  const removals = [];
  const store = createConversationAttachmentStore({
    createTempDir: async () => '/tmp/agent-remote-owned-test',
    write: async (...args) => writes.push(args),
    remove: async (...args) => removals.push(args),
  });
  const attachment = await store.save('chat-one', {
    name: '../screen shot.PNG', mimeType: 'image/png', data: Buffer.from('image'),
  });
  assert.equal(attachment.name, '.._screen shot.PNG');
  assert.match(attachment.path, /^\/tmp\/agent-remote-owned-test\/[0-9a-f-]{36}\.png$/);
  assert.equal(writes[0][2].mode, 0o600);
  assert.equal(store.get('chat-two', attachment.id), undefined);
  assert.equal(store.resolve('chat-one', [attachment.id])[0].path, attachment.path);
  await store.close();
  assert.deepEqual(removals, [['/tmp/agent-remote-owned-test', { recursive: true, force: true }]]);
});

test('conversation attachment limits reject empty and oversized payloads', async () => {
  const store = createConversationAttachmentStore({ maxBytes: 4 });
  await assert.rejects(store.save('chat', { name: 'a.txt', data: Buffer.alloc(0) }), {
    code: 'ATTACHMENT_SIZE_INVALID',
  });
  await assert.rejects(store.save('chat', { name: 'a.txt', data: Buffer.alloc(5) }), {
    code: 'ATTACHMENT_SIZE_INVALID',
  });
});

test('chunked attachments can exceed the legacy single-request limit without buffering the whole file', async () => {
  const writes = [];
  const appends = [];
  const store = createConversationAttachmentStore({
    createTempDir: async () => '/tmp/agent-remote-chunk-test',
    write: async (...args) => writes.push(args),
    append: async (...args) => appends.push(args),
    remove: async () => {},
    maxBytes: 4,
    maxChunkBytes: 3,
  });
  const uploadId = '11111111-1111-4111-8111-111111111111';
  const first = await store.appendUploadChunk('chat', {
    uploadId, name: 'recording.MOV', mimeType: 'video/quicktime',
    offset: 0, totalBytes: 5, data: Buffer.from('abc'),
  });
  assert.deepEqual(first, { complete: false, nextOffset: 3 });
  await assert.rejects(store.appendUploadChunk('chat', {
    uploadId, name: 'recording.MOV', mimeType: 'video/quicktime',
    offset: 0, totalBytes: 5, data: Buffer.from('abc'),
  }), (error) => error.code === 'ATTACHMENT_UPLOAD_OFFSET' && error.nextOffset === 3);
  const finished = await store.appendUploadChunk('chat', {
    uploadId, name: 'recording.MOV', mimeType: 'video/quicktime',
    offset: 3, totalBytes: 5, data: Buffer.from('de'),
  });
  assert.equal(finished.complete, true);
  assert.equal(finished.attachment.size, 5);
  assert.equal(finished.attachment.mimeType, 'video/quicktime');
  const repeatedFinal = await store.appendUploadChunk('chat', {
    uploadId, name: 'recording.MOV', mimeType: 'video/quicktime',
    offset: 3, totalBytes: 5, data: Buffer.from('de'),
  });
  assert.equal(repeatedFinal.complete, true);
  assert.equal(repeatedFinal.nextOffset, 5);
  assert.equal(store.get('chat', uploadId).path, '/tmp/agent-remote-chunk-test/11111111-1111-4111-8111-111111111111.mov');
  assert.equal(writes.length, 1);
  assert.deepEqual(appends.map(([, data]) => data.toString()), ['abc', 'de']);
  await store.close();
});
