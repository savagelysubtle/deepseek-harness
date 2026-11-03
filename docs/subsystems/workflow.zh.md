# 工作流

[English](workflow.md) | 中文

工作流 seam 允许 agent（智能体）运行由模型编写、会启动 subagent 的编排脚本。与 [subagent](subagent.md) 一样，它是**一项可选能力**，不属于 agent loop，因此其类型和操作记录在此处，而非 [core.md](core.md)。与 bash 一样，每个上下文只允许一个引擎实现提供 `ctx.workflowEngine`；没有命名提供方注册表（第二个引擎通过插件配置替换第一个，而不与它同时运行）。

Service Definition：[dsh-workflow](../../packages/workflow/workflow)（`ctx.workflowEngine` + 下文词汇）。Service Provider 是 [dsh-workflow-worker-thread](../../packages/workflow/workflow-worker-thread)（一个 `node:worker_threads` 引擎——每个 run 一个 worker，脚本的 vm 上下文位于其中）；面向模型的 Consumer 是 [dsh-tool-workflow](../../packages/workflow/tool-workflow)。提案与设计理由见 [dynamic-workflows Agent Note](../../.agents/notes/implemented/feature/2026-07-05-dynamic-workflows.md)。

源码：浏览器安全词汇位于 [`packages/workflow/workflow/src/types.ts`](../../packages/workflow/workflow/src/types.ts)，Host 请求与活跃运行句柄位于 [`runtime-types.ts`](../../packages/workflow/workflow/src/runtime-types.ts)。

## 启动请求

本节定义调用方启动一次运行时提交的请求。普通工作流工具会根据模型的 `{ script, meta, args }` 调用和发起调用的 agent 构建该请求；专用消费方还可以为本次运行选择引擎级 `subagentProvider`，并将 `maxTotalAgents` 调低，但脚本无法观察或替换这两项策略。`meta` 与 `args` 是普通 JSON 数据；引擎会用 schema 校验 `meta`，并在任何工作开始前明确报错并拒绝无效数据。引擎绝不会通过对脚本文本求值来获取它们。`parent` 是必填字段——脚本启动的每个子 agent 都归属于它，cwd、谱系与深度通过 [subagent seam](subagent.md) 传递。

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

## 工作流的身份标识：`WorkflowMeta`

作为数据附在启动请求上的身份块（工具的 `meta` 参数；字段词汇与 Claude Code 动态工作流的 meta 块一致）。`phases` 仅用于进度展示：`phase()` 调用与标题匹配，供观察者使用；不暗示任何执行结构。

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

## 终态结果：`WorkflowResult`

`WorkflowRun.result` 会兑现为一次运行的结果。`value` 是脚本的物化返回值——纯宿主域 JSON 数据（脚本无返回值时为 `null`）——仅在 `completed` 时有意义。`stopReason` 是封闭联合类型（由引擎定义；消费方可穷举）：`completed` | `cancelled` | `error`。非 `completed` 的原因在 `error` 中携带失败信息，消费方将其映射为 `isError` 工具结果，而非把部分输出当作成功上报。

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

## 活跃运行：`WorkflowRun`

脚本执行期间消费方持有的句柄。消费方会等待 `result`，可以在运行期间调用 `cancel`，并且必须在每条路径上调用 `dispose`（资源释放）。`result` 不会被拒绝：脚本失败会兑现为 `stopReason: 'error'`。运行被取消后，即使脚本本身永不结算，结果也会在引擎规定的有界宽限期内结算；引擎会强制将其结算为 `cancelled`，随后 worker-thread 引擎会终止脚本所在的 worker。因此，等待 `result` 的消费方不会在取消后无限期挂起。`dispose()` 会执行取消、等待有界结算并等待子 agent 完全停稳，不会因脚本卡死而挂起。

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

## 失败纪律：`WorkflowError.fatal`

脚本内部的钩子误用：错误参数、未知或延迟的 `agent()` 选项、超出[结构化输出子集](../../packages/core/tools/README.md)的 schema、超出上限、seam 启动失败、取消，都会抛出 `fatal: true` 的 `WorkflowError`。`parallel()`/`pipeline()` 组合器对 fatal 错误直接重新抛出，而非将该项映射为 `null`：一个拼写错误的选项必须明确报错并终止脚本，绝不能消融为看似普通子 agent 失败的结果。逐项的 `null` 保留给子运行失败（非 `completed` 的 stop reason）和阶段内的普通脚本错误。

## 事件

`workflow/*` 事件（`workflow/start`、`workflow/phase`、`workflow/log`、`workflow/agent-start`、`workflow/agent-end`、`workflow/end`，见[事件目录](#cordis-surface)）是**仅供观察**的 emit，携带数据快照：每个 payload 以 `WorkflowRunInfo`（id + meta）开头，而非活跃的 `WorkflowRun`，因此订阅者无法获得 `cancel`/`dispose`；`workflow/end` 刻意省略 result value（观察结果的监听器不得收到调用方 result 的可变别名）。每次 emit 对每个监听器隔离：订阅者抛出的异常会被记录到日志中而不会传播，也不会阻止后续注册的监听器收到事件；每个监听器收到自己的 payload 克隆，因此修改它既不会损坏引擎也不会影响其他监听器。这种隔离方式与 `subagent/start`/`subagent/end` 一致。

## 持久 Chat 记录

顶层 `dsh-tool-workflow` 消费方把展示事实投影到调用它的父 Session，同时不改变执行所有权。运行接受后写 `tool-workflow/run-start`，以 `runId + seq` 配对成员开始与结束，并且只在结果已取得且 dispose 完全停稳后写 `tool-workflow/run-end`。嵌套 transport 调用不写记录。第一次 append 失败会禁用本运行后续写入，因此日志保持为空或合法连续前缀，工具结果不变。

`dsh-tool-workflow/invariant` 会在实时提交前和 Session 加载时校验同一协议：每个运行只有一个 start，成员序号为正且唯一，成员 end 必须配对，仍有开放成员时不能结束运行，运行结束后不能继续更新。日志尾部缺少成员 end 或 run end 是有效的中断证据，不是损坏。

`dsh-client-ui-workflow-run` 通过 Conversation Node 引擎把四类事件折叠为一个 `workflow-run` Chat 节点，以 run-start 序号锚定在原工作流工具节点之后。阶段组只来自真正开始过的成员，并保留精确字符串，包括字段缺省与 `''` 的区别。Location 关闭时，缺失终点会显示为已中断。[界面包 README](../../packages/client/ui-workflow-run/README.md)负责定义 disclosure、状态与同父本地导航行为。

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

Source: [`packages/workflow/workflow-remote/src/wire.ts:804`](../../packages/workflow/workflow-remote/src/wire.ts)

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

Source: [`packages/workflow/workflow-remote/src/wire.ts:798`](../../packages/workflow/workflow-remote/src/wire.ts)

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

Source: [`packages/workflow/workflow-remote/src/wire.ts:792`](../../packages/workflow/workflow-remote/src/wire.ts)

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
