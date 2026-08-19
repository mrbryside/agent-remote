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
    async respondQuestion(input) { questionResponses.push(input); },
    async respondPlanReview(input) { planReviewResponses.push(input); },
    append(sessionId, record) {
      snapshots.get(sessionId).events.push(record);
      for (const listener of listeners.get(sessionId) || []) listener(snapshots.get(sessionId));
    },
    close: async () => {},
  };
  return {
    cwd, parentId, childId, acpClient, prompts, questionResponses, planReviewResponses,
    modelChanges, cancellations, snapshots,
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
    { id: data.childId, title: 'Explore the project', status: 'completed' },
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
  assert.ok(!result.items.some((item) => item.type === 'recap' || item.type === 'turn'));
  assert.equal(result.recap.text, 'Work so far');
  for (const kind of ['hook', 'retry']) {
    assert.ok(result.items.some((item) => item.type === 'event' && item.kind === kind), `missing ${kind} event`);
  }
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
  await registry.sendSessionInput({
    cwd: data.cwd, command: `grok --leader --session-id ${data.parentId}`,
    conversationThreadId: data.parentId,
  }, 'hello from phone');
  assert.equal(data.prompts[0].text, 'hello from phone');
});

test('Grok provider groups adjacent mixed tools across resolved permissions and closes thoughts at boundaries', async () => {
  const data = await fixture();
  const snapshot = await data.acpClient.loadSession({ sessionId: data.parentId });
  snapshot.events = [
    { timestamp: 1, params: { update: {
      sessionUpdate: 'tool_call', toolCallId: 'shell-1', title: 'Run checks', status: 'running',
      rawInput: { variant: 'Bash', command: 'npm test -- --runInBand' },
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
  assert.equal(result.items[0].tools[0].command, 'npm test -- --runInBand');
  assert.equal(result.items[1].text, 'I should verify this. The boundary matters.');
  assert.equal(result.items[1].status, 'completed');
  assert.equal(result.items[2].toolCallId, 'read-1');
  assert.equal(result.items[2].status, 'working');
  assert.ok(!result.items.some((item) => item.type === 'permission'));
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
    if (input.sessionId !== data.parentId || ++rootLoads !== 2) return snapshot;
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
  assert.deepEqual(updates.slice(1).map((event) => event.conversation.thread.status), ['idle']);
  assert.deepEqual(updates.at(-1).conversation.activity, { active: false });
  await stop();
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

test('Grok provider exposes turn lifecycle status without rendering lifecycle events', async () => {
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
  assert.ok(!working.items.some((item) => item.type === 'turn'));
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
    sessionUpdate: 'turn_completed', stop_reason: 'end_turn',
  } } });
  data.snapshots.get(data.parentId).turn = { active: false, cancelRequested: false };
  assert.equal(await registry.status(session), 'idle');
  assert.deepEqual((await registry.read(session)).activity, { active: false });

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

test('Grok provider exposes advertised models, context usage, and changes the root model', async () => {
  const data = await fixture();
  data.snapshots.get(data.parentId).metadata.models = {
    currentModelId: 'qwen-local',
    availableModels: [
      { modelId: 'qwen-local', name: 'Qwen 3.8 27B', _meta: { totalContextTokens: 190_000 } },
      { modelId: 'grok-4.6', name: 'Grok 4.6', description: 'Frontier model', _meta: { totalContextTokens: 500_000 } },
    ],
  };
  const provider = createGrokConversationProvider({
    acpClient: data.acpClient,
    loadSignals: async () => ({ contextTokensUsed: 5_979, contextWindowTokens: 190_000, contextWindowUsage: 3 }),
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
      { id: 'qwen-local', label: 'Qwen 3.8 27B', description: '', contextWindowTokens: 190_000 },
      { id: 'grok-4.6', label: 'Grok 4.6', description: 'Frontier model', contextWindowTokens: 500_000 },
    ],
  });
  assert.deepEqual(result.context, { usedTokens: 5_979, windowTokens: 190_000, usagePercent: 3 });

  await registry.setModel(session, 'grok-4.6');
  assert.deepEqual(data.modelChanges, [{
    sessionId: data.parentId, cwd: data.cwd, modelId: 'grok-4.6',
  }]);
});
