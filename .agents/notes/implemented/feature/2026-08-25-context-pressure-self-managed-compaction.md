# Agent Note: Context-pressure warnings and model-invoked deferred compaction

Status: implemented

English | [中文](2026-08-25-context-pressure-self-managed-compaction.zh.md)

## Problem

The model cannot see its own context-window pressure. Compaction fired automatically at a backend-only threshold (`compaction-basic`, then 0.8 of the window) with nothing model-visible announcing usage, so the model could not plan token spend, schedule heavy work against remaining budget, or choose when conversation history should condense. Humans had `/compact`; the model had no equivalent and no signal.

## Decision

Two opt-in plugins give the model both the signal and the actuator:

- [`@deepseek-ai/dsh-context-pressure`](../../../../packages/context/context-pressure/README.md) listens on `agent/pre-step`, measures usage through `ctx.tokenMeter`, and when measured totals cross a threshold of the routed model's window, appends one plugin-sourced user message stating percent used, total tokens, and remaining tokens. Thresholds default to `[0.25, 0.5, 0.75]`, are validated ascending/unique/in (0,1), and fail loud at load. One warning fires per threshold per compaction generation; all thresholds re-arm when a newer `compaction/end` lands; warned-state is derived from log scan so restarts do not re-warn. No new `SessionEventMap` events exist: the warning is an ordinary durable `user/message` with a plugin source, satisfying model-visible⟺logged through the time-context pattern.
- [`@deepseek-ai/dsh-tool-compact`](../../../../packages/compaction/tool-compact/README.md) registers an argument-free `compact` tool. A call arms process-local pending state and returns immediately; when the agent next goes idle, the runner consumes the arm and calls `ctx.compaction.compactNow()` inside the engine's existing maintenance claim and `compaction/start` lock. A waking send that wins the boundary surfaces as `ManualCompactionError('busy')` and re-arms the schedule for the next boundary. This deliberately reverses the human-command-only policy previously documented in [command-compact](../../../../packages/compaction/command-compact/README.md); compaction now has two Consumers — the human `/compact` command (immediate) and the model `compact` tool (deferred to idle).

`compaction-basic`'s `DEFAULT_THRESHOLD_RATIO` moved 0.8 → 0.95: threshold warnings own early planning, 95% is the hard backstop, and the provider-confirmed overflow-retry path remains the last resort.

The design extends the admission rules owned by [queued manual compaction](2026-07-30-queued-manual-compaction.md): the tool adds no second queue and no extra mutex, and wakes-prompt FIFO right-of-way still wins every boundary race.

## Alternatives considered

- **New `SessionEventMap` events for warnings and admissions.** Rejected: `SurfaceEventType` is a closed union, so new event kinds require core/session, token-meter folding, and deriveMessages changes, while duplicating facts the durable user message already carries — two homes for one fact. The plugin-sourced message is reconstructable and version-stable with zero format change.
- **Compacting synchronously inside the tool call.** Rejected: `compactNow` throws busy by construction mid-step, and mutating the message surface under a live turn fights the loop's ownership of the entering request.
- **A second admission queue for model requests.** Rejected: prompts outrank direct control, so a queue parallel to the inbox re-creates the priority inversion the queued-compaction decision settled; deferring through the ordinary idle claim keeps one FIFO.
- **Keeping the automatic flush at 0.8.** Declined by the product owner: with warnings planning from 25%, an 80% forced flush leaves the model no room to act on its own scheduling; 95% restores that room while overflow-retry bounds the tail risk.

## Consequences

Gained: the model sees real budget numbers and can order work against them; warning text costs roughly sixty tokens once per threshold per generation and stays byte-stable for KV reuse. Cost: an armed schedule lives only in process memory, so a crash drops it and the model re-calls after observing no checkpoint; the band between the last warning and the forced flush is config, not code, and operators who preferred silent 0.8 behavior must pin `thresholdRatio` explicitly. Recorded gotcha: schemastery materializes an omitted array config as `[]` at schema creation, so array-valued defaults must be declared with `.default([...])` on the schema field itself or they never apply.

## Testing

`context-pressure`'s Loader-composition spec drives the shipping agent loop past a threshold and pins the warning text verbatim, asserts single-fire dedup across turns, and proves model-visible presence through `deriveMessages()`. `tool-compact`'s suite covers schedule → idle-run, sync and async busy re-arm, disposal quiescence including dispose-after-re-arm (mutation-checked), and its invariant companion. The `jsonrpc-agent` example composes both plugins; its keyless smoke asserts the assembled tool list and its snapshot scenarios replay clean.
