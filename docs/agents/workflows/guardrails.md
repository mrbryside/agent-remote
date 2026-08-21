# Implementation guardrails

Read this before a change crosses tmux ownership, persistence, Remote security, browser rendering, or visual-system boundaries.

- Preserve user-owned tmux sessions. Only sessions carrying the `@agent_remote` marker belong to agent-remote.
- Keep projects and chat metadata in SQLite while live processes stay in tmux. Browser storage is preference/cache state, never authoritative process state.
- Keep Remote metadata in SQLite, the Cloudflare user token in macOS Keychain, tunnel tokens in child environments, and pairing/session/challenge secrets in memory. Do not add a plaintext credential fallback.
- Keep `/api/remote/*` on the local listener. The remote gateway remains loopback-only, requires a paired device session, and never exposes administration routes.
- Keep both listeners loopback-only. Validate local `Host` against the actual
  listener authority before accepting `Origin`; never trust two matching
  client-controlled headers as proof of locality.
- Parse HTTP and WebSocket request targets through
  `src/server/request-target.js`. Reject malformed, absolute-form,
  dot-normalized, and encoded-separator targets with bounded responses instead
  of allowing URL normalization to choose a route.
- Browser authentication uses the process-memory HttpOnly cookie created by
  the one-time root token bootstrap. Do not put bearer tokens in API, asset,
  preview, SSE, WebSocket, or DevTools URLs.
- Preserve explicit HTTP timeouts and the shared capacity limit for workspace
  streams, conversation streams, and DevTools transports. Every accepted
  long-lived connection must release its reservation on close and shutdown.
- Never overwrite or delete Cloudflare DNS/tunnel resources without an exact live match to stored ownership metadata. Stop preserves resources; Remove revalidates before deletion.
- Keep every terminal-browser renderer owned by one session and fully clean up its PTY, tabs, and daemon when its last tab or owning chat closes.
- Add visual primitives to `public/tokens.css` and consume semantic tokens from CSS and JavaScript.
- Run focused tests while iterating and `npm run test:all` before handoff. On Darwin ARM64 desktop changes, also run `npm run sidecar:smoke`, `cargo test --manifest-path src-tauri/Cargo.toml`, and `npm run desktop:build`.

[Back to workflow index](index.md)
