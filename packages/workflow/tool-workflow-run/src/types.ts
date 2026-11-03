/**
 * Shared vocabulary of the workflow runner: start options and results, run outcomes, gate-report
 * rows and the change events the service publishes to its subscribers.
 * @module @deepseek-ai/dsh-tool-workflow-run/types
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { WorkflowGateRow, WorkflowRunEndStatus } from '@deepseek-ai/dsh-workflow-run-store'
import type { Diagnostic, TrustFacts, WorkflowGraph } from '@deepseek-ai/dsh-workflow-yaml'

/** One gate-report row; `reason` explains a block (for example a headless approval rejection). */
export interface GateReportRow extends WorkflowGateRow {
  readonly reason?: string
}

/** A node's final state as shown in a run result. */
export interface RunNodeSummary {
  readonly nodeId: string
  readonly kind: string
  readonly status: string
  readonly exitCode?: number
  readonly durationMs?: number
}

/** How a finished run ended, with everything the tool result and the UI show. */
export interface RunOutcome {
  readonly runId: string
  readonly name: string
  readonly hash: string
  readonly status: WorkflowRunEndStatus
  readonly error?: string
  readonly report: readonly GateReportRow[]
  readonly nodes: readonly RunNodeSummary[]
  /** Approval and gate reasons by node id. */
  readonly reasons: Readonly<Record<string, string>>
  readonly resumedFrom?: string
  /** True when the live workflow file differs from the pinned source (or is gone). */
  readonly fileChanged?: boolean
}

/** Machine-readable reasons a start is refused. */
export type StartErrorCode =
  | 'NOT_FOUND'
  | 'DIAGNOSTICS'
  | 'INVALID_INPUT'
  | 'TRUST_REQUIRED'
  | 'TRUST_DENIED'
  | 'WRITER_BUSY'
  | 'RESUME_REFUSED'
  | 'START_FAILED'
  | 'RUNNER_UNAVAILABLE'

/** A start that did not begin a run. Always carries a message that already names the remedy. */
export interface StartRefused {
  readonly ok: false
  readonly error: StartErrorCode
  readonly message: string
  readonly remedy?: string
  readonly diagnostics?: readonly Diagnostic[]
  /** Who holds the single-writer guard (WRITER_BUSY). */
  readonly holder?: {
    readonly runId?: string
    readonly workflowName?: string
    readonly startedAt: number
    readonly pid: number
  }
}

/** A run that started; `done` settles when the run ended and its record is closed. */
export interface StartedRun {
  readonly ok: true
  readonly runId: string
  readonly name: string
  readonly hash: string
  readonly resumedFrom?: string
  readonly done: Promise<RunOutcome>
}

/** What `start` answers. */
export type StartResult = StartedRun | StartRefused

/** Options of {@link WorkflowRunsService.start}. */
export interface StartOptions {
  /** The agent that parents the run's children (its session also receives the `tool-workflow/*` records). */
  readonly parent: Agent
  /** Workflow name under the workflows directory. */
  readonly name?: string
  /** Workspace-relative path of a workflow file under the workflows directory. */
  readonly path?: string
  /** Re-run an earlier run from its pinned source, skipping nodes that already succeeded. */
  readonly resume?: string
  /** Values for the workflow's declared inputs. */
  readonly inputs?: Readonly<Record<string, unknown>>
  /** The `trustKey` a human confirmed in the UI; accepted only when it equals the current key and `trustChallenge` is valid. */
  readonly trustHash?: string
  /**
   * The single-use `trustChallenge` the host issued with the dry run the human reviewed. Without
   * a live challenge bound to this caller, workspace and key, `trustHash` is refused.
   */
  readonly trustChallenge?: string
  /** Cancels the run when aborted. */
  readonly signal?: AbortSignal
}

/** The DAG, gate manifest and trust facts of a workflow, produced without running anything. */
export interface DryRunPlan {
  readonly ok: true
  readonly name: string
  readonly hash: string
  readonly trusted: boolean
  /** The key a human confirms: the YAML hash plus every prompt file digest. Pass it back as `trustHash`. */
  readonly trustKey: string
  /** Single-use token proving this plan was served to the calling session; present only when untrusted and a caller was given. */
  readonly trustChallenge?: string
  /** The exact confirmation text a human reviews (every command verbatim); present only when untrusted. */
  readonly confirmText?: string
  readonly graph: WorkflowGraph
  readonly manifest: readonly { nodeId: string; gateKind: string }[]
  readonly trust: TrustFacts
  readonly plan: readonly string[]
  readonly warnings: readonly Diagnostic[]
}

/** Change events a subscriber (the Host Remote service) receives. */
export type WorkflowRunsEvent =
  | {
    readonly type: 'run-changed'
    readonly runId: string
    readonly status: 'running' | WorkflowRunEndStatus
    readonly nodeId?: string
    readonly nodeStatus?: string
    /** Realpath of the workspace the run belongs to; stamped by the runner, never forwarded raw. */
    readonly workspace?: string
  }
  | {
    readonly type: 'approval-pending'
    readonly runId: string
    readonly approvalId: string
    readonly nodeId: string
    readonly message: string
    /** Realpath of the workspace the run belongs to; stamped by the runner, never forwarded raw. */
    readonly workspace?: string
  }
  | {
    readonly type: 'approval-decided'
    /** Realpath of the workspace the run belongs to; stamped by the runner, never forwarded raw. */
    readonly workspace?: string
    readonly runId: string
    readonly approvalId: string
    readonly nodeId: string
    /** `allowed`, `rejected`, `expired`, `cancelled`, or `unavailable` when the decision could not be recorded. */
    readonly state: string
    /** Control-stripped reason, at most 500 characters. */
    readonly reason?: string
  }
