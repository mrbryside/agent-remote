import { marked } from '/vendor/marked.js';
import DOMPurify from '/vendor/dompurify.js';
import { highlightCodeNode } from './syntax.js';

marked.use({
  gfm: true,
  breaks: true,
});

const sanitizeOptions = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['style', 'form', 'button', 'textarea', 'select', 'option'],
  FORBID_ATTR: ['style', 'id', 'name'],
  ALLOW_DATA_ATTR: false,
  SANITIZE_NAMED_PROPS: true,
  RETURN_DOM_FRAGMENT: true,
};

function safeUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const url = new URL(value, location.href);
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url : undefined;
  } catch {
    return undefined;
  }
}

function decorateLinks(root) {
  for (const anchor of root.querySelectorAll('a[href]')) {
    const url = safeUrl(anchor.getAttribute('href'));
    if (!url) {
      anchor.removeAttribute('href');
      continue;
    }
    anchor.href = url.href;
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
    }
  }
}

function decorateImages(root) {
  for (const image of root.querySelectorAll('img')) {
    const url = safeUrl(image.getAttribute('src'));
    if (!url || url.protocol === 'mailto:') {
      image.replaceWith(document.createTextNode(image.alt || 'Image'));
      continue;
    }
    image.src = url.href;
    image.loading = 'lazy';
    image.decoding = 'async';
    image.referrerPolicy = 'no-referrer';
  }
}

function decorateTasks(root) {
  for (const input of root.querySelectorAll('input')) {
    if (input.type !== 'checkbox') {
      input.remove();
      continue;
    }
    input.disabled = true;
    input.tabIndex = -1;
  }
}

function fileReference(value) {
  const match = String(value || '').trim().match(
    /^((?:\/|\.{1,2}\/)?(?:[\w@.+-]+\/)*[\w@.+-]+\.[\w.+-]+)(?::(\d+)(?:[-–](\d+))?)?$/,
  );
  if (!match) return undefined;
  const startLine = match[2] ? Number(match[2]) : undefined;
  const endLine = match[3] ? Number(match[3]) : startLine;
  return { path: match[1], startLine, endLine };
}

function decorateFileReferences(root, onFileReference) {
  if (typeof onFileReference !== 'function') return;
  for (const code of [...root.querySelectorAll('code:not(pre code)')]) {
    const reference = fileReference(code.textContent);
    if (!reference) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'mobile-file-reference';
    button.textContent = code.textContent;
    button.setAttribute('aria-label', `Open ${reference.path}${reference.startLine ? ` at line ${reference.startLine}` : ''}`);
    button.addEventListener('click', () => onFileReference(reference));
    code.replaceWith(button);
  }
}

function inlineLanguage(source) {
  const value = String(source || '').trim();
  if (!value) return undefined;
  if (/^(?:npm|npx|node|git|rtk|cd|ls|grep|rg|curl|mkdir|rm)\b/.test(value)) return 'bash';
  if (/^(?:true|false|null|undefined|NaN|Infinity)$/.test(value)
    || /\b(?:class|interface|type|function|const|let|var|implements|extends|return|new|async|await)\b/.test(value)
    || /=>|<[A-Za-z_$][\w$]*(?:\s*,\s*[A-Za-z_$][\w$]*)?>/.test(value)) return 'typescript';
  if (/^[{[]/.test(value) && /[:},\]]/.test(value)) return 'json';
  return undefined;
}

function decorateInlineCode(root) {
  for (const code of root.querySelectorAll('code:not(pre code)')) {
    highlightCodeNode(code, code.textContent, inlineLanguage(code.textContent));
  }
}

function copyButton(code) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'mobile-markdown-copy';
  button.textContent = 'Copy';
  button.setAttribute('aria-label', 'Copy code');
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(code);
      button.textContent = 'Copied';
      setTimeout(() => { button.textContent = 'Copy'; }, 1_400);
    } catch {
      button.textContent = 'Copy failed';
      setTimeout(() => { button.textContent = 'Copy'; }, 1_400);
    }
  });
  return button;
}

function decorateCode(root) {
  for (const [index, pre] of [...root.querySelectorAll('pre')].entries()) {
    const code = pre.querySelector(':scope > code');
    if (!code) continue;
    pre.dataset.markdownScroll = `code:${index}`;
    const language = [...code.classList].find((name) => name.startsWith('language-'))?.slice(9) || 'Code';
    const source = code.textContent;
    const frame = document.createElement('div');
    frame.className = 'mobile-markdown-code';
    const toolbar = document.createElement('div');
    toolbar.className = 'mobile-markdown-code-toolbar';
    const label = document.createElement('span');
    label.textContent = language;
    toolbar.append(label, copyButton(source));
    pre.replaceWith(frame);
    frame.append(toolbar, pre);
    highlightCodeNode(code, source, language);
  }
}

function decorateTables(root) {
  for (const [index, table] of [...root.querySelectorAll('table')].entries()) {
    const viewport = document.createElement('div');
    viewport.className = 'mobile-markdown-table';
    viewport.dataset.markdownScroll = `table:${index}`;
    table.replaceWith(viewport);
    viewport.append(table);
  }
}

export function markdownNode(source, { onFileReference } = {}) {
  const root = document.createElement('div');
  root.className = 'mobile-message-content mobile-markdown';
  const markdown = String(source ?? '').replace(/^[\u200B-\u200F\uFEFF]/, '');
  try {
    const dirty = marked.parse(markdown);
    root.append(DOMPurify.sanitize(dirty, sanitizeOptions));
  } catch {
    root.textContent = markdown;
    return root;
  }
  decorateLinks(root);
  decorateImages(root);
  decorateTasks(root);
  decorateFileReferences(root, onFileReference);
  decorateInlineCode(root);
  decorateCode(root);
  decorateTables(root);
  return root;
}
