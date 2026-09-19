# @deepseek-ai/dsh-client-ui-org-board

English | [中文](README.zh.md)

Org Board (SWD-134 slice 2) registers a third entry into the sidebar's existing `sidebar.footer.action` slot, beside Stop All / Send All: a large modal drawing the organisation as a node graph, built on **React Flow** (`@xyflow/react`). It is a pure read of the host's `org.get` RPC (added in slice 1) and draws only — there is no edit affordance anywhere in this package, and none half-wired toward one; a later slice owns mutation. `org.get` is re-issued every time the modal opens (and on demand from a Refresh button inside it), so the board never shows data from before the modal was last shown.

**Nodes are seats** (from the parsed registry): each node shows the seat name and a badge row distinguishing a department lead, a throwaway test seat, a seat the computed drift report says is registered but not fully served by both rosters, and a seat holding call-up (rendered as a badge on that one node, never as edges to every other seat — call-up is a property of the seat, not a topology). **Edges are undirected mail-permission pairs** from the registry's own edge list, drawn without arrowheads. Clicking a node opens a detail panel with its working directory, session id (or an explicit "no session recorded"), and tool allow/deny lists (or an explicit "no tool restrictions"). Node positions come from a fixed alphabetical grid (`layout.ts`) — the registry carries no coordinates, and this slice has nothing to persist a drag to, so no auto-layout dependency was added for one read-only view.

**The hard requirement this package exists to satisfy: a failure must never render as emptiness, and must never render as a clean board.** `org.get`'s three inner results (`registry`, `mailboxBridge`, `toolMailbox`) and its drift report each fail INDEPENDENTLY and each surfaces its own named reason on screen — never a blank canvas standing in for "the registry couldn't be read," and never a quietly-omitted drift section standing in for "nothing to report." Concretely: an unreadable registry shows a red banner naming the reason and the graph section is not rendered at all (no empty canvas in its place); an unreadable roster shows its own banner AND the drift section shows drift as unavailable rather than a clean report (drift requires every source to have succeeded, so a roster failure always drops through to a named drift failure too — this package never recomputes or fakes a drift verdict from a partial read); the RPC call itself failing (transport/business error, before any org data was even returned) shows one top-level banner and nothing else, since there is no profile name to show either in that case. The profile name (`profile`) is always shown once any response lands, because the active profile is not discoverable at runtime anywhere in this deployment — naming it here is what turns that assumption from a fact only visible in source into one a viewer can see.

## Model Experience

None, as the package only projects an existing read-only host query (`org.get`) for human viewing; it never touches session content, prompts, tool schemas, or model context.

#### KV Cache effect

None; the package issues no LLM requests and appends nothing to any session log.

## Known Limitations and Deferred Work

- **Read-only** — by design for this slice. No add/remove/rename seat, no edge editing, no drift "fix" action; those are a later slice's scope.
- **No live push invalidation** — the board re-reads on open, on the Refresh button, and on a reconnect, not on a server-pushed event; a change made in another tab is not reflected until one of those happens.
- **The graph library's base stylesheet is vendored, not imported** — this bundler has no loader for a bare `.css` import, so `src/client/xyflow-base.module.css` is a wrapped copy of `@xyflow/react`'s own base styles. The dependency is pinned with a caret, so an in-range update can ship styles this copy no longer matches, with nothing failing loudly. Regenerate it on every `@xyflow/react` bump — that file's header comment carries the procedure.
- **Fixed grid layout, no drag persistence** — nodes are placed in an alphabetical grid and are not draggable; there is nothing yet for a rearranged position to be saved to.
- **Served-but-unregistered drift rows are list-only** — they have no `cwd`/`sessionId`/tools to show, so they appear only in the Drift section's second list, never as graph nodes.
