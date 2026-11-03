/**
 * Browser-safe durable workflow-record events written by the model-facing
 * workflow tool into its calling parent Session.
 *
 * @module @deepseek-ai/dsh-tool-workflow/types
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  WorkflowAgentOutcome, WorkflowNodeStatus, WorkflowRunId, WorkflowStopReason,
} from '@deepseek-ai/dsh-workflow/types'

/** Opens one durable top-level workflow run record. */
export interface ToolWorkflowRunStartData {
  readonly runId: WorkflowRunId
  readonly name: string
}

/** Records one workflow member after its child Session is published. */
export interface ToolWorkflowAgentStartData {
  readonly runId: WorkflowRunId
  readonly seq: number
  readonly label: string
  readonly phase?: string
  readonly childId: SessionId
}

/** Settles one previously started workflow member. */
export interface ToolWorkflowAgentEndData {
  readonly runId: WorkflowRunId
  readonly seq: number
  readonly outcome: WorkflowAgentOutcome
}

/** Settles one workflow run after its live resources reach quiescence. */
export interface ToolWorkflowRunEndData {
  readonly runId: WorkflowRunId
  readonly stopReason: WorkflowStopReason
}

/** Opens one YAML workflow node (written by `workflow_run`, never by the plain `workflow` tool). */
export interface ToolWorkflowNodeStartData {
  /** The durable run id. */
  readonly runId: WorkflowRunId
  readonly nodeId: string
  /** The node kind label. */
  readonly kind: string
  /** Epoch milliseconds when the node started. */
  readonly at: number
}

/** Lifecycle state of one workflow approval as recorded in the session. */
export type ToolWorkflowApprovalState = 'pending' | 'allowed' | 'rejected' | 'expired' | 'unavailable' | 'cancelled'

/** One approval transition of a YAML workflow run: written when it becomes pending and on every decision. */
export interface ToolWorkflowApprovalData {
  /** The durable run id. */
  readonly runId: WorkflowRunId
  readonly nodeId: string
  /** The node kind label, the same value `node-start` carries, so a row can be built from this record alone. */
  readonly kind: string
  /** The store approval id. */
  readonly approvalId: string
  readonly state: ToolWorkflowApprovalState
  /** Control-stripped reason, at most 500 characters. */
  readonly reason?: string
  /** Epoch milliseconds of the transition. */
  readonly at: number
}

/** Settles one YAML workflow node (written by `workflow_run`, never by the plain `workflow` tool). */
export interface ToolWorkflowNodeEndData {
  /** The durable run id (the workflow-run store id for YAML runs). */
  readonly runId: WorkflowRunId
  readonly nodeId: string
  /** The node kind label (`prompt`, `bash`, `loop`, `approval`, `cancel`). */
  readonly kind: string
  readonly status: WorkflowNodeStatus
  readonly exitCode?: number
  readonly durationMs?: number
  /** True when the recorded output is cut (engine cap or 8192-character agent tail); absent only in older records. */
  readonly truncated?: boolean
}

/** One row of a gate report: a declared gate and what happened to it. */
export interface ToolWorkflowGateReportRow {
  readonly nodeId: string
  readonly gateKind: string
  /** `fired-pass`, `fired-block`, `skipped`, `not-reached` or `never-evaluated`. */
  readonly outcome: string
  /** Why the gate blocked, when a reason exists (for example a headless approval rejection). */
  readonly reason?: string
}

/** The end-of-run gate report, written once on every terminal path before run-end. */
export interface ToolWorkflowGateReportData {
  readonly runId: WorkflowRunId
  readonly rows: readonly ToolWorkflowGateReportRow[]
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Opens one top-level workflow record.
     * @param data - stable run identity and display name.
     */
    'tool-workflow/run-start': ToolWorkflowRunStartData
    /**
     * Records one published workflow member.
     * @param data - run identity, member sequence, display identity, and child Session.
     */
    'tool-workflow/agent-start': ToolWorkflowAgentStartData
    /**
     * Records one member settlement.
     * @param data - run identity, paired member sequence, and outcome.
     */
    'tool-workflow/agent-end': ToolWorkflowAgentEndData
    /**
     * Opens one YAML workflow node.
     * @param data - run identity, node id and kind, and start time.
     */
    'tool-workflow/node-start': ToolWorkflowNodeStartData
    /**
     * One approval transition of a YAML workflow run (pending, then each decision).
     * @param data - run identity, node id and kind, approval id, state, optional reason, and time.
     */
    'tool-workflow/approval': ToolWorkflowApprovalData
    /**
     * Settles one YAML workflow node; a later record for the same node replaces an earlier one.
     * @param data - run identity, node id and kind, status, optional exit code and duration, and whether output was cut.
     */
    'tool-workflow/node-end': ToolWorkflowNodeEndData
    /**
     * The gate report of a YAML workflow run, one row per declared gate.
     * @param data - run identity and the report rows.
     */
    'tool-workflow/gate-report': ToolWorkflowGateReportData
    /**
     * Closes one workflow record after cleanup.
     * @param data - stable run identity and terminal reason.
     */
    'tool-workflow/run-end': ToolWorkflowRunEndData
  }
}
