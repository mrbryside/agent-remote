# Frontend module boundaries

Read this before moving browser-side behavior between files or adding another
large block to `public/app.js` or `public/mobile-conversation.js`.

## Composition roots

- `public/app.js` is the workspace composition root. It owns DOM wiring,
  project/session selection, terminal and browser-pane orchestration, and calls
  smaller domain modules. It should not own storage serialization or browser
  lifecycle adapters when those can expose a narrow API.
- `public/mobile-conversation.js` is the compact conversation composition root.
  It owns the live conversation state machine, DOM event wiring, sheets,
  composer orchestration, and rendering order. File presentation, timeline
  events, interactive question/plan cards, pure state, ranking, persistence,
  and keyed DOM reconciliation belong in focused modules. Short histories
  start at the top of the scroll surface; tail following is owned by scroll
  state and must not be simulated with a flexible spacer before the timeline.

## Focused modules

| Module | Responsibility |
| --- | --- |
| `public/ui-components.js` | Shared icon registry and accessible IconButton factory. |
| `public/terminal-snapshots.js` | Bounded session cache, xterm buffer-to-ANSI serialization, and restore sequence. |
| `public/visual-viewport.js` | Visual Viewport measurement, CSS variables, notification, and listener cleanup. |
| `public/mobile-activity-state.js` | Per-session Plan/Browser/Agents dismissal persistence and new-activity comparison. |
| `public/mobile-composer-model.js` | Slash/file completion detection and deterministic command ranking. |
| `public/mobile-timeline-reconciler.js` | Keyed timeline DOM reuse and streaming-message morph decisions. |
| `public/mobile-stream-batcher.js` | Visual-cadence coalescing for contiguous compact assistant chunks. |
| `public/mobile-sheet.js` | Shared compact sheet frame slots, drag-to-dismiss behavior, and geometry reset. |
| `public/mobile-file-surface.js` | File preview sheet, image/search results, and diff presentation. |
| `public/mobile-event-renderer.js` | Tool, event, permission, and grouped-tool cards. |
| `public/mobile-interaction-renderer.js` | Multi-step question and plan-review interaction cards. |
| `public/browser-media.js` | Browser renderer frame decoding, paint queue, pointer mapping, and recording lifecycle. |

Every new browser module must be added to the explicit static route map in
`src/server/static-assets.js`; add a fetch assertion to `test/server.test.js` so an import
cannot work in source while returning 404 in the app.

## Server route modules

`src/server.js` remains the process composition root and owns the PTY,
WebSocket, and renderer lifecycles. HTTP concerns are grouped under
`src/server/`: shared request helpers, static assets, Remote administration,
project/session mutation, conversation control, conversation messages/files,
and browser-control routes. Route modules receive their stateful dependencies
from the composition root; they must not create a second store or lifecycle
owner.

The browser renderer is split by state owner inside the same folder:
`renderer-lifecycle.js` owns its process/discovery/cleanup lifecycle,
`renderer-surface.js` owns CDP, screencast frames, viewport and tab state,
`renderer-socket.js` translates graphics WebSocket messages, and
`terminal-browser-client.js` owns the daemon socket/discovery protocol.
`renderer-protocol.js` contains bounded wire-format helpers shared with tests.
`workspace-http.js` dispatches authenticated HTTP routes,
`devtools-proxy.js` owns the Chrome DevTools transport, while
`conversation-socket.js` and `terminal-socket.js` install their respective
WebSocket connection lifecycles. The composition root creates and injects all
stores, registries, listener sets, and shutdown callbacks into these modules.

## Extraction rules

Extract by domain and state owner, not by an arbitrary line count. A useful
module has a narrow public API, keeps related conditions together, and can be
tested without recreating the whole workspace. Keep orchestration local when
moving it would force many mutable variables or callbacks across the boundary.

Name compound decisions so call sites state intent. Examples are
`isGrokSessionId()`, `hasActivityAfterDismissal()`, and
`composerCompletion()`. Avoid tiny wrappers that only rename one property read,
and avoid a generic `utils.js`; place helpers with the domain whose invariants
they protect.

Back to [Architecture](index.md).
