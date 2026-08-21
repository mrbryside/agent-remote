# Remote access architecture

Read this before changing Remote routes, listeners, Cloudflare calls, device authentication, tunnel lifecycle, or Tauri ownership.

## Boundary and launch model

The Node backend is authoritative in both supported launch modes:

```text
npm start                         Tauri on macOS Apple Silicon
node src/server.js                app probes local runtime
  local control 127.0.0.1:3000      compatible backend -> attach, unowned
  remote gateway 127.0.0.1:3001     free port -> own native launcher + Node 22 sidecar
  owned cloudflared child           same two listeners and child lifecycle
```

`src/server.js` owns both listeners, so they share the project store, tmux sessions, renderer registry, connection limit, and shutdown path. The Remote listener accepts only `127.0.0.1`; `cloudflared` is the only supported external path to it.

Tauri has no privileged Remote IPC. It probes local `/api/runtime`, attaches to a compatible server without taking ownership, and displays an error rather than disturbing a foreign service on port 3000. Its native ARM64 server launcher starts the bundled Node 22 runtime and resources. The earlier single-file `pkg` option is intentionally not used: its virtual filesystem failed a real `node-pty` `spawn-helper` smoke test. The desktop preparation step verifies the pinned `cloudflared` 2026.8.2 release-asset checksum before packaging it.

## Local vs. remote security boundary

| Surface | Access | Capabilities |
| --- | --- | --- |
| Local control (`127.0.0.1:3000`) | Same-origin local browser | Workspace plus `/api/remote/*` configuration, tunnel controls, pairing QR creation, device list, and revocation |
| Remote gateway (`127.0.0.1:3001`) | Exact public Host/Origin and paired-device session | Workspace, terminal and renderer WebSockets, sessions, and DevTools |

The remote gateway rejects unauthenticated application traffic, allows only the remote entry/auth assets before authentication, and returns `404` for every `/api/remote/*` route even after a device authenticates. Cloudflare headers are never an identity source. State-changing remote-auth requests require the exact public Origin; all remote requests require its exact Host. The authenticated workspace document uses a self-script CSP, denies framing, suppresses referrers, and is never cached. The local workspace listener may bind outside loopback only when `TERMINAL_TOKEN` is non-empty.

The authenticated Remote workspace document is rendered without Local Remote-control markup: the sidebar control, setup dialog, and Cloudflare token guide are removed server-side, and `/remote-control.js` is unavailable on the Remote listener. The browser bootstrap also removes those nodes if a non-local runtime ever receives the local shell as defense in depth. This UI isolation supplements rather than replaces the authoritative gateway rule that returns `404` for `/api/remote/*`.

Public origins are HTTPS-only. The `allowInsecurePublicOrigin` option plus non-Secure cookies exists solely for injected tests; there is no environment variable or end-user setting that enables it. Opening a valid pairing QR immediately reuses a working non-extractable browser key or creates one, pairs without a device-name form, and sends a best-effort label such as `iPhone · Safari` derived from browser hints. The backend derives the same fallback from the request User-Agent when an older client omits the label. Browsers do not expose the user's assigned hardware name. Pairing the same browser profile again upserts the existing fingerprint row, preserves its device ID and original creation time, and updates its label and last-used time; clearing site data or using another browser profile creates a distinct device.

## State and credential ownership

| State | Owner and lifecycle |
| --- | --- |
| Projects and chats | Existing SQLite project store |
| Named tunnel metadata and paired-device rows | `remote_settings` / `remote_devices` in the same SQLite file via `src/remote/store.js` |
| Cloudflare user API token | macOS Keychain (`com.sirawat.agent-remote.cloudflare` / `user-api-token`) only |
| Tunnel API token | `TUNNEL_TOKEN` in the cloudflared child environment only |
| Quick URL, pairing secret, challenges, sessions | Process memory only |
| Remote private device key | Non-extractable P-256 key in the remote browser profile's IndexedDB |

The store creates one durable installation UUID. A named tunnel is considered owned only when stored account, zone, hostname, DNS record, tunnel ID/name, and CNAME target exactly match the current Cloudflare resources. Never infer ownership from a familiar name or delete a resource when local metadata is incomplete.

Remote browser sessions are opaque in-memory sessions with a 12-hour lifetime and a Secure, HttpOnly, SameSite=Strict `__Host-agent_remote` cookie. QR pairing stores only a hash of its random secret, expires in two minutes, and is consumed once. Pair any number of devices by creating a fresh one-time QR for each browser profile; completing one pairing never closes enrollment for later devices. Returning browsers sign a one-minute server challenge with their retained P-256 key. Session expiry and logout close that session's active Remote WebSockets and SSE streams. Revoking a device deletes its paired-device row, invalidates its sessions, closes its active Remote WebSockets with code 4003 and ends its SSE streams. Revoke, Clear all, and Stop Remote also cancel any pending QR pairing secret. Clear all deletes every paired-device row in one store transaction, then invalidates connections for every removed ID. Store initialization also removes retained revoked rows left by older versions.

## Cloudflare and tunnel lifecycle

Remote uses a scoped Cloudflare **user API token**: Account / Cloudflare Tunnel / Edit, Zone / DNS / Edit, and Zone / Zone / Read, constrained to the intended account and zone(s). Validate a candidate before it reaches Keychain. Do not log or return either Cloudflare token. Once configured, the local UI renders only a fixed mask and locks the field until the user explicitly removes the Keychain token.

Only one lower-case ASCII subdomain label and one stored named tunnel are supported. An existing record is reusable only after exact ownership verification; every other record is a conflict and must remain untouched. When the user changes an owned Custom Domain, validate the new hostname before changing state, then stop the old process, remove only the exact owned DNS/tunnel resources, and create the replacement automatically. A conflicting target or unverifiable old ownership must leave the existing resources intact. Named setup writes remotely managed tunnel ingress to the remote listener, creates a proxied automatic-TTL CNAME, then starts `cloudflared tunnel --no-autoupdate run` with the tunnel token in its environment.

Quick mode runs `cloudflared tunnel --no-autoupdate --url http://127.0.0.1:3001`, extracts its random `trycloudflare.com` URL within 15 seconds, and never auto-recreates after exit. A new Quick URL is a new browser origin, so each browser profile must pair again. Named mode persists `desired_state`; only `running` named configurations are restored at Node startup. Unexpected named exits retry after 1, 2, and 4 seconds, and Stop cancels those retries.

**Stop** sends TERM (then KILL after five seconds if needed), sets a named tunnel to stopped, and preserves Cloudflare resources. Process shutdown terminates the same child without changing `desired_state`, so a named tunnel that was On reconnects when the server starts again while an explicitly stopped tunnel stays Off. While Remote is running, changing the connection type, zone, or subdomain turns the header action into **Update & Restart**; the replacement endpoint validates first and performs the restart. These fields are dialog-local drafts and closing the dialog without updating restores the persisted active configuration. The local setup UI does not expose a destructive Custom Domain removal action.

The retained `DELETE /api/remote/tunnels/named` backend operation stops first, revalidates DNS and tunnel ownership, deletes the owned DNS record and tunnel, then clears metadata only after success. Changed DNS or an incomplete/failed Cloudflare operation must preserve metadata and emit a warning so trusted callers can retry safely.

## Shutdown sequence

On application close: close renderer/client sockets, close Remote gateway tracking and WebSocket servers, close both HTTP listeners, stop the tunnel manager and cloudflared child, then close Remote auth/store and the project store. Managed tmux sessions are deliberately left running. Tauri Quit applies this only to its owned sidecar; a backend it merely attached to is untouched.

[Back to architecture index](index.md)
