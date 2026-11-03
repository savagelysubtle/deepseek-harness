/**
 * Workflow seam vocabulary: the request/run/result types a workflow engine
 * consumes and produces, plus the fields in the `workflow/*` event payloads.
 * Types only (plus the id-brand factory), per the package convention.
 *
 * @module @deepseek-ai/dsh-workflow/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Identifies one workflow run. */
export type WorkflowRunId = Branded<'WorkflowRunId'>

/**
 * Brand a string as a {@link WorkflowRunId}.
 * @param id - the raw id string (the engine mints UUIDs; tests may pass fixtures).
 * @returns the same string, branded.
 */
export function WorkflowRunId(id: string): WorkflowRunId {
  return id as WorkflowRunId
}

/**
 * One phase declared in a script's `meta.phases` (progress vocabulary only —
 * phases group agents in observers/UIs; they impose no execution structure).
 */
export interface WorkflowPhase {
  /** The phase title; `phase()` calls match against it by exact string. */
  title: string
  /** Optional one-line description of what the phase does. */
  detail?: string
  /** Optional provider override this phase is expected to use (informational). */
  provider?: string
  /** Optional model override this phase is expected to use (informational). */
  model?: string
}

/**
 * The script's identity block, provided as plain JSON data alongside the
 * script body (the model-facing tool carries it as its `meta` parameter) and
 * validated by the engine before the body runs. `name`/`description` are
 * required; the rest is optional annotation. The field vocabulary matches the
 * Claude Code dynamic-workflows meta block.
 */
export interface WorkflowMeta {
  /** Short kebab-case workflow name (display + persistence key). */
  name: string
  /** One-line description of what the workflow does. */
  description: string
  /** Optional guidance on when this workflow applies (shown in listings). */
  whenToUse?: string
  /** Optional phase declarations matched by `phase()` calls. */
  phases?: WorkflowPhase[]
}

/**
 * Why a run settled. CLOSED union (engine-owned, consumers may exhaust):
 * `completed` = the script ran to its final `return`; `cancelled` = the run
 * was cancelled (caller `cancel()`/signal); `error` = the script threw, a
 * fatal `WorkflowError` propagated, or the result failed materialization.
 */
export type WorkflowStopReason = 'completed' | 'cancelled' | 'error'

/**
 * The outcome resolved by a live workflow run. `value` is
 * the script's materialized return value (plain host-realm JSON data; `null`
 * when the script returned `undefined`) — meaningful only for `completed`.
 * A non-`completed` reason carries the failure in `error`; the consumer maps
 * it to an `isError` tool result rather than reporting partial output.
 */
export interface WorkflowResult {
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

/** Identifying detail for a run, carried by every `workflow/*` event as borrowed immutable data, never the live run. */
export interface WorkflowRunInfo {
  /** The run's id. */
  id: WorkflowRunId
  /** The run's validated meta block. */
  meta: WorkflowMeta
}

/** One `agent()` call's identity within a run (the `workflow/agent-start` payload). */
export interface WorkflowAgentInfo {
  /** 1-based sequence number of this `agent()` call within the run. */
  seq: number
  /** The display label (the `label` option, or a prompt snippet). */
  label: string
  /** The phase this agent belongs to (the `phase` option, else the current `phase()` title). */
  phase?: string
  /** The child agent's id on the subagent seam. */
  childId: SessionId
}

/** How one `agent()` call settled: clean result, child failure (script sees `null`), or run cancellation. */
export type WorkflowAgentOutcome = 'completed' | 'failed' | 'cancelled'

/** One `agent()` call's settlement (the `workflow/agent-end` payload). */
export interface WorkflowAgentEndInfo extends WorkflowAgentInfo {
  /** How the call settled. */
  outcome: WorkflowAgentOutcome
}

/**
 * A settled run's outcome as event data (the `workflow/end` payload): the
 * {@link WorkflowResult} minus `value` (a listener observing outcomes must not
 * receive a mutable alias of the caller's result value; a consumer that needs
 * the value holds the run and awaits `result`).
 */
export interface WorkflowResultInfo {
  /** Why the run settled. */
  stopReason: WorkflowStopReason
  /** The failure message (present iff `stopReason` is not `completed`). */
  error?: string
  /** How many `agent()` calls the run accepted (see {@link WorkflowResult.agentsStarted}). */
  agentsStarted: number
}

/** Node-id vocabulary shared by the node, gate, bash and approval hooks (path-safe, bounded). */
export const WORKFLOW_NODE_ID_PATTERN = /^[a-z0-9_-]{1,64}$/

/** How one workflow node settled. CLOSED union (`interrupted` = ended by a terminal path, not by the node). */
export type WorkflowNodeStatus = 'success' | 'failed' | 'skipped' | 'cancelled' | 'interrupted'

/** The outcome vocabulary of one declared gate (consumed by the gate report). */
export type WorkflowGateOutcome = 'fired-pass' | 'fired-block' | 'skipped' | 'not-reached' | 'never-evaluated'

/** One node's identity within a run (the `workflow/node-start` payload). */
export interface WorkflowNodeInfo {
  /** The node id (matches {@link WORKFLOW_NODE_ID_PATTERN}). */
  nodeId: string
  /** The node kind label (`prompt`, `bash`, `loop`, `approval`, `cancel`, ...), lowercase `[a-z_]` only. */
  kind: string
  /** The gate this node declares, when it is a gate (a `gate` event for it is owed on every terminal path). */
  gateKind?: string
}

/** Why a node's agent was stopped by the child supervisor (never a genuine non-completion). */
export interface WorkflowNodeFailure {
  /** `NODE_STALLED`: no output inside the idle window. `NODE_TIMEOUT`: the hard per-node deadline passed. */
  code: 'NODE_STALLED' | 'NODE_TIMEOUT'
  /** The failure text, naming the elapsed window and the retry count (bounded). */
  message: string
  /** What to change to avoid it. */
  remedy: string
}

/** One node's settlement (the `workflow/node-end` payload). */
export interface WorkflowNodeEndInfo extends WorkflowNodeInfo {
  /** How the node settled. */
  status: WorkflowNodeStatus
  /** The bash exit code, when the node ran one. */
  exitCode?: number
  /** Wall time in milliseconds, when the script measured it. */
  durationMs?: number
  /** True when the node's captured output was truncated at the in-memory cap. */
  truncated?: boolean
  /** The failure text (never a secret; bounded). */
  error?: string
  /** The supervisor stop that ended an agent node (stall or hard timeout); absent for a genuine non-completion. */
  failure?: WorkflowNodeFailure
  /** The real number of agent attempts the node ran (retries included), when the node ran an agent. */
  attempts?: number
  /** True when the HOST synthesized this end on a terminal path (the script never reported it). */
  synthesized?: boolean
}

/** One gate evaluation (the `workflow/gate` payload). */
export interface WorkflowGateInfo {
  /** The node the gate belongs to. */
  nodeId: string
  /** The gate kind label. */
  gateKind: string
  /** What happened to the gate. */
  outcome: WorkflowGateOutcome
  /** True when the HOST synthesized this gate on a terminal path. */
  synthesized?: boolean
}

/** In-memory cap for captured `bash()` stdout and stderr, each (bytes). Overflow keeps the TAIL. */
export const WORKFLOW_BASH_OUTPUT_CAP_BYTES = 64 * 1024

/** The script-facing options of a `bash(command, options)` call (validated worker-side AND host-side). */
export interface WorkflowBashOptions {
  /** Node id the call belongs to (labelling only). */
  nodeId?: string
  /** Working directory, relative to the run's workspace (no absolute paths, no `..`); resolved and contained at run time. */
  workdir?: string
  /** Wall-clock timeout in milliseconds (default 120000, capped at 600000). */
  timeoutMs?: number
  /** Extra environment entries (names screened against the denylist). */
  env?: Record<string, string>
  /** Upstream node outputs, exposed to the command as `WF_<NAME>` environment variables, never spliced into the command. */
  inputs?: Record<string, string>
}

/** What a `bash()` call yields to the script (the exit facts plus bounded output). */
export interface WorkflowBashResult {
  /** Exit code; `null` when a signal ended the process. */
  exitCode: number | null
  /** Terminating signal name, or `null`. */
  signal: string | null
  /** True when the timeout fired. */
  timedOut: boolean
  /** True when the run (cancel, worker death, dispose) aborted the command. */
  aborted: boolean
  /** Captured stdout tail (at most {@link WORKFLOW_BASH_OUTPUT_CAP_BYTES} bytes). */
  stdout: string
  /** Captured stderr tail (at most {@link WORKFLOW_BASH_OUTPUT_CAP_BYTES} bytes). */
  stderr: string
  /** True when either stream exceeded the cap (the full bytes went to the caller's `onBashOutput` sink). */
  truncated: boolean
  /** Total stdout bytes the command produced. */
  stdoutBytes: number
  /** Total stderr bytes the command produced. */
  stderrBytes: number
  /** Wall time in milliseconds. */
  durationMs: number
}

/** The closed outcome of one approval question. `allowed-once` is the only grant. */
export type WorkflowApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** The `agent()` done-when option: a bash check the host runs after the child finishes. */
export interface WorkflowDoneWhen {
  /** The command; non-zero exit means "not done" and starts another iteration. */
  command: string
  /** Working directory (same containment as {@link WorkflowBashOptions.workdir}). */
  workdir?: string
  /** Check timeout in milliseconds. */
  timeoutMs?: number
  /** Continuation cap (default 3, ceiling 8). */
  maxContinuations?: number
}

/** Default of {@link WorkflowDoneWhen.maxContinuations}. */
export const WORKFLOW_CONTINUATION_DEFAULT = 3
/** Ceiling of {@link WorkflowDoneWhen.maxContinuations}. */
export const WORKFLOW_CONTINUATION_CEILING = 8
/** Maximum characters of failure tail carried by {@link WorkflowContinuationEvidence}. */
export const WORKFLOW_EVIDENCE_TAIL_CHARS = 8192

/** The failure evidence that drives one continuation iteration (and ends up on exhaustion). */
export interface WorkflowContinuationEvidence {
  /** 1-based iteration the evidence ends (1 = the first run's check). */
  iteration: number
  /** The effective cap for this child. */
  maxContinuations: number
  /** The done-when command that failed. */
  command: string
  /** Its exit code (`null` = signal / timeout). */
  exitCode: number | null
  /** The last {@link WORKFLOW_EVIDENCE_TAIL_CHARS} characters of its output. */
  tail: string
  /** True when `tail` dropped output. */
  truncated: boolean
}
