import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  createMobileActivityStore,
  hasActivityAfterDismissal,
} from '../public/mobile-activity-state.js';
import {
  composerCompletion,
  rankedCommands,
  shellComposerMessage,
  shellComposerState,
} from '../public/mobile-composer-model.js';
import { pendingMessageMatchesItem } from '../public/mobile-pending-message.js';
import {
  createCompactStreamBatcher,
  preserveNewerStreamingText,
} from '../public/mobile-stream-batcher.js';
import { createTerminalSnapshotCache } from '../public/terminal-snapshots.js';
import {
  authoritativeTurn,
  contextUsage,
  isGrokSessionId,
  modelControls,
} from '../src/conversations/grok-state.js';
import {
  browserVirtualKeyCode,
  normalizeBrowserCursor,
  rendererScale,
  selectRendererViewport,
} from '../src/server/renderer-protocol.js';
import { compactConversationStreamEvent } from '../src/server/conversation-stream.js';

function memoryStorage(seed = {}) {
  const values = new Map(Object.entries(seed));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

test('mobile activity state persists per session and recognises durable subagent aliases', () => {
  const store = createMobileActivityStore(memoryStorage());
  const snapshot = { version: 1, browser: false, plan: '', subagents: ['call-1', 'thread-1'] };
  store.saveActivity('chat one', snapshot);
  store.savePlan('chat one', 'plan-1');

  assert.deepEqual(store.loadActivity('chat one'), snapshot);
  assert.equal(store.loadPlan('chat one'), 'plan-1');
  assert.equal(store.loadActivity('chat two'), undefined);
  assert.equal(hasActivityAfterDismissal({
    dismissed: snapshot,
    current: { ...snapshot },
    subagentAliases: [['call-1', 'thread-1']],
  }), false);
  assert.equal(hasActivityAfterDismissal({
    dismissed: snapshot,
    current: { ...snapshot, browser: true },
    subagentAliases: [['call-1', 'thread-1']],
  }), true);
  assert.equal(hasActivityAfterDismissal({
    dismissed: snapshot,
    current: snapshot,
    subagentAliases: [['call-2', 'thread-2']],
  }), true);
});

test('mobile composer helpers detect completions and rank exact and fuzzy commands', () => {
  assert.deepEqual(composerCompletion('hello\n/run', 10), {
    kind: 'command', query: 'run', start: 6, end: 10,
  });
  assert.deepEqual(composerCompletion('read @src/app', 13), {
    kind: 'file', query: 'src/app', start: 5, end: 13,
  });
  const commands = [{ name: 'restart' }, { name: 'reset' }, { name: 'status' }];
  assert.deepEqual(rankedCommands(commands, 'reset').map(({ name }) => name), ['reset']);
  assert.deepEqual(rankedCommands(commands, 'rst').map(({ name }) => name), ['restart', 'reset']);
  assert.deepEqual(shellComposerState('!echo hello'), { active: true, value: 'echo hello' });
  assert.deepEqual(shellComposerState('echo !', false), { active: false, value: 'echo !' });
  assert.deepEqual(shellComposerState('!important', true), { active: true, value: '!important' });
  assert.equal(shellComposerMessage(' echo hello ', true), '!echo hello');
  assert.equal(shellComposerMessage('', true), '');
});

test('pending attachment batches reconcile against the stored markdown message', () => {
  const pending = {
    text: '',
    baselineItemIds: ['old-message'],
    attachments: [
      { id: 'image-1', name: 'one.png' },
      { id: 'image-2', name: 'two.png' },
      { id: 'image-3', name: 'three.png' },
    ],
  };
  assert.equal(pendingMessageMatchesItem(pending, {
    id: 'stored-message', type: 'message', role: 'user',
    text: '![one.png](/tmp/one.png)\n![two.png](/tmp/two.png)\n![three.png](/tmp/three.png)',
  }), true);
  assert.equal(pendingMessageMatchesItem(pending, {
    id: 'stored-message', type: 'message', role: 'user',
    text: '![one.png](/tmp/one.png)\n![two.png](/tmp/two.png)',
  }), false);
  assert.equal(pendingMessageMatchesItem(pending, {
    id: 'old-message', type: 'message', role: 'user',
    text: '![one.png](/tmp/one.png)\n![two.png](/tmp/two.png)\n![three.png](/tmp/three.png)',
  }), false);
});

test('compact conversation chunks paint once per render tick without losing order', () => {
  const callbacks = new Map();
  const cancelled = [];
  const flushed = [];
  let nextFrame = 1;
  const batcher = createCompactStreamBatcher({
    requestFrame(callback) {
      const id = nextFrame++;
      callbacks.set(id, callback);
      return id;
    },
    cancelFrame(id) {
      cancelled.push(id);
      callbacks.delete(id);
    },
    onFlush(stream) { flushed.push(stream); },
  });

  batcher.push({ kind: 'agent_message_chunk', threadId: 'root', messageId: 'answer', delta: '1.' });
  batcher.push({ kind: 'agent_message_chunk', threadId: 'root', messageId: 'answer', delta: ' First\n' });
  batcher.push({ kind: 'agent_message_chunk', threadId: 'root', messageId: 'answer', delta: '2. Second' });
  assert.equal(callbacks.size, 1);
  callbacks.values().next().value();
  assert.deepEqual(flushed, [{
    kind: 'agent_message_chunk', threadId: 'root', messageId: 'answer',
    delta: '1. First\n2. Second',
  }]);

  batcher.push({ kind: 'agent_message_chunk', threadId: 'root', messageId: 'next', delta: 'new' });
  batcher.discard();
  assert.equal(flushed.length, 1);
  assert.ok(cancelled.length >= 1);
});

test('compact thought chunks batch by their item identity without merging into answer chunks', () => {
  const callbacks = new Map();
  const flushed = [];
  let nextFrame = 1;
  const batcher = createCompactStreamBatcher({
    requestFrame(callback) { callbacks.set(nextFrame, callback); return nextFrame++; },
    cancelFrame(id) { callbacks.delete(id); },
    onFlush(stream) { flushed.push(stream); },
  });
  batcher.push({
    kind: 'agent_thought_chunk', threadId: 'root', itemId: 'thought-1', delta: 'Line one.\n',
  });
  batcher.push({
    kind: 'agent_thought_chunk', threadId: 'root', itemId: 'thought-1', delta: 'Line two.',
  });
  batcher.push({
    kind: 'agent_message_chunk', threadId: 'root', itemId: 'answer-1', messageId: 'answer-1', delta: 'Done.',
  });
  assert.deepEqual(flushed, [{
    kind: 'agent_thought_chunk', threadId: 'root', itemId: 'thought-1',
    delta: 'Line one.\nLine two.',
  }]);
  callbacks.values().next().value();
  assert.equal(flushed[1].kind, 'agent_message_chunk');
  assert.equal(flushed[1].delta, 'Done.');
});

test('conversation transports compact repeated thought chunks but send the answer transition in full', () => {
  const thoughtConversation = {
    thread: { id: 'root' },
    items: [{ id: 'thought-1', type: 'thought', status: 'working', text: 'One' }],
  };
  const first = compactConversationStreamEvent({
    conversation: thoughtConversation,
    stream: { kind: 'agent_thought_chunk', delta: 'One' },
  });
  assert.equal(first.outgoing.conversation, thoughtConversation);
  assert.equal(first.outgoing.stream.itemId, 'thought-1');
  const second = compactConversationStreamEvent({
    conversation: thoughtConversation,
    stream: { kind: 'agent_thought_chunk', delta: ' two' },
  }, first.streamKey);
  assert.equal(second.outgoing.conversation, undefined);
  assert.equal(second.outgoing.stream.itemId, 'thought-1');

  const answerConversation = {
    thread: { id: 'root' },
    items: [
      { id: 'thought-1', type: 'thought', status: 'completed', text: 'One two' },
      { id: 'answer-1', type: 'message', role: 'assistant', text: 'Done' },
    ],
  };
  const answer = compactConversationStreamEvent({
    conversation: answerConversation,
    stream: { kind: 'agent_message_chunk', delta: 'Done' },
  }, second.streamKey);
  assert.equal(answer.outgoing.conversation, answerConversation,
    'the first answer frame must carry the completed thought lifecycle');
  assert.equal(answer.outgoing.stream.itemId, 'answer-1');
  assert.equal(answer.outgoing.stream.messageId, 'answer-1');
});

test('mobile thought detail wraps vertically inside one capped scrolling panel', async () => {
  const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.mobile-event-thought > \.mobile-event-panel \{[^}]*max-height:[^}]*overflow-x: hidden;[^}]*overflow-y: auto;/);
  assert.match(css, /\.mobile-event-thought > \.mobile-event-panel \.mobile-event-detail pre \{[^}]*max-height: none;[^}]*overflow: visible;[^}]*overflow-wrap: anywhere;[^}]*white-space: pre-wrap;/);
});

test('compact stream bursts drain in bounded Markdown line batches before settling', () => {
  const callbacks = [];
  const flushed = [];
  let idle = 0;
  const batcher = createCompactStreamBatcher({
    requestFrame(callback) { callbacks.push(callback); return callbacks.length; },
    cancelFrame() {},
    onFlush(stream) { flushed.push(stream.delta); },
    onIdle() { idle += 1; },
    maxBreaks: 2,
    maxChars: 1_000,
  });
  batcher.push({
    kind: 'agent_message_chunk', threadId: 'root', messageId: 'answer',
    delta: 'Intro\n\n1. First\n2. Second\n3. Third\n',
  });
  assert.equal(batcher.hasPending(), true);
  callbacks.shift()();
  assert.deepEqual(flushed, ['Intro\n\n']);
  assert.equal(batcher.hasPending(), true);
  callbacks.shift()();
  assert.deepEqual(flushed, ['Intro\n\n', '1. First\n2. Second\n']);
  callbacks.shift()();
  assert.deepEqual(flushed, ['Intro\n\n', '1. First\n2. Second\n', '3. Third\n']);
  assert.equal(batcher.hasPending(), false);
  assert.equal(idle, 1);
});

test('active fallback snapshots cannot roll streaming assistant text backward', () => {
  const previous = {
    thread: { id: 'root' }, activity: { active: true },
    items: [{ id: 'answer', type: 'message', role: 'assistant', text: 'Intro\n\n1. First\n2. Second' }],
  };
  const stale = {
    thread: { id: 'root' }, activity: { active: true },
    items: [{ id: 'answer', type: 'message', role: 'assistant', text: 'Intro1. First' }],
  };
  assert.equal(preserveNewerStreamingText(previous, stale).items[0].text, previous.items[0].text);

  const extension = {
    ...stale,
    items: [{ ...stale.items[0], text: `${previous.items[0].text}\n3. Third` }],
  };
  assert.equal(preserveNewerStreamingText(previous, extension), extension);
  assert.equal(
    preserveNewerStreamingText(previous, extension, 'answer').items[0].text,
    previous.items[0].text,
  );

  const completed = { ...stale, activity: { active: false } };
  assert.equal(preserveNewerStreamingText(previous, completed), completed);
});

test('terminal snapshot cache restores ANSI screens and removes persisted entries', () => {
  const storage = memoryStorage({
    snapshots: JSON.stringify({
      chat: { format: 2, ansiLines: ['hello'], rows: 1, cols: 20, cursorRow: 1, cursorColumn: 6, savedAt: 1 },
    }),
  });
  const cache = createTerminalSnapshotCache({ storage, key: 'snapshots' });
  assert.match(cache.restoreSequence(cache.snapshots.get('chat')), /hello/);
  cache.remove('chat');
  assert.equal(cache.snapshots.has('chat'), false);
  assert.deepEqual(JSON.parse(storage.getItem('snapshots')), {});
});

test('Grok state helpers validate sessions and derive model context metadata', () => {
  assert.equal(isGrokSessionId('12345678-1234-1234-1234-123456789abc'), true);
  assert.equal(isGrokSessionId('../not-a-session'), false);
  assert.equal(authoritativeTurn(
    { turn: { active: true, changedAt: 10 } },
    { active: false, changedAt: 11 },
  ), false);

  const controls = modelControls({ models: {
    currentModelId: 'grok-4',
    availableModels: [{
      modelId: 'grok-4',
      name: 'Grok 4',
      _meta: { totalContextTokens: 200_000 },
    }],
  } });
  assert.equal(controls.currentId, 'grok-4');
  assert.deepEqual(contextUsage({ contextTokensUsed: 50_000 }, controls), {
    usedTokens: 50_000,
    windowTokens: 200_000,
    usagePercent: 25,
  });
});

test('renderer protocol helpers normalize browser input and keep a stable viewport', () => {
  assert.equal(browserVirtualKeyCode({ code: 'ArrowDown', key: 'ArrowDown' }), 40);
  assert.equal(normalizeBrowserCursor('pointer'), 'pointer');
  assert.equal(normalizeBrowserCursor('made-up-cursor'), 'default');
  assert.equal(rendererScale(undefined), 1);
  assert.equal(rendererScale(1.9), 2);
  assert.equal(rendererScale(3), 3);
  assert.equal(rendererScale(4), 3);
  assert.deepEqual(selectRendererViewport([
    { width: 390, height: 844 }, { width: 1440, height: 900 },
  ]), { width: 1440, height: 900 });
});
