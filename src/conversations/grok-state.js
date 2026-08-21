import { open, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const sessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isGrokSessionId(value) {
  return sessionIdPattern.test(value || '');
}

function sessionFile(cwd, sessionId, filename) {
  if (!isGrokSessionId(sessionId) || typeof cwd !== 'string' || !cwd) return undefined;
  const grokHome = process.env.GROK_HOME?.trim() || join(homedir(), '.grok');
  return join(grokHome, 'sessions', encodeURIComponent(cwd), sessionId, filename);
}

export async function loadGrokSignals({ cwd, sessionId }) {
  const file = sessionFile(cwd, sessionId, 'signals.json');
  if (!file) return undefined;
  try {
    const source = await readFile(file, 'utf8');
    if (source.length > 1024 * 1024) return undefined;
    const signals = JSON.parse(source);
    return signals && typeof signals === 'object' && !Array.isArray(signals) ? signals : undefined;
  } catch {
    return undefined;
  }
}

async function readFileTail(file, maximum = 128 * 1024) {
  let handle;
  try {
    handle = await open(file, 'r');
    const { size } = await handle.stat();
    const length = Math.min(size, maximum);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, Math.max(0, size - length));
    const source = buffer.toString('utf8');
    return size > length ? source.slice(source.indexOf('\n') + 1) : source;
  } catch {
    return '';
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function loadGrokLifecycle({ cwd, sessionId }) {
  const file = sessionFile(cwd, sessionId, 'updates.jsonl');
  if (!file) return undefined;
  const lines = (await readFileTail(file)).trimEnd().split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const record = JSON.parse(lines[index]);
      const kind = record?.params?.update?.sessionUpdate;
      if (!['turn_started', 'user_message_chunk', 'turn_completed'].includes(kind)) continue;
      const agentTimestamp = Number(record?.params?._meta?.agentTimestampMs);
      const persistedTimestamp = Number(record?.timestamp);
      const changedAt = Number.isFinite(agentTimestamp) && agentTimestamp > 0
        ? agentTimestamp
        : Number.isFinite(persistedTimestamp) && persistedTimestamp > 0
          ? persistedTimestamp * (persistedTimestamp < 10_000_000_000 ? 1_000 : 1)
          : 0;
      return { active: kind !== 'turn_completed', changedAt };
    } catch {
      // A writer may be appending the final line; continue from the preceding
      // complete lifecycle boundary.
    }
  }
  return undefined;
}

export function authoritativeTurn(snapshot, lifecycle) {
  const observedAt = Number(snapshot.turn?.changedAt) || 0;
  const persistedAt = Number(lifecycle?.changedAt) || 0;
  return lifecycle && persistedAt >= observedAt ? lifecycle.active : snapshot.turn?.active;
}

export function finiteTokenCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : undefined;
}

export function shortText(value, fallback, length = 160) {
  if (typeof value !== 'string') return fallback;
  const normalized = value.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return normalized.slice(0, length) || fallback;
}

function modelProvider(model) {
  const supplied = model?.provider ?? model?._meta?.provider ?? model?._meta?.providerId;
  if (supplied && typeof supplied === 'object') {
    const label = shortText(supplied.label || supplied.name || supplied.id, '', 80);
    const id = shortText(supplied.id || supplied.providerId || supplied.name, '', 80).toLowerCase();
    if (id && label) return { id, label };
  }
  if (typeof supplied === 'string') {
    const label = shortText(supplied, '', 80);
    if (label) return { id: label.toLowerCase(), label };
  }
  const modelId = shortText(model?.modelId, '', 80).toLowerCase();
  if (modelId.startsWith('grok')) return { id: 'xai', label: 'xAI' };
  if (modelId === 'qwen-local' || modelId.endsWith('-local')) return { id: 'local', label: 'Local' };
  return { id: 'other', label: 'Other' };
}

export function modelControls(metadata) {
  const models = metadata?.models;
  const detail = metadata?._meta?.['x.ai/sessionDetail'] || {};
  const options = (Array.isArray(models?.availableModels) ? models.availableModels : [])
    .map((model) => {
      const efforts = (Array.isArray(model?._meta?.reasoningEfforts) ? model._meta.reasoningEfforts : [])
        .map((effort) => ({
          id: shortText(effort?.id || effort?.value, '', 80),
          value: shortText(effort?.value || effort?.id, '', 80),
          label: shortText(effort?.label, shortText(effort?.id || effort?.value, 'Effort', 80), 120),
          description: shortText(effort?.description, '', 300),
          default: effort?.default === true,
        }))
        .filter((effort) => effort.id && effort.value);
      const selectedEffort = shortText(model?._meta?.reasoningEffort, '', 80);
      const currentEffort = efforts.find((effort) => effort.value === selectedEffort || effort.id === selectedEffort)
        ?? efforts.find((effort) => effort.default);
      return {
        id: shortText(model?.modelId, '', 80),
        label: shortText(model?.name, shortText(model?.modelId, 'Model', 80), 120),
        provider: modelProvider(model),
        description: shortText(model?.description, '', 300),
        contextWindowTokens: finiteTokenCount(model?._meta?.totalContextTokens ?? model?._meta?.contextLimit),
        ...(efforts.length ? { currentEffortId: currentEffort?.id, efforts } : {}),
      };
    })
    .filter((model) => model.id);
  const currentId = shortText(models?.currentModelId || detail.currentModelId, '', 80);
  return currentId && options.some((model) => model.id === currentId) ? { currentId, options } : undefined;
}

export function contextUsage(signals, controls) {
  const usedTokens = finiteTokenCount(signals?.contextTokensUsed) ?? 0;
  const currentWindow = controls?.options.find((model) => model.id === controls.currentId)?.contextWindowTokens;
  const windowTokens = currentWindow ?? finiteTokenCount(signals?.contextWindowTokens);
  if (!windowTokens) return undefined;
  const reported = finiteTokenCount(signals?.contextWindowUsage);
  const usagePercent = Math.max(0, Math.min(100,
    reported ?? Math.round((usedTokens / windowTokens) * 100)));
  return { usedTokens, windowTokens, usagePercent };
}
