# Runtime architecture

## Process boundaries

- `src/server.js` composes both loopback HTTP listeners and owns terminal,
  conversation, and renderer WebSocket lifecycles, direct PTYs, and
  browser-renderer coordination. Focused HTTP handlers and protocol helpers
  live under `src/server/`; renderer process lifecycle, CDP surface state,
  graphics socket translation, and terminal-browser daemon control also have
  separate modules there. HTTP dispatch, DevTools transport, conversation
  sockets, and terminal sockets are isolated transport modules as well. They
  receive stores and lifecycle callbacks from the composition root. Local
  control defaults to `127.0.0.1:3000`; Remote gateway defaults to
  `127.0.0.1:3001`.
- The local listener owns Remote administration (`/api/remote/*`). The remote listener is a pre-route authentication gate and returns `404` for those routes even for an authenticated device; it delegates the normal workspace, terminal, renderer, and DevTools surfaces only after device authentication.
- `src/server/local-auth.js` owns the narrow local bearer bootstrap and in-memory browser session cookie. Its HTTP/upgrade gates must run before local route dispatch: they exchange only `/?token=…`, reject all other token query parameters, and adapt a validated cookie to the existing internal authorization boundary. Do not place bearer tokens in browser-generated API, asset, SSE, image, or WebSocket URLs.
- `src/server/request-target.js` is the single request-target parser for HTTP and WebSocket entrypoints. It accepts canonical origin-form targets only and returns a bounded `400` rejection for malformed, absolute-form, encoded-separator, or dot-normalized paths. Every async HTTP entrypoint must terminate rejected promises with a generic response; malformed input must never reach Node's unhandled-rejection boundary.
- Local HTTP and WebSocket authorization validates the request `Host` against the actual listener address/port before considering `Origin`; equality between two client-controlled headers is not trust. Both workspace documents deny framing. Node request/header/keep-alive limits are explicit, and workspace SSE, conversation HTTP SSE, and DevTools WebSockets share the normalized `MAX_CONNECTIONS` capacity.
- `src/remote/` owns Remote persistence, macOS Keychain credentials, Cloudflare API/DNS ownership checks, tunnel child lifecycle, device authentication, and remote gateway policy. Read [Remote access](remote-access.md) before changing these boundaries.
- `src-tauri/src/main.rs` is a thin macOS wrapper. It attaches to a compatible local backend or owns a spawned sidecar; it does not duplicate backend behavior or grant the webview privileged IPC.
- `src/sessions.js` creates and discovers only tmux sessions carrying the `@agent_remote` marker. Those sessions outlive browser connections.
- `src/agents.js` owns the project-agent catalog. Project APIs accept an agent ID, and only the server resolves it to a launch command. Browser responses never expose those commands.
- `public/app.js` composes mounted xterm runtimes, optimistic project/chat UI,
  session switching, and per-session browser panes. `public/browser-media.js`
  owns renderer frame painting and recording, `public/terminal-snapshots.js`
  owns bounded ANSI snapshot persistence, and `public/visual-viewport.js` owns
  iOS viewport measurement and listener lifecycle.
- `src/conversations/` maps managed agent metadata to provider-owned conversation data. Grok uses an Agent Remote-specific shared ACP leader socket for replay, live updates, input, and nested subagents; it must not reuse Grok's default global leader socket. `src/conversations/grok-state.js` owns persisted lifecycle reconciliation and model/context metadata. `public/mobile-conversation.js` composes the provider-neutral compact UI; file surfaces, event/tool cards, question/plan interactions, activity state, composer ranking, and keyed timeline reconciliation live in focused modules.
- `bin/agent-remote.js` is the standalone session launcher. `bin/terminal-browser` routes agent browser commands back to the owning web session.

## Main terminal flow

1. A project saves a folder and validated agent ID through the HTTP API.
2. Creating a chat reserves a unique name and starts a detached tmux session in that folder.
3. The server resolves the agent ID through `src/agents.js`, then sends its catalog-owned command into the tmux pane after agent-remote environment variables are exported.
4. The browser connects to `/ws` with the selected session key and viewport geometry.
5. The server attaches a PTY to tmux; xterm writes input and consumes output over the socket.
6. Disconnecting the page closes the PTY attachment, not the tmux session. Reconnect restores it.

Managed tmux windows use `window-size largest`. A phone and desktop can view
the same pane without the most recently active phone shrinking the shared
window and filling the desktop with tmux padding. Smaller clients receive
tmux's cropped view. On touch devices, a short stationary terminal tap focuses
xterm's text input, while a drag keeps input unfocused and pans the per-client
tmux viewport without changing the desktop or shared pane. Visual-viewport
changes refit the terminal when the software keyboard opens. When a provider
can map the selected agent process, the phone replaces xterm with native message
history and a textarea composer; desktop remains attached to xterm. Unsupported
standalone commands retain the terminal fallback.

Desktop Grok startup is also provider-gated. Its xterm runtime may attach and
buffer output behind one opaque startup surface until the conversation endpoint
confirms ACP readiness. The successful readiness response removes that cover in
one atomic hand-off; the client does not inspect Grok's terminal text, inject
focus keys, or otherwise drive the TUI. The cover deliberately keeps one stable
`Preparing chat…` label and never switches through `Opening` or `Connecting`
copy while readiness is delayed. Pending chat creation and the promoted managed session
reuse that same uninterrupted cover. Other catalog agents and standalone
terminal commands retain the bounded quiet-window reveal path.

The native mobile boot cover and desktop startup cover use the same minimal
animated loading indicator. On mobile the cover is confined to message history;
the conversation navbar and composer remain mounted, visible, and spatially
stable while the composer is inert until the first complete snapshot arrives.

## State ownership

| State | Owner |
| --- | --- |
| Running commands and shell history | tmux session |
| Project definitions and chat metadata | SQLite via `src/projects.js` |
| Active selection, expanded projects, pane widths | browser storage |
| Mounted terminal runtimes during one page lifetime | `public/app.js` runtime maps |
| Bounded terminal restore snapshots | `public/terminal-snapshots.js` in session storage |
| Mobile activity dismissal | `public/mobile-activity-state.js` per-session local storage |
| Agent message/tool/subagent history | provider-owned files, read through `src/conversations/` |
| Live mobile token/lifecycle delivery | session-scoped `/conversation-ws`, reconciled by provider snapshots |
| Active Grok goal and elapsed metrics | provider ACP Goal updates, projected into the conversation snapshot |
| Managed Grok TUI/ACP coordination | leader socket derived from the configured SQLite path |
| Browser renderer/tab state | keyed renderer in `src/server.js` |
| Named-tunnel metadata and paired-device audit rows | SQLite via `src/remote/store.js` |
| Cloudflare user API token | macOS Keychain only |
| Quick URL, pairing secret, challenges, and remote sessions | backend memory only |
| Remote browser private key | that browser profile's IndexedDB |

Do not replace a durable owner with polling or DOM state. UI updates may be optimistic, but reconciliation must use the server response without stealing selection from a newer user action.

## Mobile goal controls

Grok Goal updates are provider state, not chat messages. The Grok adapter keeps a
single current Goal item keyed by the provider Goal ID, updates its status and
metrics from ACP events, and removes it when the provider reports `cleared`.
Slash-command echoes used to control a Goal are not rendered as user messages.

The compact client places the active Goal as a persistent row at the bottom of
the queue/steer dock. It may pause, resume, or clear the Goal through
`POST /api/conversations/:session/goal`; the registry validates that the
selected provider supports the operation before dispatching the corresponding
provider command. Clearing is terminal for that Goal row: it disappears after
the authoritative snapshot confirms removal. Goal state must not be inferred
from the terminal screen or duplicated as a timeline card.

## Cross-device workspace synchronization

`GET /api/workspace/stream` is the low-latency invalidation channel for project
and chat mutations. Both the local listener and an authenticated Remote client
may subscribe. The server emits monotonically increasing workspace revisions,
an optional list of deleted session names, and a mutation type; the stream is
not an alternate project store and never carries an authoritative workspace
snapshot.

On an event, `public/app.js` immediately evicts explicitly deleted sessions and
returns an affected client to the empty workspace before reconciling projects
and sessions from the normal HTTP APIs. Polling remains a recovery path only.
Every mounted terminal, native conversation cache, terminal snapshot, and
browser split belongs to a session incarnation, not merely its tmux name. The
incarnation uses the persisted chat creation time, falling back to the provider
thread ID. When a deleted name is reused, the old incarnation must be disposed
before the replacement is mounted; otherwise another device can resurrect the
deleted terminal or message history until reload.

Keep workspace mutation broadcasts next to the successful server-side write.
Bulk project/session deletion must include every removed session name so other
clients can synchronously clear their selection and runtime artifacts.

## Startup and shutdown order

As soon as both listeners bind, the backend begins restoring a persisted named tunnel whose desired state is `running`, before unrelated terminal-browser startup cleanup and without waiting for the local UI to open. Direct Node startup emits its machine-readable readiness line independently; a slow or failed restore must not block local readiness. Quick Tunnels are never recreated because their URL changes.

`app.close()` closes renderer and client sockets, closes the remote gateway and WebSocket servers, closes both HTTP listeners, stops its `cloudflared` child, then closes Remote auth/store and the project store. It never stops user-owned tmux sessions. Tauri follows the same boundary: Quit stops only a sidecar it owns, not a compatible backend it attached to.

[Back to architecture index](index.md)
