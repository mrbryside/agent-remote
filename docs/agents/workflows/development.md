# Development workflow

## Setup and run

The browser workflow requires Node 22.5 or newer, tmux for persistent sessions, native `node-pty` support, and `cloudflared` only when using Remote access.

```bash
npm install
npm link
npm start
```

Open `http://127.0.0.1:3000`. `npm run dev` restarts the Node server on source changes. Both start modes repair the machine terminal-browser shim before launching.

`npm start` and the Tauri app use the same Node backend: both start local control on `127.0.0.1:3000` and the Remote gateway on `127.0.0.1:3001` by default. Browser mode discovers `cloudflared` through `CLOUDFLARED_BIN` or `PATH`; a missing or old binary affects only Remote controls, not local terminal startup. Remote accepts Cloudflare version 2025.4.0 or newer.

## Desktop sidecar workflow

Desktop packaging is deliberately Darwin ARM64 only. Build and validate it on Apple Silicon:

```bash
npm run desktop:prepare
npm run sidecar:build
npm run sidecar:smoke
npm run desktop:build
```

`desktop:prepare` obtains the pinned `cloudflared` 2026.8.2 asset, checks its SHA-256 from `src-tauri/sidecars.lock.json`, and installs the executable expected by Tauri. `sidecar:build` creates a native ARM64 launcher and packages the exact Node 22 runtime, application files, and native PTY assets. Do not replace this layout with a single-file `pkg` bundle: a real smoke test found that pkg's virtual filesystem cannot run `node-pty`'s `spawn-helper`.

The Tauri wrapper first probes the local runtime. It attaches if it finds compatible agent-remote, starts an owned sidecar only when the port is free, and leaves a foreign listener untouched. Window close hides the app; tray Quit terminates only the wrapper-owned child.

## Remote-development guardrails

- Keep the two listeners loopback-only. The remote endpoint is externally reachable solely through the owned cloudflared process.
- Keep Remote administration routes on local control only. Do not expose a new `/api/remote/*` route through the remote gateway.
- HTTPS is mandatory for public Remote origins. `remoteAllowInsecurePublicOrigin` and non-Secure cookies are programmatic test seams only; do not turn them into an environment variable or product preference.
- A named-tunnel restart is controlled solely by persisted `desired_state="running"`; do not restart Quick Tunnels automatically.
- When changing credential or ownership behavior, preserve the Keychain-only Cloudflare token, child-environment-only tunnel token, and exact DNS/tunnel ownership revalidation.

## Safe implementation order

1. Identify the authoritative owner of the state being changed: SQLite, tmux, renderer, or browser UI cache.
2. Add a focused test reproducing the behavior.
3. Change the narrowest owner first, then adapt API/UI consumers.
4. Preserve optimistic UI ordering and guard late asynchronous responses with generation/request identity.
5. Verify resize, refresh, rapid repeated actions, and switching away while an operation is pending.
6. Run the complete suite before handoff.

The default server is loopback-only. If local exposure changes, require a token and HTTPS as documented in the root `README.md`; the Remote gateway itself remains loopback-only.

[Back to workflow index](index.md)
