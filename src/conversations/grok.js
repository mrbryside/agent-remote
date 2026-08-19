import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

const sessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function loadGrokSignals({ cwd, sessionId }) {
  if (!sessionIdPattern.test(sessionId || '') || typeof cwd !== 'string' || !cwd) return undefined;
  const grokHome = process.env.GROK_HOME?.trim() || join(homedir(), '.grok');
  const file = join(grokHome, 'sessions', encodeURIComponent(cwd), sessionId, 'signals.json');
  try {
    const source = await readFile(file, 'utf8');
    if (source.length > 1024 * 1024) return undefined;
    const signals = JSON.parse(source);
    return signals && typeof signals === 'object' && !Array.isArray(signals) ? signals : undefined;
  } catch {
    return undefined;
  }
}

function finiteTokenCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : undefined;
}

function textContent(content) {
  if (typeof content === 'string') return content;
  if (!content || typeof content !== 'object') return '';
  if (content.type === 'text' && typeof content.text === 'string') return content.text;
  return '';
}

function shortText(value, fallback, length = 160) {
  if (typeof value !== 'string') return fallback;
  const normalized = value.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return normalized.slice(0, length) || fallback;
}

function modelControls(metadata) {
  const models = metadata?.models;
  const detail = metadata?._meta?.['x.ai/sessionDetail'] || {};
  const options = (Array.isArray(models?.availableModels) ? models.availableModels : [])
    .map((model) => ({
      id: shortText(model?.modelId, '', 80),
      label: shortText(model?.name, shortText(model?.modelId, 'Model', 80), 120),
      description: shortText(model?.description, '', 300),
      contextWindowTokens: finiteTokenCount(model?._meta?.totalContextTokens ?? model?._meta?.contextLimit),
    }))
    .filter((model) => model.id);
  const currentId = shortText(models?.currentModelId || detail.currentModelId, '', 80);
  if (!currentId || !options.some((model) => model.id === currentId)) return undefined;
  return { currentId, options };
}

function contextUsage(signals, controls) {
  const usedTokens = finiteTokenCount(signals?.contextTokensUsed);
  const currentWindow = controls?.options.find((model) => model.id === controls.currentId)?.contextWindowTokens;
  const windowTokens = currentWindow ?? finiteTokenCount(signals?.contextWindowTokens);
  if (usedTokens === undefined || !windowTokens) return undefined;
  const reported = finiteTokenCount(signals?.contextWindowUsage);
  const usagePercent = Math.max(0, Math.min(100,
    reported ?? Math.round((usedTokens / windowTokens) * 100)));
  return { usedTokens, windowTokens, usagePercent };
}

function boundedText(value, length = 32_768) {
  if (typeof value !== 'string') return '';
  return value.length > length ? `${value.slice(0, length)}\n… output truncated` : value;
}

function serialized(value, length = 32_768) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return boundedText(value, length);
  try { return boundedText(JSON.stringify(value, null, 2), length); }
  catch { return boundedText(String(value), length); }
}

function normalizedStatus(value, fallback = 'working') {
  const status = shortText(value, fallback, 40).toLowerCase();
  if (status === 'in_progress' || status === 'running' || status === 'active') return 'working';
  if (status === 'complete' || status === 'succeeded' || status === 'success' || status === 'achieved') return 'completed';
  if (status === 'error' || status === 'blocked' || status === 'cancelled') {
    return status === 'cancelled' ? status : 'failed';
  }
  return status;
}

function toolExecutionStarted(update) {
  if (!['tool_call', 'tool_call_update'].includes(update?.sessionUpdate) ||
      typeof update.toolCallId !== 'string' || !update.toolCallId) return false;
  const status = String(update.status ?? '').trim().toLowerCase().replaceAll('-', '_').replaceAll(' ', '_');
  return ['in_progress', 'running', 'active', 'completed', 'complete', 'succeeded', 'failed', 'error', 'cancelled']
    .includes(status) || update.rawOutput !== undefined;
}

function toolPayload(update) {
  const texts = [];
  const diffs = [];
  const images = [];
  for (const block of Array.isArray(update.content) ? update.content : []) {
    if (block?.type === 'content' && block.content?.type === 'text') {
      texts.push(boundedText(block.content.text));
    } else if (block?.type === 'content' && block.content?.type === 'image' &&
        typeof block.content.data === 'string' && block.content.data.length <= 4 * 1024 * 1024 &&
        /^image\/(?:png|jpeg|webp|gif)$/.test(block.content.mimeType || '')) {
      images.push({ mimeType: block.content.mimeType, data: block.content.data });
    } else if (block?.type === 'diff') {
      diffs.push({
        path: shortText(block.path, 'Changed file', 1024),
        oldText: boundedText(block.oldText),
        newText: boundedText(block.newText),
      });
    }
  }
  const raw = update.rawOutput;
  const preferredRaw = raw && typeof raw === 'object'
    ? raw.output_for_prompt ?? raw.output ?? raw.stdout ?? raw.text ?? raw.content
    : raw;
  return {
    output: texts.filter(Boolean).join('\n') || serialized(preferredRaw || raw),
    diffs,
    images,
  };
}

function toolSubject(update) {
  const input = update.rawInput ?? update._meta?.['x.ai/tool']?.input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return '';
  const path = input.target_file ?? input.file_path ?? input.path ?? input.target_directory;
  if (typeof path === 'string' && path) return basename(path);
  const value = input.description ?? input.query ?? input.pattern ?? input.url ?? input.command;
  return shortText(value, '', 180);
}

const toolSummaryLabels = new Map([
  ['list', ['Listed', 'dir', 'dirs']],
  ['read', ['Read', 'file', 'files']],
  ['edit', ['Edited', 'file', 'files']],
  ['write', ['Wrote', 'file', 'files']],
  ['search', ['Searched', 'time', 'times']],
  ['execute', ['Ran', 'command', 'commands']],
  ['web_fetch', ['Fetched', 'page', 'pages']],
  ['web_search', ['Searched', 'web query', 'web queries']],
  ['task', ['Started', 'subagent', 'subagents']],
  ['plan', ['Updated', 'plan', 'plans']],
  ['ask_user', ['Asked', 'question', 'questions']],
  ['background_task_action', ['Managed', 'background task', 'background tasks']],
]);

function summarizeTools(tools) {
  const groups = new Map();
  for (const tool of tools) {
    const key = tool.kind || tool.name || tool.title || 'tool';
    const group = groups.get(key) || { count: 0, tool };
    group.count += 1;
    groups.set(key, group);
  }
  return [...groups.values()].map(({ count, tool }) => {
    const labels = toolSummaryLabels.get(tool.kind);
    if (labels) return `${labels[0]} ${count} ${count === 1 ? labels[1] : labels[2]}`;
    return count === 1 ? tool.title : `${tool.title} × ${count}`;
  }).join(', ');
}

function groupToolBatches(items) {
  const grouped = [];
  for (let index = 0; index < items.length;) {
    const item = items[index];
    if (item.type !== 'tool') {
      grouped.push(item);
      index += 1;
      continue;
    }
    const batch = [item];
    let cursor = index + 1;
    // Grok keeps one collapsed activity group from the first tool call until
    // the next visible conversation item. A later tool may start after an
    // earlier result (and therefore have a different timestamp) while still
    // belonging to that same group.
    while (items[cursor]?.type === 'tool') {
      batch.push(items[cursor]);
      cursor += 1;
    }
    if (batch.length === 1) grouped.push(item);
    else {
      const failed = batch.some((tool) => tool.status === 'failed' || tool.status === 'error');
      const working = batch.some((tool) => tool.status === 'working' || tool.status === 'running');
      grouped.push({
        id: `tool-group-${batch.map((tool) => tool.toolCallId).join('-')}`,
        type: 'tool_group', title: summarizeTools(batch), tools: batch,
        status: failed ? 'failed' : working ? 'working' : 'completed',
        timestamp: item.timestamp,
      });
    }
    index = cursor;
  }
  return grouped;
}

function updateValue(record) {
  const update = record?.params?.update;
  return update && typeof update === 'object' ? update : undefined;
}

function subagentInput(update) {
  const input = update?.rawInput ?? update?.input ?? update?._meta?.['x.ai/tool']?.input;
  return input && typeof input === 'object' && !Array.isArray(input) ? input : {};
}

function toolMeta(update) {
  const meta = update?._meta?.['x.ai/tool'];
  return meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : {};
}

function isSubagentSpawn(update, { allowTaskKind = true } = {}) {
  const meta = toolMeta(update);
  const input = subagentInput(update);
  const name = shortText(meta.name || update?.name, '', 100);
  if (name === 'spawn_subagent' || update?.title === 'spawn_subagent') return true;
  // The permission request can arrive before the corresponding tool_call
  // notification. Its embedded ACP tool call has the Task input variant but
  // not always the x.ai/tool metadata, so retain the lifecycle card from the
  // first event the phone receives.
  if (input.variant === 'Task' && (input.description || input.subagent_type || input.prompt)) return true;
  return allowTaskKind && meta.kind === 'task' && (input.subagent_type || input.description || input.prompt);
}

function questionEntries(update) {
  const input = update.rawInput ?? update._meta?.['x.ai/tool']?.input;
  const values = input && typeof input === 'object' && !Array.isArray(input) ? input.questions : undefined;
  return (Array.isArray(values) ? values : []).flatMap((entry) => {
    if (!entry || typeof entry.question !== 'string') return [];
    return [{
      question: boundedText(entry.question, 4_000),
      options: (Array.isArray(entry.options) ? entry.options : []).flatMap((option) =>
        typeof option?.label === 'string' && typeof option.description === 'string' ? [{
          label: shortText(option.label, '', 500), description: boundedText(option.description, 4_000),
          ...(typeof option.preview === 'string' ? { preview: boundedText(option.preview, 4_000) } : {}),
        }] : []),
      multiSelect: entry.multiSelect === true ? true : entry.multiSelect === false ? false : null,
    }];
  });
}

function questionAnswerSummary(update) {
  const explicit = update.rawOutput?.UserAnswered?.message ??
    update.rawOutput?.userAnswered?.message ?? update.rawOutput?.message;
  return boundedText(explicit || toolPayload(update).output, 8_000);
}

function subagentTaskId(update) {
  const input = subagentInput(update);
  const inputId = Array.isArray(input.task_ids) && input.task_ids.length === 1 ? input.task_ids[0] : undefined;
  const result = update.rawOutput?.Result ?? update.rawOutput?.result;
  const outputId = result?.task_id ?? result?.subagent_id ?? update.rawOutput?.task_id;
  const outputText = typeof update.rawOutput === 'string' ? update.rawOutput : update.rawOutput?.text;
  const textId = typeof outputText === 'string'
    ? outputText.match(/(?:subagent_id|task_id):\s*([0-9a-f-]{36})/i)?.[1]
    : undefined;
  const id = outputId ?? inputId ?? textId;
  return sessionIdPattern.test(id || '') ? id : undefined;
}

function timeline(updates) {
  const items = [];
  const tools = new Map();
  const children = new Map();
  const subagentsByTool = new Map();
  const pendingSubagents = [];
  const goals = new Map();
  const tasks = new Map();
  const permissions = new Map();
  const executedToolCallIds = new Set();
  const questions = new Map();
  let plan;
  let recap;
  let status = 'idle';

  const appendMessage = (role, text, index, timestamp) => {
    if (!text) return;
    const previous = items.at(-1);
    if (role === 'assistant' && previous?.type === 'message' && previous.role === role) {
      previous.text += text;
      return;
    }
    items.push({ id: `${role}-${index}`, type: 'message', role, text, timestamp });
  };

  const appendEvent = (kind, title, index, record, fields = {}) => {
    const item = {
      id: `${kind}-${index}`, type: 'event', kind, title,
      status: fields.status || 'completed', timestamp: record.timestamp,
      ...fields,
    };
    items.push(item);
    return item;
  };

  const removeTool = (toolCallId) => {
    const tool = tools.get(toolCallId);
    if (!tool) return;
    tools.delete(toolCallId);
    const index = items.indexOf(tool);
    if (index >= 0) items.splice(index, 1);
  };

  const resolvePermissionFromGrok = (permission) => {
    if (!permission || permission.status !== 'pending') return;
    permission.status = 'completed';
    permission.selectedLabel = 'Approved in Grok';
    permission.resolvedBy = 'grok';
  };

  const bindSubagent = (item, threadId) => {
    if (!item || !sessionIdPattern.test(threadId || '')) return item;
    item.threadId = threadId;
    item.phase = item.status === 'completed' ? 'done' : 'running';
    children.set(threadId, item);
    return item;
  };

  const matchingPendingSubagent = (update) => {
    const available = pendingSubagents.filter((item) => !item.threadId);
    if (!available.length) return undefined;
    const title = shortText(update.description, '', 500);
    const role = shortText(update.role || update.subagent_type, '', 60);
    const model = shortText(update.model, '', 80);
    return [...available].reverse().find((item) =>
      (!title || item.title === title) && (!role || item.role === role) && (!model || item.model === model))
      ?? available.at(-1);
  };

  updates.forEach((record, index) => {
    const update = updateValue(record);
    if (!update) return;
    const kind = update.sessionUpdate;
    if (kind === 'available_commands_update' || kind === 'session_info_update') return;
    if (kind === 'user_message_chunk') {
      status = 'working';
      appendMessage('user', textContent(update.content), index, record.timestamp);
      return;
    }
    if (kind === 'agent_message_chunk') {
      status = 'working';
      appendMessage('assistant', textContent(update.content), index, record.timestamp);
      return;
    }
    if (kind === 'agent_thought_chunk') {
      status = 'working';
      const text = textContent(update.content);
      if (!text) return;
      const previous = items.at(-1);
      if (previous?.type === 'thought') previous.text += text;
      else items.push({
        id: `thought-${index}`, type: 'thought', title: 'Thought', text,
        status: 'working', timestamp: record.timestamp,
      });
      return;
    }
    if (kind === 'tool_call' || kind === 'tool_call_update') {
      const id = typeof update.toolCallId === 'string' ? update.toolCallId : `tool-${index}`;
      if (toolExecutionStarted(update)) {
        executedToolCallIds.add(id);
        for (const permission of permissions.values()) {
          if (permission.toolCallId === id) resolvePermissionFromGrok(permission);
        }
      }
      const meta = toolMeta(update);
      const input = subagentInput(update);
      const toolName = shortText(meta?.name, '', 100);
      const isQuestionTool = toolName === 'ask_user_question' || meta?.kind === 'ask_user_question' ||
        meta?.kind === 'ask_user' || update.kind === 'ask_user_question' || update.kind === 'ask_user' ||
        update.title === 'ask_user_question';
      if (isQuestionTool) {
        const entries = questionEntries(update);
        let question = questions.get(id);
        if (!question && entries.length) {
          question = {
            id: `question-${id}`, type: 'question', questionId: id, toolCallId: id,
            mode: 'default', questions: entries,
            status: typeof update.status === 'string' ? normalizedStatus(update.status) : 'calling',
            timestamp: record.timestamp,
          };
          questions.set(id, question);
          items.push(question);
        }
        if (question) {
          if (entries.length) question.questions = entries;
          if (typeof update.status === 'string') question.status = normalizedStatus(update.status, question.status);
          const summary = questionAnswerSummary(update);
          if (summary) question.answerSummary = summary;
          status = ['completed', 'failed', 'cancelled'].includes(question.status) ? status : 'working';
        }
        return;
      }
      let subagent = subagentsByTool.get(id);
      const isSpawn = isSubagentSpawn(update);
      const taskId = subagentTaskId(update);
      const isSubagentOutput = toolName === 'get_command_or_subagent_output' ||
        toolName === 'get_subagent_output' || (taskId && children.has(taskId));

      if (!subagent && isSpawn && taskId) {
        subagent = children.get(taskId);
        if (subagent) subagentsByTool.set(id, subagent);
      }
      if (!subagent && isSpawn) {
        // A completion/update can be replayed before its annotated tool_call.
        // Once that call is recognized as a spawn, remove the transient
        // generic tool so the lifecycle is represented by exactly one card.
        removeTool(id);
        subagent = {
          id: `subagent-call-${id}`, type: 'subagent', toolCallId: id,
          title: shortText(input.description || update.title, 'Subagent', 500),
          role: shortText(input.subagent_type || input.role, 'subagent', 60),
          model: shortText(input.model, '', 80),
          capabilityMode: shortText(input.capability_mode, '', 80),
          phase: 'calling', status: 'working', timestamp: record.timestamp,
        };
        subagentsByTool.set(id, subagent);
        pendingSubagents.push(subagent);
        items.push(subagent);
      } else if (!subagent && isSubagentOutput && taskId) {
        subagent = children.get(taskId) ?? [...pendingSubagents].reverse().find((item) => !item.threadId);
        if (subagent) {
          bindSubagent(subagent, taskId);
          subagentsByTool.set(id, subagent);
        }
      }

      if (subagent) {
        if (input.description) subagent.title = shortText(input.description, subagent.title, 500);
        if (input.subagent_type || input.role) {
          subagent.role = shortText(input.subagent_type || input.role, subagent.role, 60);
        }
        if (input.model) subagent.model = shortText(input.model, subagent.model, 80);
        if (taskId) bindSubagent(subagent, taskId);
        const result = update.rawOutput?.Result ?? update.rawOutput?.result;
        if (result?.output) subagent.output = boundedText(result.output);
        if (result?.status) {
          subagent.status = normalizedStatus(result.status, subagent.status);
          subagent.phase = subagent.status === 'completed' ? 'done'
            : subagent.status === 'failed' || subagent.status === 'cancelled' ? subagent.status : 'running';
        }
        if (typeof update.status === 'string') {
          subagent.status = normalizedStatus(update.status, subagent.status);
          subagent.phase = subagent.status === 'completed' ? 'done'
            : subagent.status === 'failed' || subagent.status === 'cancelled' ? subagent.status : subagent.phase;
        }
        if (subagent.phase === 'running' || ['completed', 'failed', 'cancelled'].includes(subagent.status)) {
          resolvePermissionFromGrok(permissions.get(String(subagent.permissionId)));
        }
        status = 'working';
        return;
      }

      // Grok also mirrors its server-side question request as a tool call.
      // The server request owns its pending state and has the richer options,
      // so never expose a second generic tool (or fold it into a tool group).
      if (questions.has(id)) return;

      let item = tools.get(id);
      if (!item) {
        item = {
          id: `tool-${id}`, type: 'tool', toolCallId: id,
          title: shortText(update._meta?.['x.ai/tool']?.label || update.title, 'Tool'),
          name: shortText(update._meta?.['x.ai/tool']?.name, '', 100),
          kind: shortText(update.kind || update._meta?.['x.ai/tool']?.kind, 'tool', 40),
          subject: toolSubject(update),
          status: 'running', timestamp: record.timestamp,
        };
        tools.set(id, item);
        items.push(item);
      }
      if (typeof update.title === 'string') item.title = shortText(update.title, item.title, 500);
      if (typeof update.kind === 'string' || typeof meta?.kind === 'string') {
        const nextKind = shortText(update.kind || meta?.kind, item.kind, 60);
        // Completion updates commonly report the generic `other` kind. Keep
        // the semantic kind from the original tool_call so grouping can say
        // “Listed 1 dir” instead of falling back to its display title.
        if (nextKind !== 'other' || item.kind === 'tool' || item.kind === 'other') item.kind = nextKind;
      }
      if (update.rawInput !== undefined || meta?.input !== undefined) {
        item.input = serialized(update.rawInput ?? meta.input);
        item.subject = toolSubject(update) || item.subject;
      }
      if (Array.isArray(update.locations)) {
        item.locations = update.locations.flatMap((location) =>
          typeof location?.path === 'string' ? [location.path] : []).slice(0, 100);
      }
      const payload = toolPayload(update);
      if (payload.output) item.output = payload.output;
      if (payload.diffs.length) item.diffs = payload.diffs;
      if (payload.images.length) item.images = payload.images;
      if (typeof update.status === 'string') item.status = normalizedStatus(update.status, item.status);
      status = 'working';
      return;
    }
    if (kind === 'subagent_spawned') {
      const id = update.child_session_id || update.subagent_id;
      if (!sessionIdPattern.test(id || '')) return;
      let item = children.get(id);
      if (!item) {
        item = matchingPendingSubagent(update);
        if (!item) {
          item = {
            id: `subagent-${id}`, type: 'subagent',
            title: shortText(update.description, 'Subagent'),
            role: shortText(update.role || update.subagent_type, 'subagent', 60),
            model: shortText(update.model, '', 80),
            capabilityMode: shortText(update.capability_mode, '', 80),
            timestamp: record.timestamp,
          };
          items.push(item);
        }
        bindSubagent(item, id);
      }
      item.title = shortText(update.description, item.title, 500);
      item.role = shortText(update.role || update.subagent_type, item.role, 60);
      item.model = shortText(update.model, item.model, 80);
      item.capabilityMode = shortText(update.capability_mode, item.capabilityMode, 80);
      item.status = 'working';
      item.phase = 'running';
      resolvePermissionFromGrok(permissions.get(String(item.permissionId)));
      status = 'working';
      return;
    }
    if (kind === 'subagent_finished') {
      const id = update.child_session_id || update.subagent_id;
      if (!sessionIdPattern.test(id || '')) return;
      let child = children.get(id);
      if (!child) {
        child = {
          id: `subagent-${id}`, type: 'subagent', threadId: id,
          title: 'Subagent', role: 'subagent', timestamp: record.timestamp,
        };
        children.set(id, child);
        items.push(child);
      }
      child.status = normalizedStatus(update.status, 'completed');
      child.phase = child.status === 'completed' ? 'done'
        : child.status === 'failed' || child.status === 'cancelled' ? child.status : 'running';
      child.error = boundedText(update.error, 4_000);
      child.output = boundedText(update.output);
      child.metrics = {
        toolCalls: Number(update.tool_calls) || 0,
        turns: Number(update.turns) || 0,
        durationMs: Number(update.duration_ms) || 0,
        tokensUsed: Number(update.tokens_used) || 0,
      };
      return;
    }
    if (kind === 'plan') {
      const entries = (Array.isArray(update.entries) ? update.entries : []).map((entry, entryIndex) => ({
        id: `${index}-${entryIndex}`,
        content: boundedText(entry?.content, 4_000),
        priority: shortText(entry?.priority, '', 40),
        status: normalizedStatus(entry?.status, 'pending'),
      }));
      if (!plan) {
        plan = { id: `plan-${index}`, type: 'plan', title: 'Plan', entries, timestamp: record.timestamp };
        items.push(plan);
      } else plan.entries = entries;
      plan.status = entries.some((entry) => entry.status === 'working') ? 'working'
        : entries.length && entries.every((entry) => entry.status === 'completed') ? 'completed' : 'pending';
      status = 'working';
      return;
    }
    if (kind === 'goal_updated') {
      const id = shortText(update.goal_id, 'goal', 100);
      let goal = goals.get(id);
      if (!goal) {
        goal = { id: `goal-${id}`, type: 'goal', title: 'Goal', timestamp: record.timestamp };
        goals.set(id, goal);
        items.push(goal);
      }
      Object.assign(goal, {
        objective: boundedText(update.objective, 16_000),
        status: normalizedStatus(update.status, 'working'),
        phase: shortText(update.phase, '', 80),
        progress: {
          completed: Number(update.completed_deliverables) || 0,
          total: Number(update.total_deliverables) || 0,
        },
        metrics: {
          tokensUsed: Number(update.tokens_used) || 0,
          elapsedMs: Number(update.elapsed_ms) || 0,
          workerRounds: Number(update.total_worker_rounds) || 0,
          verifyRounds: Number(update.total_verify_rounds) || 0,
        },
        lastEvent: shortText(update.last_event, '', 120),
      });
      status = goal.status === 'completed' ? status : 'working';
      return;
    }
    if (kind === 'task_backgrounded' || kind === 'task_completed') {
      const snapshot = update.task_snapshot || update;
      const id = shortText(snapshot.task_id || update.task_id || update.tool_call_id, `task-${index}`, 160);
      let task = tasks.get(id);
      if (!task) {
        task = { id: `task-${id}`, type: 'task', taskId: id, timestamp: record.timestamp };
        tasks.set(id, task);
        items.push(task);
      }
      const completed = kind === 'task_completed' || snapshot.completed === true;
      Object.assign(task, {
        title: shortText(snapshot.description || update.description, 'Background task', 500),
        command: boundedText(snapshot.command || update.command, 12_000),
        cwd: shortText(snapshot.cwd || update.cwd, '', 2_000),
        output: boundedText(snapshot.output, 32_768),
        outputFile: shortText(snapshot.output_file || update.output_file, '', 2_000),
        exitCode: Number.isInteger(snapshot.exit_code) ? snapshot.exit_code : undefined,
        status: completed ? (snapshot.exit_code === undefined || snapshot.exit_code === null ||
          snapshot.exit_code === 0 ? 'completed' : 'failed') : 'working',
      });
      status = completed ? status : 'working';
      return;
    }
    if (kind === 'hook_execution') {
      const runs = Array.isArray(update.runs) ? update.runs : [];
      const failed = runs.some((run) => run?.status?.status === 'failed');
      // Successful hooks are implementation detail. A failed hook affects the
      // task and remains visible with its error so the user can act on it.
      if (!failed) return;
      appendEvent('hook', `Hook · ${shortText(update.event_name, 'event', 120)}`, index, record, {
        status: 'failed',
        text: runs.map((run) => {
          const state = run?.status?.status || 'completed';
          const error = run?.status?.error ? ` — ${run.status.error}` : '';
          return `${run?.name || 'hook'}: ${state}${error}`;
        }).join('\n'),
      });
      return;
    }
    if (kind === 'current_mode_update') {
      // Build/plan/default transitions are internal agent state, not user
      // activity. Plans and lifecycle cards already expose meaningful work.
      return;
    }
    if (kind === 'retry_state') {
      appendEvent('retry', `Retry ${Number(update.attempt) || 0}/${Number(update.max_retries) || 0}`, index, record, {
        text: boundedText(update.reason, 8_000), status: 'working',
      });
      status = 'working';
      return;
    }
    if (kind === 'session_recap') {
      recap = {
        text: boundedText(update.summary, 32_768), auto: update.auto === true,
        timestamp: record.timestamp,
      };
      return;
    }
    if (kind === 'permission_request') {
      const id = shortText(update.permissionId, `permission-${index}`, 160);
      const permission = {
        id: `permission-${id}`, type: 'permission', permissionId: id,
        toolCallId: typeof update.toolCall?.toolCallId === 'string' ? update.toolCall.toolCallId : undefined,
        title: shortText(update.title, 'Permission required', 500),
        text: serialized(update.toolCall?.rawInput ?? update.toolCall?.input),
        options: (Array.isArray(update.options) ? update.options : []).flatMap((option) =>
          typeof option?.optionId === 'string' ? [{
            id: option.optionId,
            label: shortText(option.name || option.label, option.optionId, 120),
            kind: shortText(option.kind, '', 40),
          }] : []).sort((left, right) => {
            const order = (option) => option.id === 'allow-once' ? 0
              : option.id.startsWith('reject') ? 1
                : option.id.includes('session') ? 2 : 3;
            return order(left) - order(right);
          }),
        status: 'pending', timestamp: record.timestamp,
      };
      permissions.set(id, permission);
      items.push(permission);
      if (permission.toolCallId && executedToolCallIds.has(permission.toolCallId)) {
        resolvePermissionFromGrok(permission);
      }
      // ACP permission requests contain the tool call that is waiting for the
      // answer.  Bind a spawn immediately rather than waiting for a later
      // session/update notification: approving permission must not leave the
      // native timeline showing only generic permission/mode cards.
      const toolCall = update.toolCall;
      if (isSubagentSpawn(toolCall, { allowTaskKind: false })) {
        const toolCallId = typeof toolCall?.toolCallId === 'string' && toolCall.toolCallId
          ? toolCall.toolCallId : `permission-${id}`;
        let subagent = subagentsByTool.get(toolCallId);
        if (!subagent) {
          const input = subagentInput(toolCall);
          subagent = {
            id: `subagent-call-${toolCallId}`, type: 'subagent', toolCallId,
            title: shortText(input.description || toolCall?.title, 'Subagent', 500),
            role: shortText(input.subagent_type || input.role, 'subagent', 60),
            model: shortText(input.model, '', 80),
            capabilityMode: shortText(input.capability_mode, '', 80),
            phase: 'calling', status: 'working', timestamp: record.timestamp,
          };
          subagentsByTool.set(toolCallId, subagent);
          pendingSubagents.push(subagent);
          items.push(subagent);
        }
        subagent.permissionId = id;
        if (subagent.phase === 'running' || ['completed', 'failed', 'cancelled'].includes(subagent.status)) {
          resolvePermissionFromGrok(permission);
        }
      }
      status = 'working';
      return;
    }
    if (kind === 'permission_resolved') {
      const permission = permissions.get(String(update.permissionId));
      if (permission) {
        permission.status = 'completed';
        permission.selectedOptionId = update.optionId;
        permission.selectedLabel = shortText(update.label, update.optionId || 'Resolved', 120);
      }
      return;
    }
    if (kind === 'question_request') {
      const id = shortText(update.questionId || update.toolCallId, `question-${index}`, 160);
      removeTool(id);
      const entries = questionEntries({ rawInput: { questions: update.questions } });
      let question = questions.get(id);
      if (!question) {
        question = {
          id: `question-${id}`, type: 'question', questionId: id, toolCallId: id,
          mode: shortText(update.mode, 'default', 80), questions: entries,
          status: 'pending', timestamp: record.timestamp,
        };
        questions.set(id, question);
        items.push(question);
      } else {
        question.mode = shortText(update.mode, question.mode || 'default', 80);
        if (entries.length) question.questions = entries;
        question.status = 'pending';
      }
      status = 'working';
      return;
    }
    if (kind === 'question_resolved') {
      const question = questions.get(String(update.questionId || update.toolCallId));
      if (question) {
        question.status = 'completed';
        question.outcome = shortText(update.outcome, 'accepted', 80);
        if (update.answers && typeof update.answers === 'object' && !Array.isArray(update.answers)) {
          question.answers = Object.fromEntries(Object.entries(update.answers)
            .filter(([prompt, answer]) => typeof prompt === 'string' && typeof answer === 'string')
            .map(([prompt, answer]) => [boundedText(prompt, 4_000), boundedText(answer, 4_000)]));
        }
      }
      return;
    }
    if (kind === 'turn_completed') {
      status = 'idle';
      return;
    }
    // Unknown protocol notifications are intentionally ignored. New event
    // types must be mapped deliberately before they become user-facing.
  });
  return { items: groupToolBatches(items), children: [...children.values()].filter((child) => child.threadId), status, recap };
}

function grokCommand(command) {
  return /(^|[\s/])grok(?:[\s]|$)/i.test(command || '');
}

export function createGrokConversationProvider({
  acpClient,
  loadSignals = loadGrokSignals,
} = {}) {
  if (!acpClient) throw new Error('Grok ACP client is required');

  async function readThread(cwd, threadId, { includeControls = false } = {}) {
    const snapshot = await acpClient.loadSession({ sessionId: threadId, cwd });
    const parsed = timeline(snapshot.events);
    const detail = snapshot.metadata?._meta?.['x.ai/sessionDetail'] || {};
    const model = includeControls ? modelControls(snapshot.metadata) : undefined;
    const controls = includeControls ? {
      ...(model ? { model } : {}),
      ...(snapshot.controls?.mode ? { mode: snapshot.controls.mode } : {}),
      ...(snapshot.controls?.permission ? { permission: snapshot.controls.permission } : {}),
      ...(snapshot.controls?.commands ? { commands: snapshot.controls.commands } : {}),
    } : undefined;
    const context = includeControls
      ? contextUsage(await loadSignals({ cwd, sessionId: threadId }), model)
      : undefined;
    return {
      thread: {
        id: threadId,
        title: shortText(detail.title, detail.kind || 'Grok'),
        agentName: shortText(detail.kind, 'grok', 80),
        model: shortText(detail.currentModelId || snapshot.metadata?.models?.currentModelId, '', 80),
        status: parsed.status,
      },
      ...(controls && Object.keys(controls).length ? { controls } : {}),
      ...(includeControls ? { queue: snapshot.queue || [] } : {}),
      ...(context ? { context } : {}),
      ...parsed,
    };
  }

  async function readStatus(handle) {
    const snapshot = await acpClient.loadSession({ sessionId: handle.rootThreadId, cwd: handle.cwd });
    return timeline(snapshot.events).status;
  }

  async function graph(cwd, rootThreadId) {
    const threads = new Map();
    const parents = new Map();
    const queue = [rootThreadId];
    while (queue.length && threads.size < 100) {
      const id = queue.shift();
      if (threads.has(id)) continue;
      let thread;
      try { thread = await readThread(cwd, id, { includeControls: id === rootThreadId }); }
      catch (error) {
        if (id === rootThreadId) throw error;
        continue;
      }
      threads.set(id, thread);
      for (const child of thread.children) {
        if (!parents.has(child.threadId)) parents.set(child.threadId, id);
        queue.push(child.threadId);
      }
    }
    return { threads, parents };
  }

  async function readConversation(handle, { threadId = handle.rootThreadId } = {}) {
    const relationship = await graph(handle.cwd, handle.rootThreadId);
    const selected = relationship.threads.get(threadId);
    if (!selected) throw new Error('Thread is not part of this conversation');
    const parentId = relationship.parents.get(threadId);
    const children = selected.children.map((child) => {
      const details = relationship.threads.get(child.threadId)?.thread;
      return {
        id: child.threadId,
        title: details?.title || child.title,
        agentName: details?.agentName || child.role,
        status: child.status,
      };
    });
    // A child session's own title/model describe its internal conversation;
    // the parent card describes the lifecycle request that created it. Keep
    // the latter intact so concurrent cards do not change identity or copy
    // when descendant metadata loads (or races with the spawn event).
    const items = selected.items;
    return {
      thread: selected.thread,
      items,
      children,
      recap: selected.recap,
      ...(threadId === handle.rootThreadId && selected.controls ? { controls: selected.controls } : {}),
      ...(threadId === handle.rootThreadId ? { queue: selected.queue || [] } : {}),
      ...(threadId === handle.rootThreadId && selected.context ? { context: selected.context } : {}),
      parent: parentId ? relationship.threads.get(parentId)?.thread ?? null : null,
      rootThreadId: handle.rootThreadId,
      capabilities: { send: threadId === handle.rootThreadId, children: children.length > 0 },
    };
  }

  async function watchConversation(handle, options, listener) {
    let stopped = false;
    let timer;
    const subscriptions = new Map();

    const arm = (ids) => {
      for (const id of ids) {
        if (subscriptions.has(id)) continue;
        subscriptions.set(id, acpClient.watch(id, () => {
          clearTimeout(timer);
          timer = setTimeout(() => void publish(), 20);
        }));
      }
    };
    const publish = async () => {
      if (stopped) return;
      try {
        const relationship = await graph(handle.cwd, handle.rootThreadId);
        arm(relationship.threads.keys());
        listener(await readConversation(handle, options));
      } catch {
        clearTimeout(timer);
        timer = setTimeout(() => void publish(), 120);
      }
    };

    const relationship = await graph(handle.cwd, handle.rootThreadId);
    arm(relationship.threads.keys());
    listener(await readConversation(handle, options));
    return async () => {
      stopped = true;
      clearTimeout(timer);
      for (const unsubscribe of subscriptions.values()) unsubscribe();
      subscriptions.clear();
    };
  }

  return {
    id: 'grok',
    label: 'Grok',

    async detect(session) {
      if (!grokCommand(session.command) || !/(?:^|\s)--leader(?:\s|$)/i.test(session.command || '')) return undefined;
      if (!sessionIdPattern.test(session.conversationThreadId || '')) return undefined;
      return { cwd: session.cwd, rootThreadId: session.conversationThreadId };
    },

    read: readConversation,
    status: readStatus,
    watch: watchConversation,
    async sendInput(handle, text, options = {}) {
      return acpClient.prompt({
        sessionId: handle.rootThreadId,
        cwd: handle.cwd,
        text, ...options,
      });
    },
    async setModel(handle, modelId) {
      return acpClient.setModel({
        sessionId: handle.rootThreadId,
        cwd: handle.cwd,
        modelId,
      });
    },
    async setMode(handle, modeId) {
      return acpClient.setMode({ sessionId: handle.rootThreadId, cwd: handle.cwd, modeId });
    },
    async setPermissionMode(handle, permissionMode) {
      return acpClient.setPermissionMode({
        sessionId: handle.rootThreadId, cwd: handle.cwd, permissionMode,
      });
    },
    async removeQueuedInput(handle, queueId) {
      return acpClient.removeQueuedPrompt({ sessionId: handle.rootThreadId, queueId });
    },
    async steerQueuedInput(handle, queueId) {
      return acpClient.steerQueuedPrompt({ sessionId: handle.rootThreadId, queueId });
    },
    async respondPermission(handle, input) {
      return acpClient.respondPermission({
        sessionId: handle.rootThreadId,
        permissionId: input.permissionId,
        optionId: input.optionId,
      });
    },
    async respondQuestion(handle, input) {
      const threadId = input.threadId ?? handle.rootThreadId;
      const relationship = await graph(handle.cwd, handle.rootThreadId);
      if (!relationship.threads.has(threadId)) throw new Error('Thread is not part of this conversation');
      return acpClient.respondQuestion({
        sessionId: threadId,
        questionId: input.questionId,
        answers: input.answers,
        ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
      });
    },
    close: () => acpClient.close(),
  };
}
