# Tauri and Cloudflare remote access

Date: 2026-08-18

## Goal

Make agent-remote usable in two equivalent macOS-first forms:

1. A Tauri v2 desktop app that starts and owns the existing Node backend.
2. The existing browser workflow started with `npm start`.

Both forms must expose the same local-only Remote controls, create either a temporary Cloudflare Quick Tunnel or a persistent named tunnel on a user-owned subdomain, and allow fully privileged remote access only from browser profiles that were paired with a device key.

## Scope

### In scope

- A Tauri v2 Apple Silicon `.app` wrapper around the existing web UI and Node backend.
- `npm start` feature parity for every Remote operation.
- A fixed local-control listener on `127.0.0.1:3000` and a separate remote-gateway listener on `127.0.0.1:3001` by default.
- A bottom-right local-only Remote button and modal.
- Cloudflare Quick Tunnels with random `*.trycloudflare.com` URLs.
- Cloudflare remotely-managed named tunnels attached to one subdomain of a zone already hosted on Cloudflare DNS.
- User API tokens scoped to the chosen account and zone and stored in macOS Keychain.
- QR-based, one-time device pairing using a non-extractable Web Crypto key.
- Full terminal, project, session, renderer, and DevTools access for authenticated remote devices.
- Local-only device listing and revocation.
- Safe DNS collision detection, owned-resource reuse, stopping, and removal.
- Automatic named-tunnel restart when it was previously left enabled.

### Out of scope

- Windows, Linux, Intel macOS, iOS, or Android application packages.
- Cloudflare zones whose authoritative DNS is not hosted by Cloudflare.
- Apex/root-domain routing; only subdomains are accepted.
- Cloudflare Access, WARP, email OTP, mTLS, WebAuthn/passkeys, or hardware attestation.
- Sharing a pairing QR remotely or creating pairing sessions through the tunnel.
- More than one stored named tunnel or named hostname per agent-remote installation.
- Apple notarization, App Store distribution, auto-update, and launch-at-login.
- Keeping Quick Tunnel URLs stable across backend restarts.
- Migrating a non-extractable device key between browser origins or browser profiles.

## Chosen approach

Use **Tauri Wrapper + Node Sidecar**.

The Node backend remains the authoritative implementation for HTTP, WebSocket, tmux, PTY, SQLite, Cloudflare, tunnel lifecycle, pairing, and authentication. Tauri is a thin macOS shell that starts the packaged backend, waits for readiness, opens the same loopback web UI, provides a tray, and terminates only the child process it owns.

This approach won because it preserves the existing runtime boundaries and gives `npm start` and Tauri identical behavior. A Rust control plane would duplicate Remote behavior across two backends, while a full Rust rewrite would put the mature PTY/tmux/renderer paths at unnecessary risk.

Tauri v2 supports packaging an API server as an external sidecar. The packaged app will contain an Apple Silicon Node sidecar and a pinned `cloudflared` binary. Browser mode will use `CLOUDFLARED_BIN` or `cloudflared` from `PATH`.

## Architecture and ownership

### Process model

```text
Tauri mode
Tauri.app
  -> agent-remote-server sidecar
       -> local-control HTTP/WS 127.0.0.1:3000
       -> remote-gateway HTTP/WS 127.0.0.1:3001
       -> cloudflared child while Remote is running

Browser mode
npm start
  -> node src/server.js
       -> the same two listeners
       -> cloudflared from CLOUDFLARED_BIN or PATH
```

- The Node process owns both listeners so both surfaces share the same project store, tmux sessions, renderer registry, connection limit, and shutdown path.
- The remote listener is always loopback-only. It becomes reachable from outside only while the owned `cloudflared` child is running.
- Cloudflare identity headers are not an authentication source. Remote access is authorized only by an agent-remote device session.
- The local listener is the only listener that registers `/api/remote/*` administration routes.
- The remote listener returns `404` for every `/api/remote/*` route, even after device authentication.
- The Tauri webview loads `http://127.0.0.1:3000`; it does not receive privileged Tauri IPC capabilities.

### Tauri lifecycle

- Bundle identifier: `com.sirawat.agent-remote`.
- The initial Tauri window displays a bundled loading page.
- On startup, Tauri probes `http://127.0.0.1:3000/api/runtime`.
  - If a compatible agent-remote backend is already present, Tauri attaches without claiming process ownership.
  - If the port is free, Tauri spawns `agent-remote-server` with `AGENT_REMOTE_DESKTOP=1` and an absolute `CLOUDFLARED_BIN` for the bundled executable.
  - If another service owns the port, Tauri displays a port-conflict error and does not kill it.
- The sidecar prints one machine-readable readiness line: `{"type":"ready","localUrl":"http://127.0.0.1:3000"}`.
- Closing the main window hides it; the process and any tunnel keep running.
- The tray has `Show Agent Remote`, `Open in Browser`, and `Quit`.
- `Quit` gracefully stops a backend owned by Tauri and never stops a pre-existing `npm start` backend.
- A second Tauri launch focuses the existing app through the single-instance plugin.

### Browser-mode lifecycle

- `npm start` continues to run `node src/server.js`.
- A missing or unsupported `cloudflared` does not prevent local terminal use. The Remote modal reports the problem and shows `brew install cloudflared` or `brew upgrade cloudflared`.
- Browser mode accepts Cloudflare version `2025.4.0` or newer. The Tauri package pins `cloudflared` `2026.8.2`.
- `CLOUDFLARED_BIN` overrides PATH discovery for development and packaging.

## Configuration

`loadConfig()` adds the following fields without changing existing local defaults:

```ts
type RemoteConfig = {
  remoteHost: "127.0.0.1";
  remotePort: number;              // REMOTE_PORT, default PORT + 1
  cloudflaredBin: string;          // CLOUDFLARED_BIN, default "cloudflared"
  desktopMode: boolean;            // AGENT_REMOTE_DESKTOP === "1"
  pairingTtlMs: 120_000;
  challengeTtlMs: 60_000;
  remoteSessionTtlMs: 43_200_000;  // 12 hours
};
```

- If `PORT=0`, `REMOTE_PORT` also defaults to `0` for isolated tests.
- Production Remote support is enabled only when `process.platform === "darwin"`.
- Both listeners reject non-loopback bind addresses for the remote gateway.

## Persistent data

Remote metadata uses the existing `AGENT_REMOTE_DB_PATH` file through a separate `createRemoteStore(file)` connection in `src/remote/store.js`. It creates idempotent tables without modifying project/chat ownership.

```sql
CREATE TABLE remote_settings (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  installation_id TEXT NOT NULL UNIQUE,
  account_id TEXT,
  zone_id TEXT,
  zone_name TEXT,
  hostname TEXT,
  tunnel_id TEXT,
  tunnel_name TEXT,
  dns_record_id TEXT,
  dns_target TEXT,
  desired_state TEXT NOT NULL DEFAULT 'stopped'
    CHECK (desired_state IN ('stopped', 'running')),
  updated_at INTEGER NOT NULL
);

CREATE TABLE remote_devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  public_key_jwk TEXT NOT NULL,
  fingerprint TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
```

- `installation_id` is a random UUID created once.
- Named tunnel ownership requires all stored Cloudflare IDs and an exact live-resource match.
- Quick Tunnel state, pairing secrets, authentication challenges, and browser sessions are memory-only.
- Cloudflare API and tunnel tokens are never stored in SQLite.
- Revoked device rows remain as an audit record and cannot authenticate again.

The store contract is:

```ts
createRemoteStore(file): {
  getSettings(): RemoteSettings;
  saveNamedTunnel(input: NamedTunnelRecord): RemoteSettings;
  setDesiredState(state: "stopped" | "running"): void;
  clearNamedTunnel(): void;
  listDevices(): RemoteDevice[];
  getActiveDevice(id: string): RemoteDevice | undefined;
  registerDevice(input: NewRemoteDevice): RemoteDevice;
  touchDevice(id: string, usedAt: number): boolean;
  revokeDevice(id: string, revokedAt: number): boolean;
  close(): void;
}
```

## Cloudflare credentials

### Token instructions

The modal links to Cloudflare **My Profile -> API Tokens -> Create Custom Token** and requires a user API token with:

- Account / Cloudflare Tunnel / Edit, limited to the selected account.
- Zone / DNS / Edit, limited to the selected zone or zones.
- Zone / Zone / Read, limited to the same zone or zones.

Version one supports user API tokens, not account API tokens or global API keys.

### Keychain contract

`src/remote/keychain.js` uses `/usr/bin/security` with:

- Service: `com.sirawat.agent-remote.cloudflare`
- Account: `user-api-token`

```ts
createCloudflareTokenStore({ execFile }): {
  has(): Promise<boolean>;
  read(): Promise<string | undefined>;
  write(token: string): Promise<void>;
  remove(): Promise<boolean>;
}
```

The token is trimmed, capped at 4 KiB, never returned by an HTTP response, never logged, and passed only to `api.cloudflare.com`. Keychain deletion is allowed while stopped but leaves named metadata intact so the user can paste a valid token later to remove or restart it.

## Cloudflare API and DNS behavior

`createCloudflareClient({ fetch, token })` exposes:

```ts
verifyToken(): Promise<void>;
listZones(): Promise<CloudflareZone[]>;
checkHostname(zoneId: string, hostname: string): Promise<HostnameCheck>;
createTunnel(accountId: string, name: string): Promise<CloudflareTunnel>;
configureTunnel(accountId: string, tunnelId: string, hostname: string, service: string): Promise<void>;
getTunnelToken(accountId: string, tunnelId: string): Promise<string>;
createDnsRoute(zoneId: string, hostname: string, tunnelId: string): Promise<CloudflareDnsRecord>;
deleteDnsRoute(zoneId: string, recordId: string): Promise<void>;
deleteTunnel(accountId: string, tunnelId: string): Promise<void>;
```

- API base: `https://api.cloudflare.com/client/v4`.
- Named tunnels use `config_src: "cloudflare"`.
- Remote configuration has two ingress rules:
  - `{ hostname, service: "http://127.0.0.1:3001" }`
  - `{ service: "http_status:404" }`
- DNS is a proxied, automatic-TTL CNAME from the hostname to `<tunnel-id>.cfargotunnel.com`.
- The API tunnel token is passed to `cloudflared` through the child environment variable `TUNNEL_TOKEN`, not command-line arguments or logs.

### Hostname validation

- The user chooses a returned zone and enters one lowercase ASCII subdomain label.
- Accepted label: `^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`.
- Empty values, `@`, dots, underscores, leading/trailing hyphens, root domains, and labels over 63 bytes are rejected.
- The canonical hostname is `<label>.<zone-name>`.
- If no DNS record exists, the hostname is available.
- If the exact stored `dns_record_id`, `tunnel_id`, hostname, CNAME target, account, and zone still match Cloudflare, it is reusable.
- Any other existing A, AAAA, CNAME, or other DNS record is a conflict. agent-remote never overwrites it and suggests the first available values among `<label>-2` through `<label>-5`.
- A resource that merely has an agent-remote-like name is not considered owned when local metadata is missing.

### Named tunnel lifecycle

- Tunnel name: `agent-remote-<first 12 characters of installation_id>`.
- Only one named tunnel configuration may be stored.
- Connect creates or verifies the tunnel, writes remote ingress configuration, creates or verifies DNS, fetches the tunnel token, then starts `cloudflared tunnel --no-autoupdate run` with `TUNNEL_TOKEN` in its environment.
- Stop sends `SIGTERM`, waits five seconds, then uses `SIGKILL` only if needed. It sets `desired_state="stopped"` and preserves Cloudflare resources.
- Starting a Quick Tunnel first stops a running named tunnel and sets its desired state to stopped, but preserves named metadata.
- A stored named tunnel with `desired_state="running"` reconnects automatically when either Tauri or `npm start` launches.
- Unexpected named-tunnel exits are retried three times after 1, 2, and 4 seconds. Quick Tunnels are not automatically recreated because doing so changes their URL.
- Remove stops the process, verifies ownership again, deletes the DNS record, deletes the tunnel, and only then clears local metadata.
- If DNS was changed externally, Remove leaves it untouched and reports a warning. Partial Cloudflare failures preserve metadata so removal can be retried.

### Quick Tunnel lifecycle

- Command: `cloudflared tunnel --no-autoupdate --url http://127.0.0.1:3001`.
- The manager parses the generated `https://<random>.trycloudflare.com` URL from output and requires it within 15 seconds.
- Stop terminates the process. A later start gets a new URL.
- Quick Tunnel is explicitly labeled temporary and intended for short-lived access.
- Because IndexedDB keys are origin-scoped, a changed Quick Tunnel URL requires pairing that browser profile again. The modal explains this before connection.

The manager contract is:

```ts
type TunnelState = "stopped" | "starting" | "running" | "stopping" | "error";
type TunnelMode = "none" | "quick" | "named";
type TunnelStatus = {
  mode: TunnelMode;
  state: TunnelState;
  publicUrl?: string;
  hostname?: string;
  error?: { code: string; message: string };
};

createTunnelManager(dependencies): {
  status(): TunnelStatus;
  startQuick(): Promise<TunnelStatus>;
  startNamed(config: NamedRunConfig): Promise<TunnelStatus>;
  stop(): Promise<TunnelStatus>;
  close(): Promise<void>;
  onStatus(listener: (status: TunnelStatus) => void): () => void;
}
```

## Device pairing and authentication

### Device key

- The remote browser generates ECDSA P-256 keys with Web Crypto.
- The private key is non-extractable and saved in IndexedDB database `agent-remote`, object store `credentials`.
- The exported public JWK is sent to the backend.
- Before registration, the browser reads the stored key back and completes a local sign operation; registration is not attempted if persistent key storage fails.
- Device names default to a sanitized browser/platform label and can be edited on the pairing screen.
- The backend fingerprint is SHA-256 over a canonical public JWK representation.

### Pairing session

- `POST /api/remote/pairing-sessions` exists only on local-control and requires a running tunnel.
- It creates 32 random bytes, stores only their SHA-256 hash in memory, expires after two minutes, and replaces any prior unconsumed pairing session.
- It returns a URL shaped as `https://public-host/pair#<base64url-secret>` plus a locally generated QR data URL.
- The fragment prevents the secret from reaching HTTP logs, Cloudflare request logs, and referrer headers.
- The remote pairing page reads and immediately removes the fragment from the address bar.
- `POST /remote-auth/pair` consumes the secret exactly once, registers the device, and issues an authenticated session cookie in the same response.
- Anyone physically able to view and scan the local QR before expiry is intentionally allowed to pair.

### Returning-device challenge

```ts
POST /remote-auth/challenge
body: { deviceId: string }
response: { challengeId: string, challenge: string, expiresAt: number }

POST /remote-auth/verify
body: { deviceId: string, challengeId: string, signature: string }
response: { authenticated: true, expiresAt: number }
```

- Challenges contain 32 random bytes, expire after 60 seconds, are single-use, and are stored only in memory.
- The browser signs the UTF-8 string `agent-remote:v1:<challengeId>:<challenge>:<location.origin>` using ECDSA/SHA-256.
- Verification imports the stored public JWK and uses the same canonical string.
- Successful verification updates `last_used_at` and issues a new session.

### Remote session

- Session IDs are opaque 32-byte random values stored only in backend memory.
- Cookie name: `__Host-agent_remote`.
- Cookie flags: `Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200` with no Domain.
- Sessions expire after 12 hours. The device key silently obtains a new session on the next page load.
- A device logout deletes only its current memory session and cookie.
- Revocation invalidates every session for that device immediately and closes its HTTP-upgraded WebSockets with code `4003`.
- Authentication endpoints are globally capped at 100 requests per minute and 20 requests per minute per `CF-Connecting-IP`; direct loopback tests use the socket address.

### Remote routing gate

- Unauthenticated remote requests may receive only the locked entry page, its local CSS/JS assets, and `/remote-auth/*`.
- `/pair` shows the pairing view only when its browser fragment is present; the secret is still validated only on POST.
- All existing static application files, `/api/*`, `/ws`, `/devtools/*`, and `/devtools-ws` require a valid device session.
- Authenticated remote devices receive the normal application and have full existing capabilities.
- `/api/remote/*` always returns `404` on the remote listener.
- Remote Host must equal the active public hostname and Origin must equal `https://<active-public-hostname>` for state-changing HTTP and every WebSocket upgrade.
- Authentication responses use `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, and a CSP that permits only same-origin scripts, styles, images, HTTP, and WebSockets.

## HTTP interfaces

### Local-only administration

```ts
GET /api/runtime
-> { product: "agent-remote", version: 1, surface: "local", desktopMode: boolean }

GET /api/remote/status
-> {
  supported: boolean,
  cloudflared: { available: boolean, version?: string, source?: "bundled" | "override" | "path", error?: string },
  tokenConfigured: boolean,
  tunnel: TunnelStatus,
  named?: { zoneName: string, hostname: string, desiredState: "stopped" | "running" }
}

PUT /api/remote/cloudflare-token
body: { token: string }
-> { configured: true, zones: CloudflareZone[] }

DELETE /api/remote/cloudflare-token
-> { configured: false }

GET /api/remote/zones
-> { zones: CloudflareZone[] }

GET /api/remote/hostname-availability?zoneId=<id>&subdomain=<label>
-> { hostname: string, status: "available" | "reusable" | "conflict", suggestions: string[] }

POST /api/remote/tunnels/quick
-> 201 TunnelStatus

POST /api/remote/tunnels/named
body: { zoneId: string, subdomain: string }
-> 201 TunnelStatus

POST /api/remote/tunnels/stop
-> TunnelStatus

DELETE /api/remote/tunnels/named
-> { removed: true, warnings: string[] }

POST /api/remote/pairing-sessions
-> 201 { pairUrl: string, qrDataUrl: string, expiresAt: number }

GET /api/remote/devices
-> { devices: RemoteDevice[] }

DELETE /api/remote/devices/:deviceId
-> { revoked: true }
```

All mutations are same-origin only, reject non-JSON bodies where applicable, and use the existing JSON error shape `{ error: string, code?: string }`.

### Remote authentication

```ts
GET /remote-auth/status
-> { authenticated: boolean, deviceId?: string, expiresAt?: number }

POST /remote-auth/pair
body: { secret: string, deviceName: string, publicKeyJwk: JsonWebKey }
-> 201 { authenticated: true, device: RemoteDevice, expiresAt: number }

POST /remote-auth/challenge
POST /remote-auth/verify
DELETE /remote-auth/session
```

## User experience

### Local Remote button

- A phone/Remote floating action button is fixed to the bottom-right safe area.
- It appears only when `GET /api/runtime` reports `surface="local"`; it is absent from the authenticated remote application.
- The button shows stopped, connecting, online, and error states using semantic tokens in `public/tokens.css`.

### Remote modal

The modal reuses the existing dialog language and has four sections:

1. **Connection**: Quick or Custom Domain, status, public URL, copy/open, Connect, Stop, and Remove.
2. **Cloudflare setup**: exact scoped-token instructions, token input, validation result, zone dropdown, and single-label subdomain input.
3. **Pair device**: Create/refresh QR, two-minute countdown, public URL, and the Quick Tunnel re-pair warning.
4. **Devices**: name, paired time, last used time, status, and Revoke.

- Hostname availability is checked after 350 ms of inactivity and again on submit.
- Conflicts never offer overwrite; they show available suggestions.
- Remove and Revoke require confirmation.
- At widths at or below 520 px, the modal becomes a full-screen sheet and the Remote button respects `env(safe-area-inset-right)` and `env(safe-area-inset-bottom)`.
- Reduced-motion rules remain intact.

### Remote entry

- A returning device sees `Connecting securely…` while its stored key completes a challenge.
- A pairing link shows the device name field and one `Pair this device` action.
- Missing, expired, or already-used secrets show a locked message instructing the user to create a new QR on the Mac.
- A browser profile without a key sees `This device is not paired` and no way to create a pairing session remotely.

## Error behavior

- Local terminal functionality remains available when Remote initialization, Keychain, Cloudflare API, DNS, or `cloudflared` fails.
- Stable machine-readable error codes include `REMOTE_UNSUPPORTED`, `CLOUDFLARED_MISSING`, `CLOUDFLARED_OUTDATED`, `TOKEN_INVALID`, `ZONE_FORBIDDEN`, `HOSTNAME_CONFLICT`, `TUNNEL_START_TIMEOUT`, `PAIRING_EXPIRED`, `DEVICE_REVOKED`, and `REMOTE_UNAUTHORIZED`.
- Cloudflare response bodies are reduced to safe messages; tokens, tunnel tokens, pairing secrets, cookies, signatures, and full request headers are never logged.
- Repeated Connect/Stop calls are serialized. An operation already in the requested state is idempotent.
- Shutdown always closes tunnel children, both WebSocket servers, both HTTP listeners, remote sessions, and both SQLite connections.

## Dependencies and implementation order

1. Add configuration, remote store, and deterministic unit-test seams.
2. Add device authentication and session/revocation behavior.
3. Add Keychain, Cloudflare REST, hostname ownership, and DNS behavior.
4. Add `cloudflared` discovery and process lifecycle.
5. Split local-control and remote-gateway routing while sharing the existing terminal runtime.
6. Add local administration and remote authentication HTTP contracts.
7. Add the local Remote modal and remote entry/pairing frontend.
8. Add Tauri lifecycle, sidecar packaging, and Apple Silicon build scripts.
9. Add integration, Playwright, packaging smoke tests, and documentation.

New runtime dependencies are `qrcode` for locally rendered QR data and Tauri v2 packages for desktop development. Packaging uses `@yao-pkg/pkg` to produce the Apple Silicon Node sidecar. No Cloudflare SDK is required; the backend uses `fetch` against documented REST endpoints.

## Open risks

- `node-pty`, `node:sqlite`, ESM, and static assets must all survive `@yao-pkg/pkg`; the packaging smoke test must run a real PTY before the Tauri build is considered valid.
- The Apple Silicon `cloudflared` binary increases app size and must be pinned, checksum-verified during preparation, and covered by its Apache-2.0 notice.
- macOS may prompt when agent-remote first writes or reads its Keychain item. Cancellation must be handled as a recoverable modal error.
- Quick Tunnel URLs are temporary, have Cloudflare development-service limits, and require re-pairing after their origin changes.
- IndexedDB eviction or browser data clearing destroys the non-extractable private key; recovery is intentionally a new local QR pairing.
- Anyone who can view the local QR during its two-minute lifetime can pair. This matches the selected trust model and is called out in the UI.
- Device authentication protects the public gateway, but a compromised authenticated browser has full terminal control by design.
- DNS and tunnel deletion are multi-step remote operations. Ownership revalidation and retryable metadata prevent destructive cleanup of resources changed outside agent-remote.

## Verification requirements

- Unit tests for config, SQLite migrations, cryptographic challenge verification, expiry, rate limits, Keychain command handling, Cloudflare API payloads, hostname conflict/reuse, and tunnel process transitions.
- HTTP/WebSocket integration tests proving local-only administration, remote authentication gates, full authenticated capability, immediate revocation, strict Host/Origin checks, and clean shutdown of both listeners.
- Playwright tests for desktop and narrow mobile layouts, Quick and named setup with fake Cloudflare/cloudflared fixtures, QR expiry, first pair, returning-device login, remote admin-route denial, and revoke behavior.
- A packaged-sidecar smoke test that boots, serves `/health`, opens a real PTY, and shuts down without orphaning tmux or cloudflared.
- `npm run test:all` plus `npm run desktop:build` before handoff.

## References

- [Tauri external sidecars](https://v2.tauri.app/develop/sidecar/)
- [Tauri Node.js sidecar guide](https://v2.tauri.app/learn/sidecar-nodejs/)
- [Cloudflare Tunnel API setup](https://developers.cloudflare.com/tunnel/setup/)
- [Cloudflare remote tunnel configuration API](https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/subresources/configurations/)
- [Cloudflare tunnel token API](https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/subresources/token/methods/get/)
- [Cloudflare run parameters](https://developers.cloudflare.com/tunnel/advanced/run-parameters/)
