# Agent Note: A user-pinned title clears session blank

Status: implemented

English | [中文](2026-08-26-user-pinned-title-clears-blank.zh.md)

## Problem

`SessionSummary.blank` derived from a single fact: no `turn/start` in the log. Sessions created programmatically and named before their first turn — agent-created named seats in the dsh web GUI, the standing workflow for persistent council seats — stayed `blank: true`. Every client hid such sessions from lists and could hand out the row again as the workspace's provisional New Session target, so a seat that had been created and renamed remained invisible until something prompted it. The hiding rule itself ("blank is a placeholder") was correct; the existence test behind it was too narrow.

## Decision

A user-source `session/title` event now proves existence alongside `turn/start`. One predicate drives all three derivations that previously duplicated the turn check: the attached-summary log fold, the incremental `sessionListMetadata` projection, and the cold small-artifact probe. Automatic titles (built-in fallback or provider) keep not clearing blank — metadata chatter must not flip visibility; only an explicit human rename asserts identity.

Side effect, accepted deliberately: `agentPreset.select` locks at rename rather than first turn, because it reuses the same predicate. A title event carries no tool history, so the lock is conservative, not correctness-preserving; a named seat is committed to its composition from naming onward.

## Alternatives considered

**Client-side carve-out: show blank rows that carry a cached title projection.** Rejected: every surface (list, search, New Session reuse, fork trees) would re-derive the rule, and cold rows lack cached titles entirely until a checkpoint persists one — exactly the just-renamed case the fix exists for.

**A second server bit (`titled`) beside `blank`.** Rejected: two bits answering one question ("is this session real yet?") ripples through the wire schema, the projection cache, and every client predicate, with the invariant "never both" enforced by convention instead of by construction.

## Consequences

Named seats become visible in every client the moment they are renamed, before any turn runs; New Session reuse naturally skips them because they stopped being blank; content search admits them once titled. Untouched deployments see no change: sessions nobody renames keep the old behavior, and the bounded cold-probe cost grows only by logs whose events are already small enough to read.

## Related

[The bounded cold blank verification](../bug-fix/2026-08-13-bounded-cold-blank-verification.md) owns the cold-probe eligibility threshold and safety direction; the exact fold that probe runs now carries the user-title clause decided here.
