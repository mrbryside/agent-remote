# Tauri and Cloudflare remote access implementation plan

Design source: `docs/specs/2026-08-18-tauri-cloudflare-remote-access.md`

Implementation rule: keep the Node backend authoritative in both `npm start` and Tauri modes. Work test-first, preserve user-owned tmux sessions, and commit after each green task.

## Task 1: Add Remote configuration and stable errors

**Files:**

- Modify: `src/config.js`
- Create: `src/remote/errors.js`
- Modify: `test/config.test.js`

**Depends on:** none

- [x] Add failing config assertions for `remoteHost`, default `REMOTE_PORT=PORT+1`, the `PORT=0` test behavior, `CLOUDFLARED_BIN`, `AGENT_REMOTE_DESKTOP`, and all three TTL values.
- [x] Run `rtk npm test -- --test-name-pattern="remote config"`; expect the new assertions to fail.
- [x] Extend `loadConfig()` with the exact `RemoteConfig` fields from the design and reject a non-loopback remote host or an invalid remote port.
- [x] Add `RemoteError` and `remoteError(code, message, status)` in `src/remote/errors.js` with the stable codes listed in the design.
- [x] Add failure tests for invalid ports and verify local defaults (`HOST=127.0.0.1`, `PORT=3000`) remain unchanged.
- [x] Run focused config tests; expect PASS.
- [x] Commit checkpoint skipped with user approval because this workspace has no Git metadata.

## Task 2: Persist Remote settings and paired devices

**Files:**

- Create: `src/remote/store.js`
- Create: `test/remote-store.test.js`

**Depends on:** none

- [x] Write a failing fresh-database test for `remote_settings`, a stable UUID `installation_id`, default `desired_state="stopped"`, and an empty device list.
- [x] Run `rtk node --test test/remote-store.test.js`; expect module-not-found or assertion failure.
- [x] Implement `createRemoteStore(file)` and the `remote_settings`/`remote_devices` schema exactly as specified, creating the parent directory with user-only permissions.
- [x] Add failing persistence tests for `saveNamedTunnel()`, `setDesiredState()`, close/reopen, and `clearNamedTunnel()` preserving `installation_id`.
- [x] Implement the named-tunnel methods with one SQLite transaction per state change.
- [x] Add failing device tests for canonical JWK storage, duplicate fingerprint rejection, `touchDevice()`, retained revoked rows, and `getActiveDevice()` excluding revoked devices.
- [x] Implement `registerDevice()`, `listDevices()`, `getActiveDevice()`, `touchDevice()`, and `revokeDevice()` with JSON parsing only at the store boundary.
- [x] Add an idempotent migration test that opens a database containing only the existing project/chat tables and proves those rows are untouched.
- [x] Run `rtk node --test test/remote-store.test.js test/projects.test.js`; expect PASS.
- [x] Commit checkpoint skipped with user approval because this workspace has no Git metadata.

## Task 3: Implement device pairing, challenges, sessions, and rate limits

**Files:**

- Create: `src/remote/auth.js`
- Create: `test/remote-auth.test.js`

**Depends on:** Task 2

- [x] Write failing tests using injected `now()` and `randomBytes()` for one active pairing session, SHA-256-only secret storage, two-minute expiry, replacement, and one-time consumption.
- [x] Run `rtk node --test test/remote-auth.test.js`; expect FAIL.
- [x] Implement `createRemoteAuth({ store, now, randomBytes, subtle, secureCookies })` with `createPairing(publicUrl)` and `pair({ secret, deviceName, publicKeyJwk })`.
- [x] Add failing validation tests for non-P-256 JWKs, malformed coordinates, duplicate fingerprints, device names over 80 characters, and registration after expiry.
- [x] Implement canonical public-JWK serialization, fingerprinting, input bounds, and sanitized default device names.
- [x] Add failing ECDSA tests for `createChallenge(deviceId)` and `verifyChallenge({ deviceId, challengeId, signature, origin })`, including wrong origin, expired/reused challenge, and revoked device.
- [x] Implement the canonical `agent-remote:v1:<challengeId>:<challenge>:<origin>` verification path and `last_used_at` update.
- [x] Add failing session tests for the `__Host-agent_remote` cookie flags, 12-hour expiry, logout, all-device-session invalidation, and a revoke callback carrying the affected device ID.
- [x] Implement opaque memory sessions, cookie parse/serialize helpers, `authenticate(request)`, `logout(sessionId)`, `revokeDevice(deviceId)`, and `close()`.
- [x] Add failing tests for global 100/minute and per-client 20/minute authentication limits, then implement a fixed-window limiter with expired-bucket cleanup.
- [x] Run `rtk node --test test/remote-auth.test.js`; expect PASS.
- [x] Commit checkpoint skipped with user approval because this workspace has no Git metadata.

## Task 4: Store the Cloudflare user token in macOS Keychain

**Files:**

- Create: `src/remote/keychain.js`
- Create: `test/remote-keychain.test.js`

**Depends on:** none

- [x] Write failing tests around an injected `execFile` for missing item, read, add/update, delete, cancellation, and unexpected `/usr/bin/security` failures.
- [x] Run `rtk node --test test/remote-keychain.test.js`; expect FAIL.
- [x] Implement `createCloudflareTokenStore({ execFile })` using service `com.sirawat.agent-remote.cloudflare` and account `user-api-token`.
- [x] Add failing tests proving tokens are trimmed, capped at 4 KiB, excluded from thrown error messages, and never returned by `write()`.
- [x] Implement safe error reduction and explicit `REMOTE_UNSUPPORTED` behavior outside Darwin without adding a plaintext fallback.
- [x] Run `rtk node --test test/remote-keychain.test.js`; expect PASS.
- [x] Commit checkpoint skipped with user approval because this workspace has no Git metadata.

## Task 5: Add the scoped Cloudflare REST client

**Files:**

- Create: `src/remote/cloudflare.js`
- Create: `test/remote-cloudflare.test.js`

**Depends on:** none

- [x] Write failing fetch-double tests for Bearer authorization, `verifyToken()`, pagination-safe `listZones()`, and safe Cloudflare error reduction.
- [x] Run `rtk node --test test/remote-cloudflare.test.js`; expect FAIL.
- [x] Implement `createCloudflareClient({ fetch, token, apiBase })`, accepting the default official API base and an injected test base only.
- [x] Add failing payload tests for a `config_src="cloudflare"` tunnel, two-rule ingress configuration, tunnel-token retrieval, and proxied automatic-TTL CNAME creation.
- [x] Implement `createTunnel()`, `configureTunnel()`, `getTunnelToken()`, and `createDnsRoute()` with bounded response parsing.
- [x] Add failing tests for exact-name DNS lookup, tunnel lookup, DNS deletion, tunnel deletion, and non-success responses.
- [x] Implement `checkHostname()`, `getTunnel()`, `getDnsRecord()`, `deleteDnsRoute()`, and `deleteTunnel()`.
- [x] Assert captured requests and errors never contain the token outside the Authorization header or expose it in messages.
- [x] Run `rtk node --test test/remote-cloudflare.test.js`; expect PASS.
- [x] Commit checkpoint skipped with user approval because this workspace has no Git metadata.

## Task 6: Provision owned hostnames and named tunnels safely

**Files:**

- Create: `src/remote/provisioner.js`
- Create: `test/remote-provisioner.test.js`

**Depends on:** Tasks 2, 4, 5

- [x] Write failing table tests for the single-label regex, canonical hostname creation, root/dotted/underscore rejection, and labels over 63 bytes.
- [x] Run `rtk node --test test/remote-provisioner.test.js`; expect FAIL.
- [x] Implement `validateSubdomain(label)` and `createRemoteProvisioner({ store, tokenStore, createClient, remoteOrigin })`.
- [x] Add failing `checkAvailability(zoneId, label)` tests for available, exact owned reuse, foreign A/AAAA/CNAME conflicts, missing local ownership, and suggestions from `-2` through `-5`.
- [x] Implement availability checks that compare account, zone, hostname, DNS ID/target, and tunnel ID before returning `reusable`.
- [x] Add failing connect tests for `verify token -> resolve zone/account -> create/reuse tunnel -> configure ingress -> create/reuse DNS -> fetch tunnel token -> persist metadata` ordering.
- [x] Implement `prepareNamed({ zoneId, subdomain })` returning `{ hostname, tunnelToken, record }` and ensure a partial create keeps enough metadata for retry.
- [x] Add failing removal tests for exact owned deletion, externally changed DNS warning/no-delete, partial API failure preserving metadata, and successful cleanup clearing only named fields.
- [x] Implement `removeNamed()` and `listZones()`; never overwrite or delete a resource that fails ownership revalidation.
- [x] Run `rtk node --test test/remote-provisioner.test.js`; expect PASS.
- [x] Commit checkpoint skipped with user approval because this workspace has no Git metadata.

## Task 7: Manage cloudflared discovery and child lifecycle

**Files:**

- Create: `src/remote/tunnel.js`
- Create: `test/remote-tunnel.test.js`
- Create: `test/fixtures/cloudflared-remote`

**Depends on:** Task 1

- [x] Create an executable fake `cloudflared-remote` fixture supporting `--version`, Quick URL output, named registration output, signal recording, startup timeout, and controlled exit.
- [x] Write failing tests for override/PATH discovery, semantic version `>=2025.4.0`, missing, and outdated status.
- [x] Run `rtk node --test test/remote-tunnel.test.js`; expect FAIL.
- [x] Implement `inspectCloudflared({ command, execFile })` returning `{ available, version, source, error }` without breaking local startup.
- [x] Add failing state-machine tests for serialized/idempotent `startQuick()`, URL parsing within 15 seconds, timeout cleanup, `stop()` TERM-to-KILL escalation, and status listeners.
- [x] Implement `createTunnelManager(dependencies)` and the exact Quick command, with bounded redacted output buffers.
- [x] Add failing named tests proving `TUNNEL_TOKEN` is child-environment-only, public URL is the configured hostname, desired state changes, and unexpected exits retry after 1/2/4 seconds exactly three times.
- [x] Implement `startNamed()`, retry cancellation on Stop, no Quick auto-recreate, and `close()` child cleanup.
- [x] Run `rtk node --test test/remote-tunnel.test.js`; expect PASS and no fixture process left running.
- [x] Commit checkpoint skipped with user approval because this workspace has no Git metadata.

## Task 8: Split local-control and remote-gateway listeners

**Files:**

- Modify: `src/server.js`
- Create: `src/remote/gateway.js`
- Modify: `test/server.test.js`

**Depends on:** Tasks 1, 2, 3, 7

- [x] Add a failing integration setup that requests ephemeral local and remote ports and expects both URLs from `app.listen()` while preserving the existing `url` compatibility field.
- [x] Run `rtk node --test test/server.test.js --test-name-pattern="remote gateway"`; expect FAIL.
- [x] Refactor the existing HTTP callback into `handleWorkspaceRequest(request, response, surface)` and the upgrade callback into `handleWorkspaceUpgrade(request, socket, head, surface)` without changing local route behavior.
- [x] Create a second loopback HTTP server that shares the existing `wss`, `devtoolsWss`, renderer maps, project store, tmux state, and connection limit.
- [x] Add `GET /api/runtime` locally with `{ product:"agent-remote", version:1, surface:"local", desktopMode }`, and add tests for the response.
- [x] Implement `createRemoteGateway({ auth, getPublicUrl })` as a pre-route HTTP/upgrade gate; return `404` for `/api/remote/*` before calling the shared handlers.
- [x] Add failing tests for unauthenticated static/API/WS rejection, local administration absence on remote, invalid Host/Origin, and authenticated delegation to `/api/projects` and `/ws`.
- [x] Implement exact remote Host/Origin enforcement, attach `request.remoteDeviceId`, and track remote WebSockets by device ID.
- [x] Add a revoke integration test expecting active sockets to close with code `4003`, then wire the auth revoke callback to the shared client sets.
- [x] Extend `app.close()` tests to prove both listeners, WSS instances, remote auth, tunnel manager, remote store, and project store close without touching managed tmux sessions.
- [x] Run `rtk node --test test/server.test.js`; expect PASS.
- [x] Commit checkpoint skipped with user approval because this workspace has no Git metadata.

## Task 9: Expose local Remote administration APIs and QR creation

**Files:**

- Create: `src/remote/controller.js`
- Modify: `src/server.js`
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `test/remote-controller.test.js`
- Modify: `test/server.test.js`

**Depends on:** Tasks 3, 6, 7, 8

- [x] Add `qrcode` as a runtime dependency and write a failing controller test for the complete `GET /api/remote/status` shape when Remote is supported, missing, and errored.
- [x] Run `rtk node --test test/remote-controller.test.js`; expect FAIL.
- [x] Implement `createRemoteController({ auth, provisioner, tokenStore, tunnelManager, inspectCloudflared, toDataURL })` with status redaction.
- [x] Add failing tests for token validation-before-Keychain-write, zone listing, Keychain deletion, hostname availability, Quick start, named prepare/start, Stop, and owned Remove warnings.
- [x] Implement the controller methods, serialize Connect/Stop/Remove operations, and make repeated target-state calls idempotent.
- [x] Add failing pairing tests requiring a running public URL and expecting `pairUrl`, PNG data URL, and `expiresAt` without logging the fragment secret.
- [x] Implement pairing QR generation with error correction suitable for phone cameras and `Cache-Control: no-store` responses.
- [x] Register every specified `/api/remote/*` route only in the local handler with JSON/content-type/body-size checks and stable error codes.
- [x] Add integration tests proving the same routes are `404` on the remote listener even for an authenticated device.
- [x] Wire startup auto-reconnect only for stored named tunnels with `desired_state="running"`; test failed reconnect does not prevent local readiness.
- [x] Run `rtk node --test test/remote-controller.test.js test/server.test.js`; expect PASS.
- [x] Commit checkpoint skipped with user approval because this workspace has no Git metadata.

## Task 10: Serve remote pairing and authentication routes

**Files:**

- Modify: `src/remote/gateway.js`
- Modify: `src/server.js`
- Modify: `test/server.test.js`

**Depends on:** Tasks 3, 8

- [x] Add failing remote HTTP tests for `/remote-auth/status`, `/pair`, pair POST, challenge, verify, logout, expired/reused secrets, and rate-limit responses.
- [x] Run `rtk node --test test/server.test.js --test-name-pattern="remote auth"`; expect FAIL.
- [x] Implement bounded JSON route handlers that call `createRemoteAuth()` and set/clear the exact session cookie.
- [x] Add failing header tests for `no-store`, `no-referrer`, `nosniff`, same-origin CSP, and no pairing secret in response URLs after consumption.
- [x] Implement the security headers on every unauthenticated/auth response and ensure Cloudflare/token/signature data is excluded from logs.
- [x] Add a failing test that an authenticated remote device can use sessions, terminal WebSocket, renderer WebSocket, `/devtools/*`, and `/devtools-ws`, while an unauthenticated request cannot fetch normal application assets.
- [x] Wire authenticated requests through the existing handlers and ensure connection accounting remains global across local and remote clients.
- [x] Run `rtk node --test test/server.test.js`; expect PASS.
- [x] Commit checkpoint skipped with user approval because this workspace has no Git metadata.

## Task 11: Build the remote locked, pairing, and returning-device UI

**Files:**

- Create: `public/remote-entry.html`
- Create: `public/remote-entry.js`
- Create: `public/remote-entry.css`
- Modify: `src/remote/gateway.js`
- Create: `test/remote-entry.test.js`

**Depends on:** Task 10

- [x] Write a failing static-contract test for the locked message, pairing name field, Pair action, connecting state, and absence of local Remote administration controls.
- [x] Run `rtk node --test test/remote-entry.test.js`; expect FAIL.
- [x] Create the same-origin entry page and styles with no CDN resources, inline secrets, or Tauri IPC.
- [x] Add failing browser-API unit tests using fakes for ECDSA P-256 generation, non-extractable private keys, IndexedDB round-trip before POST, and public JWK export.
- [x] Implement `openCredentialStore()`, `createPersistedCredential()`, stored-device lookup, base64url helpers, and local sign verification.
- [x] Add failing tests for fragment extraction followed by `history.replaceState`, pair success redirect, expired QR, returning-device challenge signing, missing key, and logout.
- [x] Implement the pair and silent reauthentication flows; sign `agent-remote:v1:<challengeId>:<challenge>:<location.origin>` exactly.
- [x] Route unauthenticated `/` and `/pair` to the entry page while allowing only its three assets and `/remote-auth/*` before authentication.
- [x] Run `rtk node --test test/remote-entry.test.js test/server.test.js`; expect PASS.
- [x] Commit checkpoint skipped with user approval because this workspace has no Git metadata.

## Task 12: Add the local Remote button and modal

**Files:**

- Create: `public/api-client.js`
- Create: `public/remote-control.js`
- Modify: `public/app.js`
- Modify: `public/index.html`
- Modify: `public/tokens.css`
- Modify: `public/styles.css`
- Modify: `test/e2e.spec.js`

**Depends on:** Task 9

- [x] Refactor a failing existing E2E request path through a new `api-client.js`, then move `apiUrl()`/authenticated fetch behavior out of `app.js` without changing terminal behavior.
- [x] Run `rtk playwright test test/e2e.spec.js --grep="project"`; expect PASS after the refactor.
- [x] Add failing E2E assertions that local runtime shows a bottom-right `Remote` button and opens a four-section dialog, while a remote runtime fixture does not render the button.
- [x] Add the button/dialog markup and `remote-control.js` bootstrap gated by `GET /api/runtime` returning `surface="local"`.
- [x] Add semantic status/safe-area tokens to `tokens.css` and responsive dialog/FAB rules to `styles.css`, including full-screen layout at 520 px and reduced motion.
- [x] Add failing E2E tests for missing/outdated cloudflared instructions, Quick warning, Connect/Stop state, URL copy, QR countdown/refresh, and no secret text outside the local dialog.
- [x] Implement status polling only while the dialog is open or a transition is active; render stopped/starting/running/error states from server responses.
- [x] Add failing E2E tests for token instructions, token validation, zone selection, 350 ms hostname check, conflict suggestions, no overwrite action, named reuse, Stop, and confirmed Remove.
- [x] Implement the Custom Domain form and keep the token value write-only; clear its input after every submission.
- [x] Add failing E2E tests for device rows, timestamps, confirmation, revoke success, and retryable errors.
- [x] Implement device refresh and revoke, plus accessible focus return, labels, alerts, Escape/close behavior, and busy-state disabling.
- [x] Run `rtk playwright test test/e2e.spec.js`; expect PASS at desktop and 390x844 viewports.
- [x] Commit checkpoint skipped with user approval because this workspace has no Git metadata.

## Task 13: Add end-to-end Remote fixtures and security coverage

**Files:**

- Create: `test/fixtures/remote-playwright-server.js`
- Create: `test/remote-e2e.spec.js`
- Modify: `playwright.config.js`
- Modify: `test/cleanup-playwright-tmux.js`

**Depends on:** Tasks 9, 10, 11, 12

- [x] Create a test server wrapper that injects an in-memory token store, fake Cloudflare client, fake tunnel manager, deterministic clock controls, remote port 3101, direct HTTP public URL, and test-only non-Secure cookies.
- [x] Add a second Playwright project/context targeting the remote gateway without making fixtures parallel; extend cleanup for its SQLite and child state.
- [x] Write a failing Quick flow: local Connect -> create QR -> remote pair -> full application -> remote `/api/remote/status` returns 404.
- [x] Run `rtk playwright test test/remote-e2e.spec.js --grep="quick"`; expect FAIL, then complete only the fixture seams needed for PASS.
- [x] Write a failing returning-device test that clears the cookie but preserves IndexedDB, reloads, signs a challenge, and regains the full app without another QR.
- [x] Write a failing revoke test that removes the device locally, observes remote HTTP 401 and WebSocket close 4003, and cannot reuse the key.
- [x] Write failing security cases for expired/used QR, wrong Origin, wrong Host, forged signature, rate limits, and hidden local controls.
- [x] Write a named-domain fake flow covering token instructions, zone/subdomain selection, conflict suggestion, owned reuse, Stop preserving DNS, restart-on-launch, and Remove ownership warnings.
- [x] Run `rtk playwright test test/remote-e2e.spec.js`; expect PASS serially with no live Cloudflare traffic.
- [x] Commit checkpoint skipped with user approval because this workspace has no Git metadata.

## Task 14: Scaffold the Tauri v2 macOS wrapper

**Files:**

- Create: `desktop/index.html`
- Create: `src-tauri/Cargo.toml`
- Create: `src-tauri/build.rs`
- Create: `src-tauri/tauri.conf.json`
- Create: `src-tauri/capabilities/default.json`
- Create: `src-tauri/src/main.rs`
- Create: `src-tauri/icons/*`
- Modify: `src/server.js`
- Create: `test/tauri-contract.test.js`

**Depends on:** Task 8

- [x] Write a failing contract test for bundle identifier, Apple Silicon target, external sidecar declarations, no remote-domain IPC capability, and the three tray labels.
- [x] Run `rtk node --test test/tauri-contract.test.js`; expect FAIL.
- [x] Scaffold Tauri v2 with `tauri`, Rust-only opener, and single-instance dependencies; use the bundled loading page as `frontendDist` and grant no webview shell capability.
- [x] Implement startup probing of `/api/runtime`: attach to a compatible backend, spawn only when the port is free, and render a non-destructive port-conflict message otherwise.
- [x] Spawn `agent-remote-server` from Rust with `AGENT_REMOTE_DESKTOP=1` and the resolved bundled `CLOUDFLARED_BIN`; parse only the readiness JSON line and retain the child handle as owned state.
- [x] Modify direct Node startup to emit the readiness JSON line after both listeners succeed, while retaining the human-readable console URL.
- [x] Implement window navigation to the local URL, close-to-hide, single-instance focus, tray Show/Open/Quit, and graceful shutdown only for an owned child.
- [x] Add Rust unit tests for compatible probe, foreign-port response, readiness parsing, owned/unowned quit, and bundled/development cloudflared path resolution.
- [x] Run `rtk cargo test --manifest-path src-tauri/Cargo.toml` and `rtk node --test test/tauri-contract.test.js`; expect PASS.
- [x] Commit checkpoint skipped with user approval because this workspace has no Git metadata.

## Task 15: Package and smoke-test the Node and cloudflared sidecars

**Files:**

- Create: `scripts/prepare-tauri-sidecars.js`
- Create: `scripts/smoke-sidecar.js`
- Create: `src-tauri/sidecars.lock.json`
- Create: `THIRD_PARTY_NOTICES.md`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `.gitignore`

**Depends on:** Tasks 7, 14

- [x] Add `@tauri-apps/cli` and `@yao-pkg/pkg` dev dependencies and failing script-contract tests for `desktop:prepare`, `sidecar:build`, `sidecar:smoke`, `desktop:dev`, and `desktop:build`.
- [x] Add `sidecars.lock.json` with Cloudflare version `2026.8.2`, the official Darwin ARM64 release URL, filename, license, and published SHA-256; reject any download that does not match.
- [x] Implement `prepare-tauri-sidecars.js` to copy a matching local binary or download the pinned asset explicitly, verify version/checksum, set executable mode, and place the target-triple filename expected by Tauri.
- [x] Configure `@yao-pkg/pkg` for Node 22 macOS ARM64, ESM entry, `node-pty` native assets, xterm vendor assets, and `public/**` static files. The single-file output was rejected after a real PTY smoke exposed its virtual-filesystem `spawn-helper` limitation; the shipped fallback is a native launcher plus the exact bundled Node 22 runtime and resources.
- [x] Build `agent-remote-server-aarch64-apple-darwin` and add both server/cloudflared external binaries to `tauri.conf.json` without committing generated binaries.
- [x] Implement `smoke-sidecar.js`: start on ephemeral ports/database, wait for both health surfaces, open a real PTY WebSocket, verify output, send SIGTERM, and assert no sidecar/cloudflared child remains.
- [x] Add the Cloudflare Apache-2.0 attribution and packaged version to `THIRD_PARTY_NOTICES.md`.
- [x] Run `rtk npm run desktop:prepare`, `rtk npm run sidecar:build`, and `rtk npm run sidecar:smoke`; expect PASS.
- [x] Run `rtk npm run desktop:build`; expect an Apple Silicon `.app` that opens the shared local UI.
- [x] Commit checkpoint skipped with user approval because this workspace has no Git metadata.

## Task 16: Document, audit, and run the complete verification matrix

**Files:**

- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `docs/agents/architecture/index.md`
- Modify: `docs/agents/architecture/runtime.md`
- Create: `docs/agents/architecture/remote-access.md`
- Modify: `docs/agents/workflows/development.md`
- Modify: `docs/agents/workflows/testing.md`

**Depends on:** Tasks 1-15

- [x] Document the two equivalent launch modes, `npm start` cloudflared prerequisite, Tauri lifecycle, default ports, environment variables, Quick re-pair limitation, scoped-token permissions, Keychain behavior, Stop versus Remove, and recovery after device loss.
- [x] Add the local/remote security boundary, authoritative stores, device session lifecycle, DNS ownership rule, and shutdown order to the agent architecture docs and jump tables.
- [x] Document focused Remote tests, fake Cloudflare fixtures, sidecar smoke test, desktop build, and the Apple Silicon-only boundary.
- [x] Run `rtk npm test`; fix failures without weakening assertions.
- [x] Run `rtk npm run test:e2e`; fix desktop/mobile/remote failures and confirm serial cleanup.
- [x] Run `rtk npm run sidecar:smoke`; confirm real PTY output and no orphan processes.
- [x] Run `rtk cargo test --manifest-path src-tauri/Cargo.toml`; confirm Tauri lifecycle tests.
- [x] Run `rtk npm run desktop:build`; launch the `.app` and verify the real foreign-port UI leaves the user's already-running server untouched. Compatible-attach and owned-sidecar cleanup are covered by Rust lifecycle tests plus packaged real-PTY smoke because port 3000 was occupied by a pre-existing, incompatible `npm start` process that was not safe to restart automatically.
- [x] Perform the safe portion of a manual real-Cloudflare check: a fresh `npm start` connected a real Quick Tunnel, paired a P-256 device through the public HTTPS origin, served the authenticated workspace, revoked the device to a remote 401, stopped the tunnel, and left no child. Named create/reconnect/conflict/Remove were intentionally not run because no disposable zone/subdomain and scoped token were supplied; the complete named matrix passes against the no-network fake Cloudflare fixture.
- [x] Run `rtk npm run test:all` once more as the final gate.
- [x] Commit checkpoint skipped with user approval because this workspace has no Git metadata.

## Self-validation checklist

- [x] Every design decision maps to a task: dual launch modes, two listeners, local-only admin, full remote capability, Keychain token, Quick/named lifecycle, DNS reuse/collision/removal, QR pairing, challenge sessions, revocation, responsive UI, Tauri tray/lifecycle, packaging, and docs.
- [x] Function and route names match the design document exactly.
- [x] Tasks 1, 2, 4, 5, and 7 are parallel-safe; later dependency lines prevent shared-file conflicts where possible.
- [x] No live Cloudflare account is required by automated tests.
- [x] No task implements Windows/Linux/Intel, apex domains, Cloudflare Access/WARP, notarization, auto-update, or launch-at-login.
- [x] Final verification includes `npm run test:all`, sidecar smoke, Rust tests, and the Tauri build.
