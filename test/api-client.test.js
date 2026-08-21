import assert from 'node:assert/strict';
import test from 'node:test';

import { createAuthenticatedFetch } from '../public/api-client.js';

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('silently recovers a remote session and retries the original request body once', async () => {
  const calls = [];
  let recovered = false;
  const body = new Blob(['image-chunk'], { type: 'image/png' });
  const authenticatedFetch = createAuthenticatedFetch({
    fetchFn: async (input, options) => {
      calls.push({ input: String(input), options });
      return recovered
        ? jsonResponse({ uploaded: true })
        : jsonResponse({ error: 'Unauthorized', code: 'REMOTE_UNAUTHORIZED' }, 401);
    },
    recoverSession: async () => { recovered = true; },
  });

  const response = await authenticatedFetch('/api/conversations/chat/attachments', {
    method: 'POST', body,
  });

  assert.equal(response.status, 200);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.body, body);
  assert.equal(calls[1].options.body, body);
  assert.equal(calls[0].options.credentials, 'same-origin');
  assert.equal(calls[1].options.credentials, 'same-origin');
});

test('coalesces concurrent unauthorized responses into one device-key recovery', async () => {
  const attempts = new Map();
  let recoveries = 0;
  let releaseRecovery;
  const recoveryGate = new Promise((resolve) => { releaseRecovery = resolve; });
  const authenticatedFetch = createAuthenticatedFetch({
    fetchFn: async (input) => {
      const path = String(input);
      const attempt = (attempts.get(path) || 0) + 1;
      attempts.set(path, attempt);
      return attempt === 1
        ? jsonResponse({ error: 'Unauthorized', code: 'REMOTE_UNAUTHORIZED' }, 401)
        : jsonResponse({ ok: true });
    },
    recoverSession: async () => {
      recoveries += 1;
      await recoveryGate;
    },
  });

  const first = authenticatedFetch('/api/projects');
  const second = authenticatedFetch('/api/sessions');
  await new Promise((resolve) => setTimeout(resolve, 0));
  releaseRecovery();

  assert.deepEqual((await Promise.all([first, second])).map((response) => response.status), [200, 200]);
  assert.equal(recoveries, 1);
  assert.deepEqual([...attempts.values()], [2, 2]);
});

test('does not recover unrelated local unauthorized responses', async () => {
  let recoveries = 0;
  const response = await createAuthenticatedFetch({
    fetchFn: async () => jsonResponse({ error: 'Unauthorized' }, 401),
    recoverSession: async () => { recoveries += 1; },
  })('/api/projects');

  assert.equal(response.status, 401);
  assert.equal(recoveries, 0);
});
