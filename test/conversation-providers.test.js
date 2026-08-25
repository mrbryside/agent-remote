import assert from 'node:assert/strict';
import test from 'node:test';
import { createGrokConversationProvider } from '../src/conversations/grok.js';
import { createConversationRegistry } from '../src/conversations/registry.js';

async function fixture() {
  const cwd = '/tmp/agent-remote-acp-workspace';
  const parentId = '01a01316-78c6-74c1-90eb-5461e8ff4f40';
  const childId = '01a01316-a460-7503-a1a6-45f23d2fc6ca';
  const parentUpdates = [
    { timestamp: 1, params: { update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Make it mobile' } } } },
    { timestamp: 2, params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'I will inspect it. ' } } } },
    { timestamp: 3, params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Then build it.' } } } },
    { timestamp: 4, params: { update: { sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'list_dir', rawInput: { target_directory: '/tmp/project' }, _meta: { 'x.ai/tool': { name: 'list_dir', kind: 'list', label: 'List Files' } } } } },
    { timestamp: 4, params: { update: { sessionUpdate: 'tool_call', toolCallId: 'tool-2', title: 'read_file', rawInput: { target_file: '/tmp/project/package.json' }, _meta: { 'x.ai/tool': { name: 'read_file', kind: 'read', label: 'Read' } } } } },
    { timestamp: 4.05, params: { update: { sessionUpdate: 'tool_call', toolCallId: 'tool-3', title: 'read_file', rawInput: { target_file: '/tmp/project/README.md' }, _meta: { 'x.ai/tool': { name: 'read_file', kind: 'read', label: 'Read' } } } } },
    { timestamp: 4.1, params: { update: { sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed', locations: [{ path: '/tmp/project' }], content: [{ type: 'content', content: { type: 'text', text: 'Listed project' } }] } } },
    { timestamp: 4.1, params: { update: { sessionUpdate: 'tool_call_update', toolCallId: 'tool-2', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'Read package' } }] } } },
    { timestamp: 4.1, params: { update: { sessionUpdate: 'tool_call_update', toolCallId: 'tool-3', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'Read readme' } }] } } },
    { timestamp: 4.2, params: { update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'I should verify the result.' } } } },
    { timestamp: 4.3, params: { update: { sessionUpdate: 'plan', entries: [{ content: 'Inspect', status: 'completed', priority: 'high' }, { content: 'Build', status: 'in_progress', priority: 'medium' }] } } },
    { timestamp: 4.4, params: { update: { sessionUpdate: 'goal_updated', goal_id: 'goal-1', objective: 'Ship mobile events', status: 'active', phase: 'executing', completed_deliverables: 1, total_deliverables: 2, tokens_used: 100 } } },
    { timestamp: 4.5, params: { update: { sessionUpdate: 'hook_execution', event_name: 'after_tool', runs: [{ name: 'lint', status: { status: 'completed' } }] } } },
    { timestamp: 4.55, params: { update: { sessionUpdate: 'hook_execution', event_name: 'after_write', runs: [{ name: 'verify', status: { status: 'failed', error: 'Verification failed' } }] } } },
    { timestamp: 4.6, params: { update: { sessionUpdate: 'current_mode_update', currentModeId: 'build' } } },
    { timestamp: 4.7, params: { update: { sessionUpdate: 'retry_state', attempt: 1, max_retries: 3, reason: 'Temporary failure' } } },
    { timestamp: 4.8, params: { update: { sessionUpdate: 'session_recap', summary: 'Work so far', auto: true } } },
    { timestamp: 4.9, params: { update: { sessionUpdate: 'task_backgrounded', task_id: 'task-1', description: 'Run checks', command: 'npm test', cwd } } },
    { timestamp: 4.95, params: { update: { sessionUpdate: 'task_completed', task_snapshot: { task_id: 'task-1', description: 'Run checks', command: 'npm test', cwd, completed: true, exit_code: 0, output: 'all green' } } } },
    { timestamp: 4.99, params: { update: { sessionUpdate: 'future_event', value: 'kept visible' } } },
    { timestamp: 5, params: { update: { sessionUpdate: 'tool_call', toolCallId: 'spawn-1', title: 'spawn_subagent', rawInput: { description: 'Explore project', subagent_type: 'explore', model: 'qwen-local' }, _meta: { 'x.ai/tool': { name: 'spawn_subagent', kind: 'task', label: 'Subagent' } } } } },
    { timestamp: 5.1, params: { update: { sessionUpdate: 'subagent_spawned', child_session_id: childId, description: 'Explore project', subagent_type: 'explore', model: 'qwen-local' } } },
    { timestamp: 5.2, params: { update: { sessionUpdate: 'tool_call_update', toolCallId: 'spawn-1', status: 'completed', rawOutput: `Subagent started in background.\nsubagent_id: ${childId}` } } },
    { timestamp: 6, params: { update: { sessionUpdate: 'subagent_finished', child_session_id: childId, status: 'completed', output: 'Child result', tool_calls: 2, turns: 1 } } },
    { timestamp: 6.1, params: { update: { sessionUpdate: 'tool_call', toolCallId: 'poll-1', rawInput: { task_ids: [childId], timeout_ms: 30_000 }, _meta: { 'x.ai/tool': { name: 'get_command_or_subagent_output', kind: 'background_task_action', label: 'Background task' } } } } },
    { timestamp: 6.2, params: { update: { sessionUpdate: 'tool_call_update', toolCallId: 'poll-1', status: 'completed', title: '[subagent:explore] Explore project', rawOutput: { type: 'TaskOutput', Result: { task_id: childId, status: 'completed', output: 'Child result' } } } } },
    { timestamp: 7, params: { update: { sessionUpdate: 'turn_completed' } } },
  ];
  const childUpdates = [
    { timestamp: 1, params: { update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Inspect files' } } } },
    { timestamp: 2, params: { update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Looking through files.' } } } },
    { timestamp: 3, params: { update: { sessionUpdate: 'tool_call', toolCallId: 'child-tool', title: 'Read files' } } },
    { timestamp: 4, params: { update: { sessionUpdate: 'tool_call_update', toolCallId: 'child-tool', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'Found files' } }] } } },
    { timestamp: 5, params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } } } },
    { timestamp: 6, params: { update: { sessionUpdate: 'turn_completed', stop_reason: 'end_turn' } } },
  ];
  const snapshots = new Map([
    [parentId, {
      sessionId: parentId, events: parentUpdates,
      metadata: { _meta: { 'x.ai/sessionDetail': {
        title: 'Build mobile UI', kind: 'grok-build-plan', currentModelId: 'grok-code-fast-1',
      } } },
    }],
    [childId, {
      sessionId: childId, events: childUpdates,
      metadata: { _meta: { 'x.ai/sessionDetail': {
        title: 'Explore the project', kind: 'explore', currentModelId: 'qwen-local',
      } } },
    }],
  ]);
  const listeners = new Map();
  const prompts = [];
  const questionResponses = [];
  const planReviewResponses = [];
  const modelChanges = [];
  const cancellations = [];
  const lifecycleSyncs = [];
  const acpClient = {
    loadSession: async ({ sessionId }) => snapshots.get(sessionId) ?? (() => { throw new Error('unknown session'); })(),
    read: (sessionId) => snapshots.get(sessionId),
    watch(sessionId, listener) {
      const values = listeners.get(sessionId) || new Set();
      values.add(listener);
      listeners.set(sessionId, values);
      return () => values.delete(listener);
    },
    async prompt(input) { prompts.push(input); },
    async setModel(input) {
      modelChanges.push(input);
      const metadata = snapshots.get(input.sessionId).metadata;
      metadata.models.currentModelId = input.modelId;
      metadata._meta['x.ai/sessionDetail'].currentModelId = input.modelId;
      return { accepted: true, modelId: input.modelId };
    },
    async cancel(input) { cancellations.push(input); return { accepted: true, active: true }; },
    synchronizeTurn(input) { lifecycleSyncs.push(input); return { applied: true, active: input.active }; },
    async respondQuestion(input) { questionResponses.push(input); },
    async respondPlanReview(input) { planReviewResponses.push(input); },
    append(sessionId, record) {
      snapshots.get(sessionId).events.push(record);
      for (const listener of listeners.get(sessionId) || []) listener(snapshots.get(sessionId));
    },
    publish(sessionId) {
      for (const listener of listeners.get(sessionId) || []) listener(snapshots.get(sessionId));
    },
    close: async () => {},
  };
  return {
    cwd, parentId, childId, acpClient, prompts, questionResponses, planReviewResponses,
    modelChanges, cancellations, lifecycleSyncs, snapshots,
  };
}

test('Grok provider maps a managed tmux process to messages and subagents', async () => {
  const data = await fixture();
  const provider = createGrokConversationProvider({
    acpClient: data.acpClient,
  });
  const registry = createConversationRegistry({ providers: [provider] });
  const result = await registry.read({
    name: 'ar-chat', cwd: data.cwd,
    command: `grok --leader --session-id ${data.parentId}`, conversationThreadId: data.parentId,
  });

  assert.equal(result.provider.id, 'grok');
  assert.equal(result.thread.id, data.parentId);
  assert.equal(result.thread.title, 'Build mobile UI');
  assert.equal(result.thread.status, 'idle');
  assert.deepEqual(result.items.filter((item) => item.type === 'message').map(({ role, text }) => ({ role, text })), [
    { role: 'user', text: 'Make it mobile' },
    { role: 'assistant', text: 'I will inspect it. Then build it.' },
  ]);
  assert.deepEqual(result.children.map(({ id, title, status }) => ({ id, title, status })), [
    { id: data.childId, title: 'Explore project', status: 'completed' },
  ]);
  const subagents = result.items.filter((item) => item.type === 'subagent');
  assert.equal(subagents.length, 1);
  assert.deepEqual({
    id: subagents[0].id,
    threadId: subagents[0].threadId,
    phase: subagents[0].phase,
    status: subagents[0].status,
    output: subagents[0].output,
  }, {
    id: 'subagent-call-spawn-1',
    threadId: data.childId,
    phase: 'done',
    status: 'completed',
    output: 'Child result',
  });
  assert.ok(!result.items.some((item) => item.type === 'tool' &&
    ['spawn_subagent', 'get_command_or_subagent_output'].includes(item.name)));
  for (const type of ['thought', 'tool_group', 'plan', 'goal', 'event', 'task', 'subagent']) {
    assert.ok(result.items.some((item) => item.type === type), `missing ${type} event`);
  }
  assert.ok(!result.items.some((item) => item.type === 'turn' && item.status !== 'retrying'));
  assert.deepEqual(result.items.filter((item) => item.type === 'recap').map(({ id, text, auto, status }) => ({
    id, text, auto, status,
  })), [{ id: 'recap-16', text: 'Work so far', auto: true, status: 'completed' }]);
  assert.equal(result.recap.text, 'Work so far');
  assert.ok(result.items.some((item) => item.type === 'event' && item.kind === 'hook'), 'missing hook event');
  assert.deepEqual(result.items.filter((item) => item.type === 'turn' && item.status === 'retrying').map((item) => ({
    title: item.title, status: item.status, text: item.text,
  })), [{
    title: 'Retrying model response (1/3)', status: 'retrying', text: 'Temporary failure',
  }]);
  assert.ok(!result.items.some((item) => item.type === 'event' && ['mode', 'unknown'].includes(item.kind)));
  const hookEvents = result.items.filter((item) => item.type === 'event' && item.kind === 'hook');
  assert.equal(hookEvents.length, 1);
  assert.equal(hookEvents[0].status, 'failed');
  assert.match(hookEvents[0].text, /Verification failed/);
  const toolGroup = result.items.find((item) => item.type === 'tool_group');
  assert.equal(toolGroup.status, 'completed');
  assert.equal(toolGroup.title, 'Listed 1 dir, Read 2 files');
  assert.deepEqual(toolGroup.tools.map((tool) => tool.subject), ['project', 'package.json', 'README.md']);
  assert.deepEqual(toolGroup.tools[0].locations, ['/tmp/project']);
  const session = {
    cwd: data.cwd, command: `grok --leader --session-id ${data.parentId}`,
    conversationThreadId: data.parentId,
  };
  await registry.sendSessionInput(session, 'hello from phone');
  assert.equal(data.prompts[0].text, 'hello from phone');
  await registry.controlGoal(session, 'pause');
  assert.equal(data.prompts[1].text, '/goal pause');

  data.acpClient.append(data.parentId, {
    timestamp: 8, params: { update: {
      sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '/goal clear' },
    } },
  });
  data.acpClient.append(data.parentId, {
    timestamp: 8.1, params: { update: {
      sessionUpdate: 'goal_updated', goal_id: '', objective: '', status: 'cleared', phase: 'idle',
    } },
  });
  const cleared = await registry.read(session);
  assert.ok(!cleared.items.some((item) => item.type === 'goal'));
  assert.ok(!cleared.items.some((item) => item.type === 'message' && item.text.includes('/goal clear')));
});

test('Grok provider identifies SKILL.md reads as skill activity', async () => {
  const data = await fixture();
  data.snapshots.get(data.parentId).events = [
    { timestamp: 1, params: { update: {
      sessionUpdate: 'tool_call', toolCallId: 'skill-1', title: 'read_file',
      rawInput: { target_file: '/Users/test/.agents/skills/terminal-browser/SKILL.md' },
      _meta: { 'x.ai/tool': { name: 'read_file', kind: 'read', label: 'Read' } },
    } } },
    { timestamp: 2, params: { update: {
      sessionUpdate: 'tool_call_update', toolCallId: 'skill-1', status: 'completed',
      locations: [{ path: '/Users/test/.agents/skills/terminal-browser/SKILL.md' }],
      rawOutput: { FileContent: {
        absolute_path: '/Users/test/.agents/skills/terminal-browser/SKILL.md',
        content: '1→---\n2→name: terminal-browser',
      } },
    } } },
    { timestamp: 2.1, params: { update: {
      sessionUpdate: 'tool_call', toolCallId: 'command-1', title: 'execute',
      rawInput: { command: 'terminal-browser open example.com' },
      _meta: { 'x.ai/tool': { name: 'execute', kind: 'execute', label: 'Execute' } },
    } } },
    { timestamp: 2.2, params: { update: {
      sessionUpdate: 'tool_call_update', toolCallId: 'command-1', status: 'completed',
    } } },
    { timestamp: 3, params: { update: { sessionUpdate: 'turn_completed' } } },
  ];
  const registry = createConversationRegistry({
    providers: [createGrokConversationProvider({ acpClient: data.acpClient })],
  });
  const result = await registry.read({
    name: 'ar-chat', cwd: data.cwd,
    command: `grok --leader --session-id ${data.parentId}`,
    conversationThreadId: data.parentId,
  });

  const group = result.items.find((item) => item.type === 'tool_group');
  assert.equal(group.title, 'Read 1 skill, Ran 1 command');
  const tool = group.tools.find((item) => item.kind === 'skill');
  assert.equal(tool.kind, 'skill');
  assert.equal(tool.title, 'Read 1 skill');
  assert.equal(tool.subject, 'terminal-browser');
  assert.equal(tool.file.path, '/Users/test/.agents/skills/terminal-browser/SKILL.md');
});

test('Grok provider shows read filenames and native line ranges without leaking long paths', async () => {
  const data = await fixture();
  const path = '/Users/test/.grok/sessions/%2FUsers%2Ftest/thread/terminal/N6HnHsiEkSL1V0G3Ym46uYvryTbO0PHL.log';
  data.snapshots.get(data.parentId).events = [
    { timestamp: 1, params: { update: {
      sessionUpdate: 'tool_call', toolCallId: 'read-log', title: 'read_file',
      rawInput: { target_file: path, offset: 230, limit: 260 },
      _meta: { 'x.ai/tool': { name: 'read_file', kind: 'read', label: 'Read' } },
    } } },
    { timestamp: 2, params: { update: {
      sessionUpdate: 'tool_call_update', toolCallId: 'read-log', kind: 'read',
      title: `Read \`${path}\``, locations: [{ path, line: 230 }],
      rawInput: { variant: 'ReadFile', target_file: path, offset: 230, limit: 260 },
    } } },
    { timestamp: 3, params: { update: {
      sessionUpdate: 'tool_call_update', toolCallId: 'read-log', status: 'completed',
      rawOutput: { type: 'ReadFile', FileContent: {
        absolute_path: path, content: '230→line', raw_output: 'line',
        offset: 230, limit: 260, total_lines: 2508,
      } },
    } } },
    { timestamp: 4, params: { update: { sessionUpdate: 'turn_completed' } } },
  ];
  const registry = createConversationRegistry({
    providers: [createGrokConversationProvider({ acpClient: data.acpClient })],
  });
  const result = await registry.read({
    name: 'ar-chat', cwd: data.cwd,
    command: `grok --leader --session-id ${data.parentId}`,
    conversationThreadId: data.parentId,
  });

  const tool = result.items.find((item) => item.type === 'tool');
  assert.equal(tool.title, 'Read N6HnHsiEkSL1V0G3Ym46uYvryTbO0PHL.log (231–490 of 2508)');
  assert.equal(tool.subject, 'N6HnHsiEkSL1V0G3Ym46uYvryTbO0PHL.log');
  assert.deepEqual(tool.locations, [path]);
  assert.equal(tool.file.path, path);
  assert.doesNotMatch(tool.title, /\/Users\/test/);
});

test('Grok provider returns a bounded recent history window for mobile', async () => {
  const data = await fixture();
  const snapshot = data.snapshots.get(data.parentId);
  snapshot.events = [];
  for (let index = 0; index < 60; index += 1) {
    snapshot.events.push(
      { timestamp: index * 3 + 1, params: { update: {
        sessionUpdate: 'user_message_chunk', content: { type: 'text', text: `Prompt ${index}` },
      } } },
      { timestamp: index * 3 + 2, params: { update: {
        sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Reply ${index}` },
      } } },
      { timestamp: index * 3 + 3, params: { update: { sessionUpdate: 'turn_completed' } } },
    );
  }
  const registry = createConversationRegistry({
    providers: [createGrokConversationProvider({ acpClient: data.acpClient })],
  });
  const result = await registry.read({
    name: 'ar-chat', cwd: data.cwd,
    command: `grok --leader --session-id ${data.parentId}`,
    conversationThreadId: data.parentId,
  }, { historyLimit: 10 });

  assert.equal(result.items.length, 10);
  assert.deepEqual(result.history, {
    totalItems: 120,
    returnedItems: 10,
    hiddenItems: 110,
    hasEarlier: true,
    limit: 10,
  });
  assert.equal(result.items[0].text, 'Prompt 55');
  assert.equal(result.items.at(-1).text, 'Reply 59');
  const repeated = await registry.read({
    name: 'ar-chat', cwd: data.cwd,
    command: `grok --leader --session-id ${data.parentId}`,
    conversationThreadId: data.parentId,
  }, { historyLimit: 10 });
  assert.equal(repeated.items[0], result.items[0],
    'an unchanged ACP snapshot should reuse its parsed timeline');
});

test('Grok provider keeps a steered user message between assistant markdown segments', async () => {
  const data = await fixture();
  const snapshot = await data.acpClient.loadSession({ sessionId: data.parentId });
  snapshot.events = [
    { timestamp: 1, params: { update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '```go\npackage main\n```' },
    } } },
    { timestamp: 2, params: { update: {
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'The user sent a message while you were working:\n<user_query>\nExplain the result\n</user_query>\nMake sure to complete any unfinished tasks from previous turns.' },
    } } },
    { timestamp: 3, params: { update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'The result is ready.' },
    } } },
  ];
  const registry = createConversationRegistry({
    providers: [createGrokConversationProvider({ acpClient: data.acpClient })],
  });

  const result = await registry.read({
    cwd: data.cwd, command: `grok --leader --session-id ${data.parentId}`,
    conversationThreadId: data.parentId,
  });

  assert.deepEqual(result.items.map(({ type, role, text }) => ({ type, role, text })), [
    { type: 'message', role: 'assistant', text: '```go\npackage main\n```' },
    { type: 'message', role: 'user', text: 'Explain the result' },
    { type: 'message', role: 'assistant', text: 'The result is ready.' },
  ]);
});

test('Grok provider groups adjacent mixed tools across resolved permissions and closes thoughts at boundaries', async () => {
  const data = await fixture();
  const snapshot = await data.acpClient.loadSession({ sessionId: data.parentId });
  snapshot.events = [
    { timestamp: 1, params: { update: {
      sessionUpdate: 'tool_call', toolCallId: 'shell-1', title: 'Run checks', status: 'running',
      rawInput: {
        variant: 'Bash', command: 'npm test -- --runInBand',
        description: 'Run the focused test suite',
      },
      _meta: { 'x.ai/tool': { name: 'run_command', kind: 'execute', label: 'Shell' } },
    } } },
    { timestamp: 1.1, params: { update: {
      sessionUpdate: 'permission_request', permissionId: 'shell-permission', title: 'Run checks',
      toolCall: { toolCallId: 'shell-1' }, options: [{ optionId: 'allow_once', name: 'Allow once' }],
    } } },
    { timestamp: 1.2, params: { update: {
      sessionUpdate: 'permission_resolved', permissionId: 'shell-permission', optionId: 'allow_once', label: 'Yes',
    } } },
    { timestamp: 1.3, params: { update: {
      sessionUpdate: 'tool_call_update', toolCallId: 'shell-1', status: 'completed', rawOutput: 'passed',
    } } },
    { timestamp: 2, params: { update: {
      sessionUpdate: 'tool_call', toolCallId: 'edit-1', title: 'Edit app.js', status: 'running',
      rawInput: { path: '/tmp/project/app.js' },
      _meta: { 'x.ai/tool': { name: 'edit_file', kind: 'edit', label: 'Edit' } },
    } } },
    { timestamp: 2.1, params: { update: {
      sessionUpdate: 'tool_call_update', toolCallId: 'edit-1', status: 'completed', content: [{
        type: 'diff', path: '/tmp/project/app.js', oldText: 'const old = true;\n', newText: 'const ready = true;\n',
      }],
    } } },
    { timestamp: 3, params: { update: {
      sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'I should verify this. ' },
    } } },
    { timestamp: 3.1, params: { update: {
      sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'The boundary matters.' },
    } } },
    { timestamp: 4, params: { update: {
      sessionUpdate: 'tool_call', toolCallId: 'read-1', title: 'Read app.js', status: 'running',
      rawInput: { target_file: '/tmp/project/app.js' },
      _meta: { 'x.ai/tool': { name: 'read_file', kind: 'read', label: 'Read' } },
    } } },
  ];
  const registry = createConversationRegistry({
    providers: [createGrokConversationProvider({ acpClient: data.acpClient })],
  });
  const result = await registry.read({
    cwd: data.cwd, command: `grok --leader --session-id ${data.parentId}`,
    conversationThreadId: data.parentId,
  });

  assert.deepEqual(result.items.map((item) => item.type), ['tool_group', 'thought', 'tool']);
  assert.equal(result.items[0].title, 'Ran 1 command, Edited 1 file');
  assert.deepEqual(result.items[0].tools.map((tool) => tool.toolCallId), ['shell-1', 'edit-1']);
  const initialGroupId = result.items[0].id;
  snapshot.events.splice(6, 0, { timestamp: 2.2, params: { update: {
    sessionUpdate: 'tool_call', toolCallId: 'read-after-edit', title: 'Read app.js', status: 'running',
    rawInput: { target_file: '/tmp/project/app.js' },
    _meta: { 'x.ai/tool': { name: 'read_file', kind: 'read', label: 'Read' } },
  } } });
  const appended = await registry.read({
    cwd: data.cwd, command: `grok --leader --session-id ${data.parentId}`,
    conversationThreadId: data.parentId,
  });
  assert.equal(appended.items[0].id, initialGroupId,
    'appending an adjacent tool must not remount the existing streamed group');
  assert.equal(appended.items[0].tools.length, 3);
  assert.equal(result.items[0].tools[0].command, 'npm test -- --runInBand');
  assert.equal(result.items[0].tools[0].summary, 'Run the focused test suite');
  assert.match(result.items[0].tools[0].input, /"description": "Run the focused test suite"/);
  assert.equal(result.items[1].text, 'I should verify this. The boundary matters.');
  assert.equal(result.items[1].status, 'completed');
  assert.equal(result.items[2].toolCallId, 'read-1');
  assert.equal(result.items[2].status, 'working');
  assert.ok(!result.items.some((item) => item.type === 'permission'));
});

test('Grok provider settles orphaned generic tools at user and turn boundaries', async () => {
  const data = await fixture();
  const snapshot = await data.acpClient.loadSession({ sessionId: data.parentId });
  snapshot.events = [
    { timestamp: 1, params: { update: {
      sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Run the test' },
    } } },
    { timestamp: 2, params: { update: {
      sessionUpdate: 'tool_call', toolCallId: 'stale-shell', title: 'Run test', status: 'running',
      rawInput: { variant: 'Bash', command: 'node --test' },
      _meta: { 'x.ai/tool': { name: 'run_command', kind: 'execute', label: 'Shell' } },
    } } },
    { timestamp: 3, params: { update: { sessionUpdate: 'turn_completed' } } },
    { timestamp: 3.1, params: { update: {
      sessionUpdate: 'tool_call_update', toolCallId: 'stale-shell', status: 'running',
    } } },
    { timestamp: 4, params: { update: {
      sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Run it again' },
    } } },
    { timestamp: 5, params: { update: {
      sessionUpdate: 'tool_call', toolCallId: 'current-shell', title: 'Run test again', status: 'running',
      rawInput: { variant: 'Bash', command: 'node --test' },
      _meta: { 'x.ai/tool': { name: 'run_command', kind: 'execute', label: 'Shell' } },
    } } },
  ];
  snapshot.turn = { active: true, changedAt: 5 };
  const registry = createConversationRegistry({
    providers: [createGrokConversationProvider({ acpClient: data.acpClient })],
  });
  const session = {
    cwd: data.cwd, command: `grok --leader --session-id ${data.parentId}`,
    conversationThreadId: data.parentId,
  };

  const active = await registry.read(session);
  const activeTools = active.items.flatMap((item) => item.type === 'tool_group' ? item.tools : [item])
    .filter((item) => item.type === 'tool');
  assert.equal(activeTools.find((item) => item.toolCallId === 'stale-shell').status, 'completed');
  assert.equal(activeTools.find((item) => item.toolCallId === 'current-shell').status, 'working');

  snapshot.events.push({ timestamp: 6, params: { update: { sessionUpdate: 'turn_completed' } } });
  snapshot.turn = { active: false, changedAt: 6 };
  const completed = await registry.read(session);
  const completedTools = completed.items.flatMap((item) => item.type === 'tool_group' ? item.tools : [item])
    .filter((item) => item.type === 'tool');
  assert.ok(completedTools.every((item) => item.status !== 'working' && item.status !== 'running'));
});

test('Grok provider preserves native file, search, and diff locations without plan protocol noise', async () => {
  const data = await fixture();
  const snapshot = await data.acpClient.loadSession({ sessionId: data.parentId });
  snapshot.events = [
    { timestamp: 1, params: { update: {
      sessionUpdate: 'tool_call', toolCallId: 'read-file', title: 'read_file',
      rawInput: { target_file: 'src/profile.js' },
      _meta: { 'x.ai/tool': { name: 'read_file', kind: 'read', label: 'Read' } },
    } } },
    { timestamp: 1.1, params: { update: {
      sessionUpdate: 'tool_call_update', toolCallId: 'read-file', status: 'completed',
      rawOutput: { type: 'ReadFile', FileContent: {
        content: '8→export function displayName(profile) {\n  return profile.firstName;\n}\n',
        raw_output: 'export function displayName(profile) {\n  return profile.firstName;\n}\n',
        absolute_path: '/tmp/project/src/profile.js', offset: 7, total_lines: 21,
      } },
    } } },
    { timestamp: 2, params: { update: {
      sessionUpdate: 'tool_call', toolCallId: 'grep-file', title: 'grep',
      rawInput: { pattern: 'displayName' },
      _meta: { 'x.ai/tool': { name: 'grep', kind: 'search', label: 'Search' } },
    } } },
    { timestamp: 2.1, params: { update: {
      sessionUpdate: 'tool_call_update', toolCallId: 'grep-file', status: 'completed',
      rawOutput: { type: 'GrepSearch', match_count: 1, file_matches: [{
        path: '/tmp/project/src/profile.js',
        matches: [{ line_number: 8, content: 'export function displayName(profile) {' }],
      }] },
    } } },
    { timestamp: 3, params: { update: {
      sessionUpdate: 'tool_call', toolCallId: 'todo', title: 'todo_write',
      _meta: { 'x.ai/tool': { name: 'todo_write', kind: 'plan', label: 'Plan' } },
    } } },
    { timestamp: 3.1, params: { update: {
      sessionUpdate: 'plan', entries: [{ content: 'Fix display name', status: 'in_progress' }],
    } } },
    { timestamp: 3.2, params: { update: {
      sessionUpdate: 'tool_call', toolCallId: 'exit-plan', title: 'exit_plan_mode',
      _meta: { 'x.ai/tool': { name: 'exit_plan_mode', kind: 'exit_plan', label: 'Exit Plan Mode' } },
    } } },
    { timestamp: 4, params: { update: {
      sessionUpdate: 'tool_call', toolCallId: 'edit-file', title: 'search_replace',
      rawInput: { file_path: 'src/profile.js' },
      _meta: { 'x.ai/tool': { name: 'search_replace', kind: 'edit', label: 'Edit' } },
    } } },
    { timestamp: 4.1, params: { update: {
      sessionUpdate: 'tool_call_update', toolCallId: 'edit-file', status: 'completed', content: [{
        type: 'diff', path: '/tmp/project/src/profile.js',
        oldText: 'return profile.firstName;', newText: 'return profile.lastName ? `${profile.firstName} ${profile.lastName}` : profile.firstName;',
        _meta: { old_line: 9, new_line: 9 },
      }],
    } } },
  ];
  const registry = createConversationRegistry({
    providers: [createGrokConversationProvider({ acpClient: data.acpClient })],
  });
  const result = await registry.read({
    name: 'ar-chat', cwd: data.cwd,
    command: `grok --leader --session-id ${data.parentId}`, conversationThreadId: data.parentId,
  });
  const tools = result.items.flatMap((item) => item.type === 'tool_group' ? item.tools : item.type === 'tool' ? [item] : []);
  const read = tools.find((item) => item.toolCallId === 'read-file');
  const search = tools.find((item) => item.toolCallId === 'grep-file');
  const edit = tools.find((item) => item.toolCallId === 'edit-file');
  assert.deepEqual(read.file, {
    path: '/tmp/project/src/profile.js',
    content: 'export function displayName(profile) {\n  return profile.firstName;\n}\n',
    startLine: 8,
    totalLines: 21,
  });
  assert.deepEqual(search.matches, [{
    path: '/tmp/project/src/profile.js', line: 8, text: 'export function displayName(profile) {',
  }]);
  assert.equal(search.output, 'Found 1 match');
  assert.equal(edit.diffs[0].oldLine, 9);
  assert.equal(edit.diffs[0].newLine, 9);
  assert.ok(result.items.some((item) => item.type === 'plan'));
  assert.ok(!tools.some((item) => ['todo', 'exit-plan'].includes(item.toolCallId)));
});

test('Grok provider only opens descendants of the mapped root thread', async () => {
  const data = await fixture();
  const provider = createGrokConversationProvider({
    acpClient: data.acpClient,
  });
  const registry = createConversationRegistry({ providers: [provider] });
  const session = {
    name: 'ar-chat', cwd: data.cwd,
    command: `grok --leader --session-id ${data.parentId}`, conversationThreadId: data.parentId,
  };
  const child = await registry.read(session, { threadId: data.childId });
  assert.equal(child.thread.id, data.childId);
  assert.equal(child.parent.id, data.parentId);
  assert.equal(child.capabilities.send, false);
  assert.ok(child.items.some((item) => item.type === 'thought'));
  assert.ok(child.items.some((item) => item.type === 'tool' && item.output === 'Found files'));
  assert.ok(!child.items.some((item) => item.type === 'turn'));
  await assert.rejects(
    registry.read(session, { threadId: '01a00000-0000-0000-0000-000000000000' }),
    /not part of this conversation/i,
  );
});

test('Grok provider binds a pending subagent from its output when no spawned event arrives', async () => {
  const data = await fixture();
  const snapshot = await data.acpClient.loadSession({ sessionId: data.parentId });
  snapshot.events = snapshot.events.filter((record) => {
    const update = record.params.update;
    return update.sessionUpdate !== 'subagent_spawned' && update.sessionUpdate !== 'subagent_finished' &&
      !(update.toolCallId === 'spawn-1' && update.sessionUpdate === 'tool_call_update');
  });
  const registry = createConversationRegistry({ providers: [createGrokConversationProvider({ acpClient: data.acpClient })] });
  const result = await registry.read({
    cwd: data.cwd, command: `grok --leader --session-id ${data.parentId}`,
    conversationThreadId: data.parentId,
  });
  const subagent = result.items.find((item) => item.type === 'subagent');
  assert.equal(subagent.threadId, data.childId);
  assert.equal(subagent.phase, 'done');
  assert.equal(subagent.output, 'Child result');
  assert.ok(!result.items.some((item) => item.name === 'get_command_or_subagent_output'));
});

test('Grok provider keeps a successfully spawned background subagent running until its lifecycle finishes', async () => {
  const data = await fixture();
  const snapshot = await data.acpClient.loadSession({ sessionId: data.parentId });
  snapshot.events = snapshot.events.filter((record) => record.timestamp <= 5.2);
  const registry = createConversationRegistry({
    providers: [createGrokConversationProvider({ acpClient: data.acpClient })],
  });
  const result = await registry.read({
    cwd: data.cwd, command: `grok --leader --session-id ${data.parentId}`,
    conversationThreadId: data.parentId,
  });
  const subagent = result.items.find((item) => item.type === 'subagent');
  assert.deepEqual({
    threadId: subagent.threadId,
    status: subagent.status,
    phase: subagent.phase,
  }, {
    threadId: data.childId,
    status: 'working',
    phase: 'running',
  });
});

test('Grok provider keeps one subagent card when replay orders lifecycle before spawn tool', async () => {
  const data = await fixture();
  const snapshot = await data.acpClient.loadSession({ sessionId: data.parentId });
  const lifecycle = snapshot.events.filter((record) =>
    ['subagent_spawned', 'subagent_finished'].includes(record.params.update.sessionUpdate));
  const rest = snapshot.events.filter((record) =>
    !['subagent_spawned', 'subagent_finished'].includes(record.params.update.sessionUpdate));
  const spawn = rest.find((record) => record.params.update.toolCallId === 'spawn-1' &&
    record.params.update.sessionUpdate === 'tool_call');
  spawn.params.update.rawOutput = {
    type: 'Text', text: `Subagent started.\nsubagent_id: ${data.childId}`,
  };
  snapshot.events = [...lifecycle, ...rest];
  const registry = createConversationRegistry({ providers: [createGrokConversationProvider({ acpClient: data.acpClient })] });
  const result = await registry.read({
    cwd: data.cwd, command: `grok --leader --session-id ${data.parentId}`,
    conversationThreadId: data.parentId,
  });
  const subagents = result.items.filter((item) => item.type === 'subagent');
  assert.equal(subagents.length, 1);
  assert.equal(subagents[0].threadId, data.childId);
  assert.equal(subagents[0].phase, 'done');
});

test('Grok provider binds the captured permission-first spawn lifecycle without generic duplicates', async () => {
  const data = await fixture();
  const snapshot = await data.acpClient.loadSession({ sessionId: data.parentId });
  const spawnId = 'permission-first-spawn';
  snapshot.events = snapshot.events.filter((record) => {
    const update = record.params.update;
    return !['subagent_spawned', 'subagent_finished'].includes(update.sessionUpdate) &&
      update.toolCallId !== 'spawn-1' && update.toolCallId !== 'poll-1';
  });
  // This is the order emitted around the real ACP approval boundary: the
  // client receives a permission request containing Task input, resolves it,
  // and only then sees the generic Task tool update and child lifecycle.
  snapshot.events.push(
    { timestamp: 5, params: { update: {
      sessionUpdate: 'permission_request', permissionId: 'approve-spawn',
      title: 'Summarize project structure', toolCall: {
        toolCallId: spawnId, title: 'Summarize project structure', input: {
          variant: 'Task', description: 'Summarize project structure', subagent_type: 'explore',
          prompt: 'Explore the project',
        },
      }, options: [{ optionId: 'allow-once', name: 'Allow' }],
    } } },
    { timestamp: 5.1, params: { update: {
      sessionUpdate: 'permission_resolved', permissionId: 'approve-spawn',
      optionId: 'allow-once', label: 'Yes',
    } } },
    { timestamp: 5.2, params: { update: {
      sessionUpdate: 'tool_call_update', toolCallId: spawnId, title: 'Summarize project structure',
      rawInput: { variant: 'Task', description: 'Summarize project structure', subagent_type: 'explore' },
      status: 'completed', rawOutput: `Subagent started in background.\nsubagent_id: ${data.childId}`,
    } } },
    { timestamp: 5.3, params: { update: {
      sessionUpdate: 'subagent_spawned', child_session_id: data.childId,
      description: 'Summarize project structure', subagent_type: 'explore', model: 'qwen-local',
    } } },
    { timestamp: 5.4, params: { update: { sessionUpdate: 'current_mode_update', currentModeId: 'plan' } } },
    { timestamp: 6, params: { update: {
      sessionUpdate: 'subagent_finished', child_session_id: data.childId, status: 'completed',
      output: 'Child result', tool_calls: 2, turns: 1,
    } } },
    { timestamp: 6.1, params: { update: { sessionUpdate: 'current_mode_update', currentModeId: 'default' } } },
  );
  const registry = createConversationRegistry({ providers: [createGrokConversationProvider({ acpClient: data.acpClient })] });
  const result = await registry.read({
    cwd: data.cwd, command: `grok --leader --session-id ${data.parentId}`,
    conversationThreadId: data.parentId,
  });
  const subagents = result.items.filter((item) => item.type === 'subagent');
  assert.deepEqual(subagents.map(({ id, threadId, status, phase, permissionId }) =>
    ({ id, threadId, status, phase, permissionId })), [{
    id: `subagent-call-${spawnId}`, threadId: data.childId,
    status: 'completed', phase: 'done', permissionId: 'approve-spawn',
  }]);
  assert.equal(result.items.find((item) => item.permissionId === 'approve-spawn').status, 'completed');
  assert.ok(!result.items.some((item) => item.type === 'tool' && item.toolCallId === spawnId));
  assert.ok(result.items.some((item) => item.type === 'tool_group' &&
    item.tools.some((tool) => tool.toolCallId === 'tool-1')),
    'unrelated tool activity remains visible');
  assert.ok(!result.items.some((item) => item.type === 'event' && item.kind === 'mode' &&
    ['plan', 'default'].includes(item.text)), 'subagent lifecycle mode noise is suppressed');
});

test('Grok provider removes a stale permission once the same tool already ran in Grok', async () => {
  const data = await fixture();
  const snapshot = await data.acpClient.loadSession({ sessionId: data.parentId });
  snapshot.events = [{ timestamp: 1, params: { update: {
    sessionUpdate: 'tool_call_update', toolCallId: 'shared-tool', title: 'Run shared tool',
    status: 'completed', rawOutput: 'done',
  } } }, { timestamp: 2, params: { update: {
    sessionUpdate: 'permission_request', permissionId: 'stale-permission',
    title: 'Run shared tool', toolCall: { toolCallId: 'shared-tool' },
    options: [{ optionId: 'allow_once', name: 'Allow once' }],
  } } }];
  const registry = createConversationRegistry({
    providers: [createGrokConversationProvider({ acpClient: data.acpClient })],
  });
  const result = await registry.read({
    cwd: data.cwd, command: `grok --leader --session-id ${data.parentId}`,
    conversationThreadId: data.parentId,
  });
  assert.ok(!result.items.some((item) => item.type === 'permission' &&
    item.permissionId === 'stale-permission'));
});

test('Grok provider gives command permissions a readable summary and safe action order', async () => {
  const data = await fixture();
  const snapshot = await data.acpClient.loadSession({ sessionId: data.parentId });
  snapshot.events = [{ timestamp: 1, params: { update: {
    sessionUpdate: 'permission_request', permissionId: 'command-permission',
    title: 'Execute `mkdir -p /tmp/frames && ffmpeg ...`',
    toolCall: { toolCallId: 'command-tool', rawInput: {
      variant: 'Bash', command: 'mkdir -p /tmp/frames && ffmpeg -i recording.mov /tmp/frames/frame-%02d.png',
      description: 'Extract frames from recording',
    } },
    options: [
      { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
      { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
      { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
    ],
  } } }];
  const registry = createConversationRegistry({
    providers: [createGrokConversationProvider({ acpClient: data.acpClient })],
  });
  const result = await registry.read({
    cwd: data.cwd, command: `grok --leader --session-id ${data.parentId}`,
    conversationThreadId: data.parentId,
  });
  const permission = result.items.find((item) => item.permissionId === 'command-permission');
  assert.equal(permission.title, 'Extract frames from recording');
  assert.match(permission.text, /ffmpeg -i recording\.mov/);
  assert.deepEqual(permission.options.map((option) => option.id), [
    'allow_once', 'reject_once', 'allow_always',
  ]);
});

test('Grok provider removes a permission that arrives after its subagent is already running', async () => {
  const data = await fixture();
  const snapshot = await data.acpClient.loadSession({ sessionId: data.parentId });
  snapshot.events = [{ timestamp: 1, params: { update: {
    sessionUpdate: 'tool_call', toolCallId: 'running-spawn', title: 'spawn_subagent',
    rawInput: { description: 'Inspect permissions', subagent_type: 'explore' },
    _meta: { 'x.ai/tool': { name: 'spawn_subagent', kind: 'task' } },
  } } }, { timestamp: 2, params: { update: {
    sessionUpdate: 'subagent_spawned', child_session_id: data.childId,
    description: 'Inspect permissions', subagent_type: 'explore',
  } } }, { timestamp: 3, params: { update: {
    sessionUpdate: 'permission_request', permissionId: 'late-permission',
    title: 'Inspect permissions', toolCall: {
      toolCallId: 'running-spawn', input: {
        variant: 'Task', description: 'Inspect permissions', subagent_type: 'explore',
      },
    }, options: [{ optionId: 'allow_once', name: 'Allow once' }],
  } } }];
  const registry = createConversationRegistry({
    providers: [createGrokConversationProvider({ acpClient: data.acpClient })],
  });
  const result = await registry.read({
    cwd: data.cwd, command: `grok --leader --session-id ${data.parentId}`,
    conversationThreadId: data.parentId,
  });
  assert.ok(!result.items.some((item) => item.type === 'permission' &&
    item.permissionId === 'late-permission'));
});

test('Grok provider keeps concurrent permission-first subagents distinct through binding', async () => {
  const data = await fixture();
  const snapshot = await data.acpClient.loadSession({ sessionId: data.parentId });
  const firstChildId = '01a01316-b470-7503-a1a6-45f23d2fc6ca';
  const secondChildId = '01a01316-c580-7503-a1a6-45f23d2fc6ca';
  const registry = createConversationRegistry({ providers: [createGrokConversationProvider({ acpClient: data.acpClient })] });
  const session = {
    cwd: data.cwd, command: `grok --leader --session-id ${data.parentId}`,
    conversationThreadId: data.parentId,
  };
  snapshot.events.push(
    { timestamp: 8, params: { update: {
      sessionUpdate: 'permission_request', permissionId: 'permission-a', toolCall: {
        toolCallId: 'spawn-a', input: { variant: 'Task', description: 'First task', subagent_type: 'explore' },
      }, options: [],
    } } },
    { timestamp: 8.1, params: { update: {
      sessionUpdate: 'permission_request', permissionId: 'permission-b', toolCall: {
        toolCallId: 'spawn-b', input: { variant: 'Task', description: 'Second task', subagent_type: 'build' },
      }, options: [],
    } } },
  );
  let result = await registry.read(session);
  assert.deepEqual(result.items.filter((item) => item.type === 'subagent').slice(-2).map((item) => ({
    id: item.id, toolCallId: item.toolCallId, threadId: item.threadId, phase: item.phase,
  })), [
    { id: 'subagent-call-spawn-a', toolCallId: 'spawn-a', threadId: undefined, phase: 'calling' },
    { id: 'subagent-call-spawn-b', toolCallId: 'spawn-b', threadId: undefined, phase: 'calling' },
  ]);
  snapshot.events.push(
    { timestamp: 8.2, params: { update: {
      sessionUpdate: 'subagent_spawned', child_session_id: firstChildId,
      description: 'First task', subagent_type: 'explore',
    } } },
    { timestamp: 8.3, params: { update: {
      sessionUpdate: 'subagent_spawned', child_session_id: secondChildId,
      description: 'Second task', subagent_type: 'build',
    } } },
  );
  result = await registry.read(session);
  assert.deepEqual(result.items.filter((item) => item.type === 'subagent').slice(-2).map((item) => ({
    id: item.id, toolCallId: item.toolCallId, threadId: item.threadId, title: item.title, phase: item.phase,
  })), [
    { id: 'subagent-call-spawn-a', toolCallId: 'spawn-a', threadId: firstChildId, title: 'First task', phase: 'running' },
    { id: 'subagent-call-spawn-b', toolCallId: 'spawn-b', threadId: secondChildId, title: 'Second task', phase: 'running' },
  ]);
});

test('Grok provider marks a denied subagent spawn as failed instead of leaving it calling', async () => {
  const data = await fixture();
  const snapshot = await data.acpClient.loadSession({ sessionId: data.parentId });
  snapshot.events = snapshot.events.filter((record) => {
    const update = record.params.update;
    return !['subagent_spawned', 'subagent_finished'].includes(update.sessionUpdate) &&
      update.toolCallId !== 'poll-1' &&
      !(update.toolCallId === 'spawn-1' && update.sessionUpdate === 'tool_call_update');
  });
  const spawn = snapshot.events.find((record) => record.params.update.toolCallId === 'spawn-1');
  spawn.params.update.status = 'failed';
  delete spawn.params.update.rawOutput;
  const registry = createConversationRegistry({ providers: [createGrokConversationProvider({ acpClient: data.acpClient })] });
  const result = await registry.read({
    cwd: data.cwd, command: `grok --leader --session-id ${data.parentId}`,
    conversationThreadId: data.parentId,
  });
  const subagent = result.items.find((item) => item.type === 'subagent');
  assert.equal(subagent.status, 'failed');
  assert.equal(subagent.phase, 'failed');
});

test('registry can add providers without changing its public response contract', async () => {
  const registry = createConversationRegistry({ providers: [{
    id: 'future-agent',
    label: 'Future Agent',
    detect: async (session) => session.command === 'future' ? { rootThreadId: 'thread-1' } : undefined,
    read: async () => ({
      thread: { id: 'thread-1', title: 'Future', status: 'idle' },
      items: [], children: [], parent: null,
      capabilities: { send: true, children: false },
    }),
    encodeInput: (text) => `${text}\r`,
  }] });
  const result = await registry.read({ command: 'future' });
  assert.deepEqual(result.provider, { id: 'future-agent', label: 'Future Agent' });
  assert.equal(registry.encodeInput(result.provider.id, 'hello'), 'hello\r');
  assert.deepEqual(await registry.prepareSessionInput({ command: 'future' }, 'hello'), { data: 'hello\r' });
});

test('Grok provider streams file changes through the provider-neutral registry', async () => {
  const data = await fixture();
  const provider = createGrokConversationProvider({
    acpClient: data.acpClient,
  });
  const registry = createConversationRegistry({ providers: [provider] });
  const session = {
    name: 'ar-chat', cwd: data.cwd,
    command: `grok --leader --session-id ${data.parentId}`, conversationThreadId: data.parentId,
  };
  const updates = [];
  const stop = await registry.watch(session, {}, (event) => updates.push(event));
  data.acpClient.append(data.parentId, {
    timestamp: 8,
    params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Streaming now' } } },
  });
  const deadline = Date.now() + 2_000;
  while (!updates.some((event) => event.conversation?.items.some((item) => item.text?.includes('Streaming now')))) {
    if (Date.now() > deadline) assert.fail('Timed out waiting for the streamed Grok update');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await stop();
  assert.equal(updates.at(-1).conversation.provider.id, 'grok');
});

test('Grok 4.6-shaped streams publish thought and answer chunks incrementally and settle thinking', async (t) => {
  const data = await fixture();
  const registry = createConversationRegistry({
    providers: [createGrokConversationProvider({ acpClient: data.acpClient })],
  });
  const session = {
    name: 'ar-chat', cwd: data.cwd,
    command: `grok --leader --session-id ${data.parentId}`, conversationThreadId: data.parentId,
  };
  const root = data.snapshots.get(data.parentId);
  root.metadata._meta['x.ai/sessionDetail'].currentModelId = 'grok-4.6';
  const updates = [];
  const stop = await registry.watch(session, {}, (event) => updates.push(event));
  t.after(stop);
  root.turn = { active: true, cancelRequested: false, changedAt: 8_000 };
  const before = updates.length;
  for (const [offset, text] of ['First line.\n', 'Second line.\n', 'Third line.'].entries()) {
    data.acpClient.append(data.parentId, { timestamp: 8 + offset, params: { update: {
      sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text },
    } } });
  }
  const thoughtChunks = updates.slice(before);
  assert.equal(thoughtChunks.length, 3, 'no provider timer may collapse live thought chunks');
  assert.deepEqual(thoughtChunks.map((event) => event.stream), [
    { kind: 'agent_thought_chunk', delta: 'First line.\n' },
    { kind: 'agent_thought_chunk', delta: 'Second line.\n' },
    { kind: 'agent_thought_chunk', delta: 'Third line.' },
  ]);
  assert.deepEqual(thoughtChunks.map((event) => event.conversation.items.at(-1).text), [
    'First line.\n',
    'First line.\nSecond line.\n',
    'First line.\nSecond line.\nThird line.',
  ]);
  assert.deepEqual(thoughtChunks.map((event) => event.conversation.activity.phase), [
    'thinking', 'thinking', 'thinking',
  ]);

  const answerStart = updates.length;
  for (const [offset, text] of ['A', 'B', 'C'].entries()) {
    data.acpClient.append(data.parentId, { timestamp: 8 + offset, params: { update: {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text },
    } } });
  }
  const chunks = updates.slice(answerStart);
  assert.equal(chunks.length, 3, 'no provider timer may collapse live chunks');
  assert.deepEqual(chunks.map((event) => event.stream), [
    { kind: 'agent_message_chunk', delta: 'A' },
    { kind: 'agent_message_chunk', delta: 'B' },
    { kind: 'agent_message_chunk', delta: 'C' },
  ]);
  assert.deepEqual(chunks.map((event) => event.conversation.items.at(-1).text), ['A', 'AB', 'ABC']);
  assert.deepEqual(chunks.map((event) => event.conversation.activity.turnId), [8_000, 8_000, 8_000]);
  assert.equal(chunks[0].conversation.thread.model, 'grok-4.6');
  const completedThought = chunks[0].conversation.items.find((item) => item.type === 'thought' &&
    item.text === 'First line.\nSecond line.\nThird line.');
  assert.equal(completedThought.status, 'completed', 'the first answer token must stop the thinking spinner');
  assert.equal(chunks[0].conversation.activity.phase, 'responding');

  data.acpClient.publish(data.parentId);
  assert.equal(updates.length, answerStart + 3,
    'republishing one ACP snapshot must not duplicate its last chunk');

  root.turn = { active: false, cancelRequested: false, changedAt: 12_000 };
  data.acpClient.append(data.parentId, { timestamp: 12, params: { update: {
    sessionUpdate: 'turn_completed', stop_reason: 'end_turn',
  } } });
  assert.equal(updates.at(-1).stream.kind, 'turn_completed');
  assert.equal(updates.at(-1).conversation.activity.active, false);
  assert.equal(updates.at(-1).conversation.thread.status, 'idle');
});

test('Grok provider never lets a slow active snapshot overwrite a completed turn', async () => {
  const data = await fixture();
  const provider = createGrokConversationProvider({ acpClient: data.acpClient });
  const registry = createConversationRegistry({ providers: [provider] });
  const session = {
    name: 'ar-chat', cwd: data.cwd,
    command: `grok --leader --session-id ${data.parentId}`, conversationThreadId: data.parentId,
  };
  const updates = [];
  const stop = await registry.watch(session, {}, (event) => updates.push(event));

  const originalLoadSession = data.acpClient.loadSession;
  let rootLoads = 0;
  let releaseSlowRead;
  let markSlowReadStarted;
  const slowReadGate = new Promise((resolve) => { releaseSlowRead = resolve; });
  const slowReadStarted = new Promise((resolve) => { markSlowReadStarted = resolve; });
  data.acpClient.loadSession = async (input) => {
    const snapshot = await originalLoadSession(input);
    if (input.sessionId !== data.parentId || ++rootLoads !== 1) return snapshot;
    const captured = structuredClone(snapshot);
    markSlowReadStarted();
    await slowReadGate;
    return captured;
  };

  const root = data.snapshots.get(data.parentId);
  root.turn = { active: true, cancelRequested: false };
  data.acpClient.append(data.parentId, { timestamp: 8, params: { update: {
    sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Finishing the answer.' },
  } } });
  await slowReadStarted;

  root.turn = { active: false, cancelRequested: false };
  data.acpClient.append(data.parentId, { timestamp: 9, params: { update: {
    sessionUpdate: 'turn_completed', stop_reason: 'end_turn',
  } } });
  await new Promise((resolve) => setTimeout(resolve, 40));
  releaseSlowRead();

  const deadline = Date.now() + 2_000;
  while (updates.length < 2 || updates.at(-1).conversation.thread.status !== 'idle') {
    if (Date.now() > deadline) assert.fail('Timed out waiting for the completed turn');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await new Promise((resolve) => setTimeout(resolve, 80));
  const firstWorking = updates.findIndex((event) => event.conversation.thread.status === 'working');
  const firstIdle = updates.findIndex(
    (event, index) => index > firstWorking && event.conversation.thread.status === 'idle',
  );
  assert.notEqual(firstWorking, -1);
  assert.notEqual(firstIdle, -1);
  assert.ok(updates.slice(firstIdle).every((event) => event.conversation.thread.status === 'idle'));
  assert.deepEqual(updates.at(-1).conversation.activity, { active: false });
  await stop();
});

test('Grok provider publishes a completed root turn without waiting for a slow child session', async () => {
  const data = await fixture();
  const provider = createGrokConversationProvider({ acpClient: data.acpClient });
  const registry = createConversationRegistry({ providers: [provider] });
  const session = {
    name: 'ar-chat', cwd: data.cwd,
    command: `grok --leader --session-id ${data.parentId}`, conversationThreadId: data.parentId,
  };
  const updates = [];
  const stop = await registry.watch(session, {}, (event) => updates.push(event));
  const root = data.snapshots.get(data.parentId);
  root.turn = { active: true, cancelRequested: false };
  data.acpClient.append(data.parentId, { timestamp: 8, params: { update: {
    sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Almost done.' },
  } } });
  const workingDeadline = Date.now() + 2_000;
  while (updates.at(-1)?.conversation.thread.status !== 'working') {
    if (Date.now() > workingDeadline) assert.fail('Timed out waiting for the working turn');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  const originalLoadSession = data.acpClient.loadSession;
  let releaseChild;
  const childGate = new Promise((resolve) => { releaseChild = resolve; });
  data.acpClient.loadSession = async (input) => {
    if (input.sessionId === data.childId) await childGate;
    return originalLoadSession(input);
  };
  let resolveIdle;
  const idle = new Promise((resolve) => { resolveIdle = resolve; });
  const before = updates.length;
  const observeIdle = setInterval(() => {
    if (updates.slice(before).some((event) => event.conversation.thread.status === 'idle')) resolveIdle(true);
  }, 10);
  root.turn = { active: false, cancelRequested: false };
  data.acpClient.append(data.parentId, { timestamp: 9, params: { update: {
    sessionUpdate: 'turn_completed', stop_reason: 'end_turn',
  } } });
  const completedPromptly = await Promise.race([
    idle,
    new Promise((resolve) => setTimeout(() => resolve(false), 300)),
  ]);
  clearInterval(observeIdle);
  releaseChild();
  await stop();
  assert.equal(completedPromptly, true, 'root completion must not wait for child session hydration');
});

test('Grok provider keeps questions separate from tool groups and answers descendant questions only in its root graph', async () => {
  const data = await fixture();
  const childSnapshot = await data.acpClient.loadSession({ sessionId: data.childId });
  childSnapshot.events.splice(-1, 0,
    { timestamp: 5.3, params: { update: {
      sessionUpdate: 'tool_call', toolCallId: 'ask-child', title: 'ask_user_question',
      rawInput: { questions: [{ question: 'Pick a color', options: [{ label: 'Red', description: 'Warm' }] }] },
      _meta: { 'x.ai/tool': { name: 'ask_user_question', kind: 'ask_user' } },
    } } },
    { timestamp: 5.4, params: { update: {
      sessionUpdate: 'tool_call_update', toolCallId: 'ask-child',
      rawInput: { variant: 'AskUserQuestion', questions: [
        { question: 'Pick a color', options: [{ label: 'Red', description: 'Warm' }], multiSelect: false },
      ] },
      _meta: { 'x.ai/tool': { name: 'ask_user_question', kind: 'ask_user' } },
    } } },
    { timestamp: 5.5, params: { update: {
      sessionUpdate: 'question_request', questionId: 'ask-child', toolCallId: 'ask-child', mode: 'default',
      questions: [{ question: 'Pick a color', options: [{ label: 'Red', description: 'Warm' }], multiSelect: false }],
    } } },
  );
  const registry = createConversationRegistry({ providers: [createGrokConversationProvider({ acpClient: data.acpClient })] });
  const session = {
    cwd: data.cwd, command: `grok --leader --session-id ${data.parentId}`,
    conversationThreadId: data.parentId,
  };
  const conversation = await registry.read(session, { threadId: data.childId });
  const question = conversation.items.find((item) => item.type === 'question');
  assert.deepEqual(question, {
    id: 'question-ask-child', type: 'question', questionId: 'ask-child', toolCallId: 'ask-child',
    mode: 'default', questions: [{ question: 'Pick a color', options: [{ label: 'Red', description: 'Warm' }], multiSelect: false }],
    status: 'pending', timestamp: 5.3,
  });
  assert.ok(!conversation.items.some((item) => item.type === 'tool' && item.toolCallId === 'ask-child'));
  await registry.respondQuestion(session, {
    threadId: data.childId, questionId: 'ask-child', answers: { 'Pick a color': 'Red' },
  });
  assert.deepEqual(data.questionResponses, [{
    sessionId: data.childId, questionId: 'ask-child', answers: { 'Pick a color': 'Red' },
  }]);
  await assert.rejects(
    registry.respondQuestion(session, {
      threadId: '01a00000-0000-0000-0000-000000000000', questionId: 'ask-child',
      answers: { 'Pick a color': 'Red' },
    }),
    /not part of this conversation/i,
  );
});

test('Grok provider exposes one plan review interaction and hides its internal plan tools', async () => {
  const data = await fixture();
  const snapshot = await data.acpClient.loadSession({ sessionId: data.parentId });
  snapshot.events.splice(-1, 0,
    { timestamp: 7.1, params: { update: {
      sessionUpdate: 'tool_call', toolCallId: 'write-plan', title: 'Edit plan.md',
      rawInput: { target_file: `/Users/test/.grok/sessions/project/${data.parentId}/plan.md` },
      _meta: { 'x.ai/tool': { name: 'search_replace', kind: 'edit' } },
    } } },
    { timestamp: 7.2, params: { update: {
      sessionUpdate: 'tool_call_update', toolCallId: 'write-plan', status: 'completed',
      locations: [{ path: `/Users/test/.grok/sessions/project/${data.parentId}/plan.md` }],
    } } },
    { timestamp: 7.3, params: { update: {
      sessionUpdate: 'tool_call', toolCallId: 'exit-plan', title: 'Exit plan mode',
      _meta: { 'x.ai/tool': { name: 'exit_plan_mode', kind: 'other' } },
    } } },
    { timestamp: 7.4, params: { update: {
      sessionUpdate: 'plan_review_request', reviewId: 'exit-plan', toolCallId: 'exit-plan',
      planContent: '# Plan\n\n1. Inspect\n2. Implement',
    } } },
  );
  const registry = createConversationRegistry({
    providers: [createGrokConversationProvider({ acpClient: data.acpClient })],
  });
  const session = {
    cwd: data.cwd, command: `grok --leader --session-id ${data.parentId}`,
    conversationThreadId: data.parentId,
  };
  const conversation = await registry.read(session);
  assert.deepEqual(conversation.items.filter((item) => item.type === 'plan_review'), [{
    id: 'plan-review-exit-plan', type: 'plan_review', reviewId: 'exit-plan', toolCallId: 'exit-plan',
    planContent: '# Plan\n\n1. Inspect\n2. Implement', status: 'pending', timestamp: 7.4,
    threadId: data.parentId,
  }]);
  assert.ok(!conversation.items.some((item) =>
    (item.type === 'tool' || item.type === 'tool_group') && JSON.stringify(item).includes('plan.md')));
  assert.ok(!conversation.items.some((item) =>
    (item.type === 'tool' || item.type === 'tool_group') && JSON.stringify(item).includes('Exit plan mode')));

  await registry.respondPlanReview(session, {
    threadId: data.parentId, reviewId: 'exit-plan', outcome: 'cancelled',
    feedback: '@plan.md:3\nExplain this step.',
  });
  assert.deepEqual(data.planReviewResponses, [{
    sessionId: data.parentId, reviewId: 'exit-plan', outcome: 'cancelled',
    feedback: '@plan.md:3\nExplain this step.',
  }]);
});

test('Grok provider keeps completed question cards when replaying history', async () => {
  const data = await fixture();
  const snapshot = await data.acpClient.loadSession({ sessionId: data.parentId });
  snapshot.events.splice(-1, 0,
    { timestamp: 7.1, params: { update: {
      sessionUpdate: 'tool_call', toolCallId: 'ask-history', title: 'ask_user_question',
      rawInput: { questions: [{ question: 'Choose a release', options: [
        { label: 'Preview', description: 'Ship a preview build' },
        { label: 'Stable', description: 'Ship the stable build' },
      ] }] },
      _meta: { 'x.ai/tool': { name: 'ask_user_question', kind: 'ask_user' } },
    } } },
    { timestamp: 7.2, params: { update: {
      sessionUpdate: 'tool_call_update', toolCallId: 'ask-history', status: 'completed',
      rawInput: { variant: 'AskUserQuestion', questions: [{
        question: 'Choose a release', options: [
          { label: 'Preview', description: 'Ship a preview build' },
          { label: 'Stable', description: 'Ship the stable build' },
        ], multiSelect: false,
      }] },
      content: [{ type: 'content', content: { type: 'text', text: 'User answered Preview' } }],
      _meta: { 'x.ai/tool': { name: 'ask_user_question', kind: 'ask_user' } },
    } } },
  );
  const registry = createConversationRegistry({ providers: [createGrokConversationProvider({ acpClient: data.acpClient })] });
  const conversation = await registry.read({
    cwd: data.cwd, command: `grok --leader --session-id ${data.parentId}`,
    conversationThreadId: data.parentId,
  });
  const question = conversation.items.find((item) => item.questionId === 'ask-history');
  assert.equal(question.type, 'question');
  assert.equal(question.status, 'completed');
  assert.equal(question.answerSummary, 'User answered Preview');
  assert.ok(!conversation.items.some((item) => item.type === 'tool' && item.toolCallId === 'ask-history'));
});

test('Grok provider exposes turn lifecycle status and renders only cancelled turn boundaries', async () => {
  const data = await fixture();
  const provider = createGrokConversationProvider({ acpClient: data.acpClient });
  const session = {
    cwd: data.cwd, command: `grok --leader --session-id ${data.parentId}`,
    conversationThreadId: data.parentId,
  };
  const registry = createConversationRegistry({ providers: [provider] });
  assert.equal(await registry.status(session), 'idle');

  data.acpClient.append(data.parentId, { timestamp: 8, params: { update: {
    sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Run another turn' },
  } } });
  assert.equal(await registry.status(session), 'working');
  const working = await registry.read(session);
  assert.ok(!working.items.some((item) => item.type === 'turn' && item.status !== 'retrying'));
  assert.deepEqual(working.activity, {
    active: true, phase: 'waiting', label: 'Waiting for response…', canCancel: true, cancelRequested: false,
  });

  data.acpClient.append(data.parentId, { timestamp: 8.1, params: { update: {
    sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Checking.' },
  } } });
  assert.equal((await registry.read(session)).activity.label, 'Thinking…');
  data.acpClient.append(data.parentId, { timestamp: 8.2, params: { update: {
    sessionUpdate: 'tool_call', toolCallId: 'activity-tool', title: 'read_file',
    _meta: { 'x.ai/tool': { name: 'read_file', kind: 'read', label: 'Read' } },
  } } });
  assert.equal((await registry.read(session)).activity.label, 'Preparing read_file…');
  data.acpClient.append(data.parentId, { timestamp: 8.3, params: { update: {
    sessionUpdate: 'tool_call_update', toolCallId: 'activity-tool', title: 'Read package manifest', status: 'in_progress',
  } } });
  assert.equal((await registry.read(session)).activity.label, 'Read package manifest…');
  data.acpClient.append(data.parentId, { timestamp: 8.4, params: { update: {
    sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Here is the answer.' },
  } } });
  assert.equal((await registry.read(session)).activity.label, 'Responding…');

  await registry.cancel(session);
  assert.deepEqual(data.cancellations, [{ sessionId: data.parentId, cwd: data.cwd }]);

  data.acpClient.append(data.parentId, { timestamp: 9, params: { update: {
    sessionUpdate: 'turn_completed', stop_reason: 'cancelled',
  } } });
  data.snapshots.get(data.parentId).turn = { active: false, cancelRequested: false };
  assert.equal(await registry.status(session), 'idle');
  const cancelled = await registry.read(session);
  assert.deepEqual(cancelled.activity, { active: false });
  assert.deepEqual(cancelled.items.filter((item) => item.type === 'turn' && item.status === 'cancelled').map((item) => ({
    title: item.title,
    status: item.status,
    stopReason: item.stopReason,
    durationMs: item.durationMs,
  })), [{
    title: 'Turn cancelled by user',
    status: 'cancelled',
    stopReason: 'cancelled',
    durationMs: 1_000,
  }]);

  data.acpClient.append(data.parentId, { timestamp: 10, params: { update: {
    sessionUpdate: 'turn_started',
  } } });
  data.acpClient.append(data.parentId, { timestamp: 12, params: { update: {
    sessionUpdate: 'turn_completed', stop_reason: 'model_error', error: 'The model backend is unavailable',
  } } });
  data.snapshots.get(data.parentId).turn = { active: false, cancelRequested: false };
  const failed = await registry.read(session);
  assert.deepEqual(failed.items.filter((item) => item.type === 'turn' && item.status === 'failed').map((item) => ({
    title: item.title, status: item.status, text: item.text, durationMs: item.durationMs,
  })), [{
    title: 'Turn ended with an error', status: 'failed',
    text: 'The model backend is unavailable', durationMs: 2_000,
  }]);

  // Grok can flush a final tool update after its authoritative turn boundary.
  // That event belongs to the completed turn and must not restart activity.
  data.acpClient.append(data.parentId, { timestamp: 9.1, params: { update: {
    sessionUpdate: 'tool_call_update', toolCallId: 'activity-tool',
    title: 'Read package manifest', status: 'completed',
  } } });
  assert.equal(await registry.status(session), 'idle');
  assert.equal((await registry.read(session)).thread.status, 'idle');
  assert.deepEqual((await registry.read(session)).activity, { active: false });
});

test('Grok provider settles a desktop-originated turn from Grok persisted lifecycle', async () => {
  const data = await fixture();
  const snapshot = data.snapshots.get(data.parentId);
  snapshot.turn = { active: true, cancelRequested: false, changedAt: 8_000 };
  let lifecycle = { active: true, changedAt: 8_000 };
  const provider = createGrokConversationProvider({
    acpClient: data.acpClient,
    loadLifecycle: async () => lifecycle,
  });
  const registry = createConversationRegistry({ providers: [provider] });
  const session = {
    cwd: data.cwd, command: `grok --leader --session-id ${data.parentId}`,
    conversationThreadId: data.parentId,
  };

  assert.equal(await registry.status(session), 'working');
  lifecycle = { active: false, changedAt: 9_000 };
  const settled = await registry.read(session);
  assert.equal(settled.thread.status, 'idle');
  assert.deepEqual(settled.activity, { active: false });
  assert.deepEqual(data.lifecycleSyncs.at(-1), {
    sessionId: data.parentId, active: false, changedAt: 9_000,
  });
  await registry.sendSessionInput(session, 'fresh after desktop completion');
  assert.equal(data.prompts.at(-1).text, 'fresh after desktop completion');
  assert.deepEqual(data.lifecycleSyncs.at(-1), {
    sessionId: data.parentId, active: false, changedAt: 9_000,
  }, 'the action path must reconcile the same persisted boundary before prompting');
  assert.equal(await registry.status(session), 'idle');

  lifecycle = { active: false, changedAt: 7_000 };
  assert.equal(await registry.status(session), 'working',
    'an older persisted boundary must not override a newer live turn');
});

test('Grok provider stream polls an active persisted turn until the desktop boundary settles', async () => {
  const data = await fixture();
  data.snapshots.get(data.parentId).turn = { active: true, cancelRequested: false, changedAt: 8_000 };
  let lifecycle = { active: true, changedAt: 8_000 };
  const provider = createGrokConversationProvider({
    acpClient: data.acpClient,
    loadLifecycle: async () => lifecycle,
  });
  const session = {
    cwd: data.cwd, command: `grok --leader --session-id ${data.parentId}`,
    conversationThreadId: data.parentId,
  };
  const handle = await provider.detect(session);
  const updates = [];
  const stop = await provider.watch(handle, {}, (conversation) => updates.push(conversation));
  assert.equal(updates.at(-1).activity.active, true);

  lifecycle = { active: false, changedAt: 9_000 };
  const deadline = Date.now() + 1_000;
  while (updates.at(-1)?.activity?.active !== false && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(updates.at(-1).activity.active, false);
  await stop();
});

test('Grok provider exposes advertised models, context usage, and changes the root model', async () => {
  const data = await fixture();
  data.snapshots.get(data.parentId).metadata.models = {
    currentModelId: 'qwen-local',
    availableModels: [
      { modelId: 'qwen-local', name: 'Qwen 3.8 27B', _meta: { totalContextTokens: 190_000 } },
      { modelId: 'grok-4.6', name: 'Grok 4.6', provider: { id: 'xai', label: 'xAI' }, description: 'Frontier model', _meta: {
        totalContextTokens: 500_000, supportsReasoningEffort: true, reasoningEffort: 'high',
        reasoningEfforts: [
          { id: 'high', value: 'high', label: 'High Effort', description: 'Deep work', default: true },
          { id: 'low', value: 'low', label: 'Low Effort', description: 'Quick work', default: false },
        ],
      } },
    ],
  };
  let signals = { contextTokensUsed: 5_979, contextWindowTokens: 190_000, contextWindowUsage: 3 };
  const provider = createGrokConversationProvider({
    acpClient: data.acpClient,
    loadSignals: async () => signals,
  });
  const registry = createConversationRegistry({ providers: [provider] });
  const session = {
    name: 'ar-chat', cwd: data.cwd,
    command: `grok --leader --session-id ${data.parentId}`, conversationThreadId: data.parentId,
  };

  const result = await registry.read(session);
  assert.deepEqual(result.controls.model, {
    currentId: 'qwen-local',
    options: [
      { id: 'qwen-local', label: 'Qwen 3.8 27B', provider: { id: 'local', label: 'Local' }, description: '', contextWindowTokens: 190_000 },
      { id: 'grok-4.6', label: 'Grok 4.6', description: 'Frontier model', contextWindowTokens: 500_000,
        provider: { id: 'xai', label: 'xAI' },
        currentEffortId: 'high', efforts: [
          { id: 'high', value: 'high', label: 'High Effort', description: 'Deep work', default: true },
          { id: 'low', value: 'low', label: 'Low Effort', description: 'Quick work', default: false },
        ] },
    ],
  });
  assert.deepEqual(result.context, { usedTokens: 5_979, windowTokens: 190_000, usagePercent: 3 });
  signals = undefined;
  const resultBeforeSignals = await registry.read(session);
  assert.deepEqual(resultBeforeSignals.context, { usedTokens: 0, windowTokens: 190_000, usagePercent: 0 });

  await registry.setModel(session, 'grok-4.6');
  assert.deepEqual(data.modelChanges, [{
    sessionId: data.parentId, cwd: data.cwd, modelId: 'grok-4.6',
  }]);
});

test('Grok provider refreshes context usage after a streamed turn completes', async () => {
  const data = await fixture();
  data.snapshots.get(data.parentId).metadata.models = {
    currentModelId: 'qwen-local',
    availableModels: [
      { modelId: 'qwen-local', name: 'Qwen', _meta: { totalContextTokens: 190_000 } },
    ],
  };
  let signals = { contextTokensUsed: 1_000, contextWindowTokens: 190_000 };
  const provider = createGrokConversationProvider({
    acpClient: data.acpClient,
    loadSignals: async () => signals,
  });
  const session = {
    name: 'ar-chat', cwd: data.cwd,
    command: `grok --leader --session-id ${data.parentId}`, conversationThreadId: data.parentId,
  };
  const handle = await provider.detect(session);
  const updates = [];
  const stop = await provider.watch(handle, {}, (conversation) => updates.push(conversation));
  assert.equal(updates.at(-1).context.usedTokens, 1_000);

  data.acpClient.append(data.parentId, {
    timestamp: 8, params: { update: { sessionUpdate: 'turn_started' } },
  });
  data.acpClient.append(data.parentId, {
    timestamp: 9, params: { update: {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'A new answer.' },
    } },
  });
  signals = { contextTokensUsed: 2_500, contextWindowTokens: 190_000 };
  data.acpClient.append(data.parentId, {
    timestamp: 10, params: { update: { sessionUpdate: 'turn_completed' } },
  });

  const deadline = Date.now() + 1_500;
  while (updates.at(-1)?.context?.usedTokens !== 2_500 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(updates.at(-1).activity.active, false);
  assert.equal(updates.at(-1).context.usedTokens, 2_500);
  await stop();
});
