import { markdownNode } from './markdown.js';
import { createMobileActivityStore, hasActivityAfterDismissal as activityChanged } from './mobile-activity-state.js';
import { composerCompletion as detectComposerCompletion, rankedCommands } from './mobile-composer-model.js';
import { createTimelineReconciler } from './mobile-timeline-reconciler.js';
import {
  createMobileFileSurface,
} from './mobile-file-surface.js';
import { createMobileEventRenderer } from './mobile-event-renderer.js';
import { createMobileInteractionRenderer } from './mobile-interaction-renderer.js';
import { createIcon, createIconButton } from './ui-components.js';

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function emptyConversationNode() {
  const section = element('section', 'mobile-conversation-empty');
  section.setAttribute('aria-label', 'Empty conversation');
  section.__mobileItemSignature = 'empty-conversation';
  const stack = element('div', 'chat-state-stack');

  const orbit = element('div', 'empty-orbit mobile-conversation-empty-orbit');
  orbit.setAttribute('aria-hidden', 'true');
  orbit.append(element('span'), element('i'));

  stack.append(
    orbit,
    element('span', 'empty-kicker', 'New conversation'),
    element('h2', '', 'What should we build next?'),
    element('p', '', 'Send a message below to start this chat.'),
  );
  section.append(stack);
  return section;
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
  controlGoal,
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
  activityToggle.replaceChildren(createIcon('panel-collapse', { className: 'mobile-panel-collapse-icon' }));
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
  composer.dataset.expanded = 'false';
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
  let goalMutationPending = false;
  const hiddenGoalIds = new Set();
  const optimisticQueuedInputs = new Map();
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
  let sheetCloseGeneration = 0;
  let sheetModeMotionGeneration = 0;
  let revealChildDetails = false;
  let subagentPillHost;
  let activityPillSignature = '';
  const expandedItems = new Set();
  const autoExpandedItems = new Set();
  const disclosureMotions = new WeakMap();
  const sheetContentMotionTimers = new WeakMap();
  const pendingQuestions = new Map();
  const pendingPlanReviews = new Map();
  let questionStateVersion = 0;
  let modelBusy = false;
  let modelOptionsSignature = '';
  let controlBusy = false;
  let submittingMessage = false;
  let cancellingTurn = false;
  let interactionMotionKey = '';
  let attachments = [];
  let uploadingAttachments = 0;
  let attachmentPickerState;
  const attachmentUploads = new Map();
  let suggestionItems = [];
  let suggestionIndex = 0;
  let suggestionRange;
  let suggestionTimer;
  let suggestionGeneration = 0;
  const mentionedFiles = new Set();
  let followStreamTail = true;
  // A submitted turn owns the tail until it settles. Safari can emit scroll
  // events while the visual viewport and pending row are being replaced;
  // those layout-driven events must not look like the reader scrolled away.
  let submittedTurnFollow = false;
  let tailSnapFrame;
  let mainScrollGeometryLock;
  let mainScrollGeometryUnlockTimer;
  let mainScrollGeometryFrame;
  let readerScrollGesture = false;
  let readerScrollGestureTimer;
  let browserAvailable = false;
  let pillDismissed = false;
  let dismissedActivitySnapshot;
  let dismissedPlanRevision = '';
  let expectedConversation = false;

  const fileSurface = createMobileFileSurface({
    root,
    element,
    readFile,
    getSessionName: () => sessionName,
    getConversation: () => lastConversation,
    animateContent: animateSheetContent,
    metric,
  });
  const {
    close: closeFileSheet,
    open: openFileReference,
  } = fileSurface;
  const {
    eventNode,
    permissionDockNode,
    toolGroupNode,
  } = createMobileEventRenderer({
    fileSurface,
    expandedItems,
    autoExpandedItems,
    initializeDisclosure,
    animateDisclosure,
    getSessionName: () => sessionName,
    respondPermission,
    refresh,
  });
  const {
    planReviewNode,
    questionNode,
  } = createMobileInteractionRenderer({
    pendingQuestions,
    pendingPlanReviews,
    onQuestionStateChange: () => { questionStateVersion += 1; },
    rerender: () => {
      renderedSignature = '';
      if (lastConversation) render(lastConversation);
    },
    getSessionName: () => sessionName,
    getThreadId: () => threadId,
    respondQuestion,
    respondPlanReview,
    refresh,
  });

  const conversationCache = new Map();
  const historyLimits = new Map();
  const initialHistoryLimit = 80;
  const maxCachedConversations = 6;
  let historyPrependAnchor;

  function historyLimit(name = sessionName) {
    return historyLimits.get(name) || initialHistoryLimit;
  }

  function rememberConversation(name, conversation) {
    if (!name || !conversation || conversation.parent) return;
    conversationCache.delete(name);
    conversationCache.set(name, conversation);
    while (conversationCache.size > maxCachedConversations) {
      conversationCache.delete(conversationCache.keys().next().value);
    }
  }

  const activityStore = createMobileActivityStore(localStorage);

  function loadDismissedPlanRevision(name = sessionName) {
    return activityStore.loadPlan(name);
  }

  function persistDismissedPlanRevision(revision) {
    dismissedPlanRevision = revision || '';
    activityStore.savePlan(sessionName, dismissedPlanRevision);
  }

  function loadDismissedActivitySnapshot(name = sessionName) {
    return activityStore.loadActivity(name);
  }

  function currentActivitySnapshot(conversation = rootConversation || { items: [] }) {
    return {
      version: 1,
      browser: browserAvailable,
      plan: planRevision(plans(conversation).at(-1)),
      subagents: subagents(conversation)
        // Keep every durable alias. A newly spawned item gains threadId later;
        // replacing its call id with that thread id made the same lifecycle
        // look like a brand-new subagent after reload.
        .flatMap((item) => [item.id, item.toolCallId, item.threadId])
        .filter(Boolean)
        .filter((value, index, values) => values.indexOf(value) === index)
        .sort(),
    };
  }

  function persistActivityDismissal() {
    dismissedActivitySnapshot = currentActivitySnapshot();
    pillDismissed = true;
    activityStore.saveActivity(sessionName, dismissedActivitySnapshot);
  }

  function clearActivityDismissal() {
    dismissedActivitySnapshot = undefined;
    pillDismissed = false;
    activityStore.clearActivity(sessionName);
  }

  function hasActivityAfterDismissal(snapshot) {
    const subagentAliases = subagents(rootConversation || { items: [] })
      .map((item) => [item.id, item.toolCallId, item.threadId].filter(Boolean));
    return activityChanged({
      dismissed: dismissedActivitySnapshot,
      current: snapshot,
      subagentAliases,
    });
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

  function captureMainScrollAnchor() {
    const bottom = distanceFromBottom();
    // `followStreamTail` records the reader's intent. A browser may move the
    // scroll container to expose the focused textarea before pointerdown, so
    // geometry at that instant alone is not a trustworthy bottom signal.
    return { bottom, top: messages.scrollTop, atBottom: bottom <= 48 || followStreamTail };
  }

  function applyMainScrollGeometryLock() {
    const anchor = mainScrollGeometryLock;
    if (!anchor) return;
    const maxScrollTop = Math.max(0, messages.scrollHeight - messages.clientHeight);
    const target = anchor.atBottom
      ? maxScrollTop
      : Math.min(anchor.top, maxScrollTop);
    if (Math.abs(messages.scrollTop - target) > .5) messages.scrollTop = target;
    if (anchor.atBottom) followStreamTail = true;
    updateJumpToLatest();
  }

  function scheduleMainScrollGeometryLock() {
    if (!mainScrollGeometryLock || mainScrollGeometryFrame) return;
    mainScrollGeometryFrame = requestAnimationFrame(() => {
      mainScrollGeometryFrame = undefined;
      applyMainScrollGeometryLock();
      // Native focus scrolling does not resize either observed element. Keep
      // the anchor authoritative on every animation frame for this short
      // transition window so WebKit/Chromium cannot insert a shifted frame.
      if (mainScrollGeometryLock) scheduleMainScrollGeometryLock();
    });
  }

  function holdMainScrollGeometry({ recapture = false, settle = 260 } = {}) {
    if (!mainScrollGeometryLock || recapture) {
      mainScrollGeometryLock = captureMainScrollAnchor();
    }
    clearTimeout(mainScrollGeometryUnlockTimer);
    mainScrollGeometryUnlockTimer = setTimeout(() => {
      applyMainScrollGeometryLock();
      mainScrollGeometryLock = undefined;
      mainScrollGeometryUnlockTimer = undefined;
    }, settle);
    // Force the post-mutation layout to reconcile in the same task, then keep
    // correcting before paint while the composer/visual viewport animates.
    applyMainScrollGeometryLock();
    scheduleMainScrollGeometryLock();
  }

  function releaseMainScrollGeometryLock() {
    clearTimeout(mainScrollGeometryUnlockTimer);
    mainScrollGeometryUnlockTimer = undefined;
    cancelAnimationFrame(mainScrollGeometryFrame);
    mainScrollGeometryFrame = undefined;
    mainScrollGeometryLock = undefined;
  }

  const mainScrollGeometryObserver = new ResizeObserver(() => {
    if (!mainScrollGeometryLock) return;
    // ResizeObserver runs after layout and before paint, which keeps both the
    // collapsed/expanded composer transition and iOS keyboard transition from
    // exposing an intermediate shifted chat frame.
    holdMainScrollGeometry({ settle: 96 });
  });
  mainScrollGeometryObserver.observe(composer);
  mainScrollGeometryObserver.observe(scrollShell);

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
    if (!option || unchanged || !sessionName || modelBusy || controlBusy) return;
    modelBusy = true;
    if (lastConversation) {
      renderModelControls(lastConversation);
      renderChoiceControls(lastConversation);
    }
    updateComposerAction();
    try {
      await setModel(sessionName, modelId, effortId);
      renderedSignature = '';
      await refresh();
    } catch (error) {
      state.textContent = error.message || 'Model change failed';
      state.dataset.state = 'error';
    } finally {
      modelBusy = false;
      if (lastConversation) {
        renderModelControls(lastConversation);
        renderChoiceControls(lastConversation);
      }
      updateComposerAction();
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
          const keepComposerFocused = document.activeElement === input;
          paintEffortOptions(option);
          if (!keepComposerFocused) {
            modelList.querySelector('[aria-selected="true"]')?.focus({ preventScroll: true });
          }
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
    const backButton = createIconButton({
      label: 'Back to models', glyph: '‹', variant: 'bare', size: 'sm',
    });
    backButton.addEventListener('click', () => {
      const control = lastConversation?.controls?.model;
      if (!control) return;
      const keepComposerFocused = document.activeElement === input;
      paintModelOptions(control);
      if (!keepComposerFocused) {
        modelList.querySelector(`[data-model-id="${CSS.escape(option.id)}"]`)?.focus({ preventScroll: true });
      }
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

  function renderContextUsage(conversation) {
    const conversationStarted = Boolean(
      conversation.items?.length || pendingMessage || optimisticQueuedInputs.size,
    );
    if (!conversationStarted) {
      context.hidden = true;
      return;
    }
    const usage = conversation.context;
    const modelControl = conversation.controls?.model;
    const currentModel = modelControl?.options?.find((model) => model.id === modelControl.currentId);
    const windowTokens = usage?.windowTokens ?? currentModel?.contextWindowTokens;
    if (!windowTokens) {
      context.hidden = true;
      return;
    }
    const usedTokens = usage?.usedTokens ?? 0;
    // Prefer the exact token ratio so the bar moves after small turns. The
    // provider's usagePercent is intentionally rounded for labels and can stay
    // unchanged across several responses near the start of a large window.
    const exactPercent = usedTokens > 0
      ? (usedTokens / windowTokens) * 100
      : Number(usage?.usagePercent) || 0;
    const percent = Math.max(0, Math.min(100, exactPercent));
    const announcedPercent = Math.round(percent * 10) / 10;
    context.hidden = false;
    contextProgress.value = percent;
    contextProgress.setAttribute('aria-label', `${announcedPercent}% of context window used`);
    contextValue.value = `${compactMetric(usedTokens)} / ${compactMetric(windowTokens)}`;
    contextValue.textContent = contextValue.value;
  }

  function renderModelControls(conversation) {
    renderContextUsage(conversation);
    const control = conversation.controls?.model;
    const options = Array.isArray(control?.options) ? control.options : [];
    const current = options.find((model) => model.id === control?.currentId);
    if (!current || !options.length) {
      closeModelList();
      modelButton.hidden = true;
      return;
    }
    modelButton.hidden = false;
    // Grok applies a selection made during an active turn immediately before
    // the next queued prompt. Keep the control usable while text streams.
    modelButton.disabled = modelBusy || controlBusy;
    modelButton.setAttribute('aria-busy', String(modelBusy));
    const currentEffort = current.efforts?.find((effort) => effort.id === current.currentEffortId);
    const currentLabel = [current.label, currentEffort?.label?.replace(/ Effort$/i, '')].filter(Boolean).join(' · ');
    modelLabel.textContent = modelBusy ? 'Switching…' : currentLabel;
    modelButton.setAttribute('aria-label', `Choose model, ${currentLabel}`);

    const nextSignature = JSON.stringify({ currentId: control.currentId, options });
    if (nextSignature !== modelOptionsSignature) {
      modelOptionsSignature = nextSignature;
      paintModelOptions(control);
    }

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
    button.disabled = controlBusy || modelBusy;
    button.setAttribute('aria-busy', String(controlBusy));
    label.textContent = controlBusy ? 'Switching…' : current.label;
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
        if (option.id === control.currentId || controlBusy || modelBusy || !sessionName) return;
        controlBusy = true;
        if (lastConversation) {
          renderModelControls(lastConversation);
          renderChoiceControls(lastConversation);
        }
        updateComposerAction();
        try {
          await change(sessionName, option.id);
          renderedSignature = '';
          await refresh();
        } catch (error) {
          state.textContent = error.message || `${option.label} failed`;
          state.dataset.state = 'error';
        } finally {
          controlBusy = false;
          if (lastConversation) {
            renderModelControls(lastConversation);
            renderChoiceControls(lastConversation);
          }
          updateComposerAction();
        }
      });
      fragment.append(choice);
    }
    list.replaceChildren(fragment);
  }

  function renderChoiceControls(conversation) {
    renderChoiceControl(conversation, 'mode', modeButton, modeLabel, modeList, setMode);
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
    return detectComposerCompletion(input.value, caret);
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

  function morphStreamingMarkdownNode(current, fresh) {
    if (current.nodeType !== fresh.nodeType) {
      current.replaceWith(fresh);
      return fresh;
    }
    if (current.nodeType === Node.TEXT_NODE) {
      if (current.data !== fresh.data) current.data = fresh.data;
      return current;
    }
    if (current.nodeType !== Node.ELEMENT_NODE || current.tagName !== fresh.tagName ||
        current.className !== fresh.className || current.matches('.mobile-markdown-copy') ||
        (current.matches('button') && current.textContent !== fresh.textContent)) {
      current.replaceWith(fresh);
      return fresh;
    }
    syncAttributes(current, fresh);
    const currentChildren = [...current.childNodes];
    const freshChildren = [...fresh.childNodes];
    const sharedLength = Math.min(currentChildren.length, freshChildren.length);
    for (let index = 0; index < sharedLength; index += 1) {
      morphStreamingMarkdownNode(currentChildren[index], freshChildren[index]);
    }
    for (let index = sharedLength; index < freshChildren.length; index += 1) {
      current.append(freshChildren[index]);
    }
    for (let index = sharedLength; index < currentChildren.length; index += 1) {
      currentChildren[index].remove();
    }
    return current;
  }

  function morphStreamingMarkdown(content, fresh, { streaming = true, rawText } = {}) {
    const scroll = captureStreamScroll(content);
    const currentChildren = [...content.childNodes];
    const freshChildren = [...fresh.childNodes];
    const sharedLength = Math.min(currentChildren.length, freshChildren.length);
    for (let index = 0; index < sharedLength; index += 1) {
      morphStreamingMarkdownNode(currentChildren[index], freshChildren[index]);
    }
    for (let index = sharedLength; index < freshChildren.length; index += 1) {
      content.append(freshChildren[index]);
    }
    for (let index = sharedLength; index < currentChildren.length; index += 1) {
      currentChildren[index].remove();
    }
    if (streaming) {
      content.dataset.streaming = 'true';
      content.__mobileRawText = rawText;
    } else {
      syncAttributes(content, fresh);
      delete content.__mobileRawText;
    }
    restoreStreamScroll(content, scroll);
    return content;
  }

  function reparseStreamingMarkdown(content, nextText) {
    const fresh = markdownNode(nextText, {
      onFileReference: (reference) => void openFileReference(reference),
    });
    return morphStreamingMarkdown(content, fresh, { streaming: true, rawText: nextText });
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
    const trailingBlockBreak = /(?:\n[ \t]*\n| {2,}\n|\\\n)$/.test(previousText);
    if (previousFences !== nextFences || openingFenceCompleted || trailingBlockBreak ||
        (nextFences % 2 === 0 && streamNeedsMarkdownParse(previousText, suffix))) {
      return reparseStreamingMarkdown(content, nextText);
    }
    const openCode = nextFences % 2 === 1 ? content.querySelector('pre code') : undefined;
    if (openCode) {
      openCode.append(document.createTextNode(suffix));
    } else {
      // marked/DOMPurify retain serializer whitespace after the final block,
      // e.g. `<p>I</p>\n`. Walking the whole root selected that trailing text
      // node, so the next compact delta produced `<p>I</p>\n'm ready...` and
      // appeared on a separate line until an authoritative refresh reparsed
      // the message. Walk the final rendered block instead; it is the visual
      // tail that an incremental prose token belongs to.
      const tail = content.lastElementChild || content;
      const walker = document.createTreeWalker(tail, NodeFilter.SHOW_TEXT);
      let lastText;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) lastText = node;
      const insideInlineMarkup = lastText?.parentElement?.closest(
        'strong, em, del, a, code, .mobile-file-reference',
      );
      if (insideInlineMarkup) return reparseStreamingMarkdown(content, nextText);
      const collapsedBoundary = /\s$/.test(previousText) && !/^\s/.test(suffix) ? ' ' : '';
      if (lastText) lastText.data += `${collapsedBoundary}${suffix}`;
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
    if (atBottom || (isRoot && (followStreamTail || submittedTurnFollow))) {
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
    sheetBack = createIconButton({
      className: 'mobile-subagent-sheet-back', label: 'Back to subagent list', glyph: '‹',
      variant: 'bare', size: 'xl',
    });
    sheetTitle = element('strong', '', 'Subagents');
    sheetMeta = element('small');
    const copy = element('span');
    copy.append(sheetTitle, sheetMeta);
    sheetState = element('span', 'mobile-subagent-sheet-state');
    sheetBrowser = createIconButton({
      className: 'mobile-subagent-sheet-browser', label: 'Open browser', glyph: '↗',
      variant: 'bare', size: 'xl',
    });
    sheetBrowser.hidden = !browserAvailable;
    sheetClose = createIconButton({
      className: 'mobile-subagent-sheet-close close-button', label: 'Close activity', glyph: '×',
      variant: 'bare', size: 'xl',
    });
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
      const shouldClose = sheetPointer.distance > 54;
      sheetPointer = undefined;
      sheetPanel.dataset.dragSettled = 'true';
      delete sheetPanel.dataset.dragging;
      if (shouldClose) closeSheet();
      else sheetPanel.style.removeProperty('--mobile-sheet-drag');
    };
    sheetHandle.addEventListener('pointerup', finishDrag);
    sheetHandle.addEventListener('pointercancel', finishDrag);
  }

  function renderSubagentList(conversation = rootConversation) {
    if (!sheet || !conversation) return;
    const items = subagents(conversation);
    const running = items.filter((item) => ['calling', 'running'].includes(subagentState(item)));
    const completed = items.filter((item) => !['calling', 'running'].includes(subagentState(item)));
    sheetTitle.textContent = 'Subagents';
    sheetMeta.textContent = items.length ? `${items.length} total` : 'No agents';
    sheetState.textContent = '';
    sheetList.replaceChildren();
    const appendGroup = (label, group, state) => {
      if (!group.length) return;
      const section = element('section', 'mobile-subagent-group');
      const heading = element('h3', '', label);
      heading.dataset.state = state;
      section.append(heading);
      for (const item of group) {
        const lifecycleState = subagentState(item);
        const row = element(item.threadId ? 'button' : 'article', 'mobile-subagent-row');
        row.dataset.state = lifecycleState;
        if (item.threadId) {
          row.type = 'button';
          row.dataset.threadId = item.threadId;
          row.addEventListener('click', () => openChild(item.threadId));
        } else row.setAttribute('aria-label', `${item.title || 'Subagent'} · ${label}`);
        const copy = element('span');
        copy.append(
          element('strong', '', item.title || 'Subagent'),
          element('small', '', [item.role || 'Subagent', item.model, item.capabilityMode]
            .filter(Boolean).join(' · ')),
        );
        const rowStatusLabel = ['calling', 'running'].includes(lifecycleState)
          ? 'In progress' : statusLabel(lifecycleState);
        const status = element('span', 'mobile-subagent-status', rowStatusLabel);
        status.dataset.state = lifecycleState;
        row.append(copy, status, element('i', '', item.threadId ? '›' : ''));
        section.append(row);
      }
      sheetList.append(section);
    };
    appendGroup('In progress', running, 'running');
    appendGroup('Done', completed, 'completed');
    if (!items.length) {
      sheetList.append(element('p', 'mobile-subagent-empty', 'No subagents yet.'));
    }
  }

  function transitionSheetMode(nextMode) {
    const motionGeneration = ++sheetModeMotionGeneration;
    const startHeight = sheetPanel.getBoundingClientRect().height;
    sheetPanel.style.transition = 'none';
    sheetPanel.dataset.mode = nextMode;
    sheetPanel.style.removeProperty('height');
    const targetHeight = sheetPanel.getBoundingClientRect().height;
    sheetPanel.style.height = `${startHeight}px`;
    sheetPanel.getBoundingClientRect();
    sheetPanel.style.removeProperty('transition');
    sheetPanel.dataset.navigating = 'true';
    requestAnimationFrame(() => {
      if (motionGeneration !== sheetModeMotionGeneration || sheet.hidden) return;
      sheetPanel.style.height = `${targetHeight}px`;
    });
    let motionTimer;
    const finishMotion = (event) => {
      if (event && (event.target !== sheetPanel || event.propertyName !== 'height')) return;
      sheetPanel.removeEventListener('transitionend', finishMotion);
      clearTimeout(motionTimer);
      if (motionGeneration !== sheetModeMotionGeneration) return;
      delete sheetPanel.dataset.navigating;
      sheetPanel.style.removeProperty('height');
    };
    sheetPanel.addEventListener('transitionend', finishMotion);
    motionTimer = setTimeout(() => finishMotion(), 520);
  }

  function animateSheetContent(container) {
    clearTimeout(sheetContentMotionTimers.get(container));
    delete container.dataset.entering;
    container.getBoundingClientRect();
    container.dataset.entering = 'true';
    sheetContentMotionTimers.set(container, setTimeout(() => {
      delete container.dataset.entering;
      sheetContentMotionTimers.delete(container);
    }, 360));
  }

  function renderSubagentPill(conversation) {
    if (!subagentPillHost) {
      subagentPillHost = element('div', 'mobile-subagent-pill-host');
      scrollShell.after(subagentPillHost);
    }
    const booting = !rootConversation || root.dataset.booting === 'true';
    const items = booting ? [] : subagents(conversation);
    const plan = booting ? undefined : visiblePlan(conversation);
    if (!booting && pillDismissed && hasActivityAfterDismissal(currentActivitySnapshot(conversation))) {
      clearActivityDismissal();
    }
    const nextSignature = JSON.stringify({
      booting,
      browserAvailable,
      pillDismissed,
      plan: planRevision(plan),
      items: items.map((item) => ({
        id: item.id,
        threadId: item.threadId,
        title: item.title,
        role: item.role,
        model: item.model,
        capabilityMode: item.capabilityMode,
        phase: item.phase,
        status: item.status,
      })),
    });
    if (nextSignature === activityPillSignature) return;
    activityPillSignature = nextSignature;
    const willShowHost = !booting && !pillDismissed && Boolean(items.length || browserAvailable || plan);
    const preserveScroll = available && messages.childElementCount > 0 &&
      !subagentPillHost.hidden !== willShowHost;
    if (preserveScroll) holdMainScrollGeometry({ settle: 220 });
    if (booting) {
      subagentPillHost.replaceChildren();
      subagentPillHost.hidden = true;
      activityToggle.hidden = true;
      if (preserveScroll) applyMainScrollGeometryLock();
      return;
    }
    onSubagentAvailabilityChange(items.length > 0);
    if (!items.length && !browserAvailable && !plan) {
      subagentPillHost.replaceChildren();
      subagentPillHost.hidden = true;
      activityToggle.hidden = true;
      if (preserveScroll) applyMainScrollGeometryLock();
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
      const label = 'Agents';
      const pill = element('button', 'mobile-subagent-pill');
      pill.type = 'button';
      pill.dataset.state = running ? 'running' : 'completed';
      pill.setAttribute('aria-label', `${label}. ${running ? 'In progress' : 'Done'}. View subagents`);
      pill.append(element('i'), element('span', '', label));
      pill.addEventListener('click', () => openSheet());
      cluster.append(pill);
    }
    const dismiss = createIconButton({
      className: 'mobile-activity-pill-dismiss', label: 'Hide activity',
      icon: createIcon('panel-collapse', { className: 'mobile-panel-collapse-icon' }),
      variant: 'bare', size: 'md',
    });
    dismiss.addEventListener('click', () => {
      persistActivityDismissal();
      renderSubagentPill(rootConversation || { items: [] });
    });
    cluster.append(dismiss);
    subagentPillHost.replaceChildren(cluster);
    if (preserveScroll) applyMainScrollGeometryLock();
  }

  function clearSubagentPill() {
    activityPillSignature = '';
    if (!subagentPillHost) return;
    subagentPillHost.replaceChildren();
    subagentPillHost.hidden = true;
    activityToggle.hidden = true;
    onSubagentAvailabilityChange(false);
  }

  activityToggle.addEventListener('click', () => {
    clearActivityDismissal();
    renderSubagentPill(rootConversation || { items: [] });
  });

  function openSheet() {
    ensureSheet();
    sheetCloseGeneration += 1;
    sheetModeMotionGeneration += 1;
    delete sheet.dataset.closing;
    delete sheetPanel.dataset.dragSettled;
    sheetPanel.style.removeProperty('--mobile-sheet-drag');
    sheet.inert = false;
    sheetReturnFocus = document.activeElement;
    sheet.hidden = false;
    sheetMode = 'list';
    sheetPanel.dataset.mode = 'list';
    delete sheetPanel.dataset.navigating;
    sheetPanel.style.removeProperty('height');
    sheetPanel.style.removeProperty('transition');
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
    sheetCloseGeneration += 1;
    sheetModeMotionGeneration += 1;
    delete sheet.dataset.closing;
    delete sheetPanel.dataset.dragSettled;
    sheetPanel.style.removeProperty('--mobile-sheet-drag');
    sheet.inert = false;
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
    animateSheetContent(sheetMessages);
    requestAnimationFrame(() => sheetClose.focus({ preventScroll: true }));
  }

  function openChild(nextThreadId) {
    sheetCloseGeneration += 1;
    selectedChildId = nextThreadId;
    selectedPlanId = undefined;
    const lifecycle = subagentForThread(nextThreadId);
    sheetMode = 'child';
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
    revealChildDetails = true;
    delete sheetMessages.dataset.entering;
    sheetMessages.replaceChildren();
    transitionSheetMode('child');
    requestAnimationFrame(() => sheetBack.focus({ preventScroll: true }));
    void refresh();
  }

  function showSheetList() {
    if (sheetMode !== 'child') return;
    revealChildDetails = false;
    delete sheetMessages.dataset.entering;
    closeStream();
    threadId = rootThreadId;
    selectedChildId = undefined;
    sheetMode = 'list';
    sheetList.hidden = false;
    sheetMessages.hidden = true;
    sheetBack.hidden = true;
    renderSubagentList();
    transitionSheetMode('list');
    renderedSignature = '';
    void refresh();
  }

  function closeSheet({ dismiss = false } = {}) {
    if (!sheet || sheet.hidden || sheet.dataset.closing === 'true') return;
    const childWasOpen = sheetMode === 'child';
    const subagentSheetWasOpen = sheetMode === 'list' || childWasOpen;
    sheetModeMotionGeneration += 1;
    revealChildDetails = false;
    delete sheetMessages.dataset.entering;
    if (dismiss && sheetMode === 'plan') {
      const plan = plans(rootConversation || {}).find((item) => item.id === selectedPlanId)
        || plans(rootConversation || {}).at(-1);
      persistDismissedPlanRevision(planRevision(plan));
    }
    if (dismiss && subagentSheetWasOpen) persistActivityDismissal();
    if (childWasOpen) closeStream();
    const closeGeneration = ++sheetCloseGeneration;
    sheet.dataset.closing = 'true';
    sheet.inert = true;
    sheetMode = 'list';
    selectedChildId = undefined;
    selectedPlanId = undefined;
    threadId = rootThreadId;
    if (childWasOpen) {
      renderedSignature = '';
      void refresh();
    }
    if (dismiss) renderSubagentPill(rootConversation || { items: [] });
    let closeTimer;
    const finish = () => {
      sheetPanel.removeEventListener('animationend', finishAfterAnimation);
      clearTimeout(closeTimer);
      if (closeGeneration !== sheetCloseGeneration) return;
      sheet.hidden = true;
      sheet.inert = false;
      delete sheet.dataset.closing;
      delete sheetPanel.dataset.navigating;
      delete sheetPanel.dataset.dragSettled;
      sheetPanel.style.removeProperty('--mobile-sheet-drag');
      sheetPanel.style.removeProperty('height');
      sheetPanel.style.removeProperty('transition');
      sheetReturnFocus?.focus?.({ preventScroll: true });
    };
    const finishAfterAnimation = (event) => {
      if (event.target === sheetPanel && event.animationName === 'mobile-sheet-out') finish();
    };
    sheetPanel.addEventListener('animationend', finishAfterAnimation);
    closeTimer = setTimeout(finish, 600);
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
    url.searchParams.set('historyLimit', String(historyLimit()));
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
          setBooting(false);
          return;
        }
        if (payload?.type === 'control' && payload.action === 'open-graphics' &&
            Array.isArray(payload.argv) && payload.argv.length > 0 && payload.argv.length <= 100 &&
            payload.argv.every((argument) => typeof argument === 'string' && argument.length <= 4096)) {
          clearActivityDismissal();
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
      const remove = createIconButton({
        className: 'close-button close-button--destructive', label: `Remove ${attachment.name}`,
        glyph: '×', variant: 'danger', size: 'xs',
      });
      remove.addEventListener('pointerdown', retainComposerInputFocus);
      remove.addEventListener('click', () => {
        attachments = attachments.filter((value) => value.id !== attachment.id);
        renderAttachmentTray();
        autoSizeInput();
      });
      item.append(remove);
    }
    return item;
  }

  function attachmentUploadNode(upload) {
    const item = element('div', 'mobile-conversation-uploading');
    item.dataset.state = upload.status;
    item.setAttribute('role', upload.status === 'error' ? 'alert' : 'status');
    item.append(element('strong', '', upload.status === 'error'
      ? 'Upload failed'
      : upload.status === 'cancelling' ? 'Cancelling…'
      : `${Math.round(upload.progress * 100)}%`));
    item.append(element('small', '', upload.status === 'error'
      ? `${upload.name}: ${upload.error}`
      : upload.name));
    if (upload.status === 'uploading' || upload.status === 'cancelling') {
      const progress = document.createElement('progress');
      progress.max = 1;
      progress.value = upload.progress;
      progress.setAttribute('aria-label', `Uploading ${upload.name}`);
      item.append(progress);
    }
    const action = createIconButton({
      className: 'close-button', label: 'Manage upload', glyph: '×', variant: 'bare', size: 'xs',
    });
    action.addEventListener('pointerdown', retainComposerInputFocus);
    if (upload.status === 'uploading' || upload.status === 'cancelling') {
      action.setAttribute('aria-label', `Cancel upload ${upload.name}`);
      action.disabled = upload.status === 'cancelling';
      action.addEventListener('click', () => {
        upload.status = 'cancelling';
        upload.controller?.abort();
        renderAttachmentTray();
      });
    } else {
      action.setAttribute('aria-label', `Dismiss upload error for ${upload.name}`);
      action.addEventListener('click', () => {
        attachmentUploads.delete(upload.id);
        renderAttachmentTray();
      });
    }
    item.append(action);
    return item;
  }

  function renderAttachmentTray() {
    attachmentTray.hidden = attachments.length === 0 && attachmentUploads.size === 0;
    const fragment = document.createDocumentFragment();
    for (const attachment of attachments) fragment.append(attachmentNode(attachment, { removable: true }));
    for (const upload of attachmentUploads.values()) fragment.append(attachmentUploadNode(upload));
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

  function updateQueueOverflow(count = queueRows().length) {
    queue.dataset.scrollable = String(count > 5);
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
      if (row) queue.insertBefore(row, queue.querySelector('.mobile-conversation-goal'));
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
      else queue.insertBefore(row, queue.querySelector('.mobile-conversation-goal'));
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
      updateQueueOverflow(remaining);
      if (!remaining && !queue.querySelector('.mobile-conversation-goal')) queue.hidden = true;
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

  function reconcileOptimisticQueue(conversation) {
    if (!optimisticQueuedInputs.size) return;
    const authoritativeIds = new Set((conversation.queue || []).map((entry) => entry.id));
    const userMessages = (conversation.items || []).filter((item) =>
      item.type === 'message' && item.role === 'user');
    for (const [id, entry] of optimisticQueuedInputs) {
      const delivered = userMessages.some((item) => entry.text && item.text.includes(entry.text));
      if (authoritativeIds.has(id) || delivered) optimisticQueuedInputs.delete(id);
    }
  }

  function goalElapsed(milliseconds) {
    const seconds = Math.max(0, Math.round((Number(milliseconds) || 0) / 1_000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    return `${minutes}m ${seconds % 60}s`;
  }

  async function runGoalAction(row, goal, action) {
    if (goalMutationPending || typeof controlGoal !== 'function') return;
    goalMutationPending = true;
    row.dataset.busy = 'true';
    for (const button of row.querySelectorAll('button')) button.disabled = true;
    try {
      await controlGoal(sessionName, action);
      if (action === 'clear') {
        hiddenGoalIds.add(goal.id);
        queueRenderSignature = '';
        if (lastConversation) renderQueue(lastConversation);
      } else {
        row.dataset.pendingAction = action;
        void refresh();
      }
    } catch (error) {
      state.textContent = error.message || 'Goal action failed';
      state.dataset.state = 'error';
      for (const button of row.querySelectorAll('button')) button.disabled = false;
    } finally {
      goalMutationPending = false;
      row.dataset.busy = 'false';
    }
  }

  function goalQueueNode(goal) {
    const paused = ['paused', 'user_paused'].includes(goal.status);
    const completed = goal.status === 'completed';
    const row = element('article', 'mobile-conversation-goal');
    row.dataset.goalId = goal.id;
    row.dataset.state = completed ? 'completed' : paused ? 'paused' : 'working';

    const summary = element('div', 'mobile-conversation-goal-summary');
    const icon = element('i', 'mobile-conversation-goal-icon');
    icon.setAttribute('aria-hidden', 'true');
    const copy = element('div', 'mobile-conversation-goal-copy');
    copy.append(
      element('strong', '', completed ? 'Goal complete' : paused ? 'Goal paused' : 'Pursuing goal'),
      element('span', '', goal.objective || 'Autonomous goal'),
      element('small', '', `• ${goalElapsed(goal.metrics?.elapsedMs)}`),
    );
    const actions = element('div', 'mobile-conversation-goal-actions');
    const remove = createIconButton({
      label: 'Delete goal', title: 'Stop and delete goal', glyph: '⌫', variant: 'danger', size: 'sm',
    });
    remove.addEventListener('click', () => void runGoalAction(row, goal, 'clear'));
    const pause = createIconButton({
      label: paused ? 'Resume goal' : 'Pause goal', glyph: paused ? '▶' : 'Ⅱ',
      variant: 'bare', size: 'sm',
    });
    pause.hidden = completed;
    pause.title = paused ? 'Resume goal' : 'Pause goal';
    pause.addEventListener('click', () => void runGoalAction(row, goal, paused ? 'resume' : 'pause'));
    const expand = createIconButton({
      label: 'Show goal details', glyph: '⌗', variant: 'bare', size: 'sm',
    });
    expand.setAttribute('aria-expanded', String(expandedItems.has(goal.id)));
    actions.append(remove, pause, expand);
    summary.append(icon, copy, actions);

    const details = element('div', 'mobile-conversation-goal-details');
    details.hidden = !expandedItems.has(goal.id);
    const progress = goal.progress?.total
      ? `${metric(goal.progress.completed)} / ${metric(goal.progress.total)} deliverables`
      : 'No deliverables reported';
    details.append(
      element('span', '', goal.phase || statusLabel(goal.status)),
      element('span', '', progress),
      element('span', '', `${compactMetric(goal.metrics?.tokensUsed)} tokens`),
      ...(goal.lastEvent ? [element('span', '', goal.lastEvent.replaceAll('_', ' '))] : []),
    );
    expand.addEventListener('click', () => {
      const open = details.hidden;
      details.hidden = !open;
      expand.setAttribute('aria-expanded', String(open));
      expand.setAttribute('aria-label', open ? 'Hide goal details' : 'Show goal details');
      if (open) expandedItems.add(goal.id);
      else expandedItems.delete(goal.id);
    });
    row.append(summary, details);
    return row;
  }

  function renderQueue(conversation) {
    const authoritative = Array.isArray(conversation.queue) ? conversation.queue : [];
    const authoritativeIds = new Set(authoritative.map((entry) => entry.id));
    const entries = [
      ...authoritative,
      ...[...optimisticQueuedInputs.values()].filter((entry) => !authoritativeIds.has(entry.id)),
    ];
    const goals = (conversation.items || []).filter((item) => item.type === 'goal' && item.objective);
    const activeGoalIds = new Set(goals.map((goal) => goal.id));
    for (const hiddenId of hiddenGoalIds) {
      if (!activeGoalIds.has(hiddenId)) hiddenGoalIds.delete(hiddenId);
    }
    const goal = [...goals].reverse().find((item) => !hiddenGoalIds.has(item.id));
    const nextSignature = `${sessionName}:${JSON.stringify(entries)}:${JSON.stringify(goal || null)}`;
    if (nextSignature === queueRenderSignature) return;
    queueRenderSignature = nextSignature;
    queue.hidden = entries.length === 0 && !goal;
    queue.dataset.hasGoal = String(Boolean(goal));
    updateQueueOverflow(entries.length);
    if (!entries.length && !goal) {
      queue.replaceChildren();
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const entry of entries) {
      const row = element('article', 'mobile-conversation-queue-item');
      row.dataset.queueId = entry.id;
      row.dataset.pending = String(entry.optimistic === true);
      row.toggleAttribute('aria-busy', entry.optimistic === true);
      row.append(element('span', 'mobile-conversation-queue-icon', '↳'));
      const handle = createIconButton({
        className: 'mobile-conversation-queue-handle',
        label: `Reorder queued message: ${entry.text}`, glyph: '⋯', variant: 'bare', size: 'sm',
      });
      handle.disabled = entries.length < 2 || entry.optimistic === true;
      handle.title = 'Drag to reorder';
      setupQueueReorder(row, handle);
      const copy = element('div', 'mobile-conversation-queue-copy');
      copy.append(element('p', '', entry.text));
      const attachmentCount = entry.attachments?.length || 0;
      if (attachmentCount) copy.append(element('small', '', `+${attachmentCount} file${attachmentCount === 1 ? '' : 's'}`));
      const actions = element('div', 'mobile-conversation-queue-actions');
      const steer = element('button', '', '↪ Steer');
      steer.type = 'button';
      steer.disabled = entry.optimistic === true;
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
          submittedTurnFollow = true;
          renderedSignature = '';
          if (lastConversation) render(lastConversation);
          snapMessagesToLatest();
          void refresh();
        } },
      ));
      const remove = createIconButton({
        className: 'mobile-conversation-queue-delete', label: 'Delete queued message',
        glyph: '⌫', variant: 'danger', size: 'sm',
      });
      remove.disabled = entry.optimistic === true;
      remove.addEventListener('click', () => runQueueAction(
        row, () => removeQueuedInput(sessionName, entry.id), 'Delete failed',
      ));
      actions.append(steer, remove);
      row.append(copy, actions, handle);
      fragment.append(row);
    }
    if (goal) fragment.append(goalQueueNode(goal));
    queue.replaceChildren(fragment);
    updateQueueOverflow(entries.length);
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
    const activeElement = document.activeElement;
    const currentQuestion = interactionDock.firstElementChild;
    const localQuestionState = interaction.type === 'question'
      ? pendingQuestions.get(interaction.questionId)
      : undefined;
    const preserveFocusedCustomAnswer = interaction.type === 'question'
      && currentQuestion?.matches('.mobile-question-card')
      && currentQuestion.dataset.questionId === String(interaction.questionId)
      && currentQuestion.dataset.questionStep === String(questionStep)
      && activeElement?.matches('.mobile-question-custom')
      && currentQuestion.contains(activeElement)
      && !['submitting', 'failed'].includes(localQuestionState?.status);
    if (!preserveFocusedCustomAnswer) {
      interactionDock.replaceChildren(interaction.type === 'question'
        ? questionNode(interaction, { docked: true })
        : interaction.type === 'plan_review' ? planReviewNode(interaction)
          : permissionDockNode(interaction));
    }
  }

  function uploadedImagePreview(target) {
    const value = String(target || '').trim();
    const uploadId = value.match(/\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:\.[a-z0-9]{1,10})?$/i)?.[1];
    if (uploadId) {
      return apiUrl(`/api/conversations/${encodeURIComponent(sessionName)}/attachments/${uploadId}`);
    }
    try {
      const url = new URL(value, location.href);
      return ['http:', 'https:'].includes(url.protocol) ? url.href : undefined;
    } catch {
      return undefined;
    }
  }

  function userMessageContentNode(item) {
    const content = element('div', 'mobile-message-content');
    const images = (Array.isArray(item.attachments) ? item.attachments : []).flatMap((attachment) => {
      if (!/^image\/(?:png|jpeg|webp|gif)$/i.test(attachment?.mimeType || '') || !attachment.previewUrl) return [];
      return [{ name: attachment.name || 'Attached image', url: apiUrl(attachment.previewUrl) }];
    });
    let visibleText = String(item.text || '');
    if (!images.length) {
      visibleText = visibleText.replace(/!\[([^\]\n]*)\]\(([^)\n]+)\)/g, (source, label, target) => {
        const url = uploadedImagePreview(target);
        if (!url) return source;
        let fallback = 'Attached image';
        try { fallback = decodeURIComponent(String(target).split('/').at(-1) || fallback); } catch { /* keep fallback */ }
        images.push({ name: label.trim() || fallback, url });
        return '';
      }).replace(/\n{3,}/g, '\n\n').trim();
    }
    if (!images.length) {
      content.textContent = visibleText;
      return content;
    }

    const gallery = element('div', 'mobile-message-user-attachments');
    for (const image of images) {
      const link = element('a', 'mobile-message-user-attachment');
      link.href = image.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.setAttribute('aria-label', `View ${image.name}`);
      const preview = document.createElement('img');
      preview.src = image.url;
      preview.alt = image.name;
      preview.loading = 'lazy';
      preview.decoding = 'async';
      link.append(preview, element('small', '', image.name));
      gallery.append(link);
    }
    content.append(gallery);
    if (visibleText) content.append(element('div', 'mobile-message-user-text', visibleText));
    return content;
  }

  function messageNode(item, conversation, { suppressPendingInteractions = false } = {}) {
    if (item.type === 'message') {
      const article = element('article', `mobile-message mobile-message-${item.role}`);
      article.dataset.messageId = item.id;
      if (item.role === 'user') {
        const content = userMessageContentNode(item);
        const author = item.pendingStatus === 'failed' ? 'Not received · tap to retry' : 'You';
        article.append(element('span', 'mobile-message-author', author), content);
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
    if (item.type === 'goal') return document.createDocumentFragment();
    if (item.type === 'turn') return document.createDocumentFragment();
    if (item.type === 'subagent') return document.createDocumentFragment();
    return eventNode(item);
  }

  const reconcileTimeline = createTimelineReconciler({ appendStreamingMarkdown, morphStreamingMarkdown });

  function render(conversation, { animate = false, fromStream = false } = {}) {
    const previousConversation = lastConversation;
    lastConversation = conversation;
    const initialThreadRender = !previousConversation ||
      previousConversation.thread?.id !== conversation.thread.id;
    const isRoot = !conversation.parent && conversation.thread.id === rootThreadId;
    if (isRoot) {
      rootConversation = conversation;
      rememberConversation(sessionName, conversation);
    }
    const targetMessages = isRoot ? messages : sheetMessages || messages;
    const revealChild = !isRoot && revealChildDetails &&
      conversation.thread?.id === selectedChildId;
    if (revealChild) animateSheetContent(sheetMessages);
    // Follow new output only while the reader is actually at the bottom. A
    // generous "near bottom" threshold makes short mobile histories snap back
    // down on every streamed update and effectively prevents scrolling.
    const atBottom = distanceFromBottom(targetMessages) <= 48;
    const turnSettled = isRoot && previousConversation?.activity?.active === true &&
      conversation.activity?.active !== true;
    const shouldFollowTail = isRoot
      ? followStreamTail || submittedTurnFollow
      : atBottom;
    const hadPendingMessage = Boolean(pendingMessage);
    reconcileOptimisticQueue(conversation);
    const streamScroll = captureStreamScroll(targetMessages);
    const signature = JSON.stringify({
      thread: conversation.thread,
      activity: conversation.activity,
      items: conversation.items,
      children: conversation.children,
      controls: conversation.controls,
      context: conversation.context,
      queue: conversation.queue,
      optimisticQueue: [...optimisticQueuedInputs.values()],
      pending: pendingMessage,
      attachments,
      uploadingAttachments,
      questions: questionStateVersion,
      planReviews: [...pendingPlanReviews.entries()],
      submittingMessage,
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
    if (conversation.history?.hasEarlier) {
      const earlier = element(
        'button', 'mobile-history-earlier',
        `Load earlier history · ${metric(conversation.history.hiddenItems)} hidden`,
      );
      earlier.type = 'button';
      earlier.addEventListener('click', () => {
        const currentLimit = historyLimit();
        const nextLimit = Math.min(5_000, Math.max(currentLimit + initialHistoryLimit, currentLimit * 2));
        if (nextLimit === currentLimit) return;
        historyLimits.set(sessionName, nextLimit);
        historyPrependAnchor = {
          sessionName,
          scrollHeight: targetMessages.scrollHeight,
          scrollTop: targetMessages.scrollTop,
        };
        closeStream();
        void refresh();
      });
      fragment.append(earlier);
    }
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
    if (!fragment.childNodes.length) fragment.append(emptyConversationNode());
    reconcileTimeline(targetMessages, [...fragment.childNodes]);
    if (revealChild) {
      revealChildDetails = false;
    }
    restoreStreamScroll(targetMessages, streamScroll);
    if (historyPrependAnchor?.sessionName === sessionName) {
      const anchor = historyPrependAnchor;
      historyPrependAnchor = undefined;
      targetMessages.scrollTop = anchor.scrollTop + (targetMessages.scrollHeight - anchor.scrollHeight);
    } else if (initialThreadRender || shouldFollowTail || hadPendingMessage) {
      targetMessages.scrollTop = targetMessages.scrollHeight;
      // Newly parsed Markdown can change height once layout settles. Commit a
      // second tail position on the next frame so the first streamed chunk
      // lands flush above the composer instead of leaving a small gap.
      if (isRoot) snapMessagesToLatest();
    }
    if (turnSettled) submittedTurnFollow = false;
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
    const params = new URLSearchParams();
    if (threadId) params.set('thread', threadId);
    params.set('historyLimit', String(historyLimit()));
    const query = `?${params}`;
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
      const finishingBoot = root.dataset.booting === 'true';
      if (finishingBoot) holdMainScrollGeometry({ recapture: true, settle: 260 });
      setBooting(false);
      if (!conversation.parent) renderSubagentPill(conversation);
      if (finishingBoot) applyMainScrollGeometryLock();
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

  function setComposerExpanded(expanded) {
    const next = Boolean(expanded);
    if (composer.dataset.expanded === String(next)) return;
    holdMainScrollGeometry({ settle: 160 });
    composer.dataset.expanded = String(next);
    applyMainScrollGeometryLock();
    scheduleMainScrollGeometryLock();
    if (next) requestAnimationFrame(autoSizeInput);
    else closeAllLists();
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
    const switchingSettings = modelBusy || controlBusy;
    const stopAction = turnActive && !hasDraft;
    const waitingAction = pendingDelivery && !turnActive && !hasDraft;
    // Changing model or mode only locks submission. It is not a conversation
    // turn, so keep the ordinary Send affordance instead of showing activity.
    const action = switchingSettings ? 'send'
      : submittingMessage ? 'sending'
        : cancellingTurn ? 'stopping' : stopAction ? 'stop' : waitingAction ? 'waiting' : 'send';
    sendButton.dataset.action = action;
    sendButton.textContent = action === 'send' ? '↑' : '';
    sendButton.setAttribute('aria-label', action === 'stop' ? 'Stop response'
      : action === 'stopping' ? 'Stopping response'
        : action === 'sending' ? 'Sending message'
        : action === 'waiting' ? 'Waiting for response' : 'Send message');
    sendButton.disabled = uploadingAttachments > 0 || switchingSettings ||
      action === 'sending' || action === 'stopping' || action === 'waiting' ||
      (action === 'send' && !hasDraft);
  }

  composer.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (modelBusy || controlBusy) return;
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
    const requestId = crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    submittingMessage = true;
    updateComposerAction();
    let sendRequest;
    try {
      sendRequest = Promise.resolve(send(
        sessionName, text, sentAttachments.map((attachment) => attachment.id), sentFileMentions, requestId,
      ));
    } catch (error) {
      sendRequest = Promise.reject(error);
    }
    // Attach a rejection observer immediately: the request starts before the
    // first paint, while its authoritative error is still handled below.
    sendRequest.catch(() => {});
    const queueExpected = lastConversation?.activity?.active === true ||
      Boolean(lastConversation?.queue?.length) || optimisticQueuedInputs.size > 0;
    if (queueExpected) {
      optimisticQueuedInputs.set(requestId, {
        id: requestId, text: pendingText, createdAt: Date.now(),
        attachments: sentAttachments, optimistic: true,
      });
      pendingMessage = undefined;
    } else {
      pendingMessage = {
        text: pendingText, attachments: sentAttachments, fileMentions: sentFileMentions,
        sentAt: Date.now(), status: 'sending',
      };
    }
    followStreamTail = true;
    submittedTurnFollow = true;
    input.value = '';
    attachments = [];
    mentionedFiles.clear();
    closeSuggestions();
    renderAttachmentTray();
    autoSizeInput();
    // Give Safari one compositor frame to paint the sending state before the
    // potentially expensive history reconciliation. The request is already in
    // flight, so this does not add transport latency.
    await new Promise((resolve) => {
      const fallback = setTimeout(resolve, 48);
      requestAnimationFrame(() => {
        clearTimeout(fallback);
        resolve();
      });
    });
    renderedSignature = '';
    if (lastConversation) render(lastConversation);
    snapMessagesToLatest();
    closeAllLists();
    setComposerExpanded(false);
    input.blur();
    sendButton.blur();
    try {
      const result = await sendRequest;
      if (result?.queued) {
        pendingMessage = undefined;
        clearTimeout(pendingAcceptanceTimer);
        const optimistic = optimisticQueuedInputs.get(requestId);
        if (optimistic) {
          optimisticQueuedInputs.delete(requestId);
          optimistic.id = result.queueId || requestId;
          optimistic.optimistic = false;
          optimisticQueuedInputs.set(optimistic.id, optimistic);
        }
      } else {
        optimisticQueuedInputs.delete(requestId);
        if (!pendingMessage) {
          pendingMessage = {
            text: pendingText, attachments: sentAttachments, fileMentions: sentFileMentions,
            sentAt: Date.now(), status: 'accepted',
          };
        }
        if (pendingMessage?.text === pendingText) pendingMessage.status = 'accepted';
        schedulePendingAcceptanceFailure(pendingText);
      }
      state.textContent = 'Queued';
      state.dataset.state = 'working';
      renderedSignature = '';
      if (lastConversation) render(lastConversation);
      void refresh();
    } catch (error) {
      submittedTurnFollow = false;
      pendingMessage = undefined;
      optimisticQueuedInputs.delete(requestId);
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
      input.focus({ preventScroll: true });
    } finally {
      submittingMessage = false;
      updateComposerAction();
    }
  });
  composer.addEventListener('focusin', (event) => {
    if (event.target === attachButton || event.target === fileInput) return;
    setComposerExpanded(true);
  });
  composer.addEventListener('focusout', () => {
    requestAnimationFrame(() => {
      if (!composer.contains(document.activeElement) && modelList.hidden && modeList.hidden && suggestions.hidden) {
        setComposerExpanded(false);
      }
    });
  });
  input.addEventListener('input', () => {
    autoSizeInput();
    updateSuggestions();
  });
  input.addEventListener('click', updateSuggestions);
  attachButton.addEventListener('pointerdown', (event) => {
    // Do not let the attach control steal textarea focus before iOS opens its
    // native picker. This keeps the software keyboard and expanded composer
    // state intact for people who were already typing, just like Model/Mode.
    attachmentPickerState = { restoreFocus: document.activeElement === input };
    event.preventDefault();
  });
  attachButton.addEventListener('click', () => {
    attachmentPickerState ??= { restoreFocus: document.activeElement === input };
    fileInput.click();
  });
  function restoreComposerAfterAttachmentPicker() {
    const restoreFocus = attachmentPickerState?.restoreFocus ?? document.activeElement === input;
    attachmentPickerState = undefined;
    setComposerExpanded(restoreFocus);
    if (restoreFocus) input.focus({ preventScroll: true });
  }
  fileInput.addEventListener('change', async () => {
    const files = [...fileInput.files].slice(0, Math.max(0, 8 - attachments.length));
    fileInput.value = '';
    if (!files.length || !sessionName) {
      restoreComposerAfterAttachmentPicker();
      return;
    }
    const pendingUploads = files.map((file) => ({
      file,
      upload: {
        id: crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        name: file.name || 'Attachment', progress: 0, status: 'uploading', error: '',
        controller: new AbortController(),
      },
    }));
    uploadingAttachments += pendingUploads.length;
    for (const { upload } of pendingUploads) attachmentUploads.set(upload.id, upload);
    renderAttachmentTray();
    autoSizeInput();
    // The native picker temporarily owns focus. Restore the pre-picker input
    // state while this trusted change event is active so iOS keeps/reopens the
    // keyboard only for people who were already typing.
    restoreComposerAfterAttachmentPicker();
    for (const { file, upload } of pendingUploads) {
      try {
        attachments.push(await uploadAttachment(sessionName, file, (progress) => {
          upload.progress = progress;
          renderAttachmentTray();
        }, { signal: upload.controller.signal }));
        attachmentUploads.delete(upload.id);
      } catch (error) {
        if (upload.controller.signal.aborted || error?.name === 'AbortError') {
          attachmentUploads.delete(upload.id);
        } else {
          upload.status = 'error';
          upload.error = error.message || 'Upload failed';
          state.textContent = upload.error;
          state.dataset.state = 'error';
        }
      } finally {
        uploadingAttachments -= 1;
        renderAttachmentTray();
        autoSizeInput();
      }
    }
  });
  fileInput.addEventListener('cancel', restoreComposerAfterAttachmentPicker);
  function retainComposerInputFocus(event) {
    if (document.activeElement !== input) return;
    // Picker controls must remain usable without dismissing the iOS keyboard.
    // Cancelling the pointer's default focus transfer keeps the textarea and
    // selection intact; the buttons' click events still perform the choice.
    event.preventDefault();
  }
  modelButton.addEventListener('pointerdown', retainComposerInputFocus);
  modeButton.addEventListener('pointerdown', retainComposerInputFocus);
  modelList.addEventListener('pointerdown', retainComposerInputFocus);
  modeList.addEventListener('pointerdown', retainComposerInputFocus);
  modelButton.addEventListener('click', () => {
    if (modelButton.disabled) return;
    const keepComposerFocused = document.activeElement === input;
    const opening = modelList.hidden;
    closeAuxiliaryLists();
    closeSuggestions();
    if (opening && lastConversation?.controls?.model) paintModelOptions(lastConversation.controls.model);
    modelList.hidden = !opening;
    modelButton.setAttribute('aria-expanded', String(opening));
    if (opening && !keepComposerFocused) {
      modelList.querySelector('[aria-selected="true"]')?.focus({ preventScroll: true });
    }
  });
  function toggleAuxiliaryList(button, list) {
    if (button.disabled) return;
    const keepComposerFocused = document.activeElement === input;
    const opening = list.hidden;
    closeAllLists();
    list.hidden = !opening;
    button.setAttribute('aria-expanded', String(opening));
    if (opening && !keepComposerFocused) {
      list.querySelector('[aria-selected="true"]')?.focus({ preventScroll: true });
    }
  }
  modeButton.addEventListener('click', () => toggleAuxiliaryList(modeButton, modeList));
  menu.addEventListener('click', () => {
    const workspace = document.querySelector('.workspace');
    document.querySelector(workspace?.dataset.sidebar === 'collapsed' ? '#open-sidebar' : '#toggle-sidebar')?.click();
  });
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
  const markReaderScrollGesture = () => {
    readerScrollGesture = true;
    clearTimeout(readerScrollGestureTimer);
    readerScrollGestureTimer = setTimeout(() => { readerScrollGesture = false; }, 180);
  };
  messages.addEventListener('scroll', () => {
    const atBottom = distanceFromBottom(messages) <= 48;
    if (atBottom) followStreamTail = true;
    // Layout, focus, and visualViewport changes can all dispatch scroll without
    // reader intent. Only an actual wheel/touch/pointer gesture may release the
    // tail; this keeps a browser-created focus jump from becoming permanent.
    else if (!submittedTurnFollow && readerScrollGesture) followStreamTail = false;
    updateJumpToLatest();
  }, { passive: true });
  const releaseSubmittedTailFollow = () => {
    submittedTurnFollow = false;
    followStreamTail = distanceFromBottom(messages) <= 48;
  };
  messages.addEventListener('wheel', (event) => {
    markReaderScrollGesture();
    releaseSubmittedTailFollow();
    if (!event.deltaY || !(event.target instanceof Element)) return;
    const canMove = (node) => event.deltaY > 0
      ? node.scrollTop + node.clientHeight < node.scrollHeight - 1
      : node.scrollTop > 1;
    let node = event.target;
    let exhaustedNestedScroller = false;
    while (node && node !== messages) {
      const overflowY = getComputedStyle(node).overflowY;
      if (/^(auto|scroll)$/.test(overflowY) && node.scrollHeight > node.clientHeight + 1) {
        if (canMove(node)) return;
        exhaustedNestedScroller = true;
      }
      node = node.parentElement;
    }
    if (!exhaustedNestedScroller || !canMove(messages)) return;
    // Chromium does not always chain a wheel gesture through two exhausted
    // nested panes. Forward the remaining delta to the conversation so the
    // pointer never has to leave an expanded tool to continue scrolling.
    event.preventDefault();
    messages.scrollTop += event.deltaY;
  }, { passive: false, capture: true });
  messages.addEventListener('touchmove', () => {
    markReaderScrollGesture();
    releaseSubmittedTailFollow();
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
    setComposerExpanded(false);
    mentionedFiles.clear();
    threadId = undefined;
    renderedSignature = '';
    if (media.matches && sessionName) {
      setBooting(true);
      messages.replaceChildren();
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
      submittedTurnFollow = false;
      browserAvailable = false;
      dismissedActivitySnapshot = loadDismissedActivitySnapshot(nextSessionName);
      pillDismissed = Boolean(dismissedActivitySnapshot);
      dismissedPlanRevision = loadDismissedPlanRevision(nextSessionName);
      clearSubagentPill();
      parentId = undefined;
      providerId = undefined;
      pendingMessage = undefined;
      optimisticQueuedInputs.clear();
      cancellingTurn = false;
      historyPrependAnchor = undefined;
      interactionMotionKey = '';
      pendingPlanReviews.clear();
      attachments = [];
      attachmentUploads.clear();
      mentionedFiles.clear();
      uploadingAttachments = 0;
      renderAttachmentTray();
      lastConversation = undefined;
      renderedSignature = '';
      modelOptionsSignature = '';
      closeAllLists();
      setComposerExpanded(false);
      title.textContent = 'New Grok chat';
      meta.textContent = 'Starting ACP session';
      state.textContent = 'Connecting';
      state.dataset.state = 'working';
      setBooting(true);
      composer.hidden = false;
      context.hidden = true;
      modelButton.hidden = true;
      modeButton.hidden = true;
      queue.hidden = true;
      queue.replaceChildren();
      interactionDock.hidden = true;
      root.dataset.interaction = 'false';
      interactionDock.replaceChildren();
      back.hidden = true;
      jumpToLatest.hidden = true;
      messages.replaceChildren();
      setAvailable(true);
    },
    select(nextSessionName, { expected = false } = {}) {
      const wasExpected = expectedConversation;
      expectedConversation = Boolean(expected);
      if (sessionName === (nextSessionName || undefined)) {
        // Session metadata is hydrated independently from the initial list.
        // If this same session is newly identified as Grok after an early 404,
        // reclaim the opaque native surface synchronously instead of allowing
        // a terminal frame to appear until the next workspace refresh.
        if (expectedConversation && !wasExpected && media.matches && !available) {
          generation += 1;
          setBooting(true);
          jumpToLatest.hidden = true;
          messages.replaceChildren();
          setAvailable(true);
          void refresh();
        }
        return;
      }
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
      submittedTurnFollow = false;
      browserAvailable = false;
      dismissedActivitySnapshot = loadDismissedActivitySnapshot(sessionName);
      pillDismissed = Boolean(dismissedActivitySnapshot);
      dismissedPlanRevision = loadDismissedPlanRevision(sessionName);
      clearSubagentPill();
      parentId = undefined;
      providerId = undefined;
      pendingMessage = undefined;
      optimisticQueuedInputs.clear();
      cancellingTurn = false;
      interactionMotionKey = '';
      pendingPlanReviews.clear();
      attachments = [];
      attachmentUploads.clear();
      mentionedFiles.clear();
      uploadingAttachments = 0;
      renderAttachmentTray();
      clearTimeout(pendingAcceptanceTimer);
      clearTimeout(suggestionTimer);
      lastConversation = undefined;
      renderedSignature = '';
      modelOptionsSignature = '';
      closeAllLists();
      setComposerExpanded(false);
      interactionDock.hidden = true;
      root.dataset.interaction = 'false';
      interactionDock.replaceChildren();
      composer.hidden = false;
      context.hidden = true;
      modelButton.hidden = true;
      modeButton.hidden = true;
      queue.hidden = true;
      queue.replaceChildren();
      if (!sessionName || !media.matches) {
        setBooting(false);
        return setAvailable(false);
      }
      const cached = conversationCache.get(sessionName);
      if (cached) {
        conversationCache.delete(sessionName);
        conversationCache.set(sessionName, cached);
        providerId = cached.provider?.id;
        threadId = cached.thread?.id;
        rootThreadId = cached.rootThreadId || cached.thread?.id;
        setAvailable(true);
        setBooting(false);
        render(cached);
        startStream();
        return;
      }
      setBooting(true);
      jumpToLatest.hidden = true;
      messages.replaceChildren();
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
    invalidate(name) {
      if (!name) return;
      conversationCache.delete(name);
      historyLimits.delete(name);
      if (name !== sessionName) return;
      generation += 1;
      clearTimeout(refreshTimer);
      closeStream();
      threadId = undefined;
      rootThreadId = undefined;
      rootConversation = undefined;
      lastConversation = undefined;
      renderedSignature = '';
      if (!media.matches) return;
      setBooting(true);
      jumpToLatest.hidden = true;
      messages.replaceChildren();
      setAvailable(true);
      void refresh();
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
      clearTimeout(readerScrollGestureTimer);
      releaseMainScrollGeometryLock();
      mainScrollGeometryObserver.disconnect();
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
