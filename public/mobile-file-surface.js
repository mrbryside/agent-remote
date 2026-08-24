import { highlightCodeNode, languageForPath } from './syntax.js';
import { createMobileSheetFrame, installMobileSheetDrag } from './mobile-sheet.js';
import { createIconButton } from './ui-components.js';

function normalizedPath(value) {
  return String(value || '').replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/');
}

function samePath(candidate, requested) {
  const left = normalizedPath(candidate);
  const right = normalizedPath(requested);
  return left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`);
}

function capturedFiles(conversation) {
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

export function parsedToolInput(item) {
  if (!item?.input) return {};
  if (typeof item.input === 'object' && !Array.isArray(item.input)) return item.input;
  try {
    const input = JSON.parse(item.input);
    return input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  } catch {
    return {};
  }
}

export function searchToolTitle(item) {
  if (item?.type !== 'tool' || (item.kind !== 'search' && !item.matches?.length)) return undefined;
  const input = parsedToolInput(item);
  const matchPaths = [...new Set((item.matches || []).map((match) => match.path).filter(Boolean))];
  const scope = input.target_file || input.file_path || input.path || input.target_directory ||
    (matchPaths.length === 1 ? matchPaths[0] : matchPaths.length > 1 ? `${matchPaths.length} files` : '');
  const pattern = input.pattern || input.query || input.regex || item.subject || 'pattern';
  const reportedCount = Number(String(item.output || '').match(/\b(?:Found\s+)?(\d+)\s+matches?\b/i)?.[1]);
  const count = Number.isFinite(reportedCount) && reportedCount >= 0 ? reportedCount : item.matches?.length;
  return [
    `Search ${pattern}`,
    scope ? `in ${scope}` : '',
    Number.isFinite(count) ? `(${count} ${count === 1 ? 'match' : 'matches'})` : '',
  ].filter(Boolean).join(' ');
}

export function changeParts(change) {
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

export function createMobileFileSurface({
  root,
  element,
  readFile,
  getSessionName,
  getConversation,
  animateContent,
  metric,
}) {
  let sheet;
  let panel;
  let title;
  let meta;
  let body;
  let closeGeneration = 0;
  let previewGeneration = 0;

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

  function close() {
    if (!sheet || sheet.hidden || sheet.dataset.closing === 'true') return;
    previewGeneration += 1;
    const generation = ++closeGeneration;
    sheet.dataset.closing = 'true';
    sheet.inert = true;
    let timer;
    const finish = () => {
      panel.removeEventListener('animationend', finishAfterAnimation);
      clearTimeout(timer);
      if (generation !== closeGeneration) return;
      sheet.hidden = true;
      sheet.inert = false;
      delete sheet.dataset.closing;
      delete panel.dataset.dragSettled;
      panel.style.removeProperty('--mobile-sheet-drag');
    };
    const finishAfterAnimation = (event) => {
      if (event.target === panel && event.animationName === 'mobile-sheet-out') finish();
    };
    panel.addEventListener('animationend', finishAfterAnimation);
    timer = setTimeout(finish, 600);
  }

  function ensureSheet() {
    if (sheet) return;
    const frame = createMobileSheetFrame({
      root,
      element,
      label: 'File preview',
      handleLabel: 'Drag down to close file preview',
      classNames: {
        sheet: 'mobile-file-sheet',
        panel: 'mobile-file-sheet-panel',
        handle: 'mobile-file-sheet-handle',
        header: 'mobile-file-sheet-header',
        body: 'mobile-file-sheet-body',
      },
    });
    sheet = frame.sheet;
    panel = frame.panel;
    const { handle } = frame;
    const { header } = frame.slots;
    body = frame.slots.body;
    const copy = element('span');
    title = element('strong', '', 'File');
    meta = element('small');
    copy.append(title, meta);
    const closeButton = createIconButton({
      className: 'mobile-file-sheet-close close-button', label: 'Close file preview', glyph: '×',
      variant: 'bare', size: 'xl',
    });
    closeButton.addEventListener('click', close);
    header.append(copy, closeButton);
    sheet.addEventListener('click', (event) => {
      if (event.target === sheet) close();
    });
    sheet.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') close();
    });
    installMobileSheetDrag({ panel, handle, onClose: close, threshold: 96 });
  }

  async function open(reference, fallback) {
    ensureSheet();
    closeGeneration += 1;
    delete sheet.dataset.closing;
    delete panel.dataset.dragSettled;
    panel.style.removeProperty('--mobile-sheet-drag');
    delete panel.dataset.kind;
    sheet.inert = false;
    sheet.setAttribute('aria-label', 'File preview');
    delete body.dataset.kind;
    const generation = ++previewGeneration;
    const candidates = capturedFiles(getConversation()).filter((file) => samePath(file.path, reference.path));
    let file = candidates.at(-1) || fallback;
    sheet.hidden = false;
    title.textContent = reference.path.split('/').at(-1) || reference.path;
    meta.textContent = reference.path;
    body.replaceChildren(element('div', 'mobile-conversation-loading', 'Opening file…'));
    sheet.focus({ preventScroll: true });
    const sessionName = getSessionName();
    if (!file && sessionName && typeof readFile === 'function') {
      try { file = (await readFile(sessionName, reference.path))?.file; }
      catch (error) {
        if (generation !== previewGeneration) return;
        file = { path: reference.path, content: error.message || 'File content is unavailable.', startLine: reference.startLine || 1 };
      }
    }
    if (generation !== previewGeneration) return;
    file ||= { path: reference.path, content: 'File content was not captured in this conversation.', startLine: reference.startLine || 1 };
    const path = file.path || reference.path;
    const startLine = reference.startLine || file.startLine || 1;
    const endLine = reference.endLine || startLine;
    title.textContent = path.split('/').at(-1) || path;
    meta.textContent = `${path}${reference.startLine ? ` · Lines ${startLine}${endLine !== startLine ? `–${endLine}` : ''}` : ''}`;
    body.replaceChildren(filePreviewNode(file, { path, startLine, endLine, streamId: `file-sheet:${path}` }));
    animateContent(body);
  }

  function openMedia({ name = 'Attachment', mimeType = '', url, items = [], selectedId } = {}) {
    const gallery = (items.length ? items : [{ name, mimeType, url }]).filter((item) => item?.url);
    if (!gallery.length) return;
    ensureSheet();
    closeGeneration += 1;
    delete sheet.dataset.closing;
    delete panel.dataset.dragSettled;
    panel.style.removeProperty('--mobile-sheet-drag');
    panel.dataset.kind = 'media';
    sheet.inert = false;
    const generation = ++previewGeneration;
    let selectedIndex = Math.max(0, gallery.findIndex((item) => item.id === selectedId));
    const viewer = element('div', 'mobile-file-media-viewer');
    viewer.dataset.gallery = String(gallery.length > 1);
    const stage = element('div', 'mobile-file-media-stage');
    const strip = element('div', 'mobile-file-media-strip');
    strip.setAttribute('aria-label', 'Attachment gallery');
    const thumbnailButtons = [];

    const mediaNode = (item, { thumbnail = false } = {}) => {
      const isVideo = /^video\//i.test(item.mimeType || '');
      const media = document.createElement(isVideo ? 'video' : 'img');
      media.className = thumbnail ? 'mobile-file-media-thumbnail' : 'mobile-file-media';
      if (isVideo) {
        media.muted = thumbnail;
        media.controls = !thumbnail;
        if (!thumbnail) media.setAttribute('controls', '');
        media.playsInline = true;
        media.preload = 'metadata';
        if (!thumbnail) media.dataset.ready = 'false';
        media.setAttribute(thumbnail ? 'aria-hidden' : 'aria-label', thumbnail ? 'true' : item.name);
      } else {
        media.alt = thumbnail ? '' : item.name;
        media.decoding = 'async';
      }
      media.src = item.url;
      return media;
    };

    const showItem = (index) => {
      if (generation !== previewGeneration || sheet.hidden) return;
      selectedIndex = index;
      const item = gallery[index];
      const isVideo = /^video\//i.test(item.mimeType || '');
      const media = mediaNode(item);
      if (isVideo) {
        const revealVideo = () => { media.dataset.ready = 'true'; };
        media.addEventListener('loadedmetadata', revealVideo, { once: true });
        if (media.readyState >= HTMLMediaElement.HAVE_METADATA) revealVideo();
      }
      media.addEventListener('error', () => {
        if (generation !== previewGeneration || selectedIndex !== index || sheet.hidden) return;
        stage.replaceChildren(element('div', 'mobile-file-media-fallback', item.name));
      }, { once: true });
      stage.replaceChildren(media);
      title.textContent = item.name;
      meta.textContent = `${isVideo ? 'Video' : 'Image'}${gallery.length > 1 ? ` · ${index + 1} of ${gallery.length}` : ''}`;
      thumbnailButtons.forEach((button, buttonIndex) => {
        if (buttonIndex === index) button.setAttribute('aria-current', 'true');
        else button.removeAttribute('aria-current');
      });
      thumbnailButtons[index]?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    };

    if (gallery.length > 1) {
      gallery.forEach((item, index) => {
        const thumbnail = element('button', 'mobile-file-media-thumb');
        thumbnail.type = 'button';
        thumbnail.setAttribute('aria-label', `View ${item.name}`);
        const media = mediaNode(item, { thumbnail: true });
        media.addEventListener('error', () => {
          media.remove();
          thumbnail.dataset.preview = 'fallback';
        }, { once: true });
        thumbnail.append(media, element('small', '', item.name));
        thumbnail.addEventListener('click', () => showItem(index));
        thumbnailButtons.push(thumbnail);
        strip.append(thumbnail);
      });
      viewer.append(stage, strip);
    } else viewer.append(stage);
    sheet.hidden = false;
    sheet.setAttribute('aria-label', 'Media preview');
    body.dataset.kind = 'media';
    body.replaceChildren(viewer);
    sheet.focus({ preventScroll: true });
    showItem(selectedIndex);
    animateContent(body);
  }

  function searchMatchesNode(matches) {
    const section = element('section', 'mobile-event-matches');
    const list = element('div');
    for (const match of matches) {
      const button = element('button');
      button.type = 'button';
      const copy = element('span');
      copy.append(element('strong', '', match.path), element('code', '', match.text || 'Match'));
      button.append(element('small', '', `L${match.line}`), copy, element('i', '', '›'));
      button.addEventListener('click', () => void open(
        { path: match.path, startLine: match.line, endLine: match.line },
        { path: match.path, content: match.text || '', startLine: match.line },
      ));
      list.append(button);
    }
    section.append(list);
    return section;
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

  function changeNode(change, changeIndex) {
    const { before, after, prefix, suffix, removed, added } = changeParts(change);
    const oldBase = Math.max(1, Number(change.oldLine) || 1);
    const newBase = Math.max(1, Number(change.newLine) || 1);
    const language = languageForPath(change.path);
    const section = element('section', 'mobile-event-change');
    const header = element('header');
    header.append(element('strong', '', change.path || 'Changed file'), changeStatsNode(added.length, removed.length));
    const scroll = element('div', 'mobile-event-change-scroll');
    scroll.dataset.streamScroll = `diff:${changeIndex}:${change.path || 'changed-file'}`;
    const lines = element('div', 'mobile-event-change-lines');
    const contextStart = Math.max(0, prefix - 3);
    if (contextStart > 0) lines.append(changeLine('skip', '', '', '…', language));
    for (let index = contextStart; index < prefix; index += 1) {
      lines.append(changeLine('context', oldBase + index, newBase + index, before[index], language));
    }
    removed.forEach((line, index) => lines.append(changeLine('remove', oldBase + prefix + index, '', line, language)));
    added.forEach((line, index) => lines.append(changeLine('add', '', newBase + prefix + index, line, language)));
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

  return { close, open, openMedia, filePreviewNode, searchMatchesNode, changeNode, changeStatsNode };
}
