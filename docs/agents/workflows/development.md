# Development workflow

## Setup and run

The browser workflow requires Node 22.5 or newer, tmux for persistent sessions, native `node-pty` support, and `cloudflared` only when using Remote access.

```bash
npm install
npm link
npm start
```

Open `http://127.0.0.1:3000`. `npm run dev` restarts the Node server on source changes. Both start modes repair the machine terminal-browser shim before launching.

For a normal macOS app installation, use `./init.sh`. The default path downloads
the versioned DMG under `releases/`, verifies its checksum, mounts it read-only,
and installs the validated app without requiring Node, npm, Rust, Xcode, a Git
checkout, or an on-device build. It supports an interactive choice of
`/Applications`, `~/Applications`, or a custom destination, as well as
non-interactive `--install-dir`, positional destination, and
`AGENT_REMOTE_INSTALL_DIR` forms. `--dmg` installs a local release and
`--dmg-url` plus `--dmg-sha256` supports an alternate verified release.

Source building is developer-only and must be explicit through
`--build-from-source` or `--source-dir`. A source directory either uses an Agent
Remote checkout or clones the configured repository into that folder.
`--app-bundle` remains a direct developer/test seam. Replacement requires an
interactive confirmation or `--yes`, and `--no-launch` suppresses opening the
installed app. Keep the pinned release checksum, bundle-ID, and all four bundled
executable checks when changing the installer.

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

The desktop bundle and PWA intentionally use the same icon artwork.
`public/icon-512.png` is the source asset and must remain byte-for-byte identical
to `src-tauri/icons/icon.png`; it is an RGBA PNG because Tauri rejects RGB-only
bundle icons. The Tauri contract test prevents the two copies from drifting.

The Tauri wrapper first probes the local runtime. Compatibility requires the
Agent Remote identity plus a live Remote listener. It attaches without taking
ownership when that complete contract is present, starts an owned sidecar only
when the port is free, and leaves a foreign listener untouched. Window close
hides the app while its backend supervisor stays active; resume/reopen probes
and reconciles the frontend. Tray Quit terminates only the wrapper-owned child,
and the bundled Node process independently exits if its Tauri parent vanishes.
The macOS window uses a hidden overlay titlebar: native traffic-light controls
sit at a fixed inset on the same center line as the 34px Tauri header controls,
while the web sidebar and chat headers form the visible top edge and provide the
drag regions. Tauri's
deep drag-region contract makes every non-interactive part of either full header
draggable and makes a double-click maximize or restore the window without
treating the header buttons as drag targets. The wrapper marks each loaded
document as a Tauri surface so the native sidebar header reserves traffic-light
space while expanded. When the sidebar is collapsed, the chat header reserves
that same inset; after the window crosses into the compact conversation layout,
the mobile conversation header reserves it as well so every hamburger stays
clear of the native controls. The normal browser and PWA layouts remain flush
left in every state. Keep the
native window minimum width below the web UI's 760px compact breakpoint so the
Tauri app can intentionally resize into the mobile conversation surface. Its
mobile conversation header is also a deep drag region, preserving native drag
and double-click maximize/restore behavior after the desktop headers disappear.
The drag-region attribute is inert in phone browsers and the PWA because those
surfaces do not run inside Tauri.
Because the runtime document is served from `http://127.0.0.1:3000`, its
dedicated remote capability must remain limited to native window dragging and
the internal maximize toggle. Do not broaden that capability to `core:default`,
shell, opener, filesystem, or a non-loopback URL.

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
