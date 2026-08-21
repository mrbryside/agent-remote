# HTTP security hardening

- [x] Task 1: Enforce exact local Host/Origin trust boundaries for HTTP and WebSocket traffic; add DNS-rebinding regression tests. Depends on: none.
- [x] Task 2: Make HTTP and upgrade entrypoints reject malformed request targets without unhandled exceptions; add raw-request regression tests. Depends on: none.
- [x] Task 3: Apply anti-framing/security headers to the local workspace and protect local DevTools assets with the normal local auth boundary; add tests. Depends on: none.
- [x] Task 4: Add explicit HTTP timeout/connection limits and bound SSE/DevTools transports; add lifecycle tests. Depends on: none.
- [x] Task 5: Remove bearer-token propagation from ordinary HTTP query strings, constrain non-loopback cleartext exposure, update documentation, and preserve supported browser WebSocket authentication. Depends on: Task 1, Task 3.
- [x] Task 6: Integrate, run the complete test suite, and perform final security review. Depends on: Task 1, Task 2, Task 3, Task 4, Task 5.

Verification: the complete Node unit/backend suite passes 209/209; dependency
audit reports zero production vulnerabilities; raw HTTP/WS probes confirm
DNS-rebinding rejection and bounded malformed-target responses. Playwright is
tracked separately because it exercises process-global tmux, browser-renderer,
SQLite, and Remote fixtures.
