# @deepseek-ai/dsh-tool-compact

English | [中文](README.zh.md)

A model-callable `compact` tool that defers real compaction to the next agent idle boundary over [`ctx.compaction`](../compaction/README.md). Scheduling is process-local admission state; the durable work runs through [`Agent.runMaintenance`](../../core/agent/README.md) inside the engine's existing idle claim and `compaction/start` lock, so this plugin adds no second queue and no extra mutex. The [queued manual compaction Agent Note](../../../.agents/notes/implemented/feature/2026-07-30-queued-manual-compaction.md) owns those admission decisions; this tool is a deliberate model-facing reversal of the human-command-only policy recorded in [command-compact](../command-compact/README.md).

## Tool contract

| Call | Result |
|---|---|
| `compact` with no arguments | `Compaction scheduled; it runs when this turn ends.` — the schedule is armed and the call returns immediately. |
| Second call while a schedule is pending | `Compaction was already scheduled; it runs when this turn ends.` — idempotent per agent while armed. |
| Call from a non-agent caller | Error result: `compact requires an owning agent session`. |

When the owning agent's status becomes `idle`, the runner consumes the armed schedule synchronously and calls `compactNow(agent, signal)` directly. The engine performs the one idle-phase claim itself; a waking send that wins the boundary surfaces as `ManualCompactionError('busy')`, and the runner re-arms the original schedule so it retries at the next idle boundary, preserving the prompt's FIFO right of way. A scheduling signal that aborts before the boundary drops the schedule as cancelled. Every other failure — including the expected `changed`, `summary`, `commit`, and `persistence` codes — settles without rethrowing: the engine's bracket is already durable in the log, and the runner records a warning in the process log.

The pending set and settlement journal are per-process module state keyed weakly by agent. Plugin disposal removes the status listener and discards still-armed schedules, so a remounted fiber never dedupes against a schedule nothing would run.

## Composition

Mount the tools registry, one compaction backend, and this plugin:

```yaml
- id: system-prompt
  name: '@deepseek-ai/dsh-system-prompt'
- id: tools
  name: '@deepseek-ai/dsh-tools'
- id: compaction-basic
  name: '@deepseek-ai/dsh-compaction-basic'
- id: tool-compact
  name: '@deepseek-ai/dsh-tool-compact'
```

The producer injects `tools` and `compaction`.

## Model Experience

### Idle-deferred `compact` control

#### What the model sees

One argument-free `compact` call joins prompt assembly and returns the immediate acknowledgment `Compaction scheduled; it runs when this turn ends.`; later — after the deferred run succeeds — the backend's user-role checkpoint replaces the selected span in derived model history. The result text names the deferral so the model does not expect the condensation inside the current turn.

#### Token effect

Scheduling adds one short tool result to the current conversation. A successful deferred run reduces later requests by replacing the selected span with one framed summary; summarization itself is one auxiliary request at the idle boundary.

#### KV Cache effect

Scheduling invalidates nothing. The accepted surface replacement invalidates reuse from the first shadowed history token.

## Known Limitations and Deferred Work

- **In-memory schedule** — the armed schedule survives only in the current process; a crash drops it, and the model naturally re-calls after observing that no checkpoint appeared despite its accepted result.
- **Idle-boundary latency** — compaction starts only when the agent next goes idle; a continuously busy agent keeps re-arming after each `busy` loss instead of running inline.
- **Single backend target** — the deferral always targets whichever `ctx.compaction` engine is composed; no range or policy arguments exist, unlike the programmatic `compactRegion()` path.
