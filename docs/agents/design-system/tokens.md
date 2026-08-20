# Design tokens

## Source of truth

`public/tokens.css` is the visual primitive source of truth and loads after xterm's vendor stylesheet but before `public/styles.css`. It defines five groups:

| Prefix/group | Use |
| --- | --- |
| `--font-*` | UI and terminal font families, sizes, and line height |
| `--color-*` | Semantic surfaces, borders, text, intent states, and ANSI terminal colors |
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

Scrollbar colors use the semantic `--color-scrollbar-thumb`, `--color-scrollbar-thumb-hover`, and `--color-scrollbar-thumb-active` tokens. `public/styles.css` applies one cross-browser 6px scrollbar contract to every scroll surface: transparent, borderless tracks and corners; rounded low-contrast thumbs; and no arrow buttons. Do not hide a component scrollbar or add a component-specific track frame.

Syntax colors use the `--color-syntax-*` tokens. `public/syntax.js` applies the
same Highlight.js grammar and palette to assistant code fences, file previews,
edit diffs, and shell commands. Extend language aliases there and keep syntax
markup separate from diff add/remove backgrounds; do not add per-language raw
colors in component CSS.

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
