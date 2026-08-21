import { markdownNode } from './markdown.js';
import { changeParts, searchToolTitle } from './mobile-file-surface.js';
import { highlightCodeNode } from './syntax.js';
import { createIcon } from './ui-components.js';

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

function duration(value) {
  const milliseconds = Number(value) || 0;
  if (milliseconds < 1_000) return `${milliseconds} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)} s`;
  return `${(milliseconds / 60_000).toFixed(1)} min`;
}

function detail(panel, label, value, className = '') {
  if (value === undefined || value === null || value === '') return;
  const section = element('section', `mobile-event-detail ${className}`.trim());
  section.append(element('small', '', label), element('pre', '', String(value)));
  panel.append(section);
}

function commandNode(item) {
  const section = element('section', 'mobile-tool-command');
  const command = element('div', 'mobile-tool-command-line');
  command.append(
    createIcon('terminal', { className: 'mobile-tool-command-icon' }),
    highlightCodeNode(element('code'), item.command, 'bash'),
  );
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

function planListNode(item) {
  const list = element('ol', 'mobile-plan-list');
  for (const entry of item.entries || []) {
    const row = element('li');
    row.dataset.state = entry.status;
    row.append(element('i'), element('span', '', entry.content), element('small', '', statusLabel(entry.status)));
    list.append(row);
  }
  return list;
}

export function createMobileEventRenderer({
  fileSurface, expandedItems, autoExpandedItems, initializeDisclosure, animateDisclosure,
  getSessionName, respondPermission, refresh,
}) {
  const {
    open: openFileReference, filePreviewNode, searchMatchesNode, changeNode, changeStatsNode,
  } = fileSurface;

  function eventDetails(panel, item) {
    if (item.type === 'recap') {
      panel.append(markdownNode(item.text || '', {
        onFileReference: (reference) => void openFileReference(reference),
      }));
    } else if (item.type === 'thought' || item.type === 'event') {
      detail(panel, item.type === 'thought' ? 'Reasoning' : 'Details', item.text);
    }
    if (item.type === 'permission') detail(panel, 'Request', item.text || item.title);
    if (item.type === 'tool') {
      const diffs = Array.isArray(item.diffs) ? item.diffs : [];
      if (diffs.length) {
        for (const [index, change] of diffs.entries()) panel.append(changeNode(change, index));
      } else {
        if (item.command) panel.append(commandNode(item));
        else if (!item.file && !item.matches?.length) {
          panel.append(commandNode({
            command: genericToolCommand(item),
            output: item.output || item.locations?.join('\n') || '',
          }));
        }
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
    if (item.type === 'plan') panel.append(planListNode(item));
    if (item.type === 'goal') {
      detail(panel, 'Objective', item.objective);
      detail(panel, 'Phase', item.phase);
      if (item.progress) detail(panel, 'Deliverables', `${metric(item.progress.completed)} / ${metric(item.progress.total)}`);
      if (item.metrics) detail(panel, 'Usage', [
        `${metric(item.metrics.tokensUsed)} tokens`, duration(item.metrics.elapsedMs),
        `${metric(item.metrics.workerRounds)} worker rounds`, `${metric(item.metrics.verifyRounds)} verify rounds`,
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
        `${metric(item.usage.inputTokens)} in`, `${metric(item.usage.outputTokens)} out`,
        `${metric(item.usage.totalTokens)} total`, `${metric(item.usage.cachedReadTokens)} cached`,
        `${metric(item.usage.modelCalls)} calls`, duration(item.usage.apiDurationMs),
      ].join(' · '));
    }
    if (!panel.childNodes.length) detail(panel, 'Details', 'No additional details');
  }

  function permissionActions(item, status) {
    const actions = element('div', 'mobile-permission-actions');
    const hints = {
      allow_once: 'Allow only this request', allow_session: 'Allow for this session',
      allow_always: 'Remember for future requests', reject_once: 'Decline and return to Grok',
      reject_always: 'Always decline this permission',
    };
    for (const option of item.options || []) {
      const button = element('button');
      button.type = 'button';
      button.dataset.kind = option.kind || '';
      button.dataset.optionId = option.id;
      button.append(element('strong', '', option.label), element('small', '', hints[option.kind] || 'Choose this permission response'));
      button.addEventListener('click', async () => {
        for (const sibling of actions.querySelectorAll('button')) sibling.disabled = true;
        try {
          await respondPermission(getSessionName(), item.permissionId, option.id);
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
    copy.append(element('strong', '', item.title || 'Permission required'));
    const status = element('span', 'mobile-question-status', statusLabel(item.status));
    status.dataset.state = item.status || 'pending';
    header.append(copy, status);
    card.append(header);
    if (item.text) {
      const details = element('details', 'mobile-permission-details');
      details.open = true;
      details.append(element('summary', '', 'Command details'), element('pre', '', item.text));
      card.append(details);
    }
    card.append(permissionActions(item, status));
    return card;
  }

  function eventNode(item) {
    if ((item.type === 'recap' || (item.type === 'tool' && ['edit', 'write'].includes(item.kind))) &&
        !autoExpandedItems.has(item.id)) {
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
    const searchTitle = searchToolTitle(item);
    heading.append(element('strong', '', item.type === 'thought'
      ? thinking ? 'Thinking…' : 'Thought'
      : searchTitle || item.title || 'Event'));
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
    const panel = element('div', 'mobile-event-panel');
    panel.dataset.streamScroll = 'details';
    initializeDisclosure(toggle, panel, expandedItems.has(item.id));
    eventDetails(panel, item);
    toggle.append(copy, state, element('i', '', '›'));
    toggle.addEventListener('click', (event) => {
      if (expandedItems.has(item.id)) expandedItems.delete(item.id);
      else expandedItems.add(item.id);
      animateDisclosure(toggle, panel, expandedItems.has(item.id));
      if (item.type === 'tool' && event.detail !== 0) toggle.blur();
    });
    card.append(toggle, panel);
    if (item.type === 'permission' && item.status === 'pending') card.append(permissionActions(item, state));
    else if (item.type === 'permission' && item.selectedLabel) card.append(element('div', 'mobile-permission-result', item.selectedLabel));
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
    toggle.append(element('i'), element('strong', '', item.title || `${item.tools?.length || 0} tools`), element('small', '', statusLabel(item.status)));
    const panel = element('div', 'mobile-tool-group-panel');
    panel.dataset.streamScroll = 'tools';
    initializeDisclosure(toggle, panel, expandedItems.has(item.id));
    for (const tool of item.tools || []) {
      const displayTitle = tool.command
        ? `Ran ${tool.command}`
        : tool.subject && !tool.title?.includes(tool.subject)
          ? [tool.title, tool.subject].filter(Boolean).join(' ')
          : tool.title;
      const nested = eventNode({ ...tool, title: displayTitle });
      nested.__mobileItemSignature = JSON.stringify(tool);
      panel.append(nested);
    }
    toggle.addEventListener('click', (event) => {
      if (expandedItems.has(item.id)) expandedItems.delete(item.id);
      else expandedItems.add(item.id);
      animateDisclosure(toggle, panel, expandedItems.has(item.id));
      if (event.detail !== 0) toggle.blur();
    });
    group.append(toggle, panel);
    return group;
  }

  return { eventNode, permissionDockNode, toolGroupNode };
}
