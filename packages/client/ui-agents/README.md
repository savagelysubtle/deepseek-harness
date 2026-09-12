# @deepseek-ai/dsh-client-ui-agents

English | [中文](README.zh.md)

Agents renders the subagent tree running underneath the conversation currently open — the sessions the Workspace browser's `sessionVisible()` deliberately hides from the ordinary session list, collapsing them into a single running-count badge. A subagent nests under its immediate parent exactly as the runtime's own `origin`/`parentId` lineage records it, to any depth, running subagents first and otherwise most-recently-updated first; each row shows the subagent's title, a state dot for running/stopped/interrupted/error/completed/idle, and — for a session with its own subagents — a disclosure toggle to expand or collapse that nested branch. Read only: rows carry no navigation and no stop control, since the cascading-stop RPCs this view will eventually drive are a separate, not-yet-landed lane; wiring actions into this view is deliberate follow-up work, not part of it today. A conversation with no subagents underneath it renders a plain sentence saying so rather than an empty panel. The package provides no service and declares no Context merge; it registers one tab in the conversation's `'conversation.view'` slot ring, reading the session list through the framework's standard `useSessions` hook. Contract: api-contracts v3 §8.

## Model Experience

None, as the Agents view only renders session-list metadata already retained in the browser.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Read only** — no way to stop, interrupt, or open a subagent from this view; those are deliberate follow-up work once the cascading-stop RPCs land.
