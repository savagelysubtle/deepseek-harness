# @deepseek-ai/dsh-mailbox-bridge

English | [中文](README.zh.md)

The mailbox consumer: a polling bridge that turns claimed messages into ordinary user-role turns on the addressed [named-session](../../session/named-sessions/README.md) agents. Routing is pure derivation — the address's name half IS the session name — so a live in-process agent gets steered immediately, a dormant one is cold-resumed under its per-name residency lock, and one held by another process defers back to the queue without waiting out any staleness window.

## Delivery cycle

| Step | Semantics |
|---|---|
| `claim` | Up to `maxClaimPerCycle` pending-or-stale messages per cycle across the configured `addresses`, through the registry's default provider. |
| **Live target** | The derived session id resolves on `ctx.agents`: deliver steering into the running turn first (publish-side wake must land promptly); a turn-boundary rejection falls back to an ordinary queued turn. Settles `done` at admission. |
| **Dormant target** | Takes the named-session lock (`lockStaleMs` bounds live-holder takeover; absent keeps pid-liveness as the only takeover path), probes persistence: an absent log settles `failed` with reason `unknown-address`; a present log resumes the agent, delivers as a FIFO turn, settles `done` AT ADMISSION, awaits quiescence, flushes, and disposes before releasing. |
| **Resident elsewhere** | Lock acquisition loses to a live holder: settles `pending` so a later cycle retries. |

Every delivered turn carries the merged [`mailbox` message source](../mailbox/src/source.ts) (`{ kind: 'mailbox', form: 'relay', address, from, messageId, traceId? }`), so transcripts credit relayed mail to its sender address instead of an anonymous user turn. Per-lease failures settle `failed` with the reason instead of wedging the roster behind one poison message.

## Config

| Field | Type | Default | Semantics |
|---|---|---|---|
| `addresses` | string[]? | absent | Full `<namespace>:<name>` endpoints served; an empty or malformed roster fails at mount. |
| `pollIntervalMs` | number? | `5000` | Pause between drain cycles. |
| `maxClaimPerCycle` | number? | `10` | Upper bound on leases claimed per cycle. |
| `staleClaimMs` | number? | `60000` | Age past which an abandoned claim becomes reclaimable. |
| `lockStaleMs` | number? | absent | Cold-resume takeover bound for wedged locks; absent keeps shipped pid-liveness semantics. |
| `admitFromNamespaces` | string[]? | `[]` | Sender namespaces admitted beyond this roster's own. Empty is FAIL-CLOSED: guest/external-origin mail settles `failed/sender-not-admitted` at drain (the store cannot police outside writers at write time). Chairs-only falls out of composition — only chair bridges opt into `['guest']`. |

The interval timer never pins the host event loop (`unref`): deployments that exist only to serve mail hold themselves up through other handles. Structural failures after mount clear the timer and throw rather than ticking silently forever.

## Model Experience

### Delivered mailbox messages

#### What the model sees

Each drained message arrives as one user-role turn whose text joins the sender's `subject` and `payload` (JSON-serialized objects), and whose source is `{ kind: 'mailbox', form: 'relay' }` with the destination `address`, sender `from`, store `messageId`, and optional `traceId`. Replies are NOT transportable back through settlement — answers travel as newly published messages via the send tool.

#### Token effect

Conditional and real: every delivered message appends its rendered turn to the target conversation's request history once admitted; settlement metadata itself reaches no model.

#### KV Cache effect

Append-only per target session. Each admitted mail extends the transcript after the existing prefix, so previously cached prefixes stay reusable; a stale-lease redelivery can append a duplicate turn after a crash window, replacing nothing but adding tokens consumers must tolerate duplicates of.

## Wire admission

Non-dsh callers reach the same drain through the host API's `mailbox.publish` ([the apiproxy](../../host/apiproxy/README.md)), which wraps the exported [`publishAndWake`](./src/index.ts): loud roster validation against every mounted bridge's addresses, one store write through the default provider, one immediate routing pass, and a `delivered`/`queued` disposition taken from what this wake's settlements observed. Terminal routing failures reject with the recorded reason instead of a false-fast acknowledgment.

## Known Limitations and Deferred Work

- **No pending-directory discovery** — the roster is configuration-declared; scanning a store's unknown addresses needs a provider enumeration surface the Service Definition does not ship yet (`discoverPending` stays unplanned until then).
- **Single-store resolution** — deliveries ride the registry's default provider only; per-address provider routing waits for a consumer need.
- **Steering refusal is best-effort** — a boundary rejection silently degrades to queueing within the same cycle; there is no retry-later signal distinct from admission.
