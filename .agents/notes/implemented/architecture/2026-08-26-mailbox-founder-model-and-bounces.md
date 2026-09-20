# Agent Note: Mailbox founder model — all mail steers, senders mark blocking, every drop bounces

Status: implemented

English | [中文](2026-08-26-mailbox-founder-model-and-bounces.zh.md)

## Problem

Doc 1 (outside council) found three coupled defects: urgency inferred from the wrong party (`deliverToLive` interrupted busy seats while queueing to idle ones — the busier a seat, the more disruptive identical mail), aborts risked rendering as empty successes once interrupts became real, and terminal delivery failures were invisible to senders (`unknown-address` left a durable failed row nobody ever reads).

## Decision

Revised twice by chair and founder rulings; the semantics below are final.

- **ALL mail steers a live turn** (founder revision superseding the interim sender-intent `type:'steer'` design): no busyness inference, no type-gated interrupt requests. Transport guarantees immediacy uniformly.
- **`MailboxMessage.blocking?: boolean`** (default false) carries sender-side WAIT state. It drives receiver JUDGING, not transport: blocked-sender mail renders a visible `[BLOCKING]` prefix so a seat sees at a glance that a colleague/boss is stuck until it replies; everything else is FYI weight. Untrusted-sender risk stays handled by facts-not-directives delivery plus the fail-closed `admitFromNamespaces` drain gate — no steer allowlist, which would defeat founder intent.
- **`bounce` on every terminal failure** (council fix (a), adopted generally): failed routing publishes a best-effort reply-shaped notice back to the original `from` carrying the original `traceId` and reason. No bounce of bounces; unparseable senders get no fabricated destination. Applied to ALL terminal paths including the previously silent `unknown-address`. (Scope since narrowed by the admission-pipeline work and the [durable refusal notice](../bug-fix/2026-08-29-mail-refusal-durable-sender-notice.md): an ADMISSION refusal — registry health, the `test: true` boundary, org topology, sender admission, a loop guard — never stores a bounce, because the bounce would be subject to the very rule that refused the original. Those refusals report on the `mailbox/refused` context bus and log a durable notice into the sender's session instead.)

**Seat-alias roster (composition gap, same change):** the bridge previously assumed every target id derives from the address name — true only for headless named runs. `Config.seatAliases` (default absent) now routes a full grammar-checked address to an EXISTING session id, so web-host seat sessions become steerable/cold-resumable exactly like named ones. Fail-closed: no auto-discovery from preset personas; a chair's composition declares its rows.

Store: SCHEMA_VERSION bumped 1→2 for the new `blocking` column (monotonic, older files reject loud per contract). CLI inbox entries expose `blocking`. The apiproxy `mailbox.publish` wire accepts and forwards `blocking`.

## Alternatives considered

**Sender-declared interrupt intent (`type: 'steer'`).** The interim design had the sender mark a message as interrupting. Superseded by founder revision: all mail steers a live turn, so there is nothing for a sender to declare.

**Busyness inference and type-gated interrupt requests.** Not adopted; transport guarantees immediacy uniformly instead of deciding per message.

**A steer allowlist.** Rejected as defeating founder intent. Untrusted-sender risk is carried by facts-not-directives delivery and the fail-closed `admitFromNamespaces` drain gate instead.

**Auto-discovering seat aliases from preset personas.** Rejected as fail-open: a chair's composition declares its rows.

## Verification

Bridge suite: idle AND busy live seats both assert STEER happened (T1/T2 under revised tests 1–2); boundary-refused steer falls back to queued admission; admission gate unchanged; bounce round-trip with traceId + payload reason (T5); unknown-address bounce generality (T6); no bounce-of-bounce nor bogus addresses for opaque senders. Composition suite: a mid-generation publish STEERED into the running seat within one poll beat (row done at admission), delivered turn attributed + promptness ordering ['user','mailbox'], ZERO bounce rows, zero aborted turns in the persisted transcript (S-2 evidence: dsh's loop already records interrupted turns as `aborted` and surfaces interrupted tools as explicit errors rather than empty successes).

## Consequences

Chair-to-seat dispatch retires queueing entirely (founder transport rule: always-steer). Urgent mail reaches busy seats; routine mail stops paying an interruption tax on strangers' schedules... both true simultaneously because channel uniformity removed timing dependence. Senders who wait now have a protocol hook visible end-to-end. Guest senders can be rejected, but never silently.
