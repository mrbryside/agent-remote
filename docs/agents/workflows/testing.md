# Testing

## Commands

| Command | Coverage |
| --- | --- |
| `npm test` | Node unit and backend integration tests in `test/*.test.js` |
| `npm run test:e2e` | Serial Playwright UI, real PTY/tmux, Remote pairing, refresh, resize, optimistic action, and browser-pane tests |
| `npm run sidecar:smoke` | Packaged ARM64 launcher, both listeners, real PTY WebSocket output, and child cleanup |
| `cargo test --manifest-path src-tauri/Cargo.toml` | Tauri backend attach/ownership/readiness and lifecycle tests |
| `npm run desktop:build` | Apple Silicon Tauri `.app` packaging gate |
| `npm run test:all` | Required full suite |

Playwright runs serially because the tmux fixture, browser renderer, SQLite file, and Remote fixtures are process-global integration resources. Its local fixture listens on port 3100 and the Remote fixture on 3101; test data is stored under `test-results/`. The Remote fixture uses fake Cloudflare/tunnel services, deterministic time, and a programmatic insecure-origin/non-Secure-cookie seam. It must never contact a live Cloudflare account.

## Where to add coverage

- Configuration parsing: `test/config.test.js`
- SQLite schema and migrations: `test/projects.test.js`
- Session naming, command quoting, and CLI: `test/sessions.test.js`
- HTTP/WebSocket/PTY/tmux behavior, including compact conversation token frames and watcher cleanup: `test/server.test.js`
- Project/sidebar/terminal UX and responsive behavior: `test/e2e.spec.js`
- Grok ACP transport ownership, timestamped persisted-turn reconciliation, real active-turn queue/steer/cancel ordering, all four mobile mode mappings, hidden Plan prompt control, and request/response extensions (leader socket, permissions, questions, and Plan Review): `test/grok-acp.test.js`
- Provider-neutral timeline mapping, child-thread ownership, and interaction projection: `test/conversation-providers.test.js`
- Real terminal-browser routing (including cwd fallback with tmux and routing environment removed), direct compositor-stream cadence/backpressure, stable frame source during motion, desktop split, mobile sheet persistence, tabs, DevTools, Record, cursor, refresh, and cleanup: `test/terminal-browser.spec.js`
- Terminal-browser shim reachability, authoritative routing rejection, and session-filtered discovery: `test/terminal-browser-shim.test.js`
- Browser automation worker path validation, exact-session close, and stale-owner reaping: `test/browser-automation.test.js`
- Remote configuration: `test/config.test.js`
- Remote SQLite state and device audit lifecycle: `test/remote-store.test.js`
- Keychain, Cloudflare API, ownership provisioning, auth, controller, and tunnel state machines: `test/remote-*.test.js`
- Local/remote listener boundary, remote routes, WebSockets, and shutdown: `test/server.test.js`
- Remote pairing, returning-device, revocation, and fake named-domain flows: `test/remote-e2e.spec.js`
- Tauri configuration and wrapper lifecycle: `test/tauri-contract.test.js` and `src-tauri/src/main.rs` tests

Tests that create tmux sessions, projects, remote stores, or child tunnels must clean up even after failure. Use unique project/session markers, temporary SQLite paths, and fake cloudflared processes; the Grok leader socket follows the temporary database path so tests cannot attach to a user's default leader. Assert Remote Stop/close leaves no orphaned child. Avoid relying on execution order beyond the suite's explicit serial configuration. Run sidecar and desktop checks only on Darwin ARM64.

Before handing off cross-surface lifecycle or renderer changes, also exercise
the running app through Codex's in-app browser at a phone viewport. Complete a
real Grok turn, wait beyond one sidebar polling interval, and confirm the
composer, native activity, and sidebar all settle together. Background and
foreground the page once and confirm the conversation WebSocket reconnects from
an authoritative snapshot without leaving Responding/Stop active. For browser
ownership changes, open distinct URLs from two managed sessions, verify each
session sees only its own tab list, then close one renderer and confirm the
other remains usable. This manual check complements Playwright by using the
actual in-app browser transport and compositor.

[Back to workflow index](index.md)
