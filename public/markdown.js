import { marked } from '/vendor/marked.js';
import DOMPurify from '/vendor/dompurify.js';

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
  for (const pre of [...root.querySelectorAll('pre')]) {
    const code = pre.querySelector(':scope > code');
    if (!code) continue;
    const language = [...code.classList].find((name) => name.startsWith('language-'))?.slice(9) || 'Code';
    const frame = document.createElement('div');
    frame.className = 'mobile-markdown-code';
    const toolbar = document.createElement('div');
    toolbar.className = 'mobile-markdown-code-toolbar';
    const label = document.createElement('span');
    label.textContent = language;
    toolbar.append(label, copyButton(code.textContent));
    pre.replaceWith(frame);
    frame.append(toolbar, pre);
  }
}

function decorateTables(root) {
  for (const table of [...root.querySelectorAll('table')]) {
    const viewport = document.createElement('div');
    viewport.className = 'mobile-markdown-table';
    table.replaceWith(viewport);
    viewport.append(table);
  }
}

export function markdownNode(source) {
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
  decorateCode(root);
  decorateTables(root);
  return root;
}
