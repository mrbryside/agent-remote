import { markdownNode } from './markdown.js';
import { createMobileActivityStore, hasActivityAfterDismissal as activityChanged } from './mobile-activity-state.js';
import {
  composerCompletion as detectComposerCompletion,
  rankedCommands,
  shellComposerMessage,
  shellComposerState,
} from './mobile-composer-model.js';
import { createTimelineReconciler } from './mobile-timeline-reconciler.js';
import { createCompactStreamBatcher, preserveNewerStreamingText } from './mobile-stream-batcher.js';
import { createMobileSheetFrame, installMobileSheetDrag } from './mobile-sheet.js';
import {
  createMobileFileSurface,
} from './mobile-file-surface.js';
import { createMobileEventRenderer } from './mobile-event-renderer.js';
import { createMobileInteractionRenderer } from './mobile-interaction-renderer.js';
import { pendingMessageMatchesItem } from './mobile-pending-message.js';
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

export function disclosureNeedsReveal(panel, messages) {
  if (!panel?.isConnected || !messages?.isConnected) return false;
  const panelBox = panel.getBoundingClientRect();
  const messagesBox = messages.getBoundingClientRect();
  const viewport = window.visualViewport;
  let visibleBottom = Math.min(
    messagesBox.bottom,
    viewport ? viewport.offsetTop + viewport.height : window.innerHeight,
  );
  let ancestor = panel.parentElement?.closest('.mobile-tool-group-panel:not([hidden])');
  while (ancestor) {
    visibleBottom = Math.min(visibleBottom, ancestor.getBoundingClientRect().bottom);
    ancestor = ancestor.parentElement?.closest('.mobile-tool-group-panel:not([hidden])');
  }
  return panelBox.bottom > visibleBottom + 1;
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
  const shellPrefix = document.querySelector('#mobile-conversation-shell-prefix');
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
  let refreshRevision = 0;
  let refreshTimer;
  let foregroundResumeTimer;
  let foregroundProbeTimer;
  let lastForegroundProbeAt = Date.now();
  let streamWatchdogTimer;
  let streamSocket;
  let streamKey = '';
  let backgrounded = document.visibilityState === 'hidden';
  let renderedSignature = '';
  let pendingMessage;
  let retryMessage;
  let shellMode = false;
  const reconciledPendingRequests = new Set();
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
  let sheetBody;
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
  let deferredConversationPayload;
  let compactMessageId;
  const compactStreamBatcher = createCompactStreamBatcher({
    // Safari can defer requestAnimationFrame while native chrome, scrolling,
    // or a backgrounded webview owns the visual frame. A short render cadence
    // still yields between WebSocket bursts and remains fast enough to look
    // continuous without reparsing Markdown for every token.
    requestFrame: (callback) => setTimeout(callback, 32),
    cancelFrame: (frame) => clearTimeout(frame),
    onFlush: (stream) => {
      if (!applyStreamTextDelta(undefined, stream)) schedule(0);
    },
    onIdle: () => {
      if (!deferredConversationPayload) return;
      const payload = deferredConversationPayload;
      deferredConversationPayload = undefined;
      applyFullConversationPayload(payload);
    },
  });
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
  let submittingRequest;
  let cancellingTurn = false;
  let acceptedCancellation;
  let interactionMotionKey = '';
  let attachments = [];
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
    openMedia: openMediaAttachment,
  } = fileSurface;
  const {
    eventNode,
    permissionDockNode,
    toolGroupNode,
    turnNode,
  } = createMobileEventRenderer({
    fileSurface,
    expandedItems,
    autoExpandedItems,
    initializeDisclosure,
    animateDisclosure,
    revealDisclosure,
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
    if (shellMode) return closeSuggestions();
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
    compactStreamBatcher.discard();
    deferredConversationPayload = undefined;
    compactMessageId = undefined;
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
    refreshRevision += 1;
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
      refreshRevision += 1;
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
    else resumeFromBackground({ force: true });
  }

  function handlePageShow() {
    resumeFromBackground({ force: true });
  }

  function handleWindowFocus() {
    resumeFromBackground({ force: true });
  }

  function handleOnline() {
    resumeFromBackground({ force: true });
  }

  function probeForegroundLiveness() {
    const now = Date.now();
    const frozen = now - lastForegroundProbeAt > 6_000;
    lastForegroundProbeAt = now;
    if (document.visibilityState === 'hidden' || !media.matches || !sessionName) return;
    // Mobile Safari can freeze the page without dispatching visibilitychange,
    // pagehide, blur, or a websocket close. A resumed timer is the final
    // lifecycle signal in that case, so force the same snapshot-first repair.
    if (backgrounded || frozen) resumeFromBackground({ force: true });
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

  function normalizeStreamingMarkdownSource(source) {
    let markdown = String(source || '');
    // Some Grok ACP versions omit newline-only chunks from the live stream,
    // then restore them in the completed replay. Recover only unambiguous
    // ordered-list boundaries for the streaming presentation so `1.`, `2.`,
    // ... render as a growing list instead of one long paragraph. Keep the
    // canonical raw text separately; the final provider snapshot still wins.
    markdown = markdown.replace(
      /((?:here (?:are|is)|sentences?|items?|steps?|examples?|reasons?|following|below)[^:\n]{0,96}:)(?=1[.)]\s)/i,
      '$1\n\n',
    );
    return markdown.replace(/[.!?](?:["')\]]?)(?=\d{1,4}[.)]\s)/g,
      (boundary, offset, text) => boundary[0] === '.' && /\d/.test(text[offset - 1] || '')
        ? boundary : `${boundary}\n`);
  }

  function suffixCompletesCollapsedOrderedMarker(previousText, suffix) {
    const previousTail = previousText.slice(-32);
    const combined = `${previousTail}${suffix}`;
    const boundary = previousTail.length;
    const patterns = [/[.!?](?:["')\]]?)?\d{1,4}[.)]\s/g, /:\s*1[.)]\s/g];
    return patterns.some((pattern) => [...combined.matchAll(pattern)]
      .some((match) => match.index + match[0].length > boundary));
  }

  function streamNeedsMarkdownParse(previousText, suffix) {
    if (/[\n*_`\[\]()#>|~]/.test(suffix)) return true;
    if (suffixCompletesCollapsedOrderedMarker(previousText, suffix)) return true;
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

  function animateStreamingElement(node) {
    if (!(node instanceof HTMLElement)) return;
    node.classList.add('mobile-stream-block-enter');
    const settle = () => node.classList.remove('mobile-stream-block-enter');
    node.addEventListener('animationend', settle, { once: true });
    node.addEventListener('animationcancel', settle, { once: true });
  }

  function markNewStreamingElements(currentParent, freshParent) {
    const currentChildren = [...currentParent.children];
    const freshChildren = [...freshParent.children];
    const sharedLength = Math.min(currentChildren.length, freshChildren.length);
    for (let index = 0; index < sharedLength; index += 1) {
      const current = currentChildren[index];
      const fresh = freshChildren[index];
      if (current.tagName === fresh.tagName) markNewStreamingElements(current, fresh);
      else animateStreamingElement(fresh);
    }
    for (let index = sharedLength; index < freshChildren.length; index += 1) {
      animateStreamingElement(freshChildren[index]);
    }
  }

  function streamingTextNode(text) {
    const span = document.createElement('span');
    span.className = 'mobile-stream-text-enter';
    span.textContent = text;
    const settle = () => {
      if (!span.isConnected) return;
      const parent = span.parentNode;
      span.replaceWith(...span.childNodes);
      parent?.normalize();
    };
    span.addEventListener('animationend', settle, { once: true });
    span.addEventListener('animationcancel', settle, { once: true });
    return span;
  }

  function reparseStreamingMarkdown(content, nextText) {
    const fresh = markdownNode(normalizeStreamingMarkdownSource(nextText), {
      onFileReference: (reference) => void openFileReference(reference),
    });
    const scroll = captureStreamScroll(content);
    markNewStreamingElements(content, fresh);
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
      const addition = streamingTextNode(`${collapsedBoundary}${suffix}`);
      if (lastText) {
        const animatedText = lastText.parentElement?.closest('.mobile-stream-text-enter');
        const anchor = animatedText && tail.contains(animatedText) ? animatedText : lastText;
        anchor.parentNode?.insertBefore(addition, anchor.nextSibling);
      } else content.append(addition);
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
    if (!next || !previous) return false;
    const source = conversation || lastConversation;
    const isRoot = !source.parent && currentThreadId === rootThreadId;
    const targetMessages = isRoot ? messages : sheetMessages || messages;
    const article = [...targetMessages.querySelectorAll('.mobile-message')]
      .find((node) => node.dataset.messageId === next.id);
    const content = article?.querySelector(':scope > .mobile-message-content[data-streaming="true"]');
    const previousText = compact ? content?.__mobileRawText : previous.text;
    if (typeof previousText !== 'string') return false;
    const nextText = compact ? `${previousText}${stream.delta || ''}` : next.text;
    if (typeof nextText !== 'string' || !nextText.startsWith(previousText)) return false;
    const suffix = nextText.slice(previousText.length);
    if (!suffix) return false;
    if (!content || content.__mobileRawText !== previousText) return false;

    const atBottom = distanceFromBottom(targetMessages) <= 48;
    appendStreamingMarkdown(content, nextText);
    if (compact) {
      previous.text = nextText;
      compactMessageId = next.id;
    }
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

  function applyFullConversationPayload(payload) {
    if (payload.conversation) providerId = payload.conversation.provider.id;
    compactStreamBatcher.discard();
    if (!applyStreamTextDelta(payload.conversation, payload.stream)) {
      if (payload.conversation) render(payload.conversation, { animate: true, fromStream: true });
      else schedule(0);
    }
    setBooting(false);
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
    const frame = createMobileSheetFrame({
      root,
      element,
      label: 'Activity details',
      handleLabel: 'Drag down to close activity',
      classNames: {
        sheet: 'mobile-subagent-sheet',
        panel: 'mobile-subagent-sheet-panel',
        handle: 'mobile-subagent-sheet-handle',
        header: 'mobile-subagent-sheet-header',
        body: 'mobile-subagent-sheet-body',
      },
    });
    sheet = frame.sheet;
    sheetPanel = frame.panel;
    sheetHandle = frame.handle;
    const { header } = frame.slots;
    sheetBody = frame.slots.body;
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
    sheetBody.append(sheetList, sheetMessages);
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
    installMobileSheetDrag({ panel: sheetPanel, handle: sheetHandle, onClose: closeSheet, threshold: 54 });
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
          // A socket event is newer than any HTTP snapshot already in flight.
          // Safari may release an old fetch after foregrounding; never let it
          // roll the live turn back to a stale Streaming state.
          refreshRevision += 1;
          const payloadThreadId = payload.conversation?.thread?.id || payload.stream?.threadId;
          if (payloadThreadId !== threadId) return;
          if (!payload.conversation && payload.stream?.kind === 'agent_message_chunk') {
            // Claim text ownership as soon as the compact frame arrives, not
            // after its visual batch paints. A fallback snapshot can land in
            // that short window and otherwise seed the message with stale,
            // partially replayed text that later deltas cannot repair.
            compactMessageId = payload.stream.messageId;
            compactStreamBatcher.push(payload.stream);
            setBooting(false);
            return;
          }
          // ACP can deliver a turn's token frames as one WebSocket burst. Let
          // the bounded visual queue paint those exact suffixes before the
          // authoritative completion snapshot settles the message.
          if (payload.conversation && compactStreamBatcher.hasPending()) {
            deferredConversationPayload = payload;
            setBooting(false);
            return;
          }
          applyFullConversationPayload(payload);
          return;
        }
        if (payload?.type === 'control' && payload.action === 'open-graphics' &&
            Array.isArray(payload.argv) && payload.argv.length > 0 && payload.argv.length <= 100 &&
            payload.argv.every((argument) => typeof argument === 'string' && argument.length <= 4096)) {
          clearActivityDismissal();
          browserAvailable = true;
          renderSubagentPill(rootConversation || { items: [] });
          onBrowserOpen(sessionName, payload.argv, {
            reuseExisting: payload.reuseExisting === true,
          });
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
    const name = attachment.name || 'Attachment';
    const mimeType = attachment.mimeType || '';
    const isImage = /^image\/(?:png|jpeg|webp|gif)$/i.test(mimeType);
    const isVideo = /^video\//i.test(mimeType);
    const previewUrl = attachment.previewUrl ? apiUrl(attachment.previewUrl) : '';
    if ((isImage || isVideo) && previewUrl) {
      const preview = element('button', 'mobile-conversation-attachment-preview');
      preview.type = 'button';
      preview.setAttribute('aria-label', `View ${name}`);
      const media = document.createElement(isVideo ? 'video' : 'img');
      media.className = 'mobile-conversation-attachment-media';
      const nameLabel = element('small', 'mobile-conversation-attachment-name', name);
      media.src = previewUrl;
      if (isVideo) {
        media.muted = true;
        media.playsInline = true;
        media.preload = 'metadata';
        media.setAttribute('aria-hidden', 'true');
      } else {
        media.alt = '';
        media.decoding = 'async';
      }
      const showNameOnly = () => {
        item.dataset.preview = 'fallback';
        media.remove();
        preview.append(element('span', 'mobile-conversation-attachment-media mobile-conversation-attachment-placeholder'));
      };
      media.addEventListener('error', showNameOnly, { once: true });
      preview.addEventListener('pointerdown', retainComposerInputFocus);
      preview.addEventListener('click', () => openMediaAttachment({
        selectedId: attachment.id,
        items: attachments
          .filter((value) => /^(?:image|video)\//i.test(value.mimeType || '') && value.previewUrl)
          .map((value) => ({
            id: value.id,
            name: value.name || 'Attachment',
            mimeType: value.mimeType || '',
            url: apiUrl(value.previewUrl),
          })),
      }));
      preview.append(media);
      item.append(preview, nameLabel);
    } else {
      item.dataset.preview = 'fallback';
      item.append(
        element('span', 'mobile-conversation-attachment-media mobile-conversation-attachment-placeholder'),
        element('small', 'mobile-conversation-attachment-name', name),
      );
    }
    if (removable) {
      const remove = createIconButton({
        className: 'mobile-conversation-attachment-remove close-button close-button--destructive', label: `Remove ${name}`,
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
    const actions = element('div', 'mobile-conversation-upload-actions');
    if (upload.status === 'uploading' || upload.status === 'cancelling') {
      const action = createIconButton({
        className: 'close-button', label: 'Manage upload', glyph: '×', variant: 'bare', size: 'xs',
      });
      action.addEventListener('pointerdown', retainComposerInputFocus);
      action.setAttribute('aria-label', `Cancel upload ${upload.name}`);
      action.disabled = upload.status === 'cancelling';
      action.addEventListener('click', () => {
        upload.status = 'cancelling';
        upload.controller?.abort();
        renderAttachmentTray();
      });
      actions.append(action);
    } else {
      const retry = element('button', 'mobile-conversation-upload-retry', 'Retry');
      retry.type = 'button';
      retry.setAttribute('aria-label', `Retry upload ${upload.name}`);
      retry.addEventListener('pointerdown', retainComposerInputFocus);
      retry.addEventListener('click', () => void runAttachmentUpload(upload));
      const dismiss = createIconButton({
        className: 'close-button', label: `Dismiss upload error for ${upload.name}`,
        glyph: '×', variant: 'bare', size: 'xs',
      });
      dismiss.addEventListener('pointerdown', retainComposerInputFocus);
      dismiss.addEventListener('click', () => {
        attachmentUploads.delete(upload.id);
        renderAttachmentTray();
      });
      actions.append(retry, dismiss);
    }
    item.append(actions);
    return item;
  }

  function abortAttachmentUploads() {
    for (const upload of attachmentUploads.values()) upload.controller?.abort();
    attachmentUploads.clear();
  }

  async function runAttachmentUpload(upload) {
    if (!attachmentUploads.has(upload.id)) return;
    upload.status = 'uploading';
    upload.error = '';
    upload.progress = 0;
    upload.controller = new AbortController();
    renderAttachmentTray();
    try {
      const attachment = await uploadAttachment(upload.sessionName, upload.file, (progress) => {
        if (!attachmentUploads.has(upload.id)) return;
        upload.progress = progress;
        renderAttachmentTray();
      }, { signal: upload.controller.signal });
      if (sessionName !== upload.sessionName || generation !== upload.generation ||
          !attachmentUploads.has(upload.id)) return;
      attachments.push(attachment);
      attachmentUploads.delete(upload.id);
    } catch (error) {
      if (upload.controller.signal.aborted || error?.name === 'AbortError') {
        attachmentUploads.delete(upload.id);
      } else if (sessionName === upload.sessionName && generation === upload.generation &&
          attachmentUploads.has(upload.id)) {
        upload.status = 'error';
        upload.error = error.message || 'Upload failed';
        state.textContent = upload.error;
        state.dataset.state = 'error';
      }
    } finally {
      renderAttachmentTray();
      autoSizeInput();
    }
  }

  function renderAttachmentTray() {
    attachmentTray.hidden = attachments.length === 0 && attachmentUploads.size === 0;
    const fragment = document.createDocumentFragment();
    for (const attachment of attachments) fragment.append(attachmentNode(attachment, { removable: true }));
    for (const upload of attachmentUploads.values()) fragment.append(attachmentUploadNode(upload));
    attachmentTray.replaceChildren(fragment);
    attachButton.disabled = attachmentUploads.size > 0 || attachments.length >= 8;
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

  function disclosureBlockBox(style, collapsed = false) {
    if (collapsed) {
      // A bordered box cannot render shorter than its borders even at height
      // zero. Offset that transient residue so hiding it cannot move the group
      // in one final frame after the height animation has already settled.
      const borderHeight = (Number.parseFloat(style.borderTopWidth) || 0) +
        (Number.parseFloat(style.borderBottomWidth) || 0);
      return {
        marginTop: '0px',
        marginBottom: `${-borderHeight}px`,
        paddingTop: '0px',
        paddingBottom: '0px',
      };
    }
    return {
      marginTop: style.marginTop,
      marginBottom: style.marginBottom,
      paddingTop: style.paddingTop,
      paddingBottom: style.paddingBottom,
    };
  }

  function animateDisclosure(toggle, panel, open) {
    toggle.setAttribute('aria-expanded', String(open));
    panel.setAttribute('aria-hidden', String(!open));
    panel.inert = !open;
    const active = disclosureMotions.get(panel);
    const wasHidden = panel.hidden;
    const currentStyle = wasHidden ? undefined : getComputedStyle(panel);
    const currentHeight = panel.hidden ? 0 : panel.getBoundingClientRect().height;
    const parsedOpacity = currentStyle ? Number.parseFloat(currentStyle.opacity) : 0;
    const currentOpacity = Number.isFinite(parsedOpacity) ? parsedOpacity : 1;
    const currentBox = currentStyle ? disclosureBlockBox(currentStyle) : undefined;
    active?.animation.cancel();

    if (open) panel.hidden = false;
    if (reducedMotion() || typeof panel.animate !== 'function') {
      panel.hidden = !open;
      panel.removeAttribute('data-disclosure-motion');
      disclosureMotions.delete(panel);
      return Promise.resolve(open);
    }

    const targetHeight = open ? panel.getBoundingClientRect().height : 0;
    const targetOpacity = open ? 1 : 0;
    panel.dataset.disclosureMotion = open ? 'opening' : 'closing';
    const style = getComputedStyle(panel);
    const targetBox = disclosureBlockBox(style, !open);
    const startBox = currentBox || disclosureBlockBox(style, true);
    const animation = panel.animate([
      {
        height: `${currentHeight}px`, opacity: currentOpacity,
        transform: open ? 'translateY(-3px)' : 'translateY(0)',
        ...startBox,
      },
      {
        height: `${targetHeight}px`, opacity: targetOpacity,
        transform: open ? 'translateY(0)' : 'translateY(-3px)',
        ...targetBox,
      },
    ], {
      duration: motionDuration(panel, '--duration-normal', 220),
      easing: style.getPropertyValue('--ease-out').trim() || 'cubic-bezier(.2, .8, .2, 1)',
      fill: 'both',
    });
    const motion = { animation, open };
    disclosureMotions.set(panel, motion);
    return animation.finished.then(() => {
      if (disclosureMotions.get(panel) !== motion) return false;
      if (!open) panel.hidden = true;
      panel.removeAttribute('data-disclosure-motion');
      disclosureMotions.delete(panel);
      animation.cancel();
      return open;
    }).catch(() => false);
  }

  function revealDisclosure(toggle, panel) {
    requestAnimationFrame(() => {
      if (!toggle.isConnected || panel.hidden || toggle.getAttribute('aria-expanded') !== 'true') return;
      if (!disclosureNeedsReveal(panel, messages)) return;
      const localViewport = panel.closest('.mobile-tool-group-panel:not([hidden])') || messages;
      const availableHeight = Math.max(0, localViewport.clientHeight - 16);
      const target = panel.scrollHeight + toggle.offsetHeight > availableHeight ? toggle : panel;
      target.scrollIntoView({
        block: target === toggle ? 'start' : 'nearest',
        inline: 'nearest',
        behavior: reducedMotion() ? 'auto' : 'smooth',
      });
    });
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

  function schedulePendingAcceptanceFailure(requestId) {
    clearTimeout(pendingAcceptanceTimer);
    pendingAcceptanceTimer = setTimeout(() => {
      if (pendingMessage?.requestId !== requestId || pendingMessage.status !== 'accepted') return;
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
            requestId: `steer:${entry.id}`, text: pendingText, displayText: pendingText,
            attachments: [], fileMentions: [],
            sentAt: Date.now(), status: 'accepted', source: 'steer', queueId: entry.id,
          };
          schedulePendingAcceptanceFailure(`steer:${entry.id}`);
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

  function uploadedMediaPreview(target) {
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
    const mediaItems = (Array.isArray(item.attachments) ? item.attachments : []).flatMap((attachment) => {
      if (!/^(?:image\/(?:png|jpeg|webp|gif)|video\/)/i.test(attachment?.mimeType || '') || !attachment.previewUrl) return [];
      return [{ id: attachment.id, name: attachment.name || 'Attachment', mimeType: attachment.mimeType, url: apiUrl(attachment.previewUrl) }];
    });
    let visibleText = String(item.text || '');
    visibleText = visibleText.replace(/!?\[([^\]\n]*)\]\(([^)\n]+)\)/g, (source, label, target) => {
      const url = uploadedMediaPreview(target);
      const fileName = decodeURIComponent(String(target).split('/').at(-1) || 'Attachment');
      const extension = fileName.split('.').at(-1)?.toLowerCase();
      const isVideo = /^(?:mov|mp4|m4v|webm|avi|mkv)$/.test(extension || '');
      const isImage = /^(?:png|jpe?g|webp|gif|svg|avif)$/.test(extension || '');
      const mimeType = isVideo ? 'video/*' : 'image/*';
      if (!url || (!isImage && !isVideo)) return source;
      if (!mediaItems.some((item) => item.url === url)) {
        mediaItems.push({ name: label.trim() || fileName, mimeType, url });
      }
      return '';
    }).replace(/\n{3,}/g, '\n\n').trim();
    const attachmentDisplayNames = (Array.isArray(item.attachments) ? item.attachments : [])
      .map((attachment) => attachment?.name || 'Attachment')
      .join(', ');
    if (attachmentDisplayNames && visibleText === attachmentDisplayNames) visibleText = '';
    if (!mediaItems.length) {
      content.textContent = visibleText;
      return content;
    }
    const gallery = element('div', 'mobile-message-user-attachments');
    if (mediaItems.length > 1) gallery.dataset.count = String(mediaItems.length);
    for (const mediaItem of mediaItems.slice(0, 1)) {
      const trigger = element('button', 'mobile-message-user-attachment');
      trigger.type = 'button';
      trigger.setAttribute('aria-label', mediaItems.length > 1
        ? `View ${mediaItems.length} attachments`
        : `View ${mediaItem.name}`);
      const isVideo = /^video\//i.test(mediaItem.mimeType || '');
      const preview = document.createElement(isVideo ? 'video' : 'img');
      preview.className = 'mobile-message-user-attachment-media';
      preview.src = mediaItem.url;
      preview.loading = 'lazy';
      if (isVideo) {
        preview.muted = true;
        preview.playsInline = true;
        preview.preload = 'metadata';
        preview.setAttribute('aria-hidden', 'true');
      } else {
        preview.alt = mediaItem.name;
        preview.decoding = 'async';
      }
      preview.addEventListener('error', () => {
        trigger.dataset.preview = 'fallback';
        preview.remove();
      }, { once: true });
      trigger.addEventListener('click', () => openMediaAttachment({
        selectedId: mediaItem.id,
        items: mediaItems,
      }));
      trigger.append(preview, element('small', '', mediaItem.name));
      if (mediaItems.length > 1) trigger.append(element('b', 'mobile-message-user-attachment-count', `+${mediaItems.length - 1}`));
      gallery.append(trigger);
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
          const content = markdownNode(normalizeStreamingMarkdownSource(item.text), {
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
    if (item.type === 'turn') return turnNode(item);
    if (item.type === 'subagent') return document.createDocumentFragment();
    return eventNode(item);
  }

  const reconcileTimeline = createTimelineReconciler({ appendStreamingMarkdown, morphStreamingMarkdown });

  function render(conversation, { animate = false, fromStream = false } = {}) {
    const previousConversation = lastConversation;
    conversation = preserveNewerStreamingText(previousConversation, conversation, compactMessageId);
    acknowledgeSubmittedInput(conversation);
    if (conversation.activity?.active !== true) compactMessageId = undefined;
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
      attachmentUploads: [...attachmentUploads.values()].map(({ id, name, progress, status, error }) =>
        ({ id, name, progress, status, error })),
      questions: questionStateVersion,
      planReviews: [...pendingPlanReviews.entries()],
      submittingMessage: Boolean(submittingRequest),
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
    const pendingAlreadyStored = pendingMessage && conversation.items.some((item) =>
      pendingMessageMatchesItem(pendingMessage, item));
    const completedAfterPendingTurn = pendingMessage?.status === 'accepted' &&
      previousConversation?.activity?.active === true && conversation.activity?.active !== true;
    if (pendingAlreadyStored || completedAfterPendingTurn) {
      if (pendingMessage?.requestId) reconciledPendingRequests.add(pendingMessage.requestId);
      clearTimeout(pendingAcceptanceTimer);
      pendingMessage = undefined;
      pendingQuestions.clear();
      pendingPlanReviews.clear();
    }
    if (pendingMessage) {
      const pending = messageNode({
        id: 'pending', type: 'message', role: 'user',
        text: pendingMessage.text || pendingMessage.displayText,
        attachments: pendingMessage.attachments,
        pendingStatus: pendingMessage.status,
      }, conversation);
      pending.dataset.pending = 'true';
      if (pendingMessage.status === 'failed') {
        pending.querySelector('.mobile-message-author').textContent = 'Not received · tap to retry';
        pending.addEventListener('click', () => {
          restoreComposerDraft(pendingMessage.text || '');
          attachments = pendingMessage.attachments?.slice() || [];
          mentionedFiles.clear();
          for (const path of pendingMessage.fileMentions || []) mentionedFiles.add(path);
          retryMessage = {
            requestId: pendingMessage.requestId,
            signature: JSON.stringify({
              text: pendingMessage.text || '',
              attachmentIds: attachments.map((attachment) => attachment.id),
              fileMentions: [...mentionedFiles],
            }),
          };
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
    const currentRefreshRevision = ++refreshRevision;
    if (!media.matches || !sessionName) return setAvailable(false);
    const params = new URLSearchParams();
    if (threadId) params.set('thread', threadId);
    params.set('historyLimit', String(historyLimit()));
    const query = `?${params}`;
    try {
      const payload = await api(`/api/conversations/${encodeURIComponent(sessionName)}${query}`);
      if (currentGeneration !== generation || currentRefreshRevision !== refreshRevision) return;
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
      if (currentGeneration !== generation || currentRefreshRevision !== refreshRevision) return;
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

  function renderShellMode() {
    composer.dataset.shell = String(shellMode);
    shellPrefix.hidden = !shellMode;
    input.setAttribute('aria-label', shellMode ? 'Shell command' : 'Message');
    input.placeholder = shellMode ? '' : 'Message Grok…';
    input.setAttribute('autocapitalize', shellMode ? 'none' : 'sentences');
    input.spellcheck = !shellMode;
  }

  function setShellMode(next) {
    shellMode = Boolean(next);
    renderShellMode();
    if (shellMode) closeSuggestions();
  }

  function syncShellModeFromInput() {
    const selectionStart = input.selectionStart ?? input.value.length;
    const selectionEnd = input.selectionEnd ?? selectionStart;
    const next = shellComposerState(input.value, shellMode);
    if (next.active === shellMode && next.value === input.value) return false;
    input.value = next.value;
    setShellMode(next.active);
    const removedPrefix = selectionStart > next.value.length || selectionStart !== 0;
    const start = Math.max(0, selectionStart - (removedPrefix ? 1 : 0));
    const end = Math.max(start, selectionEnd - (removedPrefix ? 1 : 0));
    input.setSelectionRange(start, end);
    return true;
  }

  function restoreComposerDraft(value) {
    const restored = shellComposerState(value, false);
    input.value = restored.value;
    setShellMode(restored.active);
  }

  function clearComposerDraft() {
    input.value = '';
    setShellMode(false);
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
    const providerActivity = lastConversation?.activity;
    // Once the provider accepts cancellation, its prompt RPC may remain
    // internally active for a short time so queued sends stay serialized.
    // That internal drain is not a second stoppable turn: return the composer
    // to Send while the provider finishes releasing the cancelled request.
    if (acceptedCancellation && providerActivity?.active !== true) acceptedCancellation = undefined;
    if (acceptedCancellation && acceptedCancellation.turnId !== undefined &&
        providerActivity?.turnId !== undefined && acceptedCancellation.turnId !== providerActivity.turnId) {
      acceptedCancellation = undefined;
    }
    const turnActive = providerActivity?.active === true && providerActivity?.cancelRequested !== true &&
      !acceptedCancellation;
    if (!turnActive) cancellingTurn = false;
    const hasDraft = Boolean(input.value.trim() || attachments.length);
    const switchingSettings = modelBusy || controlBusy;
    const stopAction = turnActive && !hasDraft;
    const waitingAction = pendingDelivery && !turnActive && !hasDraft;
    const submittingMessage = Boolean(submittingRequest);
    // Changing model or mode only locks submission. It is not a conversation
    // turn, so keep the ordinary Send affordance instead of showing activity.
    const action = switchingSettings ? 'send'
      : cancellingTurn ? 'stopping'
        : stopAction ? 'stop' : submittingMessage ? 'sending' : waitingAction ? 'waiting' : 'send';
    sendButton.dataset.action = action;
    sendButton.textContent = action === 'send' ? '↑' : '';
    sendButton.setAttribute('aria-label', action === 'stop' ? 'Stop response'
      : action === 'stopping' ? 'Stopping response'
        : action === 'sending' ? 'Sending message'
        : action === 'waiting' ? 'Waiting for response' : 'Send message');
    sendButton.disabled = attachmentUploads.size > 0 || switchingSettings ||
      action === 'sending' || action === 'stopping' || action === 'waiting' ||
      (action === 'send' && !hasDraft);
  }

  function acknowledgeSubmittedInput(conversation) {
    const submission = submittingRequest;
    if (!submission) return;
    const activity = conversation?.activity || {};
    const queued = (conversation?.queue || []).some((entry) => entry.id === submission.id);
    const stored = pendingMessage?.requestId === submission.id &&
      (conversation?.items || []).some((item) => pendingMessageMatchesItem(pendingMessage, item));
    const changedTurn = submission.baselineTurnId !== undefined && activity.turnId !== undefined &&
      submission.baselineTurnId !== activity.turnId;
    const startedNewTurn = activity.active === true && activity.cancelRequested !== true &&
      (submission.baselineActive !== true || changedTurn ||
        (submission.baselineTurnId === undefined && submission.baselineCancelRequested === true));
    if (!queued && !stored && !startedNewTurn) return;
    submittingRequest = undefined;
    if (pendingMessage?.requestId === submission.id && pendingMessage.status === 'sending') {
      pendingMessage.status = 'accepted';
    }
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
        cancellingTurn = false;
        if (result?.accepted !== false && lastConversation?.activity?.active === true) {
          acceptedCancellation = { turnId: lastConversation.activity.turnId };
          lastConversation = {
            ...lastConversation,
            activity: {
              ...lastConversation.activity,
              phase: 'stopping',
              label: 'Stopping…',
              cancelRequested: true,
            },
          };
          if (rootConversation?.thread?.id === lastConversation.thread?.id) {
            rootConversation = lastConversation;
          }
        }
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
    const text = shellComposerMessage(input.value, shellMode);
    if ((!text && attachments.length === 0) || !sessionName || !providerId || attachmentUploads.size) return;
    const sentAttachments = attachments.slice();
    const sentFileMentions = [...mentionedFiles].filter((path) => text.includes(`@${path}`));
    const pendingText = text || sentAttachments.map((attachment) => attachment.name).join(', ');
    const requestSignature = JSON.stringify({
      text,
      attachmentIds: sentAttachments.map((attachment) => attachment.id),
      fileMentions: sentFileMentions,
    });
    const requestId = retryMessage?.signature === requestSignature
      ? retryMessage.requestId
      : crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    retryMessage = undefined;
    submittingRequest = {
      id: requestId,
      baselineActive: lastConversation?.activity?.active === true,
      baselineCancelRequested: lastConversation?.activity?.cancelRequested === true,
      baselineTurnId: lastConversation?.activity?.turnId,
    };
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
        requestId, text, displayText: pendingText, attachments: sentAttachments,
        fileMentions: sentFileMentions,
        baselineItemIds: (lastConversation?.items || []).map((item) => item.id),
        sentAt: Date.now(), status: 'sending',
      };
    }
    followStreamTail = true;
    submittedTurnFollow = true;
    clearComposerDraft();
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
        const alreadyReconciled = reconciledPendingRequests.delete(requestId);
        if (!pendingMessage && !alreadyReconciled) {
          pendingMessage = {
            requestId, text, displayText: pendingText, attachments: sentAttachments,
            fileMentions: sentFileMentions,
            baselineItemIds: (lastConversation?.items || []).map((item) => item.id),
            sentAt: Date.now(), status: 'accepted',
          };
        }
        if (pendingMessage?.requestId === requestId) pendingMessage.status = 'accepted';
        if (pendingMessage?.requestId === requestId) schedulePendingAcceptanceFailure(requestId);
      }
      state.textContent = 'Queued';
      state.dataset.state = 'working';
      renderedSignature = '';
      if (lastConversation) render(lastConversation);
      void refresh();
    } catch (error) {
      submittedTurnFollow = false;
      pendingMessage = undefined;
      reconciledPendingRequests.delete(requestId);
      optimisticQueuedInputs.delete(requestId);
      attachments = [];
      renderAttachmentTray();
      pendingQuestions.clear();
      pendingPlanReviews.clear();
      restoreComposerDraft(text);
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
      if (submittingRequest?.id === requestId) submittingRequest = undefined;
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
    syncShellModeFromInput();
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
  async function enqueueAttachmentFiles(selectedFiles) {
    const files = [...selectedFiles]
      .filter((file) => file && typeof file.size === 'number')
      .slice(0, Math.max(0, 8 - attachments.length - attachmentUploads.size));
    if (!files.length || !sessionName) return;
    const uploadSessionName = sessionName;
    const uploadGeneration = generation;
    const pendingUploads = files.map((file) => ({
        id: crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        name: file.name || 'Attachment', progress: 0, status: 'uploading', error: '',
        controller: new AbortController(), file, sessionName: uploadSessionName, generation: uploadGeneration,
    }));
    for (const upload of pendingUploads) attachmentUploads.set(upload.id, upload);
    renderAttachmentTray();
    autoSizeInput();
    // The native picker temporarily owns focus. Restore the pre-picker input
    // state while this trusted change event is active so iOS keeps/reopens the
    // keyboard only for people who were already typing.
    restoreComposerAfterAttachmentPicker();
    for (const upload of pendingUploads) await runAttachmentUpload(upload);
  }
  fileInput.addEventListener('change', async () => {
    const files = [...fileInput.files];
    fileInput.value = '';
    if (!files.length || !sessionName) {
      restoreComposerAfterAttachmentPicker();
      return;
    }
    await enqueueAttachmentFiles(files);
  });
  fileInput.addEventListener('cancel', restoreComposerAfterAttachmentPicker);
  root.addEventListener('dragenter', (event) => {
    if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
    root.dataset.dragover = 'true';
  });
  root.addEventListener('dragover', (event) => {
    if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
    root.dataset.dragover = 'true';
  });
  root.addEventListener('dragleave', (event) => {
    event.stopPropagation();
    if (!root.contains(event.relatedTarget)) delete root.dataset.dragover;
  });
  root.addEventListener('drop', (event) => {
    if (!event.dataTransfer?.files?.length) return;
    event.preventDefault();
    event.stopPropagation();
    delete root.dataset.dragover;
    void enqueueAttachmentFiles(event.dataTransfer.files);
  });
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
    if (shellMode && event.key === 'Backspace' && !event.isComposing && input.value.length === 0) {
      event.preventDefault();
      setShellMode(false);
      autoSizeInput();
      return;
    }
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
  document.addEventListener('freeze', suspendForBackground);
  document.addEventListener('resume', handleOnline);
  window.addEventListener('pagehide', suspendForBackground);
  window.addEventListener('pageshow', handlePageShow);
  window.addEventListener('blur', suspendForBackground);
  window.addEventListener('focus', handleWindowFocus);
  window.addEventListener('online', handleOnline);
  window.addEventListener('agent-remote-resume', handleOnline);
  foregroundProbeTimer = setInterval(probeForegroundLiveness, 2_000);
  renderShellMode();
  autoSizeInput();

  return {
    async uploadAttachment(nextSessionName, file, onProgress, options) {
      return uploadAttachment(nextSessionName, file, onProgress, options);
    },
    enqueueFiles(selectedFiles) {
      return enqueueAttachmentFiles(selectedFiles);
    },
    setDragOver(next) {
      if (next) root.dataset.dragover = 'true';
      else delete root.dataset.dragover;
    },
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
      reconciledPendingRequests.clear();
      optimisticQueuedInputs.clear();
      cancellingTurn = false;
      submittingRequest = undefined;
      acceptedCancellation = undefined;
      historyPrependAnchor = undefined;
      interactionMotionKey = '';
      pendingPlanReviews.clear();
      attachments = [];
      abortAttachmentUploads();
      mentionedFiles.clear();
      retryMessage = undefined;
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
      reconciledPendingRequests.clear();
      optimisticQueuedInputs.clear();
      cancellingTurn = false;
      submittingRequest = undefined;
      acceptedCancellation = undefined;
      interactionMotionKey = '';
      pendingPlanReviews.clear();
      attachments = [];
      abortAttachmentUploads();
      mentionedFiles.clear();
      retryMessage = undefined;
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
      submittingRequest = undefined;
      acceptedCancellation = undefined;
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
      submittingRequest = undefined;
      acceptedCancellation = undefined;
      clearTimeout(refreshTimer);
      clearTimeout(foregroundResumeTimer);
      clearTimeout(streamWatchdogTimer);
      clearInterval(foregroundProbeTimer);
      clearTimeout(pendingAcceptanceTimer);
      clearTimeout(readerScrollGestureTimer);
      releaseMainScrollGeometryLock();
      mainScrollGeometryObserver.disconnect();
      cancelAnimationFrame(tailSnapFrame);
      closeStream();
      document.removeEventListener('pointerdown', dismissModelList);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      document.removeEventListener('freeze', suspendForBackground);
      document.removeEventListener('resume', handleOnline);
      window.removeEventListener('pagehide', suspendForBackground);
      window.removeEventListener('pageshow', handlePageShow);
      window.removeEventListener('blur', suspendForBackground);
      window.removeEventListener('focus', handleWindowFocus);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('agent-remote-resume', handleOnline);
    },
  };
}
