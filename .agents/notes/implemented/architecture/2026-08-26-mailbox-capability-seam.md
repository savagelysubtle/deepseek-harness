# Agent Note: Mailbox capability seam — durable cross-process agent messaging

Status: implemented

## Problem

Harness residency is process-local by design: continuable-subagent Activations and inboxes do not coordinate across processes (`subagent` README, known limitation). Automation that addresses long-lived agents from outside — a Slack bot, a fleet dispatcher, another repository's agents — had exactly two options: shell out to headless runs (stateless between invocations until named sessions landed) or reach into persistence internals. Neither provides message durability, delivery-state tracking, or cross-project addressing. The opencode fork's equivalent feature shipped a peer-mailbox tool backed by a table its send path never writes (`session_peer_message`, 0 rows) — durable addressing without durable delivery.

## Decision

A new `mailbox` capability group following the Service Definition / Provider / Consumer pattern:

- `dsh-mailbox` (this change) defines branded `MailboxAddress`/`MailboxMessageId`, the `MailboxState` machine (`pending|claimed|done|failed`), `MailboxProvider` (publish/claim/settle), the `ctx.mailbox` registry service, the `<namespace>:<name>` address grammar with a reserved chair-to-chair resolution extension point for cross-temple routing policy, and the merge-extensible `mailbox` message-source kind.
- Providers own transport and leasing. Queue claims are STORE-owned conditional updates (`pending`→`claimed` with stale-claim reclaim); session residency stays pid-liveness locks from `dsh-named-sessions`. These are deliberately different exclusions and must never be conflated.
- A bridge plugin (follow-up change) drains claimed messages into addressed Agents: live agents receive `followup()` turns; dormant ones cold-resume first. Delivery completion means INBOX ADMISSION, never turn outcome; results travel as new outbound messages. Delivery is at-least-once; provenance carries the store id so receivers recognize crash-window duplicates.
- Delivered content is an ordinary user-role turn carrying `{ kind: 'mailbox' }` provenance — facts, not directives; receiving agents reason about mailbox input, never auto-execute it. No new event kinds; no log-version bump.
- Auth targets per-consumer `sb_secret_*` keys via the credentials seam with store-side RLS enforcement; custom JWT minting was measured dead on asymmetric-key Supab projects and survives only as legacy/self-hosted fallback.

## Verification

Unit suites cover address-grammar round-trips and validation, duplicate-provider registration rejection (loud failure), claim-filter invariant rejections, and the message-source kind fold. Real-composition coverage arrives with the bridge slice (product-visible delivery through the Loader against a scripted model), per the testing policy for product-visible plugins.

## Alternatives considered

- **Extending the subagent continuation manager across processes**: rejected. The residency ownership graph is intentionally process-local; a second coordination state machine inside it would double every teardown ordering rule.
- **Recording names on `SessionHeader`**: rejected. It re-couples the session format to a display concern — see the named-sessions note.
- **Pid artifacts in the queue store**: rejected. Crashed holders would wedge leases that stale-timestamp reclaim dissolves instead.

## Consequences

Agents become externally addressable by stable names across processes and repositories while session formats stay untouched. The store owns the address directory, which makes a fleet-status view derivable later without violating named-session non-enumerability. Unknown addresses fail loud per message rather than silently queuing. Cross-process duplicate delivery remains possible in crash windows — accepted, documented in provider READMEs as they land.
