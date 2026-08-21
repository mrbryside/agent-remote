# Browser renderer

The integrated terminal browser is not rendered inside the agent's tmux pane. The routing shim sends an owning-session request to `src/server.js`, which starts a separate graphics PTY and connects to the browser daemon through CDP. This avoids Kitty placeholder output in the main terminal.

The Grok ACP leader and its tool subprocesses may run outside tmux or strip the
`AGENT_REMOTE_*` environment. The project-local dispatcher therefore attempts
backend routing for every implicit `open`, `new-tab`, and `action` command. It
uses an explicit session when one can be proven and otherwise sends its cwd.
The server resolves that cwd only against connected managed chats, preferring
the single working conversation and rejecting ambiguous matches instead of
broadcasting a browser command to unrelated sessions. Commands outside an
agent-remote project fall back to the real host binary only when the local
backend is unreachable. A reachable backend's routing rejection is
authoritative: the shim exits with its actionable error and never launches the
host terminal's Kitty renderer from a Grok subprocess. This distinction avoids
false success, cross-session ownership, and long-lived renderer children that
the agent runtime may later kill.

Each session owns one keyed renderer and one UI split state. The browser toolbar reflects the daemon's real tabs with keyed DOM nodes, so polling can update labels and active state without replacing a button during a click. Back/forward/reload, tab changes, Inspect, and Record are routed to that renderer. Refresh and session switching reattach to the same backend renderer; closing the final tab, split, session, or project must clean up the renderer and daemon.

Public browser-state discovery, the shim's `ls`, and implicit `action` commands
resolve through the same owning session and expose only that session's browser
and tabs. Server-internal renderer discovery uses a private graphics-routing
marker so it can inspect all owned daemon processes without passing through the
public session filter. Never expose that global view through a client route.

Desktop control events use the selected terminal WebSocket. Native mobile conversations intentionally suspend that socket, so their dedicated conversation WebSocket also carries validated `open-graphics` control events. Both transports address the same session-keyed renderer. On phones the renderer is presented in a draggable 70%-viewport bottom sheet that slides up from below rather than a full-screen xterm layer. A renderer restored while the page is already compact starts hidden so refresh never covers the mobile conversation; the Browser activity pill or bottom Browser button opens it explicitly. Dismissing the sheet only changes frontend visibility and keeps the renderer alive. If subagents are also present, Browser and Subagents share one activity dock, and each sheet exposes a direct switch to the other so the two surfaces never stack.

On desktop a right-side-panel toggle in the main top bar hides or reveals the
active session's browser split without closing its renderer. The toggle stays
available while the split is hidden; it is not a renderer lifecycle control.

The sheet's close button is different from dismissal: it closes the keyed
renderer and unregisters the owning terminal-browser process, while dragging
down or tapping the backdrop remains the reversible hide action.
Shutdown allows a bounded two-second grace period for the renderer to process
`SIGINT` and unregister cleanly. Closing one session's browser must leave every
other session-owned browser alive. The automation CLI also creates one
`agent-browser` worker for each browser key after its first action. Agent Remote
closes that exact worker with the renderer; it never uses a global shutdown.
At server startup it compares live worker sockets with the global browser
registry and closes only workers whose browser owner no longer exists. This
second boundary recovers workers orphaned by a prior crash and prevents them
from accumulating until Grok's command executor is killed under resource
pressure.

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

Keyboard input is forwarded as complete CDP key events, including the Windows
virtual key code Chromium uses for default editing behavior, modifier bits,
location, repeat state, and generated text. Keep this mapping intact for
Enter/Space/Tab, editing and navigation keys, function/numpad keys, and
platform shortcuts; forwarding only DOM `key` and `code` makes printable text
appear to work while silently breaking form submit and caret movement.

Changes here require the real-browser coverage in `test/terminal-browser.spec.js` in addition to the general Playwright suite. The real terminal-browser case may skip when its machine binary is unavailable.

[Back to architecture index](index.md)
