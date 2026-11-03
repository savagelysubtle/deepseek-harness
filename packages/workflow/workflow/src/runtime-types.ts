/**
 * Host-only workflow request and live-run handles. The browser-safe durable
 * vocabulary remains in `./types` so Client programs never import Agent or
 * host Cordis context declarations.
 *
 * @module @deepseek-ai/dsh-workflow
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type {
  WorkflowApprovalOutcome,
  WorkflowBashResult,
  WorkflowContinuationEvidence,
  WorkflowDoneWhen,
  WorkflowMeta,
  WorkflowResult,
  WorkflowRunId,
} from './types.ts'

/** One approval question the engine puts to the injected {@link WorkflowApprover}. */
export interface WorkflowApprovalRequest {
  /** Host-minted 128-bit random id; the handle for {@link WorkflowRun.decideApproval}. Never derived from the node id. */
  readonly approvalId: string
  /** The approval node asking (matches the node-id pattern). */
  readonly nodeId: string
  /** The question text (bounded; script-supplied, so a UI must render it as data). */
  readonly message: string
  /** Aborted when the run is cancelled, the worker dies, or the run is disposed: settle `'cancelled'`. */
  readonly signal: AbortSignal
}

/**
 * Decides one approval. Injected by the owner of the run (a store-backed
 * broker); the engine knows nothing of stores or UIs. A rejection or a rogue
 * return value is treated as `'unavailable'` (fail closed).
 */
export type WorkflowApprover = (request: WorkflowApprovalRequest) => Promise<WorkflowApprovalOutcome>

/** What the engine asks a {@link WorkflowBashExecutor} to run (already validated, workdir already contained). */
export interface WorkflowBashExecRequest {
  /** The command text, run as `bash -c <command>`; never built from upstream outputs. */
  readonly command: string
  /** Absolute, realpath-contained working directory. */
  readonly cwd: string
  /** Environment entries layered over the executor's scrubbed parent base (denylist already applied). */
  readonly env: Readonly<Record<string, string>>
  /** Wall-clock timeout (milliseconds, already capped). */
  readonly timeoutMs: number
  /** In-memory cap per stream (bytes); overflow keeps the tail. */
  readonly maxOutputBytes: number
  /** Aborting tree-kills the command (cancel, worker death, dispose). */
  readonly signal: AbortSignal
  /** Receives every output chunk (the full stream), so the caller can spill what the cap dropped. */
  readonly onOutput?: (stream: 'stdout' | 'stderr', chunk: Uint8Array) => void
}

/** Runs one bash command to completion with a process-group tree-kill on abort or timeout. Never rejects for a non-zero exit. */
export interface WorkflowBashExecutor {
  run(request: WorkflowBashExecRequest): Promise<WorkflowBashResult>
}

/** One supervised `agent()` child, identified before its session exists. */
export interface WorkflowSupervisedChild {
  /** The run's child-call correlation id (stable across continuation iterations). */
  readonly callId: number
  /** The node the call belongs to, when the script labelled it. */
  readonly nodeId?: string
  /** The call's original prompt. */
  readonly prompt: string
  /** Absolute deadline (ms) requested for the child; the supervisor enforces it. */
  readonly timeoutMs?: number
  /** Stall deadline (ms) requested for the child; the supervisor enforces it. */
  readonly idleTimeoutMs?: number
  /** The tier label the call asked for. */
  readonly tier?: string
  /** The done-when check, when requested. */
  readonly doneWhen?: WorkflowDoneWhen
  /** 0 for the first run, then 1.. per continuation iteration. */
  readonly iteration: number
}

/** The terminal facts a supervisor evaluates (the JSON projection, without the structured value). */
export interface WorkflowSupervisedOutcome {
  /** The child's stop reason. */
  readonly stopReason: string
  /** The child's final assistant text. */
  readonly text: string
}

/** Host capabilities handed to a supervisor's evaluation. */
export interface WorkflowSupervisorTools {
  /** Run a validated bash check through the run's executor, abort-linked to the run. */
  runBash(command: string, options?: { workdir?: string; timeoutMs?: number }): Promise<WorkflowBashResult>
  /** The run's abort signal. */
  readonly signal: AbortSignal
}

/** What a supervisor holds to end one child iteration (stall watchdog, deadline). */
export interface WorkflowChildHandle {
  /**
   * Stop the child now. Idempotent, and a no-op once the iteration has settled or been replaced.
   * @param reason - `timeout` (absolute deadline) or `stalled` (no activity); both are retryable.
   */
  stop(reason: 'timeout' | 'stalled'): void
}

/**
 * The seam a child supervisor (stall watchdog, done-when evaluator) plugs
 * into. Every member is optional and contained: a throw is logged and treated
 * as "no opinion". Correlation: `register` fires inside `startChild`, before
 * `subagents.start` resolves, so the child session id is unknown; `bind`
 * fires once the child is published, and its `childId` equals the `info.id`
 * of that child's `subagent/start` event.
 */
export interface WorkflowChildSupervisor {
  /** A child start begins (id unknown yet). */
  register?(child: WorkflowSupervisedChild): void
  /**
   * The child is published; `childId` is its session id. Fires again per continuation iteration,
   * preceded by a fresh `register` for that iteration. `handle.stop` ends this iteration's child:
   * the host disposes it and the call settles with that stop reason, which the engine's
   * transient-only retry then treats as retryable.
   */
  bind?(child: WorkflowSupervisedChild, childId: string, handle: WorkflowChildHandle): void
  /**
   * The child produced a result. Return failure evidence to run another
   * iteration (the engine enforces the cap and composes the next prompt), or
   * `undefined` to accept the result.
   */
  evaluate?(
    child: WorkflowSupervisedChild,
    outcome: WorkflowSupervisedOutcome,
    tools: WorkflowSupervisorTools,
  ): Promise<WorkflowContinuationEvidence | undefined>
  /** The child left supervision (settled, exhausted, aborted or disposed). Fires per bound child id. */
  release?(child: WorkflowSupervisedChild, childId: string | undefined): void
}

/**
 * What a caller asks for when starting a workflow run. `meta` and `args` are
 * plain JSON data by the seam contract. `parent` is required because every
 * `agent()` spawned by the script is attributed to that live Agent.
 */
export interface WorkflowStartRequest {
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

/** One pending approval, as listed by {@link WorkflowRun.pendingApprovals}. */
export interface WorkflowPendingApproval {
  readonly approvalId: string
  readonly nodeId: string
  readonly message: string
}

/** The result of {@link WorkflowRun.decideApproval}. */
export type WorkflowApprovalDecision = 'decided' | 'already-decided' | 'unknown'

/**
 * Holder-owned live workflow. `result` never rejects; consumers may cancel
 * and must call idempotent `dispose()` to await script and child quiescence.
 */
export interface WorkflowRun {
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
