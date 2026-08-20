# Runtime architecture

## Process boundaries

- `src/server.js` owns both loopback HTTP listeners, the HTTP API, terminal and renderer WebSockets, direct PTYs, static assets, and browser-renderer coordination. Local control defaults to `127.0.0.1:3000`; Remote gateway defaults to `127.0.0.1:3001`.
- The local listener owns Remote administration (`/api/remote/*`). The remote listener is a pre-route authentication gate and returns `404` for those routes even for an authenticated device; it delegates the normal workspace, terminal, renderer, and DevTools surfaces only after device authentication.
- `src/remote/` owns Remote persistence, macOS Keychain credentials, Cloudflare API/DNS ownership checks, tunnel child lifecycle, device authentication, and remote gateway policy. Read [Remote access](remote-access.md) before changing these boundaries.
- `src-tauri/src/main.rs` is a thin macOS wrapper. It attaches to a compatible local backend or owns a spawned sidecar; it does not duplicate backend behavior or grant the webview privileged IPC.
- `src/sessions.js` creates and discovers only tmux sessions carrying the `@agent_remote` marker. Those sessions outlive browser connections.
- `src/agents.js` owns the project-agent catalog. Project APIs accept an agent ID, and only the server resolves it to a launch command. Browser responses never expose those commands.
- `public/app.js` owns mounted xterm runtimes, optimistic project/chat UI, session switching, per-session browser panes, and viewport resizing.
- `src/conversations/` maps managed agent metadata to provider-owned conversation data. Grok uses an Agent Remote-specific shared ACP leader socket for replay, live updates, input, and nested subagents; it must not reuse Grok's default global leader socket. `public/mobile-conversation.js` renders its provider-neutral schema only on compact viewports.
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
focus keys, or otherwise drive the TUI. If readiness is delayed, the same cover
reports the delay and keeps polling instead of flashing the terminal. Pending
chat creation and the promoted managed session use the same stable `Opening
Grok…` title, so the opaque cover does not visibly switch through a separate
Connecting state before the TUI is ready. Other
catalog agents and standalone terminal commands retain the bounded quiet-window reveal path.

## State ownership

| State | Owner |
| --- | --- |
| Running commands and shell history | tmux session |
| Project definitions and chat metadata | SQLite via `src/projects.js` |
| Active selection, expanded projects, pane widths | browser storage |
| Mounted terminal caches during one page lifetime | `public/app.js` runtime maps |
| Agent message/tool/subagent history | provider-owned files, read through `src/conversations/` |
| Managed Grok TUI/ACP coordination | leader socket derived from the configured SQLite path |
| Browser renderer/tab state | keyed renderer in `src/server.js` |
| Named-tunnel metadata and paired-device audit rows | SQLite via `src/remote/store.js` |
| Cloudflare user API token | macOS Keychain only |
| Quick URL, pairing secret, challenges, and remote sessions | backend memory only |
| Remote browser private key | that browser profile's IndexedDB |

Do not replace a durable owner with polling or DOM state. UI updates may be optimistic, but reconciliation must use the server response without stealing selection from a newer user action.

## Startup and shutdown order

After both listeners are ready, direct Node startup emits a machine-readable readiness line and then restores only a persisted named tunnel whose desired state is `running`; a failed restore must not block local readiness. Quick Tunnels are never recreated because their URL changes.

`app.close()` closes renderer and client sockets, closes the remote gateway and WebSocket servers, closes both HTTP listeners, stops its `cloudflared` child, then closes Remote auth/store and the project store. It never stops user-owned tmux sessions. Tauri follows the same boundary: Quit stops only a sidecar it owns, not a compatible backend it attached to.

[Back to architecture index](index.md)
