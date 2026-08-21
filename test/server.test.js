import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WebSocket } from 'ws';
import { commandExists } from '../src/config.js';
import { createTerminalServer, selectRendererViewport } from '../src/server.js';

async function withServer(options, run) {
  const stateRoot = mkdtempSync(join(tmpdir(), 'agent-remote-state-'));
  const app = createTerminalServer({
    host: '127.0.0.1',
    port: 0,
    shell: '/bin/sh',
    shellArgs: [],
    tmuxSession: '',
    tmuxShell: false,
    databaseFile: join(stateRoot, 'agent-remote.db'),
    reapBrowserAutomationSessions: async () => [],
    ...options,
  });
  const addresses = await app.listen();
  const url = addresses.url ?? addresses;
  try {
    await run(url, app, addresses);
  } finally {
    await app.close();
    rmSync(stateRoot, { recursive: true, force: true });
  }
}

async function pairRemoteDevice(app, publicUrl = 'https://remote.example.test') {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const publicKeyJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const pairing = await app.remoteAuth.createPairing(publicUrl);
  const paired = await app.remoteAuth.pair({
    secret: new URL(pairing.pairUrl).hash.slice(1),
    deviceName: 'Server test device',
    publicKeyJwk,
  });
  return { deviceId: paired.device.id, cookie: paired.setCookie };
}

function connect(url, path = '/ws', options) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url.replace('http:', 'ws:') + path, options);
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

async function readStreamUntil(reader, pattern, timeoutMs = 2_000) {
  const decoder = new TextDecoder();
  let source = '';
  const deadline = Date.now() + timeoutMs;
  while (!pattern.test(source)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`Timed out waiting for ${pattern}`);
    let timer;
    const next = await Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${pattern}`)), remaining);
      }),
    ]).finally(() => clearTimeout(timer));
    if (next.done) throw new Error(`Stream closed before ${pattern}`);
    source += decoder.decode(next.value, { stream: true });
  }
  return source;
}

function remoteRequest(url, { method = 'GET', headers, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.once('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: response.statusCode,
          headers: response.headers,
          json: () => JSON.parse(text),
          text: () => text,
        });
      });
    });
    request.once('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

function localRemoteHeaders(url, headers = {}) {
  return { Origin: new URL(url).origin, ...headers };
}

function waitForOutput(socket, marker) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${marker}; got ${output}`)), 5000);
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'output') output += message.data;
      if (output.includes(marker)) {
        clearTimeout(timeout);
        resolve(output);
      }
    });
  });
}

function waitForMessage(socket, predicate) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for websocket message')), 5000);
    const listener = (raw) => {
      const message = JSON.parse(raw.toString());
      if (!predicate(message)) return;
      clearTimeout(timeout);
      socket.off('message', listener);
      resolve(message);
    };
    socket.on('message', listener);
  });
}

async function waitForCondition(predicate, message, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(typeof message === 'function' ? message() : message);
}

test('serves the frontend and health status', async () => {
  await withServer({}, async (url) => {
    const [page, manifest, tokens, apiClient, promptTitle, uiComponents, remoteControl, mobileConversation, markdown, syntax, markedVendor, purifierVendor, highlightVendor, health] = await Promise.all([
      fetch(url),
      fetch(`${url}/manifest.webmanifest`),
      fetch(`${url}/tokens.css`),
      fetch(`${url}/api-client.js`),
      fetch(`${url}/prompt-title.js`),
      fetch(`${url}/ui-components.js`),
      fetch(`${url}/remote-control.js`),
      fetch(`${url}/mobile-conversation.js`),
      fetch(`${url}/markdown.js`),
      fetch(`${url}/syntax.js`),
      fetch(`${url}/vendor/marked.js`),
      fetch(`${url}/vendor/dompurify.js`),
      fetch(`${url}/vendor/highlight.js`),
      fetch(`${url}/health`),
    ]);
    assert.equal(page.status, 200);
    const pageHtml = await page.text();
    assert.match(pageHtml, /Interactive terminal/);
    assert.match(pageHtml, /apple-mobile-web-app-status-bar-style" content="black-translucent"/);
    assert.equal(manifest.status, 200);
    assert.match(manifest.headers.get('content-type'), /^application\/manifest\+json/);
    const manifestJson = await manifest.json();
    assert.equal(manifestJson.orientation, 'portrait-primary');
    assert.equal(manifestJson.theme_color, '#0c0c0d');
    assert.equal(manifest.headers.get('cache-control'), 'no-store');
    assert.equal(tokens.status, 200);
    assert.match(tokens.headers.get('content-type'), /^text\/css/);
    assert.equal(tokens.headers.get('cache-control'), 'no-store');
    assert.match(await tokens.text(), /--color-terminal-background:\s*#141416/);
    assert.equal(apiClient.status, 200);
    assert.match(apiClient.headers.get('content-type'), /^text\/javascript/);
    assert.equal(promptTitle.status, 200);
    assert.match(await promptTitle.text(), /derivePromptTitle/);
    assert.equal(uiComponents.status, 200);
    assert.match(await uiComponents.text(), /createIconButton/);
    assert.equal(remoteControl.status, 200);
    assert.match(remoteControl.headers.get('content-type'), /^text\/javascript/);
    assert.equal(mobileConversation.status, 200);
    assert.match(await mobileConversation.text(), /createMobileConversationView/);
    assert.equal(markdown.status, 200);
    assert.match(await markdown.text(), /DOMPurify\.sanitize/);
    assert.equal(syntax.status, 200);
    assert.match(await syntax.text(), /highlightCodeNode/);
    assert.equal(markedVendor.status, 200);
    assert.match(markedVendor.headers.get('content-type'), /^text\/javascript/);
    assert.equal(purifierVendor.status, 200);
    assert.match(purifierVendor.headers.get('content-type'), /^text\/javascript/);
    assert.equal(highlightVendor.status, 200);
    assert.match(highlightVendor.headers.get('content-type'), /^text\/javascript/);
    assert.deepEqual(await health.json(), { ok: true, mode: 'shell' });
  });
});

test('serves a provider-neutral mobile conversation only for a managed session', async () => {
  const calls = [];
  const inputs = [];
  const permissions = [];
  const questions = [];
  const planReviews = [];
  const modelChanges = [];
  const modeChanges = [];
  const goalActions = [];
  const cancellations = [];
  const queueActions = [];
  let initializing = false;
  let activeDeliveries = 0;
  let maxActiveDeliveries = 0;
  const conversationRegistry = {
    read: async (session, options) => {
      if (initializing) {
        const error = new Error('Grok ACP connection closed');
        error.code = 'GROK_ACP_DISCONNECTED';
        throw error;
      }
      calls.push({ session, options });
      return {
        provider: { id: 'fixture', label: 'Fixture' },
        thread: { id: 'thread-1', title: 'Mobile thread', status: 'idle' },
        items: [], children: [], parent: null, rootThreadId: 'thread-1',
        capabilities: { send: true, children: false },
      };
    },
    sendSessionInput: async (session, text, options) => {
      activeDeliveries += 1;
      maxActiveDeliveries = Math.max(maxActiveDeliveries, activeDeliveries);
      await new Promise((resolve) => setTimeout(resolve, 15));
      inputs.push({ session, text, options });
      activeDeliveries -= 1;
    },
    respondPermission: async (session, input) => permissions.push({ session, input }),
    respondQuestion: async (session, input) => {
      if (input.questionId === 'expired') {
        const error = new Error('Question request is no longer active');
        error.code = 'GROK_ACP_QUESTION_EXPIRED';
        throw error;
      }
      questions.push({ session, input });
    },
    respondPlanReview: async (session, input) => {
      if (input.reviewId === 'expired') {
        const error = new Error('Plan review is no longer active');
        error.code = 'GROK_ACP_PLAN_EXPIRED';
        throw error;
      }
      planReviews.push({ session, input });
    },
    setModel: async (session, modelId, effortId) => ({
      accepted: true, modelId, effortId: (modelChanges.push({ session, modelId, effortId }), effortId),
    }),
    setMode: async (session, modeId) => ({ accepted: true, modeId: (modeChanges.push({ session, modeId }), modeId) }),
    controlGoal: async (session, action) => ({ accepted: true, action: (goalActions.push({ session, action }), action) }),
    cancel: async (session) => (cancellations.push(session), { accepted: true, active: true }),
    removeQueuedInput: async (session, queueId) => (queueActions.push({ action: 'remove', session, queueId }), { accepted: true }),
    steerQueuedInput: async (session, queueId) => (queueActions.push({ action: 'steer', session, queueId }), { accepted: true }),
    reorderQueuedInputs: async (session, queueIds) => (queueActions.push({ action: 'reorder', session, queueIds }), { accepted: true, queueIds }),
  };
  await withServer({
    conversationRegistry,
    listWorkspaceSessions: async () => [{
      name: 'ar-mobile', label: 'Mobile', cwd: process.cwd(), command: 'fixture', managed: true,
    }],
    managedSessionProcessId: async () => 4321,
  }, async (url) => {
    const response = await fetch(`${url}/api/conversations/ar-mobile?thread=thread-1&historyLimit=80`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).conversation.thread.title, 'Mobile thread');
    assert.deepEqual(calls, [{
      session: {
        name: 'ar-mobile', label: 'Mobile', cwd: process.cwd(), command: 'fixture', managed: true,
        processId: 4321,
      },
      options: { threadId: 'thread-1', historyLimit: 80 },
    }]);
    const inputResponse = await fetch(`${url}/api/conversations/ar-mobile/input`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'mobile-1', text: 'hello from phone' }),
    });
    assert.equal(inputResponse.status, 202);
    assert.deepEqual(await inputResponse.json(), { accepted: true, id: 'mobile-1' });
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0].session.name, 'ar-mobile');
    assert.equal(inputs[0].text, 'hello from phone');

    const duplicate = await fetch(`${url}/api/conversations/ar-mobile/input`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'mobile-1', text: 'hello from phone' }),
    });
    assert.equal(duplicate.status, 202);
    assert.equal(inputs.length, 1, 'the same request id must not prompt ACP twice');

    const [second, third] = await Promise.all([
      fetch(`${url}/api/conversations/ar-mobile/input`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'mobile-2', text: 'second' }),
      }),
      fetch(`${url}/api/conversations/ar-mobile/input`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'mobile-3', text: 'third' }),
      }),
    ]);
    assert.equal(second.status, 202);
    assert.equal(third.status, 202);
    assert.equal(maxActiveDeliveries, 1, 'inputs for one ACP session must be serialized');
    assert.equal(inputs[0].text, 'hello from phone');
    assert.deepEqual(inputs.slice(1).map((input) => input.text).sort(), ['second', 'third']);

    const reused = await fetch(`${url}/api/conversations/ar-mobile/input`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'mobile-1', text: 'different text' }),
    });
    assert.equal(reused.status, 409);
    const permissionResponse = await fetch(`${url}/api/conversations/ar-mobile/permission`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ permissionId: 'permission-1', optionId: 'allow_once' }),
    });
    assert.equal(permissionResponse.status, 202);
    assert.deepEqual(permissions.map(({ session, input }) => ({ name: session.name, ...input })), [{
      name: 'ar-mobile', permissionId: 'permission-1', optionId: 'allow_once',
    }]);
    const questionResponse = await fetch(`${url}/api/conversations/ar-mobile/question`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        threadId: 'thread-1', questionId: 'ask-1', answers: { 'Pick a color': 'Red' },
      }),
    });
    assert.equal(questionResponse.status, 202);
    assert.deepEqual(await questionResponse.json(), { accepted: true });
    assert.deepEqual(questions.map(({ session, input }) => ({ name: session.name, ...input })), [{
      name: 'ar-mobile', threadId: 'thread-1', questionId: 'ask-1', answers: { 'Pick a color': 'Red' },
    }]);
    const planReviewResponse = await fetch(`${url}/api/conversations/ar-mobile/plan-review`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        threadId: 'thread-1', reviewId: 'exit-plan-1', outcome: 'cancelled',
        feedback: '@plan.md:3\nExplain this step.',
      }),
    });
    assert.equal(planReviewResponse.status, 202);
    assert.deepEqual(await planReviewResponse.json(), { accepted: true, outcome: 'cancelled' });
    assert.deepEqual(planReviews.map(({ session, input }) => ({ name: session.name, ...input })), [{
      name: 'ar-mobile', threadId: 'thread-1', reviewId: 'exit-plan-1', outcome: 'cancelled',
      feedback: '@plan.md:3\nExplain this step.',
    }]);
    const modelResponse = await fetch(`${url}/api/conversations/ar-mobile/model`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modelId: 'grok-4.6', effortId: 'low' }),
    });
    assert.equal(modelResponse.status, 202);
    assert.deepEqual(await modelResponse.json(), { accepted: true, modelId: 'grok-4.6', effortId: 'low' });
    assert.deepEqual(modelChanges.map(({ session, modelId, effortId }) => ({ name: session.name, modelId, effortId })), [{
      name: 'ar-mobile', modelId: 'grok-4.6', effortId: 'low',
    }]);
    const modeResponse = await fetch(`${url}/api/conversations/ar-mobile/mode`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modeId: 'alwaysApprove' }),
    });
    assert.equal(modeResponse.status, 202);
    assert.deepEqual(await modeResponse.json(), { accepted: true, modeId: 'alwaysApprove' });
    assert.deepEqual(modeChanges.map(({ session, modeId }) => ({ name: session.name, modeId })), [
      { name: 'ar-mobile', modeId: 'alwaysApprove' },
    ]);
    const goalResponse = await fetch(`${url}/api/conversations/ar-mobile/goal`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'pause' }),
    });
    assert.equal(goalResponse.status, 202);
    assert.deepEqual(await goalResponse.json(), { accepted: true, action: 'pause' });
    assert.deepEqual(goalActions.map(({ session, action }) => ({ name: session.name, action })), [
      { name: 'ar-mobile', action: 'pause' },
    ]);
    const cancelResponse = await fetch(`${url}/api/conversations/ar-mobile/cancel`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(cancelResponse.status, 202);
    assert.deepEqual(await cancelResponse.json(), { accepted: true, active: true });
    assert.deepEqual(cancellations.map((session) => session.name), ['ar-mobile']);
    for (const [suffix, method] of [['', 'DELETE'], ['/steer', 'POST']]) {
      const queueResponse = await fetch(`${url}/api/conversations/ar-mobile/queue/q-1${suffix}`, {
        method, headers: method === 'POST' ? { 'content-type': 'application/json' } : undefined,
        ...(method === 'POST' ? { body: '{}' } : {}),
      });
      assert.equal(queueResponse.status, 202);
    }
    const reorderResponse = await fetch(`${url}/api/conversations/ar-mobile/queue/reorder`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ queueIds: ['q-2', 'q-1'] }),
    });
    assert.equal(reorderResponse.status, 202);
    assert.deepEqual(await reorderResponse.json(), { accepted: true, queueIds: ['q-2', 'q-1'] });
    assert.deepEqual(queueActions.map(({ action, session, queueId }) => ({ action, name: session.name, queueId })), [
      { action: 'remove', name: 'ar-mobile', queueId: 'q-1' },
      { action: 'steer', name: 'ar-mobile', queueId: 'q-1' },
      { action: 'reorder', name: 'ar-mobile', queueId: undefined },
    ]);
    assert.deepEqual(queueActions.at(-1).queueIds, ['q-2', 'q-1']);
    const upload = await fetch(`${url}/api/conversations/ar-mobile/attachments`, {
      method: 'POST', headers: { 'content-type': 'image/png', 'x-file-name': encodeURIComponent('phone.png') },
      body: Buffer.from('fake-image'),
    });
    assert.equal(upload.status, 201);
    const uploaded = (await upload.json()).attachment;
    assert.equal(uploaded.name, 'phone.png');
    assert.equal('path' in uploaded, false);
    assert.equal((await fetch(`${url}${uploaded.previewUrl}`)).status, 200);
    const chunkUploadId = '22222222-2222-4222-8222-222222222222';
    const chunkHeaders = {
      'content-type': 'video/quicktime',
      'x-file-name': encodeURIComponent('recording.mov'),
      'x-upload-id': chunkUploadId,
      'x-upload-total': '5',
    };
    const firstChunk = await fetch(`${url}/api/conversations/ar-mobile/attachments`, {
      method: 'POST', headers: { ...chunkHeaders, 'x-upload-offset': '0' }, body: Buffer.from('abc'),
    });
    assert.equal(firstChunk.status, 202);
    assert.deepEqual(await firstChunk.json(), { nextOffset: 3 });
    const repeatedFirstChunk = await fetch(`${url}/api/conversations/ar-mobile/attachments`, {
      method: 'POST', headers: { ...chunkHeaders, 'x-upload-offset': '0' }, body: Buffer.from('abc'),
    });
    assert.equal(repeatedFirstChunk.status, 409);
    assert.deepEqual(await repeatedFirstChunk.json(), {
      error: 'Upload expected offset 3', code: 'ATTACHMENT_UPLOAD_OFFSET', nextOffset: 3,
    });
    const finalChunk = await fetch(`${url}/api/conversations/ar-mobile/attachments`, {
      method: 'POST', headers: { ...chunkHeaders, 'x-upload-offset': '3' }, body: Buffer.from('de'),
    });
    assert.equal(finalChunk.status, 201);
    const chunked = (await finalChunk.json()).attachment;
    assert.equal(chunked.id, chunkUploadId);
    assert.equal(chunked.name, 'recording.mov');
    assert.equal(chunked.mimeType, 'video/quicktime');
    assert.equal(chunked.size, 5);
    assert.equal((await fetch(`${url}${chunked.previewUrl}`)).status, 200);
    const repeatedFinalChunk = await fetch(`${url}/api/conversations/ar-mobile/attachments`, {
      method: 'POST', headers: { ...chunkHeaders, 'x-upload-offset': '3' }, body: Buffer.from('de'),
    });
    assert.equal(repeatedFinalChunk.status, 201);
    assert.equal((await repeatedFinalChunk.json()).nextOffset, 5);
    const attachmentInput = await fetch(`${url}/api/conversations/ar-mobile/input`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'mobile-attachment', text: 'inspect this', attachmentIds: [uploaded.id] }),
    });
    assert.equal(attachmentInput.status, 202);
    assert.match(inputs.at(-1).text,
      /^inspect this\n\n!\[phone\.png\]\(\/tmp\/agent-remote-uploads-[^/]+\/[0-9a-f-]{36}\.png\)$/);
    assert.equal(inputs.at(-1).options.attachments[0].previewUrl, uploaded.previewUrl);
    const fileCompletions = await fetch(`${url}/api/conversations/ar-mobile/completions/files?q=mobconv`);
    assert.equal(fileCompletions.status, 200);
    assert.equal((await fileCompletions.json()).files[0].path, 'public/mobile-conversation.js');
    const filePreview = await fetch(`${url}/api/conversations/ar-mobile/files?path=public%2Fmobile-conversation.js`);
    assert.equal(filePreview.status, 200);
    const preview = (await filePreview.json()).file;
    assert.equal(preview.path, 'public/mobile-conversation.js');
    assert.match(preview.content, /createMobileConversationView/);
    assert.equal(preview.startLine, 1);
    assert.ok(preview.totalLines > 100);
    assert.equal((await fetch(`${url}/api/conversations/ar-mobile/files?path=..%2Fpackage.json`)).status, 400);
    const mentionedInput = await fetch(`${url}/api/conversations/ar-mobile/input`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'mobile-file-mention', text: 'Review @public/mobile-conversation.js',
        fileMentions: ['public/mobile-conversation.js'],
      }),
    });
    assert.equal(mentionedInput.status, 202);
    assert.equal(inputs.at(-1).text,
      `Review @public/mobile-conversation.js\n\n[public/mobile-conversation.js](${realpathSync(join(process.cwd(), 'public/mobile-conversation.js'))})`);
    const escapedMention = await fetch(`${url}/api/conversations/ar-mobile/input`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'mobile-file-escape', text: 'bad', fileMentions: ['../outside.txt'] }),
    });
    assert.equal(escapedMention.status, 400);
    const malformedModel = await fetch(`${url}/api/conversations/ar-mobile/model`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modelId: '../bad' }),
    });
    assert.equal(malformedModel.status, 400);
    const malformedQuestion = await fetch(`${url}/api/conversations/ar-mobile/question`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: 'thread-1', questionId: 'ask-1', answers: { 'Pick a color': ['Red'] } }),
    });
    assert.equal(malformedQuestion.status, 400);
    const expiredQuestion = await fetch(`${url}/api/conversations/ar-mobile/question`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: 'thread-1', questionId: 'expired', answers: { 'Pick a color': 'Red' } }),
    });
    assert.equal(expiredQuestion.status, 409);
    assert.deepEqual(await expiredQuestion.json(), {
      error: 'Question request is no longer active', code: 'GROK_ACP_QUESTION_EXPIRED',
    });
    const malformedPlanReview = await fetch(`${url}/api/conversations/ar-mobile/plan-review`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: 'thread-1', reviewId: 'exit-plan-1', outcome: 'approve' }),
    });
    assert.equal(malformedPlanReview.status, 400);
    const expiredPlanReview = await fetch(`${url}/api/conversations/ar-mobile/plan-review`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: 'thread-1', reviewId: 'expired', outcome: 'approved' }),
    });
    assert.equal(expiredPlanReview.status, 409);
    assert.deepEqual(await expiredPlanReview.json(), {
      error: 'Plan review is no longer active', code: 'GROK_ACP_PLAN_EXPIRED',
    });
    initializing = true;
    const connecting = await fetch(`${url}/api/conversations/ar-mobile`);
    assert.equal(connecting.status, 503);
    assert.deepEqual(await connecting.json(), {
      error: 'Connecting to Grok', code: 'CONVERSATION_INITIALIZING',
    });
    assert.equal((await fetch(`${url}/api/conversations/not-managed`)).status, 404);
  });
});

test('session list includes provider lifecycle status for sidebar activity', async () => {
  const statuses = [];
  await withServer({
    conversationRegistry: {
      status: async (session) => {
        statuses.push(session.name);
        return session.name === 'ar-agent' ? 'working' : undefined;
      },
      close: async () => {},
    },
    listWorkspaceSessions: async () => [
      { name: 'ar-agent', label: 'Agent', cwd: '/tmp/project', command: 'grok', managed: true },
      { name: 'ar-shell', label: 'Shell', cwd: '/tmp/project', command: 'zsh', managed: true },
    ],
  }, async (url) => {
    const response = await fetch(`${url}/api/sessions`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.sessions.find((session) => session.name === 'ar-agent').conversationStatus, 'working');
    assert.equal('conversationStatus' in payload.sessions.find((session) => session.name === 'ar-shell'), false);
    assert.deepEqual(statuses, ['ar-agent', 'ar-shell']);
  });
});

test('streams provider-neutral conversation updates and releases its watcher on disconnect', async () => {
  let stopped = false;
  const conversation = {
    provider: { id: 'fixture', label: 'Fixture' },
    thread: { id: 'thread-1', title: 'Streaming', status: 'working' },
    items: [{ id: 'a-1', type: 'message', role: 'assistant', text: 'live chunk' }],
    children: [], parent: null, rootThreadId: 'thread-1',
    capabilities: { send: true, children: false },
  };
  const conversationRegistry = {
    read: async () => conversation,
    watch: async (_session, _options, listener) => {
      listener({ conversation, stream: { kind: 'agent_message_chunk', delta: 'live chunk' } });
      conversation.items[0].text += ' two';
      listener({ conversation, stream: { kind: 'agent_message_chunk', delta: ' two' } });
      return async () => { stopped = true; };
    },
    encodeSessionInput: async (_session, text) => `${text}\r`,
  };
  await withServer({
    conversationRegistry,
    listWorkspaceSessions: async () => [{
      name: 'ar-mobile', label: 'Mobile', cwd: '/tmp/project', command: 'fixture', managed: true,
    }],
    managedSessionProcessId: async () => 4321,
  }, async (url) => {
    const controller = new AbortController();
    const response = await fetch(`${url}/api/conversations/ar-mobile/stream`, { signal: controller.signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/event-stream/);
    const reader = response.body.getReader();
    let streamed = '';
    while (!streamed.includes('"delta":" two"')) {
      const { value, done } = await reader.read();
      if (done) break;
      streamed += Buffer.from(value).toString('utf8');
    }
    assert.equal(streamed.startsWith(':'), true);
    assert.match(streamed, /retry: 1000/);
    assert.ok(streamed.indexOf('event: conversation') > 2_048);
    assert.match(streamed, /"live chunk"/);
    assert.match(streamed, /"messageId":"a-1"/);
    assert.equal((streamed.match(/"conversation":/g) || []).length, 1);
    assert.match(response.headers.get('cache-control'), /no-transform/);
    const split = await fetch(`${url}/api/control/split`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        cwd: '/tmp/project',
        argv: ['terminal-browser', 'open', 'https://example.com'],
      }),
    });
    assert.equal(split.status, 202);
    assert.deepEqual(await split.json(), { delivered: 1, session: 'ar-mobile' });
    const control = await reader.read();
    assert.match(Buffer.from(control.value).toString('utf8'), /event: control/);
    assert.match(Buffer.from(control.value).toString('utf8'), /"action":"open-graphics"/);
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(stopped, true);
  });
});

test('streams conversation updates as websocket messages and releases its watcher on disconnect', async () => {
  let stopped = false;
  let reads = 0;
  const conversation = {
    provider: { id: 'fixture', label: 'Fixture' },
    thread: { id: 'thread-1', title: 'Streaming', status: 'working' },
    items: [{ id: 'a-1', type: 'message', role: 'assistant', text: 'live chunk' }],
    children: [], parent: null, rootThreadId: 'thread-1',
    capabilities: { send: true, children: false },
  };
  const conversationRegistry = {
    read: async () => (reads += 1, conversation),
    watch: async (_session, _options, listener) => {
      listener({ conversation, stream: { kind: 'agent_message_chunk', delta: 'live chunk' } });
      conversation.items[0].text += ' two';
      listener({ conversation, stream: { kind: 'agent_message_chunk', delta: ' two' } });
      return async () => { stopped = true; };
    },
    encodeSessionInput: async (_session, text) => `${text}\r`,
    close: async () => {},
  };
  await withServer({
    conversationRegistry,
    listWorkspaceSessions: async () => [{
      name: 'ar-mobile', label: 'Mobile', cwd: '/tmp/project', command: 'fixture', managed: true,
    }],
    managedSessionProcessId: async () => 4321,
  }, async (url) => {
    const messages = [];
    const socket = new WebSocket(
      url.replace('http:', 'ws:') + '/conversation-ws?session=ar-mobile&thread=thread-1',
    );
    socket.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    await waitForCondition(
      () => messages.some((message) => message.type === 'conversation' && message.stream?.delta === ' two'),
      'expected token deltas over the conversation websocket',
    );
    const conversationMessages = messages.filter((message) => message.type === 'conversation');
    assert.equal(conversationMessages[0].conversation.thread.id, 'thread-1');
    assert.match(conversationMessages.find((message) => message.stream?.delta === 'live chunk').conversation.items[0].text, /live chunk/);
    assert.equal(conversationMessages.find((message) => message.stream?.delta === ' two').conversation, undefined);
    assert.equal(conversationMessages.find((message) => message.stream?.delta === ' two').stream.messageId, 'a-1');
    assert.equal(reads, 0, 'websocket watch owns its initial snapshot without a duplicate read');

    const split = await fetch(`${url}/api/control/split`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        cwd: '/tmp/project',
        argv: ['terminal-browser', 'open', 'https://example.com'],
      }),
    });
    assert.equal(split.status, 202);
    await waitForCondition(
      () => messages.some((message) => message.type === 'control' && message.action === 'open-graphics'),
      'expected control delivery over the conversation websocket',
    );

    socket.close();
    await waitForCondition(() => stopped, 'expected websocket watcher cleanup');
  });
});

test('remote gateway listens separately while preserving the local url compatibility field', async () => {
  await withServer({ remotePort: 0, remotePublicUrl: 'https://remote.example.test' }, async (url, app, addresses) => {
    assert.equal(addresses.url, url);
    assert.equal(addresses.localUrl, url);
    assert.match(addresses.remoteUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.notEqual(addresses.remoteUrl, url);
    assert.deepEqual(await (await fetch(`${url}/api/runtime`)).json(), {
      product: 'agent-remote', version: 1, surface: 'local', desktopMode: false,
    });
    assert.equal(app.server.listening, true);
    assert.equal(app.remoteServer.listening, true);
  });
});

test('remote gateway rejects unauthenticated traffic, hides local administration, and delegates authenticated clients', async () => {
  const publicUrl = 'https://remote.example.test';
  const headers = { Host: 'remote.example.test', Origin: publicUrl };
  await withServer({ remotePort: 0, remotePublicUrl: publicUrl, tmuxShell: false }, async (_url, app, addresses) => {
    assert.equal((await remoteRequest(`${addresses.remoteUrl}/api/projects`, { headers })).status, 401);
    const entry = await remoteRequest(`${addresses.remoteUrl}/`, { headers });
    assert.equal(entry.status, 200);
    assert.match(entry.text(), /Remote access is locked/);
    assert.equal((await remoteRequest(`${addresses.remoteUrl}/app.js`, { headers })).status, 401);
    assert.equal((await remoteRequest(`${addresses.remoteUrl}/api/remote/status`, { headers })).status, 404);
    await assert.rejects(connect(addresses.remoteUrl, '/ws', { headers }), /401/);
    await assert.rejects(
      connect(addresses.remoteUrl, '/ws', { headers: { ...headers, Origin: 'https://wrong.example.test' } }),
      /403/,
    );

    assert.equal((await remoteRequest(`${addresses.remoteUrl}/api/projects`, {
      headers: { ...headers, Host: 'wrong.example.test' },
    })).status, 403);
    assert.equal((await remoteRequest(`${addresses.remoteUrl}/api/projects`, {
      method: 'POST', headers: { ...headers, Origin: 'https://wrong.example.test' }, body: '{}',
    })).status, 403);

    const device = await pairRemoteDevice(app, publicUrl);
    const authenticatedHeaders = { ...headers, Cookie: device.cookie };
    const projects = await remoteRequest(`${addresses.remoteUrl}/api/projects`, { headers: authenticatedHeaders });
    assert.equal(projects.status, 200);
    assert.deepEqual(await projects.json(), { projects: [] });
    const workspace = await remoteRequest(`${addresses.remoteUrl}/`, { headers: authenticatedHeaders });
    assert.equal(workspace.status, 200);
    const workspaceHtml = workspace.text();
    assert.doesNotMatch(workspaceHtml, /id="remote-button"/);
    assert.doesNotMatch(workspaceHtml, /id="remote-dialog"/);
    assert.doesNotMatch(workspaceHtml, /id="cloudflare-token-guide-dialog"/);
    assert.doesNotMatch(workspaceHtml, /local-control:(?:start|end)/);
    assert.equal((await remoteRequest(`${addresses.remoteUrl}/remote-control.js`, {
      headers: authenticatedHeaders,
    })).status, 404);
    assert.equal((await remoteRequest(`${addresses.remoteUrl}/api/remote/status`, { headers: authenticatedHeaders })).status, 404);
    assert.equal((await remoteRequest(`${addresses.remoteUrl}/devtools/missing/inspector.html`, { headers })).status, 401);
    assert.equal((await remoteRequest(`${addresses.remoteUrl}/devtools/missing/inspector.html`, {
      headers: authenticatedHeaders,
    })).status, 404);
    await assert.rejects(connect(addresses.remoteUrl, '/devtools-ws?access=missing&target=missing', { headers }), /401/);
    await assert.rejects(
      connect(addresses.remoteUrl, '/devtools-ws?access=missing&target=missing', { headers: authenticatedHeaders }),
      /404/,
    );

    const socket = await connect(addresses.remoteUrl, '/ws', { headers: authenticatedHeaders });
    socket.close();
    const rendererSocket = await connect(addresses.remoteUrl, '/ws?mode=graphics', { headers: authenticatedHeaders });
    rendererSocket.close();
  });
});

test('local Remote administration routes require same-origin JSON mutations and stay off the remote listener', async () => {
  const calls = [];
  const controller = {
    status: async () => ({ supported: true, tunnel: { mode: 'none', state: 'stopped' } }),
    tunnelStatus: () => ({ mode: 'none', state: 'stopped' }),
    setCloudflareToken: async (token) => { calls.push(['token', token]); return { configured: true, zones: [{ id: 'zone-1' }] }; },
    removeCloudflareToken: async () => { calls.push(['remove-token']); return { configured: false }; },
    listZones: async () => ({ zones: [{ id: 'zone-1' }] }),
    checkHostnameAvailability: async (input) => ({ ...input, hostname: 'term.example.com', status: 'available', suggestions: [] }),
    startQuick: async () => ({ mode: 'quick', state: 'running', publicUrl: 'https://quick.example.test' }),
    startNamed: async (input) => { calls.push(['named', input]); return { mode: 'named', state: 'running', hostname: 'term.example.com' }; },
    stop: async () => ({ mode: 'none', state: 'stopped' }),
    removeNamed: async () => ({ removed: true, warnings: [] }),
    createPairing: async () => ({ pairUrl: 'https://quick.example.test/pair#secret', qrDataUrl: 'data:image/png;base64,AA==', expiresAt: 123 }),
  };
  const publicUrl = 'https://remote.example.test';
  await withServer({
    remotePort: 0, remotePublicUrl: publicUrl, remoteController: controller,
    allowedOrigins: ['https://configured-but-not-same-origin.example.test'],
  }, async (url, app, addresses) => {
    const headers = localRemoteHeaders(url);
    const request = (path, options = {}) => remoteRequest(`${url}${path}`, {
      ...options,
      headers: localRemoteHeaders(url, options.headers),
    });
    assert.deepEqual((await request('/api/remote/status')).json(), {
      supported: true, tunnel: { mode: 'none', state: 'stopped' },
    });
    assert.deepEqual((await request('/api/remote/tunnel-status')).json(), {
      tunnel: { mode: 'none', state: 'stopped' },
    });
    assert.equal((await remoteRequest(`${url}/api/remote/tunnels/quick`, { method: 'POST' })).status, 403);
    assert.equal((await request('/api/remote/tunnels/quick', {
      method: 'POST', headers: { Origin: 'https://configured-but-not-same-origin.example.test' },
    })).status, 403);
    assert.equal((await request('/api/remote/cloudflare-token', { method: 'PUT', body: '{}' })).status, 415);
    assert.deepEqual((await request('/api/remote/cloudflare-token', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'candidate' }),
    })).json(), { configured: true, zones: [{ id: 'zone-1' }] });
    assert.deepEqual((await request('/api/remote/cloudflare-token', { method: 'DELETE' })).json(), { configured: false });
    assert.deepEqual((await request('/api/remote/zones')).json(), { zones: [{ id: 'zone-1' }] });
    assert.deepEqual((await request('/api/remote/hostname-availability?zoneId=zone-1&subdomain=term')).json(), {
      zoneId: 'zone-1', subdomain: 'term', hostname: 'term.example.com', status: 'available', suggestions: [],
    });
    assert.equal((await request('/api/remote/tunnels/quick', { method: 'POST' })).status, 201);
    assert.equal((await request('/api/remote/tunnels/named', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ zoneId: 'zone-1', subdomain: 'term' }),
    })).status, 201);
    assert.deepEqual((await request('/api/remote/tunnels/stop', { method: 'POST' })).json(), { mode: 'none', state: 'stopped' });
    assert.deepEqual((await request('/api/remote/tunnels/named', { method: 'DELETE' })).json(), { removed: true, warnings: [] });
    const pairing = await request('/api/remote/pairing-sessions', { method: 'POST' });
    assert.equal(pairing.status, 201);
    assert.equal(pairing.headers['cache-control'], 'no-store');
    assert.deepEqual(pairing.json(), { pairUrl: 'https://quick.example.test/pair#secret', qrDataUrl: 'data:image/png;base64,AA==', expiresAt: 123 });

    app.remoteStore.registerDevice({ id: 'device-1', name: 'Phone', publicKeyJwk: {}, fingerprint: 'fingerprint-1', createdAt: 10 });
    assert.deepEqual((await request('/api/remote/devices')).json(), {
      devices: [{ id: 'device-1', name: 'Phone', createdAt: 10, lastUsedAt: null, revokedAt: null }],
    });
    assert.deepEqual((await request('/api/remote/devices/device-1', { method: 'DELETE' })).json(), { removed: true });
    assert.equal((await request('/api/remote/devices/missing-device', { method: 'DELETE' })).status, 404);
    app.remoteStore.registerDevice({ id: 'device-2', name: 'Phone', publicKeyJwk: {}, fingerprint: 'fingerprint-2', createdAt: 20 });
    app.remoteStore.registerDevice({ id: 'device-3', name: 'Tablet', publicKeyJwk: {}, fingerprint: 'fingerprint-3', createdAt: 30 });
    assert.deepEqual((await request('/api/remote/devices', { method: 'DELETE' })).json(), { removed: 2 });
    assert.deepEqual((await request('/api/remote/devices')).json(), { devices: [] });
    assert.deepEqual(calls, [
      ['token', 'candidate'], ['remove-token'], ['named', { zoneId: 'zone-1', subdomain: 'term' }],
    ]);

    const device = await pairRemoteDevice(app, publicUrl);
    assert.equal((await remoteRequest(`${addresses.remoteUrl}/api/remote/zones`, {
      headers: { Host: 'remote.example.test', Origin: publicUrl, Cookie: device.cookie },
    })).status, 404);
    assert.ok(headers.Origin);
  });
});

test('named reconnect starts after both listeners bind without waiting for local UI startup work', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'agent-remote-restore-'));
  const attempts = [];
  let releaseBrowserScan;
  let signalRestore;
  const browserScan = new Promise((resolve) => { releaseBrowserScan = resolve; });
  const restoreStarted = new Promise((resolve) => { signalRestore = resolve; });
  let app;
  app = createTerminalServer({
    host: '127.0.0.1', port: 0, remoteHost: '127.0.0.1', remotePort: 0,
    shell: '/bin/sh', shellArgs: [], tmuxSession: '', tmuxShell: false,
    databaseFile: join(stateRoot, 'agent-remote.db'),
    listTerminalBrowsers: async () => {
      await browserScan;
      return [];
    },
    remoteController: { startNamed: async (input) => {
      assert.equal(app.server.listening, true);
      assert.equal(app.remoteServer.listening, true);
      attempts.push(input);
      signalRestore();
      throw new Error('Cloudflare is unavailable');
    } },
  });
  app.remoteStore.saveNamedTunnel({
    accountId: 'account-1', zoneId: 'zone-1', zoneName: 'example.com', hostname: 'term.example.com',
    tunnelId: 'tunnel-1', tunnelName: 'agent-remote-test', dnsRecordId: 'dns-1', dnsTarget: 'tunnel-1.cfargotunnel.com',
  });
  app.remoteStore.setDesiredState('running');
  let listenSettled = false;
  try {
    const listening = app.listen().finally(() => { listenSettled = true; });
    let restoreTimer;
    await Promise.race([
      restoreStarted,
      new Promise((_, reject) => {
        restoreTimer = setTimeout(() => reject(new Error('Remote restore waited for local UI startup work')), 1_000);
      }),
    ]).finally(() => clearTimeout(restoreTimer));
    assert.equal(listenSettled, false);
    assert.deepEqual(attempts, [{ zoneId: 'zone-1', subdomain: 'term' }]);
    releaseBrowserScan();
    const addresses = await listening;
    assert.match(addresses.localUrl, /^http:\/\/127\.0\.0\.1:/);
    assert.equal(app.server.listening, true);
    assert.equal(app.remoteServer.listening, true);
    await app.remoteRestore;
  } finally {
    releaseBrowserScan();
    await app.close();
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test('remote auth routes pair, challenge, verify, logout, and apply their security contract', async () => {
  const publicUrl = 'https://remote.example.test';
  const headers = { Host: 'remote.example.test', Origin: publicUrl };
  await withServer({ remotePort: 0, remotePublicUrl: publicUrl, tmuxShell: false }, async (_url, app, addresses) => {
    const status = await remoteRequest(`${addresses.remoteUrl}/remote-auth/status`, { headers });
    assert.equal(status.status, 200);
    assert.deepEqual(status.json(), { authenticated: false });
    assert.equal(status.headers['cache-control'], 'no-store');
    assert.equal(status.headers['referrer-policy'], 'no-referrer');
    assert.equal(status.headers['x-content-type-options'], 'nosniff');
    assert.equal(
      status.headers['content-security-policy'],
      "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'",
    );
    assert.equal((await remoteRequest(`${addresses.remoteUrl}/pair`, { headers })).status, 200);

    const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const publicKeyJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
    const pairing = await app.remoteAuth.createPairing(publicUrl);
    const secret = new URL(pairing.pairUrl).hash.slice(1);
    const paired = await remoteRequest(`${addresses.remoteUrl}/remote-auth/pair`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ secret, deviceName: 'Remote test device', publicKeyJwk }),
    });
    assert.equal(paired.status, 201);
    const pairedPayload = paired.json();
    assert.equal(pairedPayload.authenticated, true);
    assert.equal(pairedPayload.device.name, 'Remote test device');
    assert.equal(Object.hasOwn(pairedPayload.device, 'publicKeyJwk'), false);
    assert.equal(Object.hasOwn(pairedPayload.device, 'fingerprint'), false);
    const pairedCookie = paired.headers['set-cookie'].at(0);
    assert.match(pairedCookie, /^__Host-agent_remote=[A-Za-z0-9_-]+; Max-Age=43200; Path=\/; HttpOnly; Secure; SameSite=Strict$/);
    assert.equal(paired.text().includes(secret), false);

    const reused = await remoteRequest(`${addresses.remoteUrl}/remote-auth/pair`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ secret, deviceName: 'Remote test device', publicKeyJwk }),
    });
    assert.equal(reused.status, 410);
    assert.deepEqual(reused.json(), {
      error: 'Pairing session has expired or was already used', code: 'PAIRING_EXPIRED',
    });

    const cookie = pairedCookie;
    const authenticated = await remoteRequest(`${addresses.remoteUrl}/remote-auth/status`, {
      headers: { ...headers, Cookie: cookie },
    });
    assert.equal(authenticated.status, 200);
    assert.deepEqual(authenticated.json(), {
      authenticated: true, deviceId: pairedPayload.device.id, expiresAt: pairedPayload.expiresAt,
    });

    const workspace = await remoteRequest(`${addresses.remoteUrl}/`, {
      headers: { ...headers, Cookie: cookie },
    });
    assert.equal(workspace.status, 200);
    assert.equal(workspace.headers['cache-control'], 'no-store');
    assert.equal(workspace.headers['referrer-policy'], 'no-referrer');
    assert.equal(workspace.headers['x-frame-options'], 'DENY');
    assert.match(workspace.headers['content-security-policy'], /script-src 'self'/);
    assert.match(workspace.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.doesNotMatch(workspace.text(), /<script(?:\s[^>]*)?>\s*[^<\s]/i);

    const challenge = await remoteRequest(`${addresses.remoteUrl}/remote-auth/challenge`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: pairedPayload.device.id }),
    });
    assert.equal(challenge.status, 200);
    const challengePayload = challenge.json();
    const signed = new TextEncoder().encode(
      `agent-remote:v1:${challengePayload.challengeId}:${challengePayload.challenge}:${publicUrl}`,
    );
    const signature = Buffer.from(await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' }, keyPair.privateKey, signed,
    )).toString('base64url');
    const verified = await remoteRequest(`${addresses.remoteUrl}/remote-auth/verify`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        deviceId: pairedPayload.device.id, challengeId: challengePayload.challengeId, signature,
      }),
    });
    assert.equal(verified.status, 200);
    assert.deepEqual(verified.json().authenticated, true);
    const verifiedCookie = verified.headers['set-cookie'].at(0);
    assert.match(verifiedCookie, /^__Host-agent_remote=/);

    const loggedOut = await remoteRequest(`${addresses.remoteUrl}/remote-auth/session`, {
      method: 'DELETE', headers: { ...headers, Cookie: verifiedCookie },
    });
    assert.equal(loggedOut.status, 200);
    assert.deepEqual(loggedOut.json(), { authenticated: false });
    assert.match(loggedOut.headers['set-cookie'].at(0), /Max-Age=0/);

    const rateHeaders = {
      ...headers,
      'content-type': 'application/json',
      'cf-connecting-ip': '203.0.113.199',
    };
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await remoteRequest(`${addresses.remoteUrl}/remote-auth/challenge`, {
        method: 'POST', headers: rateHeaders, body: JSON.stringify({ deviceId: pairedPayload.device.id }),
      });
      assert.equal(response.status, 200);
    }
    const limited = await remoteRequest(`${addresses.remoteUrl}/remote-auth/challenge`, {
      method: 'POST', headers: rateHeaders, body: JSON.stringify({ deviceId: pairedPayload.device.id }),
    });
    assert.equal(limited.status, 429);
    assert.deepEqual(limited.json(), {
      error: 'Too many authentication attempts', code: 'REMOTE_UNAUTHORIZED',
    });

    const oversized = await remoteRequest(`${addresses.remoteUrl}/remote-auth/challenge`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.200' },
      body: JSON.stringify({ deviceId: pairedPayload.device.id, padding: 'x'.repeat(64 * 1024) }),
    });
    assert.equal(oversized.status, 413);
  });
});

test('revoking a remote device closes its active websocket with code 4003', async () => {
  const publicUrl = 'https://remote.example.test';
  const headers = { Host: 'remote.example.test', Origin: publicUrl };
  await withServer({ remotePort: 0, remotePublicUrl: publicUrl, tmuxShell: false }, async (_url, app, addresses) => {
    const device = await pairRemoteDevice(app, publicUrl);
    const socket = await connect(addresses.remoteUrl, '/ws', { headers: { ...headers, Cookie: device.cookie } });
    const closed = new Promise((resolve) => socket.once('close', (code) => resolve(code)));
    assert.equal(app.remoteAuth.revokeDevice(device.deviceId), true);
    assert.equal(await closed, 4003);
  });
});

test('closing the app closes both listeners and remote resources without enabling tmux', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'agent-remote-close-'));
  const closed = [];
  const remoteStore = { close: () => closed.push('remote-store') };
  const remoteAuth = {
    authenticate: () => undefined,
    close: () => closed.push('remote-auth'),
  };
  const tunnelManager = {
    status: () => ({ mode: 'none', state: 'stopped' }),
    close: async () => closed.push('tunnel-manager'),
  };
  const remoteTokenStore = { has: async () => false, read: async () => undefined, write: async () => {}, remove: async () => false };
  const remoteProvisioner = {
    validateToken: async () => [], listZones: async () => [], checkAvailability: async () => ({}),
    prepareNamed: async () => ({}), removeNamed: async () => ({ removed: true, warnings: [] }),
  };
  const remoteController = { startNamed: async () => {}, status: async () => ({}) };
  const app = createTerminalServer({
    host: '127.0.0.1', port: 0, remoteHost: '127.0.0.1', remotePort: 0,
    shell: '/bin/sh', shellArgs: [], tmuxSession: '', tmuxShell: false,
    databaseFile: join(stateRoot, 'agent-remote.db'), remoteStore, remoteAuth, tunnelManager,
    remoteTokenStore, remoteProvisioner, remoteController,
  });
  try {
    await app.listen();
    assert.equal(app.config.tmuxBacked, false);
    await app.close();
    assert.equal(app.server.listening, false);
    assert.equal(app.remoteServer.listening, false);
    assert.deepEqual(closed.sort(), ['remote-auth', 'remote-store', 'tunnel-manager']);
    assert.throws(() => app.projectStore.list());
  } finally {
    if (app.server.listening || app.remoteServer.listening) await app.close();
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test('bridges input and output through a real PTY', async () => {
  await withServer({}, async (url) => {
    const socket = await connect(url);
    // A PTY startup failure closes the socket; wait for actual terminal output below.
    const output = waitForOutput(socket, '__AGENT_REMOTE_PTY_OK__');
    socket.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
    socket.send(JSON.stringify({ type: 'input', data: "printf '__AGENT_REMOTE_PTY_OK__\\r\\n'\r" }));
    assert.match(await output, /__AGENT_REMOTE_PTY_OK__/);
    socket.close();
  });
});

test('spawns the PTY at the viewport size supplied during websocket connect', async () => {
  await withServer({}, async (url) => {
    const socket = await connect(url, '/ws?cols=123&rows=37');
    const output = waitForOutput(socket, '__INITIAL_SIZE__ 37 123');
    socket.send(JSON.stringify({ type: 'input', data: "printf '__INITIAL_SIZE__ '; stty size\r" }));
    assert.match(await output, /__INITIAL_SIZE__ 37 123/);
    socket.close();
  });
});

test('provides a direct graphics PTY without inherited tmux metadata', async () => {
  await withServer({}, async (url) => {
    const socket = await connect(url, '/ws?mode=graphics');
    const output = waitForOutput(socket, 'tmux=unset program=agent-remote');
    socket.send(JSON.stringify({
      type: 'input',
      data: "printf '__GRAPHICS_ENV__ tmux=%s program=%s\\r\\n' \"${TMUX-unset}\" \"$TERM_PROGRAM\"\r",
    }));
    assert.match(await output, /__GRAPHICS_ENV__ tmux=unset program=agent-remote/);
    socket.close();
  });
});

test('configures renderer PTYs for CSS-pixel viewport coordinates', async () => {
  await withServer({}, async (url) => {
    const socket = await connect(url, '/ws?mode=graphics&purpose=renderer');
    const output = waitForOutput(socket, 'scale=1 renderer=1');
    socket.send(JSON.stringify({
      type: 'input',
      data: "printf 'scale=%s renderer=%s\\r\\n' \"$TERMINAL_BROWSER_DISPLAY_SCALE\" \"$AGENT_REMOTE_RENDERER\"\r",
    }));
    assert.match(await output, /scale=1 renderer=1/);
    socket.close();
  });
});

test('starts internal renderers without waiting for the configured login shell', async () => {
  const fixture = mkdtempSync(join(tmpdir(), 'agent-remote-renderer-shell-'));
  const loginShell = join(fixture, 'slow-login-shell');
  const invoked = join(fixture, 'invoked');
  writeFileSync(loginShell, `#!/bin/sh\nprintf invoked > "${invoked}"\nsleep 30\n`);
  chmodSync(loginShell, 0o755);
  try {
    await withServer({ shell: loginShell, shellArgs: ['--login'] }, async (url) => {
      const socket = await connect(url, '/ws?mode=graphics&purpose=renderer&renderer=session%3Aclean-shell');
      const output = waitForOutput(socket, '__CLEAN_RENDERER_SHELL__');
      socket.send(JSON.stringify({
        type: 'input',
        data: "printf '__CLEAN_RENDERER_SHELL__\\r\\n'\r",
      }));
      assert.match(await output, /__CLEAN_RENDERER_SHELL__/);
      assert.throws(() => readFileSync(invoked), /ENOENT/);
      socket.close();
    });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('keeps one stable renderer viewport for desktop and phone observers', () => {
  assert.deepEqual(selectRendererViewport([
    { width: 390, height: 680 },
    { width: 1180, height: 720 },
  ]), { width: 1180, height: 720 });
  assert.deepEqual(selectRendererViewport([
    { width: 390, height: 680 },
  ]), { width: 390, height: 680 });
  assert.deepEqual(selectRendererViewport([], { width: 800, height: 600 }), { width: 800, height: 600 });
});

test('reports a terminal-browser discovery failure instead of loading forever', async () => {
  const fixture = mkdtempSync(join(tmpdir(), 'agent-remote-renderer-launch-'));
  const executable = join(fixture, 'terminal-browser');
  const environmentOutput = join(fixture, 'environment');
  writeFileSync(executable, `#!/bin/sh\nprintf %s \"$TERMINAL_BROWSER_SKIP_GRAPHICS_CHECK\" > \"${environmentOutput}\"\n`);
  chmodSync(executable, 0o755);
  try {
    await withServer({
      listTerminalBrowsers: async () => [],
      rendererDiscoveryAttempts: 2,
      rendererDiscoveryIntervalMs: 1,
    }, async (url) => {
      const socket = await connect(url, '/ws?mode=graphics&purpose=renderer&renderer=session%3Adiscovery-failure');
      const failed = waitForMessage(socket, (message) =>
        message.type === 'renderer-state' && message.state === 'failed');
      socket.send(JSON.stringify({
        type: 'launch',
        argv: [executable, 'open', 'https://example.com'],
      }));
      assert.deepEqual(await failed, {
        type: 'renderer-state',
        state: 'failed',
        message: 'terminal-browser did not register a browser surface',
      });
      await waitForCondition(() => {
        try { return readFileSync(environmentOutput, 'utf8') === '1'; } catch { return false; }
      }, 'renderer launch did not bypass the terminal graphics probe');
      socket.close();
    });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('keeps a keyed renderer alive across websocket reconnects until explicitly closed', async () => {
  await withServer({}, async (url) => {
    const path = '/ws?mode=graphics&purpose=renderer&renderer=builtin%3Ashell';
    const first = await connect(url, path);
    const initialized = waitForOutput(first, '__RENDERER_STATE_SET__');
    first.send(JSON.stringify({
      type: 'input',
      data: "export RENDERER_STATE=persisted; printf '__RENDERER_STATE_SET__\\r\\n'\r",
    }));
    await initialized;
    first.close();
    await new Promise((resolve) => first.once('close', resolve));

    const listed = await (await fetch(`${url}/api/renderers`)).json();
    assert.deepEqual(listed.renderers, [{ key: 'builtin:shell' }]);

    const second = await connect(url, path);
    const persisted = waitForOutput(second, 'renderer=persisted');
    second.send(JSON.stringify({
      type: 'input',
      data: "printf 'renderer=%s\\r\\n' \"$RENDERER_STATE\"\r",
    }));
    assert.match(await persisted, /renderer=persisted/);

    second.send(JSON.stringify({ type: 'close' }));
    await new Promise((resolve) => second.once('close', resolve));
    const closed = await (await fetch(`${url}/api/renderers`)).json();
    assert.deepEqual(closed.renderers, []);
  });
});

test('launches a shared keyed renderer only once when desktop and remote clients attach together', async () => {
  const outputDirectory = mkdtempSync(join(tmpdir(), 'agent-remote-shared-launch-'));
  const outputFile = join(outputDirectory, 'launches');
  try {
    await withServer({}, async (url) => {
      const path = '/ws?mode=graphics&purpose=renderer&renderer=session%3Ashared-launch';
      const first = await connect(url, path);
      const second = await connect(url, path);
      const launch = JSON.stringify({
        type: 'launch',
        argv: ['/bin/sh', '-c', `printf x >> ${outputFile}`],
      });
      first.send(launch);
      second.send(launch);
      await waitForCondition(() => {
        try { return readFileSync(outputFile, 'utf8').length > 0; } catch { return false; }
      }, 'shared renderer did not launch');
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(readFileSync(outputFile, 'utf8'), 'x');
      second.send(JSON.stringify({ type: 'close' }));
      await new Promise((resolve) => second.once('close', resolve));
      first.close();
    });
  } finally {
    rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test('closes the browser automation daemon owned by a renderer', async () => {
  const closed = [];
  let listing = 0;
  await withServer({
    listTerminalBrowsers: async () => {
      listing += 1;
      if (listing < 3) return [];
      return [{
        key: 'fixture-1', socket: '/tmp/missing-terminal-browser.sock', cdpPort: null, tabs: [],
      }];
    },
    closeBrowserAutomationSession: async (browserKey) => closed.push(browserKey),
  }, async (url) => {
    const socket = await connect(url, '/ws?mode=graphics&purpose=renderer&renderer=builtin%3Agraphics');
    socket.send(JSON.stringify({ type: 'launch', argv: ['terminal-browser', '--version'] }));
    await waitForCondition(() => listing >= 3, 'renderer browser ownership was not discovered');
    socket.send(JSON.stringify({ type: 'close' }));
    await new Promise((resolve) => socket.once('close', resolve));
    await waitForCondition(() => closed.length === 1, 'browser automation daemon was not closed');
    assert.deepEqual(closed, ['fixture-1']);
  });
});

test('claims a browser by its renderer PTY instead of another session browser', async () => {
  const fixture = mkdtempSync(join(tmpdir(), 'agent-remote-renderer-owner-'));
  const executable = join(fixture, 'terminal-browser');
  const ttyFile = join(fixture, 'tty');
  writeFileSync(executable, `#!/bin/sh\ntty > "${ttyFile}"\nsleep 30\n`);
  chmodSync(executable, 0o755);
  const closed = [];
  let lastTarget;
  try {
    await withServer({
      listTerminalBrowsers: async () => {
        let tty;
        try { tty = readFileSync(ttyFile, 'utf8').trim(); } catch { return []; }
        return [
          { key: 'other-session', tty: '/dev/not-this-renderer', socket: '/tmp/other.sock', tabs: [] },
          { key: 'owned-session', tty, socket: '/tmp/owned.sock', tabs: [] },
        ];
      },
      closeBrowserAutomationSession: async (browserKey) => closed.push(browserKey),
      rendererDiscoveryAttempts: 500,
      rendererDiscoveryIntervalMs: 5,
      rendererCloseMinimumMs: 20,
      rendererCloseGraceMs: 100,
      rendererClosePollMs: 5,
    }, async (url) => {
      const socket = await connect(url, '/ws?mode=graphics&purpose=renderer&renderer=session%3Aowned-chat');
      socket.send(JSON.stringify({ type: 'launch', argv: [executable, 'open', 'https://example.test'] }));
      await waitForCondition(async () => {
        lastTarget = await (await fetch(`${url}/api/control/browser-target?session=owned-chat`)).json();
        return lastTarget.browserKey === 'owned-session';
      }, () => `renderer claimed another session browser: tty=${readFileSync(ttyFile, 'utf8').trim()} target=${JSON.stringify(lastTarget)}`);
      socket.send(JSON.stringify({ type: 'close' }));
      await new Promise((resolve) => socket.once('close', resolve));
      await waitForCondition(() => closed.length === 1, 'owned automation worker was not closed');
      assert.deepEqual(closed, ['owned-session']);
    });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('cleans a browser worker that registers while its renderer is closing', async () => {
  const fixture = mkdtempSync(join(tmpdir(), 'agent-remote-renderer-late-owner-'));
  const executable = join(fixture, 'terminal-browser');
  const ttyFile = join(fixture, 'tty');
  writeFileSync(executable, `#!/bin/sh\ntty > "${ttyFile}"\nsleep 30\n`);
  chmodSync(executable, 0o755);
  const closed = [];
  let revealBrowser = false;
  try {
    await withServer({
      listTerminalBrowsers: async () => {
        if (!revealBrowser) return [];
        let tty;
        try { tty = readFileSync(ttyFile, 'utf8').trim(); } catch { return []; }
        return [{ key: 'late-session', tty, socket: '/tmp/late.sock', tabs: [] }];
      },
      closeBrowserAutomationSession: async (browserKey) => closed.push(browserKey),
      rendererDiscoveryIntervalMs: 5,
      rendererCloseMinimumMs: 20,
      rendererCloseGraceMs: 100,
      rendererClosePollMs: 5,
    }, async (url) => {
      const socket = await connect(url, '/ws?mode=graphics&purpose=renderer&renderer=session%3Alate-chat');
      socket.send(JSON.stringify({ type: 'launch', argv: [executable, 'open', 'https://example.test'] }));
      await waitForCondition(() => {
        try { return Boolean(readFileSync(ttyFile, 'utf8').trim()); } catch { return false; }
      }, 'renderer PTY was not recorded');
      socket.send(JSON.stringify({ type: 'close' }));
      await new Promise((resolve) => socket.once('close', resolve));
      revealBrowser = true;
      await waitForCondition(() => closed.includes('late-session'), 'late browser worker was not closed');
      assert.deepEqual(closed, ['late-session']);
    });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('reaps an orphaned session renderer without touching another live chat', async () => {
  const live = new Set(['orphaned-chat', 'active-chat']);
  await withServer({
    listWorkspaceSessions: async () => [...live].map((name) => ({
      name, label: name, cwd: process.cwd(), managed: true,
    })),
    sessionRendererSweepIntervalMs: 10,
  }, async (url) => {
    const orphaned = await connect(url, '/ws?mode=graphics&purpose=renderer&renderer=session%3Aorphaned-chat');
    const active = await connect(url, '/ws?mode=graphics&purpose=renderer&renderer=session%3Aactive-chat');
    live.delete('orphaned-chat');
    await waitForCondition(async () => {
      const payload = await (await fetch(`${url}/api/renderers`)).json();
      return !payload.renderers.some((renderer) => renderer.key === 'session:orphaned-chat');
    }, 'orphaned renderer was not reaped');
    const payload = await (await fetch(`${url}/api/renderers`)).json();
    assert.equal(payload.renderers.some((renderer) => renderer.key === 'session:active-chat'), true);
    active.close();
    orphaned.close();
  });
});

test('returns an empty browser registry for a session without its own renderer', async () => {
  await withServer({
    listWorkspaceSessions: async () => [{
      name: 'isolated-chat', label: 'Isolated chat', cwd: process.cwd(), createdAt: Date.now(),
    }],
  }, async (url) => {
    const response = await fetch(`${url}/api/control/browser-state?session=isolated-chat`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { self: null, browsers: [] });
  });
});

test('routes backend split controls to the connected terminal websocket', async () => {
  await withServer({}, async (url) => {
    const socket = await connect(url);
    const initialized = waitForOutput(socket, '__CONTROL_READY__');
    socket.send(JSON.stringify({ type: 'input', data: "printf '__CONTROL_READY__\\r\\n'\r" }));
    await initialized;

    const control = waitForMessage(socket, (message) => message.type === 'control');
    const response = await fetch(`${url}/api/control/split`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ argv: ['terminal-browser', 'open', 'https://example.com'] }),
    });
    assert.equal(response.status, 202);
    assert.deepEqual(await control, {
      type: 'control',
      action: 'open-graphics',
      argv: ['terminal-browser', 'open', 'https://example.com'],
    });
    socket.close();
  });
});

test('rejects websocket clients without the configured token', async () => {
  await withServer({ token: 'secret' }, async (url) => {
    await assert.rejects(connect(url), /401/);
    const socket = await connect(url, '/ws?token=secret');
    const output = waitForOutput(socket, '__AUTHORIZED__');
    socket.send(JSON.stringify({ type: 'input', data: "printf '__AUTHORIZED__\\r\\n'\r" }));
    assert.match(await output, /__AUTHORIZED__/);
    socket.close();
  });
});

test('blocks cross-origin browser websocket connections', async () => {
  await withServer({}, async (url) => {
    await assert.rejects(
      connect(url, '/ws', { headers: { Origin: 'https://evil.example' } }),
      /403/,
    );
    const socket = await connect(url, '/ws', { headers: { Origin: url } });
    socket.close();
  });
});

test('protects session management APIs with token and origin checks', async () => {
  await withServer({ token: 'secret' }, async (url) => {
    assert.equal((await fetch(`${url}/api/sessions`)).status, 401);
    assert.equal((await fetch(`${url}/api/sessions?token=secret`)).status, 200);
    assert.equal((await fetch(`${url}/api/sessions?token=secret`, {
      headers: { Origin: 'https://evil.example' },
    })).status, 403);
  });
});

test('tmux preserves shell state across websocket reconnects', async (context) => {
  if (!commandExists('tmux')) {
    context.skip('tmux is not installed');
    return;
  }

  const session = `agent-remote-test-${process.pid}`;
  try {
    await withServer({ tmuxSession: session }, async (url) => {
      const first = await connect(url);
      await waitForOutput(first, 'online-te');
      first.send(JSON.stringify({ type: 'input', data: 'stty -echo\r' }));
      await new Promise((resolve) => setTimeout(resolve, 50));
      const initialized = waitForOutput(first, '__TMUX_STATE_SET__');
      first.send(JSON.stringify({
        type: 'input',
        data: "export AGENT_REMOTE_SHARED=persisted_pty_state; printf '__TMUX_STATE_SET__\\r\\n'\r",
      }));
      await initialized;
      first.send(JSON.stringify({ type: 'input', data: 'stty echo; clear\r' }));
      await new Promise((resolve) => setTimeout(resolve, 50));
      first.close();
      await new Promise((resolve) => first.once('close', resolve));

      const second = await connect(url);
      const persisted = waitForOutput(second, 'value=persisted_pty_state');
      second.send(JSON.stringify({
        type: 'input',
        data: "printf 'value=%s\\r\\n' \"$AGENT_REMOTE_SHARED\"\r",
      }));
      assert.match(await persisted, /value=persisted_pty_state/);
      second.close();
    });
  } finally {
    try {
      execFileSync('tmux', ['kill-session', '-t', session]);
    } catch {
      // The session may already have ended after a test failure.
    }
  }
});

test('web API browses folders and creates a selectable managed session', async (context) => {
  if (!commandExists('tmux')) {
    context.skip('tmux is not installed');
    return;
  }

  const root = mkdtempSync(join(tmpdir(), 'agent-remote-web-'));
  mkdirSync(join(root, 'project-a'));
  let createdName;
  try {
    await withServer({
      allowedCwdRoots: [root],
      conversationRegistry: {
        read: async () => undefined,
        sendSessionInput: async (session, text) => {
          execFileSync('tmux', ['send-keys', '-t', session.name, '-l', `printf '__MOBILE_INPUT_${text}__\\r\\n'`]);
          execFileSync('tmux', ['send-keys', '-t', session.name, 'Enter']);
        },
      },
    }, async (url) => {
      const browse = await fetch(`${url}/api/directories?path=${encodeURIComponent(root)}`);
      assert.equal(browse.status, 200);
      const directory = await browse.json();
      assert.equal(directory.path, realpathSync(root));
      assert.deepEqual(directory.directories, ['project-a']);

      const blocked = await fetch(`${url}/api/directories?path=${encodeURIComponent('/')}`);
      assert.equal(blocked.status, 400);

      const create = await fetch(`${url}/api/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: `web-${process.pid}`,
          commandLine: "printf '__WEB_SESSION_READY__\\r\\n'",
          cwd: join(root, 'project-a'),
        }),
      });
      const created = await create.json();
      assert.equal(create.status, 201, created.error);
      createdName = created.session.name;

      const listed = await (await fetch(`${url}/api/sessions`)).json();
      assert.ok(listed.sessions.some((session) => session.name === createdName));

      const socket = await connect(url, `/ws?session=${encodeURIComponent(createdName)}`);
      assert.match(await waitForOutput(socket, '__WEB_SESSION_READY__'), /__WEB_SESSION_READY__/);
      const mobileOutput = waitForOutput(socket, '__MOBILE_INPUT_OK__');
      const mobileInput = await fetch(`${url}/api/conversations/${encodeURIComponent(createdName)}/input`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'mobile-1', text: 'OK' }),
      });
      assert.equal(mobileInput.status, 202);
      assert.deepEqual(await mobileInput.json(), { accepted: true, id: 'mobile-1' });
      assert.match(await mobileOutput, /__MOBILE_INPUT_OK__/);
      socket.close();

      const stopped = await fetch(`${url}/api/sessions/${encodeURIComponent(createdName)}`, { method: 'DELETE' });
      assert.equal(stopped.status, 200);
      createdName = undefined;
    });
  } finally {
    if (createdName) {
      try { execFileSync('tmux', ['kill-session', '-t', createdName]); } catch {}
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('workspace stream publishes authoritative mutations without polling', async () => {
  await withServer({
    allowedCwdRoots: [process.cwd()],
    agentDefinitions: [{ id: 'fixture', label: 'Fixture agent', command: 'exec /bin/sh' }],
  }, async (url) => {
    const stream = await fetch(`${url}/api/workspace/stream`);
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get('content-type'), /text\/event-stream/);
    const reader = stream.body.getReader();
    try {
      await readStreamUntil(reader, /event: ready/);
      const created = await fetch(`${url}/api/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Stream project', cwd: process.cwd(), agentId: 'fixture' }),
      });
      assert.equal(created.status, 201);
      const source = await readStreamUntil(reader, /"type":"project-created"/);
      assert.match(source, /event: workspace/);
      assert.match(source, /"deleted":\[\]/);
    } finally {
      await reader.cancel();
    }
  });
});

test('project API persists settings and manages its own chats', async (context) => {
  if (!commandExists('tmux')) {
    context.skip('tmux is not installed');
    return;
  }

  const root = mkdtempSync(join(tmpdir(), 'agent-remote-project-api-'));
  const projectPath = join(root, 'project-a');
  mkdirSync(projectPath);
  let createdName;
  try {
    await withServer({
      allowedCwdRoots: [root],
      agentDefinitions: [{
        id: 'fixture', label: 'Fixture agent',
        command: "printf '__PROJECT_CHAT_READY__\\r\\n'",
      }],
    }, async (url) => {
      const availableAgents = await (await fetch(`${url}/api/agents`)).json();
      assert.deepEqual(availableAgents.agents, [{
        id: 'fixture', label: 'Fixture agent', interactive: true,
      }]);
      const createProject = await fetch(`${url}/api/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd: projectPath, agentId: 'fixture' }),
      });
      const projectPayload = await createProject.json();
      assert.equal(createProject.status, 201, projectPayload.error);
      assert.equal(projectPayload.project.name, 'project-a');
      assert.equal(projectPayload.project.cwd, realpathSync(projectPath));
      assert.equal(projectPayload.project.agentId, 'fixture');
      assert.equal('commandLine' in projectPayload.project, false);

      const createChat = await fetch(`${url}/api/projects/${projectPayload.project.id}/sessions`, { method: 'POST' });
      const chatPayload = await createChat.json();
      assert.equal(createChat.status, 201, chatPayload.error);
      createdName = chatPayload.session.name;

      let listed = await (await fetch(`${url}/api/sessions`)).json();
      const chat = listed.sessions.find((session) => session.name === createdName);
      assert.equal(chat.projectId, projectPayload.project.id);
      assert.equal(chat.autoTitle, true);
      assert.equal(typeof chat.lastActiveAt, 'number');

      const activity = await fetch(`${url}/api/sessions/${encodeURIComponent(createdName)}/activity`, {
        method: 'POST',
      });
      const activityPayload = await activity.json();
      assert.equal(activity.status, 200, activityPayload.error);
      assert.equal(typeof activityPayload.lastActiveAt, 'number');
      listed = await (await fetch(`${url}/api/sessions`)).json();
      assert.equal(
        listed.sessions.find((session) => session.name === createdName).lastActiveAt,
        activityPayload.lastActiveAt,
      );

      const rename = await fetch(`${url}/api/sessions/${encodeURIComponent(createdName)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label: 'Build project dashboard' }),
      });
      assert.deepEqual(await rename.json(), { label: 'Build project dashboard' });
      listed = await (await fetch(`${url}/api/sessions`)).json();
      assert.equal(listed.sessions.find((session) => session.name === createdName).label, 'Build project dashboard');
      assert.equal(listed.sessions.find((session) => session.name === createdName).autoTitle, false);

      const clear = await fetch(`${url}/api/projects/${projectPayload.project.id}/sessions`, { method: 'DELETE' });
      assert.equal(clear.status, 200);
      createdName = undefined;
      listed = await (await fetch(`${url}/api/sessions`)).json();
      assert.equal(listed.sessions.some((session) => session.projectId === projectPayload.project.id), false);

      const remove = await fetch(`${url}/api/projects/${projectPayload.project.id}`, { method: 'DELETE' });
      assert.equal(remove.status, 200);
      const projects = await (await fetch(`${url}/api/projects`)).json();
      assert.equal(projects.projects.some((project) => project.id === projectPayload.project.id), false);
    });
  } finally {
    if (createdName) {
      try { execFileSync('tmux', ['kill-session', '-t', createdName]); } catch {}
    }
    rmSync(root, { recursive: true, force: true });
  }
});
