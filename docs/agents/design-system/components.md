# UI components

Read this before adding or styling reusable controls in `public/`, especially
icon-only buttons created from JavaScript.

## Component sources

- `public/ui-components.js` is the DOM factory and icon registry. Dynamic
  icon-only controls use `createIconButton()`; shared SVG artwork uses
  `createIcon()`.
- `button.ui-icon-button` in `public/styles.css` owns the common hit target,
  alignment, border/background reset, pointer and keyboard states, disabled
  state, icon sizing, and press motion.
- Static icon buttons use the same class and declare `data-ui-variant` and
  `data-ui-size` in `public/index.html`.

Do not create a new icon-only button with raw `document.createElement('button')`
or `element('button', ...)`. Use the factory so accessibility and interaction
states cannot drift. Existing text buttons remain on their semantic primitives:
`primary-button`, `quiet-button`, `danger-button`, or a feature component.

## IconButton API

`createIconButton()` accepts `label`, `title`, `className`, `variant`, `size`,
and either `icon`/`createIcon()` or a temporary `glyph`. Every icon-only button
requires a stable accessible `label`; visible glyphs are marked presentation-only.

| Variant | Use |
| --- | --- |
| `bare` | Navbar, sheet header, close, and other controls whose hover changes only color. |
| `ghost` | Compact toolbars where a subtle hover surface helps grouping. |
| `surface` | Elevated or primary circular icon actions such as Send and jump-to-latest. |
| `danger` | Destructive close/delete actions; it stays borderless and uses the danger hover color. |

Sizes are `xs`, `sm`, `md`, `lg`, and `xl`. A feature selector may set only
layout variables such as `--ui-icon-button-width`, `--ui-icon-button-height`,
`--ui-icon-button-font-size`, `--ui-icon-size`, or placement/position. Component
defaults use `:where()` so these feature layout variables remain intentionally
overridable. A feature must not reimplement hover, focus, disabled, or press
behavior. If a control needs another interaction contract, add a component
variant rather than another ID-specific hover rule.

## Scope and exceptions

Browser toolbar actions, project/session actions, sheet controls, composer icon
actions, attachments, queued-message icons, and Goal icon actions share this
component. Text actions, list rows, disclosure rows, backdrops, and large drag
handles are not IconButtons even if they contain a small symbol; keep their
semantic component instead of forcing square-button behavior onto them.

When a pattern appears in a second feature, extract its DOM construction and
state styling into `ui-components.js`/the component CSS contract before adding
another local copy. Tests should cover one static and one dynamic consumer plus
every new variant.

Back to [Design system](index.md).
