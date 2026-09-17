# @deepseek-ai/dsh-client-ui-org-controls

English | [中文](README.zh.md)

Org Controls registers two org-wide session actions into the sidebar's existing `sidebar.footer.action` slot, beside Settings: **Stop All** (SWD-130) stops every live top-level session's own turn and cascades into each root's descendant forest through the already-merged `sessions.stopAll` host call, reading back its `descendants` outcome so a `{ failed }` cascade result renders as a failure rather than folding into a clean "stopped N" line; **Send All** (SWD-131) composes one message in a single dialog and steers every live top-level session with it immediately on Send, mid-turn (never queued) and with no separate confirm step (removed by founder ruling — composing is already a deliberate act, and the reachable count plus the mid-turn-interruption warning live in the compose dialog itself), through the new `sessions.sendAll` host call, again reading back its `result` so a per-session delivery failure surfaces rather than vanishing into the sent count. Both counts come from the framework's standard `useSessions` hook — running sessions for Stop All, and every *attached* (live-agent) top-level session for Send All, deliberately not every listed root: a cold, never-attached historical row is one the host's own broadcast already skips, so counting it would promise a delivery the control cannot make; both controls disable their trigger with a visible reason when there is nothing to act on, and both render a persistent (non-auto-fading) result banner rather than a toast, since a partial failure is exactly the kind of thing that must not disappear before it is read. The package provides no service and declares no Context merge beyond the two list entries. Contract: api-contracts v3 §8.

## Model Experience

Indirectly, through the host `session.stopAll`/`session.sendAll` RPCs this package's two buttons trigger: Stop All ends running turns before they produce further output, and Send All's steered message enters the very session log and next-turn context the model reads, exactly as an ordinary composer send would — but neither the RPC route nor the request/turn assembly it drives belongs to this package.

#### KV Cache effect

None directly; this package neither assembles nor sends a provider request. A steered Send All message becomes new log content the next request includes, which extends the provider prefix rather than invalidating it — the same effect an ordinary user message has, owned by the session/agent-loop machinery that assembles that request.

## Known Limitations and Deferred Work

- **No per-session opt-out** — both controls address every live top-level session; there is no way to exclude one session from a Stop All or Send All pass from this view.
- **No queue for Send All** — by founder ruling this steers immediately (mid-turn interruption), not queued behind whatever a session is already doing; that is the intended behavior, not a gap, but it means a session mid-tool-call is interrupted rather than finishing first.
