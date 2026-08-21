const svgNamespace = 'http://www.w3.org/2000/svg';

const iconDefinitions = {
  chat: {
    viewBox: '0 0 24 24',
    paths: [{
      d: 'M5 5.5h14A1.5 1.5 0 0 1 20.5 7v8a1.5 1.5 0 0 1-1.5 1.5h-9l-5 3v-3.2A1.5 1.5 0 0 1 3.5 15V7A1.5 1.5 0 0 1 5 5.5Z',
      fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linejoin': 'round',
    }],
  },
  terminal: {
    viewBox: '0 0 20 20',
    elements: [
      {
        tag: 'rect', x: '2.5', y: '3.5', width: '15', height: '13', rx: '2.5',
        fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5',
      },
      {
        d: 'm5.5 7 2.5 2.5L5.5 12', fill: 'none', stroke: 'currentColor',
        'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      },
      {
        d: 'M10.5 12h3.5', fill: 'none', stroke: 'currentColor',
        'stroke-width': '1.5', 'stroke-linecap': 'round',
      },
    ],
  },
  'panel-collapse': {
    viewBox: '0 0 20 20',
    elements: [
      { tag: 'rect', x: '2.75', y: '2.75', width: '14.5', height: '14.5', rx: '3' },
      { tag: 'rect', x: '5.25', y: '12.25', width: '9.5', height: '2.5', rx: '1.25', class: 'mobile-panel-collapse-dock' },
    ],
  },
};

function iconElement(definition) {
  const node = document.createElementNS(svgNamespace, definition.tag || 'path');
  for (const [name, value] of Object.entries(definition)) {
    if (name === 'tag') continue;
    if (name === 'class') node.setAttribute('class', value);
    else node.setAttribute(name, value);
  }
  return node;
}

export function createIcon(name, { className = '' } = {}) {
  const definition = iconDefinitions[name];
  if (!definition) throw new Error(`Unknown UI icon: ${name}`);
  const svg = document.createElementNS(svgNamespace, 'svg');
  svg.classList.add('ui-icon');
  if (className) svg.classList.add(...className.split(/\s+/).filter(Boolean));
  svg.setAttribute('viewBox', definition.viewBox || '0 0 20 20');
  svg.setAttribute('aria-hidden', 'true');
  for (const item of definition.paths || definition.elements || []) svg.append(iconElement(item));
  return svg;
}

export function configureIconButton(button, {
  label,
  title,
  variant = 'bare',
  size = 'md',
  icon,
  glyph,
} = {}) {
  if (!button.hasAttribute('type')) button.type = 'button';
  button.classList.add('ui-icon-button');
  button.dataset.uiVariant = variant;
  button.dataset.uiSize = size;
  if (label) button.setAttribute('aria-label', label);
  if (title !== undefined || label) button.title = title ?? label;
  if (icon !== undefined || glyph !== undefined) {
    const content = icon instanceof Node ? icon : icon ? createIcon(icon) : undefined;
    const glyphNode = glyph === undefined ? undefined : document.createElement('span');
    if (glyphNode) {
      glyphNode.className = 'ui-icon-button__glyph';
      glyphNode.setAttribute('aria-hidden', 'true');
      glyphNode.textContent = glyph;
    }
    button.replaceChildren(content || glyphNode);
  }
  return button;
}

export function createIconButton(options = {}) {
  const button = document.createElement('button');
  if (options.className) button.className = options.className;
  return configureIconButton(button, options);
}

export function installDialogBackdropDismiss(dialog) {
  if (!dialog || dialog.dataset.backdropDismiss === 'true') return;
  dialog.dataset.backdropDismiss = 'true';
  dialog.addEventListener('click', (event) => {
    if (!dialog.open || event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    const clickedInside = event.clientX >= bounds.left
      && event.clientX <= bounds.right
      && event.clientY >= bounds.top
      && event.clientY <= bounds.bottom;
    if (!clickedInside) dialog.close();
  });
}
