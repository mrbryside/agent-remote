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
