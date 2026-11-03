# Workflow

English | [中文](workflow.zh.md)

The workflow seam lets an agent run a model-written orchestration SCRIPT that starts subagents. Like [subagent](subagent.md) it is **one optional capability**, not part of the agent loop, so its types and operations live here rather than in [core.md](core.md). Like bash, it permits ONE engine implementation per context to provide `ctx.workflowEngine`; there is no named-provider registry (a second engine replaces the first through plugin configuration rather than running beside it).

Service Definition: [dsh-workflow](../../packages/workflow/workflow) (`ctx.workflowEngine` + the vocabulary below). The Service Provider is [dsh-workflow-worker-thread](../../packages/workflow/workflow-worker-thread) (a `node:worker_threads` engine — one worker per run, the script's vm context inside it); the model-facing Consumer is [dsh-tool-workflow](../../packages/workflow/tool-workflow). The proposal and rationale: [the dynamic-workflows Agent Note](../../.agents/notes/implemented/feature/2026-07-05-dynamic-workflows.md).

Sources: browser-safe vocabulary in [`packages/workflow/workflow/src/types.ts`](../../packages/workflow/workflow/src/types.ts), Host request and live-run handles in [`runtime-types.ts`](../../packages/workflow/workflow/src/runtime-types.ts).

## The start request

What a caller asks for when starting a run. The ordinary workflow tool builds this from the model's `{ script, meta, args }` call plus the calling agent; specialized consumers may also select one engine-wide `subagentProvider` and lower `maxTotalAgents` for the run, but the script cannot observe or replace either policy. `meta` and `args` are plain JSON DATA (the engine validates `meta` against its schema and rejects loud BEFORE anything runs — no script text is ever evaluated to obtain it). `parent` is REQUIRED — every child the script starts is attributed to it, and cwd, lineage, and depth pass through the [subagent seam](subagent.md).

```ts type-equiv
/**
 * What a caller asks for when starting a workflow run. `meta` and `args` are
 * plain JSON data by the seam contract. `parent` is required because every
 * `agent()` spawned by the script is attributed to that live Agent.
 */
interface WorkflowStartRequest {
  /** The plain-JS script body (top-level await allowed; ends with `return <json-value>`). */
  script: string
  /** The workflow's identity block, as plain JSON data (shape-validated by the engine). */
  meta: WorkflowMeta
  /** Optional input exposed verbatim to the script as the `args` global. */
  args?: unknown
  /** Optional engine-wide child-provider override for this run. */
  subagentProvider?: string
  /** Optional per-run total-child ceiling. */
  maxTotalAgents?: number
  /** The agent on whose behalf the run executes (parent of every child). */
  parent: Agent
  /** Cancels the run when aborted. */
  signal?: AbortSignal
  /**
   * Workspace root: `bash()` working directories resolve (realpath) and must
   * stay under it. Defaults to the host process cwd.
   */
  cwd?: string
  /**
   * Decides `approve()` questions. Absent means every `approve()` answers
   * `'unavailable'` (fail closed); the engine never prompts by itself.
   */
  approver?: WorkflowApprover
  /**
   * Turns on the `bash()` hook and the `agent()` `doneWhen` option for this run. Off by default:
   * both run host-side commands, so only an owner that vouches for the script (a compiled,
   * trusted workflow) enables them.
   */
  bashEnabled?: boolean
  /** Overrides the built-in local bash executor (e.g. a sandboxed one). */
  bashExecutor?: WorkflowBashExecutor
  /** Receives every `bash()` output chunk (the full streams) so the caller can spill what the in-memory cap dropped. */
  onBashOutput?: (info: { nodeId?: string }, stream: 'stdout' | 'stderr', chunk: Uint8Array) => void
  /** Tier label to model id, used for an `agent()` call that gives a `tier` but no `model`. */
  tierModels?: Readonly<Record<string, string>>
  /**
   * The compiled workflow's declared gates. The engine owes one `workflow/gate` per entry on every
   * terminal path: a node that never started reports `not-reached`.
   */
  gateManifest?: readonly { nodeId: string; gateKind: string }[]
  /** Supervises `agent()` children: stall watchdog and done-when continuation (see {@link WorkflowChildSupervisor}). */
  supervisor?: WorkflowChildSupervisor
}
```

## The workflow's identity: `WorkflowMeta`

The identity block carried as data on the start request (the tool's `meta` parameter; the field vocabulary matches the Claude Code dynamic-workflows meta block). `phases` is progress vocabulary only: `phase()` calls match titles for observers; no execution structure is implied.

```ts type-equiv
/**
 * The script's identity block, provided as plain JSON data alongside the
 * script body (the model-facing tool carries it as its `meta` parameter) and
 * validated by the engine before the body runs. `name`/`description` are
 * required; the rest is optional annotation. The field vocabulary matches the
 * Claude Code dynamic-workflows meta block.
 */
interface WorkflowMeta {
  /** Short kebab-case workflow name (display + persistence key). */
  name: string
  /** One-line description of what the workflow does. */
  description: string
  /** Optional guidance on when this workflow applies (shown in listings). */
  whenToUse?: string
  /** Optional phase declarations matched by `phase()` calls. */
  phases?: WorkflowPhase[]
}
```

## The terminal result: `WorkflowResult`

The outcome of one run, resolved by `WorkflowRun.result`. `value` is the script's materialized return value — plain host-realm JSON data (`null` when the script returned nothing) — meaningful only for `completed`. `stopReason` is a CLOSED union (engine-owned; consumers may exhaust it): `completed` | `cancelled` | `error`. A non-`completed` reason carries the failure in `error`, and the consumer maps it to an `isError` tool result rather than reporting partial output as success.

```ts type-equiv
/**
 * The outcome resolved by a live workflow run. `value` is
 * the script's materialized return value (plain host-realm JSON data; `null`
 * when the script returned `undefined`) — meaningful only for `completed`.
 * A non-`completed` reason carries the failure in `error`; the consumer maps
 * it to an `isError` tool result rather than reporting partial output.
 */
interface WorkflowResult {
  /** The script's return value (host JSON data; `null` for no return). */
  value: unknown
  /** Why the run settled. */
  stopReason: WorkflowStopReason
  /** The failure message (present iff `stopReason` is not `completed`). */
  error?: string
  /**
   * How many `agent()` calls the run accepted over its whole lifetime. On a
   * graceful settlement this is the script-side count (calls still queued for
   * a concurrency slot included); on a termination path (grace force-settle,
   * worker death) it degrades to the host-observed count — calls queued
   * inside a terminated script are unknowable then.
   */
  agentsStarted: number
}
```

## A live run: `WorkflowRun`

The handle the consumer holds while a script executes. The consumer awaits `result`, may `cancel` mid-flight, and MUST `dispose` on every path. `result` does NOT reject — a script failure resolves with `stopReason: 'error'` — and once the run is cancelled it SETTLES within the engine's bounded grace even if the script itself never settles (the engine force-settles `cancelled`; the worker-thread engine then terminates the script's worker), so a consumer awaiting `result` is never wedged past a cancellation. `dispose()` = cancel + that bounded settle + child quiescence; it never hangs on a stuck script.

```ts type-equiv
/**
 * Holder-owned live workflow. `result` never rejects; consumers may cancel
 * and must call idempotent `dispose()` to await script and child quiescence.
 */
interface WorkflowRun {
  readonly id: WorkflowRunId
  /** The validated meta block available before the script body runs. */
  readonly meta: WorkflowMeta
  readonly result: Promise<WorkflowResult>
  /** Cancel the run and its children. */
  cancel(reason?: string): void
  /** Approvals currently awaiting a decision (engines without `approve()` support omit this). */
  pendingApprovals?(): readonly WorkflowPendingApproval[]
  /**
   * Decide a pending approval from outside the injected approver (a UI path).
   * First decision wins by a single synchronous compare-and-set; the id is
   * compared in constant time. A second call answers `already-decided`.
   */
  decideApproval?(approvalId: string, outcome: WorkflowApprovalOutcome): WorkflowApprovalDecision
  /** Cancel if needed and await bounded settlement and cleanup. */
  dispose(): Promise<void>
}
```

## Failure discipline: `WorkflowError.fatal`

Hook misuse inside a script — bad arguments, unknown/deferred `agent()` options, a schema outside the [structured-output subset](../../packages/core/tools/README.md), a tripped cap, a seam start failure, cancellation — throws a `WorkflowError` with `fatal: true`. The `parallel()`/`pipeline()` combinators RE-THROW fatal errors instead of mapping the item to `null`: a typo'd option must kill the script loudly, never dissolve into something that reads as an ordinary child failure. The per-item `null` is reserved for child-run failures (a non-`completed` stop reason) and ordinary in-stage script errors.

## Events

The `workflow/*` events (`workflow/start`, `workflow/phase`, `workflow/log`, `workflow/agent-start`, `workflow/agent-end`, `workflow/end` — see the [events catalog](#cordis-surface)) are **observe-only** emits carrying DATA SNAPSHOTS: every payload starts with `WorkflowRunInfo` (id + meta), never the live `WorkflowRun`, so a subscriber cannot gain `cancel`/`dispose`, and `workflow/end` deliberately omits the result value (a listener observing outcomes must not receive a mutable alias of the caller's result). Every emit is per-listener contained — a throwing subscriber is logged, never propagated, and cannot starve the listeners registered after it — and every listener receives its own payload clone, so mutating it corrupts neither the engine nor other listeners; the containment mirrors `subagent/start`/`subagent/end`.

## Durable Chat records

The top-level `dsh-tool-workflow` consumer projects display facts into its calling parent Session without changing execution ownership. It writes `tool-workflow/run-start` after a run is accepted, pairs member start and end by `runId + seq`, and writes `tool-workflow/run-end` only after the result is known and disposal reaches quiescence. Nested transport calls write no record. The first append failure disables later writes for that run, so the log remains empty or a legal continuous prefix and the tool result is unchanged.

`dsh-tool-workflow/invariant` validates the same protocol before live commit and when a Session is loaded: one start per run, positive unique member sequences, paired member endings, no run ending with open members, and no updates after the run ending. A missing member ending or run ending at the log tail is valid interruption evidence rather than corruption.

`dsh-client-ui-workflow-run` folds the four events through the Conversation Node engine into one `workflow-run` Chat node anchored at the run-start sequence, after the original workflow tool node. Phase groups come only from actual member starts and preserve exact strings, including the distinction between an omitted phase and `''`. Closed Locations turn missing terminal facts into interrupted presentation. The [UI package README](../../packages/client/ui-workflow-run/README.md) owns disclosure, status, and same-parent local navigation behavior.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxworkflowengine--workflowengine-abstract-seam"></a>

### `ctx.workflowEngine` — `WorkflowEngine` (abstract seam)

Workflow Service Definition contract. Invalid requests throw before publication; a live run is holder-owned, its result never rejects, cancellation and disposal are bounded, and disposal waits for child cleanup within that bound. Lifecycle listener failures are contained, and `workflow/end` fires exactly once as the result settles.

```ts cordis-catalog
/**
 * Parse and execute a workflow script.
 * @param request - the script, its `args`, the parent agent, and an
 *   optional cancel signal.
 * @returns the live run; its `result` resolves when the script settles.
 */
abstract start(request: WorkflowStartRequest): WorkflowRun
```

Source: [`packages/workflow/workflow/src/index.ts:170`](../../packages/workflow/workflow/src/index.ts)

<a id="ctxworkflowruns--workflowrunsservice"></a>

### `ctx.workflowRuns` — `WorkflowRunsService`

The workflow runner service. See the module comment.

```ts cordis-catalog
/**
 * Subscribe to run and approval changes.
 * @param listener - called synchronously with each event; a throw is contained.
 * @returns the unsubscribe function.
 */
subscribe(listener: (event: WorkflowRunsEvent) => void): () => void

/**
 * Declare that a human who can answer approvals is attached (the Workflows UI is open).
 * While at least one attachment is held, an approval waits for an answer instead of being
 * rejected at once; with none, an approval nobody can answer fails closed. Attaching is an
 * explicit act, never inferred from {@link WorkflowRunsService.subscribe}.
 * @returns the disposer that withdraws this attachment; calling it again does nothing.
 */
attachUi(): () => void

/**
 * The run store of a workspace: one handle per workspace per process.
 * @param workspace - a workspace path; resolved through `realpath`.
 * @returns the shared store handle, narrowed to its read methods (writes go through this service).
 */
async storeFor(workspace: string): Promise<WorkflowStoreReader>

/**
 * Workflows present in a workspace's workflows directory.
 * @param workspace - the workspace path.
 * @returns the sorted names.
 */
async listWorkflows(workspace: string): Promise<string[]>

/**
 * One run's stored detail with its pin facts.
 * @param workspace - the workspace path.
 * @param runId - the run.
 * @returns the detail, the pinned hash and whether the live file changed.
 */
async getRunView(workspace: string, runId: string): Promise<RunView>

/**
 * Approvals waiting for an answer in this process.
 * @param runId - restrict to one run.
 * @returns the waiting approvals.
 */
pendingApprovals(runId?: string): PendingApprovalView[]

/**
 * Answer a waiting approval (the UI path).
 * @param runId - the run.
 * @param approvalId - the store approval id.
 * @param answer - allow or reject.
 * @param reason - optional human reason, recorded.
 * @returns the winning state, or undefined when nothing is waiting under that id here.
 */
async answerApproval(runId: string, approvalId: string, answer: BrokerAnswer, reason?: string): Promise<string | undefined>

/**
 * The runs this process is executing now.
 * @returns run id, name, hash, workspace realpath and parent session id of each.
 */
activeRuns(): { runId: string; name: string; hash: string; workspace: string; sessionId: string }[]

/**
 * The workspace-relative directory that holds workflow files.
 * @returns the configured directory, default `.workflows`.
 */
workflowsDir(): string

/**
 * Cancel a run owned by this process, if it belongs to the caller's workspace (and session).
 * A run outside the scope answers exactly like a run that does not exist.
 * @param runId - the run.
 * @param reason - why, recorded on the run.
 * @param scope - the caller's workspace, and optionally its session.
 * @returns whether this process owns a matching run, with its eventual outcome.
 */
async cancel(runId: string, reason: string, scope: CancelScope): Promise<{ found: boolean; outcome?: RunOutcome }>

/**
 * Describe a workflow without running anything: the DAG, the gate manifest and the trust facts.
 * No store is opened and no process or agent is started.
 * @param workspace - the workspace path.
 * @param options - which workflow; `caller` (the calling session id) asks for a trust challenge.
 * @returns the plan, or why none could be made.
 */
async dryRun(workspace: string, options: DryRunOptions): Promise<DryRunPlan | StartRefused>

/**
 * Start (or resume) a workflow run.
 * @param options - which workflow, its inputs, the parent agent and the trust confirmation.
 * @returns a started run whose `done` settles when the record is closed, or why the start was refused.
 */
async start(options: StartOptions): Promise<StartResult>
```

Source: [`packages/workflow/tool-workflow-run/src/runner.ts:213`](../../packages/workflow/tool-workflow-run/src/runner.ts)

<a id="workflow-events"></a>

### `workflow/*` events

<a id="workflowagent-end--emit"></a>

#### `workflow/agent-end` — emit

One `agent()` call settled (clean result, child failure, or run cancellation). Paired with Events['workflow/agent-start'] by `agent.seq`, exactly once per started call on every stop path — on an engine termination path (a worker killed past its grace) the end is engine-synthesized with outcome `'cancelled'`.

```ts cordis-catalog
/**
 * One `agent()` call settled (clean result, child failure, or run
 * cancellation). Paired with {@link Events['workflow/agent-start']} by
 * `agent.seq`, exactly once per started call on every stop path — on an
 * engine termination path (a worker killed past its grace) the end is
 * engine-synthesized with outcome `'cancelled'`.
 * @param info - the run's identity snapshot.
 * @param agent - the call identity plus its outcome.
 * @mode emit
 */
'workflow/agent-end'(info: WorkflowRunInfo, agent: WorkflowAgentEndInfo): void
```

Source: [`packages/workflow/workflow/src/index.ts:110`](../../packages/workflow/workflow/src/index.ts)

<a id="workflowagent-start--emit"></a>

#### `workflow/agent-start` — emit

One `agent()` call established a published child run. Paired with Events['workflow/agent-end'] by `agent.seq`. A call that never receives a published run from the provider emits neither event in this pair.

```ts cordis-catalog
/**
 * One `agent()` call established a published child run. Paired with
 * {@link Events['workflow/agent-end']} by `agent.seq`. A call that never
 * receives a published run from the provider emits neither
 * event in this pair.
 * @param info - the run's identity snapshot.
 * @param agent - the call's sequence number, label, phase, and child id.
 * @mode emit
 */
'workflow/agent-start'(info: WorkflowRunInfo, agent: WorkflowAgentInfo): void
```

Source: [`packages/workflow/workflow/src/index.ts:99`](../../packages/workflow/workflow/src/index.ts)

<a id="workflowapproval-decided--emit"></a>

#### `workflow/approval-decided` — emit

An approval left the pending state.

```ts cordis-catalog
/**
 * An approval left the pending state.
 * @param decision - the run and approval ids and the state it ended in.
 * @mode emit
 */
'workflow/approval-decided'(decision: WorkflowApprovalDecided): void
```

Source: [`packages/workflow/workflow-remote/src/wire.ts:827`](../../packages/workflow/workflow-remote/src/wire.ts)

<a id="workflowapproval-pending--emit"></a>

#### `workflow/approval-pending` — emit

An approval node is waiting for a human answer.

```ts cordis-catalog
/**
 * An approval node is waiting for a human answer.
 * @param approval - the run, approval and node ids; the question is read with `pendingApprovals`.
 * @mode emit
 */
'workflow/approval-pending'(approval: WorkflowApprovalPending): void
```

Source: [`packages/workflow/workflow-remote/src/wire.ts:821`](../../packages/workflow/workflow-remote/src/wire.ts)

<a id="workflowend--emit"></a>

#### `workflow/end` — emit

A workflow run settled (any stop reason). Fired when WorkflowRun.result resolves. Paired with Events['workflow/start'].

```ts cordis-catalog
/**
 * A workflow run settled (any stop reason). Fired when
 * {@link WorkflowRun.result} resolves. Paired with
 * {@link Events['workflow/start']}.
 * @param info - the run's identity snapshot.
 * @param result - the outcome data (stop reason, error, agent count) —
 *   deliberately WITHOUT the result value (see {@link WorkflowResultInfo}).
 * @mode emit
 */
'workflow/end'(info: WorkflowRunInfo, result: WorkflowResultInfo): void
```

Source: [`packages/workflow/workflow/src/index.ts:120`](../../packages/workflow/workflow/src/index.ts)

<a id="workflowgate--emit"></a>

#### `workflow/gate` — emit

A declared gate was evaluated. Exactly one per gate-declaring node on every terminal path: the script's own, or host-synthesized (`not-reached` for a stranded node, `never-evaluated` for one that ended without evaluating its gate).

```ts cordis-catalog
/**
 * A declared gate was evaluated. Exactly one per gate-declaring node on
 * every terminal path: the script's own, or host-synthesized
 * (`not-reached` for a stranded node, `never-evaluated` for one that
 * ended without evaluating its gate).
 * @param info - the run's identity snapshot.
 * @param gate - the node, gate kind and outcome.
 * @mode emit
 */
'workflow/gate'(info: WorkflowRunInfo, gate: WorkflowGateInfo): void
```

Source: [`packages/workflow/workflow/src/index.ts:147`](../../packages/workflow/workflow/src/index.ts)

<a id="workflowlog--emit"></a>

#### `workflow/log` — emit

The script emitted a narration line (a `log(message)` call).

```ts cordis-catalog
/**
 * The script emitted a narration line (a `log(message)` call).
 * @param info - the run's identity snapshot.
 * @param message - the logged message, verbatim.
 * @mode emit
 */
'workflow/log'(info: WorkflowRunInfo, message: string): void
```

Source: [`packages/workflow/workflow/src/index.ts:89`](../../packages/workflow/workflow/src/index.ts)

<a id="workflownode-end--emit"></a>

#### `workflow/node-end` — emit

A workflow node settled. Exactly one end per started node on every terminal path: the script's own, or a host-synthesized one (`synthesized: true`, status `cancelled` after cancel else `interrupted`).

```ts cordis-catalog
/**
 * A workflow node settled. Exactly one end per started node on every
 * terminal path: the script's own, or a host-synthesized one
 * (`synthesized: true`, status `cancelled` after cancel else `interrupted`).
 * @param info - the run's identity snapshot.
 * @param node - the node identity plus its status.
 * @mode emit
 */
'workflow/node-end'(info: WorkflowRunInfo, node: WorkflowNodeEndInfo): void
```

Source: [`packages/workflow/workflow/src/index.ts:137`](../../packages/workflow/workflow/src/index.ts)

<a id="workflownode-start--emit"></a>

#### `workflow/node-start` — emit

A workflow node started (the script's `nodeStart` hook). Paired with Events['workflow/node-end'] by `node.nodeId`.

```ts cordis-catalog
/**
 * A workflow node started (the script's `nodeStart` hook). Paired with
 * {@link Events['workflow/node-end']} by `node.nodeId`.
 * @param info - the run's identity snapshot.
 * @param node - the node id, kind and declared gate kind.
 * @mode emit
 */
'workflow/node-start'(info: WorkflowRunInfo, node: WorkflowNodeInfo): void
```

Source: [`packages/workflow/workflow/src/index.ts:128`](../../packages/workflow/workflow/src/index.ts)

<a id="workflowphase--emit"></a>

#### `workflow/phase` — emit

The script entered a phase (a `phase(title)` call) — progress grouping for observers; no execution semantics.

```ts cordis-catalog
/**
 * The script entered a phase (a `phase(title)` call) — progress grouping
 * for observers; no execution semantics.
 * @param info - the run's identity snapshot.
 * @param title - the phase title, verbatim.
 * @mode emit
 */
'workflow/phase'(info: WorkflowRunInfo, title: string): void
```

Source: [`packages/workflow/workflow/src/index.ts:82`](../../packages/workflow/workflow/src/index.ts)

<a id="workflowrun-changed--emit"></a>

#### `workflow/run-changed` — emit

A workflow run started, advanced a node, or ended. Forwarded to clients verbatim once `packages/api/remotes/src/remote-events.ts`'s allowlist names it; the payload is ids and status only.

```ts cordis-catalog
/**
 * A workflow run started, advanced a node, or ended. Forwarded to clients verbatim once
 * `packages/api/remotes/src/remote-events.ts`'s allowlist names it; the payload is ids and
 * status only.
 * @param change - the run id, its status, and the node that changed.
 * @mode emit
 */
'workflow/run-changed'(change: WorkflowRunChange): void
```

Source: [`packages/workflow/workflow-remote/src/wire.ts:815`](../../packages/workflow/workflow-remote/src/wire.ts)

<a id="workflowstart--emit"></a>

#### `workflow/start` — emit

A workflow run started — the script's meta block validated, the body about to execute. Paired with Events['workflow/end'].

```ts cordis-catalog
/**
 * A workflow run started — the script's meta block validated, the body
 * about to execute. Paired with {@link Events['workflow/end']}.
 * @param info - the run's identity snapshot (id + meta).
 * @mode emit
 */
'workflow/start'(info: WorkflowRunInfo): void
```

Source: [`packages/workflow/workflow/src/index.ts:74`](../../packages/workflow/workflow/src/index.ts)
<!-- END GENERATED cordis-surface -->
