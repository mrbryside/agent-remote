import { api, apiUrl } from './api-client.js';
import { createMobileConversationView } from './mobile-conversation.js';
import { bootstrapRemoteControl } from './remote-control.js';

const terminalElement = document.querySelector('#terminal');
const statusElement = document.querySelector('#status');
const statusText = document.querySelector('#status-text');
const terminalTitle = document.querySelector('#terminal-title');
const homeButton = document.querySelector('#home-button');
const projectList = document.querySelector('#project-list');
const dialog = document.querySelector('#create-dialog');
const projectForm = document.querySelector('#project-form');
const dialogTitle = document.querySelector('#dialog-title');
const projectAgentSelect = document.querySelector('#project-agent');
const projectNameInput = document.querySelector('#project-name');
const folderPathInput = document.querySelector('#folder-path');
const selectedFolder = document.querySelector('#selected-folder');
const folderRoots = document.querySelector('#folder-roots');
const folderList = document.querySelector('#folder-list');
const formError = document.querySelector('#form-error');
const saveProjectButton = document.querySelector('#save-project');
const emptyState = document.querySelector('#empty-state');
const emptyProjectLabel = document.querySelector('#empty-project-label');
const emptyTitle = document.querySelector('#empty-title');
const emptyCopy = document.querySelector('#empty-copy');
const sessionLoading = document.querySelector('#session-loading');
const sessionLoadingKicker = document.querySelector('#session-loading-kicker');
const sessionLoadingTitle = document.querySelector('#session-loading-title');
const sessionLoadingCopy = document.querySelector('#session-loading-copy');
const graphicsSplit = document.querySelector('#graphics-split');
const graphicsTerminalElement = document.querySelector('#graphics-terminal');
const closeGraphicsSplitButton = document.querySelector('#close-graphics-split');
const graphicsResizer = document.querySelector('#graphics-resizer');
const sidebarResizer = document.querySelector('#sidebar-resizer');
const workspace = document.querySelector('.workspace');
const sidebar = document.querySelector('.sidebar');
const sidebarEdgeTrigger = document.querySelector('#sidebar-edge-trigger');
const toggleSidebarButton = document.querySelector('#toggle-sidebar');
const openSidebarButton = document.querySelector('#open-sidebar');
const token = new URLSearchParams(location.search).get('token');
const SIDEBAR_STORAGE_KEY = 'agent-remote-sidebar-collapsed';
const SIDEBAR_WIDTH_STORAGE_KEY = 'agent-remote-sidebar-width';
const compactSidebarMedia = matchMedia('(max-width: 760px)');
const GRAPHICS_WIDTH_STORAGE_KEY = 'agent-remote-graphics-width';
const ACTIVE_PROJECT_STORAGE_KEY = 'agent-remote-project';
const ACTIVE_SESSION_STORAGE_KEY = 'agent-remote-session';
const EXPANDED_PROJECTS_STORAGE_KEY = 'agent-remote-expanded-projects';
const TERMINAL_SNAPSHOTS_STORAGE_KEY = 'agent-remote-terminal-snapshots-v1';
const browserCursorValues = new Set([
  'default', 'none', 'context-menu', 'help', 'pointer', 'progress', 'wait', 'cell', 'crosshair', 'text',
  'vertical-text', 'alias', 'copy', 'move', 'no-drop', 'not-allowed', 'grab', 'grabbing', 'all-scroll',
  'col-resize', 'row-resize', 'n-resize', 'e-resize', 's-resize', 'w-resize', 'ne-resize', 'nw-resize',
  'se-resize', 'sw-resize', 'ew-resize', 'ns-resize', 'nesw-resize', 'nwse-resize', 'zoom-in', 'zoom-out',
]);

const rootStyles = getComputedStyle(document.documentElement);
function designToken(name, fallback) {
  return rootStyles.getPropertyValue(name).trim() || fallback;
}

const terminalOptions = {
  cursorBlink: true,
  cursorStyle: 'bar',
  fontFamily: designToken('--font-family-mono', '"SFMono-Regular", Menlo, Monaco, Consolas, monospace'),
  fontSize: Number.parseFloat(designToken('--font-size-terminal', '14')),
  lineHeight: Number.parseFloat(designToken('--line-height-terminal', '1.2')),
  scrollback: 10_000,
  theme: {
    background: designToken('--color-terminal-background', '#141416'),
    foreground: designToken('--color-terminal-foreground', '#d4d4d2'),
    cursor: designToken('--color-terminal-cursor', '#bbbdbb'),
    selectionBackground: designToken('--color-terminal-selection', '#50535088'),
    black: designToken('--color-terminal-black', '#202022'),
    red: designToken('--color-terminal-red', '#d78b86'),
    green: designToken('--color-terminal-green', '#9eb49d'),
    yellow: designToken('--color-terminal-yellow', '#c6ae7b'),
    blue: designToken('--color-terminal-blue', '#8da9be'),
    magenta: designToken('--color-terminal-magenta', '#b09dbb'),
    cyan: designToken('--color-terminal-cyan', '#8fb5b2'),
    white: designToken('--color-terminal-white', '#c8c8c5'),
    brightBlack: designToken('--color-terminal-bright-black', '#747672'),
    brightRed: designToken('--color-terminal-bright-red', '#e1a09b'),
    brightGreen: designToken('--color-terminal-bright-green', '#b3c6b1'),
    brightYellow: designToken('--color-terminal-bright-yellow', '#d2bf96'),
    brightBlue: designToken('--color-terminal-bright-blue', '#a5b9c8'),
    brightMagenta: designToken('--color-terminal-bright-magenta', '#c0afc8'),
    brightCyan: designToken('--color-terminal-bright-cyan', '#a5c6c3'),
    brightWhite: designToken('--color-terminal-bright-white', '#efefec'),
  },
};
terminalElement.dataset.graphics = 'kitty';
terminalElement.dataset.kittyUnicodePlacement = 'unsupported';

let projects = [];
let sessions = [];
let agents = [];
let activeProjectId = localStorage.getItem(ACTIVE_PROJECT_STORAGE_KEY) || null;
let activeSession = localStorage.getItem(ACTIVE_SESSION_STORAGE_KEY) || null;
let editingProjectId = null;
let currentFolder = '';
let firstPromptBuffer = '';
let firstPromptSession = null;
let refreshGeneration = 0;
let splitGeneration = 0;
const graphicsOpenGenerations = new Map();
let renderedSidebarSignature = '';
let expandedProjectIds = readStoredIdSet(EXPANDED_PROJECTS_STORAGE_KEY);
const showAllProjectIds = new Set();
const pendingSessionCreates = new Map();
const pendingSessionDeletes = new Map();
const pendingProjectDeletes = new Map();
const pendingProjectClears = new Map();
const graphicsPanes = new Map();
const serverRendererKeys = new Set();
const terminalRuntimes = new Map();
const localSessionActivity = new Map();
const activitySyncTimers = new Map();
const workingSessionNames = new Set();
let activeTerminalRuntime;
let terminalRuntimeGeneration = 0;
let workspaceHydrated = false;
let sidebarPeekCloseTimer;
const terminalSnapshots = readTerminalSnapshots();
const mobileConversation = createMobileConversationView({
  api,
  apiUrl,
  media: compactSidebarMedia,
  async send(sessionName, text, attachmentIds = [], fileMentions = []) {
    const id = crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    markSessionActive(sessionName, true);
    return api(`/api/conversations/${encodeURIComponent(sessionName)}/input`, {
      method: 'POST',
      body: JSON.stringify({ id, text, attachmentIds, fileMentions }),
    });
  },
  async searchFiles(sessionName, query) {
    const params = new URLSearchParams({ q: query });
    return api(`/api/conversations/${encodeURIComponent(sessionName)}/completions/files?${params}`);
  },
  async uploadAttachment(sessionName, file) {
    const response = await fetch(apiUrl(`/api/conversations/${encodeURIComponent(sessionName)}/attachments`), {
      method: 'POST',
      headers: {
        'content-type': file.type || 'application/octet-stream',
        'x-file-name': encodeURIComponent(file.name || 'attachment'),
      },
      body: file,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Upload failed (${response.status})`);
    return payload.attachment;
  },
  async setModel(sessionName, modelId) {
    return api(`/api/conversations/${encodeURIComponent(sessionName)}/model`, {
      method: 'POST', body: JSON.stringify({ modelId }),
    });
  },
  async setMode(sessionName, modeId) {
    return api(`/api/conversations/${encodeURIComponent(sessionName)}/mode`, {
      method: 'POST', body: JSON.stringify({ modeId }),
    });
  },
  async removeQueuedInput(sessionName, queueId) {
    return api(`/api/conversations/${encodeURIComponent(sessionName)}/queue/${encodeURIComponent(queueId)}`, {
      method: 'DELETE',
    });
  },
  async steerQueuedInput(sessionName, queueId) {
    return api(`/api/conversations/${encodeURIComponent(sessionName)}/queue/${encodeURIComponent(queueId)}/steer`, {
      method: 'POST', body: '{}',
    });
  },
  async respondPermission(sessionName, permissionId, optionId) {
    await api(`/api/conversations/${encodeURIComponent(sessionName)}/permission`, {
      method: 'POST', body: JSON.stringify({ permissionId, optionId }),
    });
  },
  async respondQuestion(sessionName, threadId, questionId, answers, outcome = 'accepted') {
    const body = { threadId, questionId, outcome };
    if (outcome !== 'skip_interview') body.answers = answers;
    await api(`/api/conversations/${encodeURIComponent(sessionName)}/question`, {
      method: 'POST', body: JSON.stringify(body),
    });
  },
  onVisibilityChange(visible) {
    workspace.dataset.mobileConversation = String(visible);
    setView();
    if (!visible && activeSession && !selectedSession()?.pending) connect();
  },
  onStatusChange(sessionName, status) {
    if (status === 'working' || status === 'idle') {
      setSessionWorking(sessionName, status === 'working', { authoritative: true });
    }
  },
});

function readStoredIdSet(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '[]');
    return new Set(Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []);
  } catch {
    return new Set();
  }
}

function readTerminalSnapshots() {
  try {
    const stored = JSON.parse(sessionStorage.getItem(TERMINAL_SNAPSHOTS_STORAGE_KEY) || '{}');
    return new Map(Object.entries(stored).filter(([, snapshot]) =>
      snapshot?.format === 2 && Array.isArray(snapshot.ansiLines) && Number.isFinite(snapshot.savedAt)));
  } catch {
    return new Map();
  }
}

function saveTerminalSnapshots() {
  try {
    const newest = [...terminalSnapshots.entries()]
      .sort((left, right) => right[1].savedAt - left[1].savedAt)
      .slice(0, 12);
    terminalSnapshots.clear();
    for (const [name, snapshot] of newest) terminalSnapshots.set(name, snapshot);
    sessionStorage.setItem(TERMINAL_SNAPSHOTS_STORAGE_KEY, JSON.stringify(Object.fromEntries(newest)));
  } catch {
    // Terminal caching is an acceleration only; storage limits must never
    // interrupt the live PTY.
  }
}

function removeTerminalSnapshot(sessionName) {
  if (!terminalSnapshots.delete(sessionName)) return;
  saveTerminalSnapshots();
}

function terminalSnapshotSequence(snapshot) {
  const rows = snapshot.ansiLines.slice(0, Math.max(1, snapshot.rows || snapshot.ansiLines.length));
  const screen = rows.map((line, index) => `\x1b[${index + 1};1H${line}`).join('');
  const cursorRow = Math.max(1, Math.min(rows.length || 1, snapshot.cursorRow || 1));
  const cursorColumn = Math.max(1, Math.min(snapshot.cols || 1, snapshot.cursorColumn || 1));
  return `\x1b[0m\x1b[2J\x1b[H${screen}\x1b[0m\x1b[${cursorRow};${cursorColumn}H`;
}

function terminalPaletteCode(color, background) {
  if (color < 8) return String((background ? 40 : 30) + color);
  if (color < 16) return String((background ? 100 : 90) + color - 8);
  return `${background ? 48 : 38};5;${color}`;
}

function terminalRgbCode(color, background) {
  return `${background ? 48 : 38};2;${(color >> 16) & 255};${(color >> 8) & 255};${color & 255}`;
}

function terminalCellStyle(cell) {
  const codes = [];
  if (cell.isBold()) codes.push('1');
  if (cell.isDim()) codes.push('2');
  if (cell.isItalic()) codes.push('3');
  if (cell.isUnderline()) codes.push('4');
  if (cell.isBlink()) codes.push('5');
  if (cell.isInverse()) codes.push('7');
  if (cell.isInvisible()) codes.push('8');
  if (cell.isStrikethrough()) codes.push('9');
  if (cell.isOverline()) codes.push('53');
  if (cell.isFgPalette()) codes.push(terminalPaletteCode(cell.getFgColor(), false));
  else if (cell.isFgRGB()) codes.push(terminalRgbCode(cell.getFgColor(), false));
  if (cell.isBgPalette()) codes.push(terminalPaletteCode(cell.getBgColor(), true));
  else if (cell.isBgRGB()) codes.push(terminalRgbCode(cell.getBgColor(), true));
  return codes.join(';');
}

function serializeTerminalLine(line, columns) {
  if (!line) return '';
  let lastVisibleCell = -1;
  for (let column = 0; column < columns; column += 1) {
    const cell = line.getCell(column);
    if (!cell || cell.getWidth() === 0) continue;
    if (cell.getChars() || !cell.isAttributeDefault()) lastVisibleCell = column;
  }
  if (lastVisibleCell < 0) return '';

  let output = '';
  let previousStyle;
  for (let column = 0; column <= lastVisibleCell; column += 1) {
    const cell = line.getCell(column);
    if (!cell || cell.getWidth() === 0) continue;
    const style = terminalCellStyle(cell);
    if (style !== previousStyle) {
      output += style ? `\x1b[0;${style}m` : '\x1b[0m';
      previousStyle = style;
    }
    output += cell.getChars() || ' '.repeat(Math.max(1, cell.getWidth()));
  }
  return `${output}\x1b[0m`;
}

function persistTerminalSnapshot(runtime) {
  if (runtime.disposed || !runtime.hasOutput) return;
  const buffer = runtime.terminal.buffer.active;
  const ansiLines = [];
  const rowCount = Math.max(1, runtime.terminal.rows);
  for (let row = 0; row < rowCount; row += 1) {
    const line = buffer.getLine(buffer.viewportY + row);
    ansiLines.push(serializeTerminalLine(line, runtime.terminal.cols));
  }
  const snapshot = {
    format: 2,
    ansiLines,
    cols: runtime.terminal.cols,
    rows: rowCount,
    cursorRow: buffer.baseY + buffer.cursorY - buffer.viewportY + 1,
    cursorColumn: buffer.cursorX + 1,
    savedAt: Date.now(),
  };
  // Keep an individual snapshot bounded even if a terminal is resized to an
  // extreme geometry.
  if (JSON.stringify(snapshot).length > 200_000) return;
  terminalSnapshots.set(runtime.name, snapshot);
  saveTerminalSnapshots();
}

function scheduleTerminalSnapshot(runtime) {
  clearTimeout(runtime.snapshotTimer);
  runtime.snapshotTimer = setTimeout(() => persistTerminalSnapshot(runtime), 220);
}

function saveExpandedProjects() {
  localStorage.setItem(EXPANDED_PROJECTS_STORAGE_KEY, JSON.stringify([...expandedProjectIds]));
}

function sessionActivityTime(session) {
  return Number(session?.lastActiveAt || session?.createdAt || 0);
}

function sessionsByActivity(items) {
  return [...items].sort((left, right) =>
    sessionActivityTime(right) - sessionActivityTime(left) ||
    String(left.name).localeCompare(String(right.name)));
}

function updateSessionRowState(sessionName) {
  const row = projectList.querySelector(`.session-row[data-session="${CSS.escape(sessionName)}"]`);
  if (!row) return;
  const working = workingSessionNames.has(sessionName);
  row.classList.toggle('working', working);
  row.toggleAttribute('aria-busy', working || row.dataset.state === 'pending');
}

function sessionUsesConversationLifecycle(sessionName) {
  return Boolean(sessions.find((session) => session.name === sessionName)?.conversationThreadId);
}

function setSessionWorking(sessionName, working, { authoritative = false } = {}) {
  if (!sessionName) return;
  if (!authoritative && sessionUsesConversationLifecycle(sessionName)) return;
  if (working) workingSessionNames.add(sessionName);
  else workingSessionNames.delete(sessionName);
  updateSessionRowState(sessionName);
}

function scheduleSessionWorkSettled(runtime) {
  if (!workingSessionNames.has(runtime.name)) return;
  clearTimeout(runtime.workIdleTimer);
  runtime.workIdleTimer = setTimeout(() => setSessionWorking(runtime.name, false), 2_000);
}

function markSessionActive(sessionName, submitted = false) {
  const session = sessions.find((item) => item.name === sessionName);
  if (!session || session.pending) return;
  const wasFirst = sessionsByActivity(
    sessions.filter((item) => item.projectId === session.projectId),
  )[0]?.name === sessionName;
  const lastActiveAt = Date.now();
  session.lastActiveAt = lastActiveAt;
  localSessionActivity.set(sessionName, lastActiveAt);
  if (!wasFirst) renderProjects();
  else renderedSidebarSignature = sidebarSignature(projects, sessions);
  if (submitted) setSessionWorking(sessionName, true, {
    authoritative: sessionUsesConversationLifecycle(sessionName),
  });
  if (!session.projectId) return;
  if (activitySyncTimers.has(sessionName)) return;
  activitySyncTimers.set(sessionName, setTimeout(() => activitySyncTimers.delete(sessionName), 450));
  api(`/api/sessions/${encodeURIComponent(sessionName)}/activity`, { method: 'POST', keepalive: true })
    .then((payload) => {
      const current = sessions.find((item) => item.name === sessionName);
      if (current) current.lastActiveAt = Math.max(sessionActivityTime(current), payload.lastActiveAt || 0);
    })
    .catch(() => {
      // Keep the optimistic order; the next input will retry persistence.
    });
}

function syncConversationLifecycleStatuses(sessionItems) {
  const liveNames = new Set(sessionItems.map((session) => session.name));
  for (const name of [...workingSessionNames]) {
    if (!liveNames.has(name)) workingSessionNames.delete(name);
  }
  for (const session of sessionItems) {
    if (session.conversationStatus === 'working' || session.conversationStatus === 'idle') {
      setSessionWorking(session.name, session.conversationStatus === 'working', { authoritative: true });
    }
  }
}

function setTerminalRuntimeStatus(runtime, state, text) {
  runtime.statusState = state;
  runtime.statusText = text;
  if (runtime === activeTerminalRuntime && runtime.name === activeSession) setStatus(state, text);
}

function terminalRuntimeSettleDelay(runtime) {
  const session = sessions.find((item) => item.name === runtime.name);
  const project = projects.find((item) => item.id === session?.projectId);
  // Interactive agents usually paint a full-screen UI in several bursts.
  // Keep their launch chatter covered until that stream has gone quiet.
  return agents.find((agent) => agent.id === project?.agentId)?.interactive ? 1_200 : 180;
}

const terminalRuntimeMaximumRevealDelay = 2_400;
const grokConversationReadinessRetryDelay = 300;
const grokConversationErrorRetryDelay = 2_000;
const grokConversationStartupFallbackDelay = 15_000;

function isGrokTerminalRuntime(runtime) {
  const session = sessions.find((item) => item.name === runtime.name);
  const project = projects.find((item) => item.id === session?.projectId);
  return agents.find((agent) => agent.id === project?.agentId)?.providerId === 'grok';
}

function shouldWaitForGrokConversation(runtime) {
  return isGrokTerminalRuntime(runtime) && !compactSidebarMedia.matches;
}

function revealTerminalRuntime(runtime) {
  if (runtime.revealed || runtime.disposed) return;
  runtime.revealed = true;
  clearTimeout(runtime.revealTimer);
  clearTimeout(runtime.conversationReadinessTimer);
  clearTimeout(runtime.conversationFallbackTimer);
  runtime.revealTimer = undefined;
  runtime.conversationReadinessTimer = undefined;
  runtime.conversationFallbackTimer = undefined;
  requestAnimationFrame(() => {
    if (runtime.disposed) return;
    // Keep xterm outside the paint tree through the covered output frame. The
    // loading surface remains through this frame for an atomic hand-off.
    delete runtime.host.dataset.launching;
    setSessionWorking(runtime.name, false);
    if (runtime === activeTerminalRuntime && runtime.name === activeSession) {
      requestAnimationFrame(() => {
        if (runtime === activeTerminalRuntime && runtime.name === activeSession && runtime.revealed) {
          hideSessionLoading(runtime.name);
        }
      });
    }
  });
}

function checkGrokConversationReadiness(runtime) {
  if (runtime.disposed || runtime.suspended || runtime.conversationReady || runtime.conversationReadinessPending ||
      !runtime.waitsForGrokConversation) return;
  clearTimeout(runtime.conversationReadinessTimer);
  runtime.conversationReadinessTimer = undefined;
  const checkGeneration = runtime.conversationReadinessGeneration;
  runtime.conversationReadinessPending = true;
  api(`/api/conversations/${encodeURIComponent(runtime.name)}`)
    .then(() => {
      runtime.conversationReadinessPending = false;
      if (runtime.disposed || runtime.suspended || checkGeneration !== runtime.conversationReadinessGeneration) return;
      runtime.conversationReady = true;
      revealTerminalRuntime(runtime);
    })
    .catch(() => {
      runtime.conversationReadinessPending = false;
      if (runtime.disposed || runtime.suspended || runtime.conversationReady ||
          checkGeneration !== runtime.conversationReadinessGeneration) return;
      runtime.conversationReadinessTimer = setTimeout(
        () => checkGrokConversationReadiness(runtime),
        runtime.conversationStartupFallback ? grokConversationErrorRetryDelay : grokConversationReadinessRetryDelay,
      );
    });
}

function waitForGrokConversationReadiness(runtime) {
  if (!shouldWaitForGrokConversation(runtime) || runtime.conversationReady || runtime.disposed || runtime.suspended) return false;
  runtime.waitsForGrokConversation = true;
  runtime.conversationReadinessStartedAt ??= Date.now();
  if (!runtime.conversationFallbackTimer) {
    runtime.conversationFallbackTimer = setTimeout(() => {
      if (runtime.disposed || runtime.suspended || runtime.revealed) return;
      setTerminalRuntimeStatus(runtime, 'error', 'Grok is still starting');
      runtime.conversationStartupFallback = true;
      runtime.conversationFallbackTimer = undefined;
      if (runtime === activeTerminalRuntime && runtime.name === activeSession) {
        showSessionLoading(selectedSession(), runtime.conversationReady
          ? 'Grok is still preparing its interface. Keeping the terminal private while it refreshes.'
          : 'Grok is still starting. Keeping the terminal private while it reconnects.');
      }
    }, grokConversationStartupFallbackDelay);
  }
  checkGrokConversationReadiness(runtime);
  return true;
}

function scheduleTerminalRuntimeReveal(runtime) {
  if (runtime.revealed || runtime.disposed) return;
  if (runtime.waitsForGrokConversation || shouldWaitForGrokConversation(runtime)) {
    if (!runtime.conversationReady) return waitForGrokConversationReadiness(runtime);
    revealTerminalRuntime(runtime);
    return;
  }
  if (waitForGrokConversationReadiness(runtime)) return;
  const now = Date.now();
  runtime.revealStartedAt ??= now;
  // Full-screen agents keep repainting cursors and spinners after their UI is
  // usable. A pure "wait until output is quiet" debounce can therefore hide
  // the terminal forever. Preserve the quiet window for clean startup, but
  // cap the total wait so continuous TUI output cannot starve the reveal.
  const maximumRevealAt = runtime.revealStartedAt + terminalRuntimeMaximumRevealDelay;
  const delay = Math.min(
    terminalRuntimeSettleDelay(runtime),
    Math.max(0, maximumRevealAt - now),
  );
  clearTimeout(runtime.revealTimer);
  runtime.revealTimer = setTimeout(() => revealTerminalRuntime(runtime), delay);
}

function clearTerminalRuntimeOutput(runtime) {
  if (runtime.outputAnimationFrame) cancelAnimationFrame(runtime.outputAnimationFrame);
  runtime.outputAnimationFrame = undefined;
  runtime.pendingOutput = '';
}

function prepareTerminalInput(runtime) {
  const input = runtime.host.querySelector('.xterm-helper-textarea');
  if (!input) return;
  input.setAttribute('inputmode', 'text');
  input.setAttribute('enterkeyhint', 'enter');
  input.setAttribute('autocapitalize', 'none');
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('autocorrect', 'off');
  input.spellcheck = false;
}

function focusActiveTerminalInput() {
  const runtime = activeTerminalRuntime;
  if (!runtime || runtime.disposed || terminalElement.hidden || activeSession !== runtime.name) return;
  runtime.terminal.focus();
  const input = runtime.host.querySelector('.xterm-helper-textarea');
  input?.focus({ preventScroll: true });
}

function moveMobileTerminalViewport(direction, amount) {
  const runtime = activeTerminalRuntime;
  if (!runtime || runtime.disposed || runtime.socket?.readyState !== WebSocket.OPEN) return;
  runtime.socket.send(JSON.stringify({
    type: 'viewport',
    direction,
    amount: Math.max(1, Math.min(100, amount || Math.floor(runtime.terminal.rows / 2))),
  }));
}

let terminalTouchGesture;

function beginTerminalTouch(event) {
  if ((event.pointerType !== 'touch' && !matchMedia('(pointer: coarse)').matches) || terminalTouchGesture) return;
  terminalTouchGesture = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    lastX: event.clientX,
    lastY: event.clientY,
    startedAt: performance.now(),
    moved: false,
  };
}

function updateTerminalTouch(event) {
  const gesture = terminalTouchGesture;
  if (!gesture || gesture.pointerId !== event.pointerId) return;
  gesture.lastX = event.clientX;
  gesture.lastY = event.clientY;
  if (Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) < 10) return;
  if (!gesture.moved) {
    gesture.moved = true;
    // A drag means navigation, not text entry. Releasing focus also lets the
    // visual viewport expand naturally if the software keyboard was open.
    activeTerminalRuntime?.host.querySelector('.xterm-helper-textarea')?.blur();
  }
}

function finishTerminalTouch(event, cancelled = false) {
  const gesture = terminalTouchGesture;
  if (!gesture || gesture.pointerId !== event.pointerId) return;
  terminalTouchGesture = undefined;
  const deltaX = gesture.lastX - gesture.startX;
  const deltaY = gesture.lastY - gesture.startY;
  if (!gesture.moved) {
    if (!cancelled && performance.now() - gesture.startedAt < 600) focusActiveTerminalInput();
    return;
  }
  const runtime = activeTerminalRuntime;
  if (!runtime) return;
  if (Math.abs(deltaY) >= Math.abs(deltaX)) {
    const rows = Math.max(1, Math.round(Math.abs(deltaY) / Math.max(12, runtime.terminal.options.fontSize)));
    moveMobileTerminalViewport(deltaY > 0 ? 'up' : 'down', rows);
  } else {
    const cols = Math.max(1, Math.round(Math.abs(deltaX) / Math.max(7, runtime.terminal.options.fontSize * 0.6)));
    moveMobileTerminalViewport(deltaX > 0 ? 'left' : 'right', cols);
  }
}

function queueTerminalRuntimeOutput(runtime, data, generation) {
  if (runtime.disposed || generation !== runtime.generation) return;
  runtime.pendingOutput += data;
  if (runtime.outputAnimationFrame) return;
  runtime.outputAnimationFrame = requestAnimationFrame(() => {
    runtime.outputAnimationFrame = undefined;
    if (runtime.disposed || generation !== runtime.generation) {
      runtime.pendingOutput = '';
      return;
    }
    const output = runtime.pendingOutput;
    runtime.pendingOutput = '';
    if (output) {
      // Keep one parser write per paint frame. Every session owns its xterm,
      // so inactive chats can continue updating without invalidating the
      // already-painted screen users return to later.
      runtime.terminal.write(output, () => {
        scheduleTerminalSnapshot(runtime);
      });
      runtime.hasOutput = true;
      runtime.host.dataset.rendered = 'true';
      if (!runtime.revealed && runtime === activeTerminalRuntime && runtime.name === activeSession) {
        showSessionLoading(
          selectedSession(),
          runtime.conversationStartupFallback && runtime.waitsForGrokConversation
            ? 'Grok is still preparing its interface. Keeping the terminal private while it refreshes.'
            : 'The command is starting. The terminal will appear when its output settles.',
        );
      }
      scheduleTerminalRuntimeReveal(runtime);
      scheduleSessionWorkSettled(runtime);
    }
    if (runtime.pendingOutput) queueTerminalRuntimeOutput(runtime, '', generation);
  });
}

function createTerminalRuntime(sessionName) {
  const host = document.createElement('div');
  host.className = 'terminal-instance';
  host.dataset.session = sessionName;
  host.dataset.launching = 'true';
  terminalElement.replaceChildren(host);

  const nextTerminal = new Terminal(terminalOptions);
  const nextFitAddon = new FitAddon.FitAddon();
  const nextImageAddon = new ImageAddon.ImageAddon({
    enableSizeReports: true,
    kittySupport: true,
    pixelLimit: 16_777_216,
    storageLimit: 256,
  });
  nextTerminal.loadAddon(nextFitAddon);
  nextTerminal.loadAddon(nextImageAddon);

  const runtime = {
    name: sessionName,
    generation: ++terminalRuntimeGeneration,
    host,
    terminal: nextTerminal,
    fitAddon: nextFitAddon,
    imageAddon: nextImageAddon,
    socket: undefined,
    reconnectTimer: undefined,
    revealTimer: undefined,
    revealStartedAt: undefined,
    conversationReadinessTimer: undefined,
    conversationFallbackTimer: undefined,
    conversationReadinessStartedAt: undefined,
    conversationReadinessGeneration: 0,
    conversationReadinessPending: false,
    conversationReady: false,
    conversationStartupFallback: false,
    waitsForGrokConversation: false,
    workIdleTimer: undefined,
    snapshotTimer: undefined,
    attempts: 0,
    pendingInput: '',
    pendingOutput: '',
    outputAnimationFrame: undefined,
    hasOutput: false,
    revealed: false,
    ready: false,
    images: 0,
    statusState: 'connecting',
    statusText: 'Connecting',
    suspended: false,
    disposed: false,
  };
  terminalRuntimes.set(sessionName, runtime);

  // xterm's image addon supports Kitty classic placement, but not Unicode
  // placeholder placement (U=1). Reject that probe so image clients fall
  // back instead of leaving private-use glyphs in the terminal buffer.
  nextTerminal.parser.registerApcHandler({ final: 'G' }, (data) => {
    const control = data.split(';', 1)[0];
    const fields = new Map(control.split(',').map((field) => {
      const separator = field.indexOf('=');
      return separator === -1 ? [field, ''] : [field.slice(0, separator), field.slice(separator + 1)];
    }));
    if (fields.get('a') !== 'q' || fields.get('U') !== '1') return false;
    const imageId = Number.parseInt(fields.get('i') || '0', 10) || 0;
    const placement = Number.parseInt(fields.get('p') || '0', 10) || 0;
    const placementPart = placement ? `,p=${placement}` : '';
    nextTerminal.input(`\x1b_Gi=${imageId}${placementPart};EINVAL:unicode placement unsupported\x1b\\`, false);
    terminalElement.dataset.kittyUnicodeProbe = 'rejected';
    return true;
  });
  nextTerminal.parser.registerOscHandler(777, (data) => {
    const prefix = 'agent-remote-split:';
    if (!data.startsWith(prefix)) return false;
    try {
      const encoded = data.slice(prefix.length).replaceAll('-', '+').replaceAll('_', '/');
      const padded = encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=');
      const request = JSON.parse(atob(padded));
      if (!Array.isArray(request.argv) || request.argv.length === 0 || request.argv.length > 100) return true;
      if (request.argv.some((argument) => typeof argument !== 'string' || argument.length > 4096)) return true;
      openGraphicsSplit(request.argv, 'osc', sessionName);
    } catch {
      // Consume malformed agent-remote control messages without printing them.
    }
    return true;
  });

  nextImageAddon.onImageAdded(() => {
    runtime.images += 1;
    if (runtime === activeTerminalRuntime) terminalElement.dataset.images = String(runtime.images);
  });
  nextTerminal.onKey(({ key }) => {
    if (runtime === activeTerminalRuntime && runtime.name === activeSession) {
      captureFirstPrompt(key);
      markSessionActive(runtime.name, key.includes('\r') || key.includes('\n'));
    }
  });
  nextTerminal.onData((data) => {
    if (runtime.socket?.readyState === WebSocket.OPEN) {
      runtime.socket.send(JSON.stringify({ type: 'input', data }));
    } else if (runtime.pendingInput.length < 16_384) {
      runtime.pendingInput += data;
    }
  });
  nextTerminal.open(host);
  prepareTerminalInput(runtime);
  const snapshot = terminalSnapshots.get(sessionName);
  if (snapshot) {
    delete host.dataset.launching;
    host.dataset.restoringSnapshot = 'true';
    nextTerminal.resize(Math.max(2, snapshot.cols || 80), Math.max(1, snapshot.rows || 24));
    nextTerminal.write(terminalSnapshotSequence(snapshot), () => {
      if (runtime.disposed) return;
      runtime.fitAddon.fit();
      runtime.terminal.refresh(0, Math.max(0, runtime.terminal.rows - 1));
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (runtime.disposed) return;
        delete runtime.host.dataset.restoringSnapshot;
        runtime.host.dataset.restoredCache = 'true';
      }));
    });
    runtime.hasOutput = true;
    runtime.revealed = true;
    runtime.restoredSnapshot = true;
    runtime.host.dataset.rendered = 'true';
  }
  return runtime;
}

function activateTerminalRuntime(runtime) {
  activeTerminalRuntime = runtime;
  terminalElement.replaceChildren(runtime.host);
  terminalElement.dataset.session = runtime.name;
  terminalElement.dataset.images = String(runtime.images);
  setStatus(runtime.statusState, runtime.statusText);
  if (runtime.revealed) hideSessionLoading(runtime.name);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (runtime !== activeTerminalRuntime || runtime.disposed) return;
    runtime.fitAddon.fit();
    if (runtime.socket?.readyState === WebSocket.OPEN) {
      runtime.socket.send(JSON.stringify({
        type: 'resize', cols: runtime.terminal.cols, rows: runtime.terminal.rows,
      }));
    }
    runtime.terminal.focus();
  }));
}

function detachTerminalRuntime() {
  activeTerminalRuntime = undefined;
  terminalElement.replaceChildren();
  delete terminalElement.dataset.session;
  delete terminalElement.dataset.images;
}

function suspendTerminalRuntime(sessionName) {
  const runtime = terminalRuntimes.get(sessionName);
  if (!runtime || runtime.suspended) return;
  runtime.suspended = true;
  runtime.generation += 1;
  runtime.conversationReadinessGeneration += 1;
  clearTimeout(runtime.reconnectTimer);
  clearTimeout(runtime.conversationReadinessTimer);
  clearTimeout(runtime.conversationFallbackTimer);
  runtime.conversationReadinessTimer = undefined;
  runtime.conversationFallbackTimer = undefined;
  runtime.conversationReadinessPending = false;
  const socket = runtime.socket;
  runtime.socket = undefined;
  runtime.ready = false;
  if (socket?.readyState === WebSocket.OPEN) socket.close(1000, 'Native mobile view');
  if (runtime === activeTerminalRuntime) detachTerminalRuntime();
}

function disposeTerminalRuntime(sessionName) {
  removeTerminalSnapshot(sessionName);
  const runtime = terminalRuntimes.get(sessionName);
  if (!runtime) return;
  terminalRuntimes.delete(sessionName);
  runtime.disposed = true;
  clearTimeout(runtime.reconnectTimer);
  clearTimeout(runtime.revealTimer);
  runtime.conversationReadinessGeneration += 1;
  clearTimeout(runtime.conversationReadinessTimer);
  clearTimeout(runtime.conversationFallbackTimer);
  runtime.conversationReadinessTimer = undefined;
  runtime.conversationFallbackTimer = undefined;
  runtime.conversationReadinessPending = false;
  clearTimeout(runtime.workIdleTimer);
  clearTimeout(runtime.snapshotTimer);
  setSessionWorking(sessionName, false);
  clearTerminalRuntimeOutput(runtime);
  if (runtime.socket && runtime.socket.readyState < WebSocket.CLOSING) {
    runtime.socket.close(1000, 'Closing chat');
  }
  if (runtime === activeTerminalRuntime) detachTerminalRuntime();
  runtime.terminal.dispose();
  runtime.host.remove();
}

function connectTerminalRuntime(runtime) {
  if (runtime.disposed || runtime.suspended || runtime.socket?.readyState === WebSocket.OPEN ||
      runtime.socket?.readyState === WebSocket.CONNECTING) return;
  const generation = ++runtime.generation;
  clearTimeout(runtime.reconnectTimer);
  clearTimeout(runtime.revealTimer);
  if (!runtime.revealed) runtime.revealStartedAt ??= Date.now();
  runtime.ready = false;
  if (!runtime.revealed) setSessionWorking(runtime.name, true);
  if (runtime === activeTerminalRuntime) {
    if (!runtime.revealed && !runtime.hasOutput) {
      showSessionLoading(selectedSession(), 'Attaching to the terminal. You can switch chats while this finishes.');
    }
    setTerminalRuntimeStatus(runtime, 'connecting', runtime.attempts ? 'Reconnecting' : 'Connecting');
  }

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const endpoint = new URL(`${protocol}//${location.host}/ws`);
  endpoint.searchParams.set('cols', String(runtime.terminal.cols));
  endpoint.searchParams.set('rows', String(runtime.terminal.rows));
  endpoint.searchParams.set('session', runtime.name);
  if (token) endpoint.searchParams.set('token', token);
  const nextSocket = new WebSocket(endpoint);
  runtime.socket = nextSocket;

  nextSocket.addEventListener('open', () => {
    if (runtime.disposed || runtime.suspended || generation !== runtime.generation) {
      if (nextSocket.readyState < WebSocket.CLOSING) nextSocket.close(1000, 'Terminal view suspended');
      return;
    }
    runtime.attempts = 0;
    if (runtime.revealed) setSessionWorking(runtime.name, false);
    setTerminalRuntimeStatus(runtime, 'connected', 'Ready');
    if (runtime.pendingInput) {
      nextSocket.send(JSON.stringify({ type: 'input', data: runtime.pendingInput }));
      runtime.pendingInput = '';
    }
    if (runtime === activeTerminalRuntime) fitTerminals();
  });
  nextSocket.addEventListener('message', (event) => {
    if (runtime.disposed || generation !== runtime.generation) return;
    let message;
    try { message = JSON.parse(event.data); }
    catch { return runtime.terminal.writeln('\r\n\x1b[31mServer sent an invalid message\x1b[0m'); }
    if (message.type === 'output') queueTerminalRuntimeOutput(runtime, message.data, generation);
    if (message.type === 'ready') {
      runtime.ready = true;
      setTerminalRuntimeStatus(runtime, 'connected', 'Ready');
      if (runtime === activeTerminalRuntime) {
        terminalTitle.textContent = selectedSession()?.label || message.label || '';
        fitTerminals();
        scheduleTerminalRuntimeReveal(runtime);
      }
    }
    if (message.type === 'control' && message.action === 'open-graphics' &&
        Array.isArray(message.argv) && message.argv.length > 0 && message.argv.length <= 100 &&
        message.argv.every((argument) => typeof argument === 'string' && argument.length <= 4096)) {
      openGraphicsSplit(message.argv, 'backend', runtime.name);
    }
    if (message.type === 'error') runtime.terminal.writeln(`\r\n\x1b[31m${message.message}\x1b[0m`);
    if (message.type === 'exit') setTerminalRuntimeStatus(runtime, 'disconnected', `Exited (${message.exitCode})`);
  });
  nextSocket.addEventListener('close', () => {
    if (runtime.disposed || generation !== runtime.generation) return;
    runtime.socket = undefined;
    runtime.ready = false;
    setSessionWorking(runtime.name, true);
    setTerminalRuntimeStatus(runtime, 'disconnected', 'Reconnecting');
    if (runtime === activeTerminalRuntime && !runtime.revealed && !runtime.hasOutput) {
      showSessionLoading(selectedSession(), 'The connection dropped. Reconnecting without closing your chat…');
    }
    runtime.attempts += 1;
    runtime.reconnectTimer = setTimeout(
      () => connectTerminalRuntime(runtime),
      Math.min(1_000 * 2 ** runtime.attempts, 10_000),
    );
  });
  nextSocket.addEventListener('error', () => nextSocket.close());
}

function fitTerminals() {
  const runtime = activeTerminalRuntime;
  if (runtime && activeSession === runtime.name && !terminalElement.hidden) {
    runtime.fitAddon.fit();
    if (runtime.socket?.readyState === WebSocket.OPEN) {
      runtime.socket.send(JSON.stringify({
        type: 'resize', cols: runtime.terminal.cols, rows: runtime.terminal.rows,
      }));
    }
  }
  const pane = activeGraphicsPane();
  if (!graphicsSplit.hidden && pane) {
    pane.fitAddon.fit();
    if (pane.socket?.readyState === WebSocket.OPEN) {
      // Once the direct browser surface is ready, its CSS-pixel viewport is
      // authoritative. Resizing the hidden PTY as well lets terminal-browser
      // race CDP and restore the old viewport after DevTools opens or closes.
      if (!pane.surfaceReady) {
        pane.socket.send(JSON.stringify({ type: 'resize', cols: pane.terminal.cols, rows: pane.terminal.rows }));
      }
      const viewportWidth = Math.max(160, Math.floor(pane.viewport.clientWidth));
      const viewportHeight = Math.max(120, Math.floor(pane.viewport.clientHeight));
      pane.requestedViewport = { width: viewportWidth, height: viewportHeight };
      pane.host.dataset.requestedViewport = `${viewportWidth}x${viewportHeight}`;
      const viewportRequest = `${viewportWidth}x${viewportHeight}@2`;
      if (pane.lastViewportRequest !== viewportRequest) {
        pane.lastViewportRequest = viewportRequest;
        // Motion is streamed continuously and the settled frame is replaced
        // by a sharp 2x capture. Input remains in CSS-pixel coordinates.
        pane.socket.send(JSON.stringify({
          type: 'viewport',
          width: viewportWidth,
          height: viewportHeight,
          scaleFactor: 2,
        }));
      }
    }
  }
}

function setSidebarCollapsed(collapsed, { persist = true } = {}) {
  clearTimeout(sidebarPeekCloseTimer);
  delete workspace.dataset.sidebarPeek;
  workspace.dataset.sidebar = collapsed ? 'collapsed' : 'expanded';
  toggleSidebarButton.setAttribute('aria-expanded', String(!collapsed));
  sidebarEdgeTrigger.hidden = !collapsed;
  openSidebarButton.hidden = !collapsed;
  openSidebarButton.setAttribute('aria-expanded', String(!collapsed));
  if (persist) localStorage.setItem(SIDEBAR_STORAGE_KEY, String(collapsed));
  requestAnimationFrame(() => requestAnimationFrame(fitTerminals));
}

function syncSidebarForViewport() {
  if (compactSidebarMedia.matches) {
    workspace.dataset.sidebarMode = 'compact';
    setSidebarCollapsed(true, { persist: false });
    return;
  }
  delete workspace.dataset.sidebarMode;
  setSidebarCollapsed(localStorage.getItem(SIDEBAR_STORAGE_KEY) === 'true', { persist: false });
}

function showSidebarPeek() {
  clearTimeout(sidebarPeekCloseTimer);
  if (workspace.dataset.sidebar !== 'collapsed' || !matchMedia('(hover: hover) and (pointer: fine)').matches) return;
  workspace.dataset.sidebarPeek = 'true';
}

function scheduleSidebarPeekClose() {
  clearTimeout(sidebarPeekCloseTimer);
  sidebarPeekCloseTimer = setTimeout(() => {
    delete workspace.dataset.sidebarPeek;
  }, 140);
}

function graphicsPaneKey(name = activeSession) {
  if (name === null || name === undefined) return '';
  return `session:${name}`;
}

function graphicsPaneSessionName(key) {
  return key.startsWith('session:') ? key.slice('session:'.length) : undefined;
}

function activeGraphicsPane() {
  const key = graphicsPaneKey();
  return key ? graphicsPanes.get(key) : undefined;
}

function updateGraphicsSplit() {
  const activePane = activeGraphicsPane();
  for (const pane of graphicsPanes.values()) {
    const visible = pane === activePane;
    pane.host.hidden = !visible;
    if (pane.socket?.readyState === WebSocket.OPEN) {
      pane.socket.send(JSON.stringify({ type: 'visibility', visible }));
    }
  }

  graphicsSplit.hidden = !activePane || !activePane.revealed;
  graphicsResizer.hidden = graphicsSplit.hidden;
  graphicsSplit.dataset.state = activePane?.state || 'disconnected';
  graphicsTerminalElement.dataset.images = String(activePane?.images || 0);
  graphicsTerminalElement.dataset.session = activeSession ?? '';
  if (activePane?.buffer) graphicsTerminalElement.dataset.buffer = activePane.buffer;
  else delete graphicsTerminalElement.dataset.buffer;
  if (activePane) graphicsSplit.dataset.controlTransport = activePane.transport;
  else delete graphicsSplit.dataset.controlTransport;

  requestAnimationFrame(() => requestAnimationFrame(fitTerminals));
}

function setGraphicsPaneState(pane, state) {
  pane.state = state;
  if (pane === activeGraphicsPane()) graphicsSplit.dataset.state = state;
}

function setGraphicsLoading(pane, state = 'loading') {
  if (!pane.loading) return;
  pane.loading.hidden = false;
  pane.loading.dataset.state = state;
  pane.loadingTitle.textContent = state === 'error' ? 'Could not open browser' : 'Opening terminal-browser';
  pane.loadingDetail.textContent = state === 'error'
    ? 'Close this pane and try again.'
    : 'Waiting for the first browser frame…';
  pane.terminalLayer.dataset.surface = 'hidden';
  pane.surface.dataset.ready = 'false';
  if (!pane.revealed) {
    pane.revealed = true;
    updateGraphicsSplit();
  }
}

function disposeGraphicsPane(key, { closeRemote = true } = {}) {
  const pane = graphicsPanes.get(key);
  if (!pane) return;
  graphicsPanes.delete(key);
  if (closeRemote) serverRendererKeys.delete(key);
  pane.disposed = true;
  pane.resizeObserver?.disconnect();
  if (pane.resizeAnimationFrame) cancelAnimationFrame(pane.resizeAnimationFrame);
  if (pane.pointerAnimationFrame) cancelAnimationFrame(pane.pointerAnimationFrame);
  stopBrowserRecording(pane, { download: false });
  if (pane.devtoolsFrame) pane.devtoolsFrame.src = 'about:blank';
  if (closeRemote && pane.socket?.readyState === WebSocket.OPEN) {
    pane.socket.send(JSON.stringify({ type: 'close' }));
  }
  if (pane.socket && pane.socket.readyState < WebSocket.CLOSING) {
    pane.socket.close(1000, 'Closing browser pane');
  }
  pane.terminal.dispose();
  pane.host.remove();
  updateGraphicsSplit();
}

function closeGraphicsSplit(name = activeSession) {
  disposeGraphicsPane(graphicsPaneKey(name));
}

function openGraphicsSplit(argv, transport = 'direct', sessionName = activeSession) {
  const key = graphicsPaneKey(sessionName);
  if (!key) return;
  const previous = graphicsPanes.get(key);
  const previousSocket = previous?.socket;
  const openGeneration = (graphicsOpenGenerations.get(key) || 0) + 1;
  graphicsOpenGenerations.set(key, openGeneration);
  const connect = () => {
    if (openGeneration !== graphicsOpenGenerations.get(key) || graphicsPanes.has(key)) return;
    serverRendererKeys.add(key);
    connectGraphicsPane(key, argv, transport);
  };
  if (!previous) {
    connect();
    return;
  }
  if (previousSocket && previousSocket.readyState < WebSocket.CLOSED) {
    previousSocket.addEventListener('close', connect, { once: true });
    setTimeout(connect, 1_000);
  }
  disposeGraphicsPane(key);
  if (!previousSocket || previousSocket.readyState === WebSocket.CLOSED) queueMicrotask(connect);
}

function browserPointerPosition(canvas, event, remoteViewport) {
  const bounds = canvas.getBoundingClientRect();
  const relativeX = event.clientX - bounds.left;
  const relativeY = event.clientY - bounds.top;
  const inside = relativeX >= 0 && relativeY >= 0 && relativeX <= bounds.width && relativeY <= bounds.height;
  const viewportWidth = remoteViewport?.width || bounds.width;
  const viewportHeight = remoteViewport?.height || bounds.height;
  return {
    x: Math.max(0, Math.min(viewportWidth, (relativeX / bounds.width) * viewportWidth)),
    y: Math.max(0, Math.min(viewportHeight, (relativeY / bounds.height) * viewportHeight)),
    inside,
  };
}

const browserFrameHeaderBytes = 29;

function parseBrowserFrame(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength <= browserFrameHeaderBytes) return undefined;
  const view = new DataView(buffer);
  if (String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3)) !== 'OTF1') {
    return undefined;
  }
  return {
    sequence: view.getUint32(4),
    viewportGeneration: view.getUint32(8),
    width: view.getUint32(12),
    height: view.getUint32(16),
    pixelWidth: view.getUint32(20),
    pixelHeight: view.getUint32(24),
    source: view.getUint8(28) === 1 ? 'sharp' : 'stream',
    data: buffer.slice(browserFrameHeaderBytes),
  };
}

function legacyBrowserFrameData(data) {
  const decoded = atob(data);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
  return bytes.buffer;
}

async function decodeBrowserFrame(data) {
  const blob = new Blob([data], { type: 'image/jpeg' });
  if (typeof createImageBitmap === 'function') return createImageBitmap(blob);
  const url = URL.createObjectURL(blob);
  try {
    return await new Promise((resolve, reject) => {
      const image = new Image();
      image.decoding = 'async';
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

function browserFrameSupersedes(candidate, displayed) {
  if (!candidate) return false;
  const candidateGeneration = Number(candidate.viewportGeneration) || 0;
  const displayedGeneration = Number(displayed.viewportGeneration) || 0;
  return candidateGeneration > displayedGeneration ||
    (candidateGeneration === displayedGeneration && (Number(candidate.sequence) || 0) > (Number(displayed.sequence) || 0));
}

function queueBrowserFrame(pane, incoming) {
  const message = typeof incoming.data === 'string'
    ? { ...incoming, data: legacyBrowserFrameData(incoming.data) }
    : incoming;
  const sequence = Number(message.sequence) || 0;
  const viewportGeneration = Number(message.viewportGeneration) || 0;
  if (viewportGeneration < pane.frameViewportGeneration ||
      (sequence && sequence <= pane.displayedFrameSequence)) return;
  if (pane.requestedViewport &&
      (Math.abs(Number(message.width) - pane.requestedViewport.width) > 2 ||
       Math.abs(Number(message.height) - pane.requestedViewport.height) > 2)) return;
  pane.pendingFrame = message;
  if (pane.decodingFrame) return;
  pane.decodingFrame = true;
  const decodeNext = async () => {
    while (pane.pendingFrame && !pane.disposed) {
      const next = pane.pendingFrame;
      pane.pendingFrame = undefined;
      let decoded;
      try {
        decoded = await decodeBrowserFrame(next.data);
      } catch {
        continue;
      }
      if (pane.disposed || browserFrameSupersedes(pane.pendingFrame, next)) {
        decoded.close?.();
        continue;
      }
      await new Promise((resolve) => requestAnimationFrame(resolve));
      if (pane.disposed || browserFrameSupersedes(pane.pendingFrame, next)) {
        decoded.close?.();
        continue;
      }
      const decodedWidth = decoded.width || decoded.naturalWidth;
      const decodedHeight = decoded.height || decoded.naturalHeight;
      const firstFrame = pane.surface.dataset.ready !== 'true';
      if (pane.frame.width !== decodedWidth || pane.frame.height !== decodedHeight) {
        pane.frame.width = decodedWidth;
        pane.frame.height = decodedHeight;
        pane.frameContext.imageSmoothingEnabled = true;
        pane.frameContext.imageSmoothingQuality = 'high';
      }
      pane.frameContext.drawImage(decoded, 0, 0, pane.frame.width, pane.frame.height);
      pane.frameViewport = {
        width: Number(next.width) || decodedWidth,
        height: Number(next.height) || decodedHeight,
      };
      pane.frameViewportGeneration = Number(next.viewportGeneration) || pane.frameViewportGeneration;
      pane.displayedFrameSequence = Number(next.sequence) || pane.displayedFrameSequence + 1;
      pane.host.dataset.frameSequence = String(pane.displayedFrameSequence);
      pane.host.dataset.frameViewport = `${pane.frameViewport.width}x${pane.frameViewport.height}`;
      pane.frameVersion += 1;
      pane.host.dataset.frameVersion = String(pane.frameVersion);
      pane.host.dataset.frameScale = String(decodedWidth / pane.frameViewport.width);
      pane.host.dataset.frameSource = next.source || 'unknown';
      drawBrowserRecordingFrame(pane, pane.frame);
      decoded.close?.();
      pane.surface.dataset.ready = 'true';
      pane.surfaceReady = true;
      pane.loading.hidden = true;
      pane.terminalLayer.dataset.surface = 'hidden';
      if (firstFrame) {
        pane.revealed = true;
        updateGraphicsSplit();
        requestAnimationFrame(() => requestAnimationFrame(fitTerminals));
      }
    }
    pane.decodingFrame = false;
  };
  void decodeNext();
}

function browserRecordingMimeType() {
  if (typeof MediaRecorder === 'undefined') return '';
  return ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
    .find((type) => MediaRecorder.isTypeSupported(type)) || '';
}

function updateBrowserRecordButton(pane) {
  if (!pane.recordButton) return;
  const recording = pane.recording;
  pane.recordButton.dataset.active = String(Boolean(recording));
  pane.recordButton.setAttribute('aria-pressed', String(Boolean(recording)));
  if (!recording) {
    pane.recordButton.textContent = '● Record';
    pane.recordButton.title = 'Record this browser pane';
    return;
  }
  const elapsed = Math.max(0, Math.floor((Date.now() - recording.startedAt) / 1000));
  pane.recordButton.textContent = `■ ${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`;
  pane.recordButton.title = 'Stop and download recording';
}

function drawBrowserRecordingFrame(pane, source) {
  const recording = pane.recording;
  if (!recording) return;
  const width = source.width || source.naturalWidth || pane.frame.width;
  const height = source.height || source.naturalHeight || pane.frame.height;
  if (!width || !height) return;
  if (!recording.canvas.width || !recording.canvas.height) {
    recording.canvas.width = width;
    recording.canvas.height = height;
  }
  recording.context.drawImage(source, 0, 0, recording.canvas.width, recording.canvas.height);
}

function startBrowserRecording(pane) {
  if (pane.recording) return;
  const mimeType = browserRecordingMimeType();
  if (!mimeType || typeof HTMLCanvasElement.prototype.captureStream !== 'function') {
    pane.recordButton.title = 'Recording is not supported by this browser';
    return;
  }
  const canvas = document.createElement('canvas');
  canvas.width = pane.frame.width || Math.max(1, pane.viewport.clientWidth);
  canvas.height = pane.frame.height || Math.max(1, pane.viewport.clientHeight);
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) return;
  if (pane.surfaceReady && pane.frame.width) context.drawImage(pane.frame, 0, 0, canvas.width, canvas.height);
  const stream = canvas.captureStream(20);
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 5_000_000 });
  const recording = {
    canvas,
    context,
    stream,
    recorder,
    chunks: [],
    startedAt: Date.now(),
    download: true,
    timer: undefined,
    frameTimer: undefined,
  };
  pane.recording = recording;
  recorder.addEventListener('dataavailable', (event) => {
    if (event.data.size > 0) recording.chunks.push(event.data);
  });
  recorder.addEventListener('stop', () => {
    clearInterval(recording.timer);
    clearInterval(recording.frameTimer);
    for (const track of stream.getTracks()) track.stop();
    if (pane.recording === recording) pane.recording = undefined;
    updateBrowserRecordButton(pane);
    if (!recording.download || recording.chunks.length === 0) return;
    const blob = new Blob(recording.chunks, { type: mimeType });
    const link = document.createElement('a');
    const safeTitle = (pane.surface.getAttribute('aria-label') || 'browser')
      .replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'browser';
    const stamp = new Date(recording.startedAt).toISOString().replaceAll(':', '-').replace(/\.\d{3}Z$/, 'Z');
    const objectUrl = URL.createObjectURL(blob);
    link.href = objectUrl;
    link.download = `${safeTitle}-${stamp}.webm`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
  });
  recorder.start(250);
  recording.timer = setInterval(() => updateBrowserRecordButton(pane), 500);
  recording.frameTimer = setInterval(() => {
    if (pane.surfaceReady && pane.frame.width) drawBrowserRecordingFrame(pane, pane.frame);
  }, 100);
  updateBrowserRecordButton(pane);
}

function stopBrowserRecording(pane, { download = true } = {}) {
  const recording = pane?.recording;
  if (!recording) return;
  recording.download = download;
  clearInterval(recording.timer);
  clearInterval(recording.frameTimer);
  if (recording.recorder.state !== 'inactive') recording.recorder.stop();
}

function browserDevtoolsUrl(surface) {
  if (!surface?.devtoolsPath || !surface.devtoolsAccess || !surface.targetId) return '';
  const inspectorUrl = new URL(surface.devtoolsPath, location.origin);
  const secure = location.protocol === 'https:';
  const socketUrl = new URL(`${secure ? 'wss:' : 'ws:'}//${location.host}/devtools-ws`);
  socketUrl.searchParams.set('access', surface.devtoolsAccess);
  socketUrl.searchParams.set('target', surface.targetId);
  if (token) socketUrl.searchParams.set('token', token);
  inspectorUrl.searchParams.set(secure ? 'wss' : 'ws', `${socketUrl.host}${socketUrl.pathname}${socketUrl.search}`);
  return inspectorUrl.href;
}

function setBrowserDevtoolsVisible(pane, visible) {
  if (visible && !pane.devtoolsUrl) {
    pane.inspectButton.title = 'Chrome DevTools is not ready yet';
    return;
  }
  pane.devtoolsOpen = visible;
  pane.inspectButton.dataset.active = String(visible);
  pane.inspectButton.setAttribute('aria-pressed', String(visible));
  pane.inspectButton.textContent = visible ? 'Close DevTools' : 'Inspect';
  pane.inspectButton.title = visible ? 'Close Chrome DevTools' : 'Open Chrome DevTools';
  pane.inspector.hidden = !visible;
  if (visible) {
    if (pane.devtoolsFrame.src !== pane.devtoolsUrl) pane.devtoolsFrame.src = pane.devtoolsUrl;
  } else if (pane.devtoolsFrame.src !== 'about:blank') {
    pane.devtoolsFrame.src = 'about:blank';
  }
  requestAnimationFrame(() => requestAnimationFrame(fitTerminals));
}

function renderBrowserTabs(pane, tabs) {
  pane.tabs.replaceChildren();
  for (const tab of Array.isArray(tabs) ? tabs : []) {
    if (!Number.isInteger(tab.id)) continue;
    const item = document.createElement('div');
    item.className = 'browser-tab';
    item.dataset.active = String(Boolean(tab.active));
    item.setAttribute('role', 'tab');
    item.setAttribute('aria-selected', String(Boolean(tab.active)));
    item.title = tab.title || tab.url || 'New tab';

    const select = document.createElement('button');
    select.type = 'button';
    select.className = 'browser-tab-select';
    select.textContent = tab.title || tab.url || 'New tab';
    select.setAttribute('aria-label', `Switch to ${select.textContent}`);
    select.addEventListener('click', () => {
      if (pane.socket?.readyState === WebSocket.OPEN && !tab.active) {
        pane.socket.send(JSON.stringify({ type: 'tab-switch', tab: tab.id }));
      }
    });

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'browser-tab-close';
    close.textContent = '×';
    close.setAttribute('aria-label', `Close ${select.textContent}`);
    close.addEventListener('click', () => {
      if (pane.socket?.readyState === WebSocket.OPEN) {
        pane.socket.send(JSON.stringify({ type: 'tab-close', tab: tab.id }));
      }
    });
    item.append(select, close);
    pane.tabs.append(item);
  }
}

function connectGraphicsPane(key, argv, transport = 'restore') {
  if (graphicsPanes.has(key)) return;
  const generation = ++splitGeneration;
  const sessionName = graphicsPaneSessionName(key);
  const launchCommand = Array.isArray(argv) ? argv[0]?.split('/').at(-1) : undefined;
  const host = document.createElement('div');
  host.className = 'graphics-terminal-instance';
  host.dataset.session = sessionName ?? '__shell__';
  host.dataset.outputMessages = '0';
  const terminalLayer = document.createElement('div');
  terminalLayer.className = 'graphics-terminal-transport';
  const loading = document.createElement('div');
  loading.className = 'graphics-loading';
  loading.hidden = true;
  loading.setAttribute('role', 'status');
  loading.setAttribute('aria-live', 'polite');
  const loadingSpinner = document.createElement('span');
  loadingSpinner.className = 'graphics-loading-spinner';
  loadingSpinner.setAttribute('aria-hidden', 'true');
  const loadingCopy = document.createElement('span');
  loadingCopy.className = 'graphics-loading-copy';
  const loadingTitle = document.createElement('strong');
  loadingTitle.textContent = 'Opening terminal-browser';
  const loadingDetail = document.createElement('small');
  loadingDetail.textContent = 'Waiting for the first browser frame…';
  loadingCopy.append(loadingTitle, loadingDetail);
  loading.append(loadingSpinner, loadingCopy);
  const surface = document.createElement('div');
  surface.className = 'browser-surface';
  // Keep the surface in layout while loading so the first CDP viewport is the
  // real pane size instead of the 160x120 safety minimum.
  surface.dataset.ready = 'false';
  surface.tabIndex = 0;
  const toolbar = document.createElement('div');
  toolbar.className = 'browser-toolbar';
  toolbar.setAttribute('aria-label', 'Browser toolbar');
  const navigation = document.createElement('div');
  navigation.className = 'browser-navigation';
  const actionButton = (label, action, title) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'browser-action';
    button.textContent = label;
    button.title = title;
    button.setAttribute('aria-label', title);
    button.addEventListener('click', () => {
      if (pane.socket?.readyState === WebSocket.OPEN) {
        pane.socket.send(JSON.stringify({ type: 'browser-action', action }));
      }
    });
    return button;
  };
  const tabs = document.createElement('div');
  tabs.className = 'browser-tabs';
  tabs.setAttribute('role', 'tablist');
  const newTab = document.createElement('button');
  newTab.type = 'button';
  newTab.className = 'browser-new-tab';
  newTab.textContent = '+';
  newTab.title = 'New tab';
  newTab.setAttribute('aria-label', 'New tab');
  const tools = document.createElement('div');
  tools.className = 'browser-tools';
  const inspectButton = document.createElement('button');
  inspectButton.type = 'button';
  inspectButton.className = 'browser-tool browser-inspect';
  inspectButton.textContent = 'Inspect';
  inspectButton.title = 'Open Chrome DevTools';
  inspectButton.setAttribute('aria-pressed', 'false');
  const recordButton = document.createElement('button');
  recordButton.type = 'button';
  recordButton.className = 'browser-tool browser-record';
  recordButton.textContent = '● Record';
  recordButton.title = 'Record this browser pane';
  recordButton.setAttribute('aria-pressed', 'false');
  tools.append(inspectButton, recordButton);
  const content = document.createElement('div');
  content.className = 'browser-content';
  const viewport = document.createElement('div');
  viewport.className = 'browser-viewport';
  const frame = document.createElement('canvas');
  frame.className = 'browser-frame';
  frame.width = 0;
  frame.height = 0;
  frame.setAttribute('aria-hidden', 'true');
  const frameContext = frame.getContext('2d', { alpha: false, desynchronized: true });
  viewport.append(frame);
  const inspector = document.createElement('aside');
  inspector.className = 'browser-inspector';
  inspector.hidden = true;
  const inspectorHeader = document.createElement('div');
  inspectorHeader.className = 'browser-inspector-header';
  const inspectorTitle = document.createElement('strong');
  inspectorTitle.textContent = 'Chrome DevTools';
  const inspectorClose = document.createElement('button');
  inspectorClose.type = 'button';
  inspectorClose.textContent = '×';
  inspectorClose.title = 'Close Chrome DevTools';
  inspectorClose.setAttribute('aria-label', 'Close Chrome DevTools');
  inspectorHeader.append(inspectorTitle, inspectorClose);
  const devtoolsFrame = document.createElement('iframe');
  devtoolsFrame.className = 'browser-devtools-frame';
  devtoolsFrame.title = 'Chrome DevTools';
  devtoolsFrame.src = 'about:blank';
  devtoolsFrame.setAttribute('allow', 'clipboard-read; clipboard-write');
  inspector.append(inspectorHeader, devtoolsFrame);
  content.append(viewport, inspector);
  toolbar.append(navigation, tabs, newTab, tools);
  surface.append(toolbar, content);
  host.append(terminalLayer, loading, surface);
  graphicsTerminalElement.append(host);

  const nextTerminal = new Terminal({ ...terminalOptions, scrollback: 2_000 });
  const nextFitAddon = new FitAddon.FitAddon();
  const nextImageAddon = new ImageAddon.ImageAddon({
    enableSizeReports: true,
    kittySupport: true,
    pixelLimit: 16_777_216,
    storageLimit: 256,
  });
  nextTerminal.loadAddon(nextFitAddon);
  nextTerminal.loadAddon(nextImageAddon);
  const revealImmediately = launchCommand === 'terminal-browser' || transport === 'restore';
  const pane = {
    key,
    generation,
    host,
    terminal: nextTerminal,
    fitAddon: nextFitAddon,
    socket: undefined,
    state: 'connecting',
    revealed: revealImmediately,
    suppressTerminalPreview: launchCommand === 'terminal-browser',
    transport,
    images: 0,
    buffer: '',
    disposed: false,
    terminalLayer,
    loading,
    loadingTitle,
    loadingDetail,
    surfaceReady: false,
    targetId: '',
    surface,
    toolbar,
    tabs,
    viewport,
    frame,
    frameContext,
    content,
    tools,
    inspectButton,
    recordButton,
    inspector,
    devtoolsFrame,
    devtoolsUrl: '',
    devtoolsOpen: false,
    recording: undefined,
    pendingFrame: undefined,
    decodingFrame: false,
    frameViewport: undefined,
    frameViewportGeneration: 0,
    displayedFrameSequence: 0,
    frameVersion: 0,
    cursor: 'default',
    lastViewportRequest: '',
    requestedViewport: undefined,
    pointerAnimationFrame: undefined,
    pendingPointerMove: undefined,
    resizeAnimationFrame: undefined,
    resizeObserver: undefined,
  };
  pane.resizeObserver = new ResizeObserver(() => {
    if (pane.disposed || pane !== activeGraphicsPane() || pane.resizeAnimationFrame) return;
    pane.resizeAnimationFrame = requestAnimationFrame(() => {
      pane.resizeAnimationFrame = undefined;
      if (!pane.disposed && pane === activeGraphicsPane()) fitTerminals();
    });
  });
  pane.resizeObserver.observe(viewport);
  graphicsPanes.set(key, pane);
  if (revealImmediately) setGraphicsLoading(pane);
  navigation.append(
    actionButton('‹', 'back', 'Back'),
    actionButton('›', 'forward', 'Forward'),
    actionButton('↻', 'reload', 'Reload'),
  );
  newTab.addEventListener('click', () => {
    if (nextSocket.readyState === WebSocket.OPEN) nextSocket.send(JSON.stringify({ type: 'tab-new' }));
  });
  inspectButton.addEventListener('click', () => {
    setBrowserDevtoolsVisible(pane, !pane.devtoolsOpen);
  });
  recordButton.addEventListener('click', () => {
    if (pane.recording) stopBrowserRecording(pane);
    else startBrowserRecording(pane);
  });
  inspectorClose.addEventListener('click', () => {
    setBrowserDevtoolsVisible(pane, false);
  });
  updateGraphicsSplit();

  nextImageAddon.onImageAdded(() => {
    pane.images += 1;
    const buffer = nextTerminal.buffer.active;
    pane.buffer = [buffer.type, buffer.baseY, buffer.viewportY, buffer.cursorY].join(':');
    if (pane === activeGraphicsPane()) {
      graphicsTerminalElement.dataset.images = String(pane.images);
      graphicsTerminalElement.dataset.buffer = pane.buffer;
    }
  });
  nextTerminal.open(terminalLayer);
  if (!graphicsSplit.hidden) nextFitAddon.fit();

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const endpoint = new URL(`${protocol}//${location.host}/ws`);
  endpoint.searchParams.set('mode', 'graphics');
  endpoint.searchParams.set('purpose', 'renderer');
  endpoint.searchParams.set('renderer', key);
  endpoint.searchParams.set('cols', String(nextTerminal.cols));
  endpoint.searchParams.set('rows', String(nextTerminal.rows));
  if (token) endpoint.searchParams.set('token', token);
  const nextSocket = new WebSocket(endpoint);
  nextSocket.binaryType = 'arraybuffer';
  pane.socket = nextSocket;

  const sendPointer = (event, type) => {
    if (nextSocket.readyState !== WebSocket.OPEN || !pane.surfaceReady || !frame.width) return;
    const position = browserPointerPosition(frame, event, pane.frameViewport);
    if (!position.inside) {
      if (pane.cursor !== 'default') {
        pane.cursor = 'default';
        frame.style.cursor = 'default';
      }
      if (type === 'mouseMoved') nextSocket.send(JSON.stringify({ type: 'pointer-leave' }));
      return;
    }
    const buttons = event.buttons || 0;
    const button = event.button === 0 ? 'left' : event.button === 1 ? 'middle' : event.button === 2 ? 'right' : 'none';
    nextSocket.send(JSON.stringify({
      type: 'pointer', event: type, x: position.x, y: position.y, button, buttons,
      clickCount: type === 'mousePressed' ? event.detail || 1 : 0,
      deltaX: type === 'mouseWheel' ? event.deltaX : 0,
      deltaY: type === 'mouseWheel' ? event.deltaY : 0,
    }));
  };
  frame.addEventListener('pointerdown', (event) => {
    surface.focus();
    frame.setPointerCapture?.(event.pointerId);
    // Flush the hover position before the press. DevTools element-picker uses
    // the latest mouseMoved target when handling the click.
    pane.pendingPointerMove = undefined;
    if (pane.pointerAnimationFrame) cancelAnimationFrame(pane.pointerAnimationFrame);
    pane.pointerAnimationFrame = undefined;
    sendPointer(event, 'mouseMoved');
    sendPointer(event, 'mousePressed');
  });
  frame.addEventListener('pointerup', (event) => sendPointer(event, 'mouseReleased'));
  frame.addEventListener('mousemove', (event) => {
    pane.pendingPointerMove = event;
    if (pane.pointerAnimationFrame) return;
    pane.pointerAnimationFrame = requestAnimationFrame(() => {
      pane.pointerAnimationFrame = undefined;
      const pending = pane.pendingPointerMove;
      pane.pendingPointerMove = undefined;
      if (pending && !pane.disposed) sendPointer(pending, 'mouseMoved');
    });
  });
  frame.addEventListener('pointerleave', () => {
    pane.pendingPointerMove = undefined;
    if (pane.pointerAnimationFrame) cancelAnimationFrame(pane.pointerAnimationFrame);
    pane.pointerAnimationFrame = undefined;
    pane.cursor = 'default';
    frame.style.cursor = 'default';
    if (nextSocket.readyState === WebSocket.OPEN) {
      nextSocket.send(JSON.stringify({ type: 'pointer-leave' }));
    }
  });
  frame.addEventListener('wheel', (event) => {
    event.preventDefault();
    sendPointer(event, 'mouseWheel');
  }, { passive: false });
  frame.addEventListener('contextmenu', (event) => event.preventDefault());
  surface.addEventListener('keydown', (event) => {
    if (event.target.closest('.browser-toolbar, .browser-inspector')) return;
    if (nextSocket.readyState !== WebSocket.OPEN) return;
    event.preventDefault();
    nextSocket.send(JSON.stringify({
      type: 'key', event: 'keyDown', key: event.key, code: event.code,
      text: event.key.length === 1 ? event.key : '',
    }));
  });
  surface.addEventListener('keyup', (event) => {
    if (event.target.closest('.browser-toolbar, .browser-inspector')) return;
    if (nextSocket.readyState !== WebSocket.OPEN) return;
    event.preventDefault();
    nextSocket.send(JSON.stringify({ type: 'key', event: 'keyUp', key: event.key, code: event.code }));
  });

  nextTerminal.onData((data) => {
    if (nextSocket.readyState === WebSocket.OPEN) nextSocket.send(JSON.stringify({ type: 'input', data }));
  });
  nextSocket.addEventListener('open', () => {
    if (pane === activeGraphicsPane()) requestAnimationFrame(fitTerminals);
  });
  nextSocket.addEventListener('message', (event) => {
    if (pane.disposed || graphicsPanes.get(key) !== pane) return;
    if (event.data instanceof ArrayBuffer) {
      const message = parseBrowserFrame(event.data);
      if (message) queueBrowserFrame(pane, message);
      return;
    }
    if (event.data instanceof Blob) {
      void event.data.arrayBuffer().then((buffer) => {
        if (pane.disposed || graphicsPanes.get(key) !== pane) return;
        const message = parseBrowserFrame(buffer);
        if (message) queueBrowserFrame(pane, message);
      });
      return;
    }
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === 'output') {
      host.dataset.outputMessages = String(Number(host.dataset.outputMessages) + 1);
      nextTerminal.write(message.data);
      if (!pane.suppressTerminalPreview) {
        pane.loading.hidden = true;
        delete pane.terminalLayer.dataset.surface;
        if (!pane.revealed) {
          pane.revealed = true;
          updateGraphicsSplit();
        }
      }
    }
    if (message.type === 'surface') {
      pane.suppressTerminalPreview = true;
      const targetChanged = Boolean(pane.targetId && message.targetId && pane.targetId !== message.targetId);
      if (!pane.surfaceReady || targetChanged) {
        pane.surfaceReady = false;
        setGraphicsLoading(pane);
      }
      pane.targetId = message.targetId || '';
      host.dataset.renderMode = 'direct';
      host.dataset.browserKey = message.browserKey || '';
      surface.setAttribute('aria-label', message.title || message.url || 'Browser content');
      renderBrowserTabs(pane, message.tabs);
      const nextDevtoolsUrl = browserDevtoolsUrl(message);
      if (nextDevtoolsUrl !== pane.devtoolsUrl) {
        pane.devtoolsUrl = nextDevtoolsUrl;
        if (pane.devtoolsOpen) pane.devtoolsFrame.src = nextDevtoolsUrl;
      }
      requestAnimationFrame(fitTerminals);
    }
    if (message.type === 'frame' && typeof message.data === 'string') queueBrowserFrame(pane, message);
    if (message.type === 'cursor' && browserCursorValues.has(message.value)) {
      pane.cursor = message.value;
      frame.style.cursor = pane.cursor;
    }
    if (message.type === 'ready') {
      setGraphicsPaneState(pane, 'sizing');
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (pane.disposed || graphicsPanes.get(key) !== pane || nextSocket.readyState !== WebSocket.OPEN) return;
        if (pane === activeGraphicsPane()) fitTerminals();
        setTimeout(() => {
          if (pane.disposed || graphicsPanes.get(key) !== pane || nextSocket.readyState !== WebSocket.OPEN) return;
          if (pane === activeGraphicsPane()) fitTerminals();
          else nextSocket.send(JSON.stringify({ type: 'resize', cols: nextTerminal.cols, rows: nextTerminal.rows }));
          if (Array.isArray(argv)) {
            host.dataset.launchSent = 'true';
            nextSocket.send(JSON.stringify({ type: 'launch', argv }));
          }
          setGraphicsPaneState(pane, 'connected');
          if (pane === activeGraphicsPane()) nextTerminal.focus();
        }, 120);
      }));
    }
    if (message.type === 'error') nextTerminal.writeln(`\r\n\x1b[31m${message.message}\x1b[0m`);
    if (message.type === 'exit') {
      setGraphicsPaneState(pane, 'disconnected');
      if (!pane.surfaceReady && pane.suppressTerminalPreview) setGraphicsLoading(pane, 'error');
    }
    if (message.type === 'closed') {
      serverRendererKeys.delete(key);
      disposeGraphicsPane(key, { closeRemote: false });
    }
  });
  nextSocket.addEventListener('close', () => {
    if (!pane.disposed && graphicsPanes.get(key) === pane) setGraphicsPaneState(pane, 'disconnected');
  });
  nextSocket.addEventListener('error', () => nextSocket.close());
  requestAnimationFrame(() => requestAnimationFrame(fitTerminals));
}

async function restoreGraphicsPanes(livePaneKeys, isCurrent = () => true) {
  const payload = await api('/api/renderers');
  if (!isCurrent()) return;
  serverRendererKeys.clear();
  for (const renderer of payload.renderers) {
    if (livePaneKeys.has(renderer.key)) serverRendererKeys.add(renderer.key);
  }
  const activeKey = graphicsPaneKey();
  if (serverRendererKeys.has(activeKey) && !graphicsPanes.has(activeKey)) connectGraphicsPane(activeKey);
}

function setStatus(state, text) {
  statusElement.dataset.state = state;
  statusText.textContent = text;
}

function resize() {
  fitTerminals();
}

function selectedProject() {
  return projects.find((project) => project.id === activeProjectId);
}

function selectedSession() {
  return sessions.find((session) => session.name === activeSession);
}

function showSessionLoading(session, copy = 'Opening the project folder and starting its command.') {
  const project = projects.find((item) => item.id === session?.projectId);
  sessionLoadingKicker.textContent = project?.name || 'Starting chat';
  sessionLoadingTitle.textContent = session?.pending ? 'Preparing your terminal…' : 'Connecting to your terminal…';
  sessionLoadingCopy.textContent = copy;
  sessionLoading.hidden = false;
}

function hideSessionLoading(sessionName = activeSession) {
  if (sessionName !== activeSession || selectedSession()?.pending) return;
  sessionLoading.hidden = true;
}

function showNotice(message) {
  let notice = document.querySelector('#workspace-notice');
  if (!notice) {
    notice = document.createElement('div');
    notice.id = 'workspace-notice';
    notice.className = 'workspace-notice';
    notice.setAttribute('role', 'status');
    document.body.append(notice);
  }
  notice.textContent = message;
  notice.dataset.visible = 'true';
  clearTimeout(showNotice.timer);
  showNotice.timer = setTimeout(() => { notice.dataset.visible = 'false'; }, 4_000);
}

function hasPendingMutations() {
  return pendingSessionCreates.size > 0 || pendingSessionDeletes.size > 0 ||
    pendingProjectDeletes.size > 0 || pendingProjectClears.size > 0;
}

function invalidateWorkspaceRefresh() {
  refreshGeneration += 1;
}

function renderLocalWorkspace() {
  renderProjects();
  syncSidebarSelection();
  setView();
}

function refreshWhenSettled() {
  if (!hasPendingMutations()) refreshWorkspace().catch((error) => showNotice(error.message));
}

function setView() {
  const session = selectedSession();
  const isPending = Boolean(session?.pending);
  const hasSession = Boolean(session && !isPending);
  if (isPending && session.nativeConversation) mobileConversation.showPending(session.name);
  else mobileConversation.select(hasSession ? session.name : null);
  const showMobileConversation = Boolean(session && mobileConversation.isVisibleFor(session.name));
  workspace.dataset.view = isPending ? 'loading' : hasSession ? 'terminal' : 'empty';
  terminalElement.hidden = !hasSession || showMobileConversation;
  // The empty state starts hidden in the server HTML so it can never paint as
  // a fallback frame before persisted workspace state has been hydrated.
  emptyState.hidden = hasSession || isPending;
  emptyState.setAttribute('aria-hidden', String(hasSession || isPending));
  statusElement.hidden = !hasSession;
  terminalTitle.textContent = session?.label || '';

  if (isPending) {
    if (showMobileConversation) sessionLoading.hidden = true;
    else showSessionLoading(session);
    return;
  }
  if (hasSession) {
    if (showMobileConversation) {
      suspendTerminalRuntime(session.name);
      sessionLoading.hidden = true;
      return;
    }
    const runtime = terminalRuntimes.get(session.name);
    if (!runtime?.revealed && !terminalSnapshots.has(session.name)) {
      showSessionLoading(
        session,
        runtime?.hasOutput
          ? 'The command is starting. The terminal will appear when its output settles.'
          : 'Attaching to the terminal. You can switch chats while this finishes.',
      );
    } else {
      sessionLoading.hidden = true;
    }
    return;
  }
  sessionLoading.hidden = true;
  emptyProjectLabel.textContent = 'Your workspace';
  emptyTitle.textContent = 'What should we build next?';
  emptyCopy.textContent = projects.length
    ? 'Choose a chat from the sidebar, or use + beside a project to start a new one.'
    : 'Create a project from the sidebar to choose its folder and startup command.';
}

function syncSidebarSelection() {
  for (const group of projectList.querySelectorAll('.project-group')) {
    group.classList.toggle('selected', group.dataset.project === activeProjectId);
    const expanded = expandedProjectIds.has(group.dataset.project);
    group.classList.toggle('expanded', expanded);
    group.querySelector('.project-select')?.setAttribute('aria-expanded', String(expanded));
  }
  for (const row of projectList.querySelectorAll('.session-row')) {
    row.classList.toggle('active', row.dataset.session === activeSession);
  }
}

function sessionRow(session) {
  const row = document.createElement('div');
  row.className = 'session-row';

  const button = document.createElement('button');
  button.className = 'session-button';
  button.type = 'button';
  button.addEventListener('click', () => selectSession(session.name));
  const dot = document.createElement('span');
  dot.className = 'chat-dot';
  const name = document.createElement('span');
  name.className = 'session-name';
  button.append(dot, name);

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'session-close';
  close.textContent = '×';
  close.addEventListener('click', () => deleteSession(session));
  const activity = document.createElement('span');
  activity.className = 'session-activity';
  activity.setAttribute('aria-hidden', 'true');
  row.append(button, activity, close);
  syncSessionRow(row, session);
  return row;
}

function syncSessionRow(row, session) {
  const working = workingSessionNames.has(session.name);
  row.dataset.session = session.name;
  row.dataset.state = session.pending ? 'pending' : 'ready';
  row.classList.toggle('active', activeSession === session.name);
  row.classList.toggle('pending', Boolean(session.pending));
  row.classList.toggle('working', working);
  row.toggleAttribute('aria-busy', Boolean(session.pending) || working);
  const button = row.querySelector('.session-button');
  const name = row.querySelector('.session-name');
  const close = row.querySelector('.session-close');
  if (button) button.title = session.label;
  if (name && name.textContent !== session.label) name.textContent = session.label;
  if (close) {
    close.title = `Close ${session.label}`;
    close.setAttribute('aria-label', `Close ${session.label}`);
  }
}

async function deleteSession(session) {
  const current = sessions.find((item) => item.name === session.name);
  if (!current) return;
  invalidateWorkspaceRefresh();

  if (current.pending) {
    const operation = pendingSessionCreates.get(current.name);
    if (operation) operation.canceled = true;
    sessions = sessions.filter((item) => item.name !== current.name);
    if (activeSession === current.name) selectSession(null);
    renderLocalWorkspace();
    return;
  }
  if (pendingSessionDeletes.has(current.name)) return;

  const originalIndex = sessions.findIndex((item) => item.name === current.name);
  pendingSessionDeletes.set(current.name, { session: current, originalIndex });
  sessions = sessions.filter((item) => item.name !== current.name);
  closeGraphicsSplit(current.name);
  disposeTerminalRuntime(current.name);
  if (activeSession === current.name) selectSession(null);
  renderLocalWorkspace();

  try {
    await api(`/api/sessions/${encodeURIComponent(current.name)}`, { method: 'DELETE' });
    pendingSessionDeletes.delete(current.name);
    refreshWhenSettled();
  } catch (error) {
    pendingSessionDeletes.delete(current.name);
    if (projects.some((project) => project.id === current.projectId) &&
        !sessions.some((item) => item.name === current.name)) {
      sessions.splice(Math.min(originalIndex, sessions.length), 0, current);
    }
    renderLocalWorkspace();
    showNotice(`Could not close “${current.label}”: ${error.message}`);
    refreshWhenSettled();
  }
}

async function clearProjectChats(project) {
  if (!project || pendingProjectClears.has(project.id) || pendingProjectDeletes.has(project.id)) return;
  if (!confirm(`Close every chat in “${project.name}”?`)) return;
  invalidateWorkspaceRefresh();

  const snapshot = sessions.filter((session) => session.projectId === project.id && !session.pending);
  pendingProjectClears.set(project.id, snapshot);
  for (const operation of pendingSessionCreates.values()) {
    if (operation.session.projectId === project.id) operation.canceled = true;
  }
  const removedNames = new Set(sessions.filter((session) => session.projectId === project.id).map((session) => session.name));
  sessions = sessions.filter((session) => session.projectId !== project.id);
  for (const session of snapshot) {
    closeGraphicsSplit(session.name);
    disposeTerminalRuntime(session.name);
  }
  if (activeSession && removedNames.has(activeSession)) selectSession(null);
  renderLocalWorkspace();
  dialog.close();

  try {
    await api(`/api/projects/${encodeURIComponent(project.id)}/sessions`, { method: 'DELETE' });
    pendingProjectClears.delete(project.id);
    refreshWhenSettled();
  } catch (error) {
    pendingProjectClears.delete(project.id);
    if (projects.some((item) => item.id === project.id)) {
      const liveNames = new Set(sessions.map((session) => session.name));
      sessions.push(...snapshot.filter((session) => !liveNames.has(session.name)));
    }
    renderLocalWorkspace();
    showNotice(`Could not close chats in “${project.name}”: ${error.message}`);
    refreshWhenSettled();
  }
}

async function deleteProject(project) {
  if (!project || pendingProjectDeletes.has(project.id)) return;
  if (!confirm(`Delete “${project.name}” and close all of its chats?`)) return;
  invalidateWorkspaceRefresh();

  const projectIndex = projects.findIndex((item) => item.id === project.id);
  const projectSessions = sessions.filter((session) => session.projectId === project.id && !session.pending);
  const removedNames = new Set(sessions.filter((session) => session.projectId === project.id).map((session) => session.name));
  pendingProjectDeletes.set(project.id, { project, projectIndex, sessions: projectSessions });
  for (const operation of pendingSessionCreates.values()) {
    if (operation.session.projectId === project.id) operation.canceled = true;
  }
  projects = projects.filter((item) => item.id !== project.id);
  sessions = sessions.filter((session) => session.projectId !== project.id);
  for (const session of projectSessions) {
    closeGraphicsSplit(session.name);
    disposeTerminalRuntime(session.name);
  }
  if (activeSession && removedNames.has(activeSession)) selectSession(null);
  if (activeProjectId === project.id) {
    activeProjectId = null;
    localStorage.removeItem(ACTIVE_PROJECT_STORAGE_KEY);
  }
  expandedProjectIds.delete(project.id);
  saveExpandedProjects();
  if (editingProjectId === project.id) dialog.close();
  renderLocalWorkspace();

  try {
    await api(`/api/projects/${encodeURIComponent(project.id)}`, { method: 'DELETE' });
    pendingProjectDeletes.delete(project.id);
    pendingProjectClears.delete(project.id);
    refreshWhenSettled();
  } catch (error) {
    const snapshot = pendingProjectDeletes.get(project.id);
    pendingProjectDeletes.delete(project.id);
    if (snapshot && !projects.some((item) => item.id === project.id)) {
      projects.splice(Math.min(snapshot.projectIndex, projects.length), 0, snapshot.project);
      const liveNames = new Set(sessions.map((session) => session.name));
      sessions.push(...snapshot.sessions.filter((session) => !liveNames.has(session.name)));
    }
    renderLocalWorkspace();
    showNotice(`Could not delete “${project.name}”: ${error.message}`);
    refreshWhenSettled();
  }
}

function chatActionIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M5 5.5h14A1.5 1.5 0 0 1 20.5 7v8a1.5 1.5 0 0 1-1.5 1.5h-9l-5 3v-3.2A1.5 1.5 0 0 1 3.5 15V7A1.5 1.5 0 0 1 5 5.5Z');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.8');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

function projectAction(content, title, action, className = '') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `project-action ${className}`.trim();
  if (typeof content === 'string') button.textContent = content;
  else button.append(content);
  button.title = title;
  button.setAttribute('aria-label', title);
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    Promise.resolve(action()).catch((error) => showNotice(error.message));
  });
  return button;
}

function projectGroup(project) {
  const group = document.createElement('section');
  group.className = `project-group${activeProjectId === project.id ? ' selected' : ''}${expandedProjectIds.has(project.id) ? ' expanded' : ''}`;
  group.dataset.project = project.id;
  group.dataset.projectSignature = projectSignature(project);

  const header = document.createElement('div');
  header.className = 'project-header';
  const select = document.createElement('button');
  select.type = 'button';
  select.className = 'project-select';
  select.title = project.cwd;
  select.setAttribute('aria-expanded', String(expandedProjectIds.has(project.id)));
  const icon = document.createElement('span');
  icon.className = 'project-icon';
  icon.setAttribute('aria-hidden', 'true');
  const label = document.createElement('span');
  label.className = 'project-name';
  label.textContent = project.name;
  select.append(icon, label);
  select.addEventListener('click', () => selectProject(project.id));

  const actions = document.createElement('div');
  actions.className = 'project-actions';
  actions.append(
    projectAction(chatActionIcon(), `New chat in ${project.name}`, () => createChat(project.id), 'project-new-chat'),
    projectAction('✎', `Edit ${project.name}`, () => openProjectDialog(project)),
    projectAction('×', `Delete project ${project.name}`, () => deleteProject(project), 'project-delete'),
  );
  header.append(select, actions);

  const chatList = document.createElement('div');
  chatList.className = 'chat-list';
  const chatListClip = document.createElement('div');
  chatListClip.className = 'chat-list-clip';
  const projectSessions = sessionsByActivity(sessions.filter((session) => session.projectId === project.id));
  const visibleSessions = showAllProjectIds.has(project.id) ? projectSessions : projectSessions.slice(0, 5);
  for (const session of visibleSessions) chatListClip.append(sessionRow(session));
  if (projectSessions.length > 5) {
    const showMore = document.createElement('button');
    const expanded = showAllProjectIds.has(project.id);
    showMore.type = 'button';
    showMore.className = 'show-more-sessions';
    showMore.textContent = expanded ? 'Show less' : `Show ${projectSessions.length - 5} more`;
    showMore.addEventListener('click', (event) => {
      event.stopPropagation();
      if (expanded) showAllProjectIds.delete(project.id);
      else showAllProjectIds.add(project.id);
      renderProjects();
    });
    chatListClip.append(showMore);
  }
  if (projectSessions.length === 0) {
    const message = document.createElement('p');
    message.className = 'project-empty';
    message.textContent = 'No chats';
    chatListClip.append(message);
  }
  chatList.append(chatListClip);
  group.append(header, chatList);
  return group;
}

function replaceProjects() {
  projectList.replaceChildren();
  for (const project of projects) projectList.append(projectGroup(project));

  const orphanSessions = sessionsByActivity(
    sessions.filter((session) => !session.projectId || !projects.some((project) => project.id === session.projectId)),
  );
  if (orphanSessions.length) {
    const heading = document.createElement('div');
    heading.className = 'orphan-heading';
    heading.textContent = 'Other sessions';
    const list = document.createElement('div');
    list.className = 'chat-list always-open';
    const clip = document.createElement('div');
    clip.className = 'chat-list-clip';
    for (const session of orphanSessions) clip.append(sessionRow(session));
    list.append(clip);
    projectList.append(heading, list);
  }
  renderedSidebarSignature = sidebarSignature(projects, sessions);
}

function projectSignature(project) {
  return JSON.stringify({ name: project.name, cwd: project.cwd, agentId: project.agentId });
}

function reconcileChatList(clip, projectSessions, projectId, limited = true) {
  const existingRows = new Map(
    [...clip.querySelectorAll(':scope > .session-row')].map((row) => [row.dataset.session, row]),
  );
  for (const child of [...clip.children]) {
    if (!child.classList.contains('session-row')) child.remove();
  }

  const visibleSessions = limited && !showAllProjectIds.has(projectId)
    ? projectSessions.slice(0, 5)
    : projectSessions;
  for (const session of visibleSessions) {
    let row = existingRows.get(session.name);
    if (row) {
      existingRows.delete(session.name);
      syncSessionRow(row, session);
    } else {
      row = sessionRow(session);
      row.classList.add('entering');
      row.addEventListener('animationend', () => row.classList.remove('entering'), { once: true });
    }
    // Moving a keyed row preserves its DOM, focus and hover state.
    clip.append(row);
  }
  for (const row of existingRows.values()) row.remove();

  if (limited && projectSessions.length > 5) {
    const expanded = showAllProjectIds.has(projectId);
    const showMore = document.createElement('button');
    showMore.type = 'button';
    showMore.className = 'show-more-sessions';
    showMore.textContent = expanded ? 'Show less' : `Show ${projectSessions.length - 5} more`;
    showMore.addEventListener('click', (event) => {
      event.stopPropagation();
      if (expanded) showAllProjectIds.delete(projectId);
      else showAllProjectIds.add(projectId);
      renderProjects();
    });
    clip.append(showMore);
  }
  if (projectSessions.length === 0) {
    const message = document.createElement('p');
    message.className = 'project-empty';
    message.textContent = 'No chats';
    clip.append(message);
  }
}

function renderProjects() {
  const groups = [...projectList.querySelectorAll(':scope > .project-group')];
  const sameProjectStructure = groups.length === projects.length && groups.every(
    (group, index) => group.dataset.project === projects[index].id,
  );
  if (!sameProjectStructure) {
    replaceProjects();
    return;
  }

  for (let index = 0; index < projects.length; index += 1) {
    const project = projects[index];
    let group = groups[index];
    if (group.dataset.projectSignature !== projectSignature(project)) {
      const replacement = projectGroup(project);
      group.replaceWith(replacement);
      group = replacement;
    } else {
      group.classList.toggle('selected', activeProjectId === project.id);
      group.classList.toggle('expanded', expandedProjectIds.has(project.id));
      group.querySelector('.project-select')?.setAttribute(
        'aria-expanded', String(expandedProjectIds.has(project.id)),
      );
      const projectSessions = sessionsByActivity(
        sessions.filter((session) => session.projectId === project.id),
      );
      reconcileChatList(group.querySelector('.chat-list-clip'), projectSessions, project.id);
    }
  }

  const orphanSessions = sessionsByActivity(
    sessions.filter((session) => !session.projectId || !projects.some((project) => project.id === session.projectId)),
  );
  let orphanHeading = projectList.querySelector(':scope > .orphan-heading');
  let orphanList = projectList.querySelector(':scope > .chat-list.always-open');
  if (orphanSessions.length > 0) {
    if (!orphanHeading || !orphanList) {
      orphanHeading = document.createElement('div');
      orphanHeading.className = 'orphan-heading';
      orphanHeading.textContent = 'Other sessions';
      orphanList = document.createElement('div');
      orphanList.className = 'chat-list always-open';
      const clip = document.createElement('div');
      clip.className = 'chat-list-clip';
      orphanList.append(clip);
      projectList.append(orphanHeading, orphanList);
    }
    reconcileChatList(orphanList.querySelector('.chat-list-clip'), orphanSessions, null, false);
  } else {
    orphanHeading?.remove();
    orphanList?.remove();
  }
  renderedSidebarSignature = sidebarSignature(projects, sessions);
}

function sidebarSignature(projectItems, sessionItems) {
  const projectOrder = new Map(projectItems.map((project, index) => [project.id, index]));
  return JSON.stringify({
    projects: projectItems.map(({ id, name, cwd, agentId }) => ({ id, name, cwd, agentId })),
    // Raw activity time is intentionally excluded. Its only visible effect is
    // ordering, so polling does not rebuild a row that stays in the same spot.
    sessions: [...sessionItems]
      .sort((left, right) => {
        const leftProject = projectOrder.get(left.projectId) ?? Number.MAX_SAFE_INTEGER;
        const rightProject = projectOrder.get(right.projectId) ?? Number.MAX_SAFE_INTEGER;
        return leftProject - rightProject || sessionActivityTime(right) - sessionActivityTime(left) ||
          String(left.name).localeCompare(String(right.name));
      })
      .map(({ name, label, projectId, autoTitle, pending }) => ({
        name, label, projectId, autoTitle, pending: Boolean(pending),
      })),
  });
}

function promotePendingSession(temporaryName, optimisticSession, serverSession) {
  Object.assign(optimisticSession, serverSession, { pending: false });
  const row = projectList.querySelector(`.session-row[data-session="${CSS.escape(temporaryName)}"]`);
  if (!row) {
    renderProjects();
    return;
  }
  row.dataset.session = serverSession.name;
  row.dataset.state = 'ready';
  row.classList.remove('pending');
  row.removeAttribute('aria-busy');
  const button = row.querySelector('.session-button');
  const close = row.querySelector('.session-close');
  const name = row.querySelector('.session-name');
  if (button) button.title = serverSession.label;
  if (name) name.textContent = serverSession.label;
  if (close) {
    close.title = `Close ${serverSession.label}`;
    close.setAttribute('aria-label', `Close ${serverSession.label}`);
  }
  renderedSidebarSignature = sidebarSignature(projects, sessions);
}

function disconnectTerminal() {
  detachTerminalRuntime();
}

function connect() {
  const selected = selectedSession();
  if (!activeSession || !selected || selected.pending) {
    disconnectTerminal();
    setView();
    return;
  }
  let runtime = terminalRuntimes.get(activeSession);
  if (!runtime) runtime = createTerminalRuntime(activeSession);
  runtime.suspended = false;
  activateTerminalRuntime(runtime);
  terminalTitle.textContent = selected.label || '';
  if (runtime.revealed) hideSessionLoading(runtime.name);
  else showSessionLoading(selected, 'Attaching to the terminal. You can switch chats while this finishes.');
  connectTerminalRuntime(runtime);
}

function restoreCachedActiveSession() {
  if (compactSidebarMedia.matches) return false;
  if (!activeSession || !terminalSnapshots.has(activeSession)) return false;
  const runtime = createTerminalRuntime(activeSession);
  workspace.dataset.view = 'terminal';
  terminalElement.hidden = false;
  emptyState.setAttribute('aria-hidden', 'true');
  statusElement.hidden = false;
  sessionLoading.hidden = true;
  activateTerminalRuntime(runtime);
  return true;
}

function selectProject(projectId) {
  activeProjectId = projectId;
  localStorage.setItem(ACTIVE_PROJECT_STORAGE_KEY, projectId);
  if (expandedProjectIds.has(projectId)) expandedProjectIds.delete(projectId);
  else expandedProjectIds.add(projectId);
  saveExpandedProjects();
  syncSidebarSelection();
  setView();
}

function showHome() {
  activeProjectId = null;
  localStorage.removeItem(ACTIVE_PROJECT_STORAGE_KEY);
  selectSession(null);
}

function selectSession(name, { expandProject = true } = {}) {
  const currentRuntime = name ? terminalRuntimes.get(name) : undefined;
  if (name && activeSession === name && currentRuntime?.socket?.readyState === WebSocket.OPEN) return;
  activeSession = name || null;
  firstPromptBuffer = '';
  firstPromptSession = activeSession;
  if (activeSession) {
    const session = selectedSession();
    const isPending = Boolean(session?.pending);
    if (isPending) localStorage.removeItem(ACTIVE_SESSION_STORAGE_KEY);
    else localStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, activeSession);
    if (session?.projectId) {
      activeProjectId = session.projectId;
      localStorage.setItem(ACTIVE_PROJECT_STORAGE_KEY, session.projectId);
      if (expandProject) {
      expandedProjectIds.add(session.projectId);
        saveExpandedProjects();
      }
    }
  } else {
    localStorage.removeItem(ACTIVE_SESSION_STORAGE_KEY);
  }

  const activeKey = graphicsPaneKey();
  // Keep inactive terminal and browser runtimes alive. Swapping sessions now
  // only changes which cached DOM tree is mounted; it never tears down a
  // healthy PTY or renderer connection.
  if (activeKey && serverRendererKeys.has(activeKey) && !graphicsPanes.has(activeKey)) connectGraphicsPane(activeKey);
  if (!activeSession || selectedSession()?.pending) disconnectTerminal();
  updateGraphicsSplit();
  syncSidebarSelection();
  setView();
  if (activeSession && !selectedSession()?.pending &&
      !mobileConversation.isVisibleFor(activeSession)) connect();
}

async function refreshWorkspace() {
  const generation = ++refreshGeneration;
  const [projectPayload, sessionPayload, agentPayload] = await Promise.all([
    api('/api/projects'), api('/api/sessions'), api('/api/agents'),
  ]);
  if (generation !== refreshGeneration) return;
  projects = projectPayload.projects.filter((project) => !pendingProjectDeletes.has(project.id));
  agents = agentPayload.agents;
  const optimisticSessions = [...pendingSessionCreates.values()]
    .filter((operation) => !operation.canceled && !pendingProjectDeletes.has(operation.session.projectId) &&
      !pendingProjectClears.has(operation.session.projectId))
    .map((operation) => operation.session);
  sessions = [
    ...optimisticSessions,
    ...sessionPayload.sessions.filter((session) => !pendingSessionDeletes.has(session.name) &&
      !pendingProjectDeletes.has(session.projectId) && !pendingProjectClears.has(session.projectId) &&
      ![...pendingSessionCreates.values()].some((operation) => operation.serverName === session.name))
      .map((session) => ({
        ...session,
        lastActiveAt: Math.max(sessionActivityTime(session), localSessionActivity.get(session.name) || 0),
      })),
  ];
  syncConversationLifecycleStatuses(sessions);
  if (activeProjectId && !projects.some((project) => project.id === activeProjectId)) {
    activeProjectId = null;
    localStorage.removeItem(ACTIVE_PROJECT_STORAGE_KEY);
  }
  if (activeSession && !sessions.some((session) => session.name === activeSession)) {
    activeSession = null;
    localStorage.removeItem(ACTIVE_SESSION_STORAGE_KEY);
    disconnectTerminal();
  }
  const restoredSession = selectedSession();
  if (restoredSession?.projectId && projects.some((project) => project.id === restoredSession.projectId)) {
    activeProjectId = restoredSession.projectId;
    localStorage.setItem(ACTIVE_PROJECT_STORAGE_KEY, restoredSession.projectId);
    // Reveal the restored chat on the first load, then respect manual folding.
    // Polling must not reopen an active project every three seconds.
    if (!workspaceHydrated && !expandedProjectIds.has(restoredSession.projectId)) {
      expandedProjectIds.add(restoredSession.projectId);
      saveExpandedProjects();
    }
  }
  const liveSessionNames = new Set(sessions.filter((session) => !session.pending).map((session) => session.name));
  for (const sessionName of [...terminalSnapshots.keys()]) {
    if (!liveSessionNames.has(sessionName)) removeTerminalSnapshot(sessionName);
  }
  for (const sessionName of [...terminalRuntimes.keys()]) {
    if (!liveSessionNames.has(sessionName)) disposeTerminalRuntime(sessionName);
  }
  const livePaneKeys = new Set(sessions.filter((session) => !session.pending).map((session) => graphicsPaneKey(session.name)));
  for (const key of [...graphicsPanes.keys()]) {
    if (!livePaneKeys.has(key)) disposeGraphicsPane(key);
  }
  updateGraphicsSplit();
  if (sidebarSignature(projects, sessions) !== renderedSidebarSignature) renderProjects();
  else syncSidebarSelection();
  workspaceHydrated = true;
  setView();
  delete document.documentElement.dataset.restoringSession;
  const activeRuntime = activeSession ? terminalRuntimes.get(activeSession) : undefined;
  if (activeSession && !selectedSession()?.pending &&
      !mobileConversation.isVisibleFor(activeSession) &&
      (!activeRuntime || !activeRuntime.socket || activeTerminalRuntime !== activeRuntime)) connect();

  // Renderer discovery can involve a live browser/CDP process and must never
  // delay the primary terminal. Restore the optional split after the selected
  // session is already visible and connecting.
  restoreGraphicsPanes(livePaneKeys, () => generation === refreshGeneration)
    .then(() => {
      if (generation !== refreshGeneration) return;
      updateGraphicsSplit();
    })
    .catch((error) => {
      if (generation === refreshGeneration) showNotice(`Could not restore browser pane: ${error.message}`);
    });
}

async function createChat(projectId = activeProjectId) {
  if (!projectId) return openProjectDialog();
  const project = projects.find((item) => item.id === projectId);
  if (!project || pendingProjectDeletes.has(projectId) || pendingProjectClears.has(projectId)) return;
  invalidateWorkspaceRefresh();
  activeProjectId = projectId;
  localStorage.setItem(ACTIVE_PROJECT_STORAGE_KEY, projectId);
  const operationId = crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const temporaryName = `pending:${operationId}`;
  const optimisticSession = {
    name: temporaryName,
    label: 'New chat',
    projectId,
    autoTitle: true,
    lastActiveAt: Date.now(),
    pending: true,
    nativeConversation: agents.find((agent) => agent.id === project.agentId)?.providerId === 'grok',
  };
  const operation = { id: operationId, session: optimisticSession, canceled: false };
  pendingSessionCreates.set(temporaryName, operation);
  sessions.unshift(optimisticSession);
    expandedProjectIds.add(projectId);
  saveExpandedProjects();
  renderProjects();
  selectSession(temporaryName);

  try {
    const payload = await api(`/api/projects/${encodeURIComponent(projectId)}/sessions`, { method: 'POST' });
    operation.serverName = payload.session.name;
    const projectWasRemoved = operation.canceled || pendingProjectDeletes.has(projectId) ||
      pendingProjectClears.has(projectId) || !projects.some((item) => item.id === projectId);
    if (projectWasRemoved) {
      pendingSessionCreates.delete(temporaryName);
      sessions = sessions.filter((session) => session.name !== temporaryName);
      if (activeSession === temporaryName) selectSession(null);
      renderLocalWorkspace();
      await api(`/api/sessions/${encodeURIComponent(payload.session.name)}`, { method: 'DELETE' }).catch(() => {});
      refreshWhenSettled();
      return;
    }

    pendingSessionCreates.delete(temporaryName);
    sessions = sessions.filter((session) => session === optimisticSession ||
      (session.name !== temporaryName && session.name !== payload.session.name));
    promotePendingSession(temporaryName, optimisticSession, payload.session);
    // Replacing an optimistic id is not a new user selection. Preserve the
    // current fold state in case the project was collapsed while the request
    // was in flight.
    if (activeSession === temporaryName) selectSession(payload.session.name, { expandProject: false });
    else {
      syncSidebarSelection();
      setView();
    }
    refreshWhenSettled();
  } catch (error) {
    pendingSessionCreates.delete(temporaryName);
    sessions = sessions.filter((session) => session.name !== temporaryName);
    if (activeSession === temporaryName) selectSession(null);
    renderLocalWorkspace();
    showNotice(`Could not start a new chat in “${project.name}”: ${error.message}`);
    refreshWhenSettled();
  }
}

function folderButton(label, path, className = '') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `folder-item ${className}`.trim();
  button.textContent = label;
  button.addEventListener('click', () => loadDirectory(path));
  return button;
}

async function loadDirectory(path) {
  formError.textContent = '';
  try {
    const payload = await api(`/api/directories${path ? `?path=${encodeURIComponent(path)}` : ''}`);
    currentFolder = payload.path;
    selectedFolder.textContent = currentFolder;
    selectedFolder.title = currentFolder;
    folderPathInput.value = currentFolder;
    folderRoots.replaceChildren();
    for (const root of payload.roots) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = root;
      button.title = root;
      button.addEventListener('click', () => loadDirectory(root));
      folderRoots.append(button);
    }
    folderList.replaceChildren();
    if (payload.parent) folderList.append(folderButton('↰  ..', payload.parent, 'parent'));
    for (const directory of payload.directories) {
      const child = `${payload.path.replace(/\/$/, '')}/${directory}`;
      folderList.append(folderButton(`▸  ${directory}`, child));
    }
  } catch (error) {
    formError.textContent = error.message;
  }
}

async function openProjectDialog(project) {
  editingProjectId = project?.id || null;
  projectForm.reset();
  formError.textContent = '';
  dialogTitle.textContent = project ? `Edit ${project.name}` : 'New project';
  saveProjectButton.textContent = project ? 'Save changes' : 'Create project';
  if (!agents.length) agents = (await api('/api/agents')).agents;
  projectAgentSelect.replaceChildren(...agents.map((agent) => {
    const option = document.createElement('option');
    option.value = agent.id;
    option.textContent = agent.label;
    return option;
  }));
  if (project) {
    projectNameInput.value = project.name;
  }
  projectAgentSelect.value = project?.agentId || agents[0]?.id || '';
  await loadDirectory(project?.cwd || currentFolder);
  dialog.showModal();
  (project ? projectNameInput : projectAgentSelect).focus();
}

function projectNameFallback() {
  return currentFolder.split('/').filter(Boolean).at(-1) || 'Project';
}

function cleanPromptTitle(value) {
  const title = value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/^\s*[>$❯›»]+\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return title.length > 64 ? `${title.slice(0, 61).trimEnd()}…` : title;
}

async function renameFromFirstPrompt(sessionName, prompt) {
  const title = cleanPromptTitle(prompt);
  const session = sessions.find((item) => item.name === sessionName);
  if (!title || !session?.autoTitle) return;
  session.autoTitle = false;
  session.label = title;
  renderProjects();
  setView();
  try {
    const payload = await api(`/api/sessions/${encodeURIComponent(sessionName)}`, {
      method: 'PATCH',
      body: JSON.stringify({ label: title }),
    });
    session.label = payload.label;
    renderProjects();
    setView();
  } catch {
    session.autoTitle = true;
  }
}

function captureFirstPrompt(data) {
  const session = selectedSession();
  if (!session?.autoTitle) return;
  if (firstPromptSession !== session.name) {
    firstPromptSession = session.name;
    firstPromptBuffer = '';
  }
  const clean = data
    .replaceAll('\x1b[200~', '')
    .replaceAll('\x1b[201~', '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  for (const character of clean) {
    if (character === '\r' || character === '\n') {
      const submitted = firstPromptBuffer;
      firstPromptBuffer = '';
      if (cleanPromptTitle(submitted)) renameFromFirstPrompt(session.name, submitted);
      continue;
    }
    if (character === '\x7f' || character === '\b') {
      firstPromptBuffer = firstPromptBuffer.slice(0, -1);
    } else if (character >= ' ' && character !== '\x7f' && firstPromptBuffer.length < 500) {
      firstPromptBuffer += character;
    }
  }
}

function installHorizontalResizer(element, kind) {
  const isSidebar = kind === 'sidebar';
  const storageKey = isSidebar ? SIDEBAR_WIDTH_STORAGE_KEY : GRAPHICS_WIDTH_STORAGE_KEY;
  const cssVariable = isSidebar ? '--sidebar-width' : '--graphics-width';
  const saved = Number(localStorage.getItem(storageKey));
  if (Number.isFinite(saved) && saved > 0) document.documentElement.style.setProperty(cssVariable, `${saved}px`);

  const setWidth = (clientX) => {
    if (isSidebar) {
      const bounds = workspace.getBoundingClientRect();
      const width = Math.round(Math.max(210, Math.min(430, clientX - bounds.left)));
      document.documentElement.style.setProperty(cssVariable, `${width}px`);
      localStorage.setItem(storageKey, String(width));
    } else {
      const bounds = document.querySelector('#terminal-stage').getBoundingClientRect();
      const width = Math.round(Math.max(280, Math.min(bounds.width - 280, bounds.right - clientX)));
      document.documentElement.style.setProperty(cssVariable, `${width}px`);
      localStorage.setItem(storageKey, String(width));
    }
    requestAnimationFrame(fitTerminals);
  };

  element.addEventListener('pointerdown', (event) => {
    if (element.hidden) return;
    event.preventDefault();
    element.setPointerCapture(event.pointerId);
    document.body.dataset.resizing = kind;
  });
  element.addEventListener('pointermove', (event) => {
    if (document.body.dataset.resizing === kind && element.hasPointerCapture(event.pointerId)) setWidth(event.clientX);
  });
  const endResize = (event) => {
    if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
    if (document.body.dataset.resizing === kind) delete document.body.dataset.resizing;
  };
  element.addEventListener('pointerup', endResize);
  element.addEventListener('pointercancel', endResize);
  element.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const bounds = element.getBoundingClientRect();
    setWidth(bounds.left + (event.key === 'ArrowLeft' ? -16 : 16));
  });
}

document.querySelector('#new-project').addEventListener('click', () => openProjectDialog());
homeButton.addEventListener('click', showHome);
document.querySelector('#go-folder').addEventListener('click', () => loadDirectory(folderPathInput.value));
folderPathInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') { event.preventDefault(); loadDirectory(folderPathInput.value); }
});
for (const cancel of dialog.querySelectorAll('[value="cancel"]')) {
  cancel.addEventListener('click', (event) => { event.preventDefault(); dialog.close(); });
}
projectForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  saveProjectButton.disabled = true;
  formError.textContent = '';
  try {
    const isEditing = Boolean(editingProjectId);
    const payload = await api(isEditing ? `/api/projects/${encodeURIComponent(editingProjectId)}` : '/api/projects', {
      method: isEditing ? 'PATCH' : 'POST',
      body: JSON.stringify({
        agentId: projectAgentSelect.value,
        name: projectNameInput.value.trim() || projectNameFallback(),
        cwd: currentFolder,
      }),
    });
    dialog.close();
    if (isEditing) {
      const projectIndex = projects.findIndex((project) => project.id === payload.project.id);
      if (projectIndex >= 0) projects[projectIndex] = payload.project;
      renderLocalWorkspace();
      await refreshWorkspace();
    } else {
      activeProjectId = payload.project.id;
      localStorage.setItem(ACTIVE_PROJECT_STORAGE_KEY, payload.project.id);
      if (!projects.some((project) => project.id === payload.project.id)) projects.unshift(payload.project);
      renderLocalWorkspace();
      createChat(payload.project.id);
    }
  } catch (error) {
    formError.textContent = error.message;
  } finally {
    saveProjectButton.disabled = false;
  }
});

terminalElement.addEventListener('paste', (event) => {
  const text = event.clipboardData?.getData('text');
  if (text) {
    captureFirstPrompt(text);
    markSessionActive(activeSession, text.includes('\r') || text.includes('\n'));
  }
});
// A stationary tap is text-entry intent; a drag is scrolling/panning intent.
// Do not focus on touchend unconditionally: that makes every swipe reopen the
// software keyboard and prevents native xterm scrolling.
terminalElement.addEventListener('pointerdown', beginTerminalTouch, { capture: true });
terminalElement.addEventListener('pointermove', updateTerminalTouch, { capture: true, passive: true });
terminalElement.addEventListener('pointerup', (event) => finishTerminalTouch(event), { capture: true });
terminalElement.addEventListener('pointercancel', (event) => finishTerminalTouch(event, true), { capture: true });
closeGraphicsSplitButton.addEventListener('click', () => closeGraphicsSplit());
toggleSidebarButton.addEventListener('click', () => {
  setSidebarCollapsed(true);
});
openSidebarButton.addEventListener('click', () => setSidebarCollapsed(false));
sidebarEdgeTrigger.addEventListener('pointerenter', showSidebarPeek);
sidebarEdgeTrigger.addEventListener('pointerleave', scheduleSidebarPeekClose);
sidebar.addEventListener('pointerenter', () => clearTimeout(sidebarPeekCloseTimer));
sidebar.addEventListener('pointerleave', scheduleSidebarPeekClose);
window.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'b') {
    event.preventDefault();
    setSidebarCollapsed(workspace.dataset.sidebar !== 'collapsed');
  }
});
installHorizontalResizer(sidebarResizer, 'sidebar');
installHorizontalResizer(graphicsResizer, 'graphics');
compactSidebarMedia.addEventListener('change', syncSidebarForViewport);
syncSidebarForViewport();
function syncVisualViewportHeight() {
  if (!window.visualViewport) return;
  document.documentElement.style.setProperty('--visual-viewport-height', `${Math.round(window.visualViewport.height)}px`);
  requestAnimationFrame(resize);
}
window.visualViewport?.addEventListener('resize', syncVisualViewportHeight);
syncVisualViewportHeight();
requestAnimationFrame(() => requestAnimationFrame(() => {
  delete document.documentElement.dataset.sidebarBooting;
  delete document.documentElement.dataset.initialSidebar;
}));
const observer = new ResizeObserver(resize);
observer.observe(terminalElement);
observer.observe(graphicsTerminalElement);
const poller = setInterval(() => {
  if (!hasPendingMutations()) refreshWorkspace().catch(() => {});
}, 3000);
window.addEventListener('beforeunload', () => {
  compactSidebarMedia.removeEventListener('change', syncSidebarForViewport);
  window.visualViewport?.removeEventListener('resize', syncVisualViewportHeight);
  observer.disconnect();
  clearInterval(poller);
  mobileConversation.destroy();
  for (const runtime of terminalRuntimes.values()) {
    persistTerminalSnapshot(runtime);
    runtime.disposed = true;
    clearTimeout(runtime.reconnectTimer);
    clearTimeout(runtime.revealTimer);
    clearTimeout(runtime.workIdleTimer);
    clearTimeout(runtime.snapshotTimer);
    clearTerminalRuntimeOutput(runtime);
    if (runtime.socket && runtime.socket.readyState < WebSocket.CLOSING) {
      runtime.socket.close(1000, 'Page closed');
    }
  }
  for (const timer of activitySyncTimers.values()) clearTimeout(timer);
  for (const key of [...graphicsPanes.keys()]) disposeGraphicsPane(key, { closeRemote: false });
});

restoreCachedActiveSession();
void bootstrapRemoteControl();
refreshWorkspace().catch((error) => {
  delete document.documentElement.dataset.restoringSession;
  setStatus('disconnected', error.message);
  statusElement.hidden = false;
  activeSession = null;
  renderProjects();
  setView();
});
