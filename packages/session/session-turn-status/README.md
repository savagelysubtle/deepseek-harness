# @deepseek-ai/dsh-session-turn-status

English | [中文](README.zh.md)

Function plugin registering the `turnStatus` projection unit: a pure fold of `turn/start`/`turn/end` boundaries into whether a session's latest turn is still open and, once it is not, which cause closed the last one — a deliberate user stop, a programmatic cancellation (and which sub-cause), a crash-recovered interruption, an error, completion, or a few narrower outcomes. Served through the session-projection seam (registry snapshot, change feed, and every projection carrier: history tail page, `session/projection` push frames, session-list rows), so a session-list row and a future watchdog can read the distinction without replaying the log or reopening the crash-vs-stop question this package exists to close (SWD-120).

## Fold semantics

- `open` is `true` from `turn/start` until the matching `turn/end`. It is the load-bearing bit: a process that crashes mid-turn leaves a durable `turn/start` with no `turn/end` until the session next loads (crash repair runs at load time, in `dsh-session`'s `interruptedTurnClosers`, not at crash time), so a crashed-but-not-yet-reloaded session folds to `open: true` here — the same shape as an actively executing turn. This unit reports exactly what the log contains; it is the session-list row's independent `running` bit (agent attachment) that tells the two apart. `open: true` with `running: false` is the crash signal — a caller must read both fields.
- `cause` is `null` before the session's first closed turn, and — deliberately — while `open` is `true`: a prior turn's cause must never read as describing a turn that has not finished yet.
- `cause.kind === 'aborted'` covers every cancellation, with `cause.cause.kind` naming who: `'user'` for a deliberate stop, `'parent'` / `'hook'` / `'disposed'` / `'legacy'` for every programmatic cancellation, mirroring the durable `TurnEndCancelCause` one-to-one.
- `cause.kind === 'interrupted'` is a turn a crash-repair reload closed after the fact; the events recorded before the crash remain intact, only the boundary is synthetic.
- An arm this unit does not yet recognize (`TurnEndReasonMap` is merge-extensible) degrades to `cause.kind === 'other'` rather than throwing, the same fail-soft rule `dsh-session-query` already applies to unknown turn-end reasons.

## Composition

```yaml
- id: session-turn-status
  name: '@deepseek-ai/dsh-session-turn-status'
```

Injects `sessionProjections` — the plugin's whole purpose; in assemblies without the registry the fiber stays pending and nothing registers.

## Model Experience

None, as the plugin only computes a client-facing read model — whether the session's latest turn is open, and if not, whether it stopped, crashed, errored, or completed — from already-logged session events and touches no prompt, message, schema, stream, or tool result.

#### KV Cache effect

None; the plugin never assembles or sends provider requests.

## Known Limitations and Deferred Work

- **A crashed session reports `open: true`, not `interrupted`, until it is reloaded** — crash repair runs at load time (`interruptedTurnClosers` in dsh-session), so between the crash and the next load this unit cannot distinguish "still executing" from "orphaned by a dead process" on its own; a consumer must cross-reference the session-list row's `running` bit (or an equivalent liveness fact) to tell them apart. This is a documented consequence of folding the log honestly, not a bug to fix here.
- **`cause` only ever reflects the MOST RECENTLY closed turn** — earlier turns' causes are not retained; a consumer that needs full history reads the log directly.
- **Cold sessions need `dsh-session-projection-cache` composed to serve this key without a log read** — an assembly with the registry but not the cache still folds correctly for attached sessions; a cold row's `session.list` projection column is then absent until that cache is also composed.
