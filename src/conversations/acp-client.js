import { execFile as execFileProcess, spawn as spawnProcess } from 'node:child_process';
import { delimiter } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';

const execFile = promisify(execFileProcess);

const maxLineBytes = 8 * 1024 * 1024;
const maxQuestionCount = 20;
const maxQuestionOptions = 30;
const maxQuestionText = 4_000;
const maxAnswerText = 4_000;
const maxPlanText = 512 * 1024;
const maxPlanFeedback = 32 * 1024;
const modelIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,79}$/;
const conversationModes = new Set(['default', 'plan']);
const permissionModes = new Set(['default', 'auto', 'bypassPermissions']);
const unifiedModes = new Set(['normal', 'plan', 'auto', 'alwaysApprove']);
const hostControlEnvironmentPrefixes = ['CODEX_', 'NODE_REPL_', 'BROWSER_USE_'];
const hostControlEnvironmentKeys = new Set([
  'AGENT_REMOTE_GRAPHICS',
  'AGENT_REMOTE_RENDERER',
  'AGENT_REMOTE_SESSION',
  'TMUX',
  'TMUX_PANE',
]);
const hostControlPathFragments = [
  '/.codex/tmp/',
  '/.cache/codex-runtimes/',
  '/Applications/ChatGPT.app/Contents/Resources',
  '/var/run/com.apple.security.cryptexd/codex.system/',
  '/pkg/env/global/bin',
];
const planPromptPrefix = `<system_reminder>
The user selected Plan mode in the client. If Plan mode is not already active, call \`enter_plan_mode\` before handling the request. Stay in Plan mode: inspect and reason, do not modify the project, write the plan file, and present the completed plan for review through \`exit_plan_mode\`.
</system_reminder>
<user_query>
`;
const planPromptSuffix = '\n</user_query>';

function grokProcessEnvironment(environment) {
  const result = { ...environment };
  for (const key of Object.keys(result)) {
    if (hostControlEnvironmentKeys.has(key) ||
        hostControlEnvironmentPrefixes.some((prefix) => key.startsWith(prefix))) delete result[key];
  }
  if (typeof result.PATH === 'string') {
    result.PATH = result.PATH.split(delimiter)
      .filter((entry) => entry && !hostControlPathFragments.some((fragment) => entry.includes(fragment)))
      .filter((entry, index, entries) => entries.indexOf(entry) === index)
      .join(delimiter);
  }
  // The ACP transport itself uses pipes, but the detached shared leader owns
  // every terminal tool launched by both ACP and the Grok TUI. Do not let a
  // headless server's TERM=dumb leak into that long-lived command runner.
  result.TERM = 'xterm-256color';
  return result;
}

export function grokLeaderEnvironmentIsUnsafe(environmentLine) {
  const text = String(environmentLine || '');
  const keys = [...text.matchAll(/(?:^|\s)([A-Z][A-Z0-9_]+)=/g)].map((match) => match[1]);
  if (keys.some((key) =>
    hostControlEnvironmentPrefixes.some((prefix) => key.startsWith(prefix)))) return true;
  const path = /(?:^|\s)PATH=([^\s]*)/.exec(text)?.[1];
  if (path?.split(delimiter).some((entry) =>
    hostControlPathFragments.some((fragment) => entry.includes(fragment)))) return true;
  return /(?:^|\s)TERM=dumb(?:\s|$)/.test(text);
}

async function verifiedSocketLeaderPids(leaderSocket, logger) {
  if (!leaderSocket) return [];
  let stdout;
  try {
    // Query every Unix descriptor instead of asking lsof to stat the socket
    // path. A restarted test server can unlink/recreate that pathname while an
    // older daemon still holds the previous inode; lsof's direct path selector
    // then misses exactly the orphan we need to reap.
    ({ stdout } = await execFile('lsof', ['-n', '-U', '-Fpn'], { maxBuffer: 8 * 1024 * 1024 }));
  } catch (error) {
    // lsof exits 1 when no process owns the socket, which is already clean.
    if (error?.code !== 1) logger?.(`Could not inspect Grok leader socket: ${error.message}`);
    return [];
  }
  const socketPids = new Set();
  let listedPid;
  for (const line of String(stdout).split('\n')) {
    if (line.startsWith('p')) listedPid = Number(line.slice(1));
    else if (line === `n${leaderSocket}` && Number.isSafeInteger(listedPid)) socketPids.add(listedPid);
  }
  const verified = [];
  for (const pid of socketPids) {
    if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) continue;
    try {
      const result = await execFile('ps', ['-p', String(pid), '-o', 'command='], { maxBuffer: 64 * 1024 });
      if (!/(?:^|\/)grok(?:-[^ ]+)?\s+agent\s+leader(?:\s|$)/.test(result.stdout.trim())) continue;
      verified.push(pid);
    } catch (error) {
      if (error?.code !== 'ESRCH' && error?.code !== 1) logger?.(`Could not inspect Grok leader ${pid}: ${error.message}`);
    }
  }
  return verified;
}

async function socketLeaderEnvironmentIsUnsafe(leaderSocket, logger) {
  const pids = await verifiedSocketLeaderPids(leaderSocket, logger);
  for (const pid of pids) {
    try {
      const result = await execFile('ps', ['eww', '-p', String(pid), '-o', 'command='], { maxBuffer: 1024 * 1024 });
      if (grokLeaderEnvironmentIsUnsafe(result.stdout)) return true;
    } catch (error) {
      if (error?.code !== 'ESRCH' && error?.code !== 1) {
        logger?.(`Could not inspect Grok leader environment ${pid}: ${error.message}`);
      }
    }
  }
  return false;
}

async function terminateSocketLeader(leaderSocket, logger) {
  const stopped = [];
  for (const pid of await verifiedSocketLeaderPids(leaderSocket, logger)) {
    try {
      process.kill(pid, 'SIGTERM');
      stopped.push(pid);
    } catch (error) {
      if (error?.code !== 'ESRCH') logger?.(`Could not stop Grok leader ${pid}: ${error.message}`);
    }
  }
  for (const pid of stopped) {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      try { process.kill(pid, 0); }
      catch { break; }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    try {
      process.kill(pid, 0);
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
}

function unifiedMode(current) {
  if (unifiedModes.has(current.pendingModeId)) return current.pendingModeId;
  if (current.currentMode === 'plan') return 'plan';
  if (current.permissionMode === 'auto') return 'auto';
  if (current.permissionMode === 'bypassPermissions') return 'alwaysApprove';
  return 'normal';
}

function wirePromptText(text, modeId) {
  return modeId === 'plan' ? `${planPromptPrefix}${text}${planPromptSuffix}` : text;
}

function visiblePromptText(text) {
  if (!text.startsWith(planPromptPrefix) || !text.endsWith(planPromptSuffix)) return text;
  return text.slice(planPromptPrefix.length, -planPromptSuffix.length);
}

function rpcError(message, code = 'GROK_ACP_ERROR') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function reasoningEfforts(model) {
  const values = Array.isArray(model?._meta?.reasoningEfforts) ? model._meta.reasoningEfforts : [];
  return values.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const id = typeof entry.id === 'string' && entry.id ? entry.id : entry.value;
    const value = typeof entry.value === 'string' && entry.value ? entry.value : id;
    return modelIdPattern.test(id || '') && modelIdPattern.test(value || '') ? [{ id, value }] : [];
  });
}

function metadataWithModel(metadata, modelId, effortValue) {
  if (!metadata) return metadata;
  const detail = metadata._meta?.['x.ai/sessionDetail'];
  const availableModels = Array.isArray(metadata.models?.availableModels)
    ? metadata.models.availableModels.map((model) => model?.modelId === modelId && effortValue
      ? { ...model, _meta: { ...(model._meta || {}), reasoningEffort: effortValue } }
      : model)
    : metadata.models?.availableModels;
  return {
    ...metadata,
    models: { ...(metadata.models || {}), currentModelId: modelId, ...(availableModels ? { availableModels } : {}) },
    ...(detail && typeof detail === 'object' ? {
      _meta: {
        ...(metadata._meta || {}),
        'x.ai/sessionDetail': { ...detail, currentModelId: modelId },
      },
    } : {}),
  };
}

function eventRecord(params) {
  const update = params?.update;
  if (!params?.sessionId || !update || typeof update !== 'object') return undefined;
  return {
    id: params._meta?.eventId,
    timestamp: Number(params._meta?.agentTimestampMs) || Date.now(),
    replay: params._meta?.isReplay === true,
    params: { update },
  };
}

function agentStreamStart(params) {
  const value = Number(params?._meta?.streamStartMs);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function updateText(update) {
  return update?.content?.type === 'text' && typeof update.content.text === 'string'
    ? update.content.text : '';
}

function matchesInterjectionEcho(update, entry) {
  if (update?.sessionUpdate !== 'user_message_chunk') return false;
  const text = updateText(update);
  if (text === entry.text) return true;
  return text.includes(`<user_query>\n${entry.text}\n</user_query>`);
}

function steerBoundary(entry, timestamp = Date.now()) {
  return {
    id: `agent-remote-steer:${entry.id}`,
    timestamp,
    params: { update: {
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: entry.displayText },
      source: 'steer',
      queueId: entry.id,
    } },
  };
}

function boundedString(value, maximum) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}

function toolExecutionStarted(update) {
  if (!['tool_call', 'tool_call_update'].includes(update?.sessionUpdate) ||
      typeof update.toolCallId !== 'string' || !update.toolCallId) return false;
  const status = String(update.status ?? '').trim().toLowerCase().replaceAll('-', '_').replaceAll(' ', '_');
  return ['in_progress', 'running', 'active', 'completed', 'complete', 'succeeded', 'failed', 'error', 'cancelled']
    .includes(status) || update.rawOutput !== undefined;
}

function runnerKilledBySignalNine(update) {
  if (!['tool_call', 'tool_call_update'].includes(update?.sessionUpdate)) return false;
  const status = String(update.status ?? '').trim().toLowerCase();
  if (!['failed', 'error'].includes(status)) return false;
  const output = update.rawOutput ?? update.output;
  let text;
  try { text = typeof output === 'string' ? output : JSON.stringify(output); }
  catch { return false; }
  return /(?:exit:\s*)?killed\s*\(signal\s*9\)|signal[-_ ]?nine|signal\s*9/i.test(text || '');
}

function externallyApprovedPlanReview(update) {
  if (!['tool_call', 'tool_call_update'].includes(update?.sessionUpdate) ||
      typeof update.toolCallId !== 'string' || !update.toolCallId) return undefined;
  const status = String(update.status ?? '').trim().toLowerCase().replaceAll('-', '_').replaceAll(' ', '_');
  if (!['completed', 'complete', 'succeeded'].includes(status)) return undefined;
  const rawInput = update.rawInput ?? update.input;
  const rawOutput = update.rawOutput ?? update.output;
  const toolName = update._meta?.['x.ai/tool']?.name;
  const isExitPlanMode = toolName === 'exit_plan_mode' || rawInput?.variant === 'ExitPlanMode' ||
    rawOutput?.type === 'ExitPlanMode';
  if (!isExitPlanMode || !rawOutput?.PlanReady || typeof rawOutput.PlanReady !== 'object') return undefined;
  return { reviewId: update.toolCallId, outcome: 'approved' };
}

function allowOption(options) {
  const normalized = (option) => String(option?.kind || option?.optionId || '')
    .trim().toLowerCase().replaceAll('-', '_').replaceAll(' ', '_');
  return options.find((option) => normalized(option) === 'allow_once')
    ?? options.find((option) => normalized(option).includes('allow') && normalized(option).includes('once'))
    ?? options.find((option) => normalized(option).includes('allow'));
}

function subagentSignature(update) {
  const kind = update?.sessionUpdate;
  if (kind === 'tool_call' || kind === 'tool_call_update') {
    const input = update.rawInput ?? update.input ?? update._meta?.['x.ai/tool']?.input;
    const meta = update._meta?.['x.ai/tool'];
    const isSpawn = meta?.name === 'spawn_subagent' || update.title === 'spawn_subagent' ||
      (input?.variant === 'Task' && (input.description || input.prompt));
    if (!isSpawn || !input || typeof input !== 'object') return undefined;
    const description = String(input.description || '').trim();
    const role = String(input.subagent_type || input.role || '').trim();
    return `${description}\u0000${role}`;
  }
  if (kind !== 'subagent_spawned') return undefined;
  const description = String(update.description || '').trim();
  const role = String(update.subagent_type || update.role || '').trim();
  return `${description}\u0000${role}`;
}

function questionError(message, code = 'GROK_ACP_QUESTION_INVALID') {
  return rpcError(message, code);
}

function planError(message, code = 'GROK_ACP_PLAN_INVALID') {
  return rpcError(message, code);
}

function normalizePlanReview(params) {
  if (!boundedString(params?.sessionId, 160) || !boundedString(params?.toolCallId, 160)) {
    throw planError('Plan review must include a sessionId and toolCallId');
  }
  if (typeof params.planContent !== 'string' || params.planContent.length > maxPlanText) {
    throw planError('Plan review content must be a string under 512 KiB');
  }
  return {
    sessionId: params.sessionId,
    toolCallId: params.toolCallId,
    planContent: params.planContent,
  };
}

function normalizeQuestions(params) {
  if (!boundedString(params?.sessionId, 160) || !boundedString(params?.toolCallId, 160)) {
    throw questionError('Question request must include a sessionId and toolCallId');
  }
  if (params.mode !== undefined && !boundedString(params.mode, 80)) {
    throw questionError('Question mode must be a non-empty string under 80 characters');
  }
  if (!Array.isArray(params.questions) || params.questions.length === 0 || params.questions.length > maxQuestionCount) {
    throw questionError(`Question request must include between 1 and ${maxQuestionCount} questions`);
  }
  const prompts = new Set();
  const questions = params.questions.map((question) => {
    if (!question || !boundedString(question.question, maxQuestionText) || prompts.has(question.question)) {
      throw questionError('Each question must have a unique non-empty prompt');
    }
    prompts.add(question.question);
    if (!Array.isArray(question.options) || question.options.length === 0 || question.options.length > maxQuestionOptions) {
      throw questionError(`Each question must include between 1 and ${maxQuestionOptions} options`);
    }
    const labels = new Set();
    const options = question.options.map((option) => {
      if (!option || !boundedString(option.label, 500) || labels.has(option.label) ||
          !boundedString(option.description, maxQuestionText) ||
          (option.preview !== undefined && !boundedString(option.preview, maxQuestionText))) {
        throw questionError('Each question option must have unique bounded label and description values');
      }
      labels.add(option.label);
      return option.preview === undefined
        ? { label: option.label, description: option.description }
        : { label: option.label, description: option.description, preview: option.preview };
    });
    if (question.multiSelect !== null && typeof question.multiSelect !== 'boolean') {
      throw questionError('Question multiSelect must be boolean or null');
    }
    return { question: question.question, options, multiSelect: question.multiSelect };
  });
  return {
    sessionId: params.sessionId, toolCallId: params.toolCallId,
    mode: params.mode ?? 'default', questions,
  };
}

function normalizeQuestionResponse(questionRequest, input) {
  const outcome = input?.outcome ?? 'accepted';
  if (!['accepted', 'skip_interview'].includes(outcome)) {
    throw questionError('Question outcome must be accepted or skip_interview');
  }
  if (outcome !== 'accepted') return { outcome };
  const answers = input?.answers;
  if (!answers || typeof answers !== 'object' || Array.isArray(answers) || Object.keys(answers).length !== questionRequest.questions.length) {
    throw questionError('Accepted questions require one answer for every prompt');
  }
  const normalized = {};
  for (const question of questionRequest.questions) {
    const answer = answers[question.question];
    if (!boundedString(answer, maxAnswerText)) throw questionError('Question answers must be bounded non-empty strings');
    normalized[question.question] = answer;
  }
  if (Object.keys(answers).some((key) => !questionRequest.questions.some((question) => question.question === key))) {
    throw questionError('Question answers contain an unknown prompt');
  }
  return { outcome, answers: normalized };
}

export function createGrokAcpClient({
  command = 'grok',
  spawn = spawnProcess,
  logger = () => {},
  environment = () => ({}),
  defaultPermissionMode = 'default',
  leaderSocket,
  terminateLeaderOnClose = false,
  terminateLeader = terminateSocketLeader,
  leaderEnvironmentIsUnsafe = socketLeaderEnvironmentIsUnsafe,
  runnerRecoveryDelayMs = 300,
} = {}) {
  let child;
  let lines;
  let initialized;
  let nextId = 1;
  let generation = 0;
  let closing = false;
  let runnerRecoveryRequested = false;
  let runnerRecoveryPromise;
  let leaderEnvironmentRefresh;
  const pending = new Map();
  const sessions = new Map();

  function state(sessionId) {
    let value = sessions.get(sessionId);
    if (!value) {
      value = {
        events: [], eventIds: new Set(), listeners: new Set(),
        loadedGeneration: 0, loading: undefined, metadata: undefined, cwd: undefined,
        activePrompt: undefined,
        queuedPrompts: [],
        pendingSteers: [],
        lastAgentStreamStart: undefined,
        drainingPrompts: undefined,
        turnActive: false,
        cancelRequested: false,
        pendingModelId: undefined,
        pendingEffortId: undefined,
        pendingModeId: undefined,
        currentMode: 'default',
        permissionMode: permissionModes.has(defaultPermissionMode) ? defaultPermissionMode : 'default',
        commands: [],
        permissions: new Map(),
        executedToolCallIds: new Set(),
        queuedSubagentToolCallIds: new Set(),
        pendingSubagentToolCalls: new Map(),
        questions: new Map(),
        planReviews: new Map(),
        externallyResolvedPlanReviews: new Map(),
        turnSource: 'idle',
        turnChangedAt: 0,
      };
      sessions.set(sessionId, value);
    }
    return value;
  }

  function publish(sessionId) {
    const current = state(sessionId);
    const snapshot = read(sessionId);
    for (const listener of [...current.listeners]) listener(snapshot);
  }

  function synchronizeTurn({ sessionId, active, changedAt }) {
    const current = state(sessionId);
    const boundary = Number(changedAt);
    if (!Number.isFinite(boundary) || boundary < 0) {
      throw rpcError('Turn lifecycle timestamp is invalid', 'GROK_ACP_TURN_INVALID');
    }
    // A persisted boundary may be read after a newer local prompt has already
    // started. Never let that older disk snapshot stop or resurrect the newer
    // turn.
    if (boundary < current.turnChangedAt) {
      return { applied: false, active: current.turnActive };
    }

    let changed = false;
    if (active) {
      const newTurn = !current.turnActive || boundary > current.turnChangedAt;
      changed = newTurn || current.turnSource !== 'persisted' || current.turnChangedAt !== boundary;
      current.turnActive = true;
      current.turnSource = 'persisted';
      current.turnChangedAt = boundary;
      if (newTurn) current.cancelRequested = false;
    } else {
      // Grok's terminal UI and the ACP observer do not always receive the same
      // lifecycle notification. A durable completion is authoritative: free
      // the stale RPC slot so the next message is sent as a new turn.
      changed = Boolean(current.activePrompt || current.drainingPrompts || current.pendingSteers.length ||
        current.lastAgentStreamStart !== undefined || current.turnActive || current.cancelRequested ||
        current.turnChangedAt !== boundary || current.turnSource !== 'idle');
      for (const pendingSteer of current.pendingSteers.splice(0)) {
        current.events.push(steerBoundary(pendingSteer, boundary));
      }
      current.activePrompt = undefined;
      current.drainingPrompts = undefined;
      current.lastAgentStreamStart = undefined;
      current.turnActive = false;
      current.turnSource = 'idle';
      current.turnChangedAt = boundary;
      current.cancelRequested = false;
    }
    if (changed) publish(sessionId);
    if (!active && current.queuedPrompts.length > 0) void drainPrompts(sessionId);
    return { applied: true, active: Boolean(active) };
  }

  function acceptNotification(message) {
    if (!['session/update', '_x.ai/session/update'].includes(message.method)) return;
    let record = eventRecord(message.params);
    if (!record) return;
    const current = state(message.params.sessionId);
    if (record.id && current.eventIds.has(record.id)) return;
    if (record.id) current.eventIds.add(record.id);
    let update = record.params.update;
    if (update.sessionUpdate === 'user_message_chunk') {
      const text = updateText(update);
      const visibleText = visiblePromptText(text);
      if (visibleText !== text) {
        update = { ...update, content: { ...update.content, text: visibleText } };
        record = { ...record, params: { update } };
      }
    }
    const pendingSteer = current.pendingSteers[0];
    const streamStart = agentStreamStart(message.params);
    if (pendingSteer && matchesInterjectionEcho(update, pendingSteer)) {
      update = {
        ...update,
        content: { type: 'text', text: pendingSteer.displayText },
        source: 'steer',
        queueId: pendingSteer.id,
      };
      record = { ...record, params: { update } };
      pendingSteer.boundaryRecord = record;
      current.pendingSteers.shift();
    } else if (pendingSteer && update.sessionUpdate === 'agent_message_chunk' && streamStart !== undefined &&
        pendingSteer.baselineStreamStart !== undefined && streamStart !== pendingSteer.baselineStreamStart) {
      const boundary = steerBoundary(pendingSteer, record.timestamp);
      pendingSteer.boundaryRecord = boundary;
      current.events.push(boundary);
      current.pendingSteers.shift();
    } else if (pendingSteer && update.sessionUpdate === 'turn_completed') {
      // A successful interjection normally starts another model stream inside
      // the same turn. If Grok ends without exposing that stream identity,
      // retain the user message at the final safe boundary instead of placing
      // it in the middle of the interrupted Markdown response.
      const boundary = steerBoundary(pendingSteer, record.timestamp);
      pendingSteer.boundaryRecord = boundary;
      current.events.push(boundary);
      current.pendingSteers.shift();
    }
    current.events.push(record);
    if (!record.replay && runnerKilledBySignalNine(update)) {
      runnerRecoveryRequested = true;
      logger('Grok command runner reported signal 9; recycling the shared leader after the active turn');
    }
    if (update.sessionUpdate === 'turn_started' ||
        (update.sessionUpdate === 'user_message_chunk' && update.source !== 'steer')) {
      current.lastAgentStreamStart = undefined;
    } else if (update.sessionUpdate === 'agent_message_chunk' && streamStart !== undefined) {
      current.lastAgentStreamStart = streamStart;
    } else if (update.sessionUpdate === 'turn_completed') {
      current.lastAgentStreamStart = undefined;
    }
    if (update.sessionUpdate === 'available_commands_update' && Array.isArray(update.availableCommands)) {
      current.commands = update.availableCommands.slice(0, 500).flatMap((command) => {
        if (!command || typeof command.name !== 'string' || !/^[A-Za-z0-9:_-]{1,120}$/.test(command.name)) return [];
        return [{
          name: command.name,
          description: typeof command.description === 'string' ? command.description.slice(0, 500) : '',
          inputHint: typeof command.input?.hint === 'string' ? command.input.hint.slice(0, 160) : '',
          source: typeof command._meta?.scope === 'string' ? command._meta.scope.slice(0, 80) : 'built-in',
        }];
      });
    }
    if (update.sessionUpdate === 'turn_started' ||
        (update.sessionUpdate === 'user_message_chunk' && current.loadedGeneration === generation && !record.replay)) {
      current.turnActive = true;
      current.turnSource = record.replay ? 'replay' : 'live';
      current.turnChangedAt = record.timestamp;
      current.cancelRequested = false;
    } else if (update.sessionUpdate === 'turn_completed') {
      // Grok can publish the authoritative lifecycle boundary before the
      // corresponding session/prompt RPC settles. Release that request from
      // the active slot now so the next user prompt starts a fresh turn
      // instead of being misclassified (and rendered) as queued.
      if (current.activePrompt) {
        current.activePrompt = undefined;
        current.drainingPrompts = undefined;
      }
      current.turnActive = false;
      current.turnSource = 'idle';
      current.turnChangedAt = record.timestamp;
      current.cancelRequested = false;
    } else if (update.sessionUpdate === 'current_mode_update') {
      const nextMode = update.currentModeId ?? update.currentMode;
      if (conversationModes.has(nextMode)) {
        current.currentMode = nextMode;
      }
    }
    const signature = subagentSignature(update);
    if (signature && ['tool_call', 'tool_call_update'].includes(update.sessionUpdate) &&
        typeof update.toolCallId === 'string' && !current.queuedSubagentToolCallIds.has(update.toolCallId) &&
        !current.executedToolCallIds.has(update.toolCallId)) {
      current.queuedSubagentToolCallIds.add(update.toolCallId);
      const queue = current.pendingSubagentToolCalls.get(signature) ?? [];
      queue.push(update.toolCallId);
      current.pendingSubagentToolCalls.set(signature, queue);
    }
    if (toolExecutionStarted(update)) {
      markToolExecuted(current, update.toolCallId);
    } else if (signature && update.sessionUpdate === 'subagent_spawned') {
      const queue = current.pendingSubagentToolCalls.get(signature);
      const toolCallId = queue?.shift();
      if (queue && queue.length === 0) current.pendingSubagentToolCalls.delete(signature);
      if (toolCallId) markToolExecuted(current, toolCallId);
    }
    const planResolution = externallyApprovedPlanReview(update);
    if (planResolution) {
      current.externallyResolvedPlanReviews.set(planResolution.reviewId, planResolution.outcome);
      while (current.externallyResolvedPlanReviews.size > 100) {
        current.externallyResolvedPlanReviews.delete(current.externallyResolvedPlanReviews.keys().next().value);
      }
      const review = current.planReviews.get(planResolution.reviewId);
      if (review) settlePlanReviewFromGrok(current, planResolution.reviewId, review, planResolution.outcome);
    }
    publish(message.params.sessionId);
    if (update.sessionUpdate === 'turn_completed') {
      if (runnerRecoveryRequested) void recoverRunnerAfterSignalNine();
      else void drainPrompts(message.params.sessionId);
    }
  }

  function send(message) {
    if (!child?.stdin?.writable) throw rpcError('Grok ACP connection is not available', 'GROK_ACP_DISCONNECTED');
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  function notify(method, params) {
    send({ jsonrpc: '2.0', method, params });
  }

  function settlePermissionFromGrok(current, permissionId, permission) {
    const selected = allowOption(permission.options);
    if (!selected) return false;
    try {
      send({
        jsonrpc: '2.0', id: permission.rpcId,
        result: { outcome: { outcome: 'selected', optionId: selected.optionId } },
      });
    } catch {
      return false;
    }
    current.permissions.delete(String(permissionId));
    current.events.push({
      timestamp: Date.now(),
      params: { update: {
        sessionUpdate: 'permission_resolved', permissionId: String(permissionId),
        optionId: selected.optionId, label: 'Approved in Grok', resolvedBy: 'grok',
      } },
    });
    return true;
  }

  function settlePlanReviewFromGrok(current, reviewId, review, outcome) {
    try {
      send({ jsonrpc: '2.0', id: review.rpcId, result: { outcome } });
    } catch {
      return false;
    }
    current.planReviews.delete(String(reviewId));
    current.externallyResolvedPlanReviews.delete(String(reviewId));
    current.events.push({
      timestamp: Date.now(),
      params: { update: {
        sessionUpdate: 'plan_review_resolved', reviewId: String(reviewId),
        outcome, resolvedBy: 'grok',
      } },
    });
    return true;
  }

  function markToolExecuted(current, toolCallId) {
    current.executedToolCallIds.add(toolCallId);
    current.queuedSubagentToolCallIds.delete(toolCallId);
    for (const [signature, queue] of current.pendingSubagentToolCalls) {
      const next = queue.filter((id) => id !== toolCallId);
      if (next.length) current.pendingSubagentToolCalls.set(signature, next);
      else current.pendingSubagentToolCalls.delete(signature);
    }
    for (const [permissionId, permission] of current.permissions) {
      if (permission.toolCallId === toolCallId) settlePermissionFromGrok(current, permissionId, permission);
    }
  }

  function request(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, method });
      try { send({ jsonrpc: '2.0', id, method, params }); }
      catch (error) {
        pending.delete(id);
        reject(error);
      }
    });
  }

  function handleLine(line) {
    if (Buffer.byteLength(line, 'utf8') > maxLineBytes) {
      logger('Grok ACP message exceeded the size limit');
      return;
    }
    let message;
    try { message = JSON.parse(line); }
    catch {
      logger('Grok ACP returned invalid JSON');
      return;
    }
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const waiting = pending.get(message.id);
      if (!waiting) return;
      pending.delete(message.id);
      if (message.error) waiting.reject(rpcError(
        `${waiting.method}: ${message.error.message || 'Grok ACP request failed'}`,
      ));
      else waiting.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      if (message.method === '_x.ai/ask_user_question') {
        let question;
        try { question = normalizeQuestions(message.params); }
        catch (error) {
          send({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: error.message } });
          return;
        }
        const current = state(question.sessionId);
        if (current.questions.has(question.toolCallId)) {
          send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'Question request is already active' } });
          return;
        }
        current.questions.set(question.toolCallId, { rpcId: message.id, ...question });
        current.events.push({
          timestamp: Date.now(),
          params: { update: {
            sessionUpdate: 'question_request', questionId: question.toolCallId, toolCallId: question.toolCallId,
            mode: question.mode, questions: question.questions,
          } },
        });
        publish(question.sessionId);
      } else if (['x.ai/exit_plan_mode', '_x.ai/exit_plan_mode'].includes(message.method)) {
        let review;
        try { review = normalizePlanReview(message.params); }
        catch (error) {
          send({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: error.message } });
          return;
        }
        const current = state(review.sessionId);
        const reviewId = review.toolCallId;
        current.planReviews.set(reviewId, { rpcId: message.id, ...review });
        current.events.push({
          timestamp: Date.now(),
          params: { update: {
            sessionUpdate: 'plan_review_request', reviewId, toolCallId: review.toolCallId,
            planContent: review.planContent,
          } },
        });
        const externalOutcome = current.externallyResolvedPlanReviews.get(reviewId);
        if (externalOutcome) {
          settlePlanReviewFromGrok(current, reviewId, current.planReviews.get(reviewId), externalOutcome);
        }
        publish(review.sessionId);
      } else if (message.method === 'session/request_permission' && message.params?.sessionId) {
        const current = state(message.params.sessionId);
        const permissionId = String(message.id);
        const permission = {
          rpcId: message.id,
          options: Array.isArray(message.params.options) ? message.params.options : [],
          toolCallId: typeof message.params.toolCall?.toolCallId === 'string'
            ? message.params.toolCall.toolCallId : undefined,
        };
        current.permissions.set(permissionId, permission);
        current.events.push({
          timestamp: Date.now(),
          params: { update: {
            sessionUpdate: 'permission_request', permissionId,
            title: message.params.toolCall?.title || message.params.toolCall?.name || 'Permission required',
            toolCall: message.params.toolCall,
            options: Array.isArray(message.params.options) ? message.params.options : [],
          } },
        });
        if (permission.toolCallId && current.executedToolCallIds.has(permission.toolCallId)) {
          settlePermissionFromGrok(current, permissionId, permission);
        }
        publish(message.params.sessionId);
      } else {
        send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unsupported client request' } });
      }
      return;
    }
    if (message.method) acceptNotification(message);
  }

  function disconnected(exitCode, exitSignal, silent = false) {
    const exited = child;
    child = undefined;
    initialized = undefined;
    lines?.close();
    lines = undefined;
    const suffix = exitSignal ? ` (${exitSignal})` : exitCode === null ? '' : ` (${exitCode})`;
    const error = rpcError(`Grok ACP connection closed${suffix}`, 'GROK_ACP_DISCONNECTED');
    for (const waiting of pending.values()) waiting.reject(error);
    pending.clear();
    for (const current of sessions.values()) {
      current.loadedGeneration = 0;
      current.loading = undefined;
      current.activePrompt = undefined;
      current.drainingPrompts = undefined;
      current.pendingSteers = [];
      current.permissions.clear();
      current.executedToolCallIds.clear();
      current.queuedSubagentToolCallIds.clear();
      current.pendingSubagentToolCalls.clear();
      current.questions.clear();
      current.planReviews.clear();
      current.externallyResolvedPlanReviews.clear();
      // A disconnected observer cannot keep claiming that an external Grok
      // turn is still running. The next session/load will replay the durable
      // boundary (or a new live turn) and restore the authoritative state.
      current.turnActive = false;
      current.turnSource = 'idle';
      current.turnChangedAt = Date.now();
      current.cancelRequested = false;
    }
    if (!closing) {
      for (const sessionId of sessions.keys()) publish(sessionId);
    }
    if (!closing && exited && !silent) logger(error.message);
  }

  function recoverRunnerAfterSignalNine() {
    if (!runnerRecoveryRequested || runnerRecoveryPromise || closing) return runnerRecoveryPromise;
    if ([...sessions.values()].some((current) => current.turnActive)) return undefined;
    runnerRecoveryPromise = (async () => {
      const owned = child;
      if (owned) {
        disconnected(null, 'SIGTERM', true);
        owned.stdin?.end();
        owned.kill('SIGTERM');
      }
      await terminateLeader(leaderSocket, logger);
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, runnerRecoveryDelayMs)));
      runnerRecoveryRequested = false;
      for (const [sessionId, current] of sessions) {
        if (current.queuedPrompts.length === 0 || !current.cwd) continue;
        try {
          await loadSession({ sessionId, cwd: current.cwd });
          void drainPrompts(sessionId);
        } catch (error) {
          logger(`Could not reconnect Grok after signal 9: ${error.message}`);
        }
      }
    })().finally(() => {
      runnerRecoveryPromise = undefined;
    });
    return runnerRecoveryPromise;
  }

  async function connect() {
    if (initialized) return initialized;
    if (!leaderEnvironmentRefresh) {
      leaderEnvironmentRefresh = (async () => {
        if (!leaderSocket || !await leaderEnvironmentIsUnsafe(leaderSocket, logger)) return false;
        logger('Replacing a Grok leader that inherited an unsafe host environment');
        await terminateLeader(leaderSocket, logger);
        return true;
      })().catch((error) => {
        logger(`Could not refresh Grok leader environment: ${error.message}`);
        return false;
      });
    }
    await leaderEnvironmentRefresh;
    if (initialized) return initialized;
    closing = false;
    generation += 1;
    const args = ['agent', '--leader', 'stdio'];
    if (leaderSocket) args.push('--leader-socket', leaderSocket);
    child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      // A Grok leader outlives this server process. Keep Codex Desktop's
      // per-task control environment and temporary runtime paths out of it;
      // retaining those values after their owning task ends can cause every
      // later terminal tool to be reaped immediately with signal 9.
      env: grokProcessEnvironment({ ...process.env, ...environment() }),
    });
    const connectingChild = child;
    lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', handleLine);
    child.stderr?.on('data', (chunk) => logger(String(chunk).slice(0, 4_096)));
    child.once('error', (error) => {
      if (child === connectingChild) disconnected(null, null);
      logger(error.message);
    });
    child.once('exit', (code, signal) => {
      if (child === connectingChild) disconnected(code, signal);
    });
    initialized = request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    }).catch((error) => {
      if (child === connectingChild) disconnected(null, null);
      throw error;
    });
    await initialized;
    return initialized;
  }

  async function loadSession({ sessionId, cwd }) {
    const current = state(sessionId);
    current.cwd = cwd;
    await connect();
    if (current.loadedGeneration === generation) return read(sessionId);
    if (current.loading) return current.loading;
    const loadingGeneration = generation;
    current.loading = request('session/load', { sessionId, cwd, mcpServers: [] }).then((result) => {
      if (loadingGeneration !== generation) throw rpcError('Grok ACP reconnected while loading');
      current.loadedGeneration = generation;
      current.metadata = result;
      const sessionMeta = result?._meta || {};
      if (sessionMeta.yoloMode === true) current.permissionMode = 'bypassPermissions';
      else if (sessionMeta.autoMode === true) current.permissionMode = 'auto';
      if (current.turnActive && current.turnSource === 'replay') {
        current.events.push({
          timestamp: Date.now(), replay: true,
          params: { update: { sessionUpdate: 'turn_completed', stop_reason: 'loaded' } },
        });
        // Grok's ACP replay omits the terminal lifecycle notification in some
        // completed sessions. Keep the live flag aligned with the persisted
        // boundary we synthesize for the timeline; otherwise mobile stays on
        // Responding and the sidebar spinner runs forever after reload.
        current.turnActive = false;
        current.turnSource = 'idle';
        current.turnChangedAt = Date.now();
        current.cancelRequested = false;
      }
      return read(sessionId);
    }).finally(() => {
      if (current.loading) current.loading = undefined;
    });
    return current.loading;
  }

  function read(sessionId) {
    const current = state(sessionId);
    let metadata = current.metadata;
    if (current.pendingModelId && metadata) {
      const model = metadata.models?.availableModels?.find((entry) => entry?.modelId === current.pendingModelId);
      const effort = reasoningEfforts(model).find((entry) => entry.id === current.pendingEffortId)?.value;
      metadata = metadataWithModel(metadata, current.pendingModelId, effort);
    }
    return {
      sessionId,
      cwd: current.cwd,
      metadata,
      events: current.events.slice(),
      queue: current.queuedPrompts.map(({ id, displayText, createdAt, attachments }) => ({
        id, text: displayText, createdAt, attachments,
      })),
      turn: {
        // `activePrompt` tracks the still-pending JSON-RPC request so queued
        // prompts remain serialized. Grok's `turn_completed` notification is
        // the authoritative user-visible lifecycle boundary and can arrive
        // before that request promise settles.
        active: current.turnActive,
        cancelRequested: current.cancelRequested,
        changedAt: current.turnChangedAt,
      },
      controls: {
        mode: {
          currentId: unifiedMode(current),
          options: [
            { id: 'normal', label: 'Normal', description: 'Work normally and ask before protected calls' },
            { id: 'plan', label: 'Plan', description: 'Plan first without making changes' },
            { id: 'auto', label: 'Auto', description: 'Let Grok approve lower-risk calls' },
            { id: 'alwaysApprove', label: 'Always approve', description: 'Skip ordinary permission prompts' },
          ],
        },
        commands: { options: current.commands.slice() },
      },
    };
  }

  function promptRecord(input) {
    const normalized = String(input.text).replaceAll('\x00', '').slice(0, 64 * 1024);
    const displayText = String(input.displayText ?? input.text).replaceAll('\x00', '').slice(0, 16_384);
    if (!normalized.trim() || !displayText.trim()) throw new Error('Message cannot be empty');
    return {
      id: typeof input.id === 'string' && input.id ? input.id.slice(0, 80) : crypto.randomUUID(),
      text: normalized,
      displayText,
      createdAt: Date.now(),
      attachments: Array.isArray(input.attachments) ? input.attachments.slice(0, 8) : [],
    };
  }

  async function applyModel(current, sessionId, modelId, effortId) {
    const model = current.metadata?.models?.availableModels?.find((entry) => entry?.modelId === modelId);
    const effort = reasoningEfforts(model).find((entry) => entry.id === effortId);
    await request('session/set_model', {
      sessionId, modelId, ...(effort ? { _meta: { reasoningEffort: effort.value } } : {}),
    });
    current.metadata = metadataWithModel(current.metadata || {}, modelId, effort?.value);
  }

  async function applyMode(current, sessionId, modeId) {
    const conversationMode = modeId === 'plan' ? 'plan' : 'default';
    const permissionMode = modeId === 'auto' ? 'auto'
      : modeId === 'alwaysApprove' ? 'bypassPermissions' : 'default';
    // Keep Grok's terminal UI and the mobile control on the same advertised
    // conversation mode. Grok currently treats this RPC as display state, so
    // Plan is still carried in the next prompt to enter the real workflow;
    // permission modes additionally use the vendor leader notification.
    await request('session/set_mode', { sessionId, modeId: conversationMode });
    notify('x.ai/yolo_mode_changed', {
      sessionId,
      auto_mode: permissionMode === 'auto',
      ask: permissionMode === 'default',
    });
    current.currentMode = conversationMode;
    current.permissionMode = permissionMode;
  }

  async function applyPendingControls(current, sessionId) {
    let changed = false;
    while (current.pendingModelId) {
      const modelId = current.pendingModelId;
      const effortId = current.pendingEffortId;
      await applyModel(current, sessionId, modelId, effortId);
      changed = true;
      if (current.pendingModelId === modelId && current.pendingEffortId === effortId) {
        current.pendingModelId = undefined;
        current.pendingEffortId = undefined;
      }
    }
    while (current.pendingModeId) {
      const modeId = current.pendingModeId;
      await applyMode(current, sessionId, modeId);
      changed = true;
      if (current.pendingModeId === modeId) current.pendingModeId = undefined;
    }
    if (changed) publish(sessionId);
  }

  async function drainPrompts(sessionId) {
    const current = state(sessionId);
    if (runnerRecoveryRequested || runnerRecoveryPromise) return;
    if (current.drainingPrompts) return current.drainingPrompts;
    if (current.activePrompt || current.turnActive || current.queuedPrompts.length === 0) return;
    let controlsFailed = false;
    const draining = (async () => {
      try {
        await applyPendingControls(current, sessionId);
      } catch (error) {
        controlsFailed = true;
        logger(error.message);
        return;
      }
      if (current.activePrompt || current.turnActive || current.queuedPrompts.length === 0) return;
      const entry = current.queuedPrompts.shift();
      current.activePrompt = entry;
      current.turnActive = true;
      current.turnSource = 'local';
      current.turnChangedAt = Date.now();
      current.cancelRequested = false;
      publish(sessionId);
      try {
        const result = await request('session/prompt', {
          sessionId, prompt: [{ type: 'text', text: wirePromptText(entry.text, unifiedMode(current)) }],
        });
        current.events.push({
          timestamp: Date.now(),
          params: { update: {
            sessionUpdate: 'turn_completed', stop_reason: result?.stopReason || result?.stop_reason,
          } },
        });
      } catch (error) {
        logger(error.message);
        // The turn already completed successfully when the signal-9 circuit
        // breaker intentionally disconnected this observer. Do not append a
        // synthetic prompt failure for that completed user message.
        if (!(runnerRecoveryPromise && current.activePrompt !== entry)) {
          current.events.push({
            timestamp: Date.now(),
            params: { update: {
              sessionUpdate: 'prompt_failed', promptId: entry.id, text: entry.displayText,
              error: error.message,
            } },
          });
        }
      } finally {
        // A lifecycle notification may have released this RPC before it
        // settled and allowed a newer prompt to start. Never let completion
        // of the older request clear the newer turn.
        if (current.activePrompt === entry) {
          current.activePrompt = undefined;
          current.turnActive = false;
          current.turnSource = 'idle';
          current.turnChangedAt = Date.now();
          current.cancelRequested = false;
          publish(sessionId);
        }
      }
    })();
    current.drainingPrompts = draining;
    try {
      await draining;
    } finally {
      if (current.drainingPrompts === draining) current.drainingPrompts = undefined;
      if (!controlsFailed && !current.activePrompt && !current.turnActive && current.queuedPrompts.length > 0) {
        queueMicrotask(() => void drainPrompts(sessionId));
      }
    }
  }

  async function prompt({ sessionId, cwd, ...input }) {
    const entry = promptRecord(input);
    await loadSession({ sessionId, cwd });
    const current = state(sessionId);
    const queued = Boolean(current.activePrompt || current.turnActive || current.queuedPrompts.length);
    current.queuedPrompts.push(entry);
    // An idle prompt is dispatched immediately. Publishing before the drain
    // moves it into the active slot produces a one-frame fake queue row.
    if (queued) publish(sessionId);
    void drainPrompts(sessionId);
    return { accepted: true, queued, queueId: entry.id };
  }

  async function setModel({ sessionId, cwd, modelId, effortId }) {
    if (typeof modelId !== 'string' || !modelIdPattern.test(modelId)) {
      throw rpcError('Model id is invalid', 'GROK_ACP_MODEL_INVALID');
    }
    await loadSession({ sessionId, cwd });
    const current = state(sessionId);
    const models = current.metadata?.models;
    const available = Array.isArray(models?.availableModels) ? models.availableModels : [];
    const model = available.find((entry) => entry?.modelId === modelId);
    if (!model) {
      throw rpcError('Model is not available for this session', 'GROK_ACP_MODEL_INVALID');
    }
    if (effortId !== undefined && !reasoningEfforts(model).some((entry) => entry.id === effortId)) {
      throw rpcError('Reasoning effort is not available for this model', 'GROK_ACP_MODEL_INVALID');
    }
    if (current.activePrompt || current.turnActive || current.drainingPrompts || current.queuedPrompts.length > 0) {
      current.pendingModelId = modelId;
      current.pendingEffortId = effortId;
      publish(sessionId);
      return { accepted: true, modelId, ...(effortId ? { effortId } : {}), pending: true };
    }
    await applyModel(current, sessionId, modelId, effortId);
    publish(sessionId);
    return { accepted: true, modelId, ...(effortId ? { effortId } : {}) };
  }

  async function cancel({ sessionId, cwd }) {
    await loadSession({ sessionId, cwd });
    const current = state(sessionId);
    const active = Boolean(current.activePrompt || current.turnActive);
    if (!active) return { accepted: false, active: false };
    if (!current.cancelRequested) {
      current.cancelRequested = true;
      notify('session/cancel', { sessionId });
      publish(sessionId);
    }
    return { accepted: true, active: true, cancelRequested: true };
  }

  async function setMode({ sessionId, cwd, modeId }) {
    if (!unifiedModes.has(modeId)) throw rpcError('Conversation mode is invalid', 'GROK_ACP_MODE_INVALID');
    await loadSession({ sessionId, cwd });
    const current = state(sessionId);
    if (current.activePrompt || current.turnActive || current.drainingPrompts || current.queuedPrompts.length > 0) {
      current.pendingModeId = modeId;
      publish(sessionId);
      return { accepted: true, modeId, pending: true };
    }
    await applyMode(current, sessionId, modeId);
    publish(sessionId);
    return { accepted: true, modeId };
  }

  async function removeQueuedPrompt({ sessionId, queueId }) {
    const current = state(sessionId);
    const index = current.queuedPrompts.findIndex((entry) => entry.id === queueId);
    if (index < 0) throw rpcError('Queued message is no longer available', 'GROK_ACP_QUEUE_EXPIRED');
    current.queuedPrompts.splice(index, 1);
    publish(sessionId);
    return { accepted: true };
  }

  async function steerQueuedPrompt({ sessionId, queueId }) {
    const current = state(sessionId);
    const index = current.queuedPrompts.findIndex((entry) => entry.id === queueId);
    if (index < 0) throw rpcError('Queued message is no longer available', 'GROK_ACP_QUEUE_EXPIRED');
    if (!current.activePrompt && !current.turnActive) {
      throw rpcError('There is no active turn to steer', 'GROK_ACP_SESSION_IDLE');
    }
    const [entry] = current.queuedPrompts.splice(index, 1);
    // `_x.ai/interject` can acknowledge before the interrupted model stream
    // has flushed its final chunks. Inserting the user message here would cut
    // an open Markdown block in half. Wait for Grok's interjection echo or the
    // next model-stream identity, then insert the boundary immediately before
    // the steered response.
    const pendingSteer = {
      ...entry,
      baselineStreamStart: current.lastAgentStreamStart,
      boundaryRecord: undefined,
    };
    current.pendingSteers.push(pendingSteer);
    publish(sessionId);
    try {
      await request('_x.ai/interject', { sessionId, text: entry.text });
    } catch (error) {
      const pendingIndex = current.pendingSteers.indexOf(pendingSteer);
      if (pendingIndex >= 0) current.pendingSteers.splice(pendingIndex, 1);
      const boundaryIndex = current.events.indexOf(pendingSteer.boundaryRecord);
      if (boundaryIndex >= 0) current.events.splice(boundaryIndex, 1);
      current.queuedPrompts.splice(Math.min(index, current.queuedPrompts.length), 0, entry);
      publish(sessionId);
      throw error;
    }
    return { accepted: true };
  }

  async function reorderQueuedPrompts({ sessionId, queueIds }) {
    const current = state(sessionId);
    const ids = Array.isArray(queueIds) ? queueIds : [];
    const currentIds = current.queuedPrompts.map((entry) => entry.id);
    const requested = new Set(ids);
    if (ids.length !== currentIds.length || requested.size !== ids.length ||
        ids.some((id) => typeof id !== 'string' || !currentIds.includes(id))) {
      throw rpcError('Queued messages changed before they could be reordered', 'GROK_ACP_QUEUE_INVALID');
    }
    const entries = new Map(current.queuedPrompts.map((entry) => [entry.id, entry]));
    current.queuedPrompts = ids.map((id) => entries.get(id));
    publish(sessionId);
    return { accepted: true, queueIds: ids.slice() };
  }

  function watch(sessionId, listener) {
    const current = state(sessionId);
    current.listeners.add(listener);
    return () => current.listeners.delete(listener);
  }

  async function respondPermission({ sessionId, permissionId, optionId }) {
    const current = state(sessionId);
    const permission = current.permissions.get(String(permissionId));
    if (!permission) throw rpcError('Permission request is no longer active', 'GROK_ACP_PERMISSION_EXPIRED');
    const selected = permission.options.find((option) => option.optionId === optionId);
    if (!selected) throw rpcError('Invalid permission option', 'GROK_ACP_PERMISSION_INVALID');
    current.permissions.delete(String(permissionId));
    send({
      jsonrpc: '2.0', id: permission.rpcId,
      result: { outcome: { outcome: 'selected', optionId } },
    });
    current.events.push({
      timestamp: Date.now(),
      params: { update: {
        sessionUpdate: 'permission_resolved', permissionId: String(permissionId), optionId,
        label: selected.name || selected.label || optionId,
      } },
    });
    publish(sessionId);
    return { accepted: true };
  }

  async function respondQuestion({ sessionId, questionId, answers, outcome }) {
    const current = state(sessionId);
    const question = current.questions.get(String(questionId));
    if (!question) throw questionError('Question request is no longer active', 'GROK_ACP_QUESTION_EXPIRED');
    const response = normalizeQuestionResponse(question, { answers, outcome });
    send({ jsonrpc: '2.0', id: question.rpcId, result: response });
    current.questions.delete(String(questionId));
    current.events.push({
      timestamp: Date.now(),
      params: { update: {
        sessionUpdate: 'question_resolved', questionId: String(questionId),
        outcome: response.outcome, ...(response.answers ? { answers: response.answers } : {}),
      } },
    });
    publish(sessionId);
    return { accepted: true };
  }

  async function respondPlanReview({ sessionId, reviewId, outcome, feedback }) {
    const current = state(sessionId);
    const review = current.planReviews.get(String(reviewId));
    if (!review) throw planError('Plan review is no longer active', 'GROK_ACP_PLAN_EXPIRED');
    if (!['approved', 'cancelled', 'abandoned'].includes(outcome)) {
      throw planError('Plan outcome must be approved, cancelled, or abandoned');
    }
    const normalizedFeedback = typeof feedback === 'string' ? feedback.trim() : '';
    if (normalizedFeedback.length > maxPlanFeedback) {
      throw planError('Plan feedback must be under 32 KiB');
    }
    if (outcome === 'abandoned' && normalizedFeedback) {
      throw planError('Abandoning a plan cannot include feedback');
    }
    current.planReviews.delete(String(reviewId));
    let delivery;
    if (normalizedFeedback) {
      // Grok drains this interjection only after the blocked plan-exit request
      // is released. Write it first, but do not await the reply or the two RPCs
      // would deadlock each other.
      delivery = request('_x.ai/interject', { sessionId, text: normalizedFeedback });
    }
    send({ jsonrpc: '2.0', id: review.rpcId, result: { outcome } });
    current.events.push({
      timestamp: Date.now(),
      params: { update: {
        sessionUpdate: 'plan_review_resolved', reviewId: String(reviewId), outcome,
        ...(normalizedFeedback ? { feedback: normalizedFeedback } : {}),
      } },
    });
    publish(sessionId);
    void delivery?.catch((error) => logger(error.message));
    return { accepted: true, outcome };
  }

  async function close() {
    closing = true;
    if (child) {
      const owned = child;
      child = undefined;
      initialized = undefined;
      lines?.close();
      lines = undefined;
      owned.stdin?.end();
      owned.kill('SIGTERM');
    }
    for (const waiting of pending.values()) {
      waiting.reject(rpcError('Grok ACP client closed', 'GROK_ACP_DISCONNECTED'));
    }
    pending.clear();
    for (const current of sessions.values()) {
      current.permissions.clear();
      current.executedToolCallIds.clear();
      current.queuedSubagentToolCallIds.clear();
      current.pendingSubagentToolCalls.clear();
      current.questions.clear();
      current.planReviews.clear();
      current.externallyResolvedPlanReviews.clear();
    }
    if (terminateLeaderOnClose) await terminateLeader(leaderSocket, logger);
  }

  return {
    loadSession, prompt, cancel, setModel, setMode,
    synchronizeTurn,
    removeQueuedPrompt, steerQueuedPrompt, reorderQueuedPrompts,
    read, watch, respondPermission, respondQuestion, respondPlanReview, close,
  };
}
