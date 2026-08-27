# Agent Note: Subagent route visibility via one-shot descriptor v3

Status: implemented

English | [中文](2026-08-26-subagent-descriptor-route-visibility.zh.md)

## Problem

Extends the durable-catalog decision ([2026-07-22-durable-subagent-catalog-and-list-agents](../feature/2026-07-22-durable-subagent-catalog-and-list-agents.md)) and the identity projection it introduced ([2026-08-06-subagent-list-identity-projection](2026-08-06-subagent-list-identity-projection.md)); neither is superseded. Audited gap: `listChildren()` rosters carried mode/label/timing but never WHICH model a child ran on — one-shot descriptors did not even record it (see `interagentstuff/plans/background-lifetime-findings-2026-08-26.md` §2.6), so per-dispatch model attribution was impossible for one-shot children and unexposed for continuable ones.

## Decision

Deliberate descriptor version bump v2→v3 adds optional `agentProvider`/`agentModel` to the ONE-SHOT arm, resolved like the continuable arm already resolved them (declared override else parent's route) at the single `start()` snapshot site. The identity projection carries both optional route fields on either arm (schema + `stateVersion` bumped together so stale checkpoints refold), enumeration rows pass them through, and three read surfaces consume the data verbatim — `list_agents` renders ` model=<provider>/<model>`, the browser catalog shows `provider/model` before the mode, and the api-proxy wire row gains the optional fields. Unknown-key strictness and first-event-wins folding are untouched; older logs simply render route-less. Effort levels were explicitly out of scope: nothing in-tree persists one. Token-usage attribution remains deferred (usage chunks live in child logs, needing their own projection decision).

## Alternatives considered

- Projecting provider/model from a separate session event rather than extending the descriptor — rejected: the descriptor already owns declared child composition, and a second source would need its own reset/fold story for fork seeds.
- Always-required route fields with a v4-style hard break — rejected: routes are genuinely optional today (minimal agents without options exist); optionality keeps old logs classifiable.
- Token-usage projection in this change — deferred: usage chunks require a new unit design; mixing it into the version bump would grow the blast radius of an otherwise additive change.

## Consequences

Every enumerated child row names its model when the recording descriptor carries one; Steve's named-escalation policy becomes auditable per dispatch at the roster level.

Verification rides the extended service/list/control suites plus a real-spawn assertion pinning the rendered route end-to-end (`model=mock/mock`).
