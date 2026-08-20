import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { createGrokAcpClient } from '../src/conversations/acp-client.js';

function harness() {
  const children = [];
  const requests = [];
  const spawn = (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.stdin.setEncoding('utf8');
    child.stdin.on('data', (chunk) => {
      for (const line of chunk.split('\n').filter(Boolean)) {
        const request = JSON.parse(line);
        requests.push(request);
        if (request.method === 'initialize') reply(child, request.id, { protocolVersion: 1 });
      }
    });
    child.kill = (signal) => { child.killedWith = signal; };
    children.push({ child, command, args, options });
    return child;
  };
  return { spawn, children, requests };
}

function reply(child, id, result) {
  queueMicrotask(() => child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`));
}

function notify(child, sessionId, update, eventId = crypto.randomUUID(), meta = {}) {
  child.stdout.write(`${JSON.stringify({
    jsonrpc: '2.0', method: 'session/update',
    params: { sessionId, update, _meta: { eventId, agentTimestampMs: 123, ...meta } },
  })}\n`);
}

async function waitForRequest(harnessValue, method) {
  const deadline = Date.now() + 1_000;
  while (!harnessValue.requests.some((request) => request.method === method)) {
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${method}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return harnessValue.requests.findLast((request) => request.method === method);
}

test('ACP client initializes once, replays history, deduplicates events, and prompts', async () => {
  const fake = harness();
  const client = createGrokAcpClient({
    spawn: fake.spawn,
    leaderSocket: '/tmp/agent-remote-grok.sock',
    environment: () => ({ AGENT_REMOTE_WEB: '1', AGENT_REMOTE_URL: 'http://127.0.0.1:4321' }),
  });
  const sessionId = '01a015a9-61df-7052-a5d0-17de77a201fa';
  const loading = client.loadSession({ sessionId, cwd: '/tmp/project' });
  const load = await waitForRequest(fake, 'session/load');
  const child = fake.children[0].child;
  notify(child, sessionId, {
    sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hello' },
  }, 'event-1');
  notify(child, sessionId, {
    sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hello' },
  }, 'event-1');
  reply(child, load.id, { _meta: { 'x.ai/sessionDetail': { title: 'ACP chat' } } });
  const snapshot = await loading;
  assert.equal(snapshot.events.length, 1);
  assert.equal(fake.children[0].command, 'grok');
  assert.deepEqual(fake.children[0].args, [
    'agent', '--leader', 'stdio', '--leader-socket', '/tmp/agent-remote-grok.sock',
  ]);
  assert.equal(fake.children[0].options.env.AGENT_REMOTE_WEB, '1');
  assert.equal(fake.children[0].options.env.AGENT_REMOTE_URL, 'http://127.0.0.1:4321');
  assert.equal(fake.children[0].options.stdio.length, 3);

  let streamed;
  const stop = client.watch(sessionId, (next) => { streamed = next; });
  notify(child, sessionId, {
    sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'world' },
  }, 'event-2');
  assert.equal(streamed.events.length, 2);

  const prompting = client.prompt({ sessionId, cwd: '/tmp/project', text: 'next' });
  const prompt = await waitForRequest(fake, 'session/prompt');
  assert.deepEqual(prompt.params.prompt, [{ type: 'text', text: 'next' }]);
  assert.equal(client.read(sessionId).turn.active, true);
  notify(child, sessionId, { sessionUpdate: 'turn_completed', stop_reason: 'end_turn' }, 'turn-finished');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(client.read(sessionId).turn.active, false,
    'turn completion must stop mobile activity even while the prompt RPC is still settling');
  reply(child, prompt.id, { stopReason: 'end_turn' });
  await prompting;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(client.read(sessionId).events.at(-1).params.update.sessionUpdate, 'turn_completed');
  assert.equal(fake.requests.filter((request) => request.method === 'initialize').length, 1);
  assert.equal(fake.requests.filter((request) => request.method === 'session/load').length, 1);
  stop();
  await client.close();
  assert.equal(child.killedWith, 'SIGTERM');
});

test('ACP client settles a replayed turn when session load reaches the persisted boundary', async () => {
  const fake = harness();
  const client = createGrokAcpClient({ spawn: fake.spawn });
  const sessionId = '878167fe-a74b-4c46-986b-d0f1cd0ccf70';
  const loading = client.loadSession({ sessionId, cwd: '/tmp/project' });
  const load = await waitForRequest(fake, 'session/load');
  const child = fake.children[0].child;
  notify(child, sessionId, { sessionUpdate: 'turn_started' }, 'replay-start', { isReplay: true });
  notify(child, sessionId, {
    sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Finished answer' },
  }, 'replay-answer', { isReplay: true });
  assert.equal(client.read(sessionId).turn.active, true);

  reply(child, load.id, { _meta: { 'x.ai/sessionDetail': { title: 'Completed chat' } } });
  const snapshot = await loading;
  assert.equal(snapshot.events.at(-1).params.update.sessionUpdate, 'turn_completed');
  assert.equal(snapshot.turn.active, false,
    'the synthesized persisted boundary must settle the live turn state too');
  await client.close();
});

test('ACP client settles replayed desktop turns even when live metadata follows the replay', async () => {
  const fake = harness();
  const client = createGrokAcpClient({ spawn: fake.spawn });
  const sessionId = '878167fe-a74b-4c46-986b-d0f1cd0ccf71';
  const loading = client.loadSession({ sessionId, cwd: '/tmp/project' });
  const load = await waitForRequest(fake, 'session/load');
  const child = fake.children[0].child;
  notify(child, sessionId, { sessionUpdate: 'turn_started' }, 'desktop-turn', { isReplay: true });
  notify(child, sessionId, {
    sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Desktop answer finished' },
  }, 'desktop-answer', { isReplay: true });
  // Grok can publish fresh capability/session metadata after replaying the
  // durable conversation. That metadata must not make the replay look live.
  notify(child, sessionId, {
    sessionUpdate: 'available_commands_update', availableCommands: [],
  }, 'live-metadata');

  reply(child, load.id, { _meta: { 'x.ai/sessionDetail': { title: 'Desktop chat' } } });
  const snapshot = await loading;
  assert.equal(snapshot.turn.active, false);
  assert.equal(snapshot.events.at(-1).params.update.sessionUpdate, 'turn_completed');
  await client.close();
});

test('ACP client exposes Grok slash commands from live session updates', async () => {
  const fake = harness();
  const client = createGrokAcpClient({ spawn: fake.spawn });
  const sessionId = '01a015a9-61df-7052-a5d0-17de77a201fa';
  const loading = client.loadSession({ sessionId, cwd: '/tmp/project' });
  const load = await waitForRequest(fake, 'session/load');
  const child = fake.children[0].child;
  reply(child, load.id, {});
  await loading;

  notify(child, sessionId, {
    sessionUpdate: 'available_commands_update',
    availableCommands: [
      { name: 'compact', description: 'Compress conversation history', input: { hint: 'optional focus' } },
      { name: 'deep-research', description: 'Research a topic', _meta: { scope: 'grok' } },
      { name: 'spaces are invalid', description: 'Must not be exposed' },
    ],
  });
  assert.deepEqual(client.read(sessionId).controls.commands.options, [
    { name: 'compact', description: 'Compress conversation history', inputHint: 'optional focus', source: 'built-in' },
    { name: 'deep-research', description: 'Research a topic', inputHint: '', source: 'grok' },
  ]);
  await client.close();
});

test('ACP client changes only to an advertised model and updates the session snapshot', async () => {
  const fake = harness();
  const client = createGrokAcpClient({ spawn: fake.spawn });
  const sessionId = '01a015a9-61df-7052-a5d0-17de77a201fa';
  const loading = client.loadSession({ sessionId, cwd: '/tmp/project' });
  const load = await waitForRequest(fake, 'session/load');
  const child = fake.children[0].child;
  reply(child, load.id, {
    models: {
      currentModelId: 'qwen-local',
      availableModels: [
        { modelId: 'qwen-local', name: 'Qwen Local' },
        { modelId: 'grok-4.6', name: 'Grok 4.6', _meta: {
          supportsReasoningEffort: true,
          reasoningEffort: 'high',
          reasoningEfforts: [
            { id: 'high', value: 'high', label: 'High Effort', default: true },
            { id: 'low', value: 'low', label: 'Low Effort', default: false },
          ],
        } },
      ],
    },
    _meta: { 'x.ai/sessionDetail': { currentModelId: 'qwen-local' } },
  });
  await loading;

  const changing = client.setModel({ sessionId, cwd: '/tmp/project', modelId: 'grok-4.6' });
  const request = await waitForRequest(fake, 'session/set_model');
  assert.deepEqual(request.params, { sessionId, modelId: 'grok-4.6' });
  reply(child, request.id, { _meta: { model: { Ok: 'grok-4.6' } } });
  await changing;
  assert.equal(client.read(sessionId).metadata.models.currentModelId, 'grok-4.6');
  assert.equal(client.read(sessionId).metadata._meta['x.ai/sessionDetail'].currentModelId, 'grok-4.6');

  const changingEffort = client.setModel({
    sessionId, cwd: '/tmp/project', modelId: 'grok-4.6', effortId: 'low',
  });
  while (fake.requests.filter((entry) => entry.method === 'session/set_model').length < 2) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const effortRequest = fake.requests.filter((entry) => entry.method === 'session/set_model')[1];
  assert.deepEqual(effortRequest.params, {
    sessionId, modelId: 'grok-4.6', _meta: { reasoningEffort: 'low' },
  });
  reply(child, effortRequest.id, { _meta: { model: { Ok: 'grok-4.6' } } });
  assert.deepEqual(await changingEffort, { accepted: true, modelId: 'grok-4.6', effortId: 'low' });
  assert.equal(client.read(sessionId).metadata.models.availableModels[1]._meta.reasoningEffort, 'low');

  await assert.rejects(
    client.setModel({ sessionId, cwd: '/tmp/project', modelId: 'made-up-model' }),
    { code: 'GROK_ACP_MODEL_INVALID' },
  );
  await assert.rejects(
    client.setModel({ sessionId, cwd: '/tmp/project', modelId: 'grok-4.6', effortId: 'max' }),
    { code: 'GROK_ACP_MODEL_INVALID' },
  );
  assert.equal(fake.requests.filter((entry) => entry.method === 'session/set_model').length, 2);
  await client.close();
});

test('ACP client defers active-turn model and mode choices until before the next prompt', async () => {
  const fake = harness();
  const client = createGrokAcpClient({ spawn: fake.spawn });
  const sessionId = '01a015a9-61df-7052-a5d0-17de77a201fa';
  const loading = client.loadSession({ sessionId, cwd: '/tmp/project' });
  const load = await waitForRequest(fake, 'session/load');
  const child = fake.children[0].child;
  reply(child, load.id, {
    models: {
      currentModelId: 'qwen-local',
      availableModels: [
        { modelId: 'qwen-local', name: 'Qwen Local' },
        { modelId: 'grok-4.6', name: 'Grok 4.6' },
      ],
    },
    _meta: { 'x.ai/sessionDetail': { currentModelId: 'qwen-local' } },
  });
  await loading;

  notify(child, sessionId, {
    sessionUpdate: 'turn_started',
  });
  assert.deepEqual(
    await client.setModel({ sessionId, cwd: '/tmp/project', modelId: 'grok-4.6' }),
    { accepted: true, modelId: 'grok-4.6', pending: true },
  );
  assert.deepEqual(
    await client.setMode({ sessionId, cwd: '/tmp/project', modeId: 'plan' }),
    { accepted: true, modeId: 'plan', pending: true },
  );
  assert.equal(fake.requests.some((entry) => entry.method === 'session/set_model'), false);
  assert.equal(fake.requests.some((entry) => entry.method === 'session/set_mode'), false);
  assert.equal(client.read(sessionId).metadata.models.currentModelId, 'grok-4.6');
  assert.equal(client.read(sessionId).controls.mode.currentId, 'plan');

  const queued = await client.prompt({ sessionId, cwd: '/tmp/project', id: 'next-turn', text: 'next turn' });
  assert.equal(queued.queued, true);
  notify(child, sessionId, { sessionUpdate: 'turn_completed', stop_reason: 'end_turn' });

  const modelRequest = await waitForRequest(fake, 'session/set_model');
  assert.deepEqual(modelRequest.params, { sessionId, modelId: 'grok-4.6' });
  assert.equal(fake.requests.some((entry) => entry.method === 'session/prompt'), false);
  reply(child, modelRequest.id, {});
  const modeRequest = await waitForRequest(fake, 'session/set_mode');
  assert.deepEqual(modeRequest.params, { sessionId, modeId: 'plan' });
  assert.equal(fake.requests.some((entry) => entry.method === 'session/prompt'), false);
  reply(child, modeRequest.id, {});
  const prompt = await waitForRequest(fake, 'session/prompt');
  assert.equal(prompt.params.prompt[0].text, 'next turn');
  assert.ok(fake.requests.indexOf(modelRequest) < fake.requests.indexOf(modeRequest));
  assert.ok(fake.requests.indexOf(modeRequest) < fake.requests.indexOf(prompt));
  reply(child, prompt.id, { stopReason: 'end_turn' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await client.close();
});

test('ACP client keeps follow-ups local until the active turn completes and can steer them', async () => {
  const fake = harness();
  const client = createGrokAcpClient({ spawn: fake.spawn });
  const sessionId = '01a015a9-61df-7052-a5d0-17de77a201fa';
  const loading = client.loadSession({ sessionId, cwd: '/tmp/project' });
  const load = await waitForRequest(fake, 'session/load');
  const child = fake.children[0].child;
  reply(child, load.id, {});
  await loading;

  notify(child, sessionId, {
    sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'external turn' },
  });
  notify(child, sessionId, {
    sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '```go\npackage main' },
  }, 'old-stream-start', { streamStartMs: 1_000, chunkId: 10 });
  const queued = await client.prompt({ sessionId, cwd: '/tmp/project', id: 'queue-1', text: 'follow up' });
  assert.deepEqual(queued, { accepted: true, queued: true, queueId: 'queue-1' });
  assert.equal(fake.requests.some((entry) => entry.method === 'session/prompt'), false);
  assert.deepEqual(client.read(sessionId).queue.map((entry) => entry.text), ['follow up']);

  const steering = client.steerQueuedPrompt({ sessionId, queueId: 'queue-1' });
  const interject = await waitForRequest(fake, '_x.ai/interject');
  assert.deepEqual(interject.params, { sessionId, text: 'follow up' });
  reply(child, interject.id, {});
  await steering;
  assert.deepEqual(client.read(sessionId).queue, []);
  assert.equal(client.read(sessionId).events.some((record) =>
    record.params.update.source === 'steer'), false,
  'the user boundary must wait until Grok switches away from the interrupted stream');

  notify(child, sessionId, {
    sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '\nfunc main() {}\n```' },
  }, 'old-stream-finish', { streamStartMs: 1_000, chunkId: 11 });
  assert.equal(client.read(sessionId).events.some((record) =>
    record.params.update.source === 'steer'), false,
  'late chunks from the original answer must stay before the user boundary');

  notify(child, sessionId, {
    sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Steered response' },
  }, 'new-stream-start', { streamStartMs: 2_000, chunkId: 1 });
  const steeredEvents = client.read(sessionId).events.slice(-4).map((record) => record.params.update);
  assert.deepEqual(steeredEvents[2], {
    sessionUpdate: 'user_message_chunk',
    content: { type: 'text', text: 'follow up' },
    source: 'steer',
    queueId: 'queue-1',
  });
  assert.equal(steeredEvents[3].content.text, 'Steered response');

  await client.prompt({ sessionId, cwd: '/tmp/project', id: 'queue-2', text: 'keep this queued' });
  const failedSteer = client.steerQueuedPrompt({ sessionId, queueId: 'queue-2' });
  const failedInterject = await waitForRequest(fake, '_x.ai/interject');
  child.stdout.write(`${JSON.stringify({
    jsonrpc: '2.0', id: failedInterject.id,
    error: { code: -32_000, message: 'Interject rejected' },
  })}\n`);
  await assert.rejects(failedSteer, /Interject rejected/);
  assert.deepEqual(client.read(sessionId).queue.map((entry) => entry.text), ['keep this queued']);
  assert.equal(client.read(sessionId).events.some((record) =>
    record.params.update.queueId === 'queue-2'), false);
  await client.close();
});

test('ACP client reorders the complete pending prompt queue atomically', async () => {
  const fake = harness();
  const client = createGrokAcpClient({ spawn: fake.spawn });
  const sessionId = '01a015a9-61df-7052-a5d0-17de77a201fa';
  const loading = client.loadSession({ sessionId, cwd: '/tmp/project' });
  const load = await waitForRequest(fake, 'session/load');
  const child = fake.children[0].child;
  reply(child, load.id, {});
  await loading;

  notify(child, sessionId, {
    sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'external turn' },
  });
  for (const id of ['one', 'two', 'three']) {
    await client.prompt({ sessionId, cwd: '/tmp/project', id, text: id });
  }
  assert.deepEqual(client.read(sessionId).queue.map((entry) => entry.id), ['one', 'two', 'three']);
  assert.deepEqual(await client.reorderQueuedPrompts({
    sessionId, queueIds: ['three', 'one', 'two'],
  }), { accepted: true, queueIds: ['three', 'one', 'two'] });
  assert.deepEqual(client.read(sessionId).queue.map((entry) => entry.id), ['three', 'one', 'two']);

  await assert.rejects(client.reorderQueuedPrompts({
    sessionId, queueIds: ['three', 'three', 'two'],
  }), { code: 'GROK_ACP_QUEUE_INVALID' });
  assert.deepEqual(client.read(sessionId).queue.map((entry) => entry.id), ['three', 'one', 'two']);
  await client.close();
});

test('ACP client exposes and cancels an active turn through the standard session notification', async () => {
  const fake = harness();
  const client = createGrokAcpClient({ spawn: fake.spawn });
  const sessionId = '01a015a9-61df-7052-a5d0-17de77a201fa';
  const loading = client.loadSession({ sessionId, cwd: '/tmp/project' });
  const load = await waitForRequest(fake, 'session/load');
  const child = fake.children[0].child;
  reply(child, load.id, {});
  await loading;

  notify(child, sessionId, {
    sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'long task' },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(client.read(sessionId).turn, { active: true, cancelRequested: false, changedAt: 123 });

  assert.deepEqual(await client.cancel({ sessionId, cwd: '/tmp/project' }), {
    accepted: true, active: true,
  });
  const cancellation = fake.requests.findLast((entry) => entry.method === 'session/cancel');
  assert.deepEqual(cancellation, {
    jsonrpc: '2.0', method: 'session/cancel', params: { sessionId },
  });
  assert.deepEqual(client.read(sessionId).turn, { active: true, cancelRequested: true, changedAt: 123 });

  notify(child, sessionId, { sessionUpdate: 'turn_completed', stop_reason: 'cancelled' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(client.read(sessionId).turn, { active: false, cancelRequested: false, changedAt: 123 });
  await client.close();
});

test('ACP client drains queued follow-ups in order and updates real session controls', async () => {
  const fake = harness();
  const client = createGrokAcpClient({ spawn: fake.spawn });
  const sessionId = '01a015a9-61df-7052-a5d0-17de77a201fa';
  const loading = client.loadSession({ sessionId, cwd: '/tmp/project' });
  const load = await waitForRequest(fake, 'session/load');
  const child = fake.children[0].child;
  reply(child, load.id, {});
  await loading;

  assert.equal((await client.prompt({ sessionId, cwd: '/tmp/project', id: 'one', text: 'one' })).queued, false);
  const first = await waitForRequest(fake, 'session/prompt');
  assert.equal((await client.prompt({ sessionId, cwd: '/tmp/project', id: 'two', text: 'two' })).queued, true);
  assert.deepEqual(client.read(sessionId).queue.map((entry) => entry.id), ['two']);
  reply(child, first.id, { stopReason: 'end_turn' });
  const deadline = Date.now() + 1_000;
  while (fake.requests.filter((entry) => entry.method === 'session/prompt').length < 2) {
    if (Date.now() > deadline) assert.fail('Timed out waiting for queued prompt');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const second = fake.requests.filter((entry) => entry.method === 'session/prompt')[1];
  assert.equal(second.params.prompt[0].text, 'two');
  reply(child, second.id, { stopReason: 'end_turn' });
  await new Promise((resolve) => setTimeout(resolve, 5));

  const settingMode = client.setMode({ sessionId, cwd: '/tmp/project', modeId: 'plan' });
  const modeRequest = await waitForRequest(fake, 'session/set_mode');
  assert.deepEqual(modeRequest.params, { sessionId, modeId: 'plan' });
  reply(child, modeRequest.id, {});
  await settingMode;
  let permissionNotice = fake.requests.findLast((entry) => entry.method === '_x.ai/yolo_mode_changed');
  assert.deepEqual(permissionNotice.params, { sessionId, auto_mode: false, ask: true });
  assert.equal(client.read(sessionId).controls.mode.currentId, 'plan');
  assert.equal('permission' in client.read(sessionId).controls, false);

  const settingAuto = client.setMode({ sessionId, cwd: '/tmp/project', modeId: 'auto' });
  const modeDeadline = Date.now() + 1_000;
  while (fake.requests.filter((entry) => entry.method === 'session/set_mode').length < 2) {
    if (Date.now() > modeDeadline) assert.fail('Timed out waiting for default mode');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const defaultModeRequest = fake.requests.filter((entry) => entry.method === 'session/set_mode')[1];
  assert.deepEqual(defaultModeRequest.params, { sessionId, modeId: 'default' });
  reply(child, defaultModeRequest.id, {});
  await settingAuto;
  permissionNotice = fake.requests.findLast((entry) => entry.method === '_x.ai/yolo_mode_changed');
  assert.deepEqual(permissionNotice.params, { sessionId, auto_mode: true, ask: false });
  assert.equal(client.read(sessionId).controls.mode.currentId, 'auto');

  await client.setMode({ sessionId, cwd: '/tmp/project', modeId: 'alwaysApprove' });
  permissionNotice = fake.requests.findLast((entry) => entry.method === '_x.ai/yolo_mode_changed');
  assert.deepEqual(permissionNotice.params, { sessionId, auto_mode: false, ask: false });
  assert.equal(client.read(sessionId).controls.mode.currentId, 'alwaysApprove');

  notify(child, sessionId, { sessionUpdate: 'current_mode_update', currentModeId: 'plan' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(client.read(sessionId).controls.mode.currentId, 'plan');
  await client.close();
});

test('ACP client routes parent and child updates by session id', async () => {
  const fake = harness();
  const client = createGrokAcpClient({ spawn: fake.spawn });
  const parentId = '01a015a9-61df-7052-a5d0-17de77a201fa';
  const childId = '01a015a9-61df-7052-a5d0-17de77a201fb';
  const parentLoad = client.loadSession({ sessionId: parentId, cwd: '/tmp/project' });
  let request = await waitForRequest(fake, 'session/load');
  reply(fake.children[0].child, request.id, {});
  await parentLoad;
  const childLoad = client.loadSession({ sessionId: childId, cwd: '/tmp/project' });
  const deadline = Date.now() + 1_000;
  while (fake.requests.filter((entry) => entry.method === 'session/load').length < 2) {
    if (Date.now() > deadline) assert.fail('Timed out waiting for child load');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  request = fake.requests.filter((entry) => entry.method === 'session/load')[1];
  notify(fake.children[0].child, childId, {
    sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'child live' },
  }, 'child-event');
  reply(fake.children[0].child, request.id, {});
  await childLoad;
  assert.equal(client.read(parentId).events.length, 0);
  assert.equal(client.read(childId).events[0].params.update.content.text, 'child live');
  await client.close();
});

test('ACP client exposes permission requests and returns the selected option', async () => {
  const fake = harness();
  const client = createGrokAcpClient({ spawn: fake.spawn });
  const sessionId = '01a015a9-61df-7052-a5d0-17de77a201fa';
  const loading = client.loadSession({ sessionId, cwd: '/tmp/project' });
  const load = await waitForRequest(fake, 'session/load');
  reply(fake.children[0].child, load.id, {});
  await loading;
  fake.children[0].child.stdout.write(`${JSON.stringify({
    jsonrpc: '2.0', id: 77, method: 'session/request_permission',
    params: {
      sessionId, toolCall: { title: 'Spawn explorer' },
      options: [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' }],
    },
  })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(client.read(sessionId).events.at(-1).params.update.sessionUpdate, 'permission_request');
  await client.respondPermission({ sessionId, permissionId: '77', optionId: 'allow_once' });
  const response = fake.requests.find((request) => request.id === 77 && request.result);
  assert.deepEqual(response.result, { outcome: { outcome: 'selected', optionId: 'allow_once' } });
  assert.equal(client.read(sessionId).events.at(-1).params.update.sessionUpdate, 'permission_resolved');
  await client.close();
});

test('ACP client settles a permission already executed by the Grok UI', async () => {
  const fake = harness();
  const client = createGrokAcpClient({ spawn: fake.spawn });
  const sessionId = '01a015a9-61df-7052-a5d0-17de77a201fa';
  const loading = client.loadSession({ sessionId, cwd: '/tmp/project' });
  const load = await waitForRequest(fake, 'session/load');
  reply(fake.children[0].child, load.id, {});
  await loading;
  const child = fake.children[0].child;

  notify(child, sessionId, {
    sessionUpdate: 'tool_call_update', toolCallId: 'spawn-1',
    title: 'Spawn explorer', status: 'completed', rawOutput: { taskId: 'child-1' },
  }, 'executed-before-permission');
  child.stdout.write(`${JSON.stringify({
    jsonrpc: '2.0', id: 770, method: 'session/request_permission',
    params: {
      sessionId, toolCall: { toolCallId: 'spawn-1', title: 'Spawn explorer' },
      options: [
        { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
        { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
      ],
    },
  })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(fake.requests.find((request) => request.id === 770 && request.result)?.result, {
    outcome: { outcome: 'selected', optionId: 'allow_once' },
  });
  assert.deepEqual(client.read(sessionId).events.at(-1).params.update, {
    sessionUpdate: 'permission_resolved', permissionId: '770', optionId: 'allow_once',
    label: 'Approved in Grok', resolvedBy: 'grok',
  });
  await assert.rejects(
    client.respondPermission({ sessionId, permissionId: '770', optionId: 'allow_always' }),
    { code: 'GROK_ACP_PERMISSION_EXPIRED' },
  );
  await client.close();
});

test('ACP client waits through pending tool updates and settles when Grok starts execution', async () => {
  const fake = harness();
  const client = createGrokAcpClient({ spawn: fake.spawn });
  const sessionId = '01a015a9-61df-7052-a5d0-17de77a201fa';
  const loading = client.loadSession({ sessionId, cwd: '/tmp/project' });
  const load = await waitForRequest(fake, 'session/load');
  reply(fake.children[0].child, load.id, {});
  await loading;
  const child = fake.children[0].child;

  child.stdout.write(`${JSON.stringify({
    jsonrpc: '2.0', id: 771, method: 'session/request_permission',
    params: {
      sessionId, toolCall: { toolCallId: 'tool-live', title: 'Run tool' },
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
    },
  })}\n`);
  notify(child, sessionId, {
    sessionUpdate: 'tool_call_update', toolCallId: 'tool-live', status: 'pending',
  }, 'still-pending');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(fake.requests.some((request) => request.id === 771 && request.result), false);

  notify(child, sessionId, {
    sessionUpdate: 'tool_call_update', toolCallId: 'tool-live', status: 'in_progress',
  }, 'now-running');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(fake.requests.find((request) => request.id === 771 && request.result)?.result, {
    outcome: { outcome: 'selected', optionId: 'allow-once' },
  });
  assert.equal(client.read(sessionId).events.at(-1).params.update.resolvedBy, 'grok');
  await client.close();
});

test('ACP client links a spawned child back to its pending tool before a late permission arrives', async () => {
  const fake = harness();
  const client = createGrokAcpClient({ spawn: fake.spawn });
  const sessionId = '01a015a9-61df-7052-a5d0-17de77a201fa';
  const loading = client.loadSession({ sessionId, cwd: '/tmp/project' });
  const load = await waitForRequest(fake, 'session/load');
  reply(fake.children[0].child, load.id, {});
  await loading;
  const child = fake.children[0].child;

  notify(child, sessionId, {
    sessionUpdate: 'tool_call', toolCallId: 'spawn-late-permission', title: 'spawn_subagent',
    rawInput: { description: 'Inspect permissions', subagent_type: 'explore' },
    _meta: { 'x.ai/tool': { name: 'spawn_subagent', kind: 'task' } },
  }, 'spawn-requested');
  notify(child, sessionId, {
    sessionUpdate: 'subagent_spawned', child_session_id: '01a015a9-61df-7052-a5d0-17de77a201fb',
    description: 'Inspect permissions', subagent_type: 'explore',
  }, 'child-running');
  child.stdout.write(`${JSON.stringify({
    jsonrpc: '2.0', id: 772, method: 'session/request_permission',
    params: {
      sessionId, toolCall: {
        toolCallId: 'spawn-late-permission', title: 'Inspect permissions',
        input: { variant: 'Task', description: 'Inspect permissions', subagent_type: 'explore' },
      },
      options: [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }],
    },
  })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(fake.requests.find((request) => request.id === 772 && request.result)?.result, {
    outcome: { outcome: 'selected', optionId: 'allow_once' },
  });
  assert.equal(client.read(sessionId).events.at(-1).params.update.resolvedBy, 'grok');
  await client.close();
});

test('ACP client exposes Grok questions and responds with accepted or skipped outcomes', async () => {
  const fake = harness();
  const client = createGrokAcpClient({ spawn: fake.spawn });
  const sessionId = '01a015a9-61df-7052-a5d0-17de77a201fa';
  const loading = client.loadSession({ sessionId, cwd: '/tmp/project' });
  const load = await waitForRequest(fake, 'session/load');
  reply(fake.children[0].child, load.id, {});
  await loading;

  const ask = (id, toolCallId = 'ask-1') => fake.children[0].child.stdout.write(`${JSON.stringify({
    jsonrpc: '2.0', id, method: '_x.ai/ask_user_question',
    params: { sessionId, toolCallId, mode: 'default', questions: [{
      question: 'Pick a color', options: [
        { label: 'Red', description: 'Warm', preview: 'red' },
        { label: 'Blue', description: 'Cool' },
      ], multiSelect: false,
    }] },
  })}\n`);
  ask(78);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const requested = client.read(sessionId).events.at(-1).params.update;
  assert.deepEqual(requested, {
    sessionUpdate: 'question_request', questionId: 'ask-1', toolCallId: 'ask-1', mode: 'default',
    questions: [{ question: 'Pick a color', options: [
      { label: 'Red', description: 'Warm', preview: 'red' },
      { label: 'Blue', description: 'Cool' },
    ], multiSelect: false }],
  });
  await client.respondQuestion({ sessionId, questionId: 'ask-1', answers: { 'Pick a color': 'Red' } });
  assert.deepEqual(fake.requests.find((request) => request.id === 78 && request.result).result, {
    outcome: 'accepted', answers: { 'Pick a color': 'Red' },
  });
  assert.deepEqual(client.read(sessionId).events.at(-1).params.update, {
    sessionUpdate: 'question_resolved', questionId: 'ask-1', outcome: 'accepted',
    answers: { 'Pick a color': 'Red' },
  });

  fake.children[0].child.stdout.write(`${JSON.stringify({
    jsonrpc: '2.0', id: 780, method: '_x.ai/ask_user_question',
    params: { sessionId, toolCallId: 'ask-many', mode: 'default', questions: [{
      question: 'Pick test colors', options: [{ label: 'Red', description: 'Warm' }, { label: 'Blue', description: 'Cool' }],
      multiSelect: true,
    }] },
  })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await client.respondQuestion({
    sessionId, questionId: 'ask-many', answers: { 'Pick test colors': 'Red, Blue' },
  });
  assert.deepEqual(fake.requests.find((request) => request.id === 780 && request.result).result, {
    outcome: 'accepted', answers: { 'Pick test colors': 'Red, Blue' },
  });

  ask(781, 'ask-custom');
  await new Promise((resolve) => setTimeout(resolve, 0));
  await client.respondQuestion({
    sessionId, questionId: 'ask-custom', answers: { 'Pick a color': 'A custom ultraviolet shade' },
  });
  assert.deepEqual(fake.requests.find((request) => request.id === 781 && request.result).result, {
    outcome: 'accepted', answers: { 'Pick a color': 'A custom ultraviolet shade' },
  });

  ask(79, 'ask-2');
  await new Promise((resolve) => setTimeout(resolve, 0));
  await client.respondQuestion({ sessionId, questionId: 'ask-2', outcome: 'skip_interview' });
  assert.deepEqual(fake.requests.find((request) => request.id === 79 && request.result).result, { outcome: 'skip_interview' });
  await assert.rejects(
    client.respondQuestion({ sessionId, questionId: 'ask-2', outcome: 'cancelled' }),
    { code: 'GROK_ACP_QUESTION_EXPIRED' },
  );
  await client.close();
});

test('ACP client exposes Grok plan review and sends feedback before resolving it', async () => {
  const fake = harness();
  const client = createGrokAcpClient({ spawn: fake.spawn });
  const sessionId = '01a015a9-61df-7052-a5d0-17de77a201fa';
  const loading = client.loadSession({ sessionId, cwd: '/tmp/project' });
  const load = await waitForRequest(fake, 'session/load');
  reply(fake.children[0].child, load.id, {});
  await loading;

  fake.children[0].child.stdout.write(`${JSON.stringify({
    jsonrpc: '2.0', id: 790, method: '_x.ai/exit_plan_mode',
    params: {
      sessionId, toolCallId: 'exit-plan-1',
      planContent: '# Plan\n\n1. Inspect the project\n2. Implement the change',
    },
  })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(client.read(sessionId).events.at(-1).params.update, {
    sessionUpdate: 'plan_review_request', reviewId: 'exit-plan-1', toolCallId: 'exit-plan-1',
    planContent: '# Plan\n\n1. Inspect the project\n2. Implement the change',
  });

  await client.respondPlanReview({
    sessionId, reviewId: 'exit-plan-1', outcome: 'cancelled',
    feedback: '@plan.md:3\nExplain why this step is needed.',
  });
  const interjectionIndex = fake.requests.findIndex((request) => request.method === '_x.ai/interject');
  const resolutionIndex = fake.requests.findIndex((request) => request.id === 790 && request.result);
  assert.ok(interjectionIndex >= 0 && interjectionIndex < resolutionIndex);
  assert.deepEqual(fake.requests[interjectionIndex].params, {
    sessionId, text: '@plan.md:3\nExplain why this step is needed.',
  });
  assert.deepEqual(fake.requests[resolutionIndex].result, { outcome: 'cancelled' });
  assert.deepEqual(client.read(sessionId).events.at(-1).params.update, {
    sessionUpdate: 'plan_review_resolved', reviewId: 'exit-plan-1', outcome: 'cancelled',
    feedback: '@plan.md:3\nExplain why this step is needed.',
  });

  fake.children[0].child.stdout.write(`${JSON.stringify({
    jsonrpc: '2.0', id: 791, method: 'x.ai/exit_plan_mode',
    params: { sessionId, toolCallId: 'exit-plan-2', planContent: '# Revised plan' },
  })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await client.respondPlanReview({ sessionId, reviewId: 'exit-plan-2', outcome: 'approved' });
  assert.deepEqual(fake.requests.find((request) => request.id === 791 && request.result).result, {
    outcome: 'approved',
  });
  await assert.rejects(
    client.respondPlanReview({ sessionId, reviewId: 'exit-plan-2', outcome: 'abandoned' }),
    { code: 'GROK_ACP_PLAN_EXPIRED' },
  );
  await client.close();
});
