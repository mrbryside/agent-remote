# Browser renderer

The integrated terminal browser is not rendered inside the agent's tmux pane. The routing shim sends an owning-session request to `src/server.js`, which starts a separate graphics PTY and connects to the browser daemon through CDP. This avoids Kitty placeholder output in the main terminal.

The Grok ACP leader and its tool subprocesses may run outside tmux or strip the
`AGENT_REMOTE_*` environment. The project-local dispatcher therefore attempts
backend routing for every implicit `open`, `new-tab`, and `action` command. It
uses an explicit session when one can be proven and otherwise sends its cwd.
The server resolves that cwd only against connected managed chats, preferring
the single working conversation and rejecting ambiguous matches instead of
broadcasting a browser command to unrelated sessions. Commands outside an
agent-remote project still fall back to the real host binary when the backend
has no matching chat. An explicitly identified ACP route instead exits with an
actionable error; it never falls back to the host terminal's Kitty renderer or
prints a false success message.

Each session owns one keyed renderer and one UI split state. The browser toolbar reflects the daemon's real tabs with keyed DOM nodes, so polling can update labels and active state without replacing a button during a click. Back/forward/reload, tab changes, Inspect, and Record are routed to that renderer. Refresh and session switching reattach to the same backend renderer; closing the final tab, split, session, or project must clean up the renderer and daemon.

Desktop control events use the selected terminal WebSocket. Native mobile conversations intentionally suspend that socket, so their SSE stream also carries validated `open-graphics` control events. Both transports address the same session-keyed renderer. On phones the renderer is presented in a draggable bottom sheet rather than a full-screen xterm layer. Dismissing the sheet only changes frontend visibility and keeps the renderer alive; a Browser activity pill reopens it. If subagents are also present, Browser and Subagents share one activity dock, and each sheet exposes a direct switch to the other so the two surfaces never stack.

The page viewport displays Chromium's compositor screencast directly. Layout,
input, and raster dimensions share CSS-pixel coordinates, so there is no
motion/idle quality switch and no second `Page.captureScreenshot` encode on each
frame. CDP frames are acknowledged immediately. The server keeps only the newest
frame while a WebSocket write is in flight, and the browser keeps only the newest
frame waiting for decode. A decoded frame is presented on the next animation
frame before decoding the newest replacement, which preserves steady cadence
without building a delayed queue. Screencasting stops when every client hides
the surface and restarts when one becomes visible. A top-level navigation
reapplies the exact CSS viewport and restarts the screencast even when the CDP
target id does not change. Target metadata reaches the frontend before the first
new frame, and one exact-viewport screenshot is used only as a first-frame
fallback when an idle compositor does not emit. This ordering prevents a fresh
frame from being covered by a late loading state and removes the need for a
manual resize. DevTools docks below the same target; its duplicate screencast is
disabled so the picker inspects the primary viewport.

Changes here require the real-browser coverage in `test/terminal-browser.spec.js` in addition to the general Playwright suite. The real terminal-browser case may skip when its machine binary is unavailable.

[Back to architecture index](index.md)
