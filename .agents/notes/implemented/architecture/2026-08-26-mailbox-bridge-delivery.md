# Agent Note: Mailbox bridge — steer-first delivery over derived session identity

Status: implemented

English | [中文](2026-08-26-mailbox-bridge-delivery.zh.md)

## Problem

After the seam and the SQLite store landed, queued mail still had no path to an agent: something must resolve `<namespace>:<name>` to a live or dormant session, decide residency honestly across processes, and render the delivery as transcript-visible content attributed to its sender. The opencode prior art delivered by direct injection into any process holding the session, which either steered from outside authority or queued into nothing when the holder died — the failure modes the residency rules exist to prevent.

## Decision

`@deepseek-ai/dsh-mailbox-bridge` is a polling function plugin whose entire exclusivity story is borrowed, not invented:

- Routing adds no second encoding. The name half of a grammar-checked address IS the session name; `deriveNamedSessionId` produces the target id. The roster is explicit config; directory discovery (`discoverPending`) waits on a provider enumeration surface the Service Definition deliberately does not have yet.
- Per Steve's directive, wake latency wins: a live agent is STEERED into its running turn first, degrading to `followup()` only when the boundary refuses. A freshly cold-resumed agent takes the mail as its queued FIFO turn instead — steering would skip reconstructing prior context.
- Residency stays the named-session pid-liveness lock exactly as shipped, with `lockStaleMs` as the optional bounded-takeover escape (`maxAgeMs`) wedged holders need. A lost acquire settles `pending` immediately — the "resident elsewhere" deferral never burns a staleness window waiting. Absent persistence log → `failed 'unknown-address'`, which later becomes the SeatRegistry mint-gate tripwire. `done` settles AT ADMISSION (before quiescence), because admission semantics must not depend on how long the delivered turn runs afterward.
- Delivery rendering lives in one shared module the headless runner reuses, so a queue drained at run start and one drained mid-flight produce byte- identical turns: subject + payload text under a merged `{ kind: 'mailbox', form: 'relay' }` source. The headless side exposes it as `--mailbox-namespace`, draining a fixed-bounds backlog before the task so the task remains the last message of the last turn.

## Alternatives considered

Rejected: pushing deliveries through session internals or synthetic events (model-visible ⟺ logged violation); per-address provider routing and push notification (no second consumer yet); making the poll timer keep hosts alive (an unref'd drain loop means mailbox deployments hold themselves up via their real long-lived handles).

## Verification

Unit suites cover spec validation, rendering edges, every routing outcome (live-idle / live-running / steer-refused, dormant-resume with lock release proof, unknown-address, deferral under a held residency lock, poison-message isolation) against the REAL registry + SQLite provider with stubbed residency. Composition specs boot real Loader trees with only the model scripted: a two-phase flow proves a dormant named session resumes and receives its mail (with source attribution and store state settled done), and the served-address hook admits backlog ahead of the task turn in a single shipping boot.

## Consequences

Named agents become deliverable targets end-to-end within one machine: publish mail to `<ns>:<name>`, and the next bridge cycle wakes or queues the recipient honestly across processes. The unknown-address failure gives Phase 2's SeatRegistry a loud tripwire for minting governance. Cross-process duplicate delivery remains possible in crash windows (at-least-once by contract); the bridge introduces no new duplication beyond what stale reclaim already allows.
