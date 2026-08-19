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
and sends the real `_x.ai/interject` request to the active turn. A
`turn_completed` update drains the next row. No tmux cursor state, focus key,
`send-keys`, or concurrent headless resume process participates in native
input.

Queue order is provider-owned state rather than a browser-only arrangement.
Mobile queue rows expose full-size Steer/Delete actions plus a pointer and
keyboard reorder handle. A drop posts the complete ordered id set; the ACP
client applies it atomically only when it still matches the current pending
queue, otherwise the browser rolls back with the same layout animation. This
prevents a concurrent drain or steer from silently reordering the wrong prompt.

The ACP snapshot is also the source of truth for mobile turn activity. User,
thought, tool, assistant, retry, permission, question, and subagent updates map
to concise phases such as `Waiting for response…`, `Preparing read_file…`, and
`Responding…`; these phases are status metadata and are not extra timeline
cards. The composer keeps one contextual action: with an active turn and an
empty draft it sends the standard ACP `session/cancel` notification, while
typing a draft changes the same action back to Send so the prompt can be queued
or steered. `turn_completed` clears both the activity indicator and the pending
cancel state. Treat that notification as the authoritative visible boundary:
the underlying `session/prompt` JSON-RPC promise may still be settling so the
queue remains serialized, but the phone must already leave its streaming/Stop
state when Grok says the turn is complete.

The root snapshot also exposes provider-owned controls. Grok uses
`session/set_model` and one mutually exclusive mode control: `Normal`, `Plan`,
`Auto`, or `Always approve`. `Plan` maps to ACP `session/set_mode` `plan`; the
other choices use `default` plus `_x.ai/yolo_mode_changed` with ask, auto, or
bypass semantics. Incoming `current_mode_update.currentModeId` notifications
update the same control, so the mobile selection and Grok session do not expose
independent plan and permission dropdowns. The initial choice follows Grok's
`[ui].permission_mode` config, while a mobile change affects only the loaded
Grok session through ACP.

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
the selected file bytes and display metadata; it never sends or receives a
device filesystem path. Each server process owns a private temporary root
(`/tmp/agent-remote-uploads-*` on macOS), writes opaque mode-0600 files, binds
their ids to one managed session, and deletes the root on shutdown. The upload
response exposes only an opaque id and preview URL. Input APIs accept only
those ids and expand them to backend-local Markdown paths immediately before
ACP delivery; clients cannot submit arbitrary filesystem paths through the
attachment field. Preview responses are no-store, nosniff, sandboxed, and only
raster images render inline.

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
`turn_completed` updates lifecycle state but is not rendered. `session_recap`
is retained as metadata instead of becoming a chat message. Unknown future
events remain visible as generic expandable cards.

On mobile, expanded tool groups own one fixed-height vertical scroll viewport.
Nested Shell, output, input, and generic detail blocks preserve whitespace and
can scroll both axes instead of wrapping long commands. Edit results render as
a compact unified diff with line numbers, add/remove counts, bounded context,
and independent two-axis scrolling.

Spawn calls, permission-first embedded tool calls, `subagent_spawned`,
completion, and output polling collapse into one stable lifecycle item:
`Calling`, then `Running` and navigable, then `Done` or its failure state. Child
thread metadata never overwrites the parent lifecycle title, role, or status.
On mobile, root history aggregates these items into one persistent bottom pill
showing the running count. The pill opens a selector; choosing an agent opens
its realtime conversation in a draggable half-height bottom sheet. Closing the
sheet restores the root SSE stream and scroll position. When a child UUID
appears, the provider loads that child through the same ACP connection. Its
replay and live updates use the same translation recursively, so nested
subagents remain realtime and navigation cannot escape the root's discovered
graph.

After the initial HTTP read, `/api/conversations/:session/stream` publishes the
provider-neutral snapshots over SSE. Provider watchers are released when the
browser disconnects or the server stops. Grok snapshot reads are serialized and
revision-checked: an ACP update received during a graph read invalidates that
read and rebuilds it before publishing. A slow active-turn snapshot therefore
cannot overwrite a newer completed-turn snapshot. Assistant text is painted immediately
from those provider chunks; the browser does not add a synthetic typewriter
delay after a chunk arrives. The mobile renderer keeps timeline nodes keyed by
message/event id and reconciles the changing contents in place. Tool-group and
event toggle elements therefore retain identity while output streams, so a
touch cannot lose its click target between pointer down and click. Incoming SSE
snapshots are latest-wins within one animation frame instead of forcing a full
history detach for every chunk. Opening or switching a root conversation places
the message viewport at its latest item synchronously, with no smooth initial
scroll animation. Later stream updates follow the tail only while the reader
is already there. Scrolling up reveals a jump-to-latest control; that explicit
action scrolls smoothly unless the device requests reduced motion.

The same session-scoped SSE connection may carry a `control` event for browser
surface requests originating inside the headless ACP leader. This is transport
metadata rather than a conversation timeline item. The mobile view validates
the command shape, opens the existing session-keyed graphics renderer, and
publishes Browser availability into the shared Browser/Subagents activity dock.

Assistant message text is reparsed on each snapshot as GitHub-flavored Markdown
with the locally bundled Marked runtime. Its HTML output must pass through
DOMPurify's HTML-only profile before entering the DOM; raw forms and styling are
forbidden, unsafe URLs are removed, external links receive `noopener noreferrer`,
and remote images omit referrers. Code blocks and tables get bounded scroll
containers, while code blocks also receive a client-created Copy control. User
messages remain plain text. Both browser libraries are packaged into the macOS
runtime, so Markdown rendering cannot depend on a CDN or network availability.

During initial ACP connection, the
native mobile surface continues to own the viewport and shows reconnecting
state; it does not briefly attach xterm and resize the shared tmux pane. A new
Grok chat reserves that native surface optimistically on the original `+`
click, before session creation returns, so even the pending frame says
`Connecting to Grok` rather than rendering the generic terminal loader. Once
active, the native surface also owns the only mobile header and places project
navigation there; the terminal topbar is removed from layout instead of being
stacked above the conversation header.

## Future adapters

Other agents should implement their own reliable active-session and transport
contract behind the registry. A provider must not infer a thread from cwd alone.
If it cannot prove ownership, detection returns unavailable and the phone uses
xterm for that unsupported command.

[Back to architecture index](index.md)
