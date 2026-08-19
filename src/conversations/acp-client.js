import { spawn as spawnProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

const maxLineBytes = 8 * 1024 * 1024;
const maxQuestionCount = 20;
const maxQuestionOptions = 30;
const maxQuestionText = 4_000;
const maxAnswerText = 4_000;
const modelIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,79}$/;
const conversationModes = new Set(['default', 'plan']);
const permissionModes = new Set(['default', 'auto', 'bypassPermissions']);
const unifiedModes = new Set(['normal', 'plan', 'auto', 'alwaysApprove']);

function unifiedMode(current) {
  if (current.currentMode === 'plan') return 'plan';
  if (current.permissionMode === 'auto') return 'auto';
  if (current.permissionMode === 'bypassPermissions') return 'alwaysApprove';
  return 'normal';
}

function rpcError(message, code = 'GROK_ACP_ERROR') {
  const error = new Error(message);
  error.code = code;
  return error;
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
  defaultPermissionMode = 'default',
} = {}) {
  let child;
  let lines;
  let initialized;
  let nextId = 1;
  let generation = 0;
  let closing = false;
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
        turnActive: false,
        cancelRequested: false,
        currentMode: 'default',
        permissionMode: permissionModes.has(defaultPermissionMode) ? defaultPermissionMode : 'default',
        commands: [],
        permissions: new Map(),
        executedToolCallIds: new Set(),
        queuedSubagentToolCallIds: new Set(),
        pendingSubagentToolCalls: new Map(),
        questions: new Map(),
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

  function acceptNotification(message) {
    if (!['session/update', '_x.ai/session/update'].includes(message.method)) return;
    const record = eventRecord(message.params);
    if (!record) return;
    const current = state(message.params.sessionId);
    if (record.id && current.eventIds.has(record.id)) return;
    if (record.id) current.eventIds.add(record.id);
    current.events.push(record);
    const update = record.params.update;
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
      current.cancelRequested = false;
    } else if (update.sessionUpdate === 'turn_completed') {
      current.turnActive = false;
      current.cancelRequested = false;
    } else if (update.sessionUpdate === 'current_mode_update') {
      const nextMode = update.currentModeId ?? update.currentMode;
      if (conversationModes.has(nextMode)) {
        current.currentMode = nextMode;
        current.permissionMode = 'default';
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
    publish(message.params.sessionId);
    if (update.sessionUpdate === 'turn_completed') void drainPrompts(message.params.sessionId);
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

  function disconnected(exitCode, exitSignal) {
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
      current.permissions.clear();
      current.executedToolCallIds.clear();
      current.queuedSubagentToolCallIds.clear();
      current.pendingSubagentToolCalls.clear();
      current.questions.clear();
      current.cancelRequested = false;
    }
    if (!closing && exited) logger(error.message);
  }

  async function connect() {
    if (initialized) return initialized;
    closing = false;
    generation += 1;
    child = spawn(command, ['agent', '--leader', 'stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
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
      if (current.events.at(-1)?.replay === true) {
        current.events.push({
          timestamp: Date.now(), replay: true,
          params: { update: { sessionUpdate: 'turn_completed', stop_reason: 'loaded' } },
        });
      }
      return read(sessionId);
    }).finally(() => {
      if (current.loading) current.loading = undefined;
    });
    return current.loading;
  }

  function read(sessionId) {
    const current = state(sessionId);
    return {
      sessionId,
      cwd: current.cwd,
      metadata: current.metadata,
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

  async function drainPrompts(sessionId) {
    const current = state(sessionId);
    if (current.activePrompt || current.turnActive || current.queuedPrompts.length === 0) return;
    const entry = current.queuedPrompts.shift();
    current.activePrompt = entry;
    current.turnActive = true;
    current.cancelRequested = false;
    publish(sessionId);
    try {
      const result = await request('session/prompt', {
        sessionId, prompt: [{ type: 'text', text: entry.text }],
      });
      current.events.push({
        timestamp: Date.now(),
        params: { update: {
          sessionUpdate: 'turn_completed', stop_reason: result?.stopReason || result?.stop_reason,
        } },
      });
    } catch (error) {
      logger(error.message);
      current.events.push({
        timestamp: Date.now(),
        params: { update: {
          sessionUpdate: 'prompt_failed', promptId: entry.id, text: entry.displayText,
          error: error.message,
        } },
      });
    } finally {
      current.activePrompt = undefined;
      current.turnActive = false;
      current.cancelRequested = false;
      publish(sessionId);
      void drainPrompts(sessionId);
    }
  }

  async function prompt({ sessionId, cwd, ...input }) {
    const entry = promptRecord(input);
    await loadSession({ sessionId, cwd });
    const current = state(sessionId);
    const queued = Boolean(current.activePrompt || current.turnActive || current.queuedPrompts.length);
    current.queuedPrompts.push(entry);
    publish(sessionId);
    void drainPrompts(sessionId);
    return { accepted: true, queued, queueId: entry.id };
  }

  async function setModel({ sessionId, cwd, modelId }) {
    if (typeof modelId !== 'string' || !modelIdPattern.test(modelId)) {
      throw rpcError('Model id is invalid', 'GROK_ACP_MODEL_INVALID');
    }
    await loadSession({ sessionId, cwd });
    const current = state(sessionId);
    const models = current.metadata?.models;
    const available = Array.isArray(models?.availableModels) ? models.availableModels : [];
    if (!available.some((model) => model?.modelId === modelId)) {
      throw rpcError('Model is not available for this session', 'GROK_ACP_MODEL_INVALID');
    }
    if (current.activePrompt || current.turnActive) {
      throw rpcError('Wait for the current turn before changing model', 'GROK_ACP_SESSION_BUSY');
    }
    await request('session/set_model', { sessionId, modelId });
    current.metadata = current.metadata || {};
    current.metadata.models = { ...(current.metadata.models || {}), currentModelId: modelId };
    const detail = current.metadata._meta?.['x.ai/sessionDetail'];
    if (detail && typeof detail === 'object') detail.currentModelId = modelId;
    publish(sessionId);
    return { accepted: true, modelId };
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
    return { accepted: true, active: true };
  }

  async function setMode({ sessionId, cwd, modeId }) {
    if (!unifiedModes.has(modeId)) throw rpcError('Conversation mode is invalid', 'GROK_ACP_MODE_INVALID');
    await loadSession({ sessionId, cwd });
    const current = state(sessionId);
    if (current.activePrompt || current.turnActive) {
      throw rpcError('Wait for the current turn before changing mode', 'GROK_ACP_SESSION_BUSY');
    }
    const conversationMode = modeId === 'plan' ? 'plan' : 'default';
    const permissionMode = modeId === 'auto' ? 'auto'
      : modeId === 'alwaysApprove' ? 'bypassPermissions' : 'default';
    if (current.currentMode !== conversationMode) {
      await request('session/set_mode', { sessionId, modeId: conversationMode });
    }
    notify('_x.ai/yolo_mode_changed', {
      sessionId,
      auto_mode: permissionMode === 'auto',
      ask: permissionMode === 'default',
    });
    current.currentMode = conversationMode;
    current.permissionMode = permissionMode;
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
    publish(sessionId);
    try {
      await request('_x.ai/interject', { sessionId, text: entry.text });
    } catch (error) {
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

  async function close() {
    closing = true;
    if (!child) return;
    const owned = child;
    child = undefined;
    initialized = undefined;
    lines?.close();
    lines = undefined;
    owned.stdin?.end();
    owned.kill('SIGTERM');
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
    }
  }

  return {
    loadSession, prompt, cancel, setModel, setMode,
    removeQueuedPrompt, steerQueuedPrompt, reorderQueuedPrompts,
    read, watch, respondPermission, respondQuestion, close,
  };
}
