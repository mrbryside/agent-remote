# Agent documentation

This folder holds context documents for agents. Treat every `index.md` as a jump point—only open the linked files relevant to the current task.

| If you want to know... | Go to |
| --- | --- |
| Root project index | [AGENTS.md](../../AGENTS.md) |
| Runtime, persistence, browser rendering, Remote access, or conversation providers | [Architecture](architecture/index.md) |
| Shared UI components, design tokens, and visual implementation rules | [Design system](design-system/index.md) |
| Setup, guardrails, testing, and packaging workflow | [Workflows](workflows/index.md) |

## Maintenance note

When adding new context:

1. Put detail in the relevant `docs/agents/{category}/` subfile.
2. If the category does not exist, create the folder and an `index.md`.
3. Link the new subfile from the category `index.md`.
4. If it is a new top-level category, add a row to the table above and to `AGENTS.md`.
5. Never paste long details directly into `AGENTS.md`.
6. Any new document under `docs/agents/` must follow the same index style as `AGENTS.md`: start with a short “when to read this” description, use an “If you want to know X → go to file Y” table when it covers multiple subtopics, and keep long details in linked subfiles.
