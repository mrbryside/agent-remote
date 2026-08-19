# Persistence

## SQLite

`src/projects.js` uses Node's synchronous SQLite API. The default file is `~/.agent-remote/agent-remote.db`; its parent directory is created with user-only permissions on startup. `AGENT_REMOTE_DB_PATH` overrides the location for development and tests.

The `projects` table stores display name, working directory, selected `agent_id`, and timestamps. It never stores an editable launch command. `src/agents.js` is the authoritative server-side catalog that maps an agent ID to its command and UI/provider metadata; production currently exposes only Grok. The `chats` table stores tmux session name, owning project, title/auto-title state, creation time, and latest activity. Foreign keys cascade chat deletion when a project is removed. Startup migrations add missing chat activity data without discarding existing rows.

## Durable versus cached state

- SQLite is authoritative for project grouping and chat titles.
- tmux is authoritative for whether a managed process still exists.
- `localStorage` keeps UI preferences such as selection, expanded project IDs, and pane widths.
- `sessionStorage` terminal snapshots are display acceleration only. They may be evicted and must never block a live PTY.

When changing the schema, make migration logic idempotent and extend `test/projects.test.js` with both a fresh-database and an existing-database case.

[Back to architecture index](index.md)
