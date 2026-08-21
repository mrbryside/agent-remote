import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createMobileActivityStore,
  hasActivityAfterDismissal,
} from '../public/mobile-activity-state.js';
import { composerCompletion, rankedCommands } from '../public/mobile-composer-model.js';
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
  selectRendererViewport,
} from '../src/server/renderer-protocol.js';

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
  assert.deepEqual(selectRendererViewport([
    { width: 390, height: 844 }, { width: 1440, height: 900 },
  ]), { width: 1440, height: 900 });
});
