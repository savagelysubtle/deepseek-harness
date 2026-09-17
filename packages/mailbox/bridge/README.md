# @deepseek-ai/dsh-mailbox-bridge

English | [中文](README.zh.md)

The mailbox consumer: a polling bridge that turns claimed messages into ordinary user-role turns on the addressed [named-session](../../session/named-sessions/README.md) agents. Routing is pure derivation — the address's name half IS the session name — so a live in-process agent gets steered immediately, a dormant one is cold-resumed under its per-name residency lock, and one held by another process defers back to the queue without waiting out any staleness window.

## Delivery cycle

| Step | Semantics |
|---|---|
| `claim` | Up to `maxClaimPerCycle` pending-or-stale messages per cycle across the configured `addresses`, through the registry's default provider. |
| **Live target** | The derived session id resolves on `ctx.agents`: delivery STEERS into the live turn immediately — no busyness inference, regardless of message type (founder model: all mail interrupts; senders mark `blocking`, receivers judge prioritization). A turn-boundary rejection falls back to an ordinary queued turn. Settles `done` at admission. |
| **Dormant target** | Takes the named-session lock (`lockStaleMs` bounds live-holder takeover; absent keeps pid-liveness as the only takeover path), probes persistence: an absent log settles `failed` with reason `unknown-address`; a present log resumes the agent, delivers as a FIFO turn, settles `done` AT ADMISSION, awaits quiescence, flushes, and disposes before releasing. |
| **Resident elsewhere** | Lock acquisition loses to a live holder: settles `pending` so a later cycle retries. |

Every admission refusal (`org-registry-unavailable`, a `test: true` boundary violation, an org-topology denial, `sender-not-admitted`, a loop-guard hit) reports itself three ways from the one `refuse` call: the recipient's row settles `failed`, the `mailbox/refused` context event carries the sender address, recipient address, and the recorded reason to the host's consumers, and a durable refusal notice is logged into the SENDER's session. The host's api-proxy renders the event as a live system notice (`host/agent-error` frame) addressed to the sender's session — the toast for a user who happens to be watching. The notice is a `user/message` context node whose source is the mailbox `notice` form, appended directly to the sender's session log, so the refusal survives a reload, sits in the conversation the sender reads, and reaches the sender's model without waking anything: no `steer`, no `followup`, no turn, and a mid-turn sender reads it on the request it already runs. A refusal is the harness reporting on the sender's own action, so it deliberately does not travel as mail — a bounce back to the sender would itself be subject to the rule that refused the original, refused in turn, and the sender would have seen silence. The notice never touches the mail store at all, so no admission rule — including the one that fired — can ever judge it; a refusal notice can never itself be refused. A `guest:` sender has no session and reaches nobody through either outlet (the CLI's own send path reports its failures with a non-zero exit), an unparseable sender names no derivable session, and a sender whose session has never run is never provisioned for a notice — the ghost-session class.

Every terminal failure after admission (a wake or provisioning crash) settles the recipient's row `failed` AND publishes a best-effort `bounce` notice addressed back to the original sender — type `bounce`, carrying the original `traceId` and the recorded reason in its payload — so a drop is never silent to whoever sent it. Those are failures of the recipient's side; the bounce is neither circular nor admission-judged. An undrained bounce is just an unread row, never a hang.

Every delivered turn carries the merged [`mailbox` message source](../mailbox/src/source.ts) (`{ kind: 'mailbox', form: 'relay', address, from, messageId, senderClass, subject?, blocking?, traceId? }`), so transcripts credit relayed mail to its sender address instead of an anonymous user turn, and the client's mail card renders the sender class, subject, and blocking mark straight from the durable provenance. A refusal notice carries the sibling `form: 'notice'` source (`{ kind: 'mailbox', form: 'notice', refusedTo, messageId, reason, summary }`) with NO `from`: a readable `from` is exactly what makes a mailbox source present as incoming mail on the client, and the refusal is the harness's report, not correspondence. Message-carried fields are omitted when the message does not carry them, so older logged rows still read as they were written. Per-lease failures settle `failed` with the reason instead of wedging the roster behind one poison message.

## Config

| Field | Type | Default | Semantics |
|---|---|---|---|
| `addresses` | string[]? | absent | Bare seat-name endpoints served; an empty or malformed roster fails at mount. |
| `pollIntervalMs` | number? | `5000` | Pause between drain cycles. |
| `maxClaimPerCycle` | number? | `10` | Upper bound on leases claimed per cycle. |
| `staleClaimMs` | number? | `60000` | Age past which an abandoned claim becomes reclaimable. |
| `lockStaleMs` | number? | absent | Cold-resume takeover bound for wedged locks; absent keeps shipped pid-liveness semantics. |
| `admitFrom` | string[]? | `[]` | Sender addresses admitted beyond the served roster. Empty is FAIL-CLOSED: external-origin mail settles `failed/sender-not-admitted` at drain (the store cannot police outside writers at write time). |
| `admitGuests` | boolean? | `true` | Whether the `guest:`-prefixed outside-operator CLI channel is admitted. A guest sender bypasses the `test: true` boundary and the org topology BY DESIGN — both rules judge seat-to-seat pairs, and a guest is never a roster seat — which is the break-glass property the channel exists for: an outside operator can always reach a working seat. It costs the sender no authority (the envelope renders `unverified`, and the recipient is told so); the loop guards still apply in full. `false` closes the channel, and is the only switch that does. |
| `seatAliases` | {address, sessionId}[]? | absent | Explicit live-seat roster for addresses whose target session is NOT name-derived (web-host seat sessions). Alias routes steer/cold-resume to that exact session id; unlisted names keep derivation. Absent keeps pure-derivation default. |

The interval timer never pins the host event loop (`unref`): deployments that exist only to serve mail hold themselves up through other handles. Structural failures after mount clear the timer and throw rather than ticking silently forever.

## Roster-drift alarm (SWD-118)

At mount, once — before the first drain, independent of whether any mail is waiting — this bridge declares its `addresses` to the shared `ctx.mailbox` registry ([`declareRoster`](../mailbox/README.md#roster-drift-alarm)) and checks them against the org registry. Two conditions warn loudly and never throw, refuse the mount, or block mail: this bridge's roster disagreeing with `tool-mailbox`'s, and this bridge serving a name the org registry does not know. A registry that is simply absent is the legitimate no-registry world and no-ops; a registry that exists but will not load warns that the check could not run, rather than silently passing as "nothing is wrong." See the [mailbox package's roster-drift alarm](../mailbox/README.md#roster-drift-alarm) for the full contract, including what is deliberately NOT alarmed on.

## Wire admission

Non-dsh callers reach the same drain through the host API's `mailbox.publish` ([the apiproxy](../../host/apiproxy/README.md)), which wraps the exported [`publishAndWake`](./src/index.ts): loud roster validation against every mounted bridge's addresses, one store write through the default provider, one immediate routing pass, and a `delivered`/`queued` disposition taken from what this wake's settlements observed. Terminal routing failures reject with the recorded reason instead of a false-fast acknowledgment.

## Model Experience

### Delivered mailbox messages

#### What the model sees

Each drained message arrives as one user-role turn whose text joins the sender's `subject` and `payload` (JSON-serialized objects), and whose source is `{ kind: 'mailbox', form: 'relay' }` with the destination `address`, sender `from`, store `messageId`, the derived `senderClass`, and optional `subject`, `blocking`, and `traceId`. Replies are NOT transportable back through settlement — answers travel as newly published messages via the send tool.

#### Token effect

Conditional and real: every delivered message appends its rendered turn to the target conversation's request history once admitted; settlement metadata itself reaches no model.

#### KV Cache effect

Append-only per target session. Each admitted mail extends the transcript after the existing prefix, so previously cached prefixes stay reusable; a stale-lease redelivery can append a duplicate turn after a crash window, replacing nothing but adding tokens consumers must tolerate duplicates of.

### Refusal notices

#### What the model sees

When the bridge refuses one of the session's own sends, the session's log gains one `notice`-form context turn naming the attempted recipient, the store id, the terminal reason, and the two facts a sender needs: the recipient has seen nothing, and resending unchanged changes nothing.

#### Token effect

One short fixed-shape turn per refusal, in the sender's conversation only. It is appended, never steered, so it never starts a turn, interrupts a running one, or spends a model call by itself.

#### KV Cache effect

Appended once per refused send in the sender's session; a refusal is terminal on the store row, so the same send never appends a second notice.

## Known Limitations and Deferred Work

- **Roster stays configuration-declared** — the bridge delivers to the addresses its config names; pending-address discovery exists on the provider seam (`claimableAddresses`, with no shipped consumer today), but the bridge does not self-extend its roster from the store.
- **Single-store resolution** — deliveries ride the registry's default provider only; per-address provider routing waits for a consumer need.
- **Steering refusal is best-effort** — a boundary rejection silently degrades to queueing within the same cycle; there is no retry-later signal distinct from admission.
