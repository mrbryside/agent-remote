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
- HTTP/WebSocket/PTY/tmux behavior: `test/server.test.js`
- Project/sidebar/terminal UX and responsive behavior: `test/e2e.spec.js`
- Grok ACP request/response extensions (permissions, questions, and Plan Review): `test/grok-acp.test.js`
- Provider-neutral timeline mapping, child-thread ownership, and interaction projection: `test/conversation-providers.test.js`
- Real terminal-browser routing (including cwd fallback with tmux and routing environment removed), desktop split, mobile sheet persistence, tabs, frames, DevTools, Record, cursor, refresh, and cleanup: `test/terminal-browser.spec.js`
- Remote configuration: `test/config.test.js`
- Remote SQLite state and device audit lifecycle: `test/remote-store.test.js`
- Keychain, Cloudflare API, ownership provisioning, auth, controller, and tunnel state machines: `test/remote-*.test.js`
- Local/remote listener boundary, remote routes, WebSockets, and shutdown: `test/server.test.js`
- Remote pairing, returning-device, revocation, and fake named-domain flows: `test/remote-e2e.spec.js`
- Tauri configuration and wrapper lifecycle: `test/tauri-contract.test.js` and `src-tauri/src/main.rs` tests

Tests that create tmux sessions, projects, remote stores, or child tunnels must clean up even after failure. Use unique project/session markers, temporary SQLite paths, and fake cloudflared processes; assert Remote Stop/close leaves no orphaned child. Avoid relying on execution order beyond the suite's explicit serial configuration. Run sidecar and desktop checks only on Darwin ARM64.

[Back to workflow index](index.md)
