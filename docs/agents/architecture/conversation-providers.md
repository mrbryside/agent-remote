# Mobile conversation providers

Phones use a native conversation surface when the selected managed chat can be
mapped to a supported agent session. Desktop and unsupported commands continue
to use xterm. The mobile UI never parses terminal cells.

## Provider boundary

`src/conversations/registry.js` is the provider selection point. A provider
implements `detect`, `read`, `watch`, and `sendInput`, plus explicit responders
for any provider-owned blocking interaction and optional turn cancellation;
the registry exposes the same thread/items/children contract to
`public/mobile-conversation.js` and serializes provider-owned input. New
adapters stay behind this boundary and do not add provider-specific UI branches.

Mobile initially requests the latest 80 timeline items. The provider retains
older pending interactions, plans, and subagent lifecycle items required by
auxiliary surfaces, while ordinary older messages remain behind an explicit
“Load earlier history” control. The browser also keeps the six most recent root
snapshots in an in-memory LRU: returning to a chat paints the last known state
immediately, then revalidates it through the conversation WebSocket. This cache
is presentational only; provider state remains authoritative.

## Grok ACP ownership

New interactive Grok chats are launched with `--leader`, a preallocated
`--session-id`, and Agent Remote's own `--leader-socket`. The socket defaults
beside the configured SQLite database (or
`AGENT_REMOTE_GROK_LEADER_SOCKET`), so unrelated Grok terminals, probes, and
IDEs using `~/.grok/leader.sock` cannot displace the managed tool executor or
cause newly spawned commands to die with `SIGKILL`. The TUI and ACP stdio
client must use the same Agent Remote socket; never point only one side at the
custom socket. The UUID is stored in tmux's
`@agent_remote_conversation_thread` metadata, so provider detection is available
before the first prompt and never guesses from cwd, pids, or the newest file.
Legacy Grok chats without this metadata are intentionally not projected into
the native mobile UI.

`src/conversations/acp-client.js` owns one persistent
`grok agent --leader stdio --leader-socket <path>` JSON-RPC client. It initializes once, calls
`session/load` for authoritative replay, deduplicates event ids, routes live
`session/update` notifications by session id, and calls `session/prompt` for
mobile input. It closes only its own stdio client; the interactive Grok TUI and
shared leader remain independently owned. Prompts are queued per ACP session,
so HTTP can acknowledge a mobile submission immediately while Grok completes
the preceding turn. The ACP client owns this pre-send queue because Grok's
shared pager queue mutations are not exposed to a generic ACP client. Queue
rows are therefore still removable before delivery; `Steer` removes one row
and sends the real `_x.ai/interject` request to the active turn. Grok does not
echo that interjection as a user-message update, so the ACP client inserts one
local `user_message_chunk` boundary using the queue row's display text. If the
RPC fails it removes the boundary and restores the row atomically. This keeps
the steered prompt visible in history and prevents later assistant chunks from
joining the preceding response or its Markdown code fence. A
`turn_completed` update drains the next row. No tmux cursor state, focus key,
`send-keys`, or concurrent headless resume process participates in native
input.

The managed leader is also a circuit-breaker boundary. Host-specific Codex and
browser-control environment variables and volatile runtime PATH entries are
removed before it starts, managed TUI sessions re-export that exact stable PATH
after login-shell initialization,
and its terminal metadata is normalized. On the first
ACP connection, Agent Remote also inspects the verified owner of its leader
socket and replaces an older leader that still carries any of those unsafe
values; this migrates already-running processes instead of waiting for another
tool failure. If a live
terminal tool update still reports `killed (signal 9)`, the ACP client marks
the shared runner unhealthy, waits until every active turn reaches its durable
completion boundary, disconnects the observer, terminates only the verified
owner of Agent Remote's leader socket, and reconnects before draining queued
prompts. This converts a poisoned long-lived executor into one failed tool
call rather than allowing every later command to inherit the failure.

Queue order is provider-owned state rather than a browser-only arrangement.
Mobile queue rows stay one compact, ellipsized line while preserving 44px
Steer/Delete targets plus a pointer and keyboard reorder handle. Attachments
collapse to a file count instead of increasing row height. A drop posts the complete ordered id set; the ACP
client applies it atomically only when it still matches the current pending
queue, otherwise the browser rolls back with the same layout animation. This
prevents a concurrent drain or steer from silently reordering the wrong prompt.

The ACP snapshot supplies live mobile turn activity. User,
thought, tool, assistant, retry, permission, question, and subagent updates map
to concise phases such as `Waiting for response…`, `Preparing read_file…`, and
`Responding…`; these phases are status metadata and are not extra timeline
cards. The composer keeps one contextual action: with an active turn and an
empty draft it sends the standard ACP `session/cancel` notification, while
typing a draft changes the same action back to Send so the prompt can be queued
or steered. An accepted `session/cancel` clears the pending Stop state
immediately and returns the composer to Send; the provider may continue
serializing the next prompt behind the still-settling `session/prompt` RPC.
Active snapshots expose a provider-owned `turnId`, derived from the ACP turn
revision, so a stale snapshot for the cancelled turn cannot restore Stop while
a genuinely newer turn can. Sending is request-scoped and ends as soon as a
WebSocket snapshot confirms the matching queued input, stored user message, or
new turn; it never waits for the input POST to finish. When that newer turn is
active, Stop takes precedence over any still-settling HTTP submission state.
`turn_completed` remains the authoritative provider boundary that clears the
activity indicator and releases that internal serialization. A cancellation
boundary is also retained as one muted, non-expandable mobile timeline row,
including elapsed turn time when the protocol timestamps allow it; successful
turn completions remain invisible.
Read-file cards derive their visible label from Grok's structured `target_file`,
`offset`, `limit`, and `FileContent.total_lines` fields. They show only the
basename plus the native line range, such as `Read app.js (231–490 of 2508)`.
The provider must retain the full path in `file.path` and `locations` for file
navigation, but raw absolute paths never belong in a timeline heading.
Every generic tool also exposes one canonical, bounded `summary` when Grok
provides a semantic `summary` or `description` in the update or its structured
input. Timeline rows prefer that summary and add the action for the semantic
tool kind; generated titles, subjects, and finally the command are presentation
fallbacks only. The complete command remains in the expanded command surface,
while non-command tools retain their serialized input and output in expanded
details. Never replace a semantic summary with Grok's later generated title,
which often embeds the entire shell command or absolute path.
The mobile renderer never defers provider snapshots behind pointer or scroll
gestures. Keyed DOM reconciliation preserves an open tool, code scroll
position, and pressed control without withholding token or lifecycle events;
this is important on iOS, where native scrolling can retain pointer capture
without a matching `pointerup`. Send, Steer, and Jump to latest explicitly
enable tail following. Incoming chunks continue snapping to the end until the
reader deliberately wheels or drags the history, after which the history
remains anchored until Jump to latest is chosen again. Scroll events caused by
Safari's visual-viewport resize or replacement of the pending row do not
release the submitted turn's tail latch.
The dedicated `/conversation-ws` connection sends one complete snapshot when
an assistant message starts, then sends compact
`{ threadId, messageId, delta }` frames for
subsequent text chunks. Tool, interaction, and lifecycle changes still carry a
complete snapshot. This keeps a long conversation from being serialized,
transferred, parsed, and traversed again for every token, which otherwise lets
mobile Safari fall progressively behind the desktop UI. A reconnect starts
with another complete snapshot so the compact frames never depend on state
from an earlier connection. WebSocket compression is disabled, and every ACP
chunk is sent as its own message without an application batching timer. This
transport is required for Random/Quick Cloudflare Tunnels, whose edge buffers
SSE even when the origin emits `text/event-stream`; both Quick and named
tunnels pass WebSockets through.
When iOS backgrounds the page, do not wait for a WebSocket error or close:
Safari can suspend the page without delivering either—or even without first
delivering a hidden/pagehide event. The mobile client closes its owned socket
and invalidates any in-flight snapshot on `visibilitychange`, `pagehide`,
window blur, or Page Lifecycle `freeze`. Every visible, `pageshow`, focus,
`online`, or `resume` signal forces a snapshot-first recovery even when the
client never observed the matching background event. A two-second liveness
probe also detects a suspended JavaScript clock gap and performs the same
repair. It first reads the authoritative full snapshot to recover every missed
token and lifecycle boundary, then opens a new socket. Socket frames invalidate
older in-flight HTTP reads so a late Safari fetch cannot restore a stale active
turn. The old socket is never reused after a foreground transition. The server emits an
application heartbeat every three seconds; the client resets a seven-second
watchdog for every conversation, control, open, or heartbeat message. A silent
socket is closed, reconciled from a full snapshot, and replaced. After an
accepted prompt, the client keeps the already-open conversation socket. Grok
can publish the user boundary and first token through that socket before the
input POST finishes its Cloudflare round trip; closing it at acceptance would
add another tunnel handshake and can miss fast start/completion boundaries.
The parallel snapshot remains a recovery path, while only backgrounding,
watchdog expiry, thread changes, or a real disconnect replace the socket.
The server still sends every ACP token as its own WebSocket frame. On the
phone, contiguous compact suffixes for the same assistant message coalesce on
a short visual cadence; this prevents a burst of hundreds of WebSocket
tasks from starving browser paint while preserving the exact ordered text. A
paint batch that completes Markdown structure (a line break,
list/heading marker, emphasis, inline code, link, table, or fence) reparses only
that active message and preserves its outer DOM node plus nested scroll
positions. Lists and emphasis therefore become formatted while the turn is
still streaming without bringing back full-history rerenders or a timer-based
transport batch. Once the first compact suffix for a message arrives, its
ordered suffix stream owns that message text until completion; active full
snapshots may still update metadata and tools but cannot replace or duplicate
the live text. Newly appended text and Markdown elements receive one restrained
shared-token fade/translate entrance; existing content never replays that
animation during a reparse, and reduced-motion keeps the same DOM contract. A
completed snapshot becomes authoritative again.
ACP `session/load` can replay a completed turn without replaying Grok's final
lifecycle notification. When the replay batch reaches its persisted boundary,
the client settles the live `turn.active` flag together with the synthesized
timeline boundary. An ACP disconnect also clears the transient active flag
before reconnecting.

A turn entered through the desktop Grok TUI is shared with the observer, but
some Grok leader versions broadcast its message chunks without broadcasting
the terminal `turn_completed` notification to the ACP stdio client. Therefore
`src/conversations/grok.js` also reads the bounded tail of that exact session's
persisted `updates.jsonl`. A newer persisted `user_message_chunk` marks the turn
active and a newer persisted `turn_completed` marks it idle; an older disk
boundary can never override newer ACP activity. While a provider stream is
active its watcher checks this boundary every 250 ms, so an already-open phone,
a later desktop-to-mobile resize, and the sidebar all settle from the same Grok
turn without waiting for another ACP event. This keeps Responding, Stop, and the
sidebar spinner from surviving a turn that is already complete on disk.

The provider reconciles that same timestamped boundary into the ACP client's
action state before Send, Steer, Stop, model, and mode operations. A durable
completion releases a stale pending prompt RPC, clears a stale cancel request,
and lets the next message start immediately instead of becoming a false queue
row. Conversely, a boundary older than the current local prompt cannot stop or
resurrect that newer turn. Re-reading an unchanged active boundary is
idempotent and preserves an in-flight Stop request, preventing watcher loops or
the composer from bouncing out of `Stopping…` before Grok completes the cancel.

An HTTP `202` prompt response is only a delivery receipt, not evidence that a
turn remains active. The optimistic pending message may show `Sending`, but it
must not force the composer into Stop or keep the sidebar busy. Once the
provider has reported an active-to-idle transition, the client clears that
pending state even if replay normalizes the user message differently.

The root snapshot also exposes provider-owned controls. Grok uses
`session/set_model` and one mutually exclusive mobile mode control: `Normal`,
`Plan`, `Auto`, or `Always approve`. Do not use ACP `session/set_mode` for this
control: Grok 1.0.5 accepts that request as display state without reliably
activating its Plan workflow. Mobile owns the selection instead. A Plan prompt
is delivered with a hidden control preface that requires Grok's real
`enter_plan_mode` / `exit_plan_mode` tool flow, while the visible user echo is
restored before timeline mapping. Normal, Auto, and Always approve send
`x.ai/yolo_mode_changed` with ask, auto, or bypass semantics. No runtime probe,
poll, or terminal-focus state participates in mode selection, and the mobile
choice is not required to mirror the terminal TUI selector.

The initial permission choice follows Grok's `[ui].permission_mode` config,
while a mobile change affects only the loaded Grok session through ACP. A real
`current_mode_update` from enter/exit Plan still updates the mobile control.
Model and mode selectors remain available while a turn streams. A choice made
during an active turn is projected into the mobile controls immediately but
retained as pending ACP state; immediately before the next queued
`session/prompt`, the client applies `session/set_model` and the mobile mode
contract in order. It never mutates the turn already in progress.

Composer completion also stays behind provider and project boundaries. Slash
commands come from Grok's live ACP `available_commands_update` notification;
the browser does not maintain a second hard-coded command catalog. Typing `/`
at the start of a line filters that advertised list. Typing `@` searches regular
files below the selected managed session's cwd while skipping dependency and
build trees. The input request carries the selected project-relative paths
separately from the visible text. Before ACP delivery, the server resolves each
path through `realpath`, rejects traversal and symlink escapes, and appends the
validated absolute file reference to the prompt.

Mobile uploads go through `src/conversations/attachments.js`. The browser sends
the selected file and display metadata in sequential 4 MiB chunks; there is no
application-level total file-size cap, and neither the browser nor server holds
the complete recording in memory. Each chunk carries an opaque upload UUID,
strict byte offset, and total size, so the server rejects gaps or cross-session
reuse and the client can show acknowledged progress. A failed upload is aborted
and removed from the temporary root, while its error remains visibly
dismissible in the attachment tray instead of relying on hidden header state.
The protocol never sends or receives a device filesystem path. Each server process owns a private temporary root
(`/tmp/agent-remote-uploads-*` on macOS), writes opaque mode-0600 files, binds
their ids to one managed session, and deletes the root on shutdown. The upload
response exposes only an opaque id and preview URL. Input APIs accept only
those ids and expand them to backend-local Markdown paths immediately before
ACP delivery; clients cannot submit arbitrary filesystem paths through the
attachment field. Preview responses are no-store, nosniff, sandboxed, and only
raster images render inline.
Attachment upload and removal also remain available during an active turn.
Uploaded ids stay in the local composer draft and are expanded only when that
later draft is submitted, so an upload cannot alter the prompt currently
streaming.

When Grok requests tool permission, the ACP client keeps the JSON-RPC request
open and projects its exact options into a native permission card. The mobile
API returns the selected option to that request; it never silently enables
always-approve. The least-privileged allow-once choice is presented first,
while session-wide and always-approve choices remain explicit. A denied spawn
finishes its existing subagent card as `Failed` instead of leaving `Calling`.
If the permission request arrives before the ordinary spawn notification, its
embedded tool call creates the lifecycle item immediately; later spawn and
finish events bind to that same identity instead of producing generic tool or
mode cards.

Grok's built-in `ask_user_question` tool is a separate blocking ACP extension:
`_x.ai/ask_user_question`. The ACP client keeps that exact JSON-RPC request open
and projects all questions into one native card. On mobile, that card is a
sequential wizard: it shows one question at a time, preserves answers through
Back/Next navigation and stream rerenders, then returns the complete answer set
only from the final step. Single-select, multi-select, and custom answers are
returned as Grok's prompt-keyed string map; multi-select labels are joined with
`, `. Skip returns the exact `skip_interview` outcome.
Responses include the selected child thread id, and the provider validates that
it belongs to the root conversation graph before replying, so a phone can also
answer a question raised inside a subagent. Mirrored question tool events are
merged into the same card instead of appearing in a tool group. Completed
question cards are reconstructed from replay even though their live JSON-RPC
request no longer exists.

Finishing a Grok Plan-mode draft is another blocking extension:
`_x.ai/exit_plan_mode` (the non-underscored spelling is accepted as well).
The request carries the authoritative `planContent`; the ACP client holds that
request open and projects it as a dedicated `plan_review` interaction instead
of a generic tool. On mobile, Plan Review replaces the composer with a bounded
`plan.md` reader. Each source line is selectable, a second line expands the
selection into a range, and saved comments retain their exact
`@plan.md:start-end` location. `Request changes` requires at least one line
comment or revision note, sends that structured feedback through
`_x.ai/interject`, then resolves the review as `cancelled` so Grok keeps
planning. `Approve plan` resolves it as `approved`; `Quit Plan mode` resolves
it as `abandoned` without feedback. The interjection must be written before
the review response but not awaited, because Grok drains it only after the
blocked exit request is released. The provider validates descendant thread
ownership before any response and maps a stale review to an HTTP conflict.
Approval from the desktop Grok TUI is authoritative too: the ACP client matches
the completed `exit_plan_mode` `PlanReady` update by `toolCallId`, resolves any
mirrored mobile request as `approved`, and closes the mobile interaction. It
remembers that completion briefly enough to handle replay ordering where the
tool result arrives before the mirrored review request, so changing viewport
cannot resurrect an already answered review.
Writes to Grok's session-owned `.grok/sessions/.../plan.md` artifact and the
enter/exit-plan tool calls are protocol detail: they update activity but never
appear in the visible tool timeline or tool groups.

`src/conversations/grok.js` translates user-relevant `sessionUpdate` values:
user and agent messages, thoughts, tool calls/results (including diffs and
images), plans, goals, hooks, retries, background tasks, and subagent lifecycle
events. Protocol-only mode/lifecycle noise updates state without becoming chat
cards. A contiguous run of mixed tool kinds forms one expandable activity
group; an intervening thought or other visible conversation item starts a new
group. Resolved permission prompts disappear instead of duplicating and
splitting the tool activity they approved. A thought remains `Thinking…` and
streams into its expandable reasoning panel until the next non-thought update
closes it; completed thoughts no longer remain falsely marked `Running`.
`turn_completed` updates lifecycle state. Normal completion remains protocol
detail, while a cancel, interrupt, or abort reason inserts one `turn` item at
that exact timeline boundary for the mobile cancellation row. `session_recap`
is both retained as the latest recap metadata and inserted at its protocol
position as a dedicated recap timeline item. Mobile renders that item expanded
by default as a muted, collapsible recap rather than an assistant message or a
generic tool card. Unknown future events remain visible as generic expandable
cards.

On mobile, both a collapsed tool group and an ungrouped tool use the same
borderless activity row. Each row owns one semantic leading icon and one
trailing disclosure chevron; do not add a second text glyph for the same
collapse action. Expanding a group reveals a borderless transcript of tool
rows, while expanding a standalone tool opens the same single containing frame.
Only a tool whose details are open gets that frame, avoiding nested cards. The
group owns a bounded, max-height vertical scroll viewport. Every generic Tool,
including list and unknown future tools, uses the same `$ action target` line
above its output inside that single frame; raw input, location, and output
sections are never split into separate cards. Shell commands use that same
surface while preserving whitespace and two-axis scrolling. Edit results
similarly render only the compact unified diff—with line numbers, green
additions, red removals, colored add/remove counts, bounded context, and
independent two-axis scrolling. Write and Edit share that renderer: each source
line is one non-wrapping row with one relevant line-number column and a separate
`+`/`−` marker, so narrow screens scroll horizontally instead of wrapping code.
The first appearance of a Write or Edit automatically expands its diff. If it
belongs to a Tool group, the group opens with that child; a manual collapse is
then authoritative and streamed snapshots must not reopen it.

Tool groups, their child tools, standalone tools, and thoughts share one
content-height disclosure animation. It measures the rendered panel and
animates height, opacity, and a small vertical offset with the design-system
normal duration/ease-out tokens; reduced-motion users get an immediate state
change. The open/closed identity remains in `expandedItems`, while transient
motion attributes survive timeline reconciliation so a streamed snapshot
cannot cancel a tap or make the panel jump between frames. Panels become inert
as soon as they close and receive the native `hidden` state only after the
closing motion finishes.

Spawn calls, permission-first embedded tool calls, `subagent_spawned`,
completion, and output polling collapse into one stable lifecycle item:
`Calling`, then `Running` and navigable, then `Done` or its failure state. Child
thread metadata never overwrites the parent lifecycle title, role, or status.
The spawn tool returning `completed` means only that the background child was
created; it stays `Running` until `subagent_finished` or a child TaskOutput
reports a terminal status.
On mobile, root history aggregates these items into one persistent bottom pill
showing the running count. Grok `plan` updates also stay out of the chat timeline:
the shared Browser/Plan/Subagents dock shows completed/total plan progress, and
its Plan action opens a content-height activity sheet with the live task states,
bounded to the viewport instead of stretching a short plan to the 80% sheet
height. Choosing an agent opens its realtime conversation in the draggable
80%-viewport sheet that slides up from below. The dock has an explicit dismiss
action; while dismissed, a compact header action restores it without covering
history or the composer. Dismissal lasts for the selected chat and survives
streamed dock updates. The Plan sheet's X dismisses that plan revision from the
dock until its status or tasks change; the Browser sheet's X closes its renderer
and removes Browser from the dock until a new browser control event arrives.
Closing a Subagent sheet never dismisses its lifecycle item. Closing any sheet
restores the root SSE stream and scroll position. When a child UUID
appears, the provider loads that child through the same ACP connection. Its
replay and live updates use the same translation recursively, so nested
subagents remain realtime and navigation cannot escape the root's discovered
graph.

After the initial HTTP read, `/api/conversations/:session/stream` publishes the
provider-neutral snapshots over SSE. Provider watchers are released when the
browser disconnects or the server stops. Every live ACP notification for the
selected thread is translated synchronously from the client's in-memory event
snapshot and written to SSE immediately; it does not wait for the filesystem
poll, child graph hydration, an animation-frame batch, or a synthetic
typewriter timer. Agent-message updates use the exact ACP suffix, keeping the
provider hot path O(chunk) rather than reparsing the complete session history.
The slower persisted-session read remains a 250 ms fallback
for desktop-originated lifecycle boundaries that some Grok versions omit from
ACP. Those full reads are serialized and revision-checked: an ACP update
received during a read invalidates that read and rebuilds it before publishing.
A slow active-turn snapshot therefore cannot overwrite a newer completed-turn
snapshot. Root snapshots also publish without hydrating child sessions; a slow
or unavailable child can never delay the main agent's `turn_completed`,
activity indicator, or Send/Stop state.

The mobile renderer keeps timeline nodes keyed by message/event id and
reconciles changing contents in place. While the last assistant message is
active, each SSE chunk appends only its new suffix to the existing text node;
it does not replace the article or the existing code viewport. A newly opened
or closed fenced block is reparsed once at that structural boundary; code
inside an open fence then appends in place so it remains scrollable. When `turn_completed`
arrives, that one message is rendered once as sanitized Markdown and the
Responding/Stop state clears in the same update. A tool batch is
identified by its first tool call, so appending later adjacent tools never
changes the group key. Unchanged item fingerprints skip DOM work entirely;
existing nested details, scroll positions, compositor layers, tool-group and
event toggles retain identity while output streams, so a touch cannot lose its
click target between pointer down and click. Opening or switching a root conversation places
the message viewport at its latest item synchronously, with no smooth initial
scroll animation. Later stream updates follow the tail only while the reader
is already there. Scrolling up reveals a jump-to-latest control; that explicit
action scrolls smoothly unless the device requests reduced motion.

The sidebar consumes the same provider lifecycle as the native conversation.
Each live snapshot records when it was observed; a slower `/api/sessions` poll
may refresh catalog metadata but cannot overwrite a newer SSE idle state with
an older persisted `working` flag. This timestamp boundary keeps Responding,
Stop, and the sidebar spinner aligned after `turn_completed`.

The same session-scoped SSE connection may carry a `control` event for browser
surface requests originating inside the headless ACP leader. This is transport
metadata rather than a conversation timeline item. The mobile view validates
the command shape, opens the existing session-keyed graphics renderer, and
publishes Browser availability into the shared Browser/Plan/Subagents activity dock.

Completed assistant message text is parsed as GitHub-flavored Markdown with the
locally bundled Marked runtime. Its HTML output must pass through
DOMPurify's HTML-only profile before entering the DOM; raw forms and styling are
forbidden, unsafe URLs are removed, external links receive `noopener noreferrer`,
and remote images omit referrers. Code blocks and tables get bounded scroll
containers, while code blocks also receive a client-created Copy control. User
messages remain plain text. Both browser libraries are packaged into the macOS
runtime, so Markdown rendering cannot depend on a CDN or network availability.

During initial ACP connection, the native mobile surface continues to own the
viewport behind one opaque `Preparing chat…` cover; it does not reveal xterm,
`Connecting`/`Reconnecting` header state, or partially hydrated history. The
cover is removed only after the first complete conversation snapshot has been
committed, so the transition into the chat is atomic. A temporarily unavailable
provider keeps the same cover and retries instead of falling through to the
terminal for one frame. A new Grok chat reserves
that native surface optimistically on the original `+` click, before session
creation returns. Once active, the native surface also owns the only mobile
header and places project navigation there; the terminal topbar is removed from
layout instead of being stacked above the conversation header.

## Future adapters

Other agents should implement their own reliable active-session and transport
contract behind the registry. A provider must not infer a thread from cwd alone.
If it cannot prove ownership, detection returns unavailable and the phone uses
xterm for that unsupported command.

[Back to architecture index](index.md)
