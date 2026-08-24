# Browser renderer

The integrated terminal browser is not rendered inside the agent's tmux pane. The routing shim sends an owning-session request to `src/server.js`, which starts a separate graphics PTY and connects to the browser daemon through CDP. This avoids Kitty placeholder output in the main terminal.

Agent Remote owns a private terminal-browser runtime socket tree and Chromium
profile beside its SQLite state. It never shares the host terminal's daemon or
profile. A server-side supervisor owns that sidecar lifecycle: startup removes
an unadoptable daemon left by a prior process, renderer discovery can recycle a
hung daemon once and retry, a bounded watchdog reaps stale automation workers,
and shutdown closes the private daemon. If terminal-browser hangs before it
registers its process, the supervisor resolves the owner of the private Unix
socket, verifies the exact installed daemon entrypoint, and terminates only
that PID. This isolation permits self-healing without closing a browser
launched by another application.

The Grok ACP leader and its tool subprocesses may run outside tmux or strip the
`AGENT_REMOTE_*` environment. The project-local dispatcher therefore attempts
backend routing for every implicit `open`, `new-tab`, and `action` command. It
uses an explicit session when one can be proven and otherwise sends its cwd.
The exception is a shared Grok leader: it inherits the tmux session of the
first chat that started it, while each tool subprocess receives the current
`GROK_SESSION_ID`. The dispatcher sends that thread id on every browser
control request and the server resolves it against the managed chat's
persisted `conversationThreadId` before considering tmux or cwd. A present but
unknown thread id fails closed and never mutates the stale leader-owner chat.
The server resolves that cwd only against connected managed chats, preferring
the single working conversation and rejecting ambiguous matches instead of
broadcasting a browser command to unrelated sessions. Commands outside an
agent-remote project fall back to the real host binary only when the local
backend is unreachable. A reachable backend's routing rejection is
authoritative: the shim exits with its actionable error and never launches the
host terminal's Kitty renderer from a Grok subprocess. This distinction avoids
false success, cross-session ownership, and long-lived renderer children that
the agent runtime may later kill.

The routing acknowledgement is end-to-end. The shim asks the control route to
wait, the route observes a new renderer launch generation, and success is
returned only after browser registration, CDP attachment, and the first frame
put the renderer in `ready`. Delivery of the frontend control event alone is
never reported as “Opened.” A renderer failure is returned to the originating
tool call, while non-waiting internal control callers retain the asynchronous
202 delivery contract. An `open` received while that session's renderer is
already starting or ready is idempotent: the route coalesces with the current
launch, the frontend reveals its existing split without replacing the graphics
socket or DOM pane, and a ready renderer returns `reused` with the same browser
key. Reuse remains valid while the dedicated renderer socket is healthy even
if a mobile main-chat socket is briefly reconnecting. Do not make a repeated
open wait for a generation that will never exist or require an unrelated chat
socket before acknowledging the existing browser.

Each session owns one keyed renderer and one UI split state. The browser toolbar reflects the daemon's real tabs with keyed DOM nodes, so polling can update labels and active state without replacing a button during a click. Back/forward/reload, tab changes, Inspect, and Record are routed to that renderer. Refresh and session switching reattach to the same backend renderer; closing the final tab, split, session, or project must clean up the renderer and daemon.

Tab mutations are serialized per renderer. A daemon response received while a
surface refresh is already running is queued and applied afterward rather than
dropped; otherwise two quick closes leave the UI holding tab ids the daemon no
longer owns. The backend `close-tab` route verifies every requested id
disappears before reporting success and can close multiple ids atomically from
the shim. For compatibility, an implicit `action ... eval "window.close()"` is
translated to this authoritative close path because Chromium can ignore
script-level `window.close()` while the eval command itself still exits zero.
The toolbar removes a clicked tab optimistically while the daemon mutation
runs in that renderer's queue. Each click also records whether it was visibly
the final tab. A request made while multiple tabs were visible must never close
the entire renderer merely because an earlier queued close completed first;
the authoritative surface restores any rejected optimistic removal.
Closing the visibly final tab bypasses tab mutation entirely and invokes the
same immediate frontend disposal plus renderer teardown as the pane close
button. The server treats a missing final-tab flag as the legacy close behavior
so a cached pre-flag client cannot silently preserve or restore its last tab;
only an explicit `false` is the multi-close race guard.

Renderer discovery must match terminal-browser's published `tty` to the
graphics PTY that launched it. A newly listed browser key alone is not proof of
ownership because two chats can open browsers concurrently. Builds without PTY
metadata may use the legacy single-candidate fallback, but must never guess
between multiple candidates.

Public browser-state discovery, the shim's `ls`, and implicit `action` commands
resolve through the same owning session and expose only that session's browser
and tabs. Server-internal renderer discovery uses a private graphics-routing
marker so it can inspect all owned daemon processes without passing through the
public session filter. Never expose that global view through a client route.

Desktop control events use the selected terminal WebSocket. Native mobile conversations intentionally suspend that socket, so their dedicated conversation WebSocket also carries validated `open-graphics` control events. Both transports address the same session-keyed renderer. On phones the renderer is presented as a draggable bottom sheet occupying 70% of the available terminal stage and sliding up from below, leaving conversation context visible above it. Its Chrome target uses the exact narrow CSS viewport while the frame keeps CSS-pixel input coordinates. A renderer restored while the page is already compact starts hidden so refresh never covers the mobile conversation; the Browser activity pill or bottom Browser button opens it explicitly. Dismissing the sheet only changes frontend visibility and keeps the renderer alive. If subagents are also present, Browser and Subagents share one activity dock, and each sheet exposes a direct switch to the other so the two surfaces never stack.

On desktop a right-side-panel toggle in the main top bar hides or reveals the
active session's browser split without closing its renderer. The toggle stays
available while the split is hidden; it is not a renderer lifecycle control.

The sheet's close button is different from dismissal: it closes the keyed
renderer and unregisters the owning terminal-browser process, while dragging
down or tapping the backdrop remains the reversible hide action.
Frontend close uses an authenticated idempotent HTTP delete with `keepalive`
rather than relying on the graphics WebSocket to deliver its final message as a
PWA is suspended. The client keeps a close tombstone until a later renderer
listing observes the key absent, so an older discovery response cannot restore
the pane after the user closed it. Foreground, pageshow, and resumed-timer
signals discard page-local graphics sockets and reattach to the authoritative
renderer list while preserving whether the sheet was visible or dismissed.
Terminal-browser allows itself a bounded two-second grace period to process
`SIGINT` and unregister cleanly. Agent Remote must not force-kill at that exact
boundary. It waits
past that boundary and checks that the exact browser registry key disappeared,
then tears down the owning PTY; a bounded five-second fallback closes only that
PTY connection when the client is wedged. Closing one session's browser must
leave every other session-owned browser alive. A background ownership sweep
also closes session renderers whose managed tmux chat has ended outside the
normal delete route. The automation CLI creates one
`agent-browser` worker for each browser key after its first action. Agent Remote
closes that exact worker with the renderer; it never uses a global shutdown.
At server startup it compares live worker sockets with the global browser
registry and closes only workers whose browser owner no longer exists. This
second boundary recovers workers orphaned by a prior crash and prevents them
from accumulating until Grok's command executor is killed under resource
pressure.

terminal-browser installation paths include an eight-character hash of the
physical distribution root. Worker cleanup must derive that exact hashed
runtime directory; an un-hashed `terminal-browser/agent-browser` path silently
sees no sockets and recreates the resource leak. Crash-backlog cleanup is
sequential so recovery itself cannot create another process spike.

The page viewport displays Chromium's compositor screencast directly. Layout
and input use CSS-pixel coordinates while the raster scale follows the visible
client's device pixel ratio, bucketed and capped at 3x. This keeps Retina phone
surfaces sharp without making pointer coordinates device-pixel based. Electron's
compositor stream can remain at its physical 1x backing scale, so live motion
uses those low-latency frames and 140ms of compositor quiet schedules one
exact-viewport screenshot at the requested scale. A new live frame cancels or
invalidates that optional settle capture; it is never a second encode for every
motion frame. CDP frames are acknowledged immediately. The server keeps only the
newest frame while a WebSocket write is in flight, and the browser keeps only the
newest frame waiting for decode. A decoded frame is presented on the next
animation frame before decoding the newest replacement, which preserves steady
cadence without building a delayed queue. Screencasting stops when every client hides
the surface and restarts when one becomes visible. A top-level navigation
reapplies the exact CSS viewport and restarts the screencast even when the CDP
target id does not change. Target metadata reaches the frontend before the first
new frame, and one scaled exact-viewport screenshot is also used as a first-frame
fallback when an idle compositor does not emit. This ordering prevents a fresh
frame from being covered by a late loading state and removes the need for a
manual resize. Switching or creating a tab keeps the previous canvas painted
until the replacement target's first frame arrives; the full opening cover is
reserved for the renderer's initial frame and must not flash on tab changes.
DevTools docks below the same target; its duplicate screencast is
disabled so the picker inspects the primary viewport. Automation commands such
as `snapshot` may reset Chrome's device metrics through their own CDP session;
after every backend action the renderer compares the live inner size and DPR
with its authoritative viewport and reapplies metrics only when they differ.
This prevents action-driven blur and viewport jumps without restarting the
screencast after every command.

Keyboard input is forwarded as complete CDP key events, including the Windows
virtual key code Chromium uses for default editing behavior, modifier bits,
location, repeat state, and generated text. Keep this mapping intact for
Enter/Space/Tab, editing and navigation keys, function/numpad keys, and
platform shortcuts; forwarding only DOM `key` and `code` makes printable text
appear to work while silently breaking form submit and caret movement.

Changes here require the real-browser coverage in `test/terminal-browser.spec.js` in addition to the general Playwright suite. The real terminal-browser case may skip when its machine binary is unavailable.

[Back to architecture index](index.md)
