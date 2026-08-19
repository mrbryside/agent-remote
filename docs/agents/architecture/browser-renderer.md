# Browser renderer

The integrated terminal browser is not rendered inside the agent's tmux pane. The routing shim sends an owning-session request to `src/server.js`, which starts a separate graphics PTY and connects to the browser daemon through CDP. This avoids Kitty placeholder output in the main terminal.

The Grok ACP leader is also outside tmux, so the server gives it an explicit `AGENT_REMOTE_URL`, web-routing flag, and project-local dispatcher on `PATH`. When no tmux session is available, the dispatcher sends its cwd. The server resolves that cwd only against connected managed chats, preferring the single working conversation and rejecting ambiguous matches instead of broadcasting a browser command to unrelated sessions. A failed ACP route exits with an actionable error; it never falls back to the host terminal's Kitty renderer or prints a false success message.

Each session owns one keyed renderer and one UI split state. The browser toolbar reflects the daemon's real tabs, while back/forward/reload, tab changes, Inspect, and Record are routed to that renderer. Refresh and session switching reattach to the same backend renderer; closing the final tab, split, session, or project must clean up the renderer and daemon.

Desktop control events use the selected terminal WebSocket. Native mobile conversations intentionally suspend that socket, so their SSE stream also carries validated `open-graphics` control events. Both transports address the same session-keyed renderer. On phones the renderer is presented in a draggable bottom sheet rather than a full-screen xterm layer. Dismissing the sheet only changes frontend visibility and keeps the renderer alive; a Browser activity pill reopens it. If subagents are also present, Browser and Subagents share one activity dock, and each sheet exposes a direct switch to the other so the two surfaces never stack.

The page viewport is streamed as latest-frame-wins images at CSS-pixel coordinates. High-resolution settled frames improve static clarity, while animation frames use backpressure to avoid queueing stale images. Pointer input and cursor probing remain in CSS pixels. DevTools docks below the same target; its duplicate screencast is disabled so the picker inspects the primary viewport.

Changes here require the real-browser coverage in `test/terminal-browser.spec.js` in addition to the general Playwright suite. The real terminal-browser case may skip when its machine binary is unavailable.

[Back to architecture index](index.md)
