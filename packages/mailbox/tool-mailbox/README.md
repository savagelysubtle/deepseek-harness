# @deepseek-ai/dsh-tool-mailbox

English | [中文](README.zh.md)

The four model-facing mailbox tools — `mailbox_send`, `mailbox_check_inbox`, `mailbox_await`, and `mailbox_directory` — registered over the `ctx.mailbox` seam. Every tool resolves the calling seat's address through one identity path: the deployment-supplied trusted session name, folded with the calling agent's session id, resolved by `resolveMailboxIdentity`. A seat can address mail anywhere but can only ever be itself; there is no `from` argument to forge and no address argument to read another seat's queue. An anonymous run (no trusted name available) fails every tool loud at call time rather than falling back to a guessed sender.

Requires a loaded mailbox Service Provider (e.g. `@deepseek-ai/dsh-mailbox-local`) registered as the registry's `defaultProvider`; the plugin stays pending until its injected services exist.

## Roster-drift alarm (SWD-118)

When `addresses` is configured (the multi-seat host), this mount declares its served roster to the shared `ctx.mailbox` registry ([`declareRoster`](../mailbox/README.md#roster-drift-alarm)) and checks it against the org registry at mount, once. Two conditions warn loudly and never throw, refuse the mount, or block a tool call: this roster disagreeing with `mailbox-bridge`'s, and this roster serving a name the org registry does not know. A single-seat headless run (no `addresses`) serves no roster and neither declares nor is checked. See the [mailbox package's roster-drift alarm](../mailbox/README.md#roster-drift-alarm) for the full contract, including what is deliberately NOT alarmed on.

## Tools

### `mailbox_send`

| Arg | Type | Notes |
|---|---|---|
| `to` | string (required) | Recipient seat's bare name; grammar-checked at the admitting edge. |
| `subject` | string (required) | Short human-readable subject line. |
| `body` | string (required) | The message text; self-contained, since the recipient may lack this conversation's context. |
| `blocking` | boolean | True when the sender is blocked waiting on an answer; renders as the blocking contract line on delivery. |
| `replyToTraceId` | string | The traceId of the message this reply answers, when the sender is waiting on it. Threads the reply onto that correlation chain so the waiting seat's `mailbox_await` matches it. |

The result carries the provider id, both addresses, and the row's correlation id — a fresh id per ordinary send, or the awaited send's id for a threaded reply — and the rendering names the id so the model can pass it to `mailbox_await`. The bridge's per-trace hop cap bounds how many admitted deliveries one threaded chain may carry; a longer correspondence re-threads onto a fresh send.

### `mailbox_check_inbox`

No parameters. Claims and settles (inbox admission) up to 20 pending messages addressed to the calling seat's own address, returning the drained entries — sender, blocking mark, subject, body, claim time.

### `mailbox_await`

| Arg | Type | Notes |
|---|---|---|
| `deadlineMs` | integer | Clamped to 1000–600000; default 300000. Every expiry returns the decision to the model. |
| `traceId` | string | The correlation id from the awaited send's result. Omit to end the wait on any inbound mail. |

Holds the turn until a reply arrives, the awaited send is refused, or the deadline expires — the alternative to an improvised Bash sleep-poll loop. A refusal ends the wait immediately with the recorded reason verbatim. A reply is detected by store reads, not only by claiming: a reply the bridge already claimed, steered as a turn, and settled `done` still ends the wait with its content, and a threaded reply (`replyToTraceId`) is matched to the wait precisely. A timeout is an ordinary result carrying the awaited send's store state — `delivered` (with the time), `claimed`, `pending`, or `unknown` — plus `waitedMs`. Cancellation forwards the caller's abort into every read and sleep, so a stopped seat reclaims control immediately.

### `mailbox_directory`

No parameters. Lists every seat in the org directory — this host's served roster merged with the org registry — marking which seats are served here, which are department leads, and which are throwaway test seats that must never be mailed. Discovery is what makes the other three tools usable: a seat cannot address a coworker it cannot name. The org registry loads per call; one that fails to load degrades the list to the served roster with the caveat stated in the result. Topology and admission are enforced at send time — the directory is who exists, not who may hear you.

## Model Experience

### Sending and draining

#### What the model sees

`mailbox_send`'s result text names the recipient, the stored message id, the sender, and the correlation id, plus the pointer to await that id; `mailbox_check_inbox` returns the drained entries numbered exactly as `mailbox_await` renders them, so a reply reads identically whichever tool delivered it. No system-prompt section, no address book — the result texts are the model's complete interface.

#### Token effect

One short fixed-shape result per call. `mailbox_check_inbox` scales with drained mail: up to 20 entries per call, each subject plus body, bounded by the drain limit rather than the queue's depth.

#### KV Cache effect

Tool results are append-only in the calling session; a redelivered reply (the at-least-once property) adds tokens without changing any cached prefix.

### Awaiting a reply

#### What the model sees

One result naming how the wait ended: the reply's numbered entries, the refusal's verbatim reason, or a timeout carrying the awaited send's store state (`delivered` with the time, `claimed`, `pending`, or `unknown`) plus `waitedMs`. A held turn blocks the seat's model for the clamped deadline — the tool's own bound, never a caller-supplied budget.

#### Token effect

One bounded wait costs one held turn plus one result; the improvised alternative — repeated poll turns — burns a turn per 2 s poll. Reads during the wait reach only the store, never the model.

#### KV Cache effect

The held turn's request history stays frozen while waiting, so the cached prefix survives to the result; the timeout text's delivery diagnosis arrives as appended result text, not a context rewrite.

## Known Limitations and Deferred Work

- **An untraced or unthreaded reply is matched directionally, not by id.** A wait without `traceId` — or a traced wait whose peer replied without `replyToTraceId` — ends on any inbound mail admitted since the anchor (wait start, or the awaited send's admission). Unrelated inbound mail therefore ends such a wait too; the entries name their senders so the model can judge. Precise correlation requires the thread, which only the replying side can supply.
- **A reply can reach the model twice.** Read-based detection returns the reply's content as the tool result while the bridge steers the same reply as a turn — the at-least-once property the claim path already has. Deduplicating across the two channels needs a delivery ledger the seam does not own today.
- **Threaded chains are bounded by the bridge's per-trace hop cap** (default 8 admitted deliveries). The refusal names the trace; recovery is a fresh send, which starts a fresh chain.
