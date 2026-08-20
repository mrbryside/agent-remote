# Design tokens

## Source of truth

`public/tokens.css` is the visual primitive source of truth and loads after xterm's vendor stylesheet but before `public/styles.css`. It defines five groups:

| Prefix/group | Use |
| --- | --- |
| `--font-*` | UI and terminal font families, sizes, and line height |
| `--color-*` | Semantic surfaces, borders, text, button controls, intent states, and ANSI terminal colors |
| `--space-*` | Reusable spacing steps |
| `--radius-*` | Control, card, and shell corner radii |
| `--duration-*`, `--ease-*` | Interaction and layout motion |

Layout state such as `--sidebar-width` and `--graphics-width` is also declared there, then may be updated at runtime or in responsive media queries.

Mobile Question and Permission surfaces share the interaction type scale:
`--font-size-interaction-eyebrow`, `--font-size-interaction-caption`,
`--font-size-interaction-body`, and `--font-size-interaction-title`. Text fields
use `--font-size-mobile-input` so iOS does not zoom the viewport on focus. Keep
the two interaction types on this common scale instead of adding per-card font
sizes.

Mobile disclosure motion consumes `--duration-normal` and `--ease-out` for
Tool groups, nested/standalone Tool details, and Thought details. Keep those
surfaces on the shared content-height animation contract and retain the global
reduced-motion override; do not add component-specific durations or replay an
entry animation on every streamed snapshot.

The compact conversation is a fixed compositor surface sized and translated
from the live Visual Viewport variables in `public/app.js`. Its composer takes
focus during the initiating touch with `preventScroll`, so iOS Safari cannot
first pan the layout viewport and expose the page behind the chat before the
keyboard resize event arrives. Keep the document non-scrollable at compact
widths and preserve this focus path when changing the composer or viewport
layout.

When a compact conversation changes sessions, keep its header and composer
mounted and visible. The busy surface belongs inside
`.mobile-conversation-scroll-shell` and may cover only message history; make
the composer inert until the first snapshot arrives instead of replacing or
hiding the entire conversation surface. This keeps navigation spatially stable
and still prevents the terminal from flashing during provider discovery.

Scrollbar colors use the semantic `--color-scrollbar-thumb`, `--color-scrollbar-thumb-hover`, and `--color-scrollbar-thumb-active` tokens. `public/styles.css` applies one cross-browser 6px scrollbar contract to every scroll surface: transparent, borderless tracks and corners; rounded low-contrast thumbs; and no arrow buttons. Do not hide a component scrollbar or add a component-specific track frame.

Syntax colors use the `--color-syntax-*` tokens. `public/syntax.js` applies the
same Highlight.js grammar and palette to assistant code fences, file previews,
edit diffs, shell commands, and recognizable inline code. Inline file references
use the syntax accent even when they become preview buttons. The palette is
intentionally built from muted sea-green tones, while `--color-heading` gives
Markdown headings and file-oriented headers one restrained warm accent. Keep
the more saturated `--color-diff-add`, `--color-diff-remove`, and
`--color-status-*` families theme-cohesive and reserve them for meaningful
state: teal-green for success/additions, warm amber for activity, and muted
coral for errors/removals. Extend language aliases in `public/syntax.js`,
keep syntax markup separate from diff add/remove backgrounds, and do not add
per-language raw colors in component CSS.

The two branded content accents are exact: Teal `#64BEAC` for interactive and
syntax emphasis, and Warm Amber `#E8A465` for headings, file/symbol titles, and
Markdown strong text. Derive supporting syntax shades around them rather than
introducing a competing blue accent.

Primary, neutral, and danger buttons share the semantic `--color-button-*`
contract. Their surface stays transparent in every state; hierarchy comes from
the border and text color, with teal reserved for the primary border. Do not
reintroduce filled accent backgrounds for primary actions, including compact
composer controls or the unauthenticated pairing entry surface.

Expanded mobile Tool groups own their vertical scrolling and reserve scrollbar
space on both edges with `scrollbar-gutter: stable both-edges`, so opening a
group cannot shift its status column. A child Tool detail may scroll
horizontally for long code, command output, or a diff, but it must not create a
second vertical scrollbar inside the group. Standalone Tool details may apply a
bounded vertical scroll only to the content surface that actually needs it.

## Consumption rules

- Prefer semantic names such as `--color-surface-hover` over palette-position names or raw hex values.
- Use a token directly in `public/styles.css` with `var(--token-name)`.
- xterm canvas colors cannot reliably inherit normal CSS, so `public/app.js` reads the same custom properties through `designToken()` when constructing `terminalOptions`.
- Keep a JavaScript fallback for any token consumed by xterm so the terminal remains usable if a stylesheet is temporarily unavailable.
- Do not duplicate an existing value solely for a component. Add a component token only when its meaning or future evolution is genuinely independent.

## Adding or changing a token

1. Add or modify the semantic custom property in `public/tokens.css`.
2. Replace component literals with that property in `public/styles.css` or read it with `designToken()` in `public/app.js`.
3. Check desktop, compact-width, and short-height layouts.
4. Keep reduced-motion behavior intact.
5. Run `npm run test:all`; visual primitives are cross-cutting even when the diff looks small.

[Back to design-system index](index.md)
