import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentCatalog } from '../src/agents.js';

test('ships only Grok in the production agent catalog', () => {
  const catalog = createAgentCatalog();
  assert.deepEqual(catalog.list(), [{
    id: 'grok', label: 'Grok', providerId: 'grok', interactive: true,
  }]);
  assert.equal(catalog.get('grok').command, 'grok');
  assert.equal(catalog.defaultId, 'grok');
});

test('supports injected agents without exposing their launch commands', () => {
  const catalog = createAgentCatalog([
    { id: 'fixture', label: 'Fixture', command: 'exec /bin/sh', interactive: false },
  ]);
  assert.deepEqual(catalog.list(), [{
    id: 'fixture', label: 'Fixture', providerId: undefined, interactive: false,
  }]);
  assert.equal(catalog.get('fixture').command, 'exec /bin/sh');
});
