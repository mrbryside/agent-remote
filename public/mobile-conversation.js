import { markdownNode } from './markdown.js';
import { highlightCodeNode, languageForPath } from './syntax.js';

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function statusLabel(status) {
  if (status === 'calling') return 'Calling';
  if (status === 'working' || status === 'running') return 'Running';
  if (status === 'completed') return 'Done';
  if (status === 'failed' || status === 'error') return 'Failed';
  if (status === 'cancelled') return 'Cancelled';
  if (status === 'pending') return 'Pending';
  return 'Ready';
}

function metric(value) {
  return new Intl.NumberFormat().format(Number(value) || 0);
}

function compactMetric(value) {
  return new Intl.NumberFormat(undefined, {
    notation: 'compact', maximumFractionDigits: 1,
  }).format(Number(value) || 0);
}

function duration(value) {
  const milliseconds = Number(value) || 0;
  if (milliseconds < 1_000) return `${milliseconds} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)} s`;
  return `${(milliseconds / 60_000).toFixed(1)} min`;
}

export function createMobileConversationView({
  api, apiUrl, media, send, cancelTurn, uploadAttachment, searchFiles, readFile, setModel, setMode,
  removeQueuedInput, steerQueuedInput, reorderQueuedInputs, respondPermission, respondQuestion,
  respondPlanReview,
  onVisibilityChange, onStatusChange = () => {}, onBrowserOpen = () => {},
  onShowBrowser = () => {}, onHideBrowser = () => {}, onSubagentAvailabilityChange = () => {},
}) {
  const root = document.querySelector('#mobile-conversation');
  const title = document.querySelector('#mobile-conversation-title');
  const meta = document.querySelector('#mobile-conversation-meta');
  const state = document.querySelector('#mobile-conversation-state');
  const boot = document.querySelector('#mobile-conversation-boot');
  const activityToggle = document.querySelector('#mobile-conversation-activity-toggle');
  const menu = document.querySelector('#mobile-conversation-menu');
  const back = document.querySelector('#mobile-conversation-back');
  const messages = document.querySelector('#mobile-conversation-messages');
  const scrollShell = messages.closest('.mobile-conversation-scroll-shell');
  const jumpToLatest = document.querySelector('#mobile-conversation-jump');
  const interactionDock = document.querySelector('#mobile-conversation-interaction');
  const queue = document.querySelector('#mobile-conversation-queue');
  const composer = document.querySelector('#mobile-conversation-composer');
  const input = document.querySelector('#mobile-conversation-input');
  const sendButton = document.querySelector('#mobile-conversation-send');
  const modelButton = document.querySelector('#mobile-conversation-model');
  const modelLabel = modelButton.querySelector('span');
  const modelList = document.querySelector('#mobile-conversation-model-list');
  const modeButton = document.querySelector('#mobile-conversation-mode');
  const modeLabel = modeButton.querySelector('span');
  const modeList = document.querySelector('#mobile-conversation-mode-list');
  const attachButton = document.querySelector('#mobile-conversation-attach');
  const fileInput = document.querySelector('#mobile-conversation-file');
  const attachmentTray = document.querySelector('#mobile-conversation-attachments');
  const suggestions = document.querySelector('#mobile-conversation-suggestions');
  const context = document.querySelector('#mobile-conversation-context');
  const contextProgress = document.querySelector('#mobile-conversation-context-progress');
  const contextValue = document.querySelector('#mobile-conversation-context-value');
  const activity = document.querySelector('#mobile-conversation-activity');
  const activityLabel = activity.querySelector('span');
  let sessionName;
  let threadId;
  let parentId;
  let providerId;
  let available = false;
  let generation = 0;
  let refreshTimer;
  let foregroundResumeTimer;
  let streamWatchdogTimer;
  let streamSocket;
  let streamKey = '';
  let backgrounded = document.visibilityState === 'hidden';
  let renderedSignature = '';
  let pendingMessage;
  let pendingAcceptanceTimer;
  let lastConversation;
  let queueMutationPending = false;
  let queueRenderSignature = '';
  let rootThreadId;
  let rootConversation;
  let sheet;
  let sheetPanel;
  let sheetList;
  let sheetMessages;
  let sheetTitle;
  let sheetMeta;
  let sheetState;
  let sheetBack;
  let sheetClose;
  let sheetBrowser;
  let sheetHandle;
  let sheetMode = 'list';
  let selectedChildId;
  let selectedPlanId;
  let sheetReturnFocus;
  let sheetPointer;
  let subagentPillHost;
  const expandedItems = new Set();
  const autoExpandedItems = new Set();
  const disclosureMotions = new WeakMap();
  const pendingQuestions = new Map();
  const pendingPlanReviews = new Map();
  let questionStateVersion = 0;
  let modelBusy = false;
  let modelOptionsSignature = '';
  let controlBusy = false;
  let cancellingTurn = false;
  let interactionMotionKey = '';
  let attachments = [];
  let uploadingAttachments = 0;
  let suggestionItems = [];
  let suggestionIndex = 0;
  let suggestionRange;
  let suggestionTimer;
  let suggestionGeneration = 0;
  const mentionedFiles = new Set();
  let followStreamTail = true;
  let tailSnapFrame;
  let fileSheet;
  let fileSheetPanel;
  let fileSheetTitle;
  let fileSheetMeta;
  let fileSheetBody;
  let fileSheetClose;
  let filePreviewGeneration = 0;
  let browserAvailable = false;
  let pillDismissed = false;
  let dismissedPlanRevision = '';
  let expectedConversation = false;

  const planDismissalStoragePrefix = 'agent-remote:mobile-plan-dismissed:';

  function planDismissalStorageKey(name = sessionName) {
    return name ? `${planDismissalStoragePrefix}${encodeURIComponent(name)}` : undefined;
  }

  function loadDismissedPlanRevision(name = sessionName) {
    const key = planDismissalStorageKey(name);
    if (!key) return '';
    try {
      return localStorage.getItem(key) || '';
    } catch {
      return '';
    }
  }

  function persistDismissedPlanRevision(revision) {
    dismissedPlanRevision = revision || '';
    const key = planDismissalStorageKey();
    if (!key) return;
    try {
      if (dismissedPlanRevision) localStorage.setItem(key, dismissedPlanRevision);
      else localStorage.removeItem(key);
    } catch {
      // Storage can be unavailable in hardened/private browser contexts. The
      // in-memory dismissal still behaves correctly for the current view.
    }
  }

  function setBooting(next) {
    const booting = Boolean(next);
    root.dataset.booting = String(booting);
    scrollShell.toggleAttribute('aria-busy', booting);
    composer.inert = booting;
    composer.setAttribute('aria-disabled', String(booting));
    boot.hidden = !booting;
  }

  function setAvailable(next) {
    if (available === next) return;
    available = next;
    root.hidden = !next;
    if (!next) jumpToLatest.hidden = true;
    onVisibilityChange(next);
  }

  function distanceFromBottom(container = messages) {
    return Math.max(0, container.scrollHeight - container.scrollTop - container.clientHeight);
  }

  function snapMessagesToLatest() {
    followStreamTail = true;
    cancelAnimationFrame(tailSnapFrame);
    tailSnapFrame = requestAnimationFrame(() => {
      tailSnapFrame = undefined;
      messages.scrollTop = messages.scrollHeight;
      updateJumpToLatest();
    });
  }

  function scrollIdentity(viewport) {
    const owner = viewport.closest('[data-message-id], [data-event-id]');
    if (!owner) return undefined;
    const ownerId = owner.dataset.messageId
      ? `message:${owner.dataset.messageId}`
      : `event:${owner.dataset.eventId}`;
    const viewportId = viewport.dataset.markdownScroll || viewport.dataset.streamScroll;
    return viewportId ? `${ownerId}:${viewportId}` : undefined;
  }

  function captureStreamScroll(container) {
    const positions = new Map();
    for (const viewport of container.querySelectorAll('[data-markdown-scroll], [data-stream-scroll]')) {
      const identity = scrollIdentity(viewport);
      if (!identity) continue;
      positions.set(identity, {
        top: viewport.scrollTop,
        left: viewport.scrollLeft,
        atBottom: distanceFromBottom(viewport) <= 1,
      });
    }
    return positions;
  }

  function restoreStreamScroll(container, positions) {
    for (const viewport of container.querySelectorAll('[data-markdown-scroll], [data-stream-scroll]')) {
      const position = positions.get(scrollIdentity(viewport));
      if (!position) continue;
      viewport.scrollLeft = position.left;
      viewport.scrollTop = position.atBottom ? viewport.scrollHeight : position.top;
    }
  }

  function updateJumpToLatest() {
    jumpToLatest.hidden = !available || root.dataset.interaction === 'true' || distanceFromBottom() <= 48;
  }

  function closeModelList({ focus = false } = {}) {
    if (modelList.hidden) return;
    modelList.hidden = true;
    modelButton.setAttribute('aria-expanded', 'false');
    if (focus) modelButton.focus({ preventScroll: true });
  }

  function closeAuxiliaryLists({ focus } = {}) {
    for (const [button, list] of [[modeButton, modeList]]) {
      if (!list.hidden) {
        list.hidden = true;
        button.setAttribute('aria-expanded', 'false');
      }
    }
    if (focus) focus.focus({ preventScroll: true });
  }

  function closeAllLists() {
    closeModelList();
    closeAuxiliaryLists();
    closeSuggestions();
  }

  async function chooseModel(modelId, effortId) {
    const control = lastConversation?.controls?.model;
    const option = control?.options?.find((model) => model.id === modelId);
    closeModelList();
    const unchanged = control.currentId === modelId && (!effortId || option?.currentEffortId === effortId);
    if (!option || unchanged || !sessionName || modelBusy) return;
    modelBusy = true;
    modelButton.disabled = true;
    modelLabel.textContent = 'Switching…';
    try {
      await setModel(sessionName, modelId, effortId);
      renderedSignature = '';
      await refresh();
    } catch (error) {
      state.textContent = error.message || 'Model change failed';
      state.dataset.state = 'error';
    } finally {
      modelBusy = false;
      if (lastConversation) renderModelControls(lastConversation);
    }
  }

  function paintModelOptions(control) {
    const fragment = document.createDocumentFragment();
    const groups = new Map();
    for (const option of control.options) {
      const modelId = String(option.id || '').toLowerCase();
      const provider = option.provider
        || (modelId.startsWith('grok') ? { id: 'xai', label: 'xAI' } : undefined)
        || (modelId === 'qwen-local' || modelId.endsWith('-local') ? { id: 'local', label: 'Local' } : undefined)
        || { id: 'other', label: 'Other' };
      const groupId = provider.id || provider.label || 'other';
      if (!groups.has(groupId)) groups.set(groupId, { provider, options: [] });
      groups.get(groupId).options.push(option);
    }
    for (const { provider, options } of groups.values()) {
      const group = element('section', 'mobile-conversation-model-group');
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', provider.label || 'Other');
      group.append(element('div', 'mobile-conversation-model-provider', provider.label || 'Other'));
      for (const option of options) {
        const button = element('button', 'mobile-conversation-model-option');
        button.type = 'button';
        button.setAttribute('role', 'option');
        button.setAttribute('aria-selected', String(option.id === control.currentId));
        button.dataset.modelId = option.id;
        button.append(
          element('strong', '', option.label),
          element('small', '', [option.description,
            option.contextWindowTokens ? `${compactMetric(option.contextWindowTokens)} context` : '',
            option.efforts?.length ? 'Choose effort next' : '']
            .filter(Boolean).join(' · ')),
        );
        button.addEventListener('click', () => {
          if (!option.efforts?.length) return void chooseModel(option.id);
          paintEffortOptions(option);
          modelList.querySelector('[aria-selected="true"]')?.focus({ preventScroll: true });
        });
        group.append(button);
      }
      fragment.append(group);
    }
    modelList.setAttribute('aria-label', 'Choose model');
    modelList.replaceChildren(fragment);
  }

  function paintEffortOptions(option) {
    const fragment = document.createDocumentFragment();
    const header = element('div', 'mobile-conversation-model-step');
    const backButton = element('button', '', '‹');
    backButton.type = 'button';
    backButton.setAttribute('aria-label', 'Back to models');
    backButton.addEventListener('click', () => {
      const control = lastConversation?.controls?.model;
      if (!control) return;
      paintModelOptions(control);
      modelList.querySelector(`[data-model-id="${CSS.escape(option.id)}"]`)?.focus({ preventScroll: true });
    });
    const copy = element('span');
    copy.append(element('small', '', 'Choose effort'), element('strong', '', option.label));
    header.append(backButton, copy);
    fragment.append(header);
    for (const effort of option.efforts) {
      const button = element('button', 'mobile-conversation-model-option');
      button.type = 'button';
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', String(
        option.id === lastConversation?.controls?.model?.currentId && effort.id === option.currentEffortId,
      ));
      button.dataset.effortId = effort.id;
      button.append(element('strong', '', effort.label), element('small', '', effort.description || ''));
      button.addEventListener('click', () => void chooseModel(option.id, effort.id));
      fragment.append(button);
    }
    modelList.setAttribute('aria-label', `Choose effort for ${option.label}`);
    modelList.replaceChildren(fragment);
  }

  function renderModelControls(conversation) {
    const control = conversation.controls?.model;
    const options = Array.isArray(control?.options) ? control.options : [];
    const current = options.find((model) => model.id === control?.currentId);
    if (!current || !options.length) {
      closeModelList();
      modelButton.hidden = true;
      context.hidden = true;
      return;
    }
    modelButton.hidden = false;
    // Grok applies a selection made during an active turn immediately before
    // the next queued prompt. Keep the control usable while text streams.
    modelButton.disabled = modelBusy;
    const currentEffort = current.efforts?.find((effort) => effort.id === current.currentEffortId);
    const currentLabel = [current.label, currentEffort?.label?.replace(/ Effort$/i, '')].filter(Boolean).join(' · ');
    if (!modelBusy) modelLabel.textContent = currentLabel;
    modelButton.setAttribute('aria-label', `Choose model, ${currentLabel}`);

    const nextSignature = JSON.stringify({ currentId: control.currentId, options });
    if (nextSignature !== modelOptionsSignature) {
      modelOptionsSignature = nextSignature;
      paintModelOptions(control);
    }

    const usage = conversation.context;
    if (!usage?.windowTokens && usage?.usedTokens === undefined) {
      context.hidden = true;
      return;
    }
    const percent = Math.max(0, Math.min(100, Number(usage.usagePercent) || 0));
    context.hidden = false;
    contextProgress.value = percent;
    contextProgress.setAttribute('aria-label', `${percent}% of context window used`);
    contextValue.value = `${compactMetric(usage.usedTokens)} / ${compactMetric(usage.windowTokens)}`;
    contextValue.textContent = contextValue.value;
  }

  function renderChoiceControl(conversation, key, button, label, list, change) {
    const control = conversation.controls?.[key];
    const options = Array.isArray(control?.options) ? control.options : [];
    const current = options.find((option) => option.id === control?.currentId);
    if (!current || !options.length) {
      list.hidden = true;
      button.hidden = true;
      return;
    }
    button.hidden = false;
    button.disabled = controlBusy;
    label.textContent = current.label;
    button.setAttribute('aria-label', `Choose ${key}, ${current.label}`);
    const fragment = document.createDocumentFragment();
    for (const option of options) {
      const choice = element('button', 'mobile-conversation-model-option');
      choice.type = 'button';
      choice.setAttribute('role', 'option');
      choice.setAttribute('aria-selected', String(option.id === control.currentId));
      choice.append(element('strong', '', option.label), element('small', '', option.description || ''));
      choice.addEventListener('click', async () => {
        closeAuxiliaryLists();
        if (option.id === control.currentId || controlBusy || !sessionName) return;
        controlBusy = true;
        try {
          await change(sessionName, option.id);
          renderedSignature = '';
          await refresh();
        } catch (error) {
          state.textContent = error.message || `${option.label} failed`;
          state.dataset.state = 'error';
        } finally {
          controlBusy = false;
          if (lastConversation) renderChoiceControls(lastConversation);
        }
      });
      fragment.append(choice);
    }
    list.replaceChildren(fragment);
  }

  function renderChoiceControls(conversation) {
    renderChoiceControl(conversation, 'mode', modeButton, modeLabel, modeList, setMode);
  }

  function commandSubsequenceScore(name, query) {
    let cursor = 0;
    let gaps = 0;
    for (const character of query) {
      const next = name.indexOf(character, cursor);
      if (next < 0) return Number.POSITIVE_INFINITY;
      gaps += next - cursor;
      cursor = next + 1;
    }
    return gaps + name.length / 1_000;
  }

  function rankedCommands(commands, query) {
    const needle = query.trim().toLowerCase();
    const entries = commands.map((command, index) => ({
      command, index, name: String(command.name || '').toLowerCase(),
    }));
    if (!needle) return entries.map(({ command }) => command);
    const sorted = (matches, score) => matches.sort((left, right) =>
      score(left) - score(right) || left.name.length - right.name.length || left.index - right.index)
      .map(({ command }) => command);
    const exact = entries.filter(({ name }) => name === needle);
    if (exact.length) return exact.map(({ command }) => command);
    const prefixes = entries.filter(({ name }) => name.startsWith(needle));
    if (prefixes.length) return sorted(prefixes, () => 0);
    const contained = entries.filter(({ name }) => name.includes(needle));
    if (contained.length) return sorted(contained, ({ name }) => name.indexOf(needle));
    return sorted(entries.filter(({ name }) => Number.isFinite(commandSubsequenceScore(name, needle))),
      ({ name }) => commandSubsequenceScore(name, needle));
  }

  function closeSuggestions() {
    clearTimeout(suggestionTimer);
    suggestions.hidden = true;
    suggestions.replaceChildren();
    suggestionItems = [];
    suggestionRange = undefined;
  }

  function paintSuggestions() {
    if (!suggestionItems.length) return closeSuggestions();
    const fragment = document.createDocumentFragment();
    suggestionItems.forEach((item, index) => {
      const option = element('button', 'mobile-conversation-suggestion');
      option.type = 'button';
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(index === suggestionIndex));
      option.append(
        element('strong', '', item.label),
        element('small', '', [item.description, item.hint].filter(Boolean).join(' · ')),
      );
      option.addEventListener('pointerdown', (event) => event.preventDefault());
      option.addEventListener('click', () => acceptSuggestion(index));
      fragment.append(option);
    });
    suggestions.replaceChildren(fragment);
    suggestions.hidden = false;
    suggestions.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }

  function acceptSuggestion(index = suggestionIndex) {
    const item = suggestionItems[index];
    if (!item || !suggestionRange) return;
    const before = input.value.slice(0, suggestionRange.start);
    const after = input.value.slice(suggestionRange.end);
    const replacement = `${item.value} `;
    input.value = `${before}${replacement}${after}`;
    const caret = before.length + replacement.length;
    input.setSelectionRange(caret, caret);
    if (item.kind === 'file') mentionedFiles.add(item.path);
    closeSuggestions();
    autoSizeInput();
    input.focus({ preventScroll: true });
  }

  function composerCompletion() {
    const caret = input.selectionStart ?? input.value.length;
    const before = input.value.slice(0, caret);
    const slash = before.match(/(?:^|\n)(\s*)\/([^\s]*)$/);
    if (slash) return {
      kind: 'command', query: slash[2], start: caret - slash[2].length - 1, end: caret,
    };
    const file = before.match(/(?:^|\s)@([^\s]*)$/);
    if (file) return {
      kind: 'file', query: file[1], start: caret - file[1].length - 1, end: caret,
    };
    return undefined;
  }

  function updateSuggestions() {
    const completion = composerCompletion();
    suggestionGeneration += 1;
    clearTimeout(suggestionTimer);
    if (!completion || !lastConversation) return closeSuggestions();
    closeModelList();
    closeAuxiliaryLists();
    suggestionRange = completion;
    suggestionIndex = 0;
    if (completion.kind === 'command') {
      suggestionItems = rankedCommands(lastConversation.controls?.commands?.options || [], completion.query)
        .slice(0, 10)
        .map((command) => ({
          kind: 'command', value: `/${command.name}`, label: `/${command.name}`,
          description: command.description, hint: command.inputHint,
        }));
      return paintSuggestions();
    }
    const requestGeneration = suggestionGeneration;
    suggestionTimer = setTimeout(async () => {
      try {
        const payload = await searchFiles(sessionName, completion.query);
        if (requestGeneration !== suggestionGeneration || composerCompletion()?.kind !== 'file') return;
        suggestionItems = (payload.files || []).slice(0, 10).map((file) => ({
          kind: 'file', path: file.path, value: `@${file.path}`, label: file.name,
          description: file.directory || 'Project root', hint: file.path,
        }));
        paintSuggestions();
      } catch {
        if (requestGeneration === suggestionGeneration) closeSuggestions();
      }
    }, 100);
  }

  function dismissModelList(event) {
    if (modelList.hidden || modelList.contains(event.target) || modelButton.contains(event.target)) return;
    closeModelList();
  }

  function schedule(delay = 4_000) {
    clearTimeout(refreshTimer);
    if (media.matches && sessionName) refreshTimer = setTimeout(() => void refresh(), delay);
  }

  function closeStream() {
    clearTimeout(streamWatchdogTimer);
    streamWatchdogTimer = undefined;
    const socket = streamSocket;
    streamSocket = undefined;
    streamKey = '';
    if (socket?.readyState < WebSocket.CLOSING) socket.close(1000, 'Conversation view changed');
  }

  function armStreamWatchdog(socket) {
    clearTimeout(streamWatchdogTimer);
    streamWatchdogTimer = undefined;
    if (!socket || socket !== streamSocket || document.visibilityState === 'hidden') return;
    streamWatchdogTimer = setTimeout(() => {
      if (socket !== streamSocket || document.visibilityState === 'hidden') return;
      state.textContent = 'Reconnecting';
      state.dataset.state = 'working';
      closeStream();
      renderedSignature = '';
      void refresh();
    }, 7_000);
  }

  function suspendForBackground() {
    if (!media.matches || !sessionName) return;
    if (!backgrounded) generation += 1;
    backgrounded = true;
    clearTimeout(refreshTimer);
    clearTimeout(foregroundResumeTimer);
    foregroundResumeTimer = undefined;
    closeStream();
  }

  function resumeFromBackground({ force = false } = {}) {
    if (document.visibilityState === 'hidden' || !media.matches || !sessionName) return;
    if (!backgrounded && !force) return;
    if (foregroundResumeTimer) return;
    foregroundResumeTimer = setTimeout(() => {
      foregroundResumeTimer = undefined;
      if (document.visibilityState === 'hidden' || !media.matches || !sessionName) return;
      backgrounded = false;
      closeStream();
      renderedSignature = '';
      // iOS can suspend a page without delivering a websocket close. Read the
      // authoritative snapshot first to recover every missed token and turn
      // boundary; refresh() then creates a brand-new socket.
      void refresh();
    }, 0);
  }

  function handleVisibilityChange() {
    if (document.visibilityState === 'hidden') suspendForBackground();
    else resumeFromBackground();
  }

  function handlePageShow(event) {
    resumeFromBackground({ force: event.persisted === true });
  }

  function handleWindowFocus() {
    resumeFromBackground();
  }

  function handleOnline() {
    resumeFromBackground({ force: true });
  }

  function streamingAssistant(conversation) {
    if (conversation?.activity?.active !== true) return undefined;
    return [...(conversation.items || [])].reverse().find(
      (item) => item.type === 'message' && item.role === 'assistant',
    );
  }

  function fenceCount(text) {
    return (String(text || '').match(/^(?:```|~~~)/gm) || []).length;
  }

  function streamNeedsMarkdownParse(previousText, suffix) {
    if (/[\n*_`\[\]()#>|~]/.test(suffix)) return true;
    const previousLastLine = previousText.slice(previousText.lastIndexOf('\n') + 1);
    const combinedLastLine = `${previousLastLine}${suffix}`;
    return /^(?: {0,3}(?:[-+*]|\d+[.)])\s| {0,3}#{1,6}\s| {0,3}>\s)/.test(combinedLastLine);
  }

  function reparseStreamingMarkdown(content, nextText) {
    const scroll = captureStreamScroll(content);
    const fresh = markdownNode(nextText, {
      onFileReference: (reference) => void openFileReference(reference),
    });
    content.replaceChildren(...fresh.childNodes);
    content.dataset.streaming = 'true';
    content.__mobileRawText = nextText;
    restoreStreamScroll(content, scroll);
    return content;
  }

  function appendStreamingMarkdown(content, nextText) {
    const previousText = content?.__mobileRawText;
    if (!content || typeof previousText !== 'string' || !nextText.startsWith(previousText)) return undefined;
    const suffix = nextText.slice(previousText.length);
    if (!suffix) return content;
    const previousFences = fenceCount(previousText);
    const nextFences = fenceCount(nextText);
    const previousLastLine = previousText.slice(previousText.lastIndexOf('\n') + 1);
    const openingFenceCompleted = previousFences % 2 === 1 &&
      /^(?:```|~~~)/.test(previousLastLine) && suffix.includes('\n');
    if (previousFences !== nextFences || openingFenceCompleted ||
        (nextFences % 2 === 0 && streamNeedsMarkdownParse(previousText, suffix))) {
      return reparseStreamingMarkdown(content, nextText);
    }
    const openCode = nextFences % 2 === 1 ? content.querySelector('pre code') : undefined;
    if (openCode) {
      openCode.append(document.createTextNode(suffix));
    } else {
      const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
      let lastText;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) lastText = node;
      if (lastText) lastText.data += suffix;
      else content.append(document.createTextNode(suffix));
    }
    content.__mobileRawText = nextText;
    return content;
  }

  function applyStreamTextDelta(conversation, stream) {
    if (stream?.kind !== 'agent_message_chunk' || !lastConversation) return false;
    const compact = !conversation;
    const currentThreadId = lastConversation.thread?.id;
    if (compact ? stream.threadId !== currentThreadId : conversation.thread?.id !== currentThreadId) return false;
    const next = compact
      ? (lastConversation.items || []).find((item) => item.id === stream.messageId)
      : streamingAssistant(conversation);
    const previous = (lastConversation.items || []).find((item) => item.id === next?.id);
    if (!next || !previous || typeof previous.text !== 'string') return false;
    const previousText = previous.text;
    const nextText = compact ? `${previousText}${stream.delta || ''}` : next.text;
    if (typeof nextText !== 'string' || !nextText.startsWith(previousText)) return false;
    const suffix = nextText.slice(previousText.length);
    if (!suffix) return false;
    const source = conversation || lastConversation;
    const isRoot = !source.parent && currentThreadId === rootThreadId;
    const targetMessages = isRoot ? messages : sheetMessages || messages;
    const article = [...targetMessages.querySelectorAll('.mobile-message')]
      .find((node) => node.dataset.messageId === next.id);
    const content = article?.querySelector(':scope > .mobile-message-content[data-streaming="true"]');
    if (!content || content.__mobileRawText !== previousText) return false;

    const atBottom = distanceFromBottom(targetMessages) <= 48;
    appendStreamingMarkdown(content, nextText);
    if (compact) previous.text = nextText;
    else lastConversation = conversation;
    if (isRoot && conversation) {
      rootConversation = conversation;
      state.textContent = statusLabel(conversation.thread.status);
      state.dataset.state = conversation.thread.status;
      onStatusChange(sessionName, conversation.thread.status);
      updateComposerAction();
    }
    if (atBottom || (isRoot && followStreamTail)) {
      targetMessages.scrollTop = targetMessages.scrollHeight;
    }
    if (isRoot) updateJumpToLatest();
    return true;
  }

  function subagentState(item) {
    if (item.phase === 'calling') return 'calling';
    if (item.status === 'completed' || item.phase === 'done') return 'completed';
    if (item.status === 'failed' || item.status === 'cancelled') return item.status;
    return 'running';
  }

  function subagents(conversation) {
    return (conversation.items || []).filter((item) => item.type === 'subagent');
  }

  function plans(conversation) {
    return (conversation.items || []).filter((item) => item.type === 'plan');
  }

  function planRevision(plan) {
    if (!plan) return '';
    return JSON.stringify({ id: plan.id, title: plan.title, status: plan.status, entries: plan.entries || [] });
  }

  function visiblePlan(conversation) {
    const plan = plans(conversation).at(-1);
    return planRevision(plan) === dismissedPlanRevision ? undefined : plan;
  }

  function planProgress(plan) {
    const entries = Array.isArray(plan?.entries) ? plan.entries : [];
    return {
      completed: entries.filter((entry) => entry.status === 'completed').length,
      total: entries.length,
    };
  }

  function subagentForThread(nextThreadId) {
    return subagents(rootConversation || {}).find((item) => item.threadId === nextThreadId);
  }

  function renderChildSheetHeader(conversation) {
    if (!sheet) return;
    const lifecycle = subagentForThread(conversation.thread.id) || subagentForThread(selectedChildId);
    const lifecycleState = lifecycle ? subagentState(lifecycle) : conversation.thread.status;
    sheetTitle.textContent = lifecycle?.title || conversation.thread.title;
    sheetMeta.textContent = [
      lifecycle?.role || conversation.thread.agentName,
      lifecycle?.model || conversation.thread.model,
      lifecycle?.capabilityMode,
    ].filter(Boolean).join(' · ');
    sheetState.textContent = statusLabel(lifecycleState);
    sheetState.dataset.state = lifecycleState;
  }

  function ensureSheet() {
    if (sheet) return;
    sheet = element('section', 'mobile-subagent-sheet');
    sheet.hidden = true;
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-label', 'Activity details');
    sheet.tabIndex = -1;
    sheetPanel = element('div', 'mobile-subagent-sheet-panel');
    sheetHandle = element('button', 'mobile-subagent-sheet-handle');
    sheetHandle.type = 'button';
    sheetHandle.setAttribute('aria-label', 'Drag down to close activity');
    const header = element('header', 'mobile-subagent-sheet-header');
    sheetBack = element('button', 'mobile-subagent-sheet-back', '‹');
    sheetBack.type = 'button';
    sheetBack.setAttribute('aria-label', 'Back to subagent list');
    sheetTitle = element('strong', '', 'Subagents');
    sheetMeta = element('small');
    const copy = element('span');
    copy.append(sheetTitle, sheetMeta);
    sheetState = element('span', 'mobile-subagent-sheet-state');
    sheetBrowser = element('button', 'mobile-subagent-sheet-browser', 'Browser');
    sheetBrowser.type = 'button';
    sheetBrowser.hidden = !browserAvailable;
    sheetClose = element('button', 'mobile-subagent-sheet-close', '×');
    sheetClose.type = 'button';
    sheetClose.setAttribute('aria-label', 'Close activity');
    const actions = element('span', 'mobile-subagent-sheet-actions');
    actions.append(sheetBrowser, sheetClose);
    header.append(sheetBack, copy, sheetState, actions);
    sheetList = element('div', 'mobile-subagent-list');
    sheetMessages = element('div', 'mobile-subagent-sheet-messages');
    sheetMessages.setAttribute('role', 'log');
    sheetMessages.setAttribute('aria-live', 'polite');
    sheetPanel.append(sheetHandle, header, sheetList, sheetMessages);
    sheet.append(sheetPanel);
    root.append(sheet);
    sheet.addEventListener('click', (event) => {
      if (event.target === sheet) closeSheet();
    });
    sheetClose.addEventListener('click', () => closeSheet({ dismiss: true }));
    sheetBack.addEventListener('click', showSheetList);
    sheetBrowser.addEventListener('click', () => {
      closeSheet();
      onShowBrowser(sessionName);
    });
    sheet.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeSheet();
      }
      if (event.key !== 'Tab') return;
      const controls = Array.from(sheet.querySelectorAll('button:not([hidden]):not(:disabled), [tabindex="0"]'));
      if (!controls.length) return;
      const first = controls[0];
      const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
    sheetHandle.addEventListener('pointerdown', (event) => {
      sheetPointer = { id: event.pointerId, startY: event.clientY, distance: 0 };
      sheetHandle.setPointerCapture?.(event.pointerId);
      sheetPanel.dataset.dragging = 'true';
    });
    sheetHandle.addEventListener('pointermove', (event) => {
      if (!sheetPointer || event.pointerId !== sheetPointer.id) return;
      sheetPointer.distance = Math.max(0, event.clientY - sheetPointer.startY);
      sheetPanel.style.setProperty('--mobile-sheet-drag', `${sheetPointer.distance}px`);
    });
    const finishDrag = (event) => {
      if (!sheetPointer || event.pointerId !== sheetPointer.id) return;
      const shouldClose = sheetPointer.distance > 96;
      sheetPointer = undefined;
      delete sheetPanel.dataset.dragging;
      sheetPanel.style.removeProperty('--mobile-sheet-drag');
      if (shouldClose) closeSheet();
    };
    sheetHandle.addEventListener('pointerup', finishDrag);
    sheetHandle.addEventListener('pointercancel', finishDrag);
  }

  function renderSubagentList(conversation = rootConversation) {
    if (!sheet || !conversation) return;
    const items = subagents(conversation);
    const running = items.filter((item) => ['calling', 'running'].includes(subagentState(item))).length;
    sheetTitle.textContent = running ? `${running} agent${running === 1 ? '' : 's'} running` : 'Subagents';
    sheetMeta.textContent = `${items.length} agent${items.length === 1 ? '' : 's'}`;
    sheetState.textContent = '';
    sheetList.replaceChildren();
    for (const item of items) {
      const lifecycleState = subagentState(item);
      const row = element(item.threadId ? 'button' : 'article', 'mobile-subagent-row');
      row.dataset.state = lifecycleState;
      if (item.threadId) {
        row.type = 'button';
        row.dataset.threadId = item.threadId;
        row.addEventListener('click', () => openChild(item.threadId));
      } else row.setAttribute('aria-label', `${item.title || 'Subagent'} · ${statusLabel(lifecycleState)}`);
      const copy = element('span');
      copy.append(
        element('strong', '', item.title || 'Subagent'),
        element('small', '', [item.role || 'Subagent', item.model, item.capabilityMode]
          .filter(Boolean).join(' · ')),
      );
      const status = element('span', 'mobile-subagent-status', statusLabel(lifecycleState));
      status.dataset.state = lifecycleState;
      row.append(copy, status, element('i', '', item.threadId ? '›' : '…'));
      sheetList.append(row);
    }
    if (!items.length) sheetList.append(element('p', 'mobile-subagent-empty', 'No subagents yet.'));
  }

  function renderSubagentPill(conversation) {
    if (!subagentPillHost) {
      subagentPillHost = element('div', 'mobile-subagent-pill-host');
      scrollShell.append(subagentPillHost);
    }
    const items = subagents(conversation);
    const plan = visiblePlan(conversation);
    onSubagentAvailabilityChange(items.length > 0);
    if (!items.length && !browserAvailable && !plan) {
      subagentPillHost.replaceChildren();
      subagentPillHost.hidden = true;
      activityToggle.hidden = true;
      return;
    }
    subagentPillHost.hidden = pillDismissed;
    activityToggle.hidden = !pillDismissed;
    const cluster = element('span', 'mobile-activity-pill-cluster');
    if (browserAvailable) {
      const browser = element('button', 'mobile-browser-pill');
      browser.type = 'button';
      browser.setAttribute('aria-label', 'Open browser');
      browser.append(element('i'), element('span', '', 'Browser'));
      browser.addEventListener('click', () => {
        closeSheet();
        onShowBrowser(sessionName);
      });
      cluster.append(browser);
    }
    if (plan) {
      const progress = planProgress(plan);
      const label = progress.total ? `Plan ${progress.completed} / ${progress.total}` : 'Plan';
      const planButton = element('button', 'mobile-plan-pill');
      planButton.type = 'button';
      planButton.dataset.state = plan.status || 'pending';
      planButton.setAttribute('aria-label', `${label}. View plan`);
      planButton.append(element('i'), element('span', '', label));
      planButton.addEventListener('click', () => openPlanSheet(plan.id));
      cluster.append(planButton);
    }
    if (items.length) {
      const running = items.filter((item) => ['calling', 'running'].includes(subagentState(item))).length;
      const label = running ? `${running} agent${running === 1 ? '' : 's'} running`
        : `${items.length} agent${items.length === 1 ? '' : 's'} done`;
      const pill = element('button', 'mobile-subagent-pill');
      pill.type = 'button';
      pill.dataset.state = running ? 'running' : 'completed';
      pill.setAttribute('aria-label', `${label}. View subagents`);
      pill.append(element('i'), element('span', '', label), element('small', '', `${items.length}`));
      pill.addEventListener('click', () => openSheet());
      cluster.append(pill);
    }
    const dismiss = element('button', 'mobile-activity-pill-dismiss', '×');
    dismiss.type = 'button';
    dismiss.setAttribute('aria-label', 'Hide activity');
    dismiss.addEventListener('click', () => {
      pillDismissed = true;
      subagentPillHost.hidden = true;
      activityToggle.hidden = false;
      activityToggle.focus({ preventScroll: true });
    });
    cluster.append(dismiss);
    subagentPillHost.replaceChildren(cluster);
  }

  function clearSubagentPill() {
    if (!subagentPillHost) return;
    subagentPillHost.replaceChildren();
    subagentPillHost.hidden = true;
    activityToggle.hidden = true;
    onSubagentAvailabilityChange(false);
  }

  activityToggle.addEventListener('click', () => {
    pillDismissed = false;
    renderSubagentPill(rootConversation || { items: [] });
  });

  function openSheet() {
    ensureSheet();
    sheetReturnFocus = document.activeElement;
    sheet.hidden = false;
    sheetMode = 'list';
    sheetPanel.dataset.mode = 'list';
    selectedChildId = undefined;
    selectedPlanId = undefined;
    onHideBrowser(sessionName);
    sheetBrowser.hidden = !browserAvailable;
    renderSubagentList();
    sheetList.hidden = false;
    sheetMessages.hidden = true;
    sheetBack.hidden = true;
    requestAnimationFrame(() => sheetClose.focus({ preventScroll: true }));
  }

  function renderPlanSheet(conversation = rootConversation) {
    if (!sheet || !conversation) return;
    const availablePlans = plans(conversation);
    const plan = availablePlans.find((item) => item.id === selectedPlanId) || availablePlans.at(-1);
    if (!plan) {
      sheetTitle.textContent = 'Plan';
      sheetMeta.textContent = 'No plan available';
      sheetState.textContent = '';
      sheetMessages.replaceChildren(element('p', 'mobile-subagent-empty', 'No plan available.'));
      return;
    }
    selectedPlanId = plan.id;
    const progress = planProgress(plan);
    sheetTitle.textContent = plan.title || 'Plan';
    sheetMeta.textContent = `${progress.completed} of ${progress.total} task${progress.total === 1 ? '' : 's'} complete`;
    sheetState.textContent = statusLabel(plan.status);
    sheetState.dataset.state = plan.status || 'pending';
    const content = element('section', 'mobile-plan-sheet-content');
    content.append(planListNode(plan));
    sheetMessages.replaceChildren(content);
  }

  function openPlanSheet(planId) {
    ensureSheet();
    sheetReturnFocus = document.activeElement;
    sheet.hidden = false;
    sheetMode = 'plan';
    sheetPanel.dataset.mode = 'plan';
    selectedChildId = undefined;
    selectedPlanId = planId;
    onHideBrowser(sessionName);
    sheetBrowser.hidden = !browserAvailable;
    sheetList.hidden = true;
    sheetMessages.hidden = false;
    sheetBack.hidden = true;
    renderPlanSheet();
    requestAnimationFrame(() => sheetClose.focus({ preventScroll: true }));
  }

  function openChild(nextThreadId) {
    selectedChildId = nextThreadId;
    selectedPlanId = undefined;
    const lifecycle = subagentForThread(nextThreadId);
    sheetMode = 'child';
    sheetPanel.dataset.mode = 'child';
    sheetList.hidden = true;
    sheetMessages.hidden = false;
    sheetBack.hidden = false;
    sheetTitle.textContent = lifecycle?.title || 'Opening subagent…';
    sheetMeta.textContent = [lifecycle?.role, lifecycle?.model, lifecycle?.capabilityMode]
      .filter(Boolean).join(' · ');
    sheetState.textContent = lifecycle ? statusLabel(subagentState(lifecycle)) : 'Loading';
    sheetState.dataset.state = lifecycle ? subagentState(lifecycle) : 'loading';
    closeStream();
    threadId = nextThreadId;
    renderedSignature = '';
    sheetMessages.replaceChildren(element('div', 'mobile-conversation-loading', 'Opening subagent…'));
    void refresh();
  }

  function showSheetList() {
    if (sheetMode !== 'child') return;
    closeStream();
    threadId = rootThreadId;
    selectedChildId = undefined;
    sheetMode = 'list';
    sheetPanel.dataset.mode = 'list';
    sheetList.hidden = false;
    sheetMessages.hidden = true;
    sheetBack.hidden = true;
    renderSubagentList();
    renderedSignature = '';
    void refresh();
  }

  function closeSheet({ dismiss = false } = {}) {
    if (!sheet || sheet.hidden) return;
    const childWasOpen = sheetMode === 'child';
    if (dismiss && sheetMode === 'plan') {
      const plan = plans(rootConversation || {}).find((item) => item.id === selectedPlanId)
        || plans(rootConversation || {}).at(-1);
      persistDismissedPlanRevision(planRevision(plan));
    }
    if (childWasOpen) closeStream();
    sheet.hidden = true;
    sheetMode = 'list';
    selectedChildId = undefined;
    selectedPlanId = undefined;
    threadId = rootThreadId;
    if (childWasOpen) {
      renderedSignature = '';
      void refresh();
    }
    if (dismiss) renderSubagentPill(rootConversation || { items: [] });
    sheetReturnFocus?.focus?.({ preventScroll: true });
  }

  function startStream() {
    if (document.visibilityState === 'hidden' || !media.matches || !sessionName || !threadId || !available) return;
    const nextKey = `${sessionName}:${threadId}`;
    if (streamSocket && streamKey === nextKey && streamSocket.readyState < WebSocket.CLOSING) return;
    closeStream();
    streamKey = nextKey;
    const url = apiUrl('/conversation-ws');
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('session', sessionName);
    url.searchParams.set('thread', threadId);
    const socket = new WebSocket(url);
    streamSocket = socket;
    armStreamWatchdog(socket);
    socket.addEventListener('message', (event) => {
      if (socket !== streamSocket) return;
      armStreamWatchdog(socket);
      try {
        const payload = JSON.parse(event.data);
        if (payload.type === 'heartbeat') return;
        if (payload.type === 'conversation') {
          const payloadThreadId = payload.conversation?.thread?.id || payload.stream?.threadId;
          if (payloadThreadId !== threadId) return;
          if (payload.conversation) providerId = payload.conversation.provider.id;
          if (!applyStreamTextDelta(payload.conversation, payload.stream)) {
            if (payload.conversation) render(payload.conversation, { animate: true, fromStream: true });
            else schedule(0);
          }
          return;
        }
        if (payload?.type === 'control' && payload.action === 'open-graphics' &&
            Array.isArray(payload.argv) && payload.argv.length > 0 && payload.argv.length <= 100 &&
            payload.argv.every((argument) => typeof argument === 'string' && argument.length <= 4096)) {
          browserAvailable = true;
          renderSubagentPill(rootConversation || { items: [] });
          onBrowserOpen(sessionName, payload.argv);
          return;
        }
        if (payload?.type === 'error') {
          state.textContent = payload.error || 'Stream failed';
          state.dataset.state = 'error';
        }
      } catch {
        schedule();
      }
    });
    socket.addEventListener('open', () => {
      if (socket !== streamSocket) return;
      clearTimeout(refreshTimer);
      armStreamWatchdog(socket);
    });
    socket.addEventListener('close', () => {
      if (socket !== streamSocket) return;
      state.textContent = 'Reconnecting';
      state.dataset.state = 'working';
      streamSocket = undefined;
      streamKey = '';
      clearTimeout(streamWatchdogTimer);
      streamWatchdogTimer = undefined;
      renderedSignature = '';
      void refresh();
    });
    socket.addEventListener('error', () => {
      if (socket !== streamSocket) return;
      state.textContent = 'Reconnecting';
      state.dataset.state = 'working';
    });
  }

  function normalizedFilePath(value) {
    return String(value || '').replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/');
  }

  function sameFilePath(candidate, requested) {
    const left = normalizedFilePath(candidate);
    const right = normalizedFilePath(requested);
    return left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`);
  }

  function conversationFiles(conversation) {
    const files = [];
    for (const item of conversation?.items || []) {
      const tools = item.type === 'tool_group' ? item.tools || [] : item.type === 'tool' ? [item] : [];
      for (const tool of tools) {
        if (tool.file?.path && tool.file?.content !== undefined) files.push(tool.file);
        for (const change of tool.diffs || []) {
          files.push({
            path: change.path,
            content: change.newText || change.oldText || '',
            startLine: change.newLine || change.oldLine || 1,
            changed: true,
          });
        }
      }
    }
    return files;
  }

  function fileLinesNode(file, { startLine, endLine, streamId = 'file' } = {}) {
    const viewport = element('div', 'mobile-file-lines');
    viewport.dataset.streamScroll = streamId;
    const content = String(file?.content || '').replace(/\n$/, '');
    const lines = content ? content.split('\n') : ['File content was not captured'];
    const firstLine = Math.max(1, Number(file?.startLine) || 1);
    const highlightStart = Math.max(1, Number(startLine) || 0);
    const highlightEnd = Math.max(highlightStart, Number(endLine) || highlightStart);
    const language = languageForPath(file?.path);
    for (const [index, text] of lines.entries()) {
      const number = firstLine + index;
      const row = element('div', 'mobile-file-line');
      if (highlightStart && number >= highlightStart && number <= highlightEnd) row.dataset.highlighted = 'true';
      if (file?.changed) row.dataset.changed = 'true';
      const code = element('code');
      highlightCodeNode(code, text || ' ', language);
      row.append(element('span', '', number), code);
      viewport.append(row);
    }
    return viewport;
  }

  function filePreviewNode(file, options = {}) {
    const section = element('section', 'mobile-event-file');
    const header = element('header');
    const lineLabel = file.totalLines ? `${metric(file.totalLines)} lines`
      : options.startLine ? `Line ${options.startLine}${options.endLine && options.endLine !== options.startLine ? `–${options.endLine}` : ''}` : 'File';
    header.append(element('strong', '', file.path || options.path || 'File'), element('small', '', lineLabel));
    section.append(header, fileLinesNode(file, options));
    return section;
  }

  function closeFileSheet() {
    if (!fileSheet || fileSheet.hidden) return;
    filePreviewGeneration += 1;
    fileSheet.hidden = true;
  }

  function ensureFileSheet() {
    if (fileSheet) return;
    fileSheet = element('section', 'mobile-file-sheet');
    fileSheet.hidden = true;
    fileSheet.tabIndex = -1;
    fileSheet.setAttribute('role', 'dialog');
    fileSheet.setAttribute('aria-modal', 'true');
    fileSheet.setAttribute('aria-label', 'File preview');
    fileSheetPanel = element('div', 'mobile-file-sheet-panel');
    const handle = element('div', 'mobile-file-sheet-handle');
    const header = element('header', 'mobile-file-sheet-header');
    const copy = element('span');
    fileSheetTitle = element('strong', '', 'File');
    fileSheetMeta = element('small');
    copy.append(fileSheetTitle, fileSheetMeta);
    fileSheetClose = element('button', '', '×');
    fileSheetClose.type = 'button';
    fileSheetClose.setAttribute('aria-label', 'Close file preview');
    fileSheetClose.addEventListener('click', closeFileSheet);
    header.append(copy, fileSheetClose);
    fileSheetBody = element('div', 'mobile-file-sheet-body');
    fileSheetPanel.append(handle, header, fileSheetBody);
    fileSheet.append(fileSheetPanel);
    fileSheet.addEventListener('click', (event) => {
      if (event.target === fileSheet) closeFileSheet();
    });
    fileSheet.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeFileSheet();
    });
    root.append(fileSheet);
  }

  async function openFileReference(reference, fallback) {
    ensureFileSheet();
    const previewGeneration = ++filePreviewGeneration;
    const candidates = conversationFiles(lastConversation).filter((file) => sameFilePath(file.path, reference.path));
    let file = candidates.at(-1) || fallback;
    fileSheet.hidden = false;
    fileSheetTitle.textContent = reference.path.split('/').at(-1) || reference.path;
    fileSheetMeta.textContent = reference.path;
    fileSheetBody.replaceChildren(element('div', 'mobile-conversation-loading', 'Opening file…'));
    fileSheet.focus({ preventScroll: true });
    if (!file && sessionName && typeof readFile === 'function') {
      try {
        file = (await readFile(sessionName, reference.path))?.file;
      } catch (error) {
        if (previewGeneration !== filePreviewGeneration) return;
        file = {
          path: reference.path,
          content: error.message || 'File content is unavailable.',
          startLine: reference.startLine || 1,
        };
      }
    }
    if (previewGeneration !== filePreviewGeneration) return;
    file ||= {
      path: reference.path, content: 'File content was not captured in this conversation.', startLine: reference.startLine || 1,
    };
    const path = file.path || reference.path;
    const startLine = reference.startLine || file.startLine || 1;
    const endLine = reference.endLine || startLine;
    fileSheetTitle.textContent = path.split('/').at(-1) || path;
    fileSheetMeta.textContent = `${path}${reference.startLine ? ` · Lines ${startLine}${endLine !== startLine ? `–${endLine}` : ''}` : ''}`;
    fileSheetBody.replaceChildren(filePreviewNode(file, {
      path, startLine, endLine, streamId: `file-sheet:${path}`,
    }));
  }

  function searchMatchesNode(matches) {
    const section = element('section', 'mobile-event-matches');
    section.append(element('small', '', `${matches.length} ${matches.length === 1 ? 'match' : 'matches'}`));
    const list = element('div');
    for (const match of matches) {
      const button = element('button');
      button.type = 'button';
      const copy = element('span');
      copy.append(element('strong', '', match.path), element('code', '', match.text || 'Match'));
      button.append(element('small', '', `L${match.line}`), copy, element('i', '', '›'));
      button.addEventListener('click', () => void openFileReference(
        { path: match.path, startLine: match.line, endLine: match.line },
        { path: match.path, content: match.text || '', startLine: match.line },
      ));
      list.append(button);
    }
    section.append(list);
    return section;
  }

  function detail(panel, label, value, className = '') {
    if (value === undefined || value === null || value === '') return;
    const section = element('section', `mobile-event-detail ${className}`.trim());
    section.append(element('small', '', label), element('pre', '', String(value)));
    panel.append(section);
  }

  function changeLine(kind, oldNumber, newNumber, text, language) {
    const row = element('div', 'mobile-event-change-line');
    row.dataset.kind = kind;
    row.append(
      element('span', '', kind === 'remove' ? oldNumber || '' : newNumber || oldNumber || ''),
      element('i', '', kind === 'add' ? '+' : kind === 'remove' ? '−' : ' '),
      highlightCodeNode(element('code'), text, language),
    );
    return row;
  }

  function changeParts(change) {
    const splitLines = (value) => {
      const text = String(value || '').replace(/\n$/, '');
      return text ? text.split('\n') : [];
    };
    const before = splitLines(change.oldText);
    const after = splitLines(change.newText);
    let prefix = 0;
    while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
    let suffix = 0;
    while (suffix < before.length - prefix && suffix < after.length - prefix &&
      before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix += 1;
    return {
      before, after, prefix, suffix,
      removed: before.slice(prefix, before.length - suffix),
      added: after.slice(prefix, after.length - suffix),
    };
  }

  function changeStatsNode(added, removed) {
    const stats = element('span', 'mobile-event-change-stats');
    const addedCount = element('small', '', `+${added}`);
    addedCount.dataset.kind = 'add';
    const removedCount = element('small', '', `-${removed}`);
    removedCount.dataset.kind = 'remove';
    stats.append(addedCount, removedCount);
    return stats;
  }

  function changeNode(change, index) {
    const { before, after, prefix, suffix, removed, added } = changeParts(change);
    const oldBase = Math.max(1, Number(change.oldLine) || 1);
    const newBase = Math.max(1, Number(change.newLine) || 1);
    const language = languageForPath(change.path);
    const section = element('section', 'mobile-event-change');
    const header = element('header');
    header.append(
      element('strong', '', change.path || 'Changed file'),
      changeStatsNode(added.length, removed.length),
    );
    const scroll = element('div', 'mobile-event-change-scroll');
    scroll.dataset.streamScroll = `diff:${index}:${change.path || 'changed-file'}`;
    const lines = element('div', 'mobile-event-change-lines');
    const contextStart = Math.max(0, prefix - 3);
    if (contextStart > 0) lines.append(changeLine('skip', '', '', '…', language));
    for (let index = contextStart; index < prefix; index += 1) {
      lines.append(changeLine('context', oldBase + index, newBase + index, before[index], language));
    }
    removed.forEach((line, index) => {
      lines.append(changeLine('remove', oldBase + prefix + index, '', line, language));
    });
    added.forEach((line, index) => {
      lines.append(changeLine('add', '', newBase + prefix + index, line, language));
    });
    const contextCount = Math.min(3, suffix);
    for (let index = 0; index < contextCount; index += 1) {
      lines.append(changeLine(
        'context', oldBase + before.length - suffix + index, newBase + after.length - suffix + index,
        before[before.length - suffix + index], language,
      ));
    }
    if (suffix > contextCount) lines.append(changeLine('skip', '', '', '…', language));
    if (!lines.childNodes.length) lines.append(changeLine('context', oldBase, newBase, before[0] || after[0] || '', language));
    scroll.append(lines);
    section.append(header, scroll);
    return section;
  }

  function commandNode(item) {
    const section = element('section', 'mobile-tool-command');
    const command = element('div', 'mobile-tool-command-line');
    command.append(element('i', '', '$'), highlightCodeNode(element('code'), item.command, 'bash'));
    section.append(command);
    if (item.output) section.append(element('pre', 'mobile-tool-command-output', item.output));
    return section;
  }

  function genericToolCommand(item) {
    let input = item.input;
    if (typeof input === 'string') {
      try { input = JSON.parse(input); } catch { input = undefined; }
    }
    const inputTarget = input && typeof input === 'object' && !Array.isArray(input)
      ? input.target_directory || input.target_file || input.file_path || input.path ||
        input.query || input.pattern || input.url
      : '';
    const title = String(item.title || item.kind || item.name || 'Tool').trim();
    const target = String(item.subject || inputTarget || item.locations?.[0] || '').trim();
    if (!target || title.toLocaleLowerCase().includes(target.toLocaleLowerCase())) return title;
    return `${title} ${target}`;
  }

  function genericToolNode(item) {
    return commandNode({
      command: genericToolCommand(item),
      output: item.output || item.locations?.join('\n') || '',
    });
  }

  function planListNode(item) {
    const list = element('ol', 'mobile-plan-list');
    for (const entry of item.entries || []) {
      const row = element('li');
      row.dataset.state = entry.status;
      row.append(
        element('i'),
        element('span', '', entry.content),
        element('small', '', statusLabel(entry.status)),
      );
      list.append(row);
    }
    return list;
  }

  function eventDetails(panel, item) {
    if (item.type === 'thought' || item.type === 'recap' || item.type === 'event') {
      detail(panel, item.type === 'thought' ? 'Reasoning' : 'Details', item.text);
    }
    if (item.type === 'permission') detail(panel, 'Request', item.text || item.title);
    if (item.type === 'tool') {
      const diffs = Array.isArray(item.diffs) ? item.diffs : [];
      if (diffs.length) {
        for (const [index, change] of diffs.entries()) panel.append(changeNode(change, index));
      } else {
        if (item.command) panel.append(commandNode(item));
        else if (!item.file && !item.matches?.length) panel.append(genericToolNode(item));
        if (item.file) panel.append(filePreviewNode(item.file, { streamId: `read:${item.id}` }));
        if (item.matches?.length) panel.append(searchMatchesNode(item.matches));
      }
      for (const output of item.images || []) {
        const image = element('img', 'mobile-event-image');
        image.alt = `${item.title || 'Tool'} output`;
        image.loading = 'lazy';
        image.src = `data:${output.mimeType};base64,${output.data}`;
        panel.append(image);
      }
    }
    if (item.type === 'plan') {
      panel.append(planListNode(item));
    }
    if (item.type === 'goal') {
      detail(panel, 'Objective', item.objective);
      detail(panel, 'Phase', item.phase);
      if (item.progress) detail(panel, 'Deliverables', `${metric(item.progress.completed)} / ${metric(item.progress.total)}`);
      if (item.metrics) detail(panel, 'Usage', [
        `${metric(item.metrics.tokensUsed)} tokens`,
        duration(item.metrics.elapsedMs),
        `${metric(item.metrics.workerRounds)} worker rounds`,
        `${metric(item.metrics.verifyRounds)} verify rounds`,
      ].join(' · '));
      detail(panel, 'Latest event', item.lastEvent);
    }
    if (item.type === 'task') {
      detail(panel, 'Command', item.command);
      detail(panel, 'Directory', item.cwd);
      detail(panel, 'Output', item.output);
      detail(panel, 'Output file', item.outputFile);
      if (item.exitCode !== undefined) detail(panel, 'Exit code', item.exitCode);
    }
    if (item.type === 'turn') {
      detail(panel, 'Stop reason', item.stopReason);
      if (item.usage) detail(panel, 'Usage', [
        `${metric(item.usage.inputTokens)} in`,
        `${metric(item.usage.outputTokens)} out`,
        `${metric(item.usage.totalTokens)} total`,
        `${metric(item.usage.cachedReadTokens)} cached`,
        `${metric(item.usage.modelCalls)} calls`,
        duration(item.usage.apiDurationMs),
      ].join(' · '));
    }
    if (!panel.childNodes.length) detail(panel, 'Details', 'No additional details');
  }

  function permissionActions(item, status) {
    const actions = element('div', 'mobile-permission-actions');
    const hints = {
      allow_once: 'Allow only this request',
      allow_session: 'Allow for this session',
      allow_always: 'Remember for future requests',
      reject_once: 'Decline and return to Grok',
      reject_always: 'Always decline this permission',
    };
    for (const option of item.options || []) {
      const button = element('button');
      button.type = 'button';
      button.dataset.kind = option.kind || '';
      button.dataset.optionId = option.id;
      button.append(
        element('strong', '', option.label),
        element('small', '', hints[option.kind] || 'Choose this permission response'),
      );
      button.addEventListener('click', async () => {
        for (const sibling of actions.querySelectorAll('button')) sibling.disabled = true;
        try {
          await respondPermission(sessionName, item.permissionId, option.id);
          status.textContent = 'Permission sent';
          status.dataset.state = 'working';
        } catch (error) {
          for (const sibling of actions.querySelectorAll('button')) sibling.disabled = false;
          status.textContent = error.message || 'Permission failed';
          status.dataset.state = 'error';
          void refresh();
        }
      });
      actions.append(button);
    }
    return actions;
  }

  function permissionDockNode(item) {
    const card = element('section', 'mobile-interaction-card mobile-interaction-permission');
    card.dataset.permissionId = item.permissionId;
    card.dataset.state = item.status || 'pending';
    const header = element('header', 'mobile-question-header');
    const copy = element('span');
    copy.append(element('small', '', 'Grok needs permission'), element('strong', '', item.title || 'Permission required'));
    const status = element('span', 'mobile-question-status', statusLabel(item.status));
    status.dataset.state = item.status || 'pending';
    header.append(copy, status);
    card.append(header);
    if (item.text) {
      const details = element('details', 'mobile-permission-details');
      details.open = true;
      details.append(
        element('summary', '', 'Command details'),
        element('pre', '', item.text),
      );
      card.append(details);
    }
    card.append(permissionActions(item, status));
    return card;
  }

  function eventNode(item) {
    if (item.type === 'tool' && ['edit', 'write'].includes(item.kind) && !autoExpandedItems.has(item.id)) {
      autoExpandedItems.add(item.id);
      expandedItems.add(item.id);
    }
    const card = element('article', `mobile-event-card mobile-event-${item.type}`);
    card.dataset.eventId = item.id;
    card.dataset.kind = item.kind || item.type;
    card.dataset.state = item.status || 'completed';
    const toggle = element('button', 'mobile-event-toggle');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', String(expandedItems.has(item.id)));
    const thinking = item.type === 'thought' && ['working', 'running'].includes(item.status);
    const copy = element('span');
    copy.append(element('small', '', item.type === 'thought' ? 'Reasoning' : item.kind || item.type));
    const heading = element('span', 'mobile-event-heading');
    heading.append(element('strong', '', item.type === 'thought'
      ? thinking ? 'Thinking…' : 'Thought'
      : item.title || 'Event'));
    if (item.type === 'tool' && item.diffs?.length) {
      const totals = item.diffs.reduce((summary, change) => {
        const parts = changeParts(change);
        summary.added += parts.added.length;
        summary.removed += parts.removed.length;
        return summary;
      }, { added: 0, removed: 0 });
      heading.append(changeStatsNode(totals.added, totals.removed));
    }
    copy.append(heading);
    const state = element('span', 'mobile-event-status', item.type === 'thought' ? '' : statusLabel(item.status));
    state.dataset.state = item.status;
    if (thinking) {
      state.classList.add('mobile-thinking-indicator');
      state.setAttribute('aria-label', 'Thinking');
    } else if (item.type === 'thought') state.hidden = true;
    const arrow = element('i', '', '›');
    const panel = element('div', 'mobile-event-panel');
    panel.dataset.streamScroll = 'details';
    initializeDisclosure(toggle, panel, expandedItems.has(item.id));
    eventDetails(panel, item);
    toggle.append(copy, state, arrow);
    toggle.addEventListener('click', (event) => {
      if (expandedItems.has(item.id)) expandedItems.delete(item.id);
      else expandedItems.add(item.id);
      const open = expandedItems.has(item.id);
      animateDisclosure(toggle, panel, open);
      if (item.type === 'tool' && event.detail !== 0) toggle.blur();
    });
    card.append(toggle, panel);
    if (item.type === 'permission' && item.status === 'pending') {
      card.append(permissionActions(item, state));
    } else if (item.type === 'permission' && item.selectedLabel) {
      card.append(element('div', 'mobile-permission-result', item.selectedLabel));
    }
    return card;
  }

  function updateQuestionState(questionId, next) {
    pendingQuestions.set(questionId, next);
    questionStateVersion += 1;
  }

  function questionAnswerValues(fieldset) {
    const selected = Array.from(fieldset.querySelectorAll('input[type="radio"], input[type="checkbox"]'))
      .filter((control) => control.checked)
      .map((control) => control.dataset.other === 'true'
        ? fieldset.querySelector('[data-question-custom]')?.value.trim()
        : control.value)
      .filter(Boolean);
    return selected;
  }

  function keepCustomOptionVisible(customInput) {
    const reveal = () => customInput.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    reveal();
    window.visualViewport?.addEventListener('resize', reveal, { once: true });
  }

  function questionNode(item, { docked = false } = {}) {
    const localState = pendingQuestions.get(item.questionId);
    const resolved = !['calling', 'pending', 'working'].includes(item.status);
    if (resolved || item.answers || item.answerSummary) pendingQuestions.delete(item.questionId);
    const pending = resolved ? undefined : localState;
    const submitting = pending?.status === 'submitting';
    const card = element('article', 'mobile-question-card');
    if (docked) card.classList.add('mobile-question-docked');
    card.dataset.questionId = item.questionId;
    card.dataset.state = submitting ? 'working' : item.status || 'pending';
    const header = element('header', 'mobile-question-header');
    const copy = element('span');
    copy.append(element('small', '', 'Grok needs your input'), element('strong', '', item.title || 'Question'));
    const status = element('span', 'mobile-question-status', submitting ? 'Sending…' : statusLabel(item.status));
    status.dataset.state = submitting ? 'working' : item.status || 'pending';
    header.append(copy, status);
    card.append(header);

    if (resolved || item.answers || item.answerSummary) {
      const summary = item.answerSummary || Object.values(item.answers || {}).flat().filter(Boolean).join(' · ');
      if (summary) card.append(element('p', 'mobile-question-summary', summary));
      return card;
    }
    if (item.status === 'calling') {
      card.append(element('p', 'mobile-question-live', 'Preparing choices…'));
      return card;
    }
    if (!(item.questions || []).length) {
      card.append(element('p', 'mobile-question-live', 'Preparing choices…'));
      return card;
    }

    const questions = item.questions || [];
    const lastStep = Math.max(questions.length - 1, 0);
    const step = Math.min(Math.max(pending?.step || 0, 0), lastStep);
    const question = questions[step];
    const form = element('form', 'mobile-question-form');
    form.append(element('p', 'mobile-question-progress', `Question ${step + 1} of ${questions.length}`));
    const live = element('p', 'mobile-question-live');
    live.setAttribute('aria-live', 'polite');
    if (pending?.status === 'failed') live.textContent = pending.error || 'Could not send your answer. Try again.';
    const fieldset = element('fieldset', 'mobile-question-fieldset');
    const legend = element('legend', '', question?.question || `Question ${step + 1}`);
    fieldset.append(legend);
    const options = element('div', 'mobile-question-options');
    const inputType = question?.multiSelect ? 'checkbox' : 'radio';
    const name = `question-${item.questionId}-${step}`;
    for (const [optionIndex, option] of (question?.options || []).entries()) {
      const label = element('label', 'mobile-question-option');
      const control = element('input');
      control.type = inputType;
      control.name = name;
      control.value = option.label || `Option ${optionIndex + 1}`;
      control.disabled = submitting;
      control.checked = Boolean(pending?.values?.[question.question]?.includes(control.value));
      const copy = element('span');
      copy.append(element('strong', '', option.label || `Option ${optionIndex + 1}`));
      if (option.description) copy.append(element('small', '', option.description));
      if (option.preview) copy.append(element('code', '', option.preview));
      label.append(control, copy);
      options.append(label);
    }
    const other = element('label', 'mobile-question-option mobile-question-other');
    const otherControl = element('input');
    otherControl.type = inputType;
    otherControl.name = name;
    otherControl.value = 'Other';
    otherControl.dataset.other = 'true';
    otherControl.disabled = submitting;
    const otherCopy = element('span');
    otherCopy.append(element('strong', '', 'Other'));
    const custom = element('input', 'mobile-question-custom');
    custom.type = 'text';
    custom.placeholder = 'Add your own answer';
    custom.setAttribute('aria-label', `Other answer for ${question?.question || `question ${step + 1}`}`);
    custom.dataset.questionCustom = 'true';
    custom.disabled = submitting;
    custom.value = pending?.customs?.[question?.question] || '';
    otherControl.checked = Boolean(custom.value);
    custom.addEventListener('focus', () => {
      otherControl.checked = true;
      updateValidity();
      keepCustomOptionVisible(custom);
    });
    otherCopy.append(custom);
    other.append(otherControl, otherCopy);
    options.append(other);
    fieldset.append(options);
    form.append(fieldset);
    const actions = element('div', 'mobile-question-actions');
    actions.dataset.firstStep = String(step === 0);
    const back = element('button', 'mobile-question-back', 'Back');
    back.type = 'button';
    back.hidden = step === 0;
    back.disabled = submitting;
    const skip = element('button', 'mobile-question-skip', 'Skip');
    skip.type = 'button';
    skip.disabled = submitting;
    const submit = element('button', 'mobile-question-submit', step < lastStep ? 'Next' : pending?.status === 'failed' ? 'Try again' : 'Continue');
    submit.type = step < lastStep ? 'button' : 'submit';
    submit.disabled = true;
    actions.append(back, skip, submit);
    form.append(live, actions);

    function updateValidity() {
      submit.disabled = submitting || questionAnswerValues(fieldset).length === 0;
    }

    function rememberSelections() {
      if (submitting) return;
      const previous = pendingQuestions.get(item.questionId);
      updateQuestionState(item.questionId, {
        status: previous?.status === 'failed' ? 'failed' : 'editing',
        step,
        values: { ...previous?.values, [question.question]: questionAnswerValues(fieldset) },
        customs: { ...previous?.customs, [question.question]: custom.value.trim() },
        ...(previous?.error ? { error: previous.error } : {}),
      });
    }

    function showStep(nextStep) {
      const previous = pendingQuestions.get(item.questionId) || {};
      const { error, ...editable } = previous;
      updateQuestionState(item.questionId, { ...editable, status: 'editing', step: nextStep });
      renderedSignature = '';
      if (lastConversation) render(lastConversation);
    }

    async function submitQuestion(outcome) {
      if (submitting) return;
      const values = { ...pending?.values, [question.question]: questionAnswerValues(fieldset) };
      const customs = { ...pending?.customs, [question.question]: custom.value.trim() };
      const answers = Object.fromEntries(Object.entries(values).map(([question, selected]) => [question, selected.join(', ')]));
      updateQuestionState(item.questionId, { status: 'submitting', step, values, customs });
      renderedSignature = '';
      if (lastConversation) render(lastConversation);
      try {
        await respondQuestion(sessionName, item.threadId || threadId, item.questionId, answers, outcome);
      } catch (error) {
        updateQuestionState(item.questionId, {
          ...pendingQuestions.get(item.questionId), status: 'failed', error: error.message,
        });
        renderedSignature = '';
        if (lastConversation) render(lastConversation);
        void refresh();
      }
    }

    form.addEventListener('input', () => { updateValidity(); rememberSelections(); });
    form.addEventListener('change', () => { updateValidity(); rememberSelections(); });
    back.addEventListener('click', () => {
      rememberSelections();
      showStep(step - 1);
    });
    if (step < lastStep) submit.addEventListener('click', () => {
      if (!submit.disabled) {
        rememberSelections();
        showStep(step + 1);
      }
    });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!submit.disabled) void submitQuestion('accepted');
    });
    skip.addEventListener('click', () => void submitQuestion('skip_interview'));
    updateValidity();
    card.append(form);
    return card;
  }

  function planReviewState(item) {
    const current = pendingPlanReviews.get(item.reviewId);
    if (current?.content === item.planContent) return current;
    const next = {
      content: item.planContent, selection: undefined, comments: [],
      status: 'editing', error: '', note: '', commentDraft: '',
    };
    pendingPlanReviews.set(item.reviewId, next);
    return next;
  }

  function planLineKind(source, fenced) {
    if (/^\s*```/.test(source)) return 'fence';
    if (fenced) return 'code';
    if (/^\s*#{1,6}\s+/.test(source)) return 'heading';
    if (/^\s*(?:[-*+] |\d+[.)] )/.test(source)) return 'list';
    return source.trim() ? 'text' : 'blank';
  }

  function planFeedback(state, outcome, extra) {
    const blocks = state.comments.map((comment) => {
      const location = comment.start === comment.end
        ? `@plan.md:${comment.start}` : `@plan.md:${comment.start}-${comment.end}`;
      return `${location}\n${comment.text}`;
    });
    if (extra.trim()) blocks.push(extra.trim());
    if (!blocks.length) return '';
    const lead = outcome === 'cancelled'
      ? 'The user wants to revise the plan. The user said:'
      : 'The user approved the plan with these review comments:';
    return `${lead}\n${blocks.join('\n\n')}`;
  }

  function planReviewNode(item) {
    const local = planReviewState(item);
    const card = element('section', 'mobile-plan-review');
    card.dataset.reviewId = item.reviewId;
    card.dataset.state = local.status;
    const header = element('header', 'mobile-plan-review-header');
    const copy = element('span');
    copy.append(
      element('small', '', 'Plan review'),
      element('strong', '', 'Review plan.md'),
      element('p', '', 'Tap one line, then another to select a range and leave a comment.'),
    );
    const status = element('span', 'mobile-question-status', local.status === 'submitting' ? 'Sending…' : 'Pending');
    header.append(copy, status);

    const documentView = element('div', 'mobile-plan-document');
    documentView.setAttribute('role', 'listbox');
    documentView.setAttribute('aria-label', 'Plan lines');
    const lineButtons = [];
    let fenced = false;
    const lines = String(item.planContent || '').replace(/\r\n?/g, '\n').split('\n');
    for (const [index, source] of lines.entries()) {
      const lineNumber = index + 1;
      const kind = planLineKind(source, fenced);
      const line = element('button', 'mobile-plan-line');
      line.type = 'button';
      line.dataset.line = String(lineNumber);
      line.dataset.kind = kind;
      line.setAttribute('role', 'option');
      const displayed = kind === 'heading' ? source.replace(/^\s*#{1,6}\s+/, '') : source;
      line.append(element('span', 'mobile-plan-line-number', String(lineNumber)), element('span', 'mobile-plan-line-text', displayed || ' '));
      lineButtons.push(line);
      documentView.append(line);
      if (/^\s*```/.test(source)) fenced = !fenced;
    }

    const commentEditor = element('section', 'mobile-plan-comment-editor');
    commentEditor.hidden = !local.selection;
    const commentLabel = element('label', '', local.selection
      ? `Comment on line ${local.selection.start}${local.selection.end !== local.selection.start ? `–${local.selection.end}` : ''}`
      : 'Comment');
    const commentInput = element('textarea');
    commentInput.rows = 2;
    commentInput.placeholder = 'What should Grok change here?';
    commentInput.setAttribute('aria-label', commentLabel.textContent);
    commentInput.value = local.commentDraft;
    const commentActions = element('div', 'mobile-plan-comment-actions');
    const cancelComment = element('button', '', 'Clear selection');
    cancelComment.type = 'button';
    const saveComment = element('button', '', 'Add comment');
    saveComment.type = 'button';
    saveComment.disabled = true;
    commentActions.append(cancelComment, saveComment);
    commentEditor.append(commentLabel, commentInput, commentActions);

    const comments = element('div', 'mobile-plan-comments');
    const notes = element('textarea', 'mobile-plan-review-notes');
    notes.rows = 2;
    notes.placeholder = 'Additional feedback (optional)';
    notes.setAttribute('aria-label', 'Additional plan feedback');
    notes.value = local.note;
    const live = element('p', 'mobile-plan-review-live', local.error);
    live.setAttribute('aria-live', 'polite');
    const actions = element('div', 'mobile-plan-review-actions');
    const requestChanges = element('button', 'mobile-plan-request-changes');
    requestChanges.type = 'button';
    requestChanges.append(element('strong', '', 'Request changes'), element('small', '', 'Send comments and keep planning'));
    const approve = element('button', 'mobile-plan-approve');
    approve.type = 'button';
    approve.append(element('strong', '', 'Approve plan'), element('small', '', 'Leave Plan mode and start the work'));
    const quit = element('button', 'mobile-plan-abandon', 'Quit Plan mode');
    quit.type = 'button';
    actions.append(requestChanges, approve, quit);

    function paintSelection() {
      const selection = local.selection;
      for (const line of lineButtons) {
        const value = Number(line.dataset.line);
        const selected = Boolean(selection && value >= selection.start && value <= selection.end);
        line.setAttribute('aria-selected', String(selected));
      }
      commentEditor.hidden = !selection;
      if (selection) {
        commentLabel.textContent = `Comment on line ${selection.start}${selection.end !== selection.start ? `–${selection.end}` : ''}`;
        commentInput.setAttribute('aria-label', commentLabel.textContent);
      }
    }

    function paintComments() {
      comments.replaceChildren();
      for (const [index, comment] of local.comments.entries()) {
        const row = element('div', 'mobile-plan-comment');
        const label = comment.start === comment.end ? `Line ${comment.start}` : `Lines ${comment.start}–${comment.end}`;
        const remove = element('button', '', 'Remove');
        remove.type = 'button';
        remove.addEventListener('click', () => {
          local.comments.splice(index, 1);
          paintComments();
          updateActions();
        });
        row.append(element('small', '', label), element('p', '', comment.text), remove);
        comments.append(row);
      }
      comments.hidden = local.comments.length === 0;
    }

    function updateActions() {
      const busy = local.status === 'submitting';
      requestChanges.disabled = busy || (!local.comments.length && !notes.value.trim());
      approve.disabled = busy;
      quit.disabled = busy;
      for (const line of lineButtons) line.disabled = busy;
    }

    for (const line of lineButtons) line.addEventListener('click', () => {
      const value = Number(line.dataset.line);
      if (!local.selection || local.selection.start !== local.selection.end) {
        local.selection = { start: value, end: value };
      } else if (value === local.selection.start) {
        local.selection = undefined;
      } else {
        local.selection = {
          start: Math.min(local.selection.start, value),
          end: Math.max(local.selection.start, value),
        };
      }
      commentInput.value = '';
      local.commentDraft = '';
      saveComment.disabled = true;
      paintSelection();
      if (local.selection) commentInput.focus({ preventScroll: true });
    });
    commentInput.addEventListener('input', () => {
      local.commentDraft = commentInput.value;
      saveComment.disabled = !commentInput.value.trim();
    });
    cancelComment.addEventListener('click', () => {
      local.selection = undefined;
      commentInput.value = '';
      local.commentDraft = '';
      paintSelection();
    });
    saveComment.addEventListener('click', () => {
      if (!local.selection || !commentInput.value.trim()) return;
      local.comments.push({ ...local.selection, text: commentInput.value.trim() });
      local.selection = undefined;
      commentInput.value = '';
      local.commentDraft = '';
      paintSelection();
      paintComments();
      updateActions();
    });
    notes.addEventListener('input', () => { local.note = notes.value; updateActions(); });

    async function submit(outcome) {
      if (local.status === 'submitting') return;
      const feedback = planFeedback(local, outcome, notes.value);
      if (outcome === 'cancelled' && !feedback) return;
      local.status = 'submitting';
      local.error = '';
      card.dataset.state = 'submitting';
      status.textContent = 'Sending…';
      live.textContent = '';
      updateActions();
      try {
        await respondPlanReview(sessionName, item.threadId || threadId, item.reviewId, outcome, feedback);
      } catch (error) {
        local.status = 'failed';
        local.error = error.message || 'Could not send plan review. Try again.';
        card.dataset.state = 'failed';
        status.textContent = 'Try again';
        live.textContent = local.error;
        updateActions();
        void refresh();
      }
    }
    requestChanges.addEventListener('click', () => void submit('cancelled'));
    approve.addEventListener('click', () => void submit('approved'));
    quit.addEventListener('click', () => void submit('abandoned'));
    paintSelection();
    paintComments();
    updateActions();
    card.append(header, documentView, commentEditor, comments, notes, live, actions);
    return card;
  }

  function toolGroupNode(item) {
    let hasNewEditableTool = false;
    for (const tool of item.tools || []) {
      if (!['edit', 'write'].includes(tool.kind) || autoExpandedItems.has(tool.id)) continue;
      hasNewEditableTool = true;
      autoExpandedItems.add(tool.id);
      expandedItems.add(tool.id);
    }
    if (hasNewEditableTool) {
      autoExpandedItems.add(item.id);
      expandedItems.add(item.id);
    }
    const group = element('article', 'mobile-tool-group');
    group.dataset.eventId = item.id;
    group.dataset.state = item.status || 'completed';
    const toggle = element('button', 'mobile-tool-group-toggle');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', String(expandedItems.has(item.id)));
    toggle.append(
      element('i'),
      element('strong', '', item.title || `${item.tools?.length || 0} tools`),
      element('small', '', statusLabel(item.status)),
    );
    const panel = element('div', 'mobile-tool-group-panel');
    panel.dataset.streamScroll = 'tools';
    initializeDisclosure(toggle, panel, expandedItems.has(item.id));
    for (const tool of item.tools || []) {
      const displayTitle = tool.command
        ? `Ran ${tool.command}`
        : tool.subject && !tool.title?.includes(tool.subject)
          ? [tool.title, tool.subject].filter(Boolean).join(' ')
          : tool.title;
      const nested = eventNode({
        ...tool,
        title: displayTitle,
      });
      nested.__mobileItemSignature = JSON.stringify(tool);
      panel.append(nested);
    }
    toggle.addEventListener('click', (event) => {
      if (expandedItems.has(item.id)) expandedItems.delete(item.id);
      else expandedItems.add(item.id);
      const open = expandedItems.has(item.id);
      animateDisclosure(toggle, panel, open);
      if (event.detail !== 0) toggle.blur();
    });
    group.append(toggle, panel);
    return group;
  }

  function pendingInteraction(item) {
    if (item.type === 'permission') return item.status === 'pending';
    if (item.type === 'plan_review') return item.status === 'pending';
    return item.type === 'question' && ['calling', 'pending', 'working'].includes(item.status);
  }

  function attachmentNode(attachment, { removable = false } = {}) {
    const item = element('div', 'mobile-conversation-attachment');
    if (/^image\/(?:png|jpeg|webp|gif)$/.test(attachment.mimeType || '') && attachment.previewUrl) {
      const image = document.createElement('img');
      image.src = apiUrl(attachment.previewUrl);
      image.alt = attachment.name || 'Attached image';
      item.append(image);
    } else item.append(element('span', '', attachment.name?.split('.').pop()?.toUpperCase() || 'FILE'));
    item.append(element('small', '', attachment.name || 'Attachment'));
    if (removable) {
      const remove = element('button', '', '×');
      remove.type = 'button';
      remove.setAttribute('aria-label', `Remove ${attachment.name}`);
      remove.addEventListener('click', () => {
        attachments = attachments.filter((value) => value.id !== attachment.id);
        renderAttachmentTray();
        autoSizeInput();
      });
      item.append(remove);
    }
    return item;
  }

  function renderAttachmentTray() {
    attachmentTray.hidden = attachments.length === 0 && uploadingAttachments === 0;
    const fragment = document.createDocumentFragment();
    for (const attachment of attachments) fragment.append(attachmentNode(attachment, { removable: true }));
    if (uploadingAttachments) fragment.append(element('div', 'mobile-conversation-uploading', 'Uploading…'));
    attachmentTray.replaceChildren(fragment);
    attachButton.disabled = uploadingAttachments > 0 || attachments.length >= 8;
  }

  function reducedMotion() {
    return matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function initializeDisclosure(toggle, panel, open) {
    toggle.setAttribute('aria-expanded', String(open));
    panel.hidden = !open;
    panel.inert = !open;
    panel.setAttribute('aria-hidden', String(!open));
  }

  function motionDuration(panel, token, fallback) {
    const value = getComputedStyle(panel).getPropertyValue(token).trim();
    if (value.endsWith('ms')) return Number.parseFloat(value) || fallback;
    if (value.endsWith('s')) return (Number.parseFloat(value) * 1_000) || fallback;
    return fallback;
  }

  function animateDisclosure(toggle, panel, open) {
    toggle.setAttribute('aria-expanded', String(open));
    panel.setAttribute('aria-hidden', String(!open));
    panel.inert = !open;
    const active = disclosureMotions.get(panel);
    const currentHeight = panel.hidden ? 0 : panel.getBoundingClientRect().height;
    const currentOpacity = panel.hidden ? 0 : Number.parseFloat(getComputedStyle(panel).opacity) || 1;
    active?.animation.cancel();

    if (open) panel.hidden = false;
    if (reducedMotion() || typeof panel.animate !== 'function') {
      panel.hidden = !open;
      panel.removeAttribute('data-disclosure-motion');
      disclosureMotions.delete(panel);
      return;
    }

    const targetHeight = open ? panel.getBoundingClientRect().height : 0;
    const targetOpacity = open ? 1 : 0;
    panel.dataset.disclosureMotion = open ? 'opening' : 'closing';
    const style = getComputedStyle(panel);
    const animation = panel.animate([
      { height: `${currentHeight}px`, opacity: currentOpacity, transform: open ? 'translateY(-3px)' : 'translateY(0)' },
      { height: `${targetHeight}px`, opacity: targetOpacity, transform: open ? 'translateY(0)' : 'translateY(-3px)' },
    ], {
      duration: motionDuration(panel, '--duration-normal', 220),
      easing: style.getPropertyValue('--ease-out').trim() || 'cubic-bezier(.2, .8, .2, 1)',
      fill: 'both',
    });
    const motion = { animation, open };
    disclosureMotions.set(panel, motion);
    animation.finished.then(() => {
      if (disclosureMotions.get(panel) !== motion) return;
      if (!open) panel.hidden = true;
      panel.removeAttribute('data-disclosure-motion');
      disclosureMotions.delete(panel);
      animation.cancel();
    }).catch(() => {});
  }

  function queueRows() {
    return [...queue.querySelectorAll('.mobile-conversation-queue-item')];
  }

  function queueOrder() {
    return queueRows().map((row) => row.dataset.queueId);
  }

  function queuePositions() {
    return new Map(queueRows().map((row) => [row.dataset.queueId, row.getBoundingClientRect().top]));
  }

  function animateQueuePositions(previous) {
    if (reducedMotion()) return;
    for (const row of queueRows()) {
      const top = previous.get(row.dataset.queueId);
      if (top === undefined) continue;
      const delta = top - row.getBoundingClientRect().top;
      if (Math.abs(delta) < 1) continue;
      row.animate([
        { transform: `translateY(${delta}px)` },
        { transform: 'translateY(0)' },
      ], { duration: 220, easing: 'cubic-bezier(.2,.8,.2,1)' });
    }
  }

  function applyQueueOrder(queueIds) {
    const previous = queuePositions();
    const rows = new Map(queueRows().map((row) => [row.dataset.queueId, row]));
    for (const id of queueIds) {
      const row = rows.get(id);
      if (row) queue.append(row);
    }
    animateQueuePositions(previous);
  }

  async function persistQueueOrder(previousOrder) {
    const nextOrder = queueOrder();
    if (nextOrder.join('\0') === previousOrder.join('\0')) return;
    queueMutationPending = true;
    queue.dataset.busy = 'true';
    try {
      await reorderQueuedInputs(sessionName, nextOrder);
    } catch (error) {
      applyQueueOrder(previousOrder);
      state.textContent = error.message || 'Reorder failed';
      state.dataset.state = 'error';
    } finally {
      queueMutationPending = false;
      queue.dataset.busy = 'false';
    }
  }

  function setupQueueReorder(row, handle) {
    let pointerId;
    let previousOrder;

    const move = (event) => {
      if (event.pointerId !== pointerId) return;
      const previous = queuePositions();
      const peers = queueRows().filter((candidate) => candidate !== row);
      const next = peers.find((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return event.clientY < rect.top + rect.height / 2;
      });
      if (next) queue.insertBefore(row, next);
      else queue.append(row);
      animateQueuePositions(previous);
      event.preventDefault();
    };
    const finish = (event) => {
      if (event.pointerId !== pointerId) return;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      pointerId = undefined;
      row.classList.remove('is-dragging');
      void persistQueueOrder(previousOrder);
    };
    handle.addEventListener('pointerdown', (event) => {
      if (queueMutationPending || handle.disabled || event.button > 0) return;
      pointerId = event.pointerId;
      previousOrder = queueOrder();
      row.classList.add('is-dragging');
      window.addEventListener('pointermove', move, { passive: false });
      window.addEventListener('pointerup', finish);
      window.addEventListener('pointercancel', finish);
      event.preventDefault();
    });
    handle.addEventListener('keydown', (event) => {
      if (queueMutationPending || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
      const rows = queueRows();
      const index = rows.indexOf(row);
      const destination = event.key === 'ArrowUp' ? index - 1 : index + 1;
      if (destination < 0 || destination >= rows.length) return;
      const previous = queueOrder();
      const next = previous.slice();
      [next[index], next[destination]] = [next[destination], next[index]];
      applyQueueOrder(next);
      handle.focus();
      void persistQueueOrder(previous);
      event.preventDefault();
    });
  }

  function schedulePendingAcceptanceFailure(pendingText) {
    clearTimeout(pendingAcceptanceTimer);
    pendingAcceptanceTimer = setTimeout(() => {
      if (pendingMessage?.text !== pendingText || pendingMessage.status !== 'accepted') return;
      pendingMessage.status = 'failed';
      renderedSignature = '';
      if (lastConversation) render(lastConversation);
      state.textContent = 'Grok did not receive the message';
      state.dataset.state = 'error';
    }, 10_000);
  }

  async function runQueueAction(row, action, fallback, { onSuccess } = {}) {
    if (queueMutationPending) return;
    queueMutationPending = true;
    queue.dataset.busy = 'true';
    for (const button of row.querySelectorAll('button')) button.disabled = true;
    row.classList.add('is-leaving');
    let exitAnimation;
    if (!reducedMotion()) {
      exitAnimation = row.animate([
        { opacity: 1, transform: 'translateX(0) scale(1)' },
        { opacity: 0, transform: 'translateX(18px) scale(.98)' },
      ], { duration: 160, easing: 'ease-in', fill: 'forwards' });
      await exitAnimation.finished.catch(() => {});
    }
    try {
      const result = await action();
      row.remove();
      const remaining = queueRows().length;
      if (!remaining) queue.hidden = true;
      onSuccess?.(result);
    } catch (error) {
      exitAnimation?.cancel();
      row.classList.remove('is-leaving');
      for (const button of row.querySelectorAll('button')) button.disabled = false;
      state.textContent = error.message || fallback;
      state.dataset.state = 'error';
    } finally {
      queueMutationPending = false;
      queue.dataset.busy = 'false';
    }
  }

  function renderQueue(conversation) {
    const entries = Array.isArray(conversation.queue) ? conversation.queue : [];
    const nextSignature = `${sessionName}:${JSON.stringify(entries)}`;
    if (nextSignature === queueRenderSignature) return;
    queueRenderSignature = nextSignature;
    queue.hidden = entries.length === 0;
    if (!entries.length) {
      queue.replaceChildren();
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const entry of entries) {
      const row = element('article', 'mobile-conversation-queue-item');
      row.dataset.queueId = entry.id;
      row.append(element('span', 'mobile-conversation-queue-icon', '↳'));
      const handle = element('button', 'mobile-conversation-queue-handle', '⋯');
      handle.type = 'button';
      handle.disabled = entries.length < 2;
      handle.setAttribute('aria-label', `Reorder queued message: ${entry.text}`);
      handle.title = 'Drag to reorder';
      setupQueueReorder(row, handle);
      const copy = element('div', 'mobile-conversation-queue-copy');
      copy.append(element('p', '', entry.text));
      const attachmentCount = entry.attachments?.length || 0;
      if (attachmentCount) copy.append(element('small', '', `+${attachmentCount} file${attachmentCount === 1 ? '' : 's'}`));
      const actions = element('div', 'mobile-conversation-queue-actions');
      const steer = element('button', '', '↪ Steer');
      steer.type = 'button';
      steer.addEventListener('click', () => runQueueAction(
        row, () => steerQueuedInput(sessionName, entry.id), 'Steer failed',
        { onSuccess: () => {
          const pendingText = entry.text || 'Queued message';
          pendingMessage = {
            text: pendingText, attachments: [], fileMentions: [],
            sentAt: Date.now(), status: 'accepted', source: 'steer', queueId: entry.id,
          };
          schedulePendingAcceptanceFailure(pendingText);
          followStreamTail = true;
          renderedSignature = '';
          if (lastConversation) render(lastConversation);
          snapMessagesToLatest();
          void refresh();
        } },
      ));
      const remove = element('button', 'mobile-conversation-queue-delete', '⌫');
      remove.type = 'button';
      remove.setAttribute('aria-label', 'Delete queued message');
      remove.addEventListener('click', () => runQueueAction(
        row, () => removeQueuedInput(sessionName, entry.id), 'Delete failed',
      ));
      actions.append(steer, remove);
      row.append(copy, actions, handle);
      fragment.append(row);
    }
    queue.replaceChildren(fragment);
  }

  function renderInteraction(conversation, isRoot) {
    if (!isRoot) return;
    const interaction = conversation.capabilities.send
      ? [...(conversation.items || [])].reverse().find(pendingInteraction)
      : undefined;
    if (!interaction) {
      root.dataset.interaction = 'false';
      interactionMotionKey = '';
      interactionDock.removeAttribute('data-motion');
      interactionDock.hidden = true;
      interactionDock.removeAttribute('data-kind');
      interactionDock.replaceChildren();
      composer.hidden = !conversation.capabilities.send;
      if (composer.hidden) closeModelList();
      return;
    }
    closeAllLists();
    const questionStep = interaction.type === 'question'
      ? pendingQuestions.get(interaction.questionId)?.step || 0
      : 0;
    const nextMotionKey = `${interaction.type}:${interaction.questionId || interaction.permissionId || interaction.reviewId}:${questionStep}`;
    const motion = interactionMotionKey !== nextMotionKey;
    interactionMotionKey = nextMotionKey;
    root.dataset.interaction = 'true';
    composer.hidden = true;
    interactionDock.hidden = false;
    if (motion) {
      interactionDock.dataset.motion = 'enter';
      interactionDock.addEventListener('animationend', () => {
        if (interactionMotionKey === nextMotionKey) interactionDock.dataset.motion = 'stable';
      }, { once: true });
    }
    interactionDock.dataset.kind = interaction.type;
    interactionDock.replaceChildren(interaction.type === 'question'
      ? questionNode(interaction, { docked: true })
      : interaction.type === 'plan_review' ? planReviewNode(interaction)
        : permissionDockNode(interaction));
  }

  function messageNode(item, conversation, { suppressPendingInteractions = false } = {}) {
    if (item.type === 'message') {
      const article = element('article', `mobile-message mobile-message-${item.role}`);
      article.dataset.messageId = item.id;
      if (item.role === 'user') {
        const author = item.pendingStatus === 'sending' ? 'Sending…'
          : item.pendingStatus === 'accepted' ? 'Waiting for Grok…' : 'You';
        article.append(
          element('span', 'mobile-message-author', author),
          element('div', 'mobile-message-content', item.text),
        );
      } else {
        const streaming = streamingAssistant(conversation)?.id === item.id;
        if (streaming) {
          const content = markdownNode(item.text, {
            onFileReference: (reference) => void openFileReference(reference),
          });
          content.dataset.streaming = 'true';
          content.__mobileRawText = item.text;
          article.dataset.streaming = 'true';
          article.append(content);
        } else {
          article.append(markdownNode(item.text, {
            onFileReference: (reference) => void openFileReference(reference),
          }));
        }
      }
      return article;
    }
    if (item.type === 'tool_group') return toolGroupNode(item);
    if (suppressPendingInteractions && pendingInteraction(item)) return document.createDocumentFragment();
    if (['question', 'permission', 'plan_review'].includes(item.type)) return document.createDocumentFragment();
    if (item.type === 'plan') return document.createDocumentFragment();
    if (item.type === 'turn' || item.type === 'recap') return document.createDocumentFragment();
    if (item.type === 'subagent') return document.createDocumentFragment();
    return eventNode(item);
  }

  function timelineNodeKey(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return undefined;
    if (node.matches('.mobile-tool-group')) return `group:${node.dataset.eventId}`;
    if (node.matches('.mobile-event-card')) return `event:${node.dataset.eventId}`;
    if (node.matches('.mobile-message')) {
      return node.dataset.pending ? undefined : `message:${node.dataset.messageId}`;
    }
    if (node.matches('.mobile-question-card')) return `question:${node.dataset.questionId}`;
    if (node.matches('.mobile-conversation-loading')) return 'loading';
    return undefined;
  }

  function syncAttributes(current, fresh) {
    const disclosureMoving = current.hasAttribute('data-disclosure-motion');
    const preserve = disclosureMoving
      ? new Set(['hidden', 'inert', 'aria-hidden', 'data-disclosure-motion'])
      : undefined;
    for (const attribute of [...current.attributes]) {
      if (preserve?.has(attribute.name)) continue;
      if (!fresh.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
    }
    for (const attribute of [...fresh.attributes]) {
      if (preserve?.has(attribute.name)) continue;
      if (current.getAttribute(attribute.name) !== attribute.value) {
        current.setAttribute(attribute.name, attribute.value);
      }
    }
  }

  function syncEventCard(current, fresh) {
    syncAttributes(current, fresh);
    const currentToggle = current.querySelector(':scope > .mobile-event-toggle');
    const freshToggle = fresh.querySelector(':scope > .mobile-event-toggle');
    const currentPanel = current.querySelector(':scope > .mobile-event-panel');
    const freshPanel = fresh.querySelector(':scope > .mobile-event-panel');
    if (!currentToggle || !freshToggle || !currentPanel || !freshPanel) {
      current.replaceChildren(...fresh.childNodes);
      return current;
    }
    const freshExtras = [...fresh.children].filter((child) => child !== freshToggle && child !== freshPanel);
    syncAttributes(currentToggle, freshToggle);
    currentToggle.replaceChildren(...freshToggle.childNodes);
    syncAttributes(currentPanel, freshPanel);
    currentPanel.replaceChildren(...freshPanel.childNodes);
    for (const child of [...current.children]) {
      if (child !== currentToggle && child !== currentPanel) child.remove();
    }
    for (const child of freshExtras) current.append(child);
    return current;
  }

  function reconcileTimeline(container, freshNodes) {
    const currentByKey = new Map();
    for (const node of [...container.children]) {
      const key = timelineNodeKey(node);
      if (key) currentByKey.set(key, node);
    }
    const kept = new Set();
    let cursor = container.firstChild;
    for (const fresh of freshNodes) {
      const key = timelineNodeKey(fresh);
      const current = key ? currentByKey.get(key) : undefined;
      let node = fresh;
      if (current && fresh.__mobileItemSignature !== undefined &&
          current.__mobileItemSignature === fresh.__mobileItemSignature) {
        // Most streamed snapshots only append text or update the newest tool.
        // Keep all older nodes completely untouched so active taps, nested
        // scroll positions, and compositor layers cannot be interrupted.
        node = current;
      } else if (current && current.matches('.mobile-tool-group') && fresh.matches('.mobile-tool-group')) {
        syncAttributes(current, fresh);
        const currentToggle = current.querySelector(':scope > .mobile-tool-group-toggle');
        const freshToggle = fresh.querySelector(':scope > .mobile-tool-group-toggle');
        const currentPanel = current.querySelector(':scope > .mobile-tool-group-panel');
        const freshPanel = fresh.querySelector(':scope > .mobile-tool-group-panel');
        if (currentToggle && freshToggle && currentPanel && freshPanel) {
          syncAttributes(currentToggle, freshToggle);
          if (currentToggle.textContent !== freshToggle.textContent) {
            currentToggle.replaceChildren(...freshToggle.childNodes);
          }
          syncAttributes(currentPanel, freshPanel);
          reconcileTimeline(currentPanel, [...freshPanel.children]);
          node = current;
        }
      } else if (current && current.matches('.mobile-event-card') && fresh.matches('.mobile-event-card')) {
        node = syncEventCard(current, fresh);
      } else if (current && current.matches('.mobile-message') && fresh.matches('.mobile-message')) {
        syncAttributes(current, fresh);
        const currentContent = current.querySelector(':scope > .mobile-message-content[data-streaming="true"]');
        const freshContent = fresh.querySelector(':scope > .mobile-message-content[data-streaming="true"]');
        const previousText = currentContent?.__mobileRawText;
        const nextText = freshContent?.__mobileRawText;
        if (currentContent && freshContent && typeof previousText === 'string' &&
            typeof nextText === 'string' && nextText.startsWith(previousText)) {
          appendStreamingMarkdown(currentContent, nextText);
        } else {
          current.replaceChildren(...fresh.childNodes);
        }
        node = current;
      }
      if (node === current) node.__mobileItemSignature = fresh.__mobileItemSignature;
      kept.add(node);
      if (node === cursor) cursor = cursor.nextSibling;
      else container.insertBefore(node, cursor);
    }
    for (const child of [...container.childNodes]) {
      if (!kept.has(child)) child.remove();
    }
  }

  function render(conversation, { animate = false, fromStream = false } = {}) {
    const previousConversation = lastConversation;
    lastConversation = conversation;
    const initialThreadRender = !previousConversation ||
      previousConversation.thread?.id !== conversation.thread.id;
    const isRoot = !conversation.parent && conversation.thread.id === rootThreadId;
    if (isRoot) rootConversation = conversation;
    const targetMessages = isRoot ? messages : sheetMessages || messages;
    // Follow new output only while the reader is actually at the bottom. A
    // generous "near bottom" threshold makes short mobile histories snap back
    // down on every streamed update and effectively prevents scrolling.
    const atBottom = distanceFromBottom(targetMessages) <= 48;
    const shouldFollowTail = isRoot ? followStreamTail : atBottom;
    const hadPendingMessage = Boolean(pendingMessage);
    const streamScroll = captureStreamScroll(targetMessages);
    const signature = JSON.stringify({
      thread: conversation.thread,
      activity: conversation.activity,
      items: conversation.items,
      children: conversation.children,
      controls: conversation.controls,
      context: conversation.context,
      queue: conversation.queue,
      pending: pendingMessage,
      attachments,
      uploadingAttachments,
      questions: questionStateVersion,
      planReviews: [...pendingPlanReviews.entries()],
      cancellingTurn,
    });
    if (signature === renderedSignature) return;
    renderedSignature = signature;
    if (isRoot) {
      title.textContent = conversation.thread.title;
      meta.textContent = [conversation.thread.agentName, conversation.thread.model].filter(Boolean).join(' · ');
      state.textContent = statusLabel(conversation.thread.status);
      state.dataset.state = conversation.thread.status;
      onStatusChange(sessionName, conversation.thread.status);
      renderModelControls(conversation);
      renderChoiceControls(conversation);
      renderQueue(conversation);
    } else if (sheet) {
      renderChildSheetHeader(conversation);
    }
    parentId = conversation.parent?.id;
    back.hidden = true;
    renderInteraction(conversation, isRoot);
    input.placeholder = `Message ${conversation.provider.label}…`;

    const previousItemIds = new Set((previousConversation?.items || []).map((item) => item.id));
    const fragment = document.createDocumentFragment();
    for (const item of conversation.items) {
      const node = messageNode(item, conversation, { suppressPendingInteractions: isRoot });
      if (node.nodeType === Node.ELEMENT_NODE) {
        node.__mobileItemSignature = JSON.stringify(item);
        if (animate && !previousItemIds.has(item.id)) node.classList.add('mobile-conversation-enter');
      }
      fragment.append(node);
    }
    if (isRoot) renderSubagentPill(conversation);
    const pendingAlreadyStored = pendingMessage && conversation.items.some(
      (item) => item.type === 'message' && item.role === 'user' &&
        (pendingMessage.text ? item.text.includes(pendingMessage.text) :
          pendingMessage.attachments?.every((attachment) => item.text.includes(attachment.name))),
    );
    const completedAfterPendingTurn = pendingMessage?.status === 'accepted' &&
      previousConversation?.activity?.active === true && conversation.activity?.active !== true;
    if (pendingAlreadyStored || completedAfterPendingTurn) {
      clearTimeout(pendingAcceptanceTimer);
      pendingMessage = undefined;
      pendingQuestions.clear();
      pendingPlanReviews.clear();
    }
    if (pendingMessage) {
      const pending = messageNode({
        id: 'pending', type: 'message', role: 'user', text: pendingMessage.text,
        pendingStatus: pendingMessage.status,
      }, conversation);
      pending.dataset.pending = 'true';
      if (pendingMessage.status === 'failed') {
        pending.querySelector('.mobile-message-author').textContent = 'Not received · tap to retry';
        pending.addEventListener('click', () => {
          input.value = pendingMessage.text || '';
          attachments = pendingMessage.attachments?.slice() || [];
          mentionedFiles.clear();
          for (const path of pendingMessage.fileMentions || []) mentionedFiles.add(path);
          pendingMessage = undefined;
          renderAttachmentTray();
          autoSizeInput();
          renderedSignature = '';
          render(conversation);
          input.focus({ preventScroll: true });
        });
      }
      fragment.append(pending);
    }
    if (!fragment.childNodes.length) fragment.append(element('div', 'mobile-conversation-loading', 'No messages yet'));
    reconcileTimeline(targetMessages, [...fragment.childNodes]);
    restoreStreamScroll(targetMessages, streamScroll);
    if (initialThreadRender || shouldFollowTail || hadPendingMessage) {
      targetMessages.scrollTop = targetMessages.scrollHeight;
    }
    if (isRoot) updateJumpToLatest();
    if (isRoot) updateComposerAction();
    if (isRoot && !sheet?.hidden) {
      if (sheetMode === 'list') renderSubagentList(conversation);
      else if (sheetMode === 'plan') renderPlanSheet(conversation);
    }
  }

  async function refresh() {
    const currentGeneration = generation;
    if (!media.matches || !sessionName) return setAvailable(false);
    const query = threadId ? `?thread=${encodeURIComponent(threadId)}` : '';
    try {
      const payload = await api(`/api/conversations/${encodeURIComponent(sessionName)}${query}`);
      if (currentGeneration !== generation) return;
      const conversation = payload.conversation;
      providerId = conversation.provider.id;
      threadId = conversation.thread.id;
      if (!rootThreadId && !conversation.parent) rootThreadId = conversation.thread.id;
      setAvailable(true);
      render(conversation);
      // Keep the opaque startup surface in place until the first complete
      // conversation snapshot has been committed. Removing it afterwards
      // makes the transition atomic, with no Connecting/Reconnecting frame.
      setBooting(false);
      startStream();
    } catch (error) {
      if (currentGeneration !== generation) return;
      if (error.code === 'CONVERSATION_UNAVAILABLE') {
        threadId = undefined;
        if (expectedConversation) {
          // A managed Grok chat can briefly exist before its ACP provider is
          // discoverable. Retain the same opaque surface and retry instead of
          // falling through to a one-frame terminal/Connecting flash.
          setBooting(true);
          setAvailable(true);
          schedule(600);
        } else {
          setBooting(false);
          setAvailable(false);
        }
      } else if (available) {
        state.textContent = 'Reconnecting';
        state.dataset.state = 'working';
        // A freshly spawned subagent can be announced before its summary and
        // update files are atomically visible. Keep opening it until the
        // provider graph includes the child instead of leaving a dead screen.
        schedule(1_000);
      }
    }
  }

  function autoSizeInput() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 132)}px`;
    updateComposerAction();
  }

  function updateComposerAction() {
    // The provider lifecycle is the only authority for whether a turn can be
    // stopped. A locally accepted message is only a delivery receipt: treating
    // it as a running turn leaves the composer on Stop forever when a replay
    // omits or normalizes the matching user message.
    const pendingDelivery = pendingMessage?.status === 'sending';
    const turnActive = lastConversation?.activity?.active === true;
    if (!turnActive) cancellingTurn = false;
    const hasDraft = Boolean(input.value.trim() || attachments.length);
    const stopAction = turnActive && !hasDraft;
    const statusText = cancellingTurn
      ? 'Stopping…'
      : lastConversation?.activity?.label || (pendingDelivery ? 'Sending…' : '');
    activity.hidden = !turnActive && !pendingDelivery;
    activity.dataset.phase = cancellingTurn
      ? 'stopping'
      : lastConversation?.activity?.phase || (pendingDelivery ? 'sending' : 'waiting');
    activityLabel.textContent = statusText;
    sendButton.dataset.action = stopAction ? 'stop' : 'send';
    sendButton.textContent = stopAction ? '■' : '↑';
    sendButton.setAttribute('aria-label', stopAction ? 'Stop response' : 'Send message');
    sendButton.disabled = uploadingAttachments > 0 || (stopAction ? cancellingTurn : !hasDraft);
  }

  composer.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (sendButton.dataset.action === 'stop') {
      if (!sessionName || cancellingTurn) return;
      cancellingTurn = true;
      updateComposerAction();
      try {
        const result = await cancelTurn(sessionName);
        if (result?.accepted === false) cancellingTurn = false;
        void refresh();
      } catch (error) {
        cancellingTurn = false;
        state.textContent = error.message || 'Stop failed';
        state.dataset.state = 'error';
      } finally {
        updateComposerAction();
      }
      return;
    }
    const text = input.value.trim();
    if ((!text && attachments.length === 0) || !sessionName || !providerId || uploadingAttachments) return;
    const sentAttachments = attachments.slice();
    const sentFileMentions = [...mentionedFiles].filter((path) => text.includes(`@${path}`));
    const pendingText = text || sentAttachments.map((attachment) => attachment.name).join(', ');
    pendingMessage = {
      text: pendingText, attachments: sentAttachments, fileMentions: sentFileMentions,
      sentAt: Date.now(), status: 'sending',
    };
    followStreamTail = true;
    input.value = '';
    attachments = [];
    mentionedFiles.clear();
    closeSuggestions();
    renderAttachmentTray();
    autoSizeInput();
    renderedSignature = '';
    if (lastConversation) render(lastConversation);
    snapMessagesToLatest();
    try {
      const result = await send(
        sessionName, text, sentAttachments.map((attachment) => attachment.id), sentFileMentions,
      );
      if (result?.queued) {
        pendingMessage = undefined;
        clearTimeout(pendingAcceptanceTimer);
      } else {
        if (pendingMessage?.text === pendingText) pendingMessage.status = 'accepted';
        schedulePendingAcceptanceFailure(pendingText);
        // Replace the previous turn socket after prompt acceptance. The
        // snapshot fetched below recovers chunks Grok emitted between the POST
        // and the new websocket becoming ready.
        closeStream();
        // Open the new turn transport immediately; do not make first-token
        // delivery wait for the recovery snapshot HTTP round trip.
        startStream();
      }
      state.textContent = 'Queued';
      state.dataset.state = 'working';
      renderedSignature = '';
      if (lastConversation) render(lastConversation);
      void refresh();
    } catch (error) {
      pendingMessage = undefined;
      attachments = [];
      uploadingAttachments = 0;
      renderAttachmentTray();
      pendingQuestions.clear();
      pendingPlanReviews.clear();
      input.value = text;
      attachments = sentAttachments;
      for (const path of sentFileMentions) mentionedFiles.add(path);
      renderAttachmentTray();
      autoSizeInput();
      renderedSignature = '';
      if (lastConversation) render(lastConversation);
      state.textContent = error.message || 'Send failed';
      state.dataset.state = 'error';
    } finally {
      input.focus({ preventScroll: true });
    }
  });
  const focusComposerWithoutViewportScroll = () => {
    if (document.activeElement === input) return;
    // Safari otherwise performs its own layout-viewport scroll before the
    // keyboard's visualViewport resize arrives, producing a large blank jump.
    // Focusing during the initiating gesture keeps the keyboard user-activated
    // while preventScroll makes the first painted frame use our viewport root.
    input.focus({ preventScroll: true });
  };
  input.addEventListener('pointerdown', focusComposerWithoutViewportScroll, { capture: true });
  input.addEventListener('touchstart', focusComposerWithoutViewportScroll, { capture: true, passive: true });
  input.addEventListener('input', () => {
    autoSizeInput();
    updateSuggestions();
  });
  input.addEventListener('click', updateSuggestions);
  attachButton.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const files = [...fileInput.files].slice(0, Math.max(0, 8 - attachments.length));
    fileInput.value = '';
    if (!files.length || !sessionName) return;
    uploadingAttachments += files.length;
    renderAttachmentTray();
    autoSizeInput();
    for (const file of files) {
      try {
        if (file.size > 20 * 1024 * 1024) throw new Error(`${file.name} is larger than 20 MB`);
        attachments.push(await uploadAttachment(sessionName, file));
      } catch (error) {
        state.textContent = error.message || 'Upload failed';
        state.dataset.state = 'error';
      } finally {
        uploadingAttachments -= 1;
        renderAttachmentTray();
        autoSizeInput();
      }
    }
  });
  modelButton.addEventListener('click', () => {
    if (modelButton.disabled) return;
    const opening = modelList.hidden;
    closeAuxiliaryLists();
    closeSuggestions();
    if (opening && lastConversation?.controls?.model) paintModelOptions(lastConversation.controls.model);
    modelList.hidden = !opening;
    modelButton.setAttribute('aria-expanded', String(opening));
    if (opening) modelList.querySelector('[aria-selected="true"]')?.focus({ preventScroll: true });
  });
  function toggleAuxiliaryList(button, list) {
    if (button.disabled) return;
    const opening = list.hidden;
    closeAllLists();
    list.hidden = !opening;
    button.setAttribute('aria-expanded', String(opening));
    if (opening) list.querySelector('[aria-selected="true"]')?.focus({ preventScroll: true });
  }
  modeButton.addEventListener('click', () => toggleAuxiliaryList(modeButton, modeList));
  menu.addEventListener('click', () => document.querySelector('#open-sidebar')?.click());
  modelList.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    closeModelList({ focus: true });
  });
  document.addEventListener('pointerdown', dismissModelList);
  document.addEventListener('pointerdown', (event) => {
    if (modeList.contains(event.target) || modeButton.contains(event.target)) return;
    closeAuxiliaryLists();
  });
  document.addEventListener('pointerdown', (event) => {
    if (suggestions.contains(event.target) || input.contains(event.target)) return;
    closeSuggestions();
  });
  input.addEventListener('keydown', (event) => {
    if (!suggestions.hidden && suggestionItems.length) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const direction = event.key === 'ArrowDown' ? 1 : -1;
        suggestionIndex = (suggestionIndex + direction + suggestionItems.length) % suggestionItems.length;
        paintSuggestions();
        return;
      }
      if ((event.key === 'Enter' && !event.isComposing) || event.key === 'Tab') {
        event.preventDefault();
        acceptSuggestion();
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        closeSuggestions();
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing &&
        matchMedia('(hover: hover) and (pointer: fine)').matches) {
      event.preventDefault();
      composer.requestSubmit();
    }
  });
  input.addEventListener('keyup', (event) => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) updateSuggestions();
  });
  messages.addEventListener('scroll', () => {
    followStreamTail = distanceFromBottom(messages) <= 48;
    updateJumpToLatest();
  }, { passive: true });
  jumpToLatest.addEventListener('click', () => {
    followStreamTail = true;
    messages.scrollTo({
      top: messages.scrollHeight,
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    });
  });
  back.addEventListener('click', () => {
    if (!parentId) return;
    closeStream();
    threadId = parentId;
    renderedSignature = '';
    messages.replaceChildren(element('div', 'mobile-conversation-loading', 'Back to parent…'));
    void refresh();
  });
  media.addEventListener('change', () => {
    generation += 1;
    closeStream();
    closeFileSheet();
    closeAllLists();
    mentionedFiles.clear();
    threadId = undefined;
    renderedSignature = '';
    if (media.matches && sessionName) {
      setBooting(true);
      messages.replaceChildren(element('div', 'mobile-conversation-loading', 'Preparing chat…'));
      setAvailable(true);
      void refresh();
    } else {
      setBooting(false);
      setAvailable(false);
    }
  });
  document.addEventListener('visibilitychange', handleVisibilityChange);
  window.addEventListener('pagehide', suspendForBackground);
  window.addEventListener('pageshow', handlePageShow);
  window.addEventListener('blur', suspendForBackground);
  window.addEventListener('focus', handleWindowFocus);
  window.addEventListener('online', handleOnline);
  autoSizeInput();

  return {
    showPending(nextSessionName) {
      if (!media.matches || !nextSessionName) return setAvailable(false);
      if (sessionName === nextSessionName && available) return;
      generation += 1;
      clearTimeout(refreshTimer);
      clearTimeout(foregroundResumeTimer);
      foregroundResumeTimer = undefined;
      backgrounded = document.visibilityState === 'hidden';
      closeStream();
      closeFileSheet();
      sessionName = nextSessionName;
      expandedItems.clear();
      autoExpandedItems.clear();
      expectedConversation = true;
      threadId = undefined;
      rootThreadId = undefined;
      rootConversation = undefined;
      followStreamTail = true;
      browserAvailable = false;
      pillDismissed = false;
      dismissedPlanRevision = loadDismissedPlanRevision(nextSessionName);
      clearSubagentPill();
      parentId = undefined;
      providerId = undefined;
      pendingMessage = undefined;
      cancellingTurn = false;
      interactionMotionKey = '';
      pendingPlanReviews.clear();
      attachments = [];
      mentionedFiles.clear();
      uploadingAttachments = 0;
      renderAttachmentTray();
      lastConversation = undefined;
      renderedSignature = '';
      modelOptionsSignature = '';
      closeAllLists();
      title.textContent = 'New Grok chat';
      meta.textContent = 'Starting ACP session';
      state.textContent = 'Connecting';
      state.dataset.state = 'working';
      setBooting(true);
      composer.hidden = false;
      context.hidden = true;
      activity.hidden = true;
      modelButton.hidden = true;
      modeButton.hidden = true;
      queue.hidden = true;
      queue.replaceChildren();
      interactionDock.hidden = true;
      root.dataset.interaction = 'false';
      interactionDock.replaceChildren();
      back.hidden = true;
      jumpToLatest.hidden = true;
      messages.replaceChildren(element('div', 'mobile-conversation-loading', 'Preparing chat…'));
      setAvailable(true);
    },
    select(nextSessionName, { expected = false } = {}) {
      expectedConversation = Boolean(expected);
      if (sessionName === (nextSessionName || undefined)) return;
      generation += 1;
      clearTimeout(refreshTimer);
      clearTimeout(foregroundResumeTimer);
      foregroundResumeTimer = undefined;
      backgrounded = document.visibilityState === 'hidden';
      closeStream();
      closeFileSheet();
      sessionName = nextSessionName || undefined;
      expandedItems.clear();
      autoExpandedItems.clear();
      threadId = undefined;
      rootThreadId = undefined;
      rootConversation = undefined;
      followStreamTail = true;
      browserAvailable = false;
      pillDismissed = false;
      dismissedPlanRevision = loadDismissedPlanRevision(sessionName);
      clearSubagentPill();
      parentId = undefined;
      providerId = undefined;
      pendingMessage = undefined;
      cancellingTurn = false;
      interactionMotionKey = '';
      pendingPlanReviews.clear();
      attachments = [];
      mentionedFiles.clear();
      uploadingAttachments = 0;
      renderAttachmentTray();
      clearTimeout(pendingAcceptanceTimer);
      clearTimeout(suggestionTimer);
      lastConversation = undefined;
      renderedSignature = '';
      modelOptionsSignature = '';
      closeAllLists();
      interactionDock.hidden = true;
      root.dataset.interaction = 'false';
      interactionDock.replaceChildren();
      composer.hidden = false;
      context.hidden = true;
      activity.hidden = true;
      modelButton.hidden = true;
      modeButton.hidden = true;
      queue.hidden = true;
      queue.replaceChildren();
      if (!sessionName || !media.matches) {
        setBooting(false);
        return setAvailable(false);
      }
      setBooting(true);
      jumpToLatest.hidden = true;
      messages.replaceChildren(element('div', 'mobile-conversation-loading', 'Preparing chat…'));
      // Claim the mobile surface while provider detection is in flight. This
      // prevents the terminal transport from briefly attaching (and resizing)
      // the shared tmux pane before native history is ready.
      setAvailable(true);
      void refresh();
    },
    isVisibleFor(name) {
      return available && media.matches && name === sessionName;
    },
    setBrowserAvailable(name, next) {
      if (name !== sessionName) return;
      browserAvailable = Boolean(next);
      if (sheetBrowser) sheetBrowser.hidden = !browserAvailable;
      renderSubagentPill(rootConversation || { items: [] });
    },
    openSubagents() {
      if (subagents(rootConversation || { items: [] }).length) openSheet();
    },
    destroy() {
      generation += 1;
      clearTimeout(refreshTimer);
      clearTimeout(foregroundResumeTimer);
      clearTimeout(streamWatchdogTimer);
      clearTimeout(pendingAcceptanceTimer);
      cancelAnimationFrame(tailSnapFrame);
      closeStream();
      document.removeEventListener('pointerdown', dismissModelList);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pagehide', suspendForBackground);
      window.removeEventListener('pageshow', handlePageShow);
      window.removeEventListener('blur', suspendForBackground);
      window.removeEventListener('focus', handleWindowFocus);
      window.removeEventListener('online', handleOnline);
    },
  };
}
