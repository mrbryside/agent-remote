# agent-remote

A local multi-session browser terminal built with xterm.js, WebSocket, Node.js, node-pty, and tmux. Start agents from the CLI or the web UI, keep them alive across browser reconnects, switch between sessions from the sidebar, or pair a browser through an authenticated Cloudflare Tunnel on macOS.

The frontend supports Kitty graphics through xterm's image addon. For `terminal-browser`, a dedicated PTY launches the browser and the web UI streams its page surface directly over CDP for smooth, unclipped rendering.

## One-time setup

```bash
cd agent-remote
npm install
npm link
```

`npm link` makes the local `agent-remote` command available on this machine.

## Normal workflow

Start the web server:

```bash
cd agent-remote
npm start
```

Open <http://127.0.0.1:3000>. Click **New project**, choose a working folder, and select an agent. Grok is the only project agent currently available. The project name is optional and falls back to the selected folder name. Its **New chat** button then creates a persistent tmux session in that folder and launches the selected agent using the server-owned agent catalog.

Projects, chat titles, selected agent IDs, and working folders are stored in `~/.agent-remote/agent-remote.db`. Launch commands stay in the server-owned catalog and are not editable project data. The directory and SQLite database are created automatically on first startup. Terminal processes remain in tmux, while the database provides the project/chat organization shown in the sidebar.

On a phone, a managed Grok chat switches to a native conversation view: normal
scrolling history, a system-keyboard textarea, live tool activity, and cards
that open completed or running subagents. The desktop keeps the full terminal.
Other commands fall back to xterm until they have a conversation-provider
adapter; the provider boundary is documented in
`docs/agents/architecture/conversation-providers.md`.

You can also launch standalone sessions from any terminal:

```bash
agent-remote grok
agent-remote claude --resume abc123
agent-remote --name api-agent --cwd /path/to/project claude
```

The order is flexible: sessions can be started before or after `npm start`; the web UI discovers them automatically. Starting the same command more than once creates `-2`, `-3`, and so on.

Resize the project sidebar by dragging its edge. Collapse or reopen it with the top-bar button, or press `Ctrl+B` (`Cmd+B` on macOS). The width and collapsed state are remembered after reload. Each project menu can edit its name, folder, or agent, clear only that project's chats, or delete the project. Every chat can be closed independently.

Manage CLI sessions:

```bash
agent-remote list
agent-remote stop ar-api-agent
```

Only sessions created by `agent-remote` or this web UI appear in the manager. Other personal tmux sessions are left alone.

## Desktop app and Remote access

Agent Remote has two equivalent macOS launch modes. Both run the same Node backend and expose the same local-only **Remote** control.

```bash
# Browser mode: requires Node, tmux, and cloudflared on PATH (or CLOUDFLARED_BIN).
npm start

# Packaged Apple Silicon desktop app: build after installing dependencies.
npm run desktop:build
```

The Tauri desktop app probes `http://127.0.0.1:3000/api/runtime` when it opens. It attaches to a compatible `npm start` backend without owning it; when the port is free it starts its bundled backend. If another service owns port 3000, it reports the conflict and leaves that service unchanged. Closing the app window hides it; use the tray's **Quit** item to stop only a backend the app itself started. The tray can also show the window or open the local UI in a browser.

The desktop build is intentionally macOS Apple Silicon only. Its server sidecar is a native ARM64 launcher that starts the exact bundled Node 22 runtime and resources. A single-file `pkg` server was evaluated but rejected because its virtual filesystem prevented `node-pty`'s real `spawn-helper` PTY smoke test from working. The bundle also ships a verified Cloudflare sidecar; `desktop:prepare` pins `cloudflared` to `2026.8.2` and verifies its published SHA-256 before packaging.

### Pair a remote browser

On the local UI, open **Remote** and choose one of these modes:

- **Quick Tunnel** creates a temporary random `https://*.trycloudflare.com` URL. Scan its local QR code to pair a browser profile. Stopping it or restarting the backend discards the URL. Since the non-extractable device key is stored per browser origin in IndexedDB, a new Quick URL requires pairing that browser profile again.
- **Custom Domain** creates or reuses one named tunnel and one subdomain in a Cloudflare-hosted zone. It is the persistent option and can reconnect at startup when it was left running.

Pairing is local-only: create its QR from the local Remote dialog, then scan it from the browser to be paired. Do not share the QR URL. Each QR secret is single-use and expires in two minutes. The remote browser creates a non-extractable P-256 key in IndexedDB; clearing that browser profile, using a different origin, or losing the key requires a new local pairing. If every paired device is lost, regain local access to create a new pairing session. Local access is never granted through the remote gateway.

Remote sessions last up to 12 hours. Returning browsers silently prove possession of their device key; they do not need another QR while the key remains. The Remote dialog lists paired devices and can revoke one. Revocation invalidates its sessions and closes its active remote WebSockets immediately.

### Cloudflare setup and safe lifecycle

Browser-mode Remote needs `cloudflared` 2025.4.0 or newer. Install or upgrade it with Homebrew when the dialog reports it missing or outdated:

```bash
brew install cloudflared
# or
brew upgrade cloudflared
```

For a Custom Domain, create a Cloudflare **user API token** (not a global API key or account API token), constrained to the intended account and zone(s), with:

- Account / Cloudflare Tunnel / Edit
- Zone / DNS / Edit
- Zone / Zone / Read

The token is validated before saving and is stored only in the macOS Keychain under `com.sirawat.agent-remote.cloudflare` / `user-api-token`; it is never written to SQLite, returned by Remote APIs, or logged. Removing the Keychain item does not delete the existing named-tunnel metadata, so a replacement token can later restart or remove the resources.

Only a single lowercase subdomain label is accepted; apex domains, dots, underscores, and arbitrary existing records are not. Agent Remote never overwrites a DNS record. Reuse and removal require an exact match of the persisted account, zone, DNS record, tunnel, hostname, and CNAME target against Cloudflare.

**Stop** is reversible: it stops `cloudflared`, cancels retries, records a named tunnel as stopped, and leaves its Cloudflare DNS and tunnel intact. **Remove** first stops the tunnel, rechecks ownership, then deletes only the owned DNS record and tunnel and clears the local metadata after success. If DNS changed elsewhere or verification fails, it leaves the resource alone and reports a warning; partial failure preserves metadata for a retry.

### terminal-browser

Inside an agent session created with `agent-remote` or the web **+** button, the normal command opens a web-managed pane on the right:

```bash
terminal-browser open https://example.com --split right
```

The agent stays in its tmux pane. A host dispatcher sends a control request to the Node backend, the backend routes it to the browser WebSocket attached to that session, and the frontend starts the real `terminal-browser` in a separate direct graphics PTY on the right. The split appears as soon as the agent's request arrives and shows a dedicated loading state until the first direct browser frame is ready; the launch shell and Kitty escape stream remain hidden throughout. The hidden loading surface remains in layout, so even a repeated `open` starts with the real pane dimensions instead of a temporary 160×120 viewport. Motion uses Chromium's native screencast at CSS resolution with latest-frame WebSocket backpressure, then a single high-quality 2× capture replaces the frame after the page settles. This keeps scrolling and animation responsive without sacrificing static Retina detail. Pointer coordinates remain in CSS pixels and mouse movement is synchronized to animation frames. Hover feedback is read from the target page over CDP, so links, buttons, text fields, resize handles, and custom CSS cursors use their native cursor instead of the screenshot's fixed cursor. The browser surface has its own toolbar with back, forward, reload, new-tab, tab switching, per-tab close, **Inspect**, and **Record** controls. Inspect docks the full Chrome DevTools frontend shipped with terminal-browser's Chromium, including Elements and its picker, Console, Sources, Network, and Performance. Its duplicate screencast is disabled, so the picker inspects the main browser viewport above instead of rendering a second page view inside DevTools. Record captures only the browser viewport and downloads a WebM when stopped, including pages that remain visually static. The toolbar reads the daemon's real tab list, so tabs opened by an agent or by the page appear automatically. A repeated agent `new-tab` request for the same URL focuses the existing tab instead of duplicating it. Closing the final tab closes the split, renderer, and daemon. Each sidebar session owns its renderer: switching sessions hides and restores the matching pane, while refreshing the page reattaches to the same backend PTY and browser tabs. The pane **×** and deleting the owning session also perform full cleanup. The graphics process never enters tmux, so it does not hit tmux's Kitty Unicode-placeholder mode (which xterm's image addon does not yet implement).

`npm start` checks the machine-level dispatcher automatically and repairs it after a `terminal-browser` upgrade. The dispatcher routes both `open` and unqualified `new-tab` commands to the renderer owned by the current agent-remote session, so an agent cannot accidentally create a second native tmux pane full of Kitty escape output. It also resolves unqualified `terminal-browser action` calls to that renderer automatically, preserving native commands such as `inspect`, `record start/stop`, `trace`, `snapshot`, and every other agent-browser action. Agent-remote-owned tmux sessions have their redundant tmux status line disabled because the web UI already provides session navigation. Existing Grok or Claude sessions are supported even if the agent prepends its own directories to `PATH`; OSC-to-`/dev/tty` remains as a fallback if the backend is temporarily unavailable.

## Folder access

The web folder picker is restricted to the user's home directory and this project by default. To expose different roots:

```bash
ALLOWED_CWD_ROOTS="/path/one,/path/two" npm start
```

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Listen address |
| `PORT` | `3000` | HTTP/WebSocket port |
| `REMOTE_HOST` | `127.0.0.1` | Remote gateway bind address; only loopback is accepted |
| `REMOTE_PORT` | `PORT + 1` (`3001`) | Remote gateway HTTP/WebSocket port; defaults to `0` when `PORT=0` |
| `CLOUDFLARED_BIN` | `cloudflared` | Explicit cloudflared executable; overrides PATH discovery |
| `AGENT_REMOTE_DESKTOP` | empty | Set to `1` by the Tauri wrapper for its owned backend |
| `AGENT_REMOTE_DB_PATH` | `~/.agent-remote/agent-remote.db` | SQLite file for projects and chat metadata |
| `TERMINAL_SHELL` | `$SHELL` or `/bin/zsh` | Fallback shell when no managed session is selected |
| `TERMINAL_SHELL_ARGS` | `["-l"]` | JSON array of fallback shell arguments |
| `TERMINAL_CWD` | project directory | Fallback PTY working directory |
| `ALLOWED_CWD_ROOTS` | home + project | Comma-separated roots exposed to the folder picker |
| `TERMINAL_TOKEN` | empty | Optional URL token, e.g. `?token=...` |
| `ALLOWED_ORIGINS` | same origin only | Comma-separated extra browser origins |
| `MAX_CONNECTIONS` | `20` | Concurrent PTY limit (main terminals plus per-session browser panes) |

The default host is loopback-only. The remote gateway is always loopback-only and is exposed externally only through its owned `cloudflared` child. A programmatic test seam can permit an insecure public origin for isolated fixtures; it is not an environment variable, user setting, or production configuration. If binding the local server to a LAN address or reverse proxy, set `TERMINAL_TOKEN` and use HTTPS.

## Tests

```bash
npm run test:all
```

Remote-focused checks are available individually:

```bash
node --test test/remote-*.test.js test/tauri-contract.test.js
npm run test:e2e
npm run sidecar:smoke
cargo test --manifest-path src-tauri/Cargo.toml
```

Remote Playwright coverage uses fake Cloudflare and tunnel services on isolated loopback test ports; it never needs a live Cloudflare account. `npm run sidecar:smoke` starts the packaged launcher with temporary state, confirms both listeners and real PTY WebSocket output, then asserts shutdown leaves no sidecar or cloudflared process behind. The desktop package and sidecar smoke checks require Darwin ARM64.

The integration suite creates real projects through the browser, checks the folder-name fallback and agent selector, starts real tmux chats through the server-owned test catalog, derives the chat title from the first prompt, clears projects independently, and closes chats. It also covers real PTYs, backend-to-WebSocket split routing, renderer persistence across reconnects and page refreshes, per-session split isolation, sidebar/split resizing, viewport containment, SQLite persistence and cascading cleanup, tmux persistence, folder restrictions, authentication, and origin protection. When `terminal-browser` is installed, Playwright calls the machine-level dispatcher, verifies backend routing, launches the real binary outside tmux, checks streaming animation frames followed by the settled 2× frame, opens the browser a second time and revalidates its viewport, verifies live pointer/default cursor changes, loads the full Chrome DevTools frontend and element picker, resizes the target around the docked tools, records and downloads a real WebM, verifies duplicate-URL reuse, opens, switches, and closes real daemon tabs through the toolbar, verifies refresh persistence, and checks full cleanup; that case is skipped automatically elsewhere.
