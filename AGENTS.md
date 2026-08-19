# AGENTS.md — agent-remote

Local persistent agent workspace with browser terminals, native mobile conversations, tmux, SQLite, Cloudflare Remote access, and a macOS Tauri wrapper.

`Last documented commit: ed1bd2764025e2a7a4a9fdfeee9cde467e5f19e1`

## Project structure

| Path | Purpose |
| --- | --- |
| `bin/` | User-facing `agent-remote` CLI and terminal-browser routing shim. |
| `desktop/` | Minimal loading document used by the Tauri webview. |
| `public/` | Browser UI, mobile conversation surface, Remote UI, design tokens, and xterm/browser-pane controls. |
| `scripts/` | Native dependency checks, terminal-browser shim setup, and Tauri sidecar preparation/smoke tests. |
| `src/` | Node HTTP/WebSocket server, PTY/tmux lifecycle, configuration, directories, and project persistence. |
| `src/conversations/` | Provider-neutral conversation registry plus Grok ACP, attachment, and project-file completion adapters. |
| `src/remote/` | Remote gateway, device authentication, Cloudflare APIs, ownership provisioning, tunnel lifecycle, and storage. |
| `src-tauri/` | Apple Silicon Tauri wrapper, capabilities, icons, sidecar manifest, and Rust lifecycle code. |
| `test/` | Node unit/integration tests, Playwright projects, Remote fixtures, and packaging contracts. |
| `docs/agents/` | Focused agent documentation organized as category indexes and subtopics. |
| `package.json` | Runtime constraints, CLI entry, dependencies, and development/test commands. |
| `playwright.config.js` | Serial local and Remote E2E configuration. |

Only open the sections below when they are relevant to the current task.

| If you want to know... | Go to |
| --- | --- |
| Runtime ownership, persistence, Remote security, browser rendering, or mobile providers | [Architecture](docs/agents/architecture/index.md) |
| Colors, typography, spacing, layout, and motion tokens | [Design system](docs/agents/design-system/index.md) |
| Setup, implementation guardrails, tests, desktop packaging, or safe handoff | [Workflows](docs/agents/workflows/index.md) |

## Maintenance note

When adding new context:

1. Put detail in the relevant `docs/agents/{category}/` subfile.
2. If the category does not exist, create the folder and an `index.md`.
3. Link the new subfile from the category `index.md`.
4. If it is a new top-level category, add a row to the table above.
5. Never paste long details directly into `AGENTS.md`.
6. Any new document under `docs/agents/` must follow the same index style as `AGENTS.md`: start with a short “when to read this” description, use an “If you want to know X → go to file Y” table when it covers multiple subtopics, and keep long details in linked subfiles.
